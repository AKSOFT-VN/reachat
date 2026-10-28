// Bot: tài khoản đặc biệt do người dùng tạo, điều khiển bằng token qua REST (/bot/v1/*).
// Nhận tin bằng long-poll (/bot/v1/updates) hoặc webhook (POST JSON, ký HMAC-SHA256 bằng bí mật riêng).
// Bot KHÔNG có khóa mã hóa -> chat 1-1 với bot là văn bản thường; tin nhóm mã hóa bot không đọc được.
import crypto from 'node:crypto';
import db, { getUserById, getUserByUsername, createUser, messagesSince } from './db.js';
import { httpError } from './auth.js';
import { safePost, isPrivateHost } from './linkpreview.js';

// Webhook tới mạng nội bộ (bot chạy cùng máy chủ) chỉ khi quản trị cho phép: BOT_WEBHOOK_PRIVATE=1.
const WEBHOOK_PRIVATE = process.env.BOT_WEBHOOK_PRIVATE === '1';

const ensureColumn = (t, name, ddl) => {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
};
ensureColumn('users', 'is_bot', 'is_bot INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'bot_owner', 'bot_owner TEXT');
ensureColumn('users', 'bot_token_hash', 'bot_token_hash TEXT');
ensureColumn('users', 'bot_webhook', 'bot_webhook TEXT');
ensureColumn('users', 'bot_secret', 'bot_secret TEXT');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = (id) => `rcb.${id}.${crypto.randomBytes(24).toString('base64url')}`;   // "." không có trong id (nanoid) lẫn base64url
const MAX_BOTS = 10;

const botView = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, webhook: u.bot_webhook || null, createdAt: u.created_at, disabled: !!u.banned });

export function createBot(owner, { username, displayName }) {
  if (owner.is_bot) throw httpError(403, 'Bot không tạo được bot');
  username = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(username) || !username.endsWith('bot')) throw httpError(400, 'Tên bot 3-20 ký tự a-z, 0-9, _ và kết thúc bằng "bot" (vd. thoitiet_bot)');
  if (getUserByUsername(username)) throw httpError(409, 'Tên đã có người dùng');
  if (db.prepare('SELECT COUNT(*) n FROM users WHERE bot_owner = ?').get(owner.id).n >= MAX_BOTS) throw httpError(400, `Tối đa ${MAX_BOTS} bot`);
  const u = createUser({ username, displayName: String(displayName || username).slice(0, 60), passwordHash: '!bot-không-đăng-nhập-bằng-mật-khẩu' });
  const token = newToken(u.id);
  db.prepare('UPDATE users SET is_bot = 1, bot_owner = ?, bot_token_hash = ?, bot_secret = ? WHERE id = ?')
    .run(owner.id, sha(token), crypto.randomBytes(24).toString('hex'), u.id);
  return { bot: botView(getUserById(u.id)), token };
}
const ownBot = (owner, id) => {
  const b = getUserById(id);
  if (!b || !b.is_bot || b.bot_owner !== owner.id) throw httpError(404, 'Không tìm thấy bot');
  return b;
};
export const listBots = (owner) => db.prepare('SELECT * FROM users WHERE bot_owner = ? ORDER BY created_at').all(owner.id).map(botView);
export function regenerateToken(owner, id) {
  const b = ownBot(owner, id);
  const token = newToken(b.id);
  db.prepare('UPDATE users SET bot_token_hash = ? WHERE id = ?').run(sha(token), b.id);
  return { token };
}
export function setWebhook(owner, id, url) {
  const b = ownBot(owner, id);
  url = String(url || '').trim();
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw httpError(400, 'Webhook phải là URL http(s)');
  db.prepare('UPDATE users SET bot_webhook = ? WHERE id = ?').run(url || null, b.id);
  return { webhook: url || null, secret: b.bot_secret };
}
export function deleteBot(owner, id) {
  const b = ownBot(owner, id);
  db.prepare("UPDATE users SET banned = 1, ban_reason = 'bot đã xóa', bot_token_hash = NULL, bot_webhook = NULL WHERE id = ?").run(b.id);
}

// Xác thực bot: "Authorization: Bot <token>"
export function botFromRequest(req) {
  const t = (req.headers.authorization || '').replace(/^Bot\s+/i, '').trim() || String(req.query.token || '');
  const id = /^rcb\.([^.]+)\./.exec(t)?.[1];
  const b = id && getUserById(id);
  if (!b || !b.is_bot || b.banned || !b.bot_token_hash || b.bot_token_hash !== sha(t)) throw httpError(401, 'Token bot không hợp lệ');
  return b;
}

// Bản tin gửi cho bot (tin mã hóa: không có text — bot không đọc được).
export const toUpdate = (m) => {
  const sender = getUserById(m.sender_id);
  const conv = db.prepare('SELECT type, title FROM conversations WHERE id = ?').get(m.conversation_id);
  return {
    seq: m.seq, id: m.id, conversationId: m.conversation_id, chat: { type: conv?.type, title: conv?.title || null },
    from: sender?.username, type: m.type, enc: !!m.enc, text: m.enc || m.recalled ? null : m.body,
    replyTo: m.reply_to || null, createdAt: m.created_at,
  };
};
export const botUpdates = (bot, since, limit = 100) =>
  messagesSince(bot.id, Number(since) || 0, limit).filter((m) => m.sender_id !== bot.id && m.type !== 'keydist').map(toUpdate);

// Webhook: gửi ngay khi có tin mới cho bot (không chặn luồng chính, lỗi thì bỏ qua — bot vẫn dùng updates được).
export function pushWebhooks(stored, memberIds) {
  for (const uid of memberIds) {
    if (uid === stored.sender_id) continue;
    const b = getUserById(uid);
    if (!b?.is_bot || !b.bot_webhook || b.banned) continue;
    const body = JSON.stringify({ update: toUpdate(stored) });
    const sig = crypto.createHmac('sha256', b.bot_secret).update(body).digest('hex');
    safePost(b.bot_webhook, body, { 'X-ReaChat-Signature': sig }, { allowPrivate: WEBHOOK_PRIVATE }).catch(() => {});
  }
}

// Thông báo đẩy (Web Push, chuẩn VAPID) cho bản web/PWA khi người dùng KHÔNG mở app.
// Tin mã hóa đầu-cuối: nội dung đẩy chỉ là "tin mới từ @x" (máy chủ không đọc được nội dung tin).
import fs from 'node:fs';
import webpush from 'web-push';
import db, { getUserById, getConversation } from './db.js';
import { VAPID_FILE, VAPID_SUBJECT } from './config.js';

db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  muted TEXT, created_at INTEGER NOT NULL)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id)');

// Khóa VAPID: tạo một lần, lưu tệp (hoặc đặt VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
let keys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
else {
  try { keys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); } catch {
    keys = webpush.generateVAPIDKeys();
    try { fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 }); } catch {}
  }
}
webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
export const vapidPublicKey = () => keys.publicKey;
const dbg = (...a) => { if (process.env.PUSH_DEBUG) console.log('[push]', ...a); };

export function subscribe(userId, sub, muted = []) {
  const { endpoint, keys: k } = sub || {};
  if (!/^https:\/\//.test(String(endpoint || '')) || !k?.p256dh || !k?.auth) throw Object.assign(new Error('Đăng ký đẩy không hợp lệ'), { status: 400 });
  db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, muted, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, muted = excluded.muted`)
    .run(endpoint, userId, k.p256dh, k.auth, JSON.stringify(muted.slice(0, 500)), Date.now());
}
export const unsubscribe = (userId, endpoint) => db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
export const setMuted = (userId, endpoint, muted) => db.prepare('UPDATE push_subs SET muted = ? WHERE user_id = ? AND endpoint = ?').run(JSON.stringify((muted || []).slice(0, 500)), userId, endpoint);

// Gửi thông báo tới mọi thiết bị đã đăng ký của user (bỏ qua hội thoại đã tắt thông báo). Hỏng vĩnh viễn (404/410) -> xóa.
export function pushToUser(userId, payload) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
  dbg('gửi tới', userId, subs.length, 'thiết bị', payload.title);
  for (const s of subs) {
    let muted = []; try { muted = JSON.parse(s.muted || '[]'); } catch {}
    if (payload.conversationId && muted.includes(payload.conversationId) && payload.kind !== 'call') continue;
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: payload.kind === 'call' ? 60 : 3600, urgency: payload.kind === 'call' ? 'high' : 'normal' })
      .then((r) => dbg('ok', r.statusCode))
      .catch((e) => { dbg('lỗi', e.statusCode, e.message); if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint); });
  }
}

// Tin mới cho người đang không mở app.
export function pushNewMessage(stored, memberIds, isOnline) {
  if (stored.type === 'keydist' || stored.type === 'system') return;
  const sender = getUserById(stored.sender_id);
  const conv = getConversation(stored.conversation_id);
  for (const uid of memberIds) {
    if (uid === stored.sender_id || isOnline(uid)) { dbg('bỏ qua', uid, uid === stored.sender_id ? '(người gửi)' : '(đang online)'); continue; }
    const title = conv?.type === 'group' ? `${conv.is_channel ? '📢' : '👥'} ${conv.title}` : '@' + (sender?.username || '');
    const body = stored.type === 'call' ? '📞 Cuộc gọi nhỡ' : conv?.type === 'group' ? `@${sender?.username}: tin nhắn mới 🔒` : 'Tin nhắn mới 🔒';
    pushToUser(uid, { kind: 'message', title, body, conversationId: stored.conversation_id, tag: stored.conversation_id });
  }
}

// Email / số điện thoại đã xác minh + quên mật khẩu bằng mã gửi qua email / SMS.
// - Mã 6 số, hết hạn sau 10 phút, sai tối đa 5 lần, gửi lại sau 60 giây. Chỉ lưu băm của mã.
// - "Quên mật khẩu" luôn trả lời giống nhau dù tài khoản có tồn tại hay không (chống dò tài khoản).
// - Bật xác thực 2 bước -> đặt lại vẫn phải nhập mã 2 bước (email/SMS bị chiếm không đủ để lấy tài khoản).
// - Bản sao lưu khóa bọc bằng mật khẩu CŨ -> xóa; máy còn giữ khóa sẽ bọc lại bằng mật khẩu mới.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from './db.js';
import { getUserById, getUserByUsername, setPasswordHash, setKeyBackup } from './db.js';
import { checkLimit, recordFail, clearFails, verifyTotp } from './security.js';
import { sendEmail, sendSms, channels } from './notify.js';
import { revokeAll } from './account.js';
import { checkCaptcha, captchaError } from './captcha.js';

const ensureColumn = (t, name, ddl) => {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
};
ensureColumn('users', 'email', 'email TEXT');
ensureColumn('users', 'email_ok', 'email_ok INTEGER');     // thời điểm xác minh
ensureColumn('users', 'phone', 'phone TEXT');
ensureColumn('users', 'phone_ok', 'phone_ok INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS verify_codes (
  user_id TEXT NOT NULL, purpose TEXT NOT NULL, target TEXT NOT NULL, code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, purpose))`);

const TTL = 10 * 60_000, MAX_TRIES = 5, COOLDOWN = 60_000;
const DEV_ECHO = process.env.NOTIFY_DEV_ECHO === '1';      // CHỈ dùng khi chạy test: trả mã trong phản hồi
const err = (status, message) => Object.assign(new Error(message), { status });
const hashCode = (userId, purpose, code) => crypto.createHash('sha256').update(`${userId}:${purpose}:${code}`).digest('hex');

export const normEmail = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(s) ? s : null;
};
// Số VN: 0xxxxxxxxx / 84xxxxxxxxx / +84… -> +84xxxxxxxxx. Số quốc tế: +[8-15 chữ số].
export const normPhone = (v) => {
  let s = String(v || '').replace(/[\s.\-()]/g, '');
  if (/^0\d{9}$/.test(s)) s = '+84' + s.slice(1);
  else if (/^84\d{9}$/.test(s)) s = '+' + s;
  return /^\+\d{8,15}$/.test(s) ? s : null;
};
export const maskEmail = (e) => (e ? e.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 6)) + c) : null);
export const maskPhone = (p) => (p ? p.slice(0, 3) + '*'.repeat(Math.max(p.length - 6, 2)) + p.slice(-3) : null);

async function issue(userId, purpose, target, send) {
  const old = db.prepare('SELECT created_at FROM verify_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose);
  if (old && Date.now() - old.created_at < COOLDOWN) throw err(429, 'Vừa gửi mã — đợi 1 phút rồi gửi lại');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('INSERT OR REPLACE INTO verify_codes (user_id, purpose, target, code_hash, expires, attempts, created_at) VALUES (?,?,?,?,?,0,?)')
    .run(userId, purpose, target, hashCode(userId, purpose, code), Date.now() + TTL, Date.now());
  await send(code);
  return DEV_ECHO ? { devCode: code } : {};
}
// Kiểm mã; đúng -> xóa (dùng một lần) và trả bản ghi; sai -> tăng số lần thử.
function consume(userId, purpose, code) {
  const row = db.prepare('SELECT * FROM verify_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose);
  if (!row || row.expires < Date.now() || row.attempts >= MAX_TRIES) return null;
  const ok = /^\d{6}$/.test(String(code || '').trim()) &&
    crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(userId, purpose, String(code).trim())));
  if (!ok) { db.prepare('UPDATE verify_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?').run(userId, purpose); return null; }
  db.prepare('DELETE FROM verify_codes WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  return row;
}

const MSG = (code) => `Mã xác minh ReaChat của bạn: ${code}. Mã hết hạn sau 10 phút. Không chia sẻ mã này với bất kỳ ai.`;
const deliver = (kind, target, code) => (kind === 'email'
  ? sendEmail(target, 'Mã xác minh ReaChat: ' + code, MSG(code) + '\n\nNếu bạn không yêu cầu, hãy bỏ qua email này.')
  : sendSms(target, MSG(code)));

// ---- Thêm / đổi email, số điện thoại (người đã đăng nhập) ----
export async function startContact(user, kind, value) {
  if (!channels()[kind === 'email' ? 'email' : 'sms']) throw err(503, kind === 'email' ? 'Máy chủ chưa cấu hình gửi email' : 'Máy chủ chưa cấu hình gửi SMS');
  const target = kind === 'email' ? normEmail(value) : kind === 'phone' ? normPhone(value) : null;
  if (!target) throw err(400, kind === 'email' ? 'Email không hợp lệ' : 'Số điện thoại không hợp lệ');
  const col = kind === 'email' ? 'email' : 'phone';
  if (db.prepare(`SELECT 1 FROM users WHERE ${col} = ? AND ${col}_ok IS NOT NULL AND id != ? AND banned = 0`).get(target, user.id))
    throw err(409, kind === 'email' ? 'Email này đã gắn với tài khoản khác' : 'Số điện thoại này đã gắn với tài khoản khác');
  checkLimit('vc:' + user.id);
  dailyCap('u:' + user.id); dailyCap('t:' + target);
  return { ok: true, ...(await issue(user.id, 'add-' + kind, target, (c) => deliver(kind, target, c))) };
}
// Hạn mức gửi mã xác minh theo ngày (mỗi tài khoản và mỗi email/SĐT đích) — chống dùng máy chủ để spam SMS/email.
const DAILY_MAX = Number(process.env.VERIFY_DAILY_MAX) || 5;
const sentToday = new Map();   // khóa -> [thời điểm gửi]
function dailyCap(key) {
  const now = Date.now(), list = (sentToday.get(key) || []).filter((t) => now - t < 86_400_000);
  if (list.length >= DAILY_MAX) throw err(429, 'Đã gửi quá nhiều mã hôm nay — thử lại vào ngày mai');
  list.push(now); sentToday.set(key, list);
  if (sentToday.size > 50_000) sentToday.delete(sentToday.keys().next().value);
}
export function confirmContact(user, kind, code) {
  checkLimit('vc:' + user.id);
  const row = consume(user.id, 'add-' + kind, code);
  if (!row) { recordFail('vc:' + user.id); throw err(400, 'Mã không đúng hoặc đã hết hạn'); }
  const col = kind === 'email' ? 'email' : 'phone';
  db.prepare(`UPDATE users SET ${col} = ?, ${col}_ok = ? WHERE id = ?`).run(row.target, Date.now(), user.id);
  return { ok: true };
}
export async function removeContact(user, kind, password) {
  checkLimit('u:' + user.username);
  if (!(await bcrypt.compare(password || '', user.password_hash))) { recordFail('u:' + user.username); throw err(403, 'Mật khẩu không đúng'); }
  const col = kind === 'email' ? 'email' : 'phone';
  db.prepare(`UPDATE users SET ${col} = NULL, ${col}_ok = NULL WHERE id = ?`).run(user.id);
  return { ok: true };
}
export const contactStatus = (u) => ({
  email: u.email_ok ? maskEmail(u.email) : null, phone: u.phone_ok ? maskPhone(u.phone) : null,
  emailFull: u.email_ok ? u.email : null, phoneFull: u.phone_ok ? u.phone : null,
});

// ---- Quên mật khẩu ----
// Tìm tài khoản theo username, hoặc email / số điện thoại ĐÃ xác minh.
function findForReset(ident) {
  const s = String(ident || '').trim();
  const em = normEmail(s), ph = normPhone(s);
  if (em) return db.prepare('SELECT id FROM users WHERE email = ? AND email_ok IS NOT NULL AND banned = 0').get(em);
  const u = getUserByUsername(s.toLowerCase());
  if (u && !u.banned) return u;
  return ph ? db.prepare('SELECT id FROM users WHERE phone = ? AND phone_ok IS NOT NULL AND banned = 0').get(ph) : null;
}
export async function forgotStart({ ident, channel, captcha }, ip = '') {
  if (!checkCaptcha(captcha)) throw captchaError();          // chống dùng máy chủ để spam email/SMS
  const kind = channel === 'sms' ? 'phone' : 'email';
  if (!channels()[channel === 'sms' ? 'sms' : 'email']) throw err(503, channel === 'sms' ? 'Máy chủ chưa cấu hình gửi SMS' : 'Máy chủ chưa cấu hình gửi email');
  const key = String(ident || '').trim().toLowerCase();
  checkLimit('fg:' + key); checkLimit('ip:' + ip);
  recordFail('fg:' + key);                     // mỗi lần yêu cầu đều tính (chống spam gửi mã)
  const found = findForReset(ident);
  const user = found && getUserById(found.id);
  const target = user && (kind === 'email' ? (user.email_ok && user.email) : (user.phone_ok && user.phone));
  let extra = {};
  if (target) {
    try { extra = await issue(user.id, 'reset', target + '|' + kind, (c) => deliver(kind, target, c)); }
    catch (e) { if (e.status !== 429) throw e; }   // đang trong thời gian chờ: vẫn trả lời như thường
  }
  // Cùng một câu trả lời cho mọi trường hợp.
  return { ok: true, message: `Nếu tài khoản có ${kind === 'email' ? 'email' : 'số điện thoại'} đã xác minh, mã 6 số vừa được gửi tới đó.`, ...extra };
}
export async function forgotReset({ ident, code, newPassword, otp }, ip = '', issueToken, meta = {}) {
  const key = String(ident || '').trim().toLowerCase();
  checkLimit('fr:' + key); checkLimit('ip:' + ip);
  const found = findForReset(ident);
  const user = found && getUserById(found.id);
  if (!newPassword || newPassword.length < 6) throw err(400, 'Mật khẩu mới tối thiểu 6 ký tự');
  // Bật 2 bước: kiểm mã 2 bước TRƯỚC khi tiêu mã email/SMS (nhập thiếu không làm mất mã).
  if (user?.totp_on) {
    if (!otp) throw Object.assign(err(401, 'Tài khoản bật xác thực 2 bước — nhập mã 6 số từ ứng dụng xác thực'), { need2fa: true });
    if (!verifyTotp(user.id, user.totp_secret, otp)) { recordFail('fr:' + key); recordFail('ip:' + ip); throw Object.assign(err(401, 'Mã xác thực 2 bước không đúng'), { need2fa: true }); }
  }
  const row = user && consume(user.id, 'reset', code);
  if (!row) { recordFail('fr:' + key); recordFail('ip:' + ip); throw err(400, 'Mã không đúng hoặc đã hết hạn'); }
  setPasswordHash(user.id, await bcrypt.hash(newPassword, 10));   // token_ver + 1 -> mọi token cũ hết hiệu lực
  setKeyBackup(user.id, null);                                     // bản sao lưu bọc bằng mật khẩu cũ — vô dụng
  revokeAll(user.id);
  clearFails('fr:' + key); clearFails('fg:' + key);
  const fresh = getUserById(user.id);
  return { ...issueToken(fresh, { ...meta, ip }), keyBackupReset: true };
}

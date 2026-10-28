// Đăng nhập bằng Google (OAuth 2.0 + PKCE, luồng phía máy chủ — dùng chung cho app desktop và bản web).
//  1) App gọi POST /api/auth/google/begin -> { nonce, url }; mở url bằng trình duyệt hệ thống.
//  2) /auth/google/start chuyển sang Google; Google trả về /auth/google/callback; máy chủ đổi mã lấy id_token
//     (trực tiếp từ Google qua TLS bằng client secret) và ghi kết quả vào phiên nonce.
//  3) App hỏi POST /api/auth/google/poll { nonce } tới khi có kết quả: token / cần mã 2 bước / cần tạo tài khoản.
//  Trang callback hiện MÃ XÁC NHẬN ngắn; app phải gửi đúng mã đó (poll { nonce, code }) mới nhận được kết quả.
//  -> Kẻ gian tự mở luồng rồi gửi link cho nạn nhân bấm cũng không lấy được phiên đăng nhập của nạn nhân.
// Tin nhắn mã hóa đầu-cuối vẫn cần mật khẩu ReaChat (khóa được bọc bằng mật khẩu) -> tài khoản tạo qua Google cũng
// đặt mật khẩu; đăng nhập Google ở máy mới thì app hỏi mật khẩu để mở khóa lịch sử.
// Cấu hình: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (loại "Web application"), PUBLIC_URL (vd. https://chat.example.com);
// URI chuyển hướng khai báo trong Google Cloud: <PUBLIC_URL>/auth/google/callback
import crypto from 'node:crypto';
import db, { getUserById } from './db.js';
import { verifyTotp, checkLimit, recordFail } from './security.js';
import { normEmail } from './verify.js';

const ensureColumn = (t, name, ddl) => {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
};
ensureColumn('users', 'google_sub', 'google_sub TEXT');
ensureColumn('users', 'google_email', 'google_email TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_sub)');

const CID = process.env.GOOGLE_CLIENT_ID, SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';     // ghi đè: chỉ để test
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
export const googleEnabled = () => !!(CID && SECRET && PUBLIC_URL);
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const flows = new Map();   // nonce -> { mode, userId, verifier, at, result, error }
const TTL = 10 * 60_000;
const sweep = () => { const now = Date.now(); for (const [k, f] of flows) if (now - f.at > TTL) flows.delete(k); };

export function begin(mode, userId = null) {
  if (!googleEnabled()) throw err(503, 'Máy chủ chưa cấu hình đăng nhập Google');
  sweep();
  if (flows.size > 10_000) throw err(503, 'Máy chủ bận — thử lại sau');
  const nonce = crypto.randomBytes(24).toString('base64url');
  flows.set(nonce, { mode: mode === 'link' ? 'link' : 'login', userId, verifier: crypto.randomBytes(32).toString('base64url'), at: Date.now(), result: null });
  return { nonce, url: `${PUBLIC_URL}/auth/google/start?n=${nonce}` };
}
export function startUrl(nonce) {
  const f = flows.get(String(nonce || ''));
  if (!f) return null;
  const challenge = crypto.createHash('sha256').update(f.verifier).digest('base64url');
  return AUTH_URL + '?' + new URLSearchParams({
    client_id: CID, redirect_uri: PUBLIC_URL + '/auth/google/callback', response_type: 'code', scope: 'openid email profile',
    state: nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
}
// Đổi mã -> id_token. Token lấy TRỰC TIẾP từ Google bằng client secret qua TLS nên không cần kiểm chữ ký,
// chỉ kiểm aud / iss / hạn (theo hướng dẫn của Google cho luồng máy chủ).
export async function callback({ code, state, error }) {
  const f = flows.get(String(state || ''));
  if (!f) return { ok: false, message: 'Phiên đăng nhập đã hết hạn — hãy thử lại từ ứng dụng.' };
  if (error || !code) { f.error = 'Bạn đã hủy đăng nhập Google'; return { ok: false, message: f.error }; }
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ code, client_id: CID, client_secret: SECRET, redirect_uri: PUBLIC_URL + '/auth/google/callback', grant_type: 'authorization_code', code_verifier: f.verifier }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || 'HTTP ' + r.status);
    const p = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
    if (p.aud !== CID || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss) || p.exp * 1000 < Date.now()) throw new Error('id_token không hợp lệ');
    f.result = { sub: String(p.sub), email: p.email_verified ? normEmail(p.email) : null, name: String(p.name || '').slice(0, 60) };
    f.code = newCode();
    return { ok: true, code: f.code, mode: f.mode };
  } catch (e) {
    f.error = 'Không xác thực được với Google: ' + e.message;
    return { ok: false, message: f.error };
  }
}

const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // không có 0/O/1/I dễ nhầm
const newCode = () => Array.from({ length: 6 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join('');
const sameCode = (a, b) => { a = Buffer.from(String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '')); b = Buffer.from(b); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const MAX_TRIES = 5;   // sai mã xác nhận / mã 2 bước quá số lần -> hủy luồng
const tooMany = (nonce, f) => { if (++f.fails >= MAX_TRIES) flows.delete(nonce); };

const userByGoogle = (sub) => db.prepare('SELECT id FROM users WHERE google_sub = ? AND banned = 0').get(sub);
const suggest = (email, name) => {
  let base = String(email ? email.split('@')[0] : name || 'user').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9_]/g, '').slice(0, 16);
  if (base.length < 3) base = 'user' + base;
  let u = base;
  for (let i = 0; i < 20 && db.prepare('SELECT 1 FROM users WHERE username = ?').get(u); i++) u = base.slice(0, 16) + crypto.randomInt(10, 9999);
  return u;
};
// Gắn Google cho tài khoản. Chỉ khi TẠO tài khoản qua Google (useEmail) mới lấy email Google làm email khôi phục —
// liên kết vào tài khoản có sẵn thì không (email khôi phục = quyền đặt lại mật khẩu, phải tự xác minh riêng).
export function attachGoogle(userId, g, { useEmail = false } = {}) {
  db.prepare('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?').run(g.sub, g.email, userId);
  const u = getUserById(userId);
  if (useEmail && g.email && !u.email_ok && !db.prepare('SELECT 1 FROM users WHERE email = ? AND email_ok IS NOT NULL AND id != ?').get(g.email, userId))
    db.prepare('UPDATE users SET email = ?, email_ok = ? WHERE id = ?').run(g.email, Date.now(), userId);
}

// Hỏi kết quả. deps: { issueToken, register, meta, ip, checkRegisterIp, recordRegisterIp }
export async function poll({ nonce, otp, code, register: reg }, user, deps) {
  nonce = String(nonce || '');
  const f = flows.get(nonce);
  if (!f) throw err(410, 'Phiên đăng nhập Google đã hết hạn — hãy thử lại');
  if (f.error) { flows.delete(nonce); throw err(400, f.error); }
  if (!f.result) return { pending: true };
  f.fails ||= 0;
  if (!code) return { needCode: true };
  if (!sameCode(code, f.code)) { tooMany(nonce, f); throw err(400, 'Mã xác nhận không đúng — xem lại mã trên trang trình duyệt', { needCode: true }); }
  const g = f.result;
  const owner = userByGoogle(g.sub);
  if (f.mode === 'link') {
    if (!user || user.id !== f.userId) throw err(403, 'Phiên liên kết không thuộc tài khoản này');
    if (owner && owner.id !== user.id) { flows.delete(nonce); throw err(409, 'Tài khoản Google này đã liên kết với tài khoản ReaChat khác'); }
    attachGoogle(user.id, g);
    flows.delete(nonce);
    return { linked: true, email: g.email };
  }
  if (owner) {
    const u = getUserById(owner.id);
    if (u.totp_on) {
      if (!otp) throw err(401, 'Nhập mã xác thực 2 bước', { need2fa: true });
      checkLimit('u:' + u.username);
      if (!verifyTotp(u.id, u.totp_secret, otp)) { recordFail('u:' + u.username); tooMany(nonce, f); throw err(401, 'Mã xác thực không đúng hoặc đã hết hạn', { need2fa: true }); }
    }
    flows.delete(nonce);
    return { ...deps.issueToken(u, deps.meta), via: 'google' };
  }
  // Chưa có tài khoản: tạo mới (chọn username + mật khẩu để bảo vệ khóa mã hóa).
  if (!reg) return { needRegister: true, email: g.email, name: g.name, suggestedUsername: suggest(g.email, g.name) };
  if (!reg.acceptTerms) throw err(400, 'Bạn cần đồng ý Điều khoản sử dụng và Chính sách quyền riêng tư');
  deps.checkRegisterIp(deps.ip);
  const out = await deps.register({ ...reg, displayName: reg.displayName || g.name, acceptTerms: true }, { ...deps.meta, ip: deps.ip });
  deps.recordRegisterIp(deps.ip);
  attachGoogle(out.user.id, g, { useEmail: true });
  flows.delete(nonce);
  return { ...out, via: 'google', created: true };
}
export function unlink(user) {
  if (!user.google_sub) throw err(400, 'Chưa liên kết Google');
  db.prepare('UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = ?').run(user.id);
  return { ok: true };
}

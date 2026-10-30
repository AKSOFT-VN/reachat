// Đăng nhập máy mới bằng mã QR quét từ máy đang đăng nhập.
// Máy mới: begin(epk, hash(bí mật)) -> hiện QR "reachat-login:<sid>.<epk>" -> poll(sid, bí mật).
// Máy cũ (đã xác thực): info(sid) để hiện thiết bị/IP đang xin -> approve(sid, sealed) với sealed = bó khóa danh tính
// niêm phong cho epk (máy chủ chỉ chuyển bản mã). Poll lần đầu sau khi duyệt nhận token + sealed, rồi phiên bị xóa.
// Bí mật poll chỉ máy mới biết -> ai chụp được QR cũng không lấy được token.
import crypto from 'node:crypto';

const TTL_MS = 120_000;
const sessions = new Map();          // sid -> { epk, secretHash, device, ip, createdAt, userId?, sealed? }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

function sweep(now = Date.now()) { for (const [sid, s] of sessions) if (now - s.createdAt > TTL_MS) sessions.delete(sid); }
setInterval(sweep, 30_000).unref();

function live(sid) {
  const s = sessions.get(String(sid || ''));
  if (!s || Date.now() - s.createdAt > TTL_MS) { sessions.delete(String(sid || '')); throw fail(410, 'Mã QR đã hết hạn — hãy tạo mã mới'); }
  return s;
}

export function begin({ epk, secret } = {}, { device, ip }) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(String(epk || ''))) throw fail(400, 'Khóa tạm không hợp lệ');
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 128) throw fail(400, 'Thiếu bí mật phiên');
  if (sessions.size > 5000) sweep();
  const sid = crypto.randomBytes(18).toString('base64url');
  sessions.set(sid, { epk, secretHash: sha(secret), device: String(device || '').slice(0, 120), ip, createdAt: Date.now() });
  return { sid, expiresAt: Date.now() + TTL_MS };
}

// Máy đang đăng nhập xem ai đang xin (để người dùng nhận ra máy của chính mình trước khi duyệt).
export function info(sid) {
  const s = live(sid);
  if (s.userId) throw fail(409, 'Mã này đã được dùng');
  return { epk: s.epk, device: s.device, ip: s.ip, createdAt: s.createdAt };
}

export function approve(sid, sealed, user) {
  const s = live(sid);
  if (s.userId) throw fail(409, 'Mã này đã được dùng');
  if (!sealed || typeof sealed !== 'object' || String(JSON.stringify(sealed)).length > 64_000) throw fail(400, 'Thiếu gói khóa');
  s.userId = user.id; s.sealed = sealed;
  return { ok: true };
}

export function poll({ sid, secret } = {}, { getUserById, issueToken, meta }) {
  const s = live(sid);
  if (!secret || sha(secret) !== s.secretHash) throw fail(403, 'Sai bí mật phiên');
  if (!s.userId) return { pending: true };
  sessions.delete(String(sid));                                   // dùng một lần
  const u = getUserById(s.userId);
  if (!u || u.banned || u.deleted_at) throw fail(403, 'Tài khoản không đăng nhập được');
  return { ...issueToken(u, meta), sealed: s.sealed, via: 'qr' };
}

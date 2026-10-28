import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_TTL } from './config.js';
import { createUser, getUserByUsername, getUserById, publicUser, updatePublicKey, setPasswordHash, setTotp, setRecovery } from './db.js';
import { verifyTotp, checkLimit, recordFail, clearFails, failCount } from './security.js';
import { checkCaptcha, captchaError, captchaEnabled } from './captcha.js';
import { createSession, sessionValid, revokeAll, markTerms } from './account.js';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export const register = async ({ username, password, displayName, publicKey, acceptTerms }, meta = {}) => {
  username = String(username || '').toLowerCase().trim();
  if (!USERNAME_RE.test(username)) {
    throw httpError(400, 'Username 3-20 ký tự, chỉ gồm a-z, 0-9, _');
  }
  if (!password || password.length < 6) {
    throw httpError(400, 'Mật khẩu tối thiểu 6 ký tự');
  }
  if (getUserByUsername(username)) {
    throw httpError(409, 'Username đã tồn tại');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = createUser({
    username,
    displayName: (displayName || username).trim(),
    passwordHash,
    publicKey,
  });
  if (acceptTerms) markTerms(user.id);
  return { token: sign(user, meta), user: publicUser(user) };
};

export const login = async ({ username, password, publicKey, otp, captcha }, ip = '', meta = {}) => {
  username = String(username || '').toLowerCase().trim();
  // Chặn cứng theo cặp (tài khoản, IP) + theo IP; theo tài khoản chỉ chặn ở ngưỡng cao hơn — để kẻ khác không khóa
  // được tài khoản của bạn chỉ bằng vài lần nhập sai (sau 3 lần sai theo tài khoản đã phải giải captcha).
  checkLimit('ui:' + username + '@' + ip); checkLimit('uh:' + username); checkLimit('ip:' + ip);
  // Sai nhiều lần (theo tài khoản hoặc theo mạng) -> phải giải captcha (chống dò mật khẩu tự động).
  if (captchaEnabled() && (failCount('u:' + username) >= 3 || failCount('ip:' + ip) >= 10) && !checkCaptcha(captcha))
    throw captchaError(captcha ? undefined : 'Bạn đã nhập sai nhiều lần — hãy nhập mã captcha');
  const user = getUserByUsername(username);
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    recordFail('u:' + username); recordFail('ui:' + username + '@' + ip); recordFail('uh:' + username); recordFail('ip:' + ip);
    throw httpError(401, 'Sai username hoặc mật khẩu');
  }
  if (user.banned) throw httpError(403, 'Tài khoản đã bị khóa' + (user.ban_reason ? ': ' + user.ban_reason : ''));
  // Bật xác thực 2 bước: mật khẩu đúng nhưng thiếu/sai mã -> yêu cầu mã 6 số từ ứng dụng xác thực.
  if (user.totp_on) {
    if (!otp) { const e = httpError(401, 'Nhập mã xác thực 2 bước'); e.need2fa = true; throw e; }
    if (!verifyTotp(user.id, user.totp_secret, otp)) {
      recordFail('u:' + username); recordFail('ui:' + username + '@' + ip); recordFail('uh:' + username); recordFail('ip:' + ip);
      const e = httpError(401, 'Mã xác thực không đúng hoặc đã hết hạn'); e.need2fa = true; throw e;
    }
  }
  clearFails('u:' + username); clearFails('ui:' + username + '@' + ip);
  // Nạp khóa công khai khi đăng nhập (tài khoản seed hoặc đổi thiết bị chưa có khóa).
  if (publicKey && publicKey !== user.public_key) {
    updatePublicKey(user.id, publicKey);
    user.public_key = publicKey;
  }
  return { token: sign(user, { ...meta, ip }), user: publicUser(user) };
};

// Đổi mật khẩu (cần mật khẩu cũ + mã 2 bước nếu bật). Trả token mới; client phải bọc lại bản sao lưu khóa.
export const changePassword = async (user, { oldPassword, newPassword, otp }) => {
  checkLimit('u:' + user.username);
  if (!(await bcrypt.compare(oldPassword || '', user.password_hash))) { recordFail('u:' + user.username); throw httpError(403, 'Mật khẩu hiện tại không đúng'); }
  if (user.totp_on && !verifyTotp(user.id, user.totp_secret, otp)) { recordFail('u:' + user.username); throw httpError(403, 'Mã xác thực 2 bước không đúng'); }
  if (!newPassword || newPassword.length < 6) throw httpError(400, 'Mật khẩu mới tối thiểu 6 ký tự');
  setPasswordHash(user.id, await bcrypt.hash(newPassword, 10));
  revokeAll(user.id);
  const fresh = getUserById(user.id);
  return { token: sign(fresh, { device: user.sessionDevice }), user: publicUser(fresh) };
};

// Quên mật khẩu: chứng minh có mã khôi phục (gửi "verifier" = SHA-256 của mã, KHÔNG gửi mã) -> đặt mật khẩu mới,
// tắt 2 bước, hủy mã (dùng một lần), thu hồi mọi phiên. Trả bản sao lưu khóa bọc bằng mã để máy dựng lại khóa.
export const recoverAccount = async ({ username, verifier, newPassword, device }, ip = '') => {
  username = String(username || '').toLowerCase().trim();
  checkLimit('rc:' + username); checkLimit('ip:' + ip);
  const user = getUserByUsername(username);
  if (!user || !user.rc_hash || !(await bcrypt.compare(String(verifier || ''), user.rc_hash))) {
    recordFail('rc:' + username); recordFail('ip:' + ip);
    throw httpError(401, 'Mã khôi phục không đúng');
  }
  if (!newPassword || newPassword.length < 6) throw httpError(400, 'Mật khẩu mới tối thiểu 6 ký tự');
  const recoveryBackup = user.rc_backup ? JSON.parse(user.rc_backup) : null;
  setPasswordHash(user.id, await bcrypt.hash(newPassword, 10));
  setTotp(user.id, null, false);
  setRecovery(user.id, null, null);
  clearFails('rc:' + username);
  revokeAll(user.id);
  const fresh = getUserById(user.id);
  return { token: sign(fresh, { device, ip }), user: publicUser(fresh), recoveryBackup };
};

export const setMyPublicKey = (userId, publicKey) => {
  if (publicKey) updatePublicKey(userId, publicKey);
};

export { updateProfile } from './db.js';

// tv = token_ver: đổi/đặt lại mật khẩu -> tăng -> mọi token cũ (mọi thiết bị) hết hiệu lực.
// Mỗi token gắn một phiên (sid) -> thu hồi được từng thiết bị. tv = token_ver: đổi/đặt lại mật khẩu -> mọi token cũ hết hiệu lực.
const sign = (user, meta = {}) => {
  const sid = createSession(user.id, meta);
  return jwt.sign({ sub: user.id, username: user.username, tv: user.token_ver || 0, sid }, JWT_SECRET, { expiresIn: JWT_TTL });
};

// Cấp token + thông tin người dùng (dùng cho các luồng đăng nhập khác, vd. đặt lại mật khẩu qua email/SMS).
export const issueToken = (user, meta = {}) => ({ token: sign(user, meta), user: publicUser(user) });

export const verifyToken = (token) => {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserById(payload.sub);
    if (!user || user.banned || (payload.tv || 0) !== (user.token_ver || 0)) return null;
    // Mọi token phải gắn một phiên còn hiệu lực (token không có sid = không thu hồi được -> từ chối).
    if (!payload.sid || !sessionValid(payload.sid, user.id)) return null;
    user.sid = payload.sid || null;
    return user;
  } catch {
    return null;
  }
};

export const httpError = (status, message) => {
  const e = new Error(message);
  e.status = status;
  return e;
};

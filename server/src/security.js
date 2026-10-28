// Bảo mật tài khoản: xác thực 2 bước TOTP (RFC 6238, tương thích Google Authenticator/Authy…),
// giới hạn số lần thử sai (chống dò mật khẩu/mã), mã khôi phục tài khoản.
import crypto from 'node:crypto';

// ---- Base32 (RFC 4648) cho khóa TOTP ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32Encode = (buf) => {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
};
export const base32Decode = (s) => {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export const totpAt = (secret, step) => {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
};
const lastStep = new Map();   // userId -> bước đã dùng gần nhất (chống dùng lại cùng một mã)
// Chấp nhận lệch ±1 bước (30s) do đồng hồ; mỗi mã chỉ dùng được một lần.
export function verifyTotp(userId, secret, code, now = Date.now()) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || !secret) return false;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const st = step + d;
    if (st <= (lastStep.get(userId) || 0)) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, st)), Buffer.from(code))) { lastStep.set(userId, st); return true; }
  }
  return false;
}
export const otpauthUri = (username, secret) =>
  `otpauth://totp/ReaChat:${encodeURIComponent(username)}?secret=${secret}&issuer=ReaChat&algorithm=SHA1&digits=6&period=30`;

// ---- Giới hạn thử sai: tối đa MAX lần sai / WINDOW cho mỗi khóa (username / IP) ----
const MAX = Number(process.env.LOGIN_MAX_FAILS) || 8, WINDOW = 15 * 60_000;
const fails = new Map();   // key -> [thời điểm sai...]
export function checkLimit(key) {
  const now = Date.now();
  // theo IP / theo riêng tài khoản (mọi IP) rộng hơn: nhiều người chung mạng; không cho người lạ khóa tài khoản quá dễ
  const max = key.startsWith('ip:') || key.startsWith('uh:') ? MAX * 5 : MAX;
  const list = (fails.get(key) || []).filter((t) => now - t < WINDOW);
  fails.set(key, list);
  if (list.length >= max) {
    const wait = Math.ceil((WINDOW - (now - list[0])) / 60000);
    const e = new Error(`Thử sai quá nhiều lần — thử lại sau ${wait} phút`); e.status = 429; throw e;
  }
}
export const failCount = (key) => (fails.get(key) || []).filter((t) => Date.now() - t < WINDOW).length;
export const recordFail = (key) => fails.set(key, [...(fails.get(key) || []), Date.now()]);
export const clearFails = (key) => fails.delete(key);

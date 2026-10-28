// Trạng thái tự đặt + tự động trả lời.
// Tin tự động trả lời do MÁY CHỦ gửi thay (người dùng có thể đang tắt máy) -> KHÔNG mã hóa đầu-cuối; giao diện ghi rõ.
// Mỗi người nhận tối đa 1 tin tự động trả lời / AUTO_REPLY_HOURS giờ (mặc định 6) cho cùng một người gửi.
import db, { getUserById } from './db.js';
import { assertClean } from './moderation.js';

const HOURS = Number(process.env.AUTO_REPLY_HOURS) || 6;
const err = (status, message) => Object.assign(new Error(message), { status });
export const statusActive = (u) => !!u?.status_text && (!u.status_until || u.status_until > Date.now());

export function setStatus(userId, { text, until, autoReply }) {
  const t = text ? String(text).trim().slice(0, 80) : null;
  const un = until ? Number(until) : null;
  if (un && (!Number.isFinite(un) || un < Date.now())) throw err(400, 'Thời hạn trạng thái phải ở tương lai');
  const ar = autoReply ? String(autoReply).trim().slice(0, 300) : null;
  if (ar && !t) throw err(400, 'Đặt trạng thái trước khi bật tự động trả lời');
  assertClean(t, 'Trạng thái'); assertClean(ar, 'Tin tự động trả lời');
  db.prepare('UPDATE users SET status_text = ?, status_until = ?, auto_reply = ? WHERE id = ?').run(t, t ? un : null, t ? ar : null, userId);
  if (!t || !ar) db.prepare('DELETE FROM auto_reply_log WHERE user_id = ?').run(userId);
  return getStatus(getUserById(userId), true);
}
export const getStatus = (u, self = false) => (statusActive(u)
  ? { text: u.status_text, until: u.status_until || null, ...(self ? { autoReply: u.auto_reply || null } : {}) }
  : { text: null, until: null, ...(self ? { autoReply: null } : {}) });

// Gọi sau khi một tin 1-1 được gửi tới recipientId. Trả về nội dung cần gửi tự động (hoặc null).
export function autoReplyFor(recipientId, senderId) {
  if (recipientId === senderId) return null;
  const u = getUserById(recipientId);
  if (!u?.auto_reply || !statusActive(u)) return null;
  const last = db.prepare('SELECT at FROM auto_reply_log WHERE user_id = ? AND peer_id = ?').get(recipientId, senderId)?.at || 0;
  if (Date.now() - last < HOURS * 3600_000) return null;
  db.prepare('INSERT OR REPLACE INTO auto_reply_log (user_id, peer_id, at) VALUES (?,?,?)').run(recipientId, senderId, Date.now());
  return JSON.stringify({ text: u.auto_reply, status: u.status_text, until: u.status_until || null });
}

// Đồng bộ tùy chọn giữa các thiết bị của cùng một người: ghim/tắt thông báo/lưu trữ/nhãn hội thoại, bản nháp,
// tin "xóa phía tôi", hội thoại đã xóa, tin đánh dấu sao.
// Tài liệu được MÃ HÓA trên máy bằng khóa riêng của người dùng (như Cloud của tôi) -> máy chủ chỉ giữ bản mã.
// Chống ghi đè: mỗi lần ghi phải nêu phiên bản đang có (baseVersion); lệch -> 409 kèm bản mới nhất để máy gộp lại.
import db from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS user_sync (user_id TEXT PRIMARY KEY, blob TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
const MAX = 512 * 1024;
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export const getSync = (userId) => {
  const r = db.prepare('SELECT blob, version, updated_at FROM user_sync WHERE user_id = ?').get(userId);
  return r ? { blob: r.blob, version: r.version, updatedAt: r.updated_at } : { blob: null, version: 0 };
};
export function putSync(userId, { baseVersion, blob }) {
  if (typeof blob !== 'string' || !blob || blob.length > MAX) throw err(400, 'Dữ liệu đồng bộ không hợp lệ hoặc quá lớn');
  const cur = getSync(userId);
  if ((Number(baseVersion) || 0) !== cur.version) throw err(409, 'Có thay đổi mới hơn từ thiết bị khác', { current: cur });
  const version = cur.version + 1;
  db.prepare(`INSERT INTO user_sync (user_id, blob, version, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, version = excluded.version, updated_at = excluded.updated_at`).run(userId, blob, version, Date.now());
  return { version };
}

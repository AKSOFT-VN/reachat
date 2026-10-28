// Hạn mức TURN Cloudflare: Cloudflare miễn phí 1.000 GB/tháng rồi tính tiền, KHÔNG có nút tự chặn -> ReaChat tự đo.
// - App đo số byte NHẬN qua ứng viên "relay" (= lưu lượng Cloudflare gửi ra, đúng phần Cloudflare tính tiền) và báo về.
// - Tổng tháng (theo giờ UTC, như Cloudflare tính) >= TURN_MONTHLY_GB (mặc định 900, chừa 10% an toàn) -> ngừng cấp TURN
//   Cloudflare đến hết tháng. Mỗi người tối đa TURN_USER_MONTHLY_GB (mặc định 50) để một người không dùng hết phần chung.
// - Số liệu do app tự báo: là ước lượng (cộng thêm 10% cho phần đầu gói tin). Số chính xác xem trong Cloudflare Dashboard.
import db from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS turn_usage (month TEXT NOT NULL, user_id TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, user_id))`);

const GB = 1024 ** 3;
export const MONTHLY_BYTES = (Number(process.env.TURN_MONTHLY_GB) || 900) * GB;
export const USER_MONTHLY_BYTES = (Number(process.env.TURN_USER_MONTHLY_GB) || 50) * GB;
const MAX_REPORT = 300 * 1024 ** 2;   // một lần báo (~20 giây) không thể quá 300 MB (~120 Mbps)

const month = () => new Date().toISOString().slice(0, 7);
export const monthTotal = () => db.prepare('SELECT COALESCE(SUM(bytes), 0) n FROM turn_usage WHERE month = ?').get(month()).n;
export const userTotal = (userId) => db.prepare('SELECT bytes FROM turn_usage WHERE month = ? AND user_id = ?').get(month(), userId)?.bytes || 0;

export function record(userId, bytes) {
  const b = Math.min(MAX_REPORT, Math.max(0, Math.floor(Number(bytes) || 0)));
  if (!b) return;
  db.prepare(`INSERT INTO turn_usage (month, user_id, bytes) VALUES (?,?,?)
    ON CONFLICT(month, user_id) DO UPDATE SET bytes = bytes + excluded.bytes`).run(month(), userId, Math.ceil(b * 1.1));
}
// null = được dùng; chuỗi = lý do bị chặn
export function blockedReason(userId) {
  if (monthTotal() >= MONTHLY_BYTES) return 'month';
  if (userTotal(userId) >= USER_MONTHLY_BYTES) return 'user';
  return null;
}
export const usageSummary = () => ({
  month: month(), usedGB: +(monthTotal() / GB).toFixed(2), limitGB: MONTHLY_BYTES / GB, userLimitGB: USER_MONTHLY_BYTES / GB,
  top: db.prepare('SELECT u.username, t.bytes FROM turn_usage t LEFT JOIN users u ON u.id = t.user_id WHERE t.month = ? ORDER BY t.bytes DESC LIMIT 5')
    .all(month()).map((r) => ({ username: r.username, GB: +(r.bytes / GB).toFixed(2) })),
});

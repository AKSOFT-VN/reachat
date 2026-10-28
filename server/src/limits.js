// Chống spam + hạn mức dung lượng.
// - Giới hạn tốc độ kiểu "xô token" theo (người dùng, nhóm thao tác): cho phép dồn một đợt ngắn (burst),
//   sau đó hồi dần theo thời gian. Mức đặt rộng — người dùng thật không chạm tới, script spam bị chặn ngay.
// - Hạn mức dung lượng tệp mỗi người + dọn tệp mồ côi (tải lên nhưng không tin/story nào dùng).
import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';

const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
// burst = tối đa dồn một lúc; perSec = tốc độ hồi. Chỉnh bằng biến môi trường RATE_<NHÓM>="burst/perSec".
const parse = (s, d) => { const m = /^(\d+)\/([\d.]+)$/.exec(String(s || '')); return m ? { burst: +m[1], perSec: +m[2] } : d; };
export const RATES = {
  msg: parse(process.env.RATE_MSG, { burst: 120, perSec: 20 }),         // tin nhắn/sửa/cảm xúc: 120 rồi 20/giây mỗi người (nới bằng RATE_MSG="burst/perSec")
  create: parse(process.env.RATE_CREATE, { burst: 10, perSec: 1 / 30 }), // tạo nhóm/kênh/phòng/link: 10 rồi 2/phút
  signal: parse(process.env.RATE_SIGNAL, { burst: 400, perSec: 60 }),   // tín hiệu cuộc gọi (ICE dồn nhiều lúc đầu)
  upload: parse(process.env.RATE_UPLOAD, { burst: 20, perSec: 0.1 }),   // tải tệp: 20 rồi 6/phút
  friend: parse(process.env.RATE_FRIEND, { burst: 20, perSec: 1 / 60 }), // lời mời kết bạn: 20 rồi 1/phút
  frame: parse(process.env.RATE_FRAME, { burst: 300, perSec: 50 }),     // mọi gói WebSocket của một kết nối
};
// Loại gói WebSocket -> nhóm giới hạn.
export const WS_BUCKET = {
  send: 'msg', edit: 'msg', react: 'msg', schedule: 'msg', vote: 'msg', 'task:create': 'msg', 'doc:push': 'msg',
  'group:create': 'create', 'channel:create': 'create', 'meet:create': 'create', 'invite:create': 'create', 'group:add': 'create',
  signal: 'signal', gsignal: 'signal',
};

const buckets = new Map();   // "nhóm:khóa" -> { tokens, at }
// Trả 0 nếu được phép, ngược lại số giây phải chờ.
export function take(group, key, cost = 1) {
  const r = RATES[group]; if (!r) return 0;               // nhóm không đặt giới hạn
  const k = group + ':' + key, now = Date.now();
  const b = buckets.get(k) || { tokens: r.burst, at: now };
  b.tokens = Math.min(r.burst, b.tokens + ((now - b.at) / 1000) * r.perSec);
  b.at = now;
  if (b.tokens >= cost) { b.tokens -= cost; buckets.set(k, b); return 0; }
  buckets.set(k, b);
  return Math.ceil((cost - b.tokens) / r.perSec);
}
export const limitError = (wait) => Object.assign(new Error(`Bạn thao tác quá nhanh — thử lại sau ${wait} giây`), { status: 429, wait });
export function check(group, key, cost = 1) { const w = take(group, key, cost); if (w) throw limitError(w); }
// Dọn xô đã đầy lại (không còn tác dụng) để bộ nhớ không phình.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) { const r = RATES[k.split(':')[0]]; if (r && b.tokens + ((now - b.at) / 1000) * r.perSec >= r.burst) buckets.delete(k); }
}, 60_000).unref?.();

// ---- Dung lượng ----
// Hạn mức mỗi người: mặc định KHÔNG giới hạn (0). Thay vào đó chặn tải lên khi ổ đĩa máy chủ sắp đầy.
export const QUOTA_BYTES = (Number(process.env.USER_QUOTA_MB) || 0) * 1024 * 1024;
export const MIN_FREE_BYTES = (Number(process.env.MIN_FREE_GB) || 2) * 1024 ** 3;
export const usedBytes = (userId) => db.prepare('SELECT COALESCE(SUM(size), 0) n FROM files WHERE owner_id = ?').get(userId).n;
// Tệp đang tải lên theo khúc là tệp thưa (chưa chiếm đĩa) -> phải tính phần CÒN SẼ GHI vào, nếu không nhiều lượt
// khởi tạo song song đều lọt kiểm tra rồi cùng làm đầy ổ đĩa.
const reservedBytes = () => db.prepare(`SELECT COALESCE(SUM(f.size - (SELECT COUNT(*) FROM file_parts p WHERE p.file_id = f.id) * f.chunk_size), 0) n
  FROM files f WHERE f.status = 'uploading'`).get().n;
export function checkDisk(dir, adding) {
  try {
    const st = fs.statfsSync(dir);
    let reserved = 0; try { reserved = Math.max(0, reservedBytes()); } catch {}
    if (st.bavail * st.bsize - reserved - adding < MIN_FREE_BYTES) throw Object.assign(new Error('Máy chủ sắp hết dung lượng lưu trữ — hãy gửi trực tiếp (P2P) hoặc báo quản trị viên'), { status: 507 });
  } catch (e) { if (e.status) throw e; }
}
export function checkQuota(userId, adding) {
  if (!QUOTA_BYTES) return;
  const used = usedBytes(userId);
  if (used + adding > QUOTA_BYTES) {
    const mb = (b) => (b / 1048576).toFixed(0);
    throw Object.assign(new Error(`Vượt hạn mức lưu trữ (${mb(used)}/${mb(QUOTA_BYTES)} MB) — hãy xóa bớt tin có tệp cũ`), { status: 413 });
  }
}

// Tệp mồ côi: quá ORPHAN_HOURS mà không tin nhắn / story nào tham chiếu -> xóa bản ghi + tệp trên đĩa.
const ORPHAN_HOURS = n(process.env.ORPHAN_HOURS, 24);
export function sweepOrphans(uploadDir) {
  const old = Date.now() - ORPHAN_HOURS * 3600_000;
  const rows = db.prepare(`SELECT f.id FROM files f WHERE f.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE instr(m.body, f.id) > 0)
      AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.file_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM scheduled_messages q WHERE instr(q.body, f.id) > 0)`).all(old);   // tin hẹn giờ chưa gửi
  let freed = 0;
  for (const { id } of rows) {
    const p = path.join(uploadDir, id);
    try { freed += fs.statSync(p).size; fs.unlinkSync(p); } catch {}
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }
  // Bản ghi còn mà tệp trên đĩa đã mất (thu hồi/tự hủy/xem một lần đã xóa tệp) -> bỏ bản ghi để hạn mức tính đúng.
  for (const { id } of db.prepare('SELECT id FROM files').all()) if (!fs.existsSync(path.join(uploadDir, id))) db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return { removed: rows.length, freed };
}

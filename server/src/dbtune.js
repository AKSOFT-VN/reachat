// Tối ưu SQLite (giai đoạn 1 — trước khi cần PostgreSQL / nhiều máy chủ):
//  - PRAGMA cho tốc độ: WAL + synchronous=NORMAL (an toàn với WAL, ghi nhanh hơn nhiều), bộ đệm 64 MB, mmap 256 MB,
//    bảng tạm trong RAM, chờ khóa 5 giây thay vì lỗi ngay.
//  - Chỉ mục cho các truy vấn hay chạy còn thiếu.
//  - Nhớ đệm câu lệnh đã biên dịch (cùng chuỗi SQL -> dùng lại, khỏi biên dịch lại mỗi lần gọi).
//  - Theo dõi truy vấn chậm (> SLOW_QUERY_MS, mặc định 50 ms): ghi log + hiện trên trang quản trị.
//  - PRAGMA optimize định kỳ (SQLite tự cập nhật thống kê để chọn chỉ mục đúng).
// PHẢI được import TRƯỚC các module khác dùng db (đặt đầu index.js).
import db from './db.js';

db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -65536');          // 64 MB
db.pragma('mmap_size = 268435456');        // 256 MB

const tableExists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const colExists = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
for (const [t, cols, sql] of [
  ['messages', ['sender_id'], 'CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)'],
  ['messages', ['expire_at'], 'CREATE INDEX IF NOT EXISTS idx_messages_expire ON messages(expire_at) WHERE expire_at IS NOT NULL'],
  ['files', ['owner_id'], 'CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id)'],
  ['files', ['created_at'], 'CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at)'],
  ['users', ['email'], 'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL'],
  ['users', ['phone'], 'CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL'],
  ['contacts', ['contact_id'], 'CREATE INDEX IF NOT EXISTS idx_contacts_contact ON contacts(contact_id)'],
  ['friend_requests', ['from_id'], 'CREATE INDEX IF NOT EXISTS idx_friendreq_from ON friend_requests(from_id, status)'],
  ['client_errors', ['at'], 'CREATE INDEX IF NOT EXISTS idx_client_errors_at ON client_errors(at)'],
  ['conversation_reads', ['user_id'], 'CREATE INDEX IF NOT EXISTS idx_reads_user ON conversation_reads(user_id)'],
]) if (tableExists(t) && cols.every((c) => colExists(t, c))) db.exec(sql);

// ---- nhớ đệm câu lệnh + đo thời gian ----
const SLOW_MS = Number(process.env.SLOW_QUERY_MS) || 50;
const slow = [];                                   // 30 truy vấn chậm gần nhất
const stats = { queries: 0, slow: 0 };
const cache = new Map();
const rawPrepare = db.prepare.bind(db);
const timed = (st, sql) => {
  for (const m of ['run', 'get', 'all']) {
    const fn = st[m].bind(st);
    st[m] = (...a) => {
      const t = performance.now();
      try { return fn(...a); } finally {
        const d = performance.now() - t; stats.queries++;
        if (d > SLOW_MS) {
          stats.slow++;
          slow.unshift({ at: Date.now(), ms: Math.round(d), sql: sql.replace(/\s+/g, ' ').trim().slice(0, 300) }); slow.length = Math.min(slow.length, 30);
          console.warn(`[truy vấn chậm] ${Math.round(d)} ms: ${sql.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
        }
      }
    };
  }
  return st;
};
db.prepare = (sql) => {
  let st = cache.get(sql);
  if (!st) { st = timed(rawPrepare(sql), sql); if (cache.size < 2000) cache.set(sql, st); }
  return st;
};
export const dbStats = () => {
  let sizeMB = null;
  try { sizeMB = +((db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true })) / 1048576).toFixed(1); } catch {}
  return { ...stats, slowMs: SLOW_MS, cachedStatements: cache.size, sizeMB, recentSlow: slow.slice(0, 10) };
};

// SQLite tự cập nhật thống kê để chọn chỉ mục tốt (rẻ, chạy mỗi 6 giờ).
const optimize = () => { try { db.pragma('optimize'); } catch {} };
optimize();
setInterval(optimize, 6 * 3600_000).unref?.();

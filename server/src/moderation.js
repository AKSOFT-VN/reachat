// Kiểm duyệt + nhật ký quản trị.
// - Từ ngữ cấm / tên miền bị chặn (quản trị viên sửa trên /admin). Áp dụng cho nội dung MÁY CHỦ ĐỌC ĐƯỢC:
//   bài đăng + tên/mô tả kênh công khai, tên nhóm, username / tên hiển thị / giới thiệu / trạng thái / tự động trả lời.
//   Tin nhắn mã hóa đầu-cuối thì máy chủ không đọc được -> không lọc (người dùng báo cáo vi phạm như hiện nay).
// - So khớp nguyên từ, không phân biệt dấu / hoa thường ("dm" không khớp "admin"). Tên miền: khớp cả tên miền con.
// - Nhật ký quản trị: mọi thao tác thay đổi trên /api/admin/* (ai, lúc nào, làm gì, với ai).
import db from './db.js';
import { fold } from './search.js';

db.exec('CREATE TABLE IF NOT EXISTS mod_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.exec(`CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, admin_id TEXT,
  action TEXT NOT NULL, target TEXT, detail TEXT)`);

const getSetting = (k) => db.prepare('SELECT value FROM mod_settings WHERE key = ?').get(k)?.value || '';
const lines = (s) => [...new Set(String(s || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 2000);
let cache = null;
const load = () => {
  const words = lines(getSetting('blocked_words')).map(fold).filter((w) => w.length >= 2);
  const domains = lines(getSetting('blocked_domains')).map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/\/.*$/, '')).filter((d) => d.includes('.'));
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+');
  cache = { words, domains, re: words.length ? new RegExp(`(^|[^a-z0-9])(${words.map(esc).join('|')})(?=$|[^a-z0-9])`) : null };
  return cache;
};

export const getModeration = () => ({ blockedWords: getSetting('blocked_words'), blockedDomains: getSetting('blocked_domains') });
export function setModeration({ blockedWords, blockedDomains }) {
  const put = db.prepare('INSERT OR REPLACE INTO mod_settings (key, value) VALUES (?, ?)');
  if (blockedWords != null) put.run('blocked_words', String(blockedWords).slice(0, 100_000));
  if (blockedDomains != null) put.run('blocked_domains', String(blockedDomains).slice(0, 100_000));
  load();
  return getModeration();
}

// Trả về lý do vi phạm (chuỗi) hoặc null.
export function checkText(text) {
  const c = cache || load();
  const s = String(text || '');
  if (!s) return null;
  if (c.re) { const m = fold(s).match(c.re); if (m) return `từ ngữ bị cấm (“${m[2]}”)`; }
  if (c.domains.length) {
    for (const [, host] of s.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]|\b)/gi)) {
      const h = host.toLowerCase();
      const bad = c.domains.find((d) => h === d || h.endsWith('.' + d));
      if (bad) return `liên kết tới trang bị chặn (${bad})`;
    }
  }
  return null;
}
export function assertClean(text, what = 'Nội dung') {
  const why = checkText(text);
  if (why) throw Object.assign(new Error(`${what} chứa ${why}`), { status: 400 });
}

// ---- Nhật ký quản trị ----
export function audit(adminId, action, target, detail) {
  db.prepare('INSERT INTO admin_audit (at, admin_id, action, target, detail) VALUES (?,?,?,?,?)')
    .run(Date.now(), adminId || null, String(action).slice(0, 100), target ? String(target).slice(0, 100) : null, detail ? String(detail).slice(0, 500) : null);
  db.prepare('DELETE FROM admin_audit WHERE id <= (SELECT MAX(id) - 5000 FROM admin_audit)').run();
}
export const auditLog = (limit = 200) => db.prepare(`SELECT a.at, a.action, a.target, a.detail, u.username admin FROM admin_audit a
  LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT ?`).all(limit);

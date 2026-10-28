// Tìm bạn bè: theo tên hiển thị (không dấu, không phân biệt hoa thường), username, hoặc email / số điện thoại
// ĐÃ xác minh (chỉ khớp CHÍNH XÁC — không cho dò danh sách). Người dùng tắt được trong Quyền riêng tư:
//  find_by_name = 0  -> không hiện khi người khác tìm theo tên / một phần username (vẫn kết bạn được bằng username đầy đủ, QR)
//  find_by_contact = 0 -> không tìm thấy bằng email / số điện thoại
// Chống cào dữ liệu: mỗi người tối đa SEARCH_PER_MIN lần / phút, kết quả tối đa 20, từ khóa >= 2 ký tự.
import db from './db.js';
import { normEmail, normPhone } from './verify.js';

const ensureColumn = (t, name, ddl) => {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
};
ensureColumn('users', 'search_name', 'search_name TEXT');                       // tên + username đã bỏ dấu, chữ thường
ensureColumn('users', 'find_by_name', 'find_by_name INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'find_by_contact', 'find_by_contact INTEGER NOT NULL DEFAULT 1');

export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const searchText = (u) => fold(`${u.display_name || ''} ${u.username || ''}`);
export const refreshSearchName = (id) => {
  const u = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(id);
  if (u) db.prepare('UPDATE users SET search_name = ? WHERE id = ?').run(searchText(u), id);
};
// Lấp cột cho người dùng cũ / người vừa đổi tên (rẻ: chỉ các dòng còn thiếu).
const backfill = () => {
  for (const u of db.prepare('SELECT id, username, display_name FROM users WHERE search_name IS NULL LIMIT 5000').all())
    db.prepare('UPDATE users SET search_name = ? WHERE id = ?').run(searchText(u), u.id);
};
backfill();

const hits = new Map();   // userId -> [thời điểm]
const PER_MIN = Number(process.env.SEARCH_PER_MIN) || 30;
const escLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export function searchUsers(me, q) {
  const now = Date.now();
  const list = (hits.get(me.id) || []).filter((t) => now - t < 60_000);
  if (list.length >= PER_MIN) throw Object.assign(new Error('Tìm kiếm quá nhanh — đợi một chút rồi thử lại'), { status: 429 });
  hits.set(me.id, [...list, now]);
  backfill();
  const raw = String(q || '').trim().replace(/^@+/, '').slice(0, 60);
  if (raw.length < 2) return { results: [], by: null };
  const notMe = `id != @me AND banned = 0 AND COALESCE(is_bot, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM blocks WHERE (blocker_id = users.id AND blocked_id = @me) OR (blocker_id = @me AND blocked_id = users.id))`;
  // Email / số điện thoại: chỉ khớp chính xác, chỉ người cho phép.
  const em = normEmail(raw), ph = !/[a-z]/i.test(raw) ? normPhone(raw) : null;
  if (em || ph) {
    const rows = db.prepare(`SELECT * FROM users WHERE ${notMe} AND find_by_contact = 1 AND ${em ? 'email = @v AND email_ok IS NOT NULL' : 'phone = @v AND phone_ok IS NOT NULL'} LIMIT 1`)
      .all({ me: me.id, v: em || ph });
    return { results: rows, by: em ? 'email' : 'phone' };
  }
  const f = fold(raw);
  const uname = raw.toLowerCase();
  // Username đầy đủ luôn tìm được (như kết bạn bằng username); còn lại cần find_by_name = 1.
  const rows = db.prepare(`SELECT * FROM users WHERE ${notMe} AND (username = @u OR (find_by_name = 1 AND (
      username LIKE @pre ESCAPE '\\' OR search_name LIKE @pre ESCAPE '\\' OR search_name LIKE @word ESCAPE '\\' OR search_name LIKE @any ESCAPE '\\')))
    ORDER BY (username = @u) DESC, (username LIKE @pre ESCAPE '\\') DESC, (search_name LIKE @pre ESCAPE '\\' OR search_name LIKE @word ESCAPE '\\') DESC, length(search_name)
    LIMIT 20`).all({ me: me.id, u: uname, pre: escLike(f) + '%', word: '% ' + escLike(f) + '%', any: '%' + escLike(f) + '%' });
  return { results: rows, by: 'name' };
}
export const getPrivacy = (u) => ({ findByName: u.find_by_name !== 0, findByContact: u.find_by_contact !== 0,
  hidePresence: u.hide_presence === 1, readReceipts: u.read_receipts !== 0 });
export function setPrivacy(userId, { findByName, findByContact }) {
  if (findByName != null) db.prepare('UPDATE users SET find_by_name = ? WHERE id = ?').run(findByName ? 1 : 0, userId);
  if (findByContact != null) db.prepare('UPDATE users SET find_by_contact = ? WHERE id = ?').run(findByContact ? 1 : 0, userId);
}
export function setPrivacy2(userId, { hidePresence, readReceipts }) {
  if (hidePresence != null) db.prepare('UPDATE users SET hide_presence = ? WHERE id = ?').run(hidePresence ? 1 : 0, userId);
  if (readReceipts != null) db.prepare('UPDATE users SET read_receipts = ? WHERE id = ?').run(readReceipts ? 1 : 0, userId);
}

// Phiên đăng nhập (quản lý thiết bị) + xóa tài khoản.
// - Mỗi lần đăng nhập tạo 1 phiên; token mang mã phiên (sid). Thu hồi phiên -> token đó hết hiệu lực ngay.
// - Phiên không hoạt động quá SESSION_IDLE_DAYS (mặc định 30) tự hết hạn.
// - Xóa tài khoản: thu hồi mọi tin đã gửi, xóa tệp / story / danh bạ / phiên / khóa; giữ một bản ghi ẩn danh
//   "Tài khoản đã xóa" để lịch sử hội thoại của người khác không vỡ.
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import db, { bumpMod } from './db.js';

const ensureColumn = (t, name, ddl) => {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
};
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device TEXT, ip TEXT,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
ensureColumn('users', 'terms_at', 'terms_at INTEGER');     // thời điểm đồng ý Điều khoản & Chính sách
ensureColumn('users', 'deleted_at', 'deleted_at INTEGER');

const IDLE_MS = (Number(process.env.SESSION_IDLE_DAYS) || 30) * 86400_000;

// Nhãn thiết bị: app gửi kèm (vd. "ReaChat Desktop · Windows"), không có thì đoán từ User-Agent.
export function deviceLabel(given, ua = '') {
  if (given) return String(given).slice(0, 80);
  const u = String(ua);
  const os = /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android' : /iPhone|iPad/.test(u) ? 'iOS' : /Mac OS/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : '';
  const br = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : u ? 'Trình duyệt' : 'Không rõ';
  return [br, os].filter(Boolean).join(' · ');
}
export function createSession(userId, { device, ip } = {}) {
  const id = nanoid(16), now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, device, ip, created_at, last_seen) VALUES (?,?,?,?,?,?)').run(id, userId, device || null, ip || null, now, now);
  return id;
}
// Phiên mới đăng nhập (đã chứng minh mật khẩu/OTP gần đây) — dùng cho thao tác nhạy cảm không hỏi lại mật khẩu.
export function sessionAge(sid) {
  const s = sid && db.prepare('SELECT created_at FROM sessions WHERE id = ?').get(sid);
  return s ? Date.now() - s.created_at : Infinity;
}
const touched = new Map();   // sid -> lần ghi last_seen gần nhất (ghi tối đa 5 phút/lần)
export function sessionValid(sid, userId) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!s || s.revoked || s.user_id !== userId || Date.now() - s.last_seen > IDLE_MS) return false;
  const now = Date.now();
  if (now - (touched.get(sid) || 0) > 300_000) { touched.set(sid, now); db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, sid); }
  return true;
}
export const listSessions = (userId) => db.prepare('SELECT id, device, ip, created_at, last_seen FROM sessions WHERE user_id = ? AND revoked = 0 AND last_seen > ? ORDER BY last_seen DESC')
  .all(userId, Date.now() - IDLE_MS);
export const revokeSession = (userId, sid) => db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?').run(sid, userId).changes;
export const revokeOthers = (userId, keepSid) => db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id != ? AND revoked = 0').run(userId, keepSid || '').changes;
export const revokeAll = (userId) => db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(userId);
export const markTerms = (userId) => db.prepare('UPDATE users SET terms_at = ? WHERE id = ?').run(Date.now(), userId);

// ---- Xóa tài khoản ----
const tableExists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
export function deleteAccount(userId, uploadDir) {
  const files = db.prepare('SELECT id FROM files WHERE owner_id = ?').all(userId).map((r) => r.id);
  db.transaction(() => {
    // Tin đã gửi: thu hồi (xóa nội dung), báo thay đổi cho mọi thiết bị qua mod_seq.
    for (const { id } of db.prepare('SELECT id FROM messages WHERE sender_id = ? AND recalled = 0').all(userId)) {
      db.prepare("UPDATE messages SET body = '', recalled = 1 WHERE id = ?").run(id);
      bumpMod(id);
    }
    const run = (sql, ...a) => db.prepare(sql).run(...a);
    for (const [t, sql] of [
      ['self_copies', 'DELETE FROM self_copies WHERE user_id = ?'], ['push_subs', 'DELETE FROM push_subs WHERE user_id = ?'],
      ['sessions', 'DELETE FROM sessions WHERE user_id = ?'], ['story_hidden', 'DELETE FROM story_hidden WHERE owner_id = ? OR user_id = ?'],
      ['story_views', 'DELETE FROM story_views WHERE viewer_id = ?'], ['scheduled_messages', 'DELETE FROM scheduled_messages WHERE sender_id = ?'],
      ['reactions', 'DELETE FROM reactions WHERE user_id = ?'], ['verify_codes', 'DELETE FROM verify_codes WHERE user_id = ?'], ['poll_votes', 'DELETE FROM poll_votes WHERE voter_id = ?'], ['user_sync', 'DELETE FROM user_sync WHERE user_id = ?'],
    ]) if (tableExists(t)) run(sql, ...(sql.split('?').length - 1 === 2 ? [userId, userId] : [userId]));
    if (tableExists('stories')) { run('DELETE FROM story_views WHERE story_id IN (SELECT id FROM stories WHERE user_id = ?)', userId); run('DELETE FROM stories WHERE user_id = ?', userId); }
    if (tableExists('contacts')) run('DELETE FROM contacts WHERE owner_id = ? OR contact_id = ?', userId, userId);
    if (tableExists('blocks')) run('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?', userId, userId);
    if (tableExists('friend_requests')) run('DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?', userId, userId);
    run('DELETE FROM files WHERE owner_id = ?', userId);
    // Nhóm / kênh: rời; nếu là trưởng nhóm -> chuyển cho thành viên còn lại lâu nhất.
    for (const { conversation_id: cid } of db.prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ?').all(userId)) {
      run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', cid, userId);
      const c = db.prepare('SELECT owner_id FROM conversations WHERE id = ?').get(cid);
      if (c?.owner_id === userId) {
        const next = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? LIMIT 1').get(cid);
        run('UPDATE conversations SET owner_id = ? WHERE id = ?', next?.user_id || null, cid);
      }
    }
    // Bot do người này tạo: vô hiệu hóa.
    run("UPDATE users SET banned = 1, ban_reason = 'chủ bot đã xóa tài khoản', bot_token_hash = NULL, bot_webhook = NULL WHERE bot_owner = ?", userId);
    // Bản ghi người dùng: ẩn danh hóa (giữ id để lịch sử hội thoại không vỡ).
    run(`UPDATE users SET username = ?, display_name = 'Tài khoản đã xóa', password_hash = '!deleted', public_key = NULL, avatar = NULL,
         key_backup = NULL, rc_hash = NULL, rc_backup = NULL, totp_secret = NULL, totp_on = 0, role = NULL,
         email = NULL, email_ok = NULL, phone = NULL, phone_ok = NULL, google_sub = NULL, google_email = NULL,
         banned = 1, ban_reason = 'deleted', deleted_at = ?, token_ver = token_ver + 1 WHERE id = ?`, 'deleted_' + userId.slice(0, 12).toLowerCase().replace(/[^a-z0-9_]/g, '_'), Date.now(), userId);
  })();
  for (const id of files) { try { fs.unlinkSync(path.join(uploadDir, id)); } catch {} }
  return { files: files.length };
}

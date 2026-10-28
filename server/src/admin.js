// Quản trị: báo cáo vi phạm (người dùng gửi) + API cho trang /admin (chỉ tài khoản role = 'admin').
// Tin nhắn mã hóa đầu-cuối: server KHÔNG đọc được -> báo cáo kèm nội dung do chính người báo cáo tự nguyện gửi.
import db, { getUserById, getUserByUsername, publicUser, getMessageById, destroyMessage, serializeMessage } from './db.js';
import { httpError } from './auth.js';

const ensureColumn = (t, name, ddl) => {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
};
ensureColumn('users', 'role', 'role TEXT');
ensureColumn('users', 'banned', 'banned INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'ban_reason', 'ban_reason TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL, target_id TEXT, conversation_id TEXT, message_id TEXT,
  reason TEXT NOT NULL, note TEXT, content TEXT,
  status TEXT NOT NULL DEFAULT 'open', handled_by TEXT, handled_note TEXT, handled_at INTEGER,
  created_at INTEGER NOT NULL)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at)');

export const REASONS = { scam: 'Lừa đảo / chiếm đoạt', harass: 'Quấy rối / đe dọa', spam: 'Spam / quảng cáo', nsfw: 'Nội dung đồi trụy / bạo lực', other: 'Khác' };

// ---- Người dùng gửi báo cáo ----
export function createReport(reporter, { messageId, targetUsername, reason, note, content }) {
  if (!REASONS[reason]) throw httpError(400, 'Lý do không hợp lệ');
  let target = targetUsername ? getUserByUsername(String(targetUsername).toLowerCase()) : null;
  let conversationId = null;
  if (messageId) {
    const m = getMessageById(messageId);
    const member = m && db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(m.conversation_id, reporter.id);
    if (!member) throw httpError(404, 'Không tìm thấy tin');
    conversationId = m.conversation_id;
    target = getUserById(m.sender_id);
  }
  if (!target || target.id === reporter.id) throw httpError(400, 'Không báo cáo được chính mình');
  const recent = db.prepare('SELECT COUNT(*) n FROM reports WHERE reporter_id = ? AND created_at > ?').get(reporter.id, Date.now() - 3600_000).n;
  if (recent >= 20) throw httpError(429, 'Bạn đã gửi quá nhiều báo cáo, thử lại sau');
  const r = db.prepare(`INSERT INTO reports (reporter_id, target_id, conversation_id, message_id, reason, note, content, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(reporter.id, target.id, conversationId, messageId || null, reason,
    String(note || '').slice(0, 1000), content == null ? null : String(content).slice(0, 4000), Date.now());
  return { id: r.lastInsertRowid };
}

// ---- Quản trị ----
export const requireAdmin = (req) => { if (req.user?.role !== 'admin') throw httpError(403, 'Chỉ quản trị viên'); };

export function adminStats(onlineCount) {
  const day = Date.now() - 86400_000;
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    users: one('SELECT COUNT(*) n FROM users'),
    newUsers24h: one('SELECT COUNT(*) n FROM users WHERE created_at > ?', day),
    online: onlineCount,
    banned: one('SELECT COUNT(*) n FROM users WHERE banned = 1'),
    messages: one('SELECT COUNT(*) n FROM messages'),
    messages24h: one('SELECT COUNT(*) n FROM messages WHERE created_at > ?', day),
    groups: one("SELECT COUNT(*) n FROM conversations WHERE type = 'group'"),
    calls24h: one("SELECT COUNT(*) n FROM messages WHERE type = 'call' AND created_at > ?", day),
    files: one('SELECT COUNT(*) n FROM files'),
    fileBytes: db.prepare('SELECT COALESCE(SUM(size), 0) n FROM files').get().n,
    reportsOpen: one("SELECT COUNT(*) n FROM reports WHERE status = 'open'"),
    perDay: db.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') d, COUNT(*) n FROM messages
      WHERE created_at > ? GROUP BY d ORDER BY d`).all(Date.now() - 14 * 86400_000),
  };
}

const adminUser = (u, isOnline) => u && ({
  ...publicUser(u), role: u.role || null, banned: !!u.banned, banReason: u.ban_reason || null, createdAt: u.created_at,
  totp: !!u.totp_on, online: isOnline(u.id),
  reports: db.prepare('SELECT COUNT(*) n FROM reports WHERE target_id = ?').get(u.id).n,
});
export function adminUsers(q, isOnline) {
  const like = '%' + String(q || '').toLowerCase() + '%';
  return db.prepare(`SELECT * FROM users WHERE lower(username) LIKE ? OR lower(display_name) LIKE ? ORDER BY created_at DESC LIMIT 200`)
    .all(like, like).map((u) => adminUser(u, isOnline));
}
export function setBan(adminId, userId, banned, reason) {
  const u = getUserById(userId);
  if (!u) throw httpError(404, 'Không tìm thấy người dùng');
  if (u.id === adminId) throw httpError(400, 'Không tự khóa chính mình');
  db.prepare('UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?').run(banned ? 1 : 0, banned ? String(reason || '').slice(0, 200) : null, userId);
  return getUserById(userId);
}
export function setRole(userId, role) {
  if (role !== 'admin' && role !== null) throw httpError(400, 'Vai trò không hợp lệ');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}
export function adminReports(status) {
  const rows = db.prepare(`SELECT * FROM reports WHERE (? = 'all' OR status = ?) ORDER BY created_at DESC LIMIT 300`).all(status || 'open', status || 'open');
  return rows.map((r) => {
    const m = r.message_id ? getMessageById(r.message_id) : null;
    return {
      id: r.id, reason: r.reason, reasonLabel: REASONS[r.reason], note: r.note, content: r.content, status: r.status,
      createdAt: r.created_at, handledNote: r.handled_note, handledAt: r.handled_at,
      reporter: publicUser(getUserById(r.reporter_id))?.username, target: publicUser(getUserById(r.target_id)),
      targetBanned: !!getUserById(r.target_id)?.banned,
      message: m ? { id: m.id, type: m.type, enc: !!m.enc, recalled: !!m.recalled, createdAt: m.created_at, conversationId: m.conversation_id } : null,
      handledBy: r.handled_by ? getUserById(r.handled_by)?.username : null,
    };
  });
}
export function handleReport(adminId, id, { status, note }) {
  if (!['open', 'resolved', 'dismissed'].includes(status)) throw httpError(400, 'Trạng thái không hợp lệ');
  const r = db.prepare('UPDATE reports SET status = ?, handled_note = ?, handled_by = ?, handled_at = ? WHERE id = ?')
    .run(status, String(note || '').slice(0, 500), adminId, Date.now(), id);
  if (!r.changes) throw httpError(404, 'Không tìm thấy báo cáo');
}
// Gỡ tin bị báo cáo: xóa nội dung + tệp trên server, mọi thiết bị nhận cập nhật "đã bị gỡ".
export function removeMessage(messageId) {
  const r = destroyMessage(messageId);
  if (!r) throw httpError(404, 'Không tìm thấy tin');
  db.prepare("UPDATE messages SET body = ? WHERE id = ?").run(JSON.stringify({ removedByAdmin: true }), messageId);
  return { message: serializeMessage(getMessageById(messageId)), fileId: r.fileId };
}

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { DB_PATH } from './config.js';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

// ---- Migration nhẹ: thêm cột còn thiếu cho DB cũ ----------------------
const columns = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const ensureColumn = (t, name, ddl) => {
  if (!columns(t).includes(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`);
};
ensureColumn('users', 'last_seen', 'last_seen INTEGER');
ensureColumn('users', 'avatar', 'avatar TEXT');
ensureColumn('conversations', 'owner_id', 'owner_id TEXT');
ensureColumn('messages', 'type', "type TEXT NOT NULL DEFAULT 'text'");
ensureColumn('messages', 'reply_to', 'reply_to TEXT');
ensureColumn('messages', 'edited_at', 'edited_at INTEGER');
ensureColumn('messages', 'recalled', 'recalled INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'expire_at', 'expire_at INTEGER');
ensureColumn('users', 'key_backup', 'key_backup TEXT');   // khóa danh tính ĐÃ mã hóa phía client
// Bảo mật tài khoản: TOTP 2 bước, mã khôi phục (lưu bcrypt của "verifier" + bản sao lưu khóa bọc bằng mã),
// token_ver tăng khi đổi/đặt lại mật khẩu -> mọi phiên cũ hết hiệu lực.
// Kênh công khai = nhóm có cờ is_channel: chỉ chủ kênh đăng, người theo dõi chỉ đọc; tìm theo tên/@handle.
ensureColumn('conversations', 'is_channel', 'is_channel INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversations', 'handle', 'handle TEXT');
ensureColumn('conversations', 'description', 'description TEXT');
// Phòng họp = nhóm có cờ is_meeting: vào bằng link reachat://meet/<mã>, mở thẳng cuộc gọi nhóm (chat phòng vẫn mã hóa).
ensureColumn('conversations', 'is_meeting', 'is_meeting INTEGER NOT NULL DEFAULT 0');
// Nhóm: ảnh nhóm, duyệt thành viên mới, chỉ trưởng/phó nhóm được nhắn; vai trò thành viên ('deputy' = phó nhóm)
ensureColumn('conversations', 'avatar', 'avatar TEXT');
ensureColumn('conversations', 'approval', 'approval INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversations', 'admin_only', 'admin_only INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversation_members', 'role', 'role TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS group_join_requests (conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, by_id TEXT,
  created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, user_id))`);
// Quyền riêng tư + hồ sơ
ensureColumn('users', 'hide_presence', 'hide_presence INTEGER NOT NULL DEFAULT 0');   // ẩn trực tuyến / lần cuối truy cập
ensureColumn('users', 'read_receipts', 'read_receipts INTEGER NOT NULL DEFAULT 1');   // 0 = không gửi & không nhận "Đã xem"
ensureColumn('users', 'bio', 'bio TEXT');
ensureColumn('users', 'birthday', 'birthday TEXT');                                   // YYYY-MM-DD
ensureColumn('users', 'show_birthday', 'show_birthday INTEGER NOT NULL DEFAULT 1');   // 0 ẩn, 1 ngày/tháng, 2 đủ năm
ensureColumn('users', 'cover', 'cover TEXT');
// Trạng thái tự đặt + tự động trả lời
ensureColumn('users', 'status_text', 'status_text TEXT');
ensureColumn('users', 'status_until', 'status_until INTEGER');                      // null = không thời hạn
ensureColumn('users', 'auto_reply', 'auto_reply TEXT');                             // null = tắt
db.exec('CREATE TABLE IF NOT EXISTS auto_reply_log (user_id TEXT NOT NULL, peer_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, peer_id))');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_handle ON conversations(handle) WHERE handle IS NOT NULL');
// Tải lên theo khúc: tệp lớn không giới hạn kích thước (mỗi khúc mã hóa riêng ở client).
ensureColumn('files', 'status', "status TEXT NOT NULL DEFAULT 'ready'");
ensureColumn('files', 'chunk_size', 'chunk_size INTEGER');
ensureColumn('files', 'chunks', 'chunks INTEGER');
db.exec('CREATE TABLE IF NOT EXISTS file_parts (file_id TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (file_id, n))');
ensureColumn('users', 'totp_secret', 'totp_secret TEXT');
ensureColumn('users', 'totp_on', 'totp_on INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'rc_hash', 'rc_hash TEXT');
ensureColumn('users', 'rc_backup', 'rc_backup TEXT');
ensureColumn('users', 'token_ver', 'token_ver INTEGER NOT NULL DEFAULT 0');
// mod_seq: tăng toàn cục mỗi khi tin ĐÃ CÓ bị thay đổi (sửa/thu hồi/tự hủy/cảm xúc) -> thiết bị offline
// đồng bộ được thay đổi (trước đây chỉ đồng bộ theo seq nên bỏ lỡ thu hồi/sửa).
ensureColumn('messages', 'mod_seq', 'mod_seq INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mod ON messages(mod_seq)');
ensureColumn('scheduled_messages', 'cond', 'cond TEXT');   // gửi có điều kiện (JSON), null = hẹn giờ thường
db.exec(`CREATE TABLE IF NOT EXISTS destruct_acks (
  message_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, device_id))`);

// Ẩn story với người cụ thể: owner không cho user xem story của mình.
db.exec(`CREATE TABLE IF NOT EXISTS story_hidden (
  owner_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (owner_id, user_id))`);

// Link mời vào nhóm: mỗi nhóm một mã đang hiệu lực (tạo mới -> mã cũ bị thu hồi), hết hạn sau 7 ngày.
db.exec(`CREATE TABLE IF NOT EXISTS group_invites (
  code TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0)`);

export default db;

// ---- Users -------------------------------------------------------------
export const createUser = ({ username, displayName, passwordHash, publicKey }) => {
  const id = nanoid();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, public_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, username, displayName, passwordHash, publicKey ?? null, Date.now());
  return getUserById(id);
};

export const getUserByUsername = (username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(username);
export const getUserById = (id) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export const updatePublicKey = (id, publicKey) =>
  db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(publicKey, id);
// Bản sao lưu khóa danh tính: server chỉ giữ blob đã mã hóa (không có khóa mở).
export const setTotp = (id, secret, on) => db.prepare('UPDATE users SET totp_secret = ?, totp_on = ? WHERE id = ?').run(secret, on ? 1 : 0, id);
export const setRecovery = (id, hash, backup) => db.prepare('UPDATE users SET rc_hash = ?, rc_backup = ? WHERE id = ?').run(hash, backup, id);
export const setPasswordHash = (id, hash) => db.prepare('UPDATE users SET password_hash = ?, token_ver = token_ver + 1 WHERE id = ?').run(hash, id);
const INVITE_TTL = 7 * 24 * 3600_000;
const INVITE_ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
export const createInvite = (conversationId, userId) => {
  const code = Array.from({ length: 10 }, () => INVITE_ALPHA[crypto.randomInt(INVITE_ALPHA.length)]).join('');   // CSPRNG: mã mời không đoán trước được
  const now = Date.now();
  db.transaction(() => {
    db.prepare('UPDATE group_invites SET revoked = 1 WHERE conversation_id = ?').run(conversationId);
    db.prepare('INSERT INTO group_invites (code, conversation_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(code, conversationId, userId, now, now + INVITE_TTL);
  })();
  return { code, expiresAt: now + INVITE_TTL };
};
export const activeInvite = (conversationId) =>
  db.prepare('SELECT * FROM group_invites WHERE conversation_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(conversationId, Date.now()) || null;
export const getInvite = (code) =>
  db.prepare('SELECT * FROM group_invites WHERE code = ? AND revoked = 0 AND expires_at > ?').get(String(code || '').toLowerCase(), Date.now()) || null;
export const revokeInvites = (conversationId) => db.prepare('UPDATE group_invites SET revoked = 1 WHERE conversation_id = ?').run(conversationId);
export const useInvite = (code) => db.prepare('UPDATE group_invites SET uses = uses + 1 WHERE code = ?').run(code);
export const getKeyBackup = (id) => db.prepare('SELECT key_backup FROM users WHERE id = ?').get(id)?.key_backup || null;
export const setKeyBackup = (id, blob) => db.prepare('UPDATE users SET key_backup = ? WHERE id = ?').run(blob, id);
export const setLastSeen = (id, ts = Date.now()) =>
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(ts, id);
export const updateProfile = (id, { displayName, avatar }) => {
  if (displayName != null) db.prepare('UPDATE users SET display_name = ?, search_name = NULL WHERE id = ?').run(displayName, id);   // search_name tính lại khi tìm
  if (avatar !== undefined) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, id);
  return getUserById(id);
};

export const publicUser = (u) =>
  u && {
    id: u.id, username: u.username, displayName: u.display_name,
    publicKey: u.public_key, lastSeen: u.hide_presence ? null : u.last_seen, avatar: u.avatar,
    ...(u.status_text && (!u.status_until || u.status_until > Date.now()) ? { statusText: u.status_text, statusUntil: u.status_until || null } : {}), ...(u.is_bot ? { isBot: true } : {}),
  };

// ---- Conversations -----------------------------------------------------
export const directConversationId = (a, b) => 'dm_' + [a, b].sort().join('_');

export const ensureDirectConversation = (userA, userB) => {
  const id = directConversationId(userA, userB);
  if (!db.prepare('SELECT id FROM conversations WHERE id = ?').get(id)) {
    db.transaction(() => {
      db.prepare('INSERT INTO conversations (id, type, created_at) VALUES (?, ?, ?)')
        .run(id, 'direct', Date.now());
      const add = db.prepare(
        'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)'
      );
      add.run(id, userA); add.run(id, userB);
    })();
  }
  return id;
};

export const createGroup = (title, ownerId, memberIds) => {
  const id = 'grp_' + nanoid();
  db.transaction(() => {
    db.prepare('INSERT INTO conversations (id, type, title, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'group', title, ownerId, Date.now());
    const add = db.prepare(
      'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)'
    );
    for (const uid of new Set([ownerId, ...memberIds])) add.run(id, uid);
  })();
  return getConversation(id);
};

export const getConversation = (id) =>
  db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);

export const conversationMembers = (conversationId) =>
  db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
    .all(conversationId).map((r) => r.user_id);

export const isMember = (conversationId, userId) =>
  !!db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, userId);

export const listConversationsForUser = (userId) =>
  db.prepare(
    `SELECT c.id, c.type, c.title, c.owner_id, c.created_at
       FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id
      WHERE m.user_id = ?`
  ).all(userId);

// Danh sách user dùng chung ít nhất một hội thoại (để phát trạng thái online).
export const contactsOf = (userId) =>
  db.prepare(
    // Không tính kênh công khai: cùng theo dõi một kênh không phải là "liên hệ" (không lộ trạng thái trực tuyến).
    `SELECT DISTINCT m2.user_id FROM conversation_members m1
       JOIN conversation_members m2 ON m1.conversation_id = m2.conversation_id
       JOIN conversations c ON c.id = m1.conversation_id AND COALESCE(c.is_channel, 0) = 0
      WHERE m1.user_id = ? AND m2.user_id <> ?`
  ).all(userId, userId).map((r) => r.user_id);

// ---- Thay đổi tin đã có (mod_seq) ----
export const bumpMod = (id) =>
  db.prepare('UPDATE messages SET mod_seq = (SELECT COALESCE(MAX(mod_seq), 0) + 1 FROM messages) WHERE id = ?').run(id);
// Tin ĐÃ biết (seq <= sinceSeq) bị thay đổi sau mốc sinceMod.
export const messagesChangedSince = (userId, sinceSeq, sinceMod, limit = 500) =>
  db.prepare(
    `SELECT msg.* FROM messages msg
       JOIN conversation_members m ON m.conversation_id = msg.conversation_id
      WHERE m.user_id = ? AND msg.seq <= ? AND msg.mod_seq > ?
      ORDER BY msg.mod_seq ASC LIMIT ?`
  ).all(userId, sinceSeq, sinceMod, limit);

// Phân trang lịch sử: tin cũ hơn beforeSeq (mới nhất trước), trả về tăng dần.
export const messagesBefore = (conversationId, beforeSeq, limit = 50) =>
  db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
    .all(conversationId, beforeSeq || Number.MAX_SAFE_INTEGER, limit).reverse();

// ---- Tin tự hủy: hủy HẲN (nội dung, file đính kèm, bản sao đa thiết bị, cảm xúc) ----
export const destroyMessage = (id) => db.transaction(() => {
  const m = getMessageById(id);
  if (!m) return null;
  let fileId = null;
  if (!['text', 'sticker', 'contact', 'system'].includes(m.type)) {
    try { const meta = JSON.parse(m.body); if (meta.fileId && /^[\w-]+$/.test(meta.fileId)) fileId = meta.fileId; } catch {}
    // Chỉ xóa tệp do CHÍNH người gửi tin tải lên (không cho dẫn fileId của người khác vào tin tự hủy để xóa hộ).
    if (fileId && getFile(fileId)?.owner_id !== m.sender_id) fileId = null;
  }
  db.prepare("UPDATE messages SET recalled = 1, body = '', pinned = 0 WHERE id = ?").run(id);
  db.prepare('DELETE FROM self_copies WHERE message_id = ?').run(id);
  db.prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
  db.prepare('DELETE FROM poll_votes WHERE message_id = ?').run(id);
  if (fileId) db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  bumpMod(id);
  return { message: getMessageById(id), fileId };
})();
// Xác nhận "đã xóa trên thiết bị" cho tin tự hủy (mỗi thiết bị một lần).
export const addDestructAck = (messageId, userId, deviceId) =>
  // tối đa 10 thiết bị / người / tin (deviceId do client tự khai -> không cho làm phình CSDL)
  db.prepare('SELECT COUNT(*) n FROM destruct_acks WHERE message_id = ? AND user_id = ?').get(messageId, userId).n >= 10 ? 0
    : db.prepare('INSERT OR IGNORE INTO destruct_acks (message_id, user_id, device_id, created_at) VALUES (?,?,?,?)')
      .run(messageId, userId, String(deviceId).slice(0, 64), Date.now()).changes;
export const destructAcks = (messageId) =>
  db.prepare(`SELECT u.username, COUNT(*) devices, MAX(a.created_at) at FROM destruct_acks a JOIN users u ON u.id = a.user_id
               WHERE a.message_id = ? GROUP BY a.user_id`).all(messageId);

// ---- Đa thiết bị: bản sao cho chính mình ----
export const putSelfCopy = (messageId, userId, data) =>
  db.prepare('INSERT OR IGNORE INTO self_copies (message_id, user_id, data, created_at) VALUES (?,?,?,?)').run(messageId, userId, data, Date.now()).changes;
export const getSelfCopy = (messageId, userId) =>
  db.prepare('SELECT data FROM self_copies WHERE message_id = ? AND user_id = ?').get(messageId, userId)?.data || null;

// ---- Ghi chú soạn chung (nhật ký cập nhật đã mã hóa) ----
export const pushDocUpdate = (conversationId, data) =>
  db.prepare('INSERT INTO doc_updates (conversation_id, data, created_at) VALUES (?,?,?)').run(conversationId, data, Date.now()).lastInsertRowid;
export const docUpdates = (conversationId) =>
  db.prepare('SELECT id, data FROM doc_updates WHERE conversation_id = ? ORDER BY id').all(conversationId);
// Nén: thay mọi cập nhật <= upto bằng 1 bản trạng thái gộp (client tạo + mã hóa).
export const compactDoc = (conversationId, upto, data) => db.transaction(() => {
  db.prepare('DELETE FROM doc_updates WHERE conversation_id = ? AND id <= ?').run(conversationId, upto);
  return pushDocUpdate(conversationId, data);
})();

// ---- Giao việc ----
export const createTask = ({ conversationId, messageId, titleEnc, assignee, dueAt, createdBy }) => {
  const id = nanoid();
  db.prepare(`INSERT INTO tasks (id, conversation_id, message_id, title_enc, assignee, due_at, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(id, conversationId, messageId || null, titleEnc, assignee || null, dueAt || null, createdBy, Date.now());
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
};
export const getTask = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
export const toggleTask = (id, username) => {
  const t = getTask(id); if (!t) return null;
  db.prepare('UPDATE tasks SET done = ?, done_by = ? WHERE id = ?').run(t.done ? 0 : 1, t.done ? null : username, id);
  return getTask(id);
};
export const deleteTask = (id) => db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
export const listTasks = (conversationId) =>
  db.prepare('SELECT * FROM tasks WHERE conversation_id = ? ORDER BY done ASC, COALESCE(due_at, 9e15) ASC, created_at ASC').all(conversationId)
    .map((t) => ({ id: t.id, conversationId: t.conversation_id, messageId: t.message_id, titleEnc: t.title_enc, assignee: t.assignee,
      dueAt: t.due_at, done: !!t.done, doneBy: t.done_by, createdBy: t.created_by, createdAt: t.created_at }));

// ---- Quản lý nhóm ----
export const renameGroup = (id, title) => { db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id); return getConversation(id); };
export const addMembers = (id, userIds) => {
  const add = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)');
  let n = 0; for (const uid of userIds) n += add.run(id, uid).changes;
  return n;
};
export const removeMember = (id, userId) =>
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(id, userId);
export const setOwner = (id, userId) => db.prepare('UPDATE conversations SET owner_id = ? WHERE id = ?').run(userId, id);
// Tin của MỘT hội thoại (cho thành viên mới tải lịch sử nhóm).
// Phần MỚI NHẤT; phần cũ hơn tải dần bằng 'history' (messagesBefore).
export const conversationMessages = (conversationId, limit = 300) =>
  db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?').all(conversationId, limit).reverse();

const MEMBER_COLS = `u.id, u.username, u.display_name displayName, CASE WHEN u.hide_presence = 1 THEN NULL ELSE u.last_seen END lastSeen, u.avatar, u.public_key publicKey,
  CASE WHEN u.status_text IS NOT NULL AND (u.status_until IS NULL OR u.status_until > CAST(strftime('%s','now') AS INTEGER) * 1000) THEN u.status_text END statusText,
  CASE WHEN u.status_text IS NOT NULL AND (u.status_until IS NULL OR u.status_until > CAST(strftime('%s','now') AS INTEGER) * 1000) THEN u.status_until END statusUntil`;
export const serializeConversation = (c) => (c.is_channel ? {
  // Kênh: KHÔNG gửi danh sách người theo dõi (riêng tư + có thể rất đông) — chỉ chủ kênh + số lượng.
  id: c.id, type: c.type, title: c.title, ownerId: c.owner_id,
  channel: { handle: c.handle, description: c.description || '', subscribers: channelCount(c.id) },
  members: db.prepare(`SELECT ${MEMBER_COLS} FROM users u WHERE u.id = ?`).all(c.owner_id),
} : {
  id: c.id,
  type: c.type,
  title: c.title,
  ownerId: c.owner_id,
  ...(c.is_meeting ? { meeting: true } : {}),
  ...(c.type === 'group' ? {
    avatar: c.avatar || null, approval: !!c.approval, adminOnly: !!c.admin_only,
    deputies: db.prepare("SELECT u.username FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND m.role = 'deputy'").all(c.id).map((r) => r.username),
    pending: db.prepare(`SELECT u.username, u.display_name displayName, u.avatar, b.username byUsername, r.created_at createdAt
      FROM group_join_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users b ON b.id = r.by_id WHERE r.conversation_id = ? ORDER BY r.created_at`).all(c.id),
  } : {}),
  members: db.prepare(
    `SELECT ${MEMBER_COLS}
       FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ?`
  ).all(c.id),
});
// ---- Quyền trong nhóm ----
export const isGroupAdmin = (c, userId) => !!c && (c.owner_id === userId
  || db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND role = 'deputy'").get(c.id, userId) != null);
export const setMemberRole = (convId, userId, role) => db.prepare('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?').run(role, convId, userId);
export const setGroupAvatar = (id, avatar) => db.prepare('UPDATE conversations SET avatar = ? WHERE id = ?').run(avatar, id);
export const setGroupSettings = (id, { approval, adminOnly }) => {
  if (approval != null) db.prepare('UPDATE conversations SET approval = ? WHERE id = ?').run(approval ? 1 : 0, id);
  if (adminOnly != null) db.prepare('UPDATE conversations SET admin_only = ? WHERE id = ?').run(adminOnly ? 1 : 0, id);
};
export const addJoinRequest = (convId, userId, byId) => db.prepare('INSERT OR IGNORE INTO group_join_requests (conversation_id, user_id, by_id, created_at) VALUES (?,?,?,?)').run(convId, userId, byId, Date.now()).changes;
export const removeJoinRequest = (convId, userId) => db.prepare('DELETE FROM group_join_requests WHERE conversation_id = ? AND user_id = ?').run(convId, userId).changes;
export const readReceiptsOn = (userId) => db.prepare('SELECT read_receipts r FROM users WHERE id = ?').get(userId)?.r !== 0;
export const presenceHidden = (userId) => db.prepare('SELECT hide_presence h FROM users WHERE id = ?').get(userId)?.h === 1;
export const channelCount = (id) => db.prepare('SELECT COUNT(*) n FROM conversation_members WHERE conversation_id = ?').get(id).n;
export const makeMeeting = (id) => db.prepare('UPDATE conversations SET is_meeting = 1 WHERE id = ?').run(id);
export const makeChannel = (id, handle, description) =>
  db.prepare('UPDATE conversations SET is_channel = 1, handle = ?, description = ? WHERE id = ?').run(handle, description || '', id);
export const getChannelByHandle = (h) => db.prepare('SELECT * FROM conversations WHERE is_channel = 1 AND handle = ?').get(String(h || '').toLowerCase().replace(/^@/, ''));
export const searchChannels = (q, limit = 30) => {
  const like = '%' + String(q || '').toLowerCase().replace(/^@/, '') + '%';
  return db.prepare(`SELECT * FROM conversations WHERE is_channel = 1 AND (lower(title) LIKE ? OR handle LIKE ? OR lower(description) LIKE ?)
    ORDER BY (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = conversations.id) DESC LIMIT ?`).all(like, like, like, limit);
};

// ---- Reads (đã xem) ----------------------------------------------------
export const setRead = (conversationId, userId, seq) =>
  db.prepare(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET
       last_read_seq = MAX(last_read_seq, excluded.last_read_seq), updated_at = excluded.updated_at`
  ).run(conversationId, userId, seq, Date.now());

export const getReads = (conversationId) =>
  db.prepare('SELECT user_id userId, last_read_seq lastReadSeq FROM conversation_reads WHERE conversation_id = ?')
    .all(conversationId);

// ---- Sự kiện: trả lời tham gia ----------------------------------------
db.exec('CREATE TABLE IF NOT EXISTS event_rsvp (message_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (message_id, user_id))');
export const setRsvp = (messageId, userId, status) => (status
  ? db.prepare('INSERT OR REPLACE INTO event_rsvp (message_id, user_id, status, updated_at) VALUES (?,?,?,?)').run(messageId, userId, status, Date.now())
  : db.prepare('DELETE FROM event_rsvp WHERE message_id = ? AND user_id = ?').run(messageId, userId));
export const rsvpTally = (messageId) => {
  const t = { yes: [], maybe: [], no: [] };
  for (const r of db.prepare('SELECT u.username, r.status FROM event_rsvp r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? ORDER BY r.updated_at').all(messageId)) t[r.status]?.push(r.username);
  return t;
};

// ---- Messages ----------------------------------------------------------
export const insertMessage = ({ conversationId, senderId, body, enc, type, replyTo, ttlMs }) => {
  const id = nanoid();
  const now = Date.now();
  const expireAt = ttlMs && ttlMs > 0 ? now + ttlMs : null;   // tin tự hủy
  const info = db.prepare(
    `INSERT INTO messages (id, conversation_id, sender_id, body, enc, type, reply_to, expire_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, conversationId, senderId, body, enc ? 1 : 0, type || 'text', replyTo ?? null, expireAt, now);
  return db.prepare('SELECT * FROM messages WHERE rowid = ?').get(info.lastInsertRowid);
};

export const getMessageById = (id) =>
  db.prepare('SELECT * FROM messages WHERE id = ?').get(id);

export const recallMessage = (id) => {
  db.prepare("UPDATE messages SET recalled = 1, body = '' WHERE id = ?").run(id);
  db.prepare('DELETE FROM self_copies WHERE message_id = ?').run(id);   // thu hồi -> bỏ cả bản sao đa thiết bị
  bumpMod(id);
  return getMessageById(id);
};

// Ảnh xem một lần đã được xem: thu hồi, thay nội dung bằng dấu vết "ai đã xem".
export const markOnceViewed = (id, byUsername) => {
  db.prepare('UPDATE messages SET recalled = 1, body = ? WHERE id = ?').run(JSON.stringify({ onceViewed: true, by: byUsername }), id);
  bumpMod(id);
  return getMessageById(id);
};

// ---- Ghim tin ----
export const setPinned = (id, pinned) => {
  db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  return getMessageById(id);
};
export const pinnedIds = (conversationId) =>
  db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND pinned = 1 AND recalled = 0 ORDER BY created_at DESC")
    .all(conversationId).map((r) => r.id);

// ---- Tin tự hủy: lấy tin đã hết hạn (chưa thu hồi) để quét ----
export const expiredMessageIds = () =>
  db.prepare('SELECT id, conversation_id FROM messages WHERE expire_at IS NOT NULL AND expire_at <= ? AND recalled = 0')
    .all(Date.now());

// ---- Bình chọn (poll) ----
export const votePoll = (messageId, voterId, optionIdx) => {
  const cur = db.prepare('SELECT option_idx FROM poll_votes WHERE message_id = ? AND voter_id = ?').get(messageId, voterId);
  if (cur && cur.option_idx === optionIdx) {                 // bấm lại lựa chọn cũ -> bỏ phiếu
    db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND voter_id = ?').run(messageId, voterId);
  } else {
    db.prepare('INSERT OR REPLACE INTO poll_votes (message_id, voter_id, option_idx, updated_at) VALUES (?,?,?,?)')
      .run(messageId, voterId, optionIdx, Date.now());
  }
};
// Trả về mảng theo phương án: mỗi phần tử là danh sách username đã chọn.
export const pollTally = (messageId, nOptions) => {
  const rows = db.prepare(
    `SELECT pv.option_idx idx, u.username FROM poll_votes pv JOIN users u ON u.id = pv.voter_id
      WHERE pv.message_id = ?`
  ).all(messageId);
  const out = Array.from({ length: nOptions }, () => []);
  for (const r of rows) if (r.idx >= 0 && r.idx < nOptions) out[r.idx].push(r.username);
  return out;
};

// ---- Tin hẹn giờ gửi ----
export const createScheduled = ({ conversationId, senderId, body, enc, type, replyTo, sendAt, cond }) => {
  const id = nanoid();
  db.prepare(
    `INSERT INTO scheduled_messages (id, conversation_id, sender_id, body, enc, type, reply_to, send_at, created_at, cond)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, conversationId, senderId, body, enc ? 1 : 0, type || 'text', replyTo ?? null, sendAt, Date.now(), cond ? JSON.stringify(cond) : null);
  return db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
};
export const dueScheduled = () =>
  db.prepare('SELECT * FROM scheduled_messages WHERE send_at <= ?').all(Date.now());
export const deleteScheduled = (id, senderId) =>
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?' + (senderId ? ' AND sender_id = ?' : ''))
    .run(...(senderId ? [id, senderId] : [id]));
export const getScheduled = (id) => db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
// Tin chờ điều kiện theo người nhận (online / đã xem).
export const scheduledWaitingOn = (kind, userId) =>
  db.prepare("SELECT * FROM scheduled_messages WHERE json_extract(cond, '$.kind') = ? AND json_extract(cond, '$.userId') = ?").all(kind, userId);
// Có ai KHÁC người gửi nhắn trong hội thoại sau mốc seq không (điều kiện "nếu chưa trả lời").
export const repliedAfter = (conversationId, senderId, seq) =>
  !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND sender_id <> ? AND seq > ? AND type NOT IN ('system','keydist') LIMIT 1").get(conversationId, senderId, seq);
export const lastSeqOf = (conversationId, senderId = null) =>
  db.prepare('SELECT COALESCE(MAX(seq), 0) v FROM messages WHERE conversation_id = ?' + (senderId ? ' AND sender_id = ?' : ''))
    .get(...(senderId ? [conversationId, senderId] : [conversationId])).v;
export const readSeqOf = (conversationId, userId) =>
  db.prepare('SELECT last_read_seq v FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId)?.v || 0;
export const listScheduled = (senderId) =>
  db.prepare('SELECT * FROM scheduled_messages WHERE sender_id = ? ORDER BY send_at ASC').all(senderId);
export const editMessage = (id, body, enc) => {
  db.prepare('UPDATE messages SET body = ?, enc = ?, edited_at = ? WHERE id = ?')
    .run(body, enc ? 1 : 0, Date.now(), id);
  db.prepare('DELETE FROM self_copies WHERE message_id = ?').run(id);   // nội dung đổi -> bản sao cũ hết hiệu lực
  bumpMod(id);
  return getMessageById(id);
};

export const messagesSince = (userId, sinceSeq = 0, limit = 500) =>
  db.prepare(
    `SELECT msg.* FROM messages msg
       JOIN conversation_members m ON m.conversation_id = msg.conversation_id
      WHERE m.user_id = ? AND msg.seq > ?
      ORDER BY msg.seq ASC LIMIT ?`
  ).all(userId, sinceSeq, limit);

// ---- Reactions ---------------------------------------------------------
export const toggleReaction = (messageId, userId, emoji) => {
  bumpMod(messageId);
  const cur = db.prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?').get(messageId, userId);
  if (cur && cur.emoji === emoji) {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId);
  } else {
    db.prepare(
      `INSERT INTO reactions (message_id, user_id, emoji, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, updated_at = excluded.updated_at`
    ).run(messageId, userId, emoji, Date.now());
  }
};
export const getReactions = (messageId) =>
  db.prepare(
    `SELECT u.username, r.emoji FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id = ?`
  ).all(messageId);

// ---- Contacts & Blocks -------------------------------------------------
export const addContact = (ownerId, contactId) =>
  db.prepare('INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at) VALUES (?, ?, ?)')
    .run(ownerId, contactId, Date.now());
export const removeContact = (ownerId, contactId) =>
  db.prepare('DELETE FROM contacts WHERE owner_id = ? AND contact_id = ?').run(ownerId, contactId);
export const listContacts = (ownerId) =>
  db.prepare(
    `SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id
      WHERE c.owner_id = ? ORDER BY u.display_name`
  ).all(ownerId);

export const block = (blockerId, blockedId) =>
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(blockerId, blockedId, Date.now());
export const unblock = (blockerId, blockedId) =>
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
export const isBlocked = (blockerId, blockedId) =>
  !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId);
export const listBlocks = (blockerId) =>
  db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(blockerId).map((r) => r.blocked_id);

// ---- Lời mời kết bạn ---------------------------------------------------
export const getFriendRequest = (id) =>
  db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(id);
export const getRequestBetween = (fromId, toId) =>
  db.prepare('SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ?').get(fromId, toId);
export const createFriendRequest = (fromId, toId) => {
  const now = Date.now();
  // Nếu đã có lời mời cũ (declined) thì mở lại thành pending.
  const existing = getRequestBetween(fromId, toId);
  if (existing) {
    db.prepare("UPDATE friend_requests SET status='pending', updated_at=? WHERE id=?").run(now, existing.id);
    return getFriendRequest(existing.id);
  }
  const id = nanoid();
  db.prepare('INSERT INTO friend_requests (id, from_id, to_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, fromId, toId, 'pending', now, now);
  return getFriendRequest(id);
};
export const setRequestStatus = (id, status) => {
  db.prepare('UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  return getFriendRequest(id);
};
// Lưu ý: u.* có cột id (user id) sẽ đè fr.id, nên đặt bí danh req_id riêng.
export const listIncomingRequests = (userId) =>
  db.prepare(
    `SELECT fr.id req_id, fr.created_at createdAt, u.*
       FROM friend_requests fr JOIN users u ON u.id = fr.from_id
      WHERE fr.to_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`
  ).all(userId);
export const listOutgoingRequests = (userId) =>
  db.prepare(
    `SELECT fr.id req_id, fr.created_at createdAt, u.*
       FROM friend_requests fr JOIN users u ON u.id = fr.to_id
      WHERE fr.from_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`
  ).all(userId);
// Bạn bè = danh bạ HAI chiều (chỉ tạo khi chấp nhận lời mời). Tự thêm ai đó vào danh bạ (một chiều) không phải bạn bè.
export const areFriends = (a, b) =>
  db.prepare('SELECT COUNT(*) n FROM contacts WHERE (owner_id = ? AND contact_id = ?) OR (owner_id = ? AND contact_id = ?)').get(a, b, b, a).n === 2;
// Chấp nhận: tạo danh bạ 2 chiều (trở thành bạn bè).
export const makeFriends = (a, b) => { addContact(a, b); addContact(b, a); };

// ---- Khoảnh khắc (story) ----------------------------------------------
export const createStory = ({ userId, kind, body, fileId, bg, ttlMs = 24 * 3600 * 1000 }) => {
  const id = nanoid(); const now = Date.now();
  db.prepare('INSERT INTO stories (id, user_id, kind, body, file_id, bg, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, userId, kind || 'text', body || '', fileId || null, bg || null, now, now + ttlMs);
  return getStory(id);
};
export const getStory = (id) => db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
export const deleteStory = (id, userId) =>
  db.prepare('DELETE FROM stories WHERE id = ? AND user_id = ?').run(id, userId);
export const purgeExpiredStories = () =>
  db.prepare('DELETE FROM stories WHERE expires_at < ?').run(Date.now());
// Story còn hạn của một tập user (bản thân + bạn bè).
export const activeStoriesForUsers = (userIds) => {
  if (!userIds.length) return [];
  const ph = userIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM stories WHERE user_id IN (${ph}) AND expires_at > ? ORDER BY created_at ASC`
  ).all(...userIds, Date.now());
};
export const storyHiddenFrom = (ownerId) =>
  db.prepare('SELECT user_id FROM story_hidden WHERE owner_id = ?').all(ownerId).map((r) => r.user_id);
export const setStoryHidden = (ownerId, userIds) => db.transaction(() => {
  db.prepare('DELETE FROM story_hidden WHERE owner_id = ?').run(ownerId);
  const add = db.prepare('INSERT OR IGNORE INTO story_hidden (owner_id, user_id) VALUES (?, ?)');
  for (const u of userIds) if (u !== ownerId) add.run(ownerId, u);
})();
// viewer có được xem story của owner không (chính mình, hoặc bạn bè không bị ẩn).
// Xem story: chính mình, hoặc bạn bè 2 chiều, không chặn nhau, chủ story không ẩn với người xem.
export const canSeeStoriesOf = (viewerId, ownerId) => viewerId === ownerId || (areFriends(viewerId, ownerId)
  && !isBlocked(ownerId, viewerId) && !isBlocked(viewerId, ownerId)
  && !db.prepare('SELECT 1 FROM story_hidden WHERE owner_id = ? AND user_id = ?').get(ownerId, viewerId));
export const markStoryViewed = (storyId, viewerId) =>
  db.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer_id, created_at) VALUES (?,?,?)')
    .run(storyId, viewerId, Date.now());
export const storyViewers = (storyId) =>
  db.prepare(
    `SELECT u.*, sv.created_at viewedAt FROM story_views sv JOIN users u ON u.id = sv.viewer_id
      WHERE sv.story_id = ? ORDER BY sv.created_at DESC`
  ).all(storyId);
export const storyViewCount = (storyId) =>
  db.prepare('SELECT COUNT(*) n FROM story_views WHERE story_id = ?').get(storyId).n;
export const hasViewedStory = (storyId, viewerId) =>
  !!db.prepare('SELECT 1 FROM story_views WHERE story_id = ? AND viewer_id = ?').get(storyId, viewerId);

// ---- Files -------------------------------------------------------------
export const recordFile = ({ id, name, mime, size, ownerId }) =>
  db.prepare('INSERT INTO files (id, name, mime, size, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, mime, size, ownerId, Date.now());
export const getFile = (id) => db.prepare('SELECT * FROM files WHERE id = ?').get(id);
export const startChunked = ({ id, name, mime, size, ownerId, chunkSize, chunks }) =>
  db.prepare("INSERT INTO files (id, name, mime, size, owner_id, created_at, status, chunk_size, chunks) VALUES (?,?,?,?,?,?, 'uploading', ?, ?)")
    .run(id, name, mime, size, ownerId, Date.now(), chunkSize, chunks);
export const addPart = (id, n) => db.prepare('INSERT OR IGNORE INTO file_parts (file_id, n) VALUES (?, ?)').run(id, n);
export const listParts = (id) => db.prepare('SELECT n FROM file_parts WHERE file_id = ? ORDER BY n').all(id).map((r) => r.n);
export const finishChunked = (id) => db.transaction(() => {
  db.prepare("UPDATE files SET status = 'ready' WHERE id = ?").run(id);
  db.prepare('DELETE FROM file_parts WHERE file_id = ?').run(id);
})();

export const serializeMessage = (m) => ({
  seq: m.seq,
  id: m.id,
  conversationId: m.conversation_id,
  senderId: m.sender_id,
  body: m.body,
  enc: !!m.enc,
  type: m.type || 'text',
  replyTo: m.reply_to || null,
  editedAt: m.edited_at || null,
  recalled: !!m.recalled,
  pinned: !!m.pinned,
  expireAt: m.expire_at || null,
  modSeq: m.mod_seq || 0,
  createdAt: m.created_at,
});

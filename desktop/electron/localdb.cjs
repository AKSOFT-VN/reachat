// SQLite cache cục bộ chạy trong MAIN process (sql.js / WASM — không cần biên dịch native).
// Renderer không đụng trực tiếp vào đĩa; mọi truy cập đi qua IPC.
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

let db = null;
let dbFile = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    seq             INTEGER,
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id       TEXT NOT NULL,
    sender_username TEXT,
    body            TEXT NOT NULL,
    enc             INTEGER NOT NULL DEFAULT 0,
    type            TEXT NOT NULL DEFAULT 'text',
    recalled        INTEGER NOT NULL DEFAULT 0,
    edited_at       INTEGER,
    reply_to        TEXT,
    expire_at       INTEGER,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cache_conv ON messages(conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

async function initLocalDb(userDataDir, scopeKey) {
  // scopeKey thành tên tệp -> chỉ chữ/số/_/- (không cho "../" ghi ra ngoài thư mục dữ liệu).
  if (!/^[\w-]{1,80}$/.test(String(scopeKey))) throw new Error('scopeKey không hợp lệ');
  dbFile = path.join(userDataDir, `cache-${scopeKey}.db`);
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f),
  });
  db = fs.existsSync(dbFile) ? new SQL.Database(fs.readFileSync(dbFile)) : new SQL.Database();
  db.run(SCHEMA);
  // Migration cho cache cũ.
  const cols = new Set();
  const r = db.exec('PRAGMA table_info(messages)');
  if (r.length) for (const row of r[0].values) cols.add(row[1]);
  const add = (name, ddl) => { if (!cols.has(name)) db.run(`ALTER TABLE messages ADD COLUMN ${ddl}`); };
  add('sender_username', 'sender_username TEXT');
  add('type', "type TEXT NOT NULL DEFAULT 'text'");
  add('recalled', 'recalled INTEGER NOT NULL DEFAULT 0');
  add('edited_at', 'edited_at INTEGER');
  add('reply_to', 'reply_to TEXT');
  add('expire_at', 'expire_at INTEGER');
  if (!cols.has('reactions')) {                // JSON [{emoji, username}] — giữ cảm xúc qua lần mở app sau
    add('reactions', 'reactions TEXT');
    db.run("UPDATE meta SET value = '0' WHERE key = 'modSeq'");   // lần sync tới kéo lại mọi thay đổi -> điền cảm xúc tin cũ
  }
  persist();
}

function persist() {
  if (db && dbFile) fs.writeFileSync(dbFile, Buffer.from(db.export()));
}

function upsertMessage(m) {
  // Không có trường reactions (vd. cập nhật bản giải mã) -> giữ giá trị đang lưu.
  let rx = m.reactions;
  if (rx === undefined) { const r = db.exec('SELECT reactions FROM messages WHERE id = ?', [m.id]); rx = r.length ? r[0].values[0][0] : null; }
  else if (rx !== null && typeof rx !== 'string') rx = JSON.stringify(rx);
  db.run(
    `INSERT OR REPLACE INTO messages
       (seq, id, conversation_id, sender_id, sender_username, body, enc, type, recalled, edited_at, reply_to, expire_at, created_at, reactions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.seq ?? null, m.id, m.conversationId, m.senderId, m.senderUsername ?? null, m.body, m.enc ? 1 : 0,
     m.type || 'text', m.recalled ? 1 : 0, m.editedAt ?? null, m.replyTo ?? null, m.expireAt ?? null, m.createdAt, rx]
  );
  persist();
}

function rowsToObjects(res) {
  if (!res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

const MSG_COLS = `seq, id, conversation_id AS conversationId, sender_id AS senderId,
            sender_username AS senderUsername, body, enc,
            type, recalled, edited_at AS editedAt, reply_to AS replyTo,
            expire_at AS expireAt, created_at AS createdAt, reactions`;

// Nạp `limit` tin MỚI NHẤT (tùy chọn cũ hơn mốc `before` để phân trang), trả về thứ tự tăng dần.
function getMessages(conversationId, limit = 40, before = null) {
  const where = before ? 'conversation_id = ? AND created_at < ?' : 'conversation_id = ?';
  const params = before ? [conversationId, before, limit] : [conversationId, limit];
  const res = db.exec(
    `SELECT ${MSG_COLS} FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
    params
  );
  return rowsToObjects(res).map((m) => ({ ...m, enc: !!m.enc, recalled: !!m.recalled })).reverse();
}

// Kho media: ảnh (image) | tệp (file, voice, p2pfile) | link (tin chữ có http/https). Mới nhất trước.
function mediaOf(conversationId, kind, limit = 300) {
  const where = kind === 'image' ? "type = 'image'" : kind === 'file' ? "type IN ('file','voice','p2pfile')" : "type = 'text' AND (body LIKE '%http://%' OR body LIKE '%https://%')";
  return rowsToObjects(db.exec(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? AND recalled = 0 AND ${where} ORDER BY created_at DESC LIMIT ?`, [conversationId, limit]))
    .map((m) => ({ ...m, enc: !!m.enc, recalled: !!m.recalled }));
}

function getMessageById(id) {
  const res = db.exec(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`, [id]);
  const r = rowsToObjects(res).map((m) => ({ ...m, enc: !!m.enc, recalled: !!m.recalled }));
  return r[0] || null;
}

// Tìm trong cache ĐÃ giải mã trên máy -> tìm được cả tin E2E (server không tham gia).
// f: { kind: text|link|image|file, convId, sender (username), from, to (ms) }
function searchMessages(query, limit = 50, f = {}) {
  const where = ['recalled = 0', "body NOT IN ('[không giải mã được]', '[chưa có khóa nhóm]')"], args = [];
  const kind = f.kind || 'text';
  if (kind === 'image') where.push("type = 'image'");
  else if (kind === 'file') where.push("type IN ('file', 'voice', 'video', 'p2pfile')");
  else {
    where.push("type = 'text'");
    if (query) { where.push('body LIKE ?'); args.push(`%${query}%`); }
    if (kind === 'link') where.push("(body LIKE '%http://%' OR body LIKE '%https://%')");
  }
  if (f.convId) { where.push('conversation_id = ?'); args.push(f.convId); }
  if (f.sender) { where.push('sender_username = ?'); args.push(String(f.sender).replace(/^@/, '').toLowerCase()); }
  if (f.from) { where.push('created_at >= ?'); args.push(Number(f.from)); }
  if (f.to) { where.push('created_at <= ?'); args.push(Number(f.to)); }
  const res = db.exec(`SELECT id, conversation_id AS conversationId, sender_id AS senderId, sender_username AS senderUsername, body, type, recalled, created_at AS createdAt
     FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, [...args, limit]);
  return rowsToObjects(res);
}

// Xóa cả cuộc trò chuyện (phía tôi): bỏ mọi tin của hội thoại khỏi bộ nhớ đệm trên máy.
function clearConversation(convId) {
  db.run('DELETE FROM messages WHERE conversation_id = ?', [convId]);
  persist();
  return true;
}

function listConversations(myId = '') {
  const res = db.exec(
    `SELECT conversation_id AS conversationId, MAX(created_at) AS lastAt,
            MAX(CASE WHEN sender_id = ? THEN 1 ELSE 0 END) AS mine,
            (SELECT CASE WHEN recalled=1 THEN '(đã thu hồi)' WHEN type IN ('system','sticker') THEN body WHEN type='contact' THEN '👤 Danh thiếp'
                    WHEN type='poll' THEN '📊 Bình chọn' WHEN type='call' THEN '📞 Cuộc gọi' WHEN type='location' THEN '📍 Vị trí' WHEN type='p2pfile' THEN '📦 Tệp gửi trực tiếp' WHEN type='voice' THEN '🎤 Tin thoại' WHEN type='video' THEN '🎬 Video' WHEN type='autoreply' THEN '🤖 Tự động trả lời' WHEN type='event' THEN '📅 Sự kiện' WHEN type!='text' THEN '['||type||']' ELSE body END
               FROM messages m2 WHERE m2.conversation_id = m1.conversation_id
              ORDER BY created_at DESC LIMIT 1) AS preview
       FROM messages m1 GROUP BY conversation_id ORDER BY lastAt DESC`, [myId]
  );
  return rowsToObjects(res);
}

// Số tin chưa đọc mỗi hội thoại: tin của người khác có seq > con trỏ đã đọc (lưu ở meta 'read.<conv>').
function unreadCounts(myUserId) {
  const res = db.exec(
    `SELECT m.conversation_id AS conversationId, COUNT(*) AS unread
       FROM messages m
       LEFT JOIN meta r ON r.key = 'read.' || m.conversation_id
      WHERE m.sender_id <> ? AND m.recalled = 0
        AND m.seq > COALESCE(CAST(r.value AS INTEGER), 0)
      GROUP BY m.conversation_id`,
    [myUserId]
  );
  return Object.fromEntries(rowsToObjects(res).map((r) => [r.conversationId, r.unread]));
}

const FAIL_BODIES = ['[không giải mã được]', '[chưa có khóa nhóm]', '[tin của bạn]'];

// Tin tự hủy đã hết hạn: xóa nội dung NGAY trong cache (giữ dấu vết "đã biến mất"), trả về bản trước khi xóa
// để renderer dọn khóa media / ảnh đã giải mã và gửi xác nhận.
function purgeExpired(now) {
  const rows = rowsToObjects(db.exec(
    `SELECT id, conversation_id AS conversationId, body, type, expire_at AS expireAt FROM messages
      WHERE expire_at IS NOT NULL AND expire_at <= ? AND recalled = 0`, [now]));
  if (!rows.length) return [];
  db.run("UPDATE messages SET body = '', recalled = 1 WHERE expire_at IS NOT NULL AND expire_at <= ? AND recalled = 0", [now]);
  persist();
  return rows;
}

// Tin 1-1 mã hóa còn đọc được trên máy này (để sao lưu bản sao cho thiết bị khác).
function listDmForBackfill() {
  return rowsToObjects(db.exec(
    `SELECT id, type, body FROM messages WHERE substr(conversation_id, 1, 3) = 'dm_' AND recalled = 0
        AND ((enc = 1 AND type IN ('text','sticker','contact')) OR type IN ('image','file','voice'))`));
}
// Tin 1-1 đang lỗi giải mã (xin bản sao từ thiết bị khác).
function failedDmIds() {
  return rowsToObjects(db.exec(
    `SELECT id FROM messages WHERE substr(conversation_id, 1, 3) = 'dm_' AND recalled = 0 AND body IN (?, ?, ?)`, FAIL_BODIES)).map((r) => r.id);
}

// fileId của mọi ảnh/tệp/tin thoại CÒN hiệu lực trong cache (để dọn khóa media không còn dùng).
function liveFileIds() {
  const ids = [];
  for (const r of rowsToObjects(db.exec(`SELECT body FROM messages WHERE type IN ('image','file','voice') AND recalled = 0`))) {
    try { const id = JSON.parse(r.body).fileId; if (id) ids.push(id); } catch {}
  }
  return ids;
}

// Sao lưu: mọi tin trong cache (đã giải mã).
function exportMessages() {
  return rowsToObjects(db.exec(`SELECT ${MSG_COLS} FROM messages ORDER BY created_at`)).map((m) => ({ ...m, enc: !!m.enc, recalled: !!m.recalled }));
}
// Khôi phục: chỉ ghi tin CHƯA có hoặc đang lỗi giải mã (không đè bản đọc được); ghi đĩa một lần.
function importMessages(list) {
  let added = 0, fixed = 0;
  db.run('BEGIN');
  try {
    for (const m of list || []) {
      const r = db.exec('SELECT body FROM messages WHERE id = ?', [m.id]);
      const cur = r.length ? r[0].values[0][0] : null;
      if (cur != null && !FAIL_BODIES.includes(cur)) continue;
      if (FAIL_BODIES.includes(m.body)) continue;
      db.run(`INSERT OR REPLACE INTO messages
        (seq, id, conversation_id, sender_id, sender_username, body, enc, type, recalled, edited_at, reply_to, expire_at, created_at, reactions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.seq ?? null, m.id, m.conversationId, m.senderId, m.senderUsername ?? null, m.body, m.enc ? 1 : 0, m.type || 'text',
         m.recalled ? 1 : 0, m.editedAt ?? null, m.replyTo ?? null, m.expireAt ?? null, m.createdAt,
         m.reactions == null ? null : typeof m.reactions === 'string' ? m.reactions : JSON.stringify(m.reactions)]);
      cur == null ? added++ : fixed++;
    }
    db.run('COMMIT');
  } catch (e) { db.run('ROLLBACK'); throw e; }
  persist();
  return { added, fixed };
}

function getMeta(key) {
  const res = db.exec('SELECT value FROM meta WHERE key = ?', [key]);
  return res.length ? res[0].values[0][0] : null;
}
function setMeta(key, value) {
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)]);
  persist();
}
function maxSeq() {
  const res = db.exec('SELECT MAX(seq) FROM messages');
  return (res.length && res[0].values[0][0]) || 0;
}

module.exports = {
  initLocalDb, upsertMessage, getMessages, getMessageById, searchMessages, listConversations, clearConversation,
  unreadCounts, getMeta, setMeta, maxSeq, purgeExpired, listDmForBackfill, failedDmIds, liveFileIds, mediaOf, exportMessages, importMessages,
};

-- Lược đồ cơ sở dữ liệu server. Cột bổ sung được migrate bằng code (db.js).

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  public_key    TEXT,
  last_seen     INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'direct',  -- 'direct' | 'group'
  title      TEXT,
  owner_id   TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT UNIQUE NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  enc             INTEGER NOT NULL DEFAULT 0,
  type            TEXT NOT NULL DEFAULT 'text',  -- text | image | file | system
  reply_to        TEXT,
  edited_at       INTEGER,
  recalled        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

-- Con trỏ đã đọc của từng thành viên trong từng hội thoại.
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  last_read_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

-- Thả cảm xúc: mỗi người 1 emoji cho mỗi tin.
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

-- Metadata file đính kèm (bytes lưu ở thư mục uploads/<id>).
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Danh bạ (một chiều) và chặn.
CREATE TABLE IF NOT EXISTS contacts (
  owner_id   TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, contact_id)
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Lời mời kết bạn (2 chiều). Chấp nhận -> tạo contact cả hai phía.
CREATE TABLE IF NOT EXISTS friend_requests (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | declined
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id)
);

-- Khoảnh khắc (story) sống 24h. KHÔNG mã hóa E2E (phát cho nhiều bạn bè).
CREATE TABLE IF NOT EXISTS stories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'text',       -- text | image
  body       TEXT,                               -- chú thích / nội dung text
  file_id    TEXT,                               -- ảnh (nếu kind=image)
  bg         TEXT,                               -- màu nền cho story text
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_views (
  story_id   TEXT NOT NULL,
  viewer_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, viewer_id)
);

-- Bình chọn: mỗi người 1 lựa chọn cho mỗi tin poll (option = chỉ số phương án).
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL,
  voter_id   TEXT NOT NULL,
  option_idx INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, voter_id)
);

-- Tin hẹn giờ gửi: lưu tạm tới khi send_at thì server mới chèn vào messages.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  enc             INTEGER NOT NULL DEFAULT 0,
  type            TEXT NOT NULL DEFAULT 'text',
  reply_to        TEXT,
  send_at         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

-- Việc cần làm giao từ tin nhắn. title_enc do client mã hóa (server không đọc được).
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id      TEXT,
  title_enc       TEXT NOT NULL,
  assignee        TEXT,
  due_at          INTEGER,
  done            INTEGER NOT NULL DEFAULT 0,
  done_by         TEXT,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_conv ON tasks(conversation_id);

-- Ghi chú soạn chung (CRDT Yjs): nhật ký cập nhật ĐÃ mã hóa phía client; server không đọc được.
CREATE TABLE IF NOT EXISTS doc_updates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  data            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_conv ON doc_updates(conversation_id, id);

-- Đa thiết bị 1-1: bản sao nội dung/khóa media mã hóa bằng khóa CÁ NHÂN của người nhận
-- (thiết bị nào giải được thì tải lên, thiết bị khác của cùng người dùng đọc lại). Server không mở được.
CREATE TABLE IF NOT EXISTS self_copies (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_friendreq_to ON friend_requests(to_id, status);
CREATE INDEX IF NOT EXISTS idx_pollvotes_msg ON poll_votes(message_id);
CREATE INDEX IF NOT EXISTS idx_sched_time ON scheduled_messages(send_at);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);

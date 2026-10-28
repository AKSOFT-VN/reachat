// Kho GIF tự quản: quản trị viên tải GIF lên + gắn từ khóa; người dùng tìm và gửi trong app.
// Miễn phí, không phụ thuộc dịch vụ ngoài, không giới hạn lượt dùng. GIF gửi đi như ảnh thường (mã hóa đầu-cuối).
// Tệp lưu ở GIF_DIR (mặc định: thư mục "gifs" cạnh tệp CSDL — trên Docker là /data/gifs, nằm trong volume).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from './db.js';
import { DB_PATH } from './config.js';
import { fold } from './search.js';

export const GIF_DIR = process.env.GIF_DIR || path.join(path.dirname(DB_PATH), 'gifs');
fs.mkdirSync(GIF_DIR, { recursive: true });
db.exec(`CREATE TABLE IF NOT EXISTS gif_library (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL,
  title TEXT, tags TEXT, search TEXT, uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, created_by TEXT)`);
// Sticker dùng chung kho: kind = 'gif' | 'sticker'; sticker gom theo gói (pack).
for (const [c, ddl] of [['kind', "kind TEXT NOT NULL DEFAULT 'gif'"], ['pack', 'pack TEXT']])
  if (!db.prepare('PRAGMA table_info(gif_library)').all().some((x) => x.name === c)) db.exec('ALTER TABLE gif_library ADD COLUMN ' + ddl);

const MAX_BYTES = (Number(process.env.GIF_MAX_MB) || 10) * 1024 * 1024;
const err = (status, message) => Object.assign(new Error(message), { status });
// Nhận dạng theo nội dung tệp (không tin đuôi tệp): GIF, WebP, PNG (APNG).
const sniff = (b) => (b.slice(0, 6).toString('latin1').match(/^GIF8[79]a$/) ? 'image/gif'
  : b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' ? 'image/webp'
  : b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : null);
const normTags = (t) => [...new Set(String(t || '').split(/[,;#\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 20).join(', ');
const searchText = (title, tags) => fold(`${title || ''} ${tags || ''}`);
const row = (r) => r && { id: r.id, title: r.title || '', tags: r.tags || '', size: r.size, mime: r.mime, uses: r.uses, createdAt: r.created_at, kind: r.kind || 'gif', pack: r.pack || '' };

export const libraryCount = () => db.prepare("SELECT COUNT(*) n FROM gif_library WHERE kind = 'gif'").get().n;

export function addGif({ dataB64, title, tags, kind, pack }, userId) {
  const buf = Buffer.from(String(dataB64 || ''), 'base64');
  if (!buf.length) throw err(400, 'Thiếu dữ liệu tệp');
  if (buf.length > MAX_BYTES) throw err(413, `GIF vượt ${MAX_BYTES / 1024 / 1024} MB`);
  const mime = sniff(buf);
  if (!mime) throw err(400, 'Chỉ nhận ảnh GIF / WebP / PNG (động hoặc tĩnh)');
  const k = kind === 'sticker' ? 'sticker' : 'gif', pk = k === 'sticker' ? (String(pack || '').trim().slice(0, 40) || 'Sticker') : null;
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);   // trùng nội dung -> không lưu 2 lần
  const dup = db.prepare('SELECT * FROM gif_library WHERE id = ?').get(hash);
  if (dup) return { ...row(dup), duplicate: true };
  fs.writeFileSync(path.join(GIF_DIR, hash), buf);
  const t = String(title || '').trim().slice(0, 80), tg = normTags(tags);
  db.prepare('INSERT INTO gif_library (id, mime, size, title, tags, search, created_at, created_by, kind, pack) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(hash, mime, buf.length, t, tg, searchText(t, tg), Date.now(), userId || null, k, pk);
  return row(db.prepare('SELECT * FROM gif_library WHERE id = ?').get(hash));
}
export function updateGif(id, { title, tags, pack }) {
  const r = db.prepare('SELECT * FROM gif_library WHERE id = ?').get(id);
  if (!r) throw err(404, 'Không tìm thấy GIF');
  const t = title != null ? String(title).trim().slice(0, 80) : r.title, tg = tags != null ? normTags(tags) : r.tags;
  db.prepare('UPDATE gif_library SET title = ?, tags = ?, search = ? WHERE id = ?').run(t, tg, searchText(t, tg), id);
  if (pack != null && r.kind === 'sticker') db.prepare('UPDATE gif_library SET pack = ? WHERE id = ?').run(String(pack).trim().slice(0, 40) || 'Sticker', id);
  return row(db.prepare('SELECT * FROM gif_library WHERE id = ?').get(id));
}
export function deleteGif(id) {
  if (!db.prepare('DELETE FROM gif_library WHERE id = ?').run(id).changes) throw err(404, 'Không tìm thấy GIF');
  try { fs.unlinkSync(path.join(GIF_DIR, id)); } catch {}
  return { ok: true };
}
export function listGifs({ q = '', limit = 200, kind = 'gif' } = {}) {
  const f = fold(q), k = kind === 'sticker' ? 'sticker' : 'gif';
  const rows = f ? db.prepare("SELECT * FROM gif_library WHERE kind = ? AND search LIKE ? ESCAPE '\\' ORDER BY uses DESC, created_at DESC LIMIT ?").all(k, '%' + f.replace(/[\\%_]/g, '\\$&') + '%', limit)
    : db.prepare('SELECT * FROM gif_library WHERE kind = ? ORDER BY pack, created_at DESC LIMIT ?').all(k, limit);
  return { total: db.prepare('SELECT COUNT(*) n FROM gif_library WHERE kind = ?').get(k).n, items: rows.map(row) };
}
// Gói sticker cho app: [{ pack, items: [{ id, title }] }]
export function stickerPacks() {
  const by = new Map();
  for (const r of db.prepare("SELECT id, title, pack FROM gif_library WHERE kind = 'sticker' ORDER BY pack, created_at").all())
    (by.get(r.pack || 'Sticker') || by.set(r.pack || 'Sticker', []).get(r.pack || 'Sticker')).push({ id: r.id, title: r.title || '' });
  return [...by].map(([pack, items]) => ({ pack, items }));
}
// Tìm cho người dùng: khớp từng từ (không dấu) trong tiêu đề + từ khóa; không gõ gì -> GIF hay dùng nhất.
export function searchLibrary(q, limit = 60) {
  const words = fold(q).split(' ').filter(Boolean).slice(0, 5);
  const where = ["kind = 'gif'", ...words.map(() => "search LIKE ? ESCAPE '\\'")].join(' AND ');
  const rows = db.prepare(`SELECT * FROM gif_library WHERE ${where} ORDER BY uses DESC, created_at DESC LIMIT ?`).all(...words.map((w) => '%' + w.replace(/[\\%_]/g, '\\$&') + '%'), limit);
  return rows.map((r) => ({ id: 'lib:' + r.id, preview: 'lib:' + r.id, url: 'lib:' + r.id, title: r.title || r.tags || '', lib: true }));
}
export function readGif(id, countUse) {
  if (!/^[0-9a-f]{24}$/.test(String(id))) throw err(400, 'Mã GIF không hợp lệ');
  const r = db.prepare('SELECT * FROM gif_library WHERE id = ?').get(id);
  if (!r) throw err(404, 'Không tìm thấy GIF');
  if (countUse) db.prepare('UPDATE gif_library SET uses = uses + 1 WHERE id = ?').run(id);
  return { mime: r.mime, file: path.join(GIF_DIR, id) };
}

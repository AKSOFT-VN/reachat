// Sao lưu cơ sở dữ liệu khi server ĐANG CHẠY (API backup trực tuyến của SQLite — nhất quán, không khóa ghi lâu).
// Dùng: node scripts/backup-db.js   (BACKUP_DIR mặc định <thư mục DB>/backups, BACKUP_KEEP mặc định 14 bản)
import fs from 'node:fs';
import path from 'node:path';
import db from '../src/db.js';
import { DB_PATH } from '../src/config.js';

const dir = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const keep = Number(process.env.BACKUP_KEEP) || 14;
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const file = path.join(dir, `reachat-${stamp}.db`);
await db.backup(file);
const ok = (() => { try { const n = db.prepare('SELECT COUNT(*) n FROM users').get().n; return n >= 0; } catch { return false; } })();
// Giữ `keep` bản mới nhất.
const all = fs.readdirSync(dir).filter((f) => /^reachat-.*\.db$/.test(f)).sort();
for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, f));
console.log(`${new Date().toISOString()} sao lưu ${ok ? 'OK' : 'LỖI'}: ${file} (${(fs.statSync(file).size / 1048576).toFixed(2)} MB), giữ ${Math.min(all.length, keep)} bản`);

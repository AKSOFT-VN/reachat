// Sao lưu tệp đính kèm (uploads/) và kho GIF (gifs/) sang BACKUP_DIR/uploads, BACKUP_DIR/gifs theo kiểu "gương" tăng dần:
// chỉ chép tệp mới / đổi kích thước; tệp đã bị xóa ở nguồn được giữ thêm BACKUP_KEEP ngày rồi mới xóa.
// Chạy: npm run backup-files   (cùng lịch với backup-db)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPLOADS = fileURLToPath(new URL('../uploads', import.meta.url));
const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('../data.db', import.meta.url));
const GIFS = process.env.GIF_DIR || path.join(path.dirname(DB_PATH), 'gifs');
const BACKUP_DIR = process.env.BACKUP_DIR || fileURLToPath(new URL('../data/backups', import.meta.url));
const KEEP_DAYS = Number(process.env.BACKUP_KEEP) || 14;

function mirror(SRC, DST) {
  fs.mkdirSync(DST, { recursive: true });
  let copied = 0, bytes = 0, removed = 0;
  const src = new Set(fs.existsSync(SRC) ? fs.readdirSync(SRC) : []);
  for (const name of src) {
    const a = path.join(SRC, name), b = path.join(DST, name);
    const st = fs.statSync(a);
    if (!st.isFile()) continue;
    const bt = fs.existsSync(b) ? fs.statSync(b) : null;
    if (bt && bt.size === st.size) continue;
    fs.copyFileSync(a, b + '.part'); fs.renameSync(b + '.part', b);
    copied++; bytes += st.size;
  }
  // Tệp không còn ở nguồn: đánh dấu thời điểm biến mất, quá hạn thì xóa.
  const goneFile = path.join(DST, '.gone.json');
  let gone = {}; try { gone = JSON.parse(fs.readFileSync(goneFile, 'utf8')); } catch {}
  const now = Date.now();
  for (const name of fs.readdirSync(DST)) {
    if (name === '.gone.json' || src.has(name)) { delete gone[name]; continue; }
    gone[name] ||= now;
    if (now - gone[name] > KEEP_DAYS * 86400_000) { fs.rmSync(path.join(DST, name), { force: true }); delete gone[name]; removed++; }
  }
  fs.writeFileSync(goneFile, JSON.stringify(gone));
  console.log(`[backup-files] ${new Date().toISOString()} ${path.basename(DST)}: chép ${copied} tệp (${(bytes / 1048576).toFixed(1)} MB), xóa ${removed} tệp quá hạn -> ${DST}`);
}
mirror(UPLOADS, path.join(BACKUP_DIR, 'uploads'));
mirror(GIFS, path.join(BACKUP_DIR, 'gifs'));

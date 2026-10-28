// Sao chép bộ cài NSIS + latest.yml (+ blockmap) từ release/ sang thư mục cập nhật của server
// (mặc định ../server/updates, hoặc UPDATES_DIR). Client tự kiểm tra <máy chủ>/updates/latest.yml.
const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../package.json');
const rel = path.join(__dirname, '..', 'release');
const out = process.env.UPDATES_DIR || path.join(__dirname, '..', '..', 'server', 'updates');
fs.mkdirSync(out, { recursive: true });
const yml = fs.readFileSync(path.join(rel, 'latest.yml'), 'utf8');
if (!yml.includes(`version: ${version}`)) throw new Error('latest.yml không khớp phiên bản ' + version);
const files = fs.readdirSync(rel).filter((f) => f === 'latest.yml' || (f.includes(version) && /\.(exe|blockmap)$/.test(f)));
for (const f of files) fs.copyFileSync(path.join(rel, f), path.join(out, f));
console.log('Đã phát hành', version, '->', out, '\n ', files.join('\n  '));

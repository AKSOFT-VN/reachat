// Phát hành + triển khai ReaChat bằng MỘT lệnh:
//   npm run release -- 0.9.0          (hoặc --patch / --minor: tự tăng số phiên bản)
// Các bước (dừng ngay khi một bước hỏng):
//   1. Test máy chủ + app (npm test)            5. Đóng gói máy chủ + bản web + Dockerfile
//   2. Đặt phiên bản, build giao diện           6. Chép lên máy chủ, chạy deploy/remote-deploy.sh
//      (sao lưu CSDL, build Docker, chạy, chờ /health; hỏng -> tự quay lại bản trước)
//   3. Kiểm tra giao diện tự động trên bản build (scripts/smoke-ui.mjs)
//   4. Build bộ cài Windows + xuất bản cập nhật   7. Kiểm tra sau triển khai qua tên miền thật
// Tùy chọn: --skip-tests (bỏ bước 1), --no-installer (chỉ máy chủ + web), --no-deploy (không đẩy lên máy chủ),
//   --skip-smoke (bỏ bước 3 — chỉ dùng khi vừa chạy đạt cho đúng bản build này).
// Cấu hình triển khai: biến môi trường hoặc tệp deploy/deploy.env (KHÔNG đưa vào Git — xem deploy/deploy.env.example):
//   DEPLOY_HOST (tên máy ssh), DEPLOY_URL (https://chat.example.com), DEPLOY_DIR (mặc định /opt/reachat), SSH_BIN / SCP_BIN.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// deploy/deploy.env (KEY=giá trị mỗi dòng) — cấu hình máy chủ riêng của bạn, không nằm trong Git.
const envFile = path.join(ROOT, 'deploy', 'deploy.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const DESK = path.join(ROOT, 'desktop'), SRV = path.join(ROOT, 'server');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const HOST = process.env.DEPLOY_HOST;
const URL_ = String(process.env.DEPLOY_URL || '').replace(/\/$/, '');
const DIR = process.env.DEPLOY_DIR || '/opt/reachat';
if (!args.includes('--no-deploy') && (!HOST || !URL_)) {
  console.error('Thiếu DEPLOY_HOST / DEPLOY_URL — tạo deploy/deploy.env từ deploy/deploy.env.example, hoặc dùng --no-deploy.');
  process.exit(1);
}
const win = process.platform === 'win32';
const SSH = process.env.SSH_BIN || (win ? 'C:/Windows/System32/OpenSSH/ssh.exe' : 'ssh');   // ssh của Windows dùng khóa trong ssh-agent
const SCP = process.env.SCP_BIN || (win ? 'C:/Windows/System32/OpenSSH/scp.exe' : 'scp');
const t0 = Date.now();

const sh = (cmd, a, opts = {}) => {
  const r = spawnSync(cmd, a, { stdio: 'inherit', cwd: ROOT, shell: false, ...opts });
  if (r.status !== 0) { console.error(`\n✗ Lỗi ở bước: ${cmd} ${a.join(' ')}`); process.exit(1); }
};
const npm = (a, cwd = ROOT) => sh(win ? 'cmd.exe' : 'npm', win ? ['/d', '/s', '/c', 'npm', ...a] : a, { cwd });
const npx = (a, cwd) => sh(win ? 'cmd.exe' : 'npx', win ? ['/d', '/s', '/c', 'npx', ...a] : a, { cwd });
const title = (s) => console.log(`\n━━ ${s} (${Math.round((Date.now() - t0) / 1000)}s)`);

// ---- phiên bản ----
const pkgPath = path.join(DESK, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
let ver = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
if (!ver) ver = flag('--minor') ? `${ma}.${mi + 1}.0` : flag('--patch') ? `${ma}.${mi}.${pa + 1}` : null;
if (!ver) { console.error('Cần phiên bản: npm run release -- 0.9.0  (hoặc --patch / --minor)'); process.exit(1); }
console.log(`ReaChat ${pkg.version} -> ${ver}${flag('--no-deploy') ? '' : `  · triển khai: ${HOST} (${URL_})`}`);

if (!flag('--skip-tests')) { title('1/7 Test máy chủ + app'); npm(['test']); }

title('2/7 Đặt phiên bản + build giao diện');
pkg.version = ver;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
npx(['vite', 'build'], DESK);

if (!flag('--skip-smoke')) { title('3/7 Kiểm tra giao diện tự động trên bản build'); sh(process.execPath, [path.join(ROOT, 'scripts', 'smoke-ui.mjs')]); }

const updates = [];
if (!flag('--no-installer')) {
  title('4/7 Build bộ cài Windows + xuất bản cập nhật');
  const out = path.join(DESK, 'release-' + ver.replace(/\./g, ''));
  fs.rmSync(out, { recursive: true, force: true });
  // Thư mục riêng: release/win-unpacked có thể đang bị app đang chạy khóa.
  npx(['electron-builder', '--win', 'nsis', '-c.directories.output=' + path.relative(DESK, out)], DESK);
  // Chạy lại kiểm tra giao diện trên CHÍNH bản đóng gói (bắt lỗi chỉ có sau khi đóng gói: asar, CSP, Electron mới…).
  if (!flag('--skip-smoke')) sh(process.execPath, [path.join(ROOT, 'scripts', 'smoke-ui.mjs')], { env: { ...process.env, SMOKE_EXE: path.join(out, 'win-unpacked', 'ReaChat.exe') } });
  const rel = path.join(DESK, 'release');
  for (const f of [`ReaChat-Setup-${ver}.exe`, `ReaChat-Setup-${ver}.exe.blockmap`, 'latest.yml']) fs.copyFileSync(path.join(out, f), path.join(rel, f));
  sh(process.execPath, [path.join(DESK, 'scripts', 'publish-update.cjs')], { cwd: DESK });
  for (const f of [`ReaChat-Setup-${ver}.exe`, `ReaChat-Setup-${ver}.exe.blockmap`, 'latest.yml']) updates.push(path.join(SRV, 'updates', f));
}

title('5/7 Đóng gói máy chủ + bản web');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'reachat-bundle-'));
fs.mkdirSync(path.join(stage, 'server'));
for (const p of ['package.json', 'src', 'scripts', 'admin', 'legal']) fs.cpSync(path.join(SRV, p), path.join(stage, 'server', p), { recursive: true });
fs.cpSync(path.join(DESK, 'dist'), path.join(stage, 'web'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'deploy', 'Dockerfile'), path.join(stage, 'Dockerfile'));
const tgz = path.join(os.tmpdir(), 'reachat-bundle.tgz');
sh('tar', [...(win ? ['--force-local'] : []), '-czf', tgz, '-C', stage, '.']);
console.log('  gói:', (fs.statSync(tgz).size / 1024).toFixed(0), 'KB');

if (flag('--no-deploy')) { console.log(`\n✓ Đã build ${ver} (không triển khai).`); process.exit(0); }

title(`6/7 Triển khai lên ${HOST}`);
sh(SCP, [tgz, path.join(ROOT, 'deploy', 'remote-deploy.sh'), `${HOST}:${DIR}/`]);
if (updates.length) sh(SCP, [...updates, `${HOST}:${DIR}/data/updates/`]);
sh(SSH, [HOST, `chown 1000:1000 ${DIR}/data/updates/* 2>/dev/null; DEPLOY_DIR=${DIR} bash ${DIR}/remote-deploy.sh ${ver}`]);

title('7/7 Kiểm tra sau triển khai');
const checks = [];
const chk = async (name, fn) => { try { const ok = await fn(); checks.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${name}`); } catch (e) { checks.push(false); console.log(`  ✗ ${name} — ${e.message}`); } };
await chk('/health ok', async () => (await (await fetch(URL_ + '/health')).json()).ok === true);
if (updates.length) await chk(`bản cập nhật = ${ver}`, async () => (await (await fetch(URL_ + '/updates/latest.yml')).text()).includes(`version: ${ver}`));
// Bản web trên máy chủ phải là bản VỪA build (tên tệp JS mang mã băm nội dung) — "tải được" thôi là chưa đủ.
const localJs = fs.readFileSync(path.join(DESK, 'dist', 'index.html'), 'utf8').match(/assets\/index-[\w-]+\.js/)?.[0];
await chk('bản web /app đúng bản vừa build', async () => { const r = await fetch(URL_ + '/app/'); return r.ok && !!localJs && (await r.text()).includes(localJs); });
await chk('máy chủ chạy code mới (có API đồng bộ của 0.9)', async () => (await fetch(URL_ + '/api/me/sync')).status === 401);
await chk('captcha / đăng ký hoạt động', async () => !!(await (await fetch(URL_ + '/api/captcha')).json()).svg);
fs.rmSync(stage, { recursive: true, force: true });
if (checks.includes(false)) { console.error(`\n✗ Triển khai ${ver} có kiểm tra hỏng — xem ở trên.`); process.exit(1); }
console.log(`\n✓ Đã phát hành ${ver} lên ${URL_} trong ${Math.round((Date.now() - t0) / 1000)} giây.`);

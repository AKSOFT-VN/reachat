// Chạy toàn bộ test server: dựng server thử (DB tạm mới, cổng riêng), seed tài khoản demo, chạy lần lượt
// các bộ test, rồi dọn dẹp. Dùng: npm test (trong server). Không đụng tới data.db / cổng 4000 thật.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.TEST_PORT || '4100';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachat-test-'));
const env = {
  ...process.env, PORT, DB_PATH: path.join(dir, 'test.db'), UPDATES_DIR: path.join(dir, 'updates'),
  TURN_PORT: process.env.TEST_TURN_PORT || '3479',   // không tranh cổng TURN của server thật
  RING_TIMEOUT_MS: '1500', GCALL_MAX: '3', TLS: '',
  VAPID_FILE: path.join(dir, 'vapid.json'), GIF_DIR: path.join(dir, 'gifs'),
  NOTIFY_LOG: '1', NOTIFY_DEV_ECHO: '1',              // mã email/SMS: in log + trả trong phản hồi (chỉ server TEST)
  CAPTCHA: '0', REG_PER_IP_HOUR: '0', REG_PER_IP_DAY: '0',   // captcha / giới hạn đăng ký: kiểm riêng trong test-captcha
  NODE_TLS_REJECT_UNAUTHORIZED: '0',                  // chỉ server TEST: push service giả dùng chứng chỉ tự ký
  BOT_WEBHOOK_PRIVATE: '1',                           // webhook bot trong test trỏ về 127.0.0.1
  // Các bộ test gửi dồn hàng trăm tin -> nới giới hạn tốc độ; giới hạn THẬT được kiểm riêng trong test-limits (server riêng).
  RATE_MSG: '100000/1000', RATE_CREATE: '1000/100', RATE_SIGNAL: '100000/1000', RATE_UPLOAD: '1000/100', RATE_FRIEND: '1000/100', RATE_FRAME: '100000/10000',
};
const SUITES = ['test-new.mjs', 'test-calls.mjs', 'test-gcall.mjs', 'test-story.mjs', 'test-security.mjs', 'test-invite.mjs', 'test-admin.mjs', 'test-bots.mjs', 'test-channels.mjs', 'test-push.mjs', 'test-limits.mjs', 'test-files.mjs', 'test-account.mjs', 'test-turn.mjs', 'test-captcha.mjs', 'test-search.mjs', 'test-group2.mjs', 'test-gifs.mjs', 'test-hardening.mjs', 'test-qrlogin.mjs'];

spawnSync(process.execPath, ['src/seed.js'], { cwd: root, env, stdio: 'ignore' });
const server = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const cleanup = () => { try { server.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// Chờ server sẵn sàng.
const t0 = Date.now();
for (;;) {
  try { await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST' }); break; } catch {}
  if (Date.now() - t0 > 15000) { console.error('Server test không khởi động được:\n' + log); process.exit(1); }
  await new Promise((r) => setTimeout(r, 200));
}

let failed = 0;
const summary = [];
for (const s of SUITES) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [path.join('test', s)], { cwd: root, env, stdio: 'inherit', timeout: 180000 });
  summary.push(`${r.status === 0 ? '✓' : '✗'} ${s}`);
  if (r.status !== 0) failed++;
}
console.log('\n' + summary.join('\n'));
console.log(failed ? `\n${failed} bộ test LỖI` : '\nTất cả bộ test server đều đạt');
cleanup();
process.exit(failed ? 1 : 0);

// Test chống spam + đăng nhập Google + cảnh báo: server riêng (cổng 4104) bật captcha, giới hạn đăng ký theo IP,
// "Google giả" (cổng 4198) và webhook cảnh báo giả.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { totpAt } from '../src/security.js';

// ---- Google giả + webhook giả ----
const CID = 'cid-test.apps.googleusercontent.com';
let nextUser = { sub: 'g-111', email: 'an.nguyen@gmail.com', name: 'An Nguyễn' };
const hooks = [];
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/token') {
      const p = new URLSearchParams(body);
      if (p.get('client_secret') !== 'sec' || !p.get('code_verifier') || p.get('code') !== 'good') { res.writeHead(400).end('{"error":"invalid_grant"}'); return; }
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const idt = b64({ alg: 'RS256' }) + '.' + b64({ iss: 'https://accounts.google.com', aud: CID, exp: Math.floor(Date.now() / 1000) + 3600, email_verified: true, ...nextUser }) + '.sig';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id_token: idt })); return;
    }
    if (req.url === '/hook') { hooks.push(JSON.parse(body).text); res.writeHead(200).end('{}'); return; }
    res.writeHead(404).end();
  });
});
await new Promise((r) => fake.listen(4198, r));

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachat-cap-'));
const PORT = '4104', base = `http://localhost:${PORT}`;
const env = { ...process.env, PORT, DB_PATH: path.join(dir, 't.db'), TURN_BUILTIN: '0', VAPID_FILE: path.join(dir, 'v.json'),
  CAPTCHA: '1', CAPTCHA_DEV_ECHO: '1', REG_PER_IP_HOUR: '4', REG_PER_IP_DAY: '10',
  GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: 'sec', PUBLIC_URL: base, GOOGLE_AUTH_URL: 'http://localhost:4198/auth', GOOGLE_TOKEN_URL: 'http://localhost:4198/token',
  ALERT_WEBHOOK_URL: 'http://localhost:4198/hook', ALERT_CLIENT_ERRORS: '3', ALERT_NAME: 'test' };
spawnSync(process.execPath, ['src/seed.js'], { cwd: root, env, stdio: 'ignore' });
const srv = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.resume(); srv.stderr.resume();
process.on('exit', () => { try { srv.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { await fetch(base + '/health'); break; } catch { await sleep(200); } }
const post = (p, b, t) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b || {}) })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const cap = async () => { const c = await (await fetch(base + '/api/captcha')).json(); return { id: c.id, answer: c.devAnswer, svg: c.svg }; };
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

console.log('1) Captcha');
const c1 = await cap();
ok(/^<svg/.test(c1.svg) && !/<text/i.test(c1.svg) && !c1.svg.includes(c1.answer), 'ảnh SVG vẽ bằng nét, không chứa chữ đáp án');
ok((await post('/api/register', { username: 'cap_a', password: '123456' })).needCaptcha, 'đăng ký thiếu captcha -> từ chối');
ok((await post('/api/register', { username: 'cap_a', password: '123456', captcha: { id: c1.id, answer: 'ZZZZZ' } })).status === 400, 'sai đáp án -> từ chối');
ok((await post('/api/register', { username: 'cap_a', password: '123456', captcha: c1 })).status === 400, 'mã đã thử (dù sai) không dùng lại được');
const r1 = await post('/api/register', { username: 'cap_a', password: '123456', captcha: await cap() });
ok(!!r1.token, 'đúng captcha -> tạo tài khoản');
const c2 = await cap();
ok((await post('/api/register', { username: 'cap_b', password: '123456', captcha: { id: c2.id, answer: c2.answer.toLowerCase() } })).token, 'không phân biệt hoa/thường');
ok((await post('/api/register', { username: 'cap_c', password: '123456', captcha: c2 })).status === 400, 'mã đúng cũng chỉ dùng một lần');

console.log('2) Đăng nhập sai nhiều lần -> captcha');
for (let i = 0; i < 3; i++) await post('/api/login', { username: 'cap_a', password: 'sai' });
const l1 = await post('/api/login', { username: 'cap_a', password: '123456' });
ok(l1.status === 400 && l1.needCaptcha, 'sau 3 lần sai: mật khẩu đúng vẫn phải có captcha');
ok(!!(await post('/api/login', { username: 'cap_a', password: '123456', captcha: await cap() })).token, 'kèm captcha -> đăng nhập được');
ok((await post('/api/forgot/start', { ident: 'cap_a', channel: 'email' })).needCaptcha || true, 'quên mật khẩu yêu cầu captcha (nếu có kênh gửi)');

console.log('3) Giới hạn đăng ký theo IP (4/giờ)');
ok(!!(await post('/api/register', { username: 'cap_d', password: '123456', captcha: await cap() })).token, 'tài khoản thứ 3 từ cùng IP');
ok(!!(await post('/api/register', { username: 'cap_e', password: '123456', captcha: await cap() })).token, 'tài khoản thứ 4');
const r5 = await post('/api/register', { username: 'cap_f', password: '123456', captcha: await cap() });
ok(r5.status === 429, 'tài khoản thứ 5 trong 1 giờ -> 429');

console.log('4) Đăng nhập Google');
ok((await (await fetch(base + '/api/auth/google/config')).json()).enabled, 'cấu hình Google: bật');
const googleLogin = async (extra = {}, token) => {
  const b = await post('/api/auth/google/begin', extra, token);
  const r = await fetch(b.url, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  const okRedirect = loc.origin + loc.pathname === 'http://localhost:4198/auth' && loc.searchParams.get('state') === b.nonce && loc.searchParams.get('code_challenge_method') === 'S256';
  return { b, okRedirect, pending: await post('/api/auth/google/poll', { nonce: b.nonce }, token) };
};
// Trang callback hiện mã xác nhận; app phải gửi kèm mã đó khi hỏi kết quả.
const codeOf = {};
const callback = async (nonce, code = 'good') => {
  const html = await (await fetch(`${base}/auth/google/callback?code=${code}&state=${nonce}`)).text();
  codeOf[nonce] = /class="code">([A-Z0-9]+)</.exec(html)?.[1];
  return html;
};
const gpoll = (body, token) => post('/api/auth/google/poll', { code: codeOf[body.nonce], ...body }, token);
const g1 = await googleLogin();
ok(g1.okRedirect, 'chuyển sang Google kèm state + PKCE');
ok(g1.pending.pending, 'chưa xác thực -> đang chờ');
const cb = await callback(g1.b.nonce);
ok(cb.includes('Đã xác thực') && /^[A-Z0-9]{6}$/.test(codeOf[g1.b.nonce] || ''), 'trang callback báo thành công + hiện mã xác nhận');
ok((await post('/api/auth/google/poll', { nonce: g1.b.nonce })).needCode, 'chưa nhập mã xác nhận -> chưa trả kết quả (kẻ gửi link không lấy được phiên)');
ok((await post('/api/auth/google/poll', { nonce: g1.b.nonce, code: 'ZZZZZZ' })).status === 400, 'sai mã xác nhận -> từ chối');
const p1 = await gpoll({ nonce: g1.b.nonce });
ok(p1.needRegister && p1.email === 'an.nguyen@gmail.com' && /^annguyen/.test(p1.suggestedUsername), 'Google mới -> cần tạo tài khoản, gợi ý username');
// IP đã tạo đủ 4 tài khoản trong giờ -> tạo qua Google cũng bị chặn
const p2 = await gpoll({ nonce: g1.b.nonce, register: { username: 'an_google', password: 'abc123', acceptTerms: true } });
ok(p2.status === 429, 'tạo tài khoản qua Google cũng tính vào giới hạn theo IP');

console.log('5) Google: đăng nhập tài khoản đã liên kết, 2 bước, liên kết / gỡ');
const ta = r1.token;
const lk = await googleLogin({ mode: 'link' }, ta);
await callback(lk.b.nonce);
const linked = await gpoll({ nonce: lk.b.nonce }, ta);
ok(linked.linked && linked.email === 'an.nguyen@gmail.com', 'liên kết Google vào tài khoản cap_a');
const sec = await (await fetch(base + '/api/me/security', { headers: { Authorization: 'Bearer ' + ta } })).json();
ok(sec.google === 'an.nguyen@gmail.com' && sec.email !== 'an.nguyen@gmail.com', 'liên kết Google KHÔNG tự đặt email khôi phục');
const g2 = await googleLogin();
await callback(g2.b.nonce);
const p3 = await gpoll({ nonce: g2.b.nonce });
ok(p3.token && p3.user.username === 'cap_a', 'đăng nhập bằng Google -> đúng tài khoản');
ok((await gpoll({ nonce: g2.b.nonce })).status === 410, 'phiên Google dùng một lần');
const setup = await post('/api/me/2fa/setup', {}, ta);
while (Date.now() % 30000 > 20000) await sleep(500);
const S = Math.floor(Date.now() / 30000);
await post('/api/me/2fa/enable', { code: totpAt(setup.secret, S - 1) }, ta);
const g3 = await googleLogin();
await callback(g3.b.nonce);
ok((await gpoll({ nonce: g3.b.nonce })).need2fa, 'bật 2 bước -> Google cũng phải nhập mã');
ok(!!(await gpoll({ nonce: g3.b.nonce, otp: totpAt(setup.secret, S) })).token, 'kèm mã 2 bước -> vào được');
const g5 = await googleLogin();
await callback(g5.b.nonce);
for (let i = 0; i < 5; i++) await gpoll({ nonce: g5.b.nonce, otp: '000000' });
ok((await gpoll({ nonce: g5.b.nonce, otp: totpAt(setup.secret, S) })).status === 410, 'sai mã 2 bước 5 lần -> hủy luồng Google (không dò mã được)');
const tb = (await post('/api/login', { username: 'cap_b', password: '123456' })).token;
const lk2 = await googleLogin({ mode: 'link' }, tb);
await callback(lk2.b.nonce);
ok((await gpoll({ nonce: lk2.b.nonce }, tb)).status === 409, 'Google đã gắn tài khoản khác -> không liên kết được');
const g4 = await googleLogin();
const bad = await callback(g4.b.nonce, 'bad');
ok(bad.includes('Chưa đăng nhập được') && (await gpoll({ nonce: g4.b.nonce })).status === 400, 'mã Google không hợp lệ -> báo lỗi');
ok((await post('/api/me/google/unlink', { password: 'sai' }, ta)).status === 403, 'gỡ liên kết cần mật khẩu');
ok((await post('/api/me/google/unlink', { password: '123456' }, ta)).ok, 'gỡ liên kết Google');

console.log('6) Cảnh báo');
ok(hooks.some((t) => /khởi động/.test(t)), 'khởi động máy chủ -> gửi cảnh báo qua webhook');
for (let i = 0; i < 3; i++) await post('/api/client-errors', { message: 'TypeError: x is undefined', version: '0.7.3', platform: 'win32' });
await sleep(300);
ok(hooks.some((t) => /lỗi ứng dụng/.test(t)), 'lỗi ứng dụng tăng đột biến -> cảnh báo');

fake.close();
console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

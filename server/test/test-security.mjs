// Test bảo mật tài khoản: 2 bước TOTP, chống dò mật khẩu, mã khôi phục, đổi mật khẩu thu hồi phiên.
import WebSocket from 'ws';
import { totpAt } from '../src/security.js';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const call = async (method, p, b, t) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ...(await r.json()) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsOpen = (t) => new Promise((res) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.on('open', () => res({ ws })); });
// Chờ server đóng kết nối, trả mã đóng (token hợp lệ thì hết giờ -> 'open').
const wsClose = (t) => new Promise((res) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); const tm = setTimeout(() => { ws.close(); res({ code: 'open' }); }, 3000); ws.on('close', (code) => { clearTimeout(tm); res({ code }); }); });
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
const code = (secret, offset = 0) => totpAt(secret, Math.floor(Date.now() / 30000) + offset);

const reg = await call('POST', '/api/register', { username: 'baomat', password: 'matkhau1', displayName: 'Bảo Mật' });
let tok = reg.token;

console.log('1) Bật xác thực 2 bước');
const setup = await call('POST', '/api/me/2fa/setup', {}, tok);
ok(/^[A-Z2-7]{32}$/.test(setup.secret) && setup.uri.startsWith('otpauth://totp/ReaChat:baomat'), 'cấp khóa TOTP + otpauth URI');
ok((await call('POST', '/api/me/2fa/enable', { code: '000000' }, tok)).status === 400, 'mã sai -> chưa bật');
ok((await call('POST', '/api/me/2fa/enable', { code: code(setup.secret) }, tok)).ok, 'mã đúng -> bật');
ok((await call('GET', '/api/me/security', null, tok)).totp === true, 'trạng thái: đang bật');

console.log('2) Đăng nhập cần mã');
const l1 = await call('POST', '/api/login', { username: 'baomat', password: 'matkhau1' });
ok(l1.status === 401 && l1.need2fa && !l1.token, 'đúng mật khẩu, thiếu mã -> need2fa');
await sleep(30000 - (Date.now() % 30000) + 200);                // sang bước mới (mã lúc bật đã dùng)
const c1 = code(setup.secret);
const l2 = await call('POST', '/api/login', { username: 'baomat', password: 'matkhau1', otp: c1 });
ok(!!l2.token, 'đúng mật khẩu + đúng mã -> vào được');
const l3 = await call('POST', '/api/login', { username: 'baomat', password: 'matkhau1', otp: c1 });
ok(l3.status === 401 && !l3.token, 'dùng lại cùng mã -> bị từ chối (chống phát lại)');
tok = l2.token;

console.log('3) Chống dò mật khẩu');
await call('POST', '/api/register', { username: 'bidodo', password: 'dungroi1' });
let st = [];
for (let i = 0; i < 9; i++) st.push((await call('POST', '/api/login', { username: 'bidodo', password: 'sai' + i })).status);
ok(st.slice(0, 8).every((s) => s === 401) && st[8] === 429, `8 lần sai -> lần 9 bị chặn (${st.join(',')})`);
ok((await call('POST', '/api/login', { username: 'bidodo', password: 'dungroi1' })).status === 429, 'đang bị chặn thì mật khẩu đúng cũng phải chờ');
ok(!!(await call('POST', '/api/login', { username: 'nam', password: '123456' })).token, 'tài khoản khác cùng IP vẫn đăng nhập được');

console.log('4) Mã khôi phục');
const verifier = 'ab'.repeat(32);
ok((await call('POST', '/api/me/recovery', { verifier, backup: { v: 2, nonce: 'n', box: 'b' } }, tok)).ok, 'lưu verifier + bản sao lưu bọc mã');
const { ws: oldWs } = await wsOpen(tok);
const bad = await call('POST', '/api/recover', { username: 'baomat', verifier: 'cd'.repeat(32), newPassword: 'moi12345' });
ok(bad.status === 401, 'sai mã -> từ chối');
const closed = new Promise((res) => oldWs.on('close', (c) => res(c)));
const rec = await call('POST', '/api/recover', { username: 'baomat', verifier, newPassword: 'moi12345' });
ok(!!rec.token && rec.recoveryBackup?.box === 'b', 'đúng mã -> mật khẩu mới + trả bản sao lưu khóa');
ok(await Promise.race([closed, sleep(2000).then(() => 'timeout')]) === 4401, 'kết nối cũ bị đóng (4401)');
ok((await call('GET', '/api/me/security', null, tok)).status === 401, 'token cũ hết hiệu lực');
const sec = await call('GET', '/api/me/security', null, rec.token);
ok(sec.totp === false && sec.recovery === false, 'sau khôi phục: tắt 2 bước, mã đã dùng hết hiệu lực');
ok((await call('POST', '/api/recover', { username: 'baomat', verifier, newPassword: 'lan2xxxx' })).status === 401, 'không dùng lại được mã');
ok(!!(await call('POST', '/api/login', { username: 'baomat', password: 'moi12345' })).token, 'đăng nhập bằng mật khẩu mới');

console.log('5) Đổi mật khẩu');
tok = rec.token;
ok((await call('POST', '/api/me/password', { oldPassword: 'sai', newPassword: 'abcdef12' }, tok)).status === 403, 'sai mật khẩu cũ -> từ chối');
const ch = await call('POST', '/api/me/password', { oldPassword: 'moi12345', newPassword: 'abcdef12' }, tok);
ok(!!ch.token && ch.token !== tok, 'đổi thành công, cấp token mới');
ok((await call('GET', '/api/me/security', null, tok)).status === 401 && (await call('GET', '/api/me/security', null, ch.token)).status === 200, 'token cũ hỏng, token mới dùng được');
ok((await wsClose(tok)).code === 4401, 'WebSocket với token cũ bị từ chối (4401)');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

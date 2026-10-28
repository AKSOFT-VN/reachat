// Test tài khoản: thiết bị đăng nhập (liệt kê / đăng xuất từng máy / đăng xuất máy khác + đóng WebSocket),
// /health, Điều khoản, email/SĐT xác minh, quên mật khẩu qua mã (chống dò tài khoản, 2 bước, dùng một lần),
// tự xóa tài khoản.
// Server test chạy với NOTIFY_LOG=1 + NOTIFY_DEV_ECHO=1: mã 6 số được trả trong phản hồi thay vì gửi thật.
import WebSocket from 'ws';
import { totpAt } from '../src/security.js';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const rnd = Math.random().toString(36).slice(2, 7);
const post = (p, b, t) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b || {}) })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const get = (p, t) => fetch(base + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const del = (p, t) => fetch(base + p, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
const openWs = (t) => new Promise((r) => { const w = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); w.on('close', (c) => { w.code = c; }); w.on('open', () => setTimeout(() => r(w), 300)); w.on('error', () => r(w)); });
const closed = (w) => new Promise((r) => { if (w.code) return r(w.code); w.on('close', (c) => r(c)); setTimeout(() => r(null), 2000); });

console.log('1) Đăng ký + Điều khoản');
const ua = 'acc_' + rnd;
const reg = await post('/api/register', { username: ua, password: '123456', acceptTerms: true, device: 'Máy test A' });
ok(!!reg.token, 'đăng ký có acceptTerms');
const t1 = reg.token;
ok((await fetch(base + '/legal/terms.html')).status === 200 && (await fetch(base + '/legal/privacy.html')).status === 200, 'trang Điều khoản & Chính sách phục vụ được');
const terms = await (await fetch(base + '/legal/terms.html')).text();
ok(!terms.includes('{{') && terms.includes('đơn vị vận hành máy chủ này'), 'mẫu Điều khoản được điền thông tin đơn vị vận hành (không còn {{…}})');
ok((await fetch(base + '/legal/_style.css')).status === 200, 'tệp CSS của trang pháp lý vẫn phục vụ được');

console.log('2) Thiết bị đăng nhập');
const t2 = (await post('/api/login', { username: ua, password: '123456', device: 'Máy test B' })).token;
const t3 = (await post('/api/login', { username: ua, password: '123456' })).token;
let s = await get('/api/me/sessions', t1);
ok(s.sessions?.length === 3 && !!s.current, 'liệt kê 3 phiên, biết phiên hiện tại');
ok(s.sessions.some((x) => x.device === 'Máy test B'), 'nhãn thiết bị được lưu');
const sid2 = (await get('/api/me/sessions', t2)).current;
const w2 = await openWs(t2);
ok((await del('/api/me/sessions/' + sid2, t1)).ok, 'đăng xuất từ xa phiên B');
ok((await closed(w2)) === 4401, 'WebSocket của máy B bị đóng (4401)');
ok((await get('/api/me/sessions', t2)).status === 401, 'token máy B hết hiệu lực');
ok((await get('/api/me/sessions', t1)).status === 200, 'máy A vẫn dùng được');
ok((await del('/api/me/sessions/khong-ton-tai', t1)).status === 404, 'phiên không tồn tại -> 404');
const w3 = await openWs(t3);
const ro = await post('/api/me/sessions/revoke-others', {}, t1);
ok(ro.revoked === 1, 'đăng xuất mọi máy khác');
ok((await closed(w3)) === 4401 && (await get('/api/me/sessions', t3)).status === 401, 'máy C bị đá ra');
ok((await get('/api/me/sessions', t1)).sessions?.length === 1, 'chỉ còn phiên hiện tại');

console.log('3) /health');
const h = await get('/health');
ok(h.status === 200 && h.ok && h.db === true && typeof h.uptimeSec === 'number', '/health trả ok');

console.log('4) Email / số điện thoại');
const st0 = await get('/api/me/security', t1);
ok(st0.channels?.email && st0.channels?.sms && st0.email === null, 'kênh email/SMS khả dụng, chưa gắn');
ok((await post('/api/me/contact/start', { kind: 'email', value: 'khong-hop-le' }, t1)).status === 400, 'email sai định dạng -> 400');
const em = `${ua}@vidu.vn`;
const c1 = await post('/api/me/contact/start', { kind: 'email', value: em }, t1);
ok(c1.ok && /^\d{6}$/.test(c1.devCode), 'gửi mã xác minh email');
ok((await post('/api/me/contact/start', { kind: 'email', value: em }, t1)).status === 429, 'gửi lại ngay -> phải đợi');
ok((await post('/api/me/contact/verify', { kind: 'email', code: c1.devCode === '000000' ? '111111' : '000000' }, t1)).status === 400, 'mã sai -> 400');
ok((await post('/api/me/contact/verify', { kind: 'email', code: c1.devCode }, t1)).ok, 'xác minh email');
const p1 = await post('/api/me/contact/start', { kind: 'phone', value: '0912 345 6' + rnd.replace(/\D/g, '0').slice(0, 2).padEnd(2, '0') }, t1);
ok(p1.ok, 'gửi mã tới SĐT dạng 0xxx');
ok((await post('/api/me/contact/verify', { kind: 'phone', code: p1.devCode }, t1)).ok, 'xác minh SĐT');
const st1 = await get('/api/me/security', t1);
ok(st1.email === em && /^\+84\d{9}$/.test(st1.phone), 'trạng thái: email + SĐT (chuẩn hóa +84)');
const ub = 'acb_' + rnd;
const tb = (await post('/api/register', { username: ub, password: '123456' })).token;
ok((await post('/api/me/contact/start', { kind: 'email', value: em }, tb)).status === 409, 'email đã gắn tài khoản khác -> 409');
const pub = await get('/api/users/' + ua, tb);
ok(!JSON.stringify(pub).includes(em), 'email không lộ qua hồ sơ công khai');

console.log('5) Quên mật khẩu qua email');
const g0 = await post('/api/forgot/start', { ident: 'khong_ton_tai_' + rnd, channel: 'email' });
const g1 = await post('/api/forgot/start', { ident: ua, channel: 'email' });
ok(g0.ok && g1.ok && g0.message === g1.message && !g0.devCode && /^\d{6}$/.test(g1.devCode), 'trả lời giống nhau dù tài khoản có hay không');
const wA = await openWs(t1);
ok((await post('/api/forgot/reset', { ident: ua, code: '999999' === g1.devCode ? '888888' : '999999', newPassword: 'moi123' })).status === 400, 'mã sai -> 400');
const rs = await post('/api/forgot/reset', { ident: em, code: g1.devCode, newPassword: 'moi123', device: 'Máy khôi phục' });
ok(!!rs.token && rs.user?.username === ua && rs.keyBackupReset, 'đặt lại bằng email (nhập địa chỉ email) -> token mới');
ok((await closed(wA)) === 4401 && (await get('/api/me/sessions', t1)).status === 401, 'mọi phiên cũ bị đăng xuất');
ok((await post('/api/forgot/reset', { ident: ua, code: g1.devCode, newPassword: 'lan2xx' })).status === 400, 'mã đã dùng -> không dùng lại được');
ok(!!(await post('/api/login', { username: ua, password: 'moi123' })).token, 'đăng nhập bằng mật khẩu mới');
ok((await get('/api/me/keybackup', rs.token)).backup === null, 'bản sao lưu khóa (bọc bằng mật khẩu cũ) đã bị xóa');

console.log('6) Quên mật khẩu qua SMS + bật 2 bước');
const t4 = rs.token;
while (Date.now() % 30000 > 18000) await new Promise((r) => setTimeout(r, 500));   // tránh ranh giới bước 30 giây
const S = Math.floor(Date.now() / 30000);   // mã 2 bước: bật = S-1, đặt lại = S, xóa = S+1 (mỗi mã chỉ dùng 1 lần)
const setup = await post('/api/me/2fa/setup', {}, t4);
ok((await post('/api/me/2fa/enable', { code: totpAt(setup.secret, S - 1) }, t4)).ok, 'bật 2 bước');
const g2 = await post('/api/forgot/start', { ident: st1.phone, channel: 'sms' });
ok(/^\d{6}$/.test(g2.devCode || ''), 'gửi mã SMS (tìm theo SĐT)');
const n2 = await post('/api/forgot/reset', { ident: ua, code: g2.devCode, newPassword: 'sms123' });
ok(n2.status === 401 && n2.need2fa, 'bật 2 bước -> thiếu mã 2 bước thì từ chối');
const r2 = await post('/api/forgot/reset', { ident: ua, code: g2.devCode, newPassword: 'sms123', otp: totpAt(setup.secret, S) });
ok(!!r2.token, 'mã SMS + mã 2 bước -> đặt lại thành công (mã SMS không bị tiêu khi thiếu 2 bước)');
for (let i = 0; i < 8; i++) await post('/api/forgot/start', { ident: 'spam_' + rnd, channel: 'email' });
ok((await post('/api/forgot/start', { ident: 'spam_' + rnd, channel: 'email' })).status === 429, 'gửi mã liên tục -> bị giới hạn');

console.log('7) Xóa tài khoản');
const t5 = r2.token;
ok((await post('/api/me/delete', { password: 'sms123' }, t5)).status === 400, 'thiếu xác nhận "XOA" -> 400');
ok((await post('/api/me/delete', { password: 'sai', confirm: 'XOA' }, t5)).status === 403, 'sai mật khẩu -> 403 (không đăng xuất)');
ok((await post('/api/me/delete', { password: 'sms123', confirm: 'XOA' }, t5)).status === 403, 'bật 2 bước mà thiếu mã -> 403');
const d = await post('/api/me/delete', { password: 'sms123', confirm: 'XOA', otp: totpAt(setup.secret, S + 1) }, t5);
ok(d.ok, 'xóa tài khoản');
ok((await get('/api/me/sessions', t5)).status === 401, 'token cũ hết hiệu lực');
ok((await post('/api/login', { username: ua, password: 'sms123' })).status === 401, 'không đăng nhập lại được');
const g3 = await post('/api/forgot/start', { ident: em, channel: 'email' });
ok(g3.ok && !g3.devCode, 'email của tài khoản đã xóa không còn nhận mã');
ok(!!(await post('/api/register', { username: ua, password: '123456' })).token, 'username được giải phóng để đăng ký lại');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

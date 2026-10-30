// Test đăng nhập máy mới bằng QR. Chạy với server test: PORT=4100 (DB riêng, đã seed).
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const req = (method, p, b, t) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const tn = (await req('POST', '/api/login', { username: 'nam', password: '123456' })).token;
const epk = Buffer.alloc(32, 7).toString('base64'), secret = 'b'.repeat(43);

console.log('1) Tạo phiên');
ok((await req('POST', '/api/qrlogin/begin', { epk: 'xấu', secret })).status === 400, 'khóa tạm sai định dạng -> 400');
ok((await req('POST', '/api/qrlogin/begin', { epk, secret: 'ngắn' })).status === 400, 'thiếu bí mật phiên -> 400');
const b = await req('POST', '/api/qrlogin/begin', { epk, secret, device: 'Máy test' });
ok(b.sid && b.expiresAt > Date.now(), 'nhận sid + hạn');

console.log('2) Chờ duyệt');
ok((await req('POST', '/api/qrlogin/poll', { sid: b.sid, secret })).pending === true, 'chưa duyệt -> pending');
ok((await req('POST', '/api/qrlogin/poll', { sid: b.sid, secret: 'c'.repeat(43) })).status === 403, 'sai bí mật (ai chụp được QR) -> 403');
ok((await req('POST', '/api/qrlogin/info', { sid: b.sid })).status === 401, 'xem thông tin phiên cần đăng nhập');
const info = await req('POST', '/api/qrlogin/info', { sid: b.sid }, tn);
ok(info.epk === epk && info.device, 'máy cũ thấy khóa tạm + tên thiết bị');

console.log('3) Duyệt + nhận token');
const sealed = { epk, nonce: 'n', box: 'b' };
ok((await req('POST', '/api/qrlogin/approve', { sid: b.sid, sealed }, tn)).ok, 'máy cũ duyệt');
ok((await req('POST', '/api/qrlogin/approve', { sid: b.sid, sealed }, tn)).status === 409, 'duyệt lần 2 -> 409');
const r = await req('POST', '/api/qrlogin/poll', { sid: b.sid, secret });
ok(r.token && r.user?.username === 'nam' && r.sealed?.box === 'b', 'máy mới nhận token + gói khóa niêm phong');
ok((await req('GET', '/api/me/sessions', null, r.token)).sessions?.length >= 2, 'token mới dùng được, thành một phiên riêng');
ok((await req('POST', '/api/qrlogin/poll', { sid: b.sid, secret })).status === 410, 'phiên chỉ dùng một lần');
ok((await req('POST', '/api/qrlogin/approve', { sid: 'khong-ton-tai-123456', sealed }, tn)).status === 410, 'sid lạ -> 410');

console.log(`\n${pass}/${pass + fail} pass`);
process.exitCode = fail ? 1 : 0;   // không process.exit(): Node trên Windows có thể lỗi khi socket keep-alive đang đóng

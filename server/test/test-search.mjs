// Test tìm bạn bè: tên không dấu, một phần username, email/SĐT chỉ khớp chính xác, quyền riêng tư, chặn,
// quan hệ (bạn bè / đã gửi / chờ mình chấp nhận), giới hạn tốc độ.
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const rnd = Math.random().toString(36).slice(2, 6);
const post = (p, b, t) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b || {}) })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const find = (q, t) => fetch(base + '/api/users/search?q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + t } }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const names = (r) => (r.results || []).map((u) => u.username);
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
const reg = async (u, displayName) => (await post('/api/register', { username: u, password: '123456', displayName })).token;

const me = await reg('tim_' + rnd, 'Người Tìm');
const tLan = await reg('lan_' + rnd, 'Nguyễn Thị Lan');
const tLong = await reg('long_' + rnd, 'Trần Văn Long');
const tAn = await reg('an_' + rnd, 'Phạm An');

console.log('1) Theo tên / username');
ok(names(await find('nguyen thi lan', me)).includes('lan_' + rnd), 'tên không dấu tìm được tên có dấu');
ok(names(await find('LAN', me)).includes('lan_' + rnd), 'không phân biệt hoa thường, khớp từ trong tên');
ok(names(await find('long_' + rnd.slice(0, 2), me)).includes('long_' + rnd), 'một phần username');
const self = await find('Người Tìm', me);
ok(!names(self).includes('tim_' + rnd), 'không trả về chính mình');
ok(names(await find('x', me)).length === 0, 'từ khóa 1 ký tự -> không tìm');
const r1 = (await find('lan_' + rnd, me)).results[0];
ok(r1 && r1.displayName === 'Nguyễn Thị Lan' && !('email' in r1) && !('phone' in r1) && r1.relation === null, 'kết quả chỉ có thông tin công khai + quan hệ');

console.log('2) Email / số điện thoại');
const em = `lan.${rnd}@vidu.vn`;
const c = await post('/api/me/contact/start', { kind: 'email', value: em }, tLan);
await post('/api/me/contact/verify', { kind: 'email', code: c.devCode }, tLan);
const phone = '09' + String(Date.now()).slice(-8);
const pc = await post('/api/me/contact/start', { kind: 'phone', value: phone }, tLan);
await post('/api/me/contact/verify', { kind: 'phone', code: pc.devCode }, tLan);
const byEmail = await find(em.toUpperCase(), me);
ok(byEmail.by === 'email' && names(byEmail).includes('lan_' + rnd), 'email đầy đủ -> tìm được');
ok(names(await find(`lan.${rnd}@vidu`, me)).length === 0, 'một phần email -> không ra (chống dò)');
ok(names(await find(phone.replace(/^0/, '+84'), me)).includes('lan_' + rnd), 'số điện thoại (dạng +84) -> tìm được');
ok(names(await find(phone.slice(0, 7), me)).length === 0, 'một phần số điện thoại -> không ra');

console.log('3) Quyền riêng tư');
await post('/api/me/privacy', { findByContact: false }, tLan);
ok(names(await find(em, me)).length === 0, 'tắt tìm bằng email/SĐT -> không ra');
await post('/api/me/privacy', { findByName: false }, tLan);
ok(!names(await find('nguyen thi lan', me)).includes('lan_' + rnd), 'tắt tìm theo tên -> không ra');
ok(names(await find('lan_' + rnd, me)).includes('lan_' + rnd), 'username đầy đủ vẫn tìm được (như kết bạn bằng username)');
const pv = await (await fetch(base + '/api/me/privacy', { headers: { Authorization: 'Bearer ' + tLan } })).json();
ok(pv.findByName === false && pv.findByContact === false, 'đọc lại cài đặt quyền riêng tư');

console.log('4) Quan hệ & chặn');
await post('/api/friends/request', { username: 'long_' + rnd }, me);
ok((await find('tran van long', me)).results[0]?.relation === 'sent', 'đã gửi lời mời -> "sent"');
ok((await find('nguoi tim', tLong)).results.find((u) => u.username === 'tim_' + rnd)?.relation === 'incoming', 'phía kia thấy "incoming"');
await post('/api/friends/request', { username: 'tim_' + rnd }, tLong);
ok((await find('tran van long', me)).results[0]?.relation === 'friend', 'đã là bạn -> "friend"');
await post('/api/block', { username: 'tim_' + rnd }, tAn);
ok(!names(await find('pham an', me)).includes('an_' + rnd), 'người đã chặn mình -> không hiện');
await post('/api/me/profile', { displayName: 'Hoàng Đổi Tên' }, tLong);
ok(names(await find('hoang doi ten', me)).includes('long_' + rnd), 'đổi tên hiển thị -> tìm được bằng tên mới');

console.log('5) Giới hạn tốc độ');
let last;
for (let i = 0; i < 31; i++) last = await find('ab' + i, tAn);
ok(last.status === 429, 'tìm quá 30 lần/phút -> 429');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

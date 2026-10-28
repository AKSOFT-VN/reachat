// Test kho GIF tự quản: chỉ quản trị viên thêm/sửa/xóa; kiểm loại tệp theo nội dung; chống trùng;
// người dùng tìm theo từ khóa không dấu, tải về, đếm lượt gửi; bật GIF trong app khi kho có GIF.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const rnd = Math.random().toString(36).slice(2, 6);
const call = (method, p, b, t) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
const reg = async (u) => (await call('POST', '/api/register', { username: u, password: '123456' })).token;

// GIF 1x1 hợp lệ (mỗi tệp khác nhau một byte màu để không bị coi là trùng)
const gif = (c) => Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, c, c, c, 0, 0, 0, 0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b]).toString('base64');
const adminU = 'gifadm_' + rnd, userU = 'gifusr_' + rnd;
const ta = await reg(adminU), tu = await reg(userU);
spawnSync(process.execPath, ['scripts/make-admin.js', adminU], { cwd: root, env: process.env });

console.log('1) Quản trị kho');
ok((await call('POST', '/api/admin/gifs', { dataB64: gif(1), title: 'x' }, tu)).status === 403, 'người thường không thêm được GIF');
const g1 = await call('POST', '/api/admin/gifs', { dataB64: gif(10), title: 'Chúc mừng sinh nhật', tags: 'sinh nhật, chúc mừng, bánh kem' }, ta);
ok(/^[0-9a-f]{24}$/.test(g1.id) && g1.tags === 'sinh nhật, chúc mừng, bánh kem', 'thêm GIF + từ khóa');
const g2 = await call('POST', '/api/admin/gifs', { dataB64: gif(20), title: 'Cảm ơn nhiều', tags: 'cảm ơn; thanks' }, ta);
ok(g2.id && g2.tags === 'cảm ơn, thanks', 'chuẩn hóa từ khóa');
ok((await call('POST', '/api/admin/gifs', { dataB64: gif(10), title: 'trùng' }, ta)).duplicate === true, 'cùng nội dung -> không lưu 2 lần');
ok((await call('POST', '/api/admin/gifs', { dataB64: Buffer.from('<script>alert(1)</script>').toString('base64'), title: 'gia.gif' }, ta)).status === 400, 'tệp không phải ảnh động -> từ chối (kiểm theo nội dung, không theo tên)');
const up = await call('POST', '/api/admin/gifs/' + g2.id, { tags: 'cảm ơn, thanks, tks' }, ta);
ok(up.tags === 'cảm ơn, thanks, tks', 'sửa từ khóa');
const list = await call('GET', '/api/admin/gifs?q=cam on', null, ta);
ok(list.items.some((x) => x.id === g2.id), 'quản trị tìm trong kho (không dấu)');

console.log('2) Người dùng tìm + gửi');
ok((await call('GET', '/api/extras/config', null, tu)).gif === true, 'kho có GIF -> app bật nút GIF');
const s1 = await call('GET', '/api/gif/search?q=' + encodeURIComponent('chuc mung'), null, tu);
ok(s1.items?.[0]?.id === 'lib:' + g1.id, 'tìm "chuc mung" (không dấu) ra GIF sinh nhật');
const s2 = await call('GET', '/api/gif/search?q=' + encodeURIComponent('sinh nhat banh'), null, tu);
ok(s2.items.length === 1 && s2.items[0].id === 'lib:' + g1.id, 'nhiều từ: phải khớp tất cả');
ok((await call('GET', '/api/gif/search?q=khongcogi', null, tu)).items.length === 0, 'không khớp -> rỗng');
const r = await fetch(base + '/api/gif/lib/' + g1.id + '?use=1', { headers: { Authorization: 'Bearer ' + tu } });
const buf = Buffer.from(await r.arrayBuffer());
ok(r.status === 200 && r.headers.get('content-type').startsWith('image/gif') && buf.toString('base64') === gif(10), 'tải GIF từ kho, đúng từng byte');
ok((await fetch(base + '/api/gif/lib/' + g1.id)).status === 401, 'phải đăng nhập mới tải được');
ok((await fetch(base + '/api/gif/lib/..%2f..%2fdata.db', { headers: { Authorization: 'Bearer ' + tu } })).status === 400, 'mã GIF lạ (dò đường dẫn) -> từ chối');
const top = await call('GET', '/api/gif/search?q=', null, tu);
ok(top.items[0]?.id === 'lib:' + g1.id, 'không gõ gì -> GIF hay được gửi nhất lên đầu');

console.log('3) Xóa');
ok((await call('DELETE', '/api/admin/gifs/' + g2.id, null, tu)).status === 403, 'người thường không xóa được');
ok((await call('DELETE', '/api/admin/gifs/' + g2.id, null, ta)).ok, 'quản trị xóa GIF');
ok((await fetch(base + '/api/gif/lib/' + g2.id, { headers: { Authorization: 'Bearer ' + tu } })).status === 404, 'GIF đã xóa không tải được nữa');
await call('DELETE', '/api/admin/gifs/' + g1.id, null, ta);

console.log('4) Sticker (theo gói)');
const st1 = await call('POST', '/api/admin/gifs', { dataB64: gif(31), title: 'Mèo vẫy tay', kind: 'sticker', pack: 'Mèo béo' }, ta);
const st2 = await call('POST', '/api/admin/gifs', { dataB64: gif(32), title: 'Mèo ngủ', kind: 'sticker', pack: 'Mèo béo' }, ta);
ok(st1.kind === 'sticker' && st1.pack === 'Mèo béo' && st2.id, 'thêm sticker vào gói');
const packs = await call('GET', '/api/stickers', null, tu);
ok(packs.packs?.length === 1 && packs.packs[0].pack === 'Mèo béo' && packs.packs[0].items.length === 2, 'app lấy được gói sticker');
ok(!(await call('GET', '/api/gif/search?q=meo', null, tu)).items.some((x) => x.id === 'lib:' + st1.id), 'sticker không lẫn vào kết quả tìm GIF');
ok((await call('GET', '/api/admin/gifs?kind=sticker', null, ta)).total === 2, 'trang quản trị lọc theo loại');
await call('DELETE', '/api/admin/gifs/' + st1.id, null, ta); await call('DELETE', '/api/admin/gifs/' + st2.id, null, ta);

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

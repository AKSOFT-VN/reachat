// Test báo cáo vi phạm + quản trị: quyền admin, gỡ tin, khóa/mở khóa tài khoản, trang /admin.
import WebSocket from 'ws';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const call = async (method, p, b, t) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const login = async (u) => { let r = await call('POST', '/api/login', { username: u, password: '123456' }); if (!r.token) r = await call('POST', '/api/register', { username: u, password: '123456' }); return r.token; };
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (ws, pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = ws.inbox.findIndex(pred); if (i >= 0) return ws.inbox.splice(i, 1)[0]; await sleep(30); } throw new Error('timeout chờ sự kiện'); };
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const tq = await login('quantri'), tx = await login('xau'), tn = await login('nannhan'), to = await login('nguoingoai');
const wx = await open(tx), wn = await open(tn);
await wait(wx, (m) => m.type === 'ready'); await wait(wn, (m) => m.type === 'ready');
wx.send(JSON.stringify({ type: 'send', to: 'nannhan', body: 'chuyển khoản 5 triệu để nhận quà', ref: 'r1' }));
const msg = (await wait(wn, (m) => m.type === 'message')).message;

console.log('1) Báo cáo');
ok((await call('POST', '/api/reports', { messageId: msg.id, reason: 'scam' }, to)).status === 404, 'người ngoài hội thoại không báo cáo được tin');
ok((await call('POST', '/api/reports', { messageId: msg.id, reason: 'bậy' }, tn)).status === 400, 'lý do không hợp lệ -> từ chối');
const rep = await call('POST', '/api/reports', { messageId: msg.id, reason: 'scam', note: 'đòi chuyển tiền', content: msg.body }, tn);
ok(rep.id > 0, 'nạn nhân báo cáo tin kèm nội dung');

console.log('2) Quyền quản trị');
ok((await call('GET', '/api/admin/stats', null, tq)).status === 403, 'chưa cấp quyền -> 403');
spawnSync(process.execPath, ['scripts/make-admin.js', 'quantri'], { cwd: root, env: process.env });
const st = await call('GET', '/api/admin/stats', null, tq);
ok(st.status === 200 && st.reportsOpen >= 1 && st.users >= 4 && Array.isArray(st.perDay), 'cấp quyền bằng make-admin -> xem được thống kê');
const list = (await call('GET', '/api/admin/reports?status=open', null, tq)).reports;
const r0 = list.find((r) => r.id === rep.id);
ok(r0 && r0.target.username === 'xau' && r0.reporter === 'nannhan' && r0.content === msg.body && r0.reasonLabel, 'danh sách báo cáo: người bị báo cáo, người báo, nội dung kèm');

console.log('3) Gỡ tin');
ok((await call('POST', `/api/admin/messages/${msg.id}/remove`, {}, tn)).status === 403, 'người thường không gỡ được');
ok((await call('POST', `/api/admin/messages/${msg.id}/remove`, {}, tq)).ok, 'quản trị viên gỡ tin');
const upd = (await wait(wn, (m) => m.type === 'message:update')).message;
ok(upd.recalled && JSON.parse(upd.body).removedByAdmin, 'mọi thiết bị nhận "đã bị gỡ", không còn nội dung');
ok((await call('POST', `/api/admin/reports/${rep.id}`, { status: 'resolved', note: 'đã gỡ' }, tq)).ok, 'đánh dấu đã xử lý');
ok((await call('GET', '/api/admin/stats', null, tq)).reportsOpen === st.reportsOpen - 1, 'số báo cáo chờ giảm');

console.log('4) Khóa tài khoản');
const xid = (await call('GET', '/api/admin/users?q=xau', null, tq)).users.find((u) => u.username === 'xau').id;
const closed = new Promise((res) => wx.on('close', (c) => res(c)));
ok((await call('POST', `/api/admin/users/${xid}/ban`, { banned: true, reason: 'lừa đảo' }, tq)).ok, 'khóa tài khoản');
ok(await Promise.race([closed, sleep(2000).then(() => 'timeout')]) === 4401, 'đang online -> bị đăng xuất ngay (4401)');
const lb = await call('POST', '/api/login', { username: 'xau', password: '123456' });
ok(lb.status === 403 && /bị khóa: lừa đảo/.test(lb.error), 'đăng nhập bị từ chối kèm lý do');
ok((await call('GET', '/api/me/security', null, tx)).status === 401, 'token cũ hết hiệu lực');
await call('POST', `/api/admin/users/${xid}/ban`, { banned: false }, tq);
ok(!!(await call('POST', '/api/login', { username: 'xau', password: '123456' })).token, 'mở khóa -> đăng nhập lại được');
const me = (await call('GET', '/api/admin/users?q=quantri', null, tq)).users[0];
ok((await call('POST', `/api/admin/users/${me.id}/ban`, { banned: true }, tq)).status === 400, 'không tự khóa chính mình');

console.log('5) Trang quản trị');
const page = await fetch(base + '/admin/');
ok(page.status === 200 && (await page.text()).includes('ReaChat Admin'), '/admin phục vụ trang giao diện');

console.log('Kiểm duyệt + nhật ký');
{
  const call = (m, p, b, t) => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
  const tq = (await call('POST', '/api/login', { username: 'quantri', password: '123456' })).token;
  ok((await call('POST', '/api/admin/moderation', { blockedWords: 'cá độ\nlừa đảo', blockedDomains: 'trang-xau.com' }, tq)).blockedWords.includes('cá độ'), 'lưu từ cấm + tên miền chặn');
  const tn = (await call('POST', '/api/login', { username: 'nam', password: '123456' })).token;
  const bad = await call('POST', '/api/me/profile', { displayName: 'Chuyên CA DO bóng đá' }, tn);
  ok(bad.status === 400 && /cá độ|ca do/.test(bad.error), 'tên hiển thị chứa từ cấm (không dấu, chữ hoa) -> từ chối');
  ok((await call('POST', '/api/me/profile', { displayName: 'Cao Độ' }, tn)).status === 200, 'không khớp nhầm từ khác');
  ok((await call('POST', '/api/me/status', { text: 'Xem https://www.trang-xau.com/khuyen-mai' }, tn)).status === 400, 'liên kết tới tên miền bị chặn (cả tên miền con) -> từ chối');
  const log = await call('GET', '/api/admin/audit', null, tq);
  ok(log.items?.some((a) => a.action === 'sửa danh sách kiểm duyệt' && a.admin === 'quantri'), 'nhật ký ghi thao tác quản trị');
  ok((await call('GET', '/api/admin/audit', null, tn)).status === 403, 'người thường không xem được nhật ký');
  await call('POST', '/api/admin/moderation', { blockedWords: '', blockedDomains: '' }, tq);
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

// Test link mời vào nhóm: chỉ trưởng nhóm tạo/thu hồi, xem trước, tham gia, mã cũ hết hiệu lực.
import WebSocket from 'ws';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const login = async (u) => { let r = await post('/api/login', { username: u, password: '123456' }); if (!r.token) r = await post('/api/register', { username: u, password: '123456' }); return r.token; };
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
const send = (ws, o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (ws, pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = ws.inbox.findIndex(pred); if (i >= 0) return ws.inbox.splice(i, 1)[0]; await sleep(30); } throw new Error('timeout chờ sự kiện'); };
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const [wo, wm, wg, wx] = await Promise.all(['chunhom', 'thanhvien', 'khach', 'khach2'].map(async (u) => open(await login(u))));
for (const w of [wo, wm, wg, wx]) await wait(w, (m) => m.type === 'ready');
send(wo, { type: 'group:create', title: 'Nhóm có link', members: ['thanhvien'] });
const conv = (await wait(wo, (m) => m.type === 'conversation:new')).conversation.id;

console.log('1) Tạo link');
send(wm, { type: 'invite:create', conversationId: conv });
ok(/Chỉ trưởng nhóm/.test((await wait(wm, (m) => m.type === 'error')).error), 'thành viên thường không tạo được');
send(wo, { type: 'invite:create', conversationId: conv });
const inv = await wait(wo, (m) => m.type === 'invite');
ok(/^[a-z0-9]{10}$/.test(inv.code) && inv.expiresAt > Date.now() + 6 * 86400000, 'trưởng nhóm tạo được mã, hạn 7 ngày');

console.log('2) Xem trước + tham gia');
send(wg, { type: 'invite:preview', code: inv.code });
const pv = await wait(wg, (m) => m.type === 'invite:preview');
ok(pv.valid && pv.title === 'Nhóm có link' && pv.memberCount === 2 && pv.by === 'chunhom' && !pv.already, 'xem trước: tên, số thành viên, người tạo');
send(wg, { type: 'invite:join', code: inv.code.toUpperCase() });
ok((await wait(wg, (m) => m.type === 'invite:joined')).conversationId === conv, 'tham gia được (mã không phân biệt hoa thường)');
const up = await wait(wo, (m) => m.type === 'conversation:update');
ok(up.via === 'invite' && up.added[0] === 'khach' && up.conversation.members.length === 3, 'trưởng nhóm nhận cập nhật via=invite (để chia khóa)');
ok(/qua link mời/.test((await wait(wm, (m) => m.type === 'message' && m.message.type === 'system')).message.body), 'tin hệ thống báo người mới');

console.log('3) Tạo mới / thu hồi');
send(wo, { type: 'invite:create', conversationId: conv });
const inv2 = await wait(wo, (m) => m.type === 'invite');
send(wx, { type: 'invite:preview', code: inv.code });
ok((await wait(wx, (m) => m.type === 'invite:preview')).valid === false, 'tạo link mới -> link cũ hết hiệu lực');
send(wo, { type: 'invite:revoke', conversationId: conv });
ok((await wait(wo, (m) => m.type === 'invite')).code === null, 'thu hồi -> không còn link');
send(wx, { type: 'invite:join', code: inv2.code });
ok(/không hợp lệ/.test((await wait(wx, (m) => m.type === 'error')).error), 'link đã thu hồi không vào được');
send(wx, { type: 'invite:preview', code: 'khongtontai' });
ok((await wait(wx, (m) => m.type === 'invite:preview')).valid === false, 'mã bịa -> không hợp lệ');

console.log('4) Phòng họp (link reachat://meet/<mã>)');
send(wo, { type: 'meet:create', title: 'Họp giao ban' });
const mc = await wait(wo, (m) => m.type === 'meet:created');
const mconv = (await wait(wo, (m) => m.type === 'conversation:new' && m.conversation.id === mc.conversationId)).conversation;
ok(/^[a-z0-9]{10}$/.test(mc.code) && mconv.meeting === true && mconv.title === 'Họp giao ban', 'tạo phòng họp + mã mời');
send(wo, { type: 'gcall:join', conversationId: mc.conversationId, video: true });
await wait(wo, (m) => m.type === 'gcall:joined');
send(wx, { type: 'invite:preview', code: mc.code });
const mp = await wait(wx, (m) => m.type === 'invite:preview');
ok(mp.valid && mp.meeting === true && mp.inCall === 1 && !mp.already, 'xem trước: là phòng họp, 1 người đang trong cuộc gọi');
send(wx, { type: 'invite:join', code: mc.code });
await wait(wx, (m) => m.type === 'invite:joined');
send(wx, { type: 'gcall:join', conversationId: mc.conversationId, video: true });
const gj = await wait(wx, (m) => m.type === 'gcall:joined');
ok(gj.peers.length === 1 && gj.peers[0].username === 'chunhom', 'người có link vào được cuộc gọi của phòng');
ok(!!(await wait(wo, (m) => m.type === 'message' && m.message.type === 'system' && /đã vào phòng họp/.test(m.message.body))), 'tin hệ thống "đã vào phòng họp"');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

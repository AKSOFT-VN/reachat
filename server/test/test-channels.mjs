// Test kênh công khai: tạo, tìm, theo dõi, chỉ chủ kênh đăng, riêng tư người theo dõi, bỏ theo dõi lặng lẽ.
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

const [wo, wa, wb] = await Promise.all(['chukenh', 'docgia1', 'docgia2'].map(async (u) => open(await login(u))));
for (const w of [wo, wa, wb]) await wait(w, (m) => m.type === 'ready');

console.log('1) Tạo kênh');
send(wo, { type: 'channel:create', title: 'Tin công nghệ', handle: 'x' });
ok(/Mã kênh/.test((await wait(wo, (m) => m.type === 'error')).error), 'mã kênh không hợp lệ -> từ chối');
send(wo, { type: 'channel:create', title: 'Tin công nghệ', handle: '@TinCongNghe', description: 'Cập nhật mỗi ngày' });
const cn = (await wait(wo, (m) => m.type === 'conversation:new')).conversation;
ok(cn.channel?.handle === 'tincongnghe' && cn.channel.subscribers === 1 && cn.ownerId, 'tạo kênh @tincongnghe');
send(wa, { type: 'channel:create', title: 'Trùng', handle: 'tincongnghe' });
ok(/đã có/.test((await wait(wa, (m) => m.type === 'error')).error), 'mã kênh trùng -> từ chối');

console.log('2) Tìm + theo dõi');
send(wa, { type: 'channel:search', q: 'công nghệ' });
const found = (await wait(wa, (m) => m.type === 'channel:results')).items;
ok(found.some((c) => c.id === cn.id && !c.joined && c.owner === 'chukenh'), 'tìm thấy theo tên');
send(wa, { type: 'channel:join', id: cn.id });
const joined = await wait(wa, (m) => m.type === 'conversation:new' && m.conversation.id === cn.id);
ok(joined.conversation.members.length === 1 && joined.conversation.channel.subscribers === 2, 'theo dõi: chỉ thấy chủ kênh, không thấy danh sách người theo dõi');
send(wb, { type: 'channel:join', handle: '@tincongnghe' });
ok((await wait(wb, (m) => m.type === 'channel:joined')).conversationId === cn.id, 'theo dõi bằng @mã kênh');
await sleep(200);
ok(!wa.inbox.some((m) => m.type === 'conversation:update' || (m.type === 'message' && m.message.type === 'system')), 'người theo dõi khác không bị báo ai vừa vào');

console.log('3) Đăng bài');
send(wa, { type: 'send', conversationId: cn.id, body: 'spam', ref: 'x' });
ok(/Chỉ chủ kênh/.test((await wait(wa, (m) => m.type === 'error')).error), 'người theo dõi không đăng được');
send(wo, { type: 'send', conversationId: cn.id, body: 'bí mật', enc: true, ref: 'e' });
ok(/không dùng mã hóa/.test((await wait(wo, (m) => m.type === 'error')).error), 'kênh từ chối tin mã hóa');
send(wo, { type: 'send', conversationId: cn.id, body: 'Bài đăng số 1', ref: 'p1' });
const got = await wait(wb, (m) => m.type === 'message' && m.message.body === 'Bài đăng số 1');
ok(got.message.conversationId === cn.id && !got.message.enc, 'người theo dõi nhận bài đăng');
send(wa, { type: 'react', messageId: got.message.id, emoji: '👍' });
ok(!!(await wait(wo, (m) => m.type === 'message:update' && m.message.reactions?.length)), 'người theo dõi thả cảm xúc được');
send(wa, { type: 'read', conversationId: cn.id, seq: got.message.seq });
send(wa, { type: 'typing', conversationId: cn.id, isTyping: true });
await sleep(300);
ok(!wo.inbox.some((m) => (m.type === 'receipt' && m.state === 'read') || m.type === 'typing'), 'không lộ ai đã xem / đang gõ');

console.log('4) Giới hạn tính năng nhóm');
send(wo, { type: 'gcall:join', conversationId: cn.id });
ok(/không có cuộc gọi/.test((await wait(wo, (m) => m.type === 'error')).error), 'kênh không có gọi nhóm');
send(wo, { type: 'invite:create', conversationId: cn.id });
ok(/reachat:\/\/c\/tincongnghe/.test((await wait(wo, (m) => m.type === 'error')).error), 'kênh dùng link reachat://c/<mã>');
send(wo, { type: 'group:add', conversationId: cn.id, members: ['docgia2'] });
ok(/tự theo dõi/.test((await wait(wo, (m) => m.type === 'error')).error), 'không thêm người thủ công');

console.log('5) Bỏ theo dõi');
send(wb, { type: 'group:leave', conversationId: cn.id });
const rm = await wait(wb, (m) => m.type === 'conversation:removed');
ok(rm.channel === true, 'bỏ theo dõi thành công');
await sleep(300);
ok(!wa.inbox.some((m) => m.type === 'message' && m.message.type === 'system'), 'không có tin hệ thống "đã rời" gửi cả kênh');
send(wo, { type: 'group:leave', conversationId: cn.id });
ok(/Chủ kênh không rời/.test((await wait(wo, (m) => m.type === 'error')).error), 'chủ kênh không rời kênh của mình');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

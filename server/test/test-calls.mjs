// Test lịch sử cuộc gọi + định tuyến tín hiệu đa thiết bị. Chạy với server test: PORT=4100 RING_TIMEOUT_MS=1500.
import WebSocket from 'ws';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const login = async (u) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: '123456' }) })).json()).token;
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
const send = (ws, o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (ws, pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = ws.inbox.findIndex(pred); if (i >= 0) return ws.inbox.splice(i, 1)[0]; await sleep(30); } throw new Error('timeout chờ sự kiện'); };
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
const sig = (ws, to, data) => send(ws, { type: 'signal', to, data });
const callMsg = (ws, id) => wait(ws, (m) => m.type === 'message' && m.message.type === 'call' && JSON.parse(m.message.body).callId === id).then((m) => ({ ...m.message, info: JSON.parse(m.message.body) }));

const nam = await login('nam'), binh = await login('binh');
const wn = await open(nam);
await wait(wn, (m) => m.type === 'ready');

console.log('1) Gọi người đang offline');
sig(wn, 'binh', { callId: 'c1', kind: 'offer', video: false, sdp: 'x' });
const r1 = await wait(wn, (m) => m.type === 'signal' && m.data.callId === 'c1');
ok(r1.data.kind === 'reject' && r1.data.reason === 'offline', 'người gọi được báo "offline" ngay');
const l1 = await callMsg(wn, 'c1');
ok(l1.info.status === 'missed' && l1.info.by === 'nam' && !l1.enc, 'ghi cuộc gọi nhỡ vào hội thoại');

console.log('2) Hai thiết bị cùng đổ chuông, một máy bắt -> máy kia dừng, tín hiệu chỉ tới máy đã bắt');
const wb1 = await open(binh), wb2 = await open(binh);
await wait(wb1, (m) => m.type === 'ready'); await wait(wb2, (m) => m.type === 'ready');
sig(wn, 'binh', { callId: 'c2', kind: 'offer', video: true, sdp: 'o' });
ok(!!(await wait(wb1, (m) => m.type === 'signal' && m.data.kind === 'offer')) && !!(await wait(wb2, (m) => m.type === 'signal' && m.data.kind === 'offer')), 'cả 2 thiết bị nhận offer');
sig(wb1, 'nam', { callId: 'c2', kind: 'answer', sdp: 'a' });
ok((await wait(wn, (m) => m.type === 'signal' && m.data.kind === 'answer')).from === 'binh', 'người gọi nhận answer');
const stop = await wait(wb2, (m) => m.type === 'signal' && m.data.callId === 'c2');
ok(stop.data.kind === 'hangup' && stop.data.reason === 'elsewhere', 'thiết bị 2 nhận "đã bắt máy ở nơi khác"');
sig(wn, 'binh', { callId: 'c2', kind: 'ice', candidate: { c: 1 } });
await wait(wb1, (m) => m.type === 'signal' && m.data.kind === 'ice');
await sleep(200);
ok(!wb2.inbox.some((m) => m.type === 'signal' && m.data.kind === 'ice'), 'ICE chỉ tới thiết bị đã bắt máy');
await sleep(1100);
sig(wb1, 'nam', { callId: 'c2', kind: 'hangup' });
await wait(wn, (m) => m.type === 'signal' && m.data.kind === 'hangup');
const l2 = await callMsg(wb2, 'c2');
ok(l2.info.status === 'answered' && l2.info.video === true && l2.info.duration >= 1, `ghi "đã nghe" + thời lượng (${l2.info.duration}s), mọi thiết bị đều thấy`);

console.log('3) Từ chối / hủy / không trả lời');
sig(wn, 'binh', { callId: 'c3', kind: 'offer', sdp: 'o' });
await wait(wb1, (m) => m.type === 'signal' && m.data.callId === 'c3');
sig(wb1, 'nam', { callId: 'c3', kind: 'reject' });
ok((await callMsg(wn, 'c3')).info.status === 'declined', 'người nhận từ chối -> declined');
sig(wn, 'binh', { callId: 'c4', kind: 'offer', sdp: 'o' });
await wait(wb1, (m) => m.type === 'signal' && m.data.callId === 'c4');
sig(wn, 'binh', { callId: 'c4', kind: 'hangup' });
ok((await callMsg(wb1, 'c4')).info.status === 'cancelled', 'người gọi hủy trước khi bắt -> cancelled (bên nhận hiện cuộc gọi nhỡ)');
sig(wn, 'binh', { callId: 'c5', kind: 'offer', sdp: 'o' });
const t1 = await wait(wb1, (m) => m.type === 'signal' && m.data.callId === 'c5' && m.data.kind === 'hangup', 4000);
const t2 = await wait(wn, (m) => m.type === 'signal' && m.data.callId === 'c5', 4000);
ok(t1.data.reason === 'timeout' && t2.data.reason === 'timeout', 'hết giờ đổ chuông -> cả hai bên dừng');
ok((await callMsg(wn, 'c5')).info.status === 'missed', 'hết giờ -> missed');

console.log('4) Mất kết nối giữa cuộc gọi');
sig(wn, 'binh', { callId: 'c6', kind: 'offer', sdp: 'o' });
await wait(wb2, (m) => m.type === 'signal' && m.data.callId === 'c6');
sig(wb2, 'nam', { callId: 'c6', kind: 'answer', sdp: 'a' });
await wait(wn, (m) => m.type === 'signal' && m.data.kind === 'answer' && m.data.callId === 'c6');
wb2.close();
const d = await wait(wn, (m) => m.type === 'signal' && m.data.callId === 'c6' && m.data.kind === 'hangup');
ok(d.data.reason === 'dropped', 'thiết bị đang nghe đóng app -> người gọi được báo dropped');
ok((await callMsg(wn, 'c6')).info.status === 'answered', 'vẫn ghi là cuộc gọi đã nghe');

console.log('5) Bị chặn: không đổ chuông, không ghi lịch sử');
await fetch(base + '/api/block', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + binh }, body: JSON.stringify({ username: 'nam' }) });
sig(wn, 'binh', { callId: 'c7', kind: 'offer', sdp: 'o' });
ok((await wait(wn, (m) => m.type === 'signal' && m.data.callId === 'c7')).data.reason === 'unavailable', 'người gọi nhận "unavailable"');
await sleep(300);
ok(!wb1.inbox.some((m) => m.type === 'signal' && m.data.callId === 'c7'), 'người chặn không đổ chuông');
ok(!wn.inbox.some((m) => m.type === 'message' && m.message.type === 'call' && m.message.body.includes('c7')), 'không ghi lịch sử');
await fetch(base + '/api/unblock', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + binh }, body: JSON.stringify({ username: 'nam' }) });

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

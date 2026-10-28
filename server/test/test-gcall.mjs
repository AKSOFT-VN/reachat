// Test cuộc gọi nhóm (phòng + định tuyến tín hiệu theo pid). Chạy với server test: PORT=4100 GCALL_MAX=3.
import WebSocket from 'ws';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const post = (p, b, t) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b) }).then((r) => r.json());
const login = async (u) => {
  let r = await post('/api/login', { username: u, password: '123456' });
  if (!r.token) r = await post('/api/register', { username: u, password: '123456', displayName: u });
  return r.token;
};
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
const send = (ws, o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (ws, pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = ws.inbox.findIndex(pred); if (i >= 0) return ws.inbox.splice(i, 1)[0]; await sleep(30); } throw new Error('timeout chờ sự kiện'); };
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const [tn, tb, tc, td] = await Promise.all(['nam', 'binh', 'chi', 'dung'].map(login));
const [wn, wb, wc, wd] = await Promise.all([tn, tb, tc, td].map(open));
for (const w of [wn, wb, wc, wd]) await wait(w, (m) => m.type === 'ready');
send(wn, { type: 'group:create', title: 'Gọi nhóm test', members: ['binh', 'chi', 'dung'] });
const conv = (await wait(wn, (m) => m.type === 'conversation:new')).conversation.id;
const outsider = await login('eman'); const we = await open(outsider); await wait(we, (m) => m.type === 'ready');

console.log('1) Mở phòng -> các thành viên đổ chuông');
send(wn, { type: 'gcall:join', conversationId: conv, video: true });
const jn = await wait(wn, (m) => m.type === 'gcall:joined');
ok(jn.peers.length === 0 && jn.pid && jn.video, 'người mở phòng vào đầu tiên, có pid');
const ring = await wait(wb, (m) => m.type === 'gcall:active' && m.ring);
ok(ring.by === 'nam' && ring.participants.join() === 'nam', 'thành viên nhận chuông (ring) kèm người đang trong phòng');

console.log('2) Người sau vào nhận danh sách peer, người cũ được báo');
send(wb, { type: 'gcall:join', conversationId: conv });
const jb = await wait(wb, (m) => m.type === 'gcall:joined');
ok(jb.callId === jn.callId && jb.peers.length === 1 && jb.peers[0].username === 'nam', 'binh thấy nam trong phòng (cùng callId)');
const pj = await wait(wn, (m) => m.type === 'gcall:peer' && m.joined);
ok(pj.pid === jb.pid && pj.username === 'binh', 'nam được báo binh vào');
const act = await wait(wd, (m) => m.type === 'gcall:active' && m.participants.length === 2);
ok(!act.ring, 'thành viên khác thấy phòng đang có 2 người (không đổ chuông lại)');

console.log('3) Tín hiệu theo pid, chỉ trong phòng');
send(wb, { type: 'gsignal', pid: jn.pid, data: { kind: 'offer', sdp: 'o' } });
const gs = await wait(wn, (m) => m.type === 'gsignal');
ok(gs.pid === jb.pid && gs.username === 'binh' && gs.data.kind === 'offer', 'nam nhận offer từ đúng pid của binh');
send(wc, { type: 'gsignal', pid: jn.pid, data: { kind: 'offer', sdp: 'x' } });
send(we, { type: 'gcall:join', conversationId: conv });
await sleep(300);
ok(!wn.inbox.some((m) => m.type === 'gsignal'), 'người ngoài phòng không gửi được tín hiệu');
ok(we.inbox.some((m) => m.type === 'error') && !we.inbox.some((m) => m.type === 'gcall:joined'), 'người ngoài nhóm không vào được phòng');

console.log('4) Giới hạn số người');
send(wc, { type: 'gcall:join', conversationId: conv });
await wait(wc, (m) => m.type === 'gcall:joined');
send(wd, { type: 'gcall:join', conversationId: conv });
const full = await wait(wd, (m) => m.type === 'error');
ok(/đủ 3/.test(full.error), 'người thứ 4 bị từ chối khi GCALL_MAX=3');

console.log('5) Cùng tài khoản vào từ thiết bị khác -> thiết bị cũ rời');
const wb2 = await open(tb); await wait(wb2, (m) => m.type === 'ready');
send(wb2, { type: 'gcall:join', conversationId: conv });
ok((await wait(wb, (m) => m.type === 'gcall:ended')).reason === 'elsewhere', 'thiết bị cũ của binh nhận "elsewhere"');
const jb2 = await wait(wb2, (m) => m.type === 'gcall:joined');
ok(jb2.peers.length === 2 && !jb2.peers.some((p) => p.username === 'binh'), 'thiết bị mới thấy 2 người còn lại, không thấy chính mình');

console.log('6) Bị mời ra khỏi nhóm -> rời phòng; phòng trống -> ghi lịch sử');
send(wn, { type: 'group:kick', conversationId: conv, username: 'chi' });
ok((await wait(wc, (m) => m.type === 'gcall:ended')).reason === 'removed', 'chi bị mời ra -> rời cuộc gọi');
await sleep(1100);
send(wb2, { type: 'gcall:leave' });
wn.close();
const log = await wait(wd, (m) => m.type === 'message' && m.message.type === 'call');
const info = JSON.parse(log.message.body);
ok(info.group && info.status === 'answered' && info.peak === 3 && info.by === 'nam' && info.duration >= 1, `ghi lịch sử nhóm: đỉnh ${info.peak} người, ${info.duration}s`);
const end = await wait(wd, (m) => m.type === 'gcall:active' && m.participants.length === 0);
ok(end.callId === null, 'phòng kết thúc được báo cho thành viên');

console.log('7) Mở phòng rồi rời ngay -> cuộc gọi nhỡ');
send(wd, { type: 'gcall:join', conversationId: conv });
const j7 = await wait(wd, (m) => m.type === 'gcall:joined');
send(wd, { type: 'gcall:leave' });
const l2 = await wait(wb2, (m) => m.type === 'message' && m.message.type === 'call' && m.message.body.includes(j7.callId));
ok(JSON.parse(l2.message.body).status === 'missed', 'không ai vào -> missed');

console.log('8) Vào lại sau rớt mạng khi phòng đã kết thúc');
await sleep(200); wb2.inbox.length = 0;
send(wd, { type: 'gcall:join', conversationId: conv, rejoin: true });
ok((await wait(wd, (m) => m.type === 'gcall:ended')).reason === 'over', 'nhận "over", không mở phòng mới');
await sleep(300);
ok(!wb2.inbox.some((m) => m.type === 'gcall:active' && m.ring), 'không ai bị đổ chuông');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

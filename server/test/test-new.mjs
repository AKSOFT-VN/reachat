// Test các tính năng server mới: đồng bộ theo lô + thay đổi (mod_seq), lịch sử, tự hủy có xác nhận,
// gửi có điều kiện, cấp ICE/TURN. Chạy với server test: PORT=4100 (DB riêng).
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

const nam = await login('nam'), binh = await login('binh');
const wn = await open(nam);
await wait(wn, (m) => m.type === 'ready');

console.log('1) Đồng bộ theo lô (>500 tin)');
for (let i = 0; i < 620; i++) send(wn, { type: 'send', to: 'binh', body: 'm' + i, ref: 'r' + i });
for (let i = 0; i < 620; i++) await wait(wn, (m) => m.type === 'ack', 8000);
const wb = await open(binh);
send(wb, { type: 'sync', sinceSeq: 0 });
const b1 = await wait(wb, (m) => m.type === 'sync:batch');
ok(b1.messages.length === 500 && b1.more === true, `lô 1: 500 tin, more=true (${b1.messages.length}, ${b1.more})`);
const last1 = Math.max(...b1.messages.map((m) => m.seq));
send(wb, { type: 'sync', sinceSeq: last1, sinceMod: 0 });
const b2 = await wait(wb, (m) => m.type === 'sync:batch');
ok(b2.messages.filter((m) => m.seq > last1).length >= 120 && b2.more === false, `lô 2: phần còn lại (${b2.messages.length}), more=false`);
const maxSeq = Math.max(...b2.messages.map((m) => m.seq));
const maxMod = Math.max(0, ...[...b1.messages, ...b2.messages].map((m) => m.modSeq || 0));

console.log('2) Thay đổi khi offline (sửa/thu hồi) được đồng bộ');
wb.close(); await sleep(200);
const victim = b2.messages.find((m) => m.body === 'm600');
const edited = b2.messages.find((m) => m.body === 'm601');
send(wn, { type: 'recall', messageId: victim.id });
send(wn, { type: 'edit', messageId: edited.id, body: 'đã sửa', enc: false });
await sleep(300);
const wb2 = await open(binh);
send(wb2, { type: 'sync', sinceSeq: maxSeq, sinceMod: maxMod });
const b3 = await wait(wb2, (m) => m.type === 'sync:batch');
ok(b3.messages.some((m) => m.id === victim.id && m.recalled), 'thiết bị offline nhận được thu hồi');
ok(b3.messages.some((m) => m.id === edited.id && m.body === 'đã sửa' && m.editedAt), 'thiết bị offline nhận được bản sửa');

console.log('3) Phân trang lịch sử từ server');
const conv = victim.conversationId;
send(wb2, { type: 'history', conversationId: conv, beforeSeq: 0, limit: 50 });
const h1 = await wait(wb2, (m) => m.type === 'history');
ok(h1.messages.length === 50 && h1.hasMore, 'trang 1: 50 tin mới nhất, hasMore');
const minSeq = h1.messages[0].seq;
send(wb2, { type: 'history', conversationId: conv, beforeSeq: minSeq, limit: 50 });
const h2 = await wait(wb2, (m) => m.type === 'history');
ok(h2.messages.length === 50 && h2.messages.every((m) => m.seq < minSeq) && h2.messages[49].seq < minSeq, 'trang 2: cũ hơn trang 1, tăng dần');
send(wb2, { type: 'history', conversationId: 'dm_khong_phai_cua_toi', beforeSeq: 0 });
await sleep(300);
ok(!wb2.inbox.some((m) => m.type === 'history'), 'không lấy được lịch sử hội thoại không thuộc về mình');

console.log('4) Tin tự hủy có xác nhận');
const up = await (await fetch(base + '/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + nam }, body: JSON.stringify({ name: 'a.bin', mime: 'application/octet-stream', dataB64: Buffer.from('bimat').toString('base64') }) })).json();
send(wn, { type: 'send', to: 'binh', body: JSON.stringify({ fileId: up.file.id, name: 'a.bin' }), msgType: 'file', ttl: 1500, ref: 'ttl1' });
const ttlAck = await wait(wn, (m) => m.type === 'ack' && m.ref === 'ttl1');
send(wn, { type: 'copy:put', messageId: ttlAck.message.id, data: 'banSao' });
send(wn, { type: 'react', messageId: ttlAck.message.id, emoji: '❤️' });
const destroyed = await wait(wb2, (m) => m.type === 'message:update' && m.message.id === ttlAck.message.id && m.message.recalled, 6000);
ok(destroyed.message.body === '' && destroyed.message.reactions.length === 0, 'hết hạn: nội dung + cảm xúc bị xóa');
const fr = await fetch(base + '/api/files/' + up.file.id, { headers: { Authorization: 'Bearer ' + nam } });
ok(fr.status === 404, 'file đính kèm bị xóa khỏi server (404)');
send(wn, { type: 'copy:get', ids: [ttlAck.message.id] });
const cps = await wait(wn, (m) => m.type === 'copies');
ok(cps.items.length === 0, 'bản sao đa thiết bị bị xóa');
send(wb2, { type: 'destruct:ack', ids: [ttlAck.message.id], deviceId: 'binh-pc' });
const acked = await wait(wb2, (m) => m.type === 'destruct:acked');
const seen = await wait(wn, (m) => m.type === 'destruct:acks' && m.messageId === ttlAck.message.id);
ok(acked.ids.length === 1 && seen.acks.some((a) => a.username === 'binh' && a.devices === 1), 'người gửi nhận xác nhận "binh đã xóa (1 thiết bị)"');
send(wb2, { type: 'destruct:ack', ids: [victim.id], deviceId: 'x' });   // tin thường bị thu hồi -> không nhận
const acked2 = await wait(wb2, (m) => m.type === 'destruct:acked');
ok(acked2.ids.length === 0, 'không nhận xác nhận cho tin không tự hủy');

console.log('5) Gửi có điều kiện');
wb2.close(); await sleep(300);
send(wn, { type: 'schedule', to: 'binh', body: 'khi online', sendAt: Date.now() + 3600e3, cond: { kind: 'online' } });
const c1 = await wait(wn, (m) => m.type === 'scheduled' && m.action === 'created');
ok(c1.cond === 'online', 'đã hẹn "gửi khi binh online"');
await sleep(300);
ok(!wn.inbox.some((m) => m.type === 'message' && m.message.body === 'khi online'), 'chưa gửi khi binh offline');
const wb3 = await open(binh);
const got = await wait(wb3, (m) => m.type === 'message' && m.message.body === 'khi online');
ok(!!got, 'binh online -> nhận ngay');
await wait(wn, (m) => m.type === 'scheduled' && m.action === 'sent');

send(wn, { type: 'schedule', to: 'binh', body: 'nhắc lại', sendAt: Date.now() + 2500, cond: { kind: 'noreply' } });
await wait(wn, (m) => m.type === 'scheduled' && m.action === 'created');
send(wb3, { type: 'send', to: 'nam', body: 'mình trả lời rồi', ref: 'x' });
const sk = await wait(wn, (m) => m.type === 'scheduled' && (m.action === 'skipped' || m.action === 'sent'), 6000);
ok(sk.action === 'skipped', '"nếu chưa trả lời": binh đã trả lời -> bỏ, không gửi');
send(wn, { type: 'schedule', to: 'binh', body: 'nhắc lần 2', sendAt: Date.now() + 2500, cond: { kind: 'noreply' } });
await wait(wn, (m) => m.type === 'scheduled' && m.action === 'created');
const sk2 = await wait(wn, (m) => m.type === 'scheduled' && (m.action === 'skipped' || m.action === 'sent'), 6000);
ok(sk2.action === 'sent', '"nếu chưa trả lời": im lặng -> gửi');

send(wn, { type: 'send', to: 'binh', body: 'tin trước', ref: 'tp' });
const tp = await wait(wn, (m) => m.type === 'ack' && m.ref === 'tp');
send(wn, { type: 'schedule', to: 'binh', body: 'sau khi xem', sendAt: Date.now() + 3600e3, cond: { kind: 'read' } });
await wait(wn, (m) => m.type === 'scheduled' && m.action === 'created');
await sleep(300);
ok(!wb3.inbox.some((m) => m.type === 'message' && m.message.body === 'sau khi xem'), 'chưa gửi khi binh chưa xem');
send(wb3, { type: 'read', conversationId: conv, seq: tp.message.seq });
ok(!!(await wait(wb3, (m) => m.type === 'message' && m.message.body === 'sau khi xem')), 'binh xem tin trước -> tin sau được gửi');

send(wn, { type: 'schedule', to: 'binh', body: 'hết hạn', sendAt: Date.now() + 2200, cond: { kind: 'read', fallback: 'drop' } });
const exc = await wait(wn, (m) => m.type === 'scheduled' && m.action === 'created');
const ex = await wait(wn, (m) => m.type === 'scheduled' && m.id === exc.id && m.action !== 'created', 6000);
ok(ex.action === 'expired', 'hết hạn chờ, không chọn "vẫn gửi" -> bỏ');

console.log('6) Cấp ICE/TURN');
const ice = await (await fetch(base + '/api/ice', { headers: { Authorization: 'Bearer ' + nam } })).json();
const t = ice.iceServers.find((s) => String(s.urls).includes('turn:'));
ok(!!t && t.username && t.credential, 'có máy chủ TURN + thông tin đăng nhập tạm thời: ' + (t && t.urls));
const ice2 = await (await fetch(base + '/api/ice', { headers: { Authorization: 'Bearer ' + nam } })).json();
ok(ice2.iceServers.at(-1).credential !== t.credential, 'mỗi lần cấp một mật khẩu khác');
ok((await fetch(base + '/api/ice')).status === 401, 'không token -> 401');

console.log(`\nKết quả: ${pass} đạt, ${fail} lỗi`);
process.exit(fail ? 1 : 0);

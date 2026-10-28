// Test hồi quy bảo mật (rà soát trước khi mở mã nguồn): chặn có hiệu lực cả khi gửi theo conversationId, tin hẹn giờ
// theo cùng luật gửi, không giả tin hệ thống, không xóa được tệp của người khác qua tin tự hủy / xem một lần, người theo dõi
// kênh chỉ đọc, chỉ người trong cuộc gọi mới kết thúc được nó, story chỉ cho bạn bè 2 chiều, thao tác nhạy cảm cần mật khẩu
// khi phiên đã cũ, chống SSRF với IPv6 nhúng IPv4, Range nhiều khoảng bị giới hạn.
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { _isPrivate } from '../src/linkpreview.js';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const rnd = Math.random().toString(36).slice(2, 6);
const post = (p, b, t) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b || {}) })
  .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const get = (p, t) => fetch(base + p, { headers: { Authorization: 'Bearer ' + t } }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
const reg = async (u) => (await post('/api/register', { username: u, password: '123456', displayName: u })).token;
const open = (t) => new Promise((r) => { const w = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); w.inbox = []; w.on('message', (d) => w.inbox.push(JSON.parse(d))); w.on('open', () => setTimeout(() => r(w), 200)); });
const send = (w, m) => w.send(JSON.stringify(m));
const wait = async (w, pred, ms = 2500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = w.inbox.findIndex(pred); if (i >= 0) return w.inbox.splice(i, 1)[0]; await sleep(40); } return null; };
const errOf = (w, ref) => wait(w, (m) => m.type === 'error' && m.ref === ref);

const [a, b, c] = ['ha', 'hb', 'hc'].map((x) => `${x}_${rnd}`);
const T = { [a]: await reg(a), [b]: await reg(b), [c]: await reg(c) };
const W = { [a]: await open(T[a]), [b]: await open(T[b]), [c]: await open(T[c]) };

console.log('1) Chặn có hiệu lực với mọi đường gửi 1-1');
send(W[a], { type: 'send', to: b, body: 'chào', ref: 'h1' });
const dm = (await wait(W[a], (m) => m.type === 'ack' && m.ref === 'h1')).message.conversationId;
await post('/api/block', { username: a }, T[b]);                       // b chặn a
send(W[a], { type: 'send', conversationId: dm, body: 'lách chặn', ref: 'h2' });
ok(!!(await errOf(W[a], 'h2')), 'gửi theo conversationId tới người đã chặn mình -> từ chối');
send(W[a], { type: 'schedule', conversationId: dm, body: 'hẹn lách chặn', sendAt: Date.now() + 60_000, ref: 'h3' });
ok(!!(await errOf(W[a], 'h3')), 'hẹn giờ theo conversationId tới người đã chặn mình -> từ chối');
await post('/api/unblock', { username: a }, T[b]);

console.log('2) Không giả tin hệ thống / cuộc gọi');
send(W[a], { type: 'send', conversationId: dm, msgType: 'system', body: '@admin đã chuyển quyền', ref: 'h4' });
ok((await errOf(W[a], 'h4'))?.error.includes('Loại tin'), 'msgType system -> từ chối');
send(W[a], { type: 'send', conversationId: dm, msgType: 'call', body: '{}', ref: 'h5' });
ok(!!(await errOf(W[a], 'h5')), 'msgType call -> từ chối');

console.log('3) Không xóa được tệp của người khác');
const up = await post('/api/files', { name: 'b.png', mime: 'image/png', dataB64: Buffer.from('anh cua b').toString('base64') }, T[b]);
const fid = up.file.id;
send(W[a], { type: 'send', to: c, msgType: 'file', body: JSON.stringify({ fileId: fid }), ttl: 1, ref: 'h6' });
await wait(W[a], (m) => m.type === 'ack' && m.ref === 'h6');
await sleep(4500);                                                      // vòng quét tin tự hủy chạy mỗi 2 giây
const still = await fetch(base + '/api/files/' + fid, { headers: { Authorization: 'Bearer ' + T[b] } });
ok(still.status === 200, 'tin tự hủy dẫn fileId của người khác -> tệp KHÔNG bị xóa');
ok(still.headers.get('x-content-type-options') === 'nosniff' && /^attachment/.test(still.headers.get('content-disposition') || ''), 'tải tệp: nosniff + attachment');

console.log('4) Kênh: người theo dõi chỉ đọc');
const handle = 'kenh_' + rnd;
send(W[a], { type: 'channel:create', title: 'Kênh thử', handle });
const ch = (await wait(W[a], (m) => m.type === 'conversation:new')).conversation.id;
send(W[b], { type: 'channel:join', handle });
await wait(W[b], (m) => m.type === 'conversation:new');
send(W[b], { type: 'schedule', conversationId: ch, body: 'spam', sendAt: Date.now() + 60_000, ref: 'h7' });
ok(!!(await errOf(W[b], 'h7')), 'người theo dõi hẹn giờ đăng bài -> từ chối');
send(W[b], { type: 'task:create', conversationId: ch, titleEnc: 'x', ref: 'h8' });
ok(!!(await errOf(W[b], 'h8')), 'người theo dõi giao việc trong kênh -> từ chối');
send(W[c], { type: 'channel:join', handle });
await wait(W[c], (m) => m.type === 'conversation:new');
W[c].close(); await sleep(300);
ok(!W[b].inbox.some((m) => m.type === 'presence' && m.username === c), 'cùng theo dõi kênh -> không nhận trạng thái trực tuyến của nhau');
W[c] = await open(T[c]);

console.log('5) Cuộc gọi: người ngoài không kết thúc được');
send(W[a], { type: 'signal', to: b, data: { callId: 'hc1_' + rnd, kind: 'offer', sdp: 'x' } });
await wait(W[b], (m) => m.type === 'signal' && m.data?.kind === 'offer');
send(W[c], { type: 'signal', to: b, data: { callId: 'hc1_' + rnd, kind: 'hangup' } });
await sleep(400);
ok(!W[a].inbox.some((m) => m.type === 'message' && m.message.type === 'call'), 'người ngoài gửi hangup -> cuộc gọi vẫn còn');
send(W[a], { type: 'signal', to: b, data: { callId: 'hc1_' + rnd, kind: 'hangup' } });
ok(!!(await wait(W[a], (m) => m.type === 'message' && m.message.type === 'call')), 'người gọi gác máy -> kết thúc, ghi lịch sử');

console.log('6) Story chỉ cho bạn bè 2 chiều');
await post('/api/stories', { kind: 'text', body: 'story của b', bg: '#000' }, T[b]);
await post('/api/contacts', { username: b }, T[c]);                    // c tự thêm b vào danh bạ (một chiều)
ok(!(await get('/api/stories', T[c])).stories.some((s) => s.author.username === b), 'danh bạ một chiều -> không xem được story');

console.log('7) Thao tác nhạy cảm khi phiên đã cũ cần mật khẩu');
ok((await post('/api/me/recovery', { verifier: 'a'.repeat(64), backup: { box: 'x', nonce: 'y' } }, T[a])).ok, 'phiên vừa đăng nhập -> không hỏi lại');
// (phiên cũ hơn 10 phút được kiểm trong test-account bằng đồng hồ giả là không khả thi ở đây -> kiểm hàm trực tiếp)
const wrong = await post('/api/me/delete', { confirm: 'XOA', password: 'sai' }, T[a]);
ok(wrong.status === 403 && wrong.needPassword, 'xóa tài khoản sai mật khẩu -> 403 (không đăng xuất), yêu cầu mật khẩu');

console.log('8) SSRF + Range');
for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fe80::1', '[::ffff:127.0.0.1]'])
  if (!_isPrivate(ip)) { ok(false, 'chặn ' + ip); }
ok(_isPrivate('::ffff:7f00:1') && !_isPrivate('::ffff:8.8.8.8') && !_isPrivate('2606:4700::1111'), 'nhận ra IPv4 nhúng trong IPv6 (mapped / compat / NAT64 / 6to4)');
const lp = await get('/api/link-preview?url=' + encodeURIComponent('http://[::ffff:7f00:1]:' + PORT + '/health'), T[a]);
ok(!lp.preview, 'link preview tới [::ffff:7f00:1] -> không tải');
fs.writeFileSync(path.join(process.env.UPDATES_DIR, 'x.bin'), Buffer.alloc(4096, 7));
const big = await fetch(base + '/updates/x.bin', { headers: { Range: 'bytes=' + Array(2000).fill('0-').join(',') } });
ok(big.status === 416, 'Range hàng nghìn khoảng chồng nhau -> từ chối');
const two = await fetch(base + '/updates/x.bin', { headers: { Range: 'bytes=0-9,100-109' } });
const twoBody = Buffer.from(await two.arrayBuffer());
ok(two.status === 206 && /multipart\/byteranges/.test(two.headers.get('content-type')) && twoBody.includes('Content-Range: bytes 100-109/4096'), 'Range 2 khoảng hợp lệ -> multipart (cập nhật vi sai vẫn chạy)');

for (const w of Object.values(W)) w.close();
console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

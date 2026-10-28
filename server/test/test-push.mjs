// Test thông báo đẩy (Web Push): push service giả (HTTPS cục bộ, chứng chỉ tự ký — server test chạy với
// NODE_TLS_REJECT_UNAUTHORIZED=0) nhận yêu cầu đã ký VAPID + mã hóa aes128gcm.
import WebSocket from 'ws';
import https from 'node:https';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const call = async (method, p, b, t) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const login = async (u) => { let r = await call('POST', '/api/login', { username: u, password: '123456' }); if (!r.token) r = await call('POST', '/api/register', { username: u, password: '123456' }); return r.token; };
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (ws, pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = ws.inbox.findIndex(pred); if (i >= 0) return ws.inbox.splice(i, 1)[0]; await sleep(30); } throw new Error('timeout chờ sự kiện'); };
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

// Push service giả
const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
const hits = []; let reply = 201;
const svc = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => { hits.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = reply; res.end(); });
});
await new Promise((r) => svc.listen(0, r));
const endpoint = `https://localhost:${svc.address().port}/push/abc`;
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const sub = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };

const tr = await login('nhanpush'), ts = await login('guipush');
const ws = await open(ts); await wait(ws, (m) => m.type === 'ready');

console.log('1) Đăng ký');
ok(/^B[A-Za-z0-9_-]{80,}$/.test((await call('GET', '/api/push/key')).publicKey), 'khóa VAPID công khai');
ok((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://khong-an-toan', keys: sub.keys } }, tr)).status === 400, 'endpoint không phải https -> từ chối');
ok((await call('POST', '/api/push/subscribe', { subscription: sub }, tr)).ok, 'lưu đăng ký đẩy');

console.log('2) Đẩy khi offline');
ws.send(JSON.stringify({ type: 'send', to: 'nhanpush', body: '{"dr":1,"ct":"bimat"}', enc: true, ref: 'a' }));
const ack = await wait(ws, (m) => m.type === 'ack');
for (let i = 0; i < 40 && !hits.length; i++) await sleep(100);
const h = hits[0];
ok(!!h && h.path === '/push/abc', 'push service nhận yêu cầu');
ok(h && /^vapid t=.+, k=/.test(h.headers.authorization) && h.headers['content-encoding'] === 'aes128gcm' && Number(h.headers.ttl) > 0, 'ký VAPID + mã hóa aes128gcm');
ok(h && !h.body.includes(Buffer.from('bimat')) && !h.body.includes(Buffer.from('guipush')), 'thân yêu cầu đã mã hóa (không lộ người gửi/nội dung)');

console.log('3) Không đẩy khi đang mở app / hội thoại đã tắt thông báo');
const wr = await open(tr); await wait(wr, (m) => m.type === 'ready');
hits.length = 0;
ws.send(JSON.stringify({ type: 'send', to: 'nhanpush', body: 'x', ref: 'b' }));
await wait(wr, (m) => m.type === 'message'); await sleep(800);
ok(hits.length === 0, 'người nhận đang online -> không đẩy');
wr.close(); await sleep(300);
await call('POST', '/api/push/muted', { endpoint, muted: [ack.message.conversationId] }, tr);
ws.send(JSON.stringify({ type: 'send', to: 'nhanpush', body: 'y', ref: 'c' }));
await sleep(800);
ok(hits.length === 0, 'hội thoại đã tắt thông báo -> không đẩy');
await call('POST', '/api/push/muted', { endpoint, muted: [] }, tr);

console.log('4) Endpoint hết hạn');
reply = 410;
ws.send(JSON.stringify({ type: 'send', to: 'nhanpush', body: 'z', ref: 'd' }));
for (let i = 0; i < 30 && !hits.length; i++) await sleep(100);
await sleep(300); hits.length = 0; reply = 201;
ws.send(JSON.stringify({ type: 'send', to: 'nhanpush', body: 'w', ref: 'e' }));
await sleep(800);
ok(hits.length === 0, '410 Gone -> tự xóa đăng ký, không đẩy nữa');
svc.close();

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

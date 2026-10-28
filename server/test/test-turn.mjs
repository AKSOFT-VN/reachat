// Test TURN Cloudflare chỉ cấp cho cuộc gọi thật: dựng "Cloudflare giả" + server riêng (cổng 4103) với CF_TURN_*.
// Kiểm: không ngữ cảnh / người nhận offline / bị chặn -> không cấp; người gọi + người nghe hợp lệ -> cấp;
// kết thúc cuộc gọi -> thu hồi; xin mà không gọi thật -> tự thu hồi; gọi nhóm; giới hạn số lần cấp mỗi giờ.
import WebSocket from 'ws';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Cloudflare giả ----
let gen = 0; const revoked = new Set();
const cf = http.createServer((req, res) => {
  const m = req.url.match(/\/turn\/keys\/kid\/credentials\/(?:(generate-ice-servers)|([^/]+)\/revoke)$/);
  if (req.headers.authorization !== 'Bearer tok' || !m) { res.writeHead(401).end(); return; }
  if (m[1]) { gen++; res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'cf' + gen, credential: 'x' }] })); return; }
  revoked.add(decodeURIComponent(m[2])); res.writeHead(204).end();
});
await new Promise((r) => cf.listen(4199, r));

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachat-turn-'));
const PORT = '4103', base = `http://localhost:${PORT}`;
const env = { ...process.env, PORT, DB_PATH: path.join(dir, 't.db'), TURN_BUILTIN: '0', VAPID_FILE: path.join(dir, 'v.json'),
  CF_TURN_KEY_ID: 'kid', CF_TURN_API_TOKEN: 'tok', CF_TURN_API_BASE: 'http://localhost:4199/v1', CF_CONFIRM_MS: '1500', CF_GRANTS_PER_HOUR: '6', RING_TIMEOUT_MS: '45000' };
spawnSync(process.execPath, ['src/seed.js'], { cwd: root, env, stdio: 'ignore' });
const srv = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.resume(); srv.stderr.resume();
process.on('exit', () => { try { srv.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/login', { method: 'POST' }); break; } catch { await sleep(200); } }
const login = async (u) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: '123456' }) })).json()).token;
const ice = async (t, q = {}) => (await fetch(base + '/api/ice?' + new URLSearchParams(q), { headers: { Authorization: 'Bearer ' + t } })).json();
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
const send = (ws, m) => ws.send(JSON.stringify(m));
const sig = (ws, to, data) => send(ws, { type: 'signal', to, data });
const wait = async (ws, pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = ws.inbox.find(pred); if (m) return m; await sleep(50); } return null; };
const cfUser = (c) => c.iceServers?.find((s) => s.username)?.username;
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const tn = await login('nam'), tb = await login('binh');
const tc = (await (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'chi', password: '123456' }) })).json()).token;   // người ngoài cuộc, KHÔNG trực tuyến
const wn = await open(tn), wb = await open(tb);
await sleep(300);

console.log('1) Không phải cuộc gọi thật -> không cấp');
ok((await ice(tn)).turn === 'none' && gen === 0, 'không ngữ cảnh (vd. gửi tệp P2P) -> chỉ STUN');
ok(!!tc && (await ice(tn, { callId: 'c_x', peer: 'chi' })).turn === 'none', 'gọi tới người đang offline -> không cấp');
ok((await ice(tn, { callId: 'c_x', peer: 'nam' })).turn === 'none', 'tự gọi mình -> không cấp');
ok((await ice(tc, { callId: 'c_khong_co' })).turn === 'none', 'nghe một cuộc gọi không tồn tại -> không cấp');
ok(gen === 0, 'chưa gọi API Cloudflare lần nào');

console.log('2) Cuộc gọi 1-1 thật');
const a = await ice(tn, { callId: 'c1', peer: 'binh' });
ok(a.turn === 'cloudflare' && !!cfUser(a), 'người gọi được cấp TURN Cloudflare');
ok(!JSON.stringify(a).includes(':53?'), 'đã bỏ URL cổng 53');
ok(cfUser(await ice(tn, { callId: 'c1', peer: 'binh' })) === cfUser(a) && gen === 1, 'xin lại cùng cuộc gọi -> dùng lại, không cấp thêm');
ok((await ice(tc, { callId: 'c1' })).turn === 'none', 'người ngoài không lấy được TURN của cuộc gọi này');
sig(wn, 'binh', { callId: 'c1', kind: 'offer', sdp: 'o' });
await wait(wb, (m) => m.data?.kind === 'offer');
const b = await ice(tb, { callId: 'c1' });
ok(b.turn === 'cloudflare' && cfUser(b) !== cfUser(a), 'người nghe (đang đổ chuông) được cấp bộ riêng');
sig(wb, 'nam', { callId: 'c1', kind: 'answer', sdp: 'a' });
await sleep(2500);
ok(!revoked.has(cfUser(a)), 'cuộc gọi đã bắt máy, đang diễn ra -> không bị thu hồi');
sig(wn, 'binh', { callId: 'c1', kind: 'hangup' });
await sleep(400);
ok(revoked.has(cfUser(a)) && revoked.has(cfUser(b)), 'kết thúc cuộc gọi -> thu hồi trên Cloudflare cả hai bên');

console.log('3) Xin TURN mà không gọi thật');
const fake = await ice(tn, { callId: 'c_gia', peer: 'binh' });
ok(fake.turn === 'cloudflare', 'được cấp tạm');
await sleep(3000);
ok(revoked.has(cfUser(fake)), 'không có cuộc gọi trong thời hạn -> tự thu hồi');

console.log('4) Chặn nhau');
await fetch(base + '/api/block', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tb }, body: JSON.stringify({ username: 'nam' }) });
ok((await ice(tn, { callId: 'c_bl', peer: 'binh' })).turn === 'none', 'đã bị chặn -> không cấp');
await fetch(base + '/api/unblock', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tb }, body: JSON.stringify({ username: 'nam' }) });

console.log('5) Gọi nhóm');
send(wn, { type: 'group:create', title: 'TURN nhóm', members: ['binh'] });
const conv = (await wait(wn, (m) => m.type === 'conversation:new')).conversation.id;
ok((await ice(tc, { group: conv })).turn === 'none', 'không phải thành viên -> không cấp');
const g = await ice(tn, { group: conv });
ok(g.turn === 'cloudflare', 'thành viên được cấp');
send(wn, { type: 'gcall:join', conversationId: conv, video: false });
await wait(wn, (m) => m.type === 'gcall:joined');
send(wb, { type: 'gcall:join', conversationId: conv, video: false });          // cuộc gọi thật = có ít nhất 2 người
await wait(wb, (m) => m.type === 'gcall:joined');
await sleep(2500);
ok(!revoked.has(cfUser(g)), 'đang ở trong phòng -> giữ nguyên');
send(wn, { type: 'gcall:leave' });
await sleep(400);
ok(revoked.has(cfUser(g)), 'rời phòng -> thu hồi');

console.log('6) Giới hạn số lần cấp mỗi giờ');
let last;
for (let i = 0; i < 4; i++) last = await ice(tn, { callId: 'c_r' + i, peer: 'binh' });
ok(last.turn === 'none' && last.turnBlocked === 'rate', 'vượt số lần cấp/giờ -> ngừng cấp');

wn.close(); wb.close(); cf.close();
console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

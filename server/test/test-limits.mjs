// Test chống spam + hạn mức dung lượng với GIỚI HẠN MẶC ĐỊNH: tự dựng server riêng (cổng 4102, DB tạm),
// vì run-all nới giới hạn cho các bộ test khác.
import WebSocket from 'ws';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachat-limits-'));
const PORT = '4102', base = `http://localhost:${PORT}`;
const env = { ...process.env, PORT, DB_PATH: path.join(dir, 't.db'), TURN_BUILTIN: '0', USER_QUOTA_MB: '1', MAX_FILE_MB: '2', GROUP_MAX_MEMBERS: '3', VAPID_FILE: path.join(dir, 'v.json') };
for (const k of Object.keys(env)) if (k.startsWith('RATE_')) delete env[k];
spawnSync(process.execPath, ['src/seed.js'], { cwd: root, env, stdio: 'ignore' });
const srv = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.resume(); srv.stderr.resume();
process.on('exit', () => { try { srv.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/login', { method: 'POST' }); break; } catch { await sleep(200); } }
const call = async (method, p, b, t) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const login = async (u) => (await call('POST', '/api/login', { username: u, password: '123456' })).token;
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const tn = await login('nam'), tb = await login('binh');
const wn = await open(tn), wb = await open(tb);
await sleep(400);

console.log('1) Tin nhắn KHÔNG giới hạn số lượng; chỉ chặn dội gói (tấn công) ở mức kết nối');
for (let i = 0; i < 200; i++) { wn.send(JSON.stringify({ type: 'send', to: 'binh', body: 'tin ' + i, ref: 'r' + i })); if (i % 40 === 39) await sleep(1000); }
await sleep(1500);
const acks = wn.inbox.filter((m) => m.type === 'ack').length;
ok(acks === 200 && !wn.inbox.some((m) => m.rateLimited), `200 tin gửi liên tục đều đi qua, không bị chặn (${acks})`);
ok(wb.inbox.filter((m) => m.type === 'message').length === 200, 'người nhận nhận đủ 200 tin');
const flood = await open(tb);
const fclosed = new Promise((r) => flood.on('close', (c) => r(c)));
for (let i = 0; i < 1500; i++) flood.send(JSON.stringify({ type: 'typing', conversationId: 'x', isTyping: true }));
ok(await Promise.race([fclosed, sleep(4000).then(() => 'open')]) === 4429, 'dội 1.500 gói tức thời -> server đóng kết nối đó (4429)');
wb.inbox.length = 0;
wb.send(JSON.stringify({ type: 'send', to: 'nam', body: 'các kết nối khác vẫn bình thường', ref: 'x' }));
await sleep(400);
ok(wb.inbox.some((m) => m.type === 'ack'), 'kết nối khác của cùng người không bị ảnh hưởng');

console.log('2) Tạo nhóm hàng loạt');
wn.inbox.length = 0;
for (let i = 0; i < 14; i++) wn.send(JSON.stringify({ type: 'group:create', title: 'g' + i, members: ['binh'] }));
await sleep(1200);
ok(wn.inbox.filter((m) => m.type === 'conversation:new').length === 10 && wn.inbox.filter((m) => m.rateLimited).length === 4, 'tối đa 10 nhóm liền, phần dư bị chặn');

console.log('3) Gói WebSocket quá lớn');
const big = await open(tb);
big.on('error', () => {});
const closed = new Promise((r) => big.on('close', (c) => r(c)));
big.send(JSON.stringify({ type: 'typing', conversationId: 'x', pad: 'a'.repeat(1_200_000) }));
{ const c = await Promise.race([closed, sleep(3000).then(() => 'open')]); ok(c === 1009 || c === 1006, 'gói > 1MB -> đóng kết nối (1009; 1006 nếu bị cắt khi client còn đang gửi)'); }

console.log('4) Hạn mức dung lượng (1 MB khi test)');
const up = (kb) => call('POST', '/api/files', { name: 'a.bin', mime: 'application/octet-stream', dataB64: Buffer.alloc(kb * 1024, 7).toString('base64') }, tn);
const u1 = await up(600);
ok(!!u1.file, 'tải 600KB được');
const u2 = await up(600);
ok(u2.status === 413 && /hạn mức/.test(u2.error), 'vượt 1MB -> 413 "vượt hạn mức"');
const st = await call('GET', '/api/me/storage', null, tn);
ok(st.used === 600 * 1024 && st.quota === 1048576, 'xem dung lượng đã dùng / hạn mức');

console.log('5) Dọn tệp mồ côi');
process.env.DB_PATH = env.DB_PATH;
process.env.ORPHAN_HOURS = '0.0001';            // ~0,4 giây
const { sweepOrphans } = await import('../src/limits.js');
const used = (await up(100)).file.id;            // tệp được dùng trong tin
wn.send(JSON.stringify({ type: 'send', to: 'binh', body: JSON.stringify({ fileId: used, name: 'x' }), msgType: 'file', ref: 'f' }));
await sleep(800);
const r = sweepOrphans(path.join(root, 'uploads'));
ok(r.removed === 1, `xóa tệp không tin nào dùng (${r.removed})`);
ok((await fetch(`${base}/api/files/${u1.file.id}`, { headers: { Authorization: 'Bearer ' + tn } })).status === 404, 'tệp mồ côi không còn tải được');
ok((await fetch(`${base}/api/files/${used}`, { headers: { Authorization: 'Bearer ' + tn } })).status === 200, 'tệp đang dùng được giữ');
ok((await call('GET', '/api/me/storage', null, tn)).used === 100 * 1024, 'dung lượng đã dùng giảm tương ứng');

console.log('6) Giới hạn nội dung (test: tệp 2 MB, nhóm 3 người)');
const tc = await login('chi') || (await call('POST', '/api/register', { username: 'chi', password: '123456' })).token;
const upc = (kb) => call('POST', '/api/files', { name: 'b.bin', mime: 'application/octet-stream', dataB64: Buffer.alloc(kb * 1024, 1).toString('base64') }, tc);
const near = await upc(1990);
ok(near.status === 413 && /hạn mức/.test(near.error), 'tệp sát trần (1,99 MB) qua được bước kiểm kích thước base64 (chỉ vướng hạn mức)');
const over = await upc(2600);
ok(over.status === 413 && over.error === 'Tệp vượt 2 MB', 'tệp vượt trần -> báo rõ "Tệp vượt 2 MB"');
const huge = await upc(6000);
ok(huge.status === 413 && huge.error === 'Tệp vượt 2 MB', 'tệp rất lớn (chặn ngay ở thân yêu cầu) -> vẫn báo JSON rõ ràng');
wb.inbox.length = 0;
wb.send(JSON.stringify({ type: 'send', to: 'nam', body: 'x'.repeat(300 * 1024), ref: 'long' }));
await sleep(600);
ok(wb.inbox.some((m) => m.type === 'error' && /Tin nhắn quá dài/.test(m.error)) && wb.readyState === 1, 'tin quá dài -> báo lỗi, KHÔNG đứt kết nối');
wb.send(JSON.stringify({ type: 'group:create', title: 'đông', members: ['nam', 'chi', 'x1'] }));
await sleep(400);
ok(wb.inbox.some((m) => m.type === 'error' && /Nhóm tối đa 3/.test(m.error)), 'tạo nhóm vượt số thành viên -> từ chối');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

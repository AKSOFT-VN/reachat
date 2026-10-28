// Test tải lên THEO KHÚC (tệp không giới hạn kích thước): khúc không theo thứ tự / gửi trùng, tải tiếp,
// quyền sở hữu, hoàn tất, đọc theo Range, tệp chưa xong không cho tải.
import crypto from 'node:crypto';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const login = async (u) => { const p = (b) => fetch(base + '/api/' + b, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: '123456' }) }).then((r) => r.json()); let r = await p('login'); if (!r.token) r = await p('register'); return r.token; };
const H = (t) => ({ Authorization: 'Bearer ' + t });
const json = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const ta = await login('guitepto'), tb = await login('nguoila');
const CS = 4 * 1024 * 1024, N = 6;
const data = crypto.randomBytes(CS * (N - 1) + 1234567);           // ~21,2 MB, khúc cuối lẻ
const chunk = (i) => data.subarray(i * CS, Math.min(data.length, (i + 1) * CS));
const put = (t, id, i, body) => fetch(`${base}/api/files/${id}/chunk/${i}`, { method: 'PUT', headers: { ...H(t), 'Content-Type': 'application/octet-stream' }, body });

console.log('1) Khởi tạo');
ok((await json(await fetch(base + '/api/files/init', { method: 'POST', headers: { ...H(ta), 'Content-Type': 'application/json' }, body: JSON.stringify({ size: data.length, chunkSize: CS, chunks: 3 }) }))).status === 400, 'số khúc không khớp kích thước -> 400');
const init = await json(await fetch(base + '/api/files/init', { method: 'POST', headers: { ...H(ta), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'blob', size: data.length, chunkSize: CS, chunks: N }) }));
ok(!!init.id, 'tạo phiên tải lên');

console.log('2) Gửi khúc');
for (const i of [3, 0, 5, 1]) ok((await put(ta, init.id, i, chunk(i))).ok, `khúc ${i} (không theo thứ tự)`);
ok((await put(ta, init.id, 1, chunk(1))).ok, 'gửi trùng khúc 1 (thử lại) vẫn ổn');
ok((await put(ta, init.id, 2, chunk(2).subarray(10))).status === 400, 'khúc sai kích thước -> 400');
ok((await put(tb, init.id, 2, chunk(2))).status === 404, 'người khác không ghi vào tệp của mình được');
ok((await fetch(`${base}/api/files/${init.id}`, { headers: H(ta) })).status === 409, 'tệp chưa xong -> chưa cho tải (409)');
const parts = await json(await fetch(`${base}/api/files/${init.id}/parts`, { headers: H(ta) }));
ok(JSON.stringify(parts.parts) === '[0,1,3,5]', 'xem khúc đã nhận để tải tiếp');
ok((await json(await fetch(`${base}/api/files/${init.id}/complete`, { method: 'POST', headers: H(ta) }))).status === 400, 'hoàn tất khi còn thiếu khúc -> từ chối');
for (const i of [2, 4]) await put(ta, init.id, i, chunk(i));
const done = await json(await fetch(`${base}/api/files/${init.id}/complete`, { method: 'POST', headers: H(ta) }));
ok(done.file?.size === data.length, 'tải tiếp phần thiếu rồi hoàn tất');

console.log('3) Tải xuống');
const all = Buffer.from(await (await fetch(`${base}/api/files/${init.id}`, { headers: H(tb) })).arrayBuffer());
ok(all.equals(data), 'tải nguyên tệp: đúng từng byte (' + (data.length / 1048576).toFixed(1) + ' MB)');
const r = await fetch(`${base}/api/files/${init.id}`, { headers: { ...H(tb), Range: `bytes=${5 * CS}-${6 * CS - 1}` } });
const part = Buffer.from(await r.arrayBuffer());
ok(r.status === 206 && part.equals(chunk(5)), 'đọc theo Range: khúc cuối (206)');

console.log('4) Gửi trực tiếp (P2P) tới người đang offline');
const { default: WebSocket } = await import('ws');
const ws = await new Promise((r) => { const w = new WebSocket(`ws://localhost:${PORT}/ws?token=` + ta); w.inbox = []; w.on('message', (d) => w.inbox.push(JSON.parse(d))); w.on('open', () => r(w)); });
ws.send(JSON.stringify({ type: 'signal', to: 'nguoila', data: { callId: 'ft_x', kind: 'ft-offer', sealed: 'abc' } }));
await new Promise((r) => setTimeout(r, 600));
const back = ws.inbox.find((m) => m.type === 'signal' && m.data.callId === 'ft_x');
ok(back?.data.kind === 'ft-cancel' && back.data.reason === 'offline', 'server báo ngay "offline" để app gợi ý gửi qua máy chủ');
ws.close();

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

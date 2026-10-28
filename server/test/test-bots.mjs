// Test Bot API: tạo bot, token, gửi tin, long-poll updates, webhook ký HMAC, tin mã hóa bot không đọc được.
import WebSocket from 'ws';
import http from 'node:http';
import crypto from 'node:crypto';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const call = async (method, p, b, auth) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const login = async (u) => { let r = await call('POST', '/api/login', { username: u, password: '123456' }); if (!r.token) r = await call('POST', '/api/register', { username: u, password: '123456' }); return r.token; };
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (ws, pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = ws.inbox.findIndex(pred); if (i >= 0) return ws.inbox.splice(i, 1)[0]; await sleep(30); } throw new Error('timeout chờ sự kiện'); };
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const tu = await login('chubot');
const U = 'Bearer ' + tu;

console.log('1) Tạo bot');
ok((await call('POST', '/api/bots', { username: 'khongduoi' }, U)).status === 400, 'tên bot phải kết thúc bằng "bot"');
const cb = await call('POST', '/api/bots', { username: 'thu_bot', displayName: 'Bot Thử' }, U);
ok(/^rcb\.[^.]+\.[A-Za-z0-9_-]+$/.test(cb.token) && cb.bot.username === 'thu_bot', 'tạo bot, nhận token (chỉ hiện một lần)');
const B = 'Bot ' + cb.token;
ok((await call('GET', '/api/bots', null, U)).bots.length === 1, 'liệt kê bot của mình');
ok((await call('POST', '/api/login', { username: 'thu_bot', password: '' })).status === 401, 'bot không đăng nhập được bằng mật khẩu');
ok((await call('GET', '/bot/v1/me', null, 'Bot rcb_sai_token')).status === 401, 'token sai -> 401');
ok((await call('GET', '/bot/v1/me', null, B)).username === 'thu_bot', 'GET /bot/v1/me');
// id ngẫu nhiên có thể chứa ký tự đặc biệt -> token của MỌI bot đều phải dùng được
const extra = [];
for (let i = 0; i < 6; i++) extra.push(await call('POST', '/api/bots', { username: `phu${i}_bot` }, U));
const mes = await Promise.all(extra.map((x) => call('GET', '/bot/v1/me', null, 'Bot ' + x.token)));
ok(mes.every((m, i) => m.username === `phu${i}_bot`), 'token của 6 bot khác nhau đều hợp lệ');
for (const x of extra) await call('DELETE', `/api/bots/${x.bot.id}`, null, U);

console.log('2) Người dùng <-> bot');
const wu = await open(tu); await wait(wu, (m) => m.type === 'ready');
wu.send(JSON.stringify({ type: 'send', to: 'thu_bot', body: 'xin chào bot', ref: 'a' }));
const t0 = Date.now();
const up = await call('GET', '/bot/v1/updates?since=0&timeout=5', null, B);
ok(up.updates.length === 1 && up.updates[0].text === 'xin chào bot' && up.updates[0].from === 'chubot' && up.updates[0].chat.type === 'direct', 'bot nhận tin qua updates');
const since = up.updates[0].seq;
const p = call('GET', `/bot/v1/updates?since=${since}&timeout=10`, null, B);
await sleep(600);
wu.send(JSON.stringify({ type: 'send', to: 'thu_bot', body: 'tin thứ hai', ref: 'b' }));
const up2 = await p;
ok(up2.updates.length === 1 && up2.updates[0].text === 'tin thứ hai' && Date.now() - t0 < 6000, 'long-poll trả về ngay khi có tin mới');
const sent = await call('POST', '/bot/v1/send', { conversationId: up.updates[0].conversationId, text: 'bot trả lời', replyTo: up.updates[0].id }, B);
ok(sent.message?.body === 'bot trả lời', 'bot gửi trả lời');
const got = await wait(wu, (m) => m.type === 'message' && m.message.body === 'bot trả lời');
ok(got.message.senderUsername === 'thu_bot' && !got.message.enc && got.message.replyTo === up.updates[0].id, 'người dùng nhận tin bot (không mã hóa, có trích dẫn)');
ok((await call('GET', '/api/users/thu_bot', null, U)).user?.isBot === true, 'hồ sơ đánh dấu isBot');

console.log('3) Tin mã hóa / phạm vi');
wu.send(JSON.stringify({ type: 'send', to: 'thu_bot', body: '{"dr":1,"ct":"xx"}', enc: true, ref: 'c' }));
await sleep(300);
const up3 = await call('GET', `/bot/v1/updates?since=${up2.updates[0].seq}&timeout=0`, null, B);
ok(up3.updates[0]?.enc === true && up3.updates[0].text === null, 'tin mã hóa: bot chỉ thấy enc=true, không có nội dung');
ok((await call('POST', '/bot/v1/send', { conversationId: 'grp_khongthuoc', text: 'x' }, B)).status === 403, 'không gửi vào hội thoại không tham gia');

console.log('4) Webhook');
let hook = null;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hook = { body: b, sig: req.headers['x-reachat-signature'] }; res.end('ok'); }); });
await new Promise((r) => srv.listen(0, r));
const wh = await call('POST', `/api/bots/${cb.bot.id}/webhook`, { url: `http://127.0.0.1:${srv.address().port}/hook` }, U);
ok(wh.webhook && /^[0-9a-f]{48}$/.test(wh.secret), 'đặt webhook, nhận bí mật ký');
wu.send(JSON.stringify({ type: 'send', to: 'thu_bot', body: 'qua webhook', ref: 'd' }));
for (let i = 0; i < 40 && !hook; i++) await sleep(100);
ok(hook && JSON.parse(hook.body).update.text === 'qua webhook', 'webhook nhận tin mới');
ok(hook && hook.sig === crypto.createHmac('sha256', wh.secret).update(hook.body).digest('hex'), 'chữ ký HMAC-SHA256 hợp lệ');
srv.close();

console.log('5) Token mới / xóa bot');
const rt = await call('POST', `/api/bots/${cb.bot.id}/token`, {}, U);
ok((await call('GET', '/bot/v1/me', null, B)).status === 401 && (await call('GET', '/bot/v1/me', null, 'Bot ' + rt.token)).status === 200, 'cấp token mới -> token cũ hết hiệu lực');
const other = await login('nguoikhac');
ok((await call('DELETE', `/api/bots/${cb.bot.id}`, null, 'Bearer ' + other)).status === 404, 'người khác không xóa được bot');
await call('DELETE', `/api/bots/${cb.bot.id}`, null, U);
ok((await call('GET', '/bot/v1/me', null, 'Bot ' + rt.token)).status === 401, 'xóa bot -> token vô hiệu');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

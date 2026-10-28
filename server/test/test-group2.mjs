// Test nhóm 2: phó nhóm, chuyển trưởng nhóm, ảnh nhóm, duyệt thành viên (thêm + link mời), chỉ quản trị viên nhắn,
// mời ra theo quyền; ẩn trạng thái trực tuyến; tắt "Đã xem" (có đi có lại); hồ sơ (giới thiệu, sinh nhật, ảnh bìa);
// xem trước liên kết chặn địa chỉ nội bộ.
import WebSocket from 'ws';
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
// Lấy bản cập nhật nhóm MỚI NHẤT (bỏ các bản cũ còn trong hàng đợi)
const lastConv = async (w, cid) => {
  const isUpd = (m) => m.type === 'conversation:update' && m.conversation.id === cid;
  const t0 = Date.now();
  while (!w.inbox.some(isUpd) && Date.now() - t0 < 2500) await sleep(40);
  await sleep(300);
  const all = w.inbox.filter(isUpd);
  w.inbox = w.inbox.filter((m) => !isUpd(m));
  return all.at(-1)?.conversation;
};

const U = ['own', 'dep', 'mem', 'out', 'late'].map((x) => `${x}_${rnd}`);
const T = {}; for (const u of U) T[u] = await reg(u);
const [own, dep, mem, out, late] = U;
const W = {}; for (const u of [own, dep, mem, out]) W[u] = await open(T[u]);

console.log('1) Phó nhóm, ảnh nhóm, cài đặt');
send(W[own], { type: 'group:create', title: 'Nhóm thử', members: [dep, mem] });
const cid = (await wait(W[own], (m) => m.type === 'conversation:new')).conversation.id;
send(W[mem], { type: 'group:role', conversationId: cid, username: dep, role: 'deputy' });
ok((await wait(W[mem], (m) => m.type === 'error'))?.error.includes('Chỉ trưởng nhóm'), 'thành viên thường không bổ nhiệm được phó nhóm');
send(W[own], { type: 'group:role', conversationId: cid, username: dep, role: 'deputy' });
let c = await lastConv(W[own], cid);
ok(c?.deputies?.includes(dep), 'trưởng nhóm bổ nhiệm phó nhóm');
const AV = 'data:image/png;base64,' + Buffer.alloc(200).toString('base64');
send(W[mem], { type: 'group:avatar', conversationId: cid, avatar: AV });
ok((await wait(W[mem], (m) => m.type === 'error'))?.error.includes('ảnh nhóm'), 'thành viên thường không đổi được ảnh nhóm');
send(W[dep], { type: 'group:avatar', conversationId: cid, avatar: AV });
c = await lastConv(W[own], cid);
ok(c?.avatar === AV, 'phó nhóm đổi ảnh nhóm');
send(W[dep], { type: 'group:settings', conversationId: cid, approval: true, adminOnly: true });
c = await lastConv(W[own], cid);
ok(c?.approval === true && c?.adminOnly === true, 'phó nhóm bật duyệt thành viên + chỉ quản trị viên nhắn');

console.log('2) Chỉ quản trị viên được nhắn');
send(W[mem], { type: 'send', conversationId: cid, body: 'xin chào', ref: 'r1' });
ok((await wait(W[mem], (m) => m.type === 'error' && m.ref === 'r1'))?.error.includes('Chỉ trưởng nhóm và phó nhóm'), 'thành viên thường bị chặn gửi');
send(W[dep], { type: 'send', conversationId: cid, body: 'thông báo', ref: 'r2' });
ok(!!(await wait(W[dep], (m) => m.type === 'ack' && m.ref === 'r2')), 'phó nhóm gửi được');

console.log('3) Duyệt thành viên');
send(W[mem], { type: 'group:add', conversationId: cid, members: [out] });
ok((await wait(W[mem], (m) => m.type === 'group:pending'))?.usernames?.includes(out), 'thành viên thường thêm người -> chờ duyệt');
c = await lastConv(W[own], cid);
ok(c?.pending?.some((p) => p.username === out && p.byUsername === mem) && !c.members.some((x) => x.username === out), 'trưởng nhóm thấy yêu cầu, người đó chưa vào nhóm');
send(W[mem], { type: 'group:approve', conversationId: cid, username: out, accept: true });
ok((await wait(W[mem], (m) => m.type === 'error'))?.error.includes('duyệt'), 'thành viên thường không duyệt được');
send(W[dep], { type: 'group:approve', conversationId: cid, username: out, accept: true });
c = await lastConv(W[own], cid);
ok(c?.members.some((x) => x.username === out) && !c.pending.length, 'phó nhóm duyệt -> người đó vào nhóm');
send(W[own], { type: 'invite:create', conversationId: cid });
const inv = await wait(W[own], (m) => m.type === 'invite' || m.type === 'invite:info' || m.invite);
const code = inv?.invite?.code || inv?.code;
const WL = await open(T[late]);
send(WL, { type: 'invite:join', code });
ok(!!(await wait(WL, (m) => m.type === 'invite:pending')), 'vào bằng link mời khi bật duyệt -> chờ duyệt');
send(W[own], { type: 'group:approve', conversationId: cid, username: late, accept: false });
c = await lastConv(W[own], cid);
ok(c && !c.members.some((x) => x.username === late) && !c.pending.length, 'từ chối yêu cầu');

console.log('4) Mời ra, chuyển trưởng nhóm');
send(W[dep], { type: 'group:kick', conversationId: cid, username: own });
ok((await wait(W[dep], (m) => m.type === 'error'))?.error.includes('Chỉ trưởng nhóm'), 'phó nhóm không mời trưởng nhóm ra được');
send(W[dep], { type: 'group:kick', conversationId: cid, username: out });
c = await lastConv(W[own], cid);
ok(c && !c.members.some((x) => x.username === out), 'phó nhóm mời thành viên thường ra');
send(W[own], { type: 'group:transfer', conversationId: cid, username: mem });
c = await lastConv(W[own], cid);
ok(c?.ownerId && c.members.find((x) => x.id === c.ownerId)?.username === mem, 'chuyển quyền trưởng nhóm');
send(W[own], { type: 'group:role', conversationId: cid, username: dep, role: null });
ok((await wait(W[own], (m) => m.type === 'error'))?.error.includes('Chỉ trưởng nhóm'), 'trưởng nhóm cũ hết quyền bổ nhiệm');

console.log('5) Ẩn trạng thái trực tuyến');
await post('/api/friends/request', { username: mem }, T[out]); await post('/api/friends/request', { username: out }, T[mem]);
await post('/api/me/privacy', { hidePresence: true }, T[out]);
W[out].close(); await sleep(300); W[mem].inbox.length = 0;
const W2 = await open(T[out]);
await sleep(400);
ok(!W[mem].inbox.some((m) => m.type === 'presence' && m.username === out), 'bạn bè không nhận "đang trực tuyến"');
W2.send(JSON.stringify({ type: 'send', to: mem, body: 'xin chào', ref: 'p0' })); await sleep(400);   // trạng thái chỉ báo cho người có chung hội thoại
W[mem].inbox.length = 0;
await post('/api/me/privacy', { hidePresence: false }, T[out]); await sleep(300);
ok(W[mem].inbox.some((m) => m.type === 'presence' && m.username === out && m.online), 'bật lại hiện trạng thái -> bạn bè thấy online ngay');
await post('/api/me/privacy', { hidePresence: true }, T[out]); await sleep(300);
ok(W[mem].inbox.some((m) => m.type === 'presence' && m.username === out && m.online === false), 'ẩn khi đang online -> bạn bè thấy offline ngay (không cần kết nối lại)');
const pu = await get('/api/users/' + out, T[mem]);
ok(pu.user && pu.user.lastSeen == null, 'không lộ "lần cuối truy cập"');
const priv = await get('/api/me/privacy', T[out]);
ok(priv.hidePresence === true && priv.readReceipts === true, 'đọc lại cài đặt');

console.log('6) Tắt "Đã xem" (có đi có lại)');
const dm = (await post('/api/me/privacy', { readReceipts: false }, T[mem])).ok;
send(W2, { type: 'send', to: mem, body: 'chào', ref: 'd1' });
const ack = await wait(W2, (m) => m.type === 'ack' && m.ref === 'd1');
send(W[mem], { type: 'read', conversationId: ack.message.conversationId, seq: ack.message.seq });
await sleep(400);
ok(dm && !W2.inbox.some((m) => m.type === 'receipt' && m.state === 'read' && m.username === mem), 'người tắt "Đã xem" không gửi trạng thái đã xem');
send(W[mem], { type: 'send', to: out, body: 'đáp', ref: 'd2' });
const ack2 = await wait(W[mem], (m) => m.type === 'ack' && m.ref === 'd2');
W[mem].inbox.length = 0;
send(W2, { type: 'read', conversationId: ack2.message.conversationId, seq: ack2.message.seq });
await sleep(400);
ok(!W[mem].inbox.some((m) => m.type === 'receipt' && m.state === 'read' && m.username === out), 'và cũng không nhận "Đã xem" của người khác');

console.log('7) Hồ sơ');
const COVER = 'data:image/jpeg;base64,' + Buffer.alloc(300).toString('base64');
const pe = await post('/api/me/profile/extra', { bio: 'Kỹ sư phần mềm', birthday: '1995-' + new Date(Date.now() + 7 * 3600e3).toISOString().slice(5, 10), showBirthday: 1, cover: COVER }, T[dep]);
ok(pe.profile?.bio === 'Kỹ sư phần mềm' && pe.profile.birthday.startsWith('1995-'), 'lưu giới thiệu + sinh nhật (chính mình thấy đủ năm)');
ok((await post('/api/me/profile/extra', { birthday: '2999-01-01' }, T[dep])).status === 400, 'ngày sinh tương lai -> từ chối');
const pv = await get('/api/users/' + dep + '/profile', T[own]);
ok(/^--\d{2}-\d{2}$/.test(pv.profile?.birthday || '') && pv.profile.cover === COVER && pv.profile.bio === 'Kỹ sư phần mềm', 'người khác thấy ngày/tháng (ẩn năm), ảnh bìa, giới thiệu');
const pubList = await get('/api/users/' + dep, T[own]);
ok(!('cover' in pubList.user), 'ảnh bìa không nằm trong thông tin công khai rút gọn');
await post('/api/friends/request', { username: own }, T[dep]); await post('/api/friends/request', { username: dep }, T[own]);
const bd = await get('/api/contacts/birthdays', T[own]);
ok(bd.today?.some((u) => u.username === dep), 'sinh nhật bạn bè hôm nay');
await post('/api/me/profile/extra', { showBirthday: 0 }, T[dep]);
ok((await get('/api/users/' + dep + '/profile', T[own])).profile.birthday === null && !(await get('/api/contacts/birthdays', T[own])).today.length, 'ẩn sinh nhật');

console.log('7b) Trạng thái + tự động trả lời');
ok((await post('/api/me/status', { text: 'Nghỉ phép', autoReply: 'x' }, T[late])).text === 'Nghỉ phép', 'đặt trạng thái');
ok((await post('/api/me/status', { text: 'Đang họp', until: Date.now() - 1000 }, T[late])).status === 400, 'thời hạn ở quá khứ -> từ chối');
const stR = await post('/api/me/status', { text: 'Nghỉ phép đến thứ Hai', until: Date.now() + 3600e3, autoReply: 'Mình đang nghỉ phép, sẽ trả lời sau nhé.' }, T[late]);
ok(stR.autoReply && stR.until > Date.now(), 'bật tự động trả lời có thời hạn');
ok((await get('/api/users/' + late, T[own])).user.statusText === 'Nghỉ phép đến thứ Hai', 'người khác thấy trạng thái');
const WS2 = await open(T[own]);
send(WS2, { type: 'send', to: late, body: 'alo', ref: 'ar1' });
const auto = await wait(WS2, (m) => m.type === 'message' && m.message.type === 'autoreply');
ok(auto && JSON.parse(auto.message.body).text === 'Mình đang nghỉ phép, sẽ trả lời sau nhé.' && auto.message.enc === false, 'nhắn tới -> nhận tin tự động trả lời (ghi rõ không mã hóa)');
send(WS2, { type: 'send', to: late, body: 'alo lần 2', ref: 'ar2' });
await sleep(1200);
ok(!WS2.inbox.some((m) => m.type === 'message' && m.message.type === 'autoreply'), 'nhắn tiếp -> không trả lời tự động lặp lại');
await post('/api/me/status', { text: null }, T[late]);
ok(!(await get('/api/users/' + late, T[own])).user.statusText, 'xóa trạng thái');
WS2.close();

console.log('7c) Sự kiện');
const WE = await open(T[own]), WD = await open(T[dep]);
send(WD, { type: 'send', conversationId: cid, body: 'bản-mã-sự-kiện', enc: true, msgType: 'event', ref: 'ev1' });   // phó nhóm (nhóm đang 'chỉ quản trị viên nhắn')
const evAck = await wait(WD, (m) => m.type === 'ack' && m.ref === 'ev1');
ok(evAck?.message.type === 'event', 'gửi sự kiện (nội dung mã hóa như tin chữ)');
send(WE, { type: 'rsvp', messageId: evAck.message.id, status: 'yes' });
const tl = await wait(WD, (m) => m.type === 'event:rsvp' && m.tally.yes.includes(own));
ok(!!tl, 'thành viên trả lời "Tham gia" -> cả nhóm thấy');
send(WE, { type: 'rsvp', messageId: evAck.message.id, status: 'no' });
ok((await wait(WD, (m) => m.type === 'event:rsvp' && m.tally.no.includes(own) && !m.tally.yes.includes(own))) != null, 'đổi ý -> cập nhật');
send(WE, { type: 'rsvp', messageId: evAck.message.id, status: 'bừa' });
await sleep(300);
ok(!WD.inbox.some((m) => m.type === 'event:rsvp'), 'trạng thái lạ -> bỏ qua');
WE.close(); WD.close();

console.log('8) Xem trước liên kết');
const lp = await get('/api/link-preview?url=' + encodeURIComponent('http://127.0.0.1:' + PORT + '/health'), T[own]);
ok(lp.status === 200 && lp.preview === null, 'địa chỉ nội bộ bị chặn (chống SSRF)');
ok((await get('/api/link-preview?url=ftp://x', T[own])).status === 400, 'chỉ http/https');

for (const w of [...Object.values(W), W2, WL]) try { w.close(); } catch {}
console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

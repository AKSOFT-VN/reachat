// Test ẩn story với người cụ thể. Chạy với server test: PORT=4100 (DB riêng, đã seed).
import WebSocket from 'ws';
const PORT = process.env.PORT || 4100;
const base = `http://localhost:${PORT}`;
const req = (method, p, b, t) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const login = async (u) => {
  let r = await req('POST', '/api/login', { username: u, password: '123456' });
  if (!r.token) r = await req('POST', '/api/register', { username: u, password: '123456', displayName: u });
  return r.token;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (t) => new Promise((r) => { const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=` + t); ws.inbox = []; ws.on('message', (d) => ws.inbox.push(JSON.parse(d))); ws.on('open', () => r(ws)); });
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const [tn, tb, tc] = await Promise.all(['nam', 'binh', 'chi'].map(login));
for (const [a, b, ta, tb2] of [['nam', 'binh', tn, tb], ['nam', 'chi', tn, tc]]) {   // mời 2 chiều -> thành bạn
  await req('POST', '/api/friends/request', { username: b }, ta);
  await req('POST', '/api/friends/request', { username: a }, tb2);
}
const wb = await open(tb), wc = await open(tc);
await sleep(300);

console.log('1) Ẩn với binh');
const put = await req('PUT', '/api/stories/hidden', { usernames: ['binh', 'nam', 'khong_ton_tai'] }, tn);
ok(put.ok && put.count === 1, 'lưu danh sách (bỏ qua chính mình + người không tồn tại)');
const h = await req('GET', '/api/stories/hidden', null, tn);
ok(h.hidden.length === 1 && h.hidden[0].username === 'binh', 'đọc lại danh sách ẩn');

console.log('2) Đăng story');
const st = (await req('POST', '/api/stories', { kind: 'text', body: 'bí mật với binh', bg: '#000' }, tn)).story;
await sleep(300);
ok(wc.inbox.some((m) => m.type === 'story:new') && !wb.inbox.some((m) => m.type === 'story:new'), 'chi được báo story mới, binh thì không');
const sb = (await req('GET', '/api/stories', null, tb)).stories;
const sc = (await req('GET', '/api/stories', null, tc)).stories;
ok(!sb.some((s) => s.id === st.id), 'binh không thấy story');
ok(sc.some((s) => s.id === st.id), 'chi thấy story');
await req('POST', `/api/stories/${st.id}/view`, {}, tb);
await req('POST', `/api/stories/${st.id}/view`, {}, tc);
const v = (await req('GET', `/api/stories/${st.id}/viewers`, null, tn)).viewers;
ok(v.length === 1 && v[0].username === 'chi', 'binh không ghi được lượt xem bằng id đoán được');

console.log('3) Bỏ ẩn -> thấy cả story đang hiển thị');
await req('PUT', '/api/stories/hidden', { usernames: [] }, tn);
ok((await req('GET', '/api/stories', null, tb)).stories.some((s) => s.id === st.id), 'binh thấy lại story');

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

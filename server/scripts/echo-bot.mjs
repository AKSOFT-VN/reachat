// Bot mẫu: trả lời mọi tin nhắn 1-1. Chạy:
//   REACHAT_BOT_TOKEN=rcb_... node scripts/echo-bot.mjs [http://localhost:4000]
// Tạo bot + lấy token: app ReaChat -> Cài đặt -> Bot.
const base = process.argv[2] || process.env.REACHAT_SERVER || 'http://localhost:4000';
const token = process.env.REACHAT_BOT_TOKEN;
if (!token) { console.error('Thiếu REACHAT_BOT_TOKEN'); process.exit(1); }
const api = async (path, body) => {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
};
const me = await api('/bot/v1/me');
console.log(`Bot @${me.username} đang chạy trên ${base}`);
let since = 0;
// Bỏ qua tin cũ: lấy mốc hiện tại trước.
for (const u of (await api('/bot/v1/updates?timeout=0')).updates) since = Math.max(since, u.seq);
for (;;) {
  try {
    const { updates } = await api(`/bot/v1/updates?since=${since}&timeout=25`);
    for (const u of updates) {
      since = Math.max(since, u.seq);
      if (u.chat.type !== 'direct') continue;                    // chỉ trả lời chat 1-1
      const text = u.text == null ? '(tin đã mã hóa — bot không đọc được)'
        : u.text.trim() === '/giờ' ? '🕒 ' + new Date().toLocaleString('vi-VN')
        : u.text.trim() === '/help' ? 'Lệnh: /giờ, /help — hoặc gửi gì mình nhắc lại nấy.'
        : '🤖 Bạn vừa nói: ' + u.text;
      await api('/bot/v1/send', { conversationId: u.conversationId, text, replyTo: u.id });
    }
  } catch (e) { console.error('Lỗi:', e.message); await new Promise((r) => setTimeout(r, 3000)); }
}

// Giám sát & cảnh báo: máy chủ tự báo khi có sự cố.
// Kênh báo (bật cái nào có cấu hình):
//  - ALERT_WEBHOOK_URL: POST JSON. Mặc định {"text": "..."} (Google Chat, Slack); Discord dùng ALERT_WEBHOOK_BODY={"content":"{text}"};
//    Telegram: ALERT_WEBHOOK_URL=https://api.telegram.org/bot<TOKEN>/sendMessage, ALERT_WEBHOOK_BODY={"chat_id":"<ID>","text":"{text}"}
//  - ALERT_EMAIL: gửi qua SMTP_URL (cùng cấu hình email khôi phục).
// Sự kiện: máy chủ khởi động (= vừa sập/khởi động lại), lỗi không bắt được, nhiều lỗi 5xx, đĩa sắp đầy, CSDL lỗi,
// lỗi ứng dụng (client) tăng đột biến, TURN Cloudflare sắp hết hạn mức. Mỗi loại báo tối đa 1 lần / ALERT_COOLDOWN_MIN (30).
// LƯU Ý: máy chủ chết hẳn thì không tự báo được -> dùng thêm dịch vụ theo dõi bên ngoài gọi /health (xem README).
import os from 'node:os';
import fs from 'node:fs';
import db from './db.js';
import { sendEmail } from './notify.js';

const HOOK = process.env.ALERT_WEBHOOK_URL, BODY = process.env.ALERT_WEBHOOK_BODY, EMAIL = process.env.ALERT_EMAIL;
const COOLDOWN = (Number(process.env.ALERT_COOLDOWN_MIN) || 30) * 60_000;
const NAME = process.env.ALERT_NAME || process.env.PUBLIC_URL || os.hostname();
export const alertEnabled = () => !!(HOOK || EMAIL);
const last = new Map();       // loại -> lần báo gần nhất
const recent = [];            // 20 cảnh báo gần nhất (trang quản trị)

export async function alert(kind, text, { force = false } = {}) {
  const now = Date.now();
  recent.unshift({ at: now, kind, text: String(text).slice(0, 500) }); recent.length = Math.min(recent.length, 20);
  console.warn(`[cảnh báo] ${kind}: ${text}`);
  if (!force && now - (last.get(kind) || 0) < COOLDOWN) return;
  last.set(kind, now);
  const msg = `⚠️ ReaChat (${NAME}) — ${text}`;
  const jobs = [];
  if (HOOK) {
    const body = BODY ? BODY.replace(/\{text\}/g, JSON.stringify(msg).slice(1, -1)) : JSON.stringify({ text: msg });
    jobs.push(fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) }));
  }
  if (EMAIL) jobs.push(sendEmail(EMAIL, 'Cảnh báo ReaChat: ' + kind, msg));
  for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') console.warn('Không gửi được cảnh báo:', r.reason?.message);
}
export const recentAlerts = () => recent;

// ---- Lỗi 5xx: >= ALERT_5XX lỗi trong 5 phút -> báo (kèm lỗi gần nhất) ----
const errs5xx = [];
export function record5xx(path, message) {
  const now = Date.now();
  errs5xx.push(now);
  while (errs5xx.length && now - errs5xx[0] > 300_000) errs5xx.shift();
  if (errs5xx.length >= (Number(process.env.ALERT_5XX) || 10)) alert('loi-5xx', `${errs5xx.length} lỗi máy chủ trong 5 phút. Gần nhất: ${path} — ${message}`);
}

// ---- Lỗi ứng dụng (client gửi về) ----
db.exec(`CREATE TABLE IF NOT EXISTS client_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT,
  version TEXT, platform TEXT, message TEXT, stack TEXT)`);
export function recordClientError(userId, b = {}) {
  const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
  db.prepare('INSERT INTO client_errors (at, user_id, version, platform, message, stack) VALUES (?,?,?,?,?,?)')
    .run(Date.now(), userId || null, cut(b.version, 20), cut(b.platform, 40), cut(b.message, 500), cut(b.stack, 3000));
  db.prepare('DELETE FROM client_errors WHERE id <= (SELECT MAX(id) - 2000 FROM client_errors)').run();   // giữ 2000 bản gần nhất
  const n = db.prepare('SELECT COUNT(*) n FROM client_errors WHERE at > ?').get(Date.now() - 600_000).n;
  if (n >= (Number(process.env.ALERT_CLIENT_ERRORS) || 30)) alert('loi-ung-dung', `${n} lỗi ứng dụng trong 10 phút. Gần nhất: ${cut(b.message, 200)}`);
}
export const clientErrors = (limit = 50) => ({
  last24h: db.prepare('SELECT COUNT(*) n FROM client_errors WHERE at > ?').get(Date.now() - 86400_000).n,
  // gộp theo nội dung lỗi: lỗi nào hay gặp nhất
  top: db.prepare(`SELECT message, COUNT(*) n, MAX(at) lastAt, MAX(version) version FROM client_errors WHERE at > ?
    GROUP BY message ORDER BY n DESC LIMIT ?`).all(Date.now() - 7 * 86400_000, limit),
});

// ---- Kiểm tra định kỳ (5 phút): đĩa, CSDL, hạn mức TURN ----
export function startWatchdog({ uploadDir, minFreeGB = 2, turnUsage }) {
  const check = () => {
    try {
      const st = fs.statfsSync(uploadDir);
      const free = (st.bavail * st.bsize) / 1024 ** 3;
      if (free < minFreeGB * 2) alert('dia-sap-day', `Ổ đĩa còn ${free.toFixed(1)} GB (máy chủ từ chối tải tệp khi dưới ${minFreeGB} GB).`);
    } catch {}
    try { db.prepare('SELECT 1').get(); } catch (e) { alert('csdl', 'CSDL lỗi: ' + e.message); }
    try {
      const t = turnUsage?.();
      if (t && t.limitGB && t.usedGB >= t.limitGB * 0.8) alert('turn-han-muc', `TURN Cloudflare tháng ${t.month} đã dùng ${t.usedGB}/${t.limitGB} GB${t.usedGB >= t.limitGB ? ' — ĐÃ NGỪNG cấp TURN Cloudflare' : ''}.`);
    } catch {}
  };
  setTimeout(check, 10_000).unref?.();
  setInterval(check, 300_000).unref?.();
}
// Lỗi không bắt được: báo rồi để tiến trình thoát (Docker tự khởi động lại; lúc khởi động sẽ báo tiếp).
export function installCrashHandlers() {
  process.on('uncaughtException', (e) => {
    console.error(e);
    alert('sap', 'Lỗi không bắt được — máy chủ sẽ khởi động lại: ' + (e?.stack || e).toString().slice(0, 400), { force: true }).finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
  });
  process.on('unhandledRejection', (e) => { alert('promise', 'Promise bị từ chối không xử lý: ' + (e?.stack || e).toString().slice(0, 400)); });
}

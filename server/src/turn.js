// Cấp cấu hình ICE (STUN + TURN) cho cuộc gọi. Ba chế độ (ưu tiên từ trên xuống):
//  0) Cloudflare Realtime TURN (CF_TURN_KEY_ID + CF_TURN_API_TOKEN): xin thông tin đăng nhập tạm thời qua API của
//     Cloudflare; có TURN qua UDP/TCP/TLS cổng 443 -> đi xuyên hầu hết tường lửa. Máy chủ ReaChat không cần mở UDP.
//  1) TURN tích hợp (node-turn): mỗi lần xin cấp sinh user/mật khẩu NGẪU NHIÊN, tự hết hạn sau TURN_TTL_S.
//  2) coturn riêng (TURN_URLS + TURN_SECRET): thông tin đăng nhập tạm thời chuẩn "TURN REST API"
//     username = "<hết hạn unix>:<userId>", credential = base64(HMAC-SHA1(secret, username)).
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import { blockedReason } from './turnquota.js';
import { TURN_BUILTIN, TURN_PORT, TURN_PUBLIC_HOST, TURN_EXTERNAL_IP, TURN_URLS, TURN_SECRET, TURN_TTL_S, STUN_URLS, TURN_MIN_PORT, TURN_MAX_PORT } from './config.js';

const require = createRequire(import.meta.url);
let turn = null;
const issued = new Map();   // username -> hết hạn (ms)

export function startTurn() {
  if (!TURN_BUILTIN) { if (cloudflareTurn) console.log('TURN: Cloudflare Realtime'); return null; }
  try {
    const Turn = require('node-turn');
    turn = new Turn({
      listeningPort: TURN_PORT,
      minPort: TURN_MIN_PORT, maxPort: TURN_MAX_PORT,   // dải cổng relay (mở trên tường lửa)
      authMech: 'long-term',
      realm: 'reachat',
      credentials: {},
      ...(TURN_EXTERNAL_IP ? { externalIps: TURN_EXTERNAL_IP } : {}),
      debugLevel: 'ERROR',
    });
    turn.start();
    // Dọn thông tin đăng nhập hết hạn.
    setInterval(() => {
      const now = Date.now();
      for (const [u, exp] of issued) if (exp <= now) { try { turn.removeUser(u); } catch {} issued.delete(u); }
    }, 60_000).unref?.();
    console.log(`TURN tích hợp: udp/${TURN_PORT}`);
  } catch (e) {
    console.warn('Không khởi động được TURN tích hợp:', e.message);
    turn = null;
  }
  return turn;
}

// IPv4 LAN đầu tiên của máy (dùng khi client kết nối qua localhost).
const lanAddress = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

// host: tên máy chủ client đang dùng để kết nối (lấy từ request) — TURN chạy cùng máy.
// ---- Cloudflare: CHỈ cấp cho cuộc gọi thật, mỗi (cuộc gọi, người) một bộ thông tin đăng nhập riêng ----
// Hợp lệ (kiểm ở ws.js -> turnEligible): người gọi đang gọi tới một tài khoản đang trực tuyến, không chặn nhau;
// người nghe có cuộc gọi đang đổ chuông/đã nhận dành cho mình; thành viên vào cuộc gọi nhóm của nhóm mình.
// Thu hồi ngay trên Cloudflare khi cuộc gọi kết thúc / rời phòng, hoặc sau 60 giây nếu cuộc gọi không thực sự diễn ra.
// Gửi tệp P2P KHÔNG dùng TURN Cloudflare (tệp lớn đốt hạn mức rất nhanh) -> TURN tích hợp / gọi thẳng.
const CF_KEY = process.env.CF_TURN_KEY_ID, CF_TOKEN = process.env.CF_TURN_API_TOKEN;
export const cloudflareTurn = !!(CF_KEY && CF_TOKEN);
const CF_API = `${process.env.CF_TURN_API_BASE || 'https://rtc.live.cloudflare.com/v1'}/turn/keys/${CF_KEY}/credentials`;   // API_BASE: chỉ để test
const grants = new Map();          // khóa cuộc gọi -> Map(userId -> { cfUser, iceServers, at })
const perHour = new Map();         // userId -> [thời điểm cấp...]  (tối đa CF_GRANTS_PER_HOUR)
const GRANTS_PER_HOUR = Number(process.env.CF_GRANTS_PER_HOUR) || 30;
const CONFIRM_MS = Number(process.env.CF_CONFIRM_MS) || 60_000;
const wasted = new Map();          // userId -> [thời điểm bị thu hồi vì không có cuộc gọi thật]
const WASTE_MAX = Number(process.env.CF_WASTE_MAX) || 3;
// Thời hạn mật khẩu Cloudflare (mặc định 6 giờ = cuộc gọi dài nhất). Đã thử thực tế (28/10/2026):
//  - lệnh thu hồi của Cloudflare KHÔNG có hiệu lực ngay (sau 3 phút mật khẩu đã thu hồi vẫn dùng được);
//  - mật khẩu hết hạn thì cuộc gọi đang chạy RỚT ở lần gia hạn TURN kế tiếp (~5 phút) -> không thể đặt thời hạn ngắn.
// Vì vậy chốt chặn là: chỉ cấp cho cuộc gọi thật + giới hạn số lần cấp + hạn mức tháng + captcha/giới hạn đăng ký.
const CF_TTL_S = Number(process.env.CF_TURN_TTL_S) || TURN_TTL_S;
let isLive = () => true;           // ws.js gắn vào: cuộc gọi còn diễn ra với người này không
export const setLiveCheck = (fn) => { isLive = fn; };

async function cfGenerate() {
  const r = await fetch(CF_API + '/generate-ice-servers', {
    method: 'POST', headers: { Authorization: 'Bearer ' + CF_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TTL_S }), signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error('Cloudflare TURN ' + r.status);
  const { iceServers } = await r.json();
  // Bỏ URL cổng 53: trình duyệt chặn cổng này -> chỉ làm chậm thu thập ứng viên.
  const list = (Array.isArray(iceServers) ? iceServers : [iceServers]).map((x) => ({
    ...x, urls: (Array.isArray(x.urls) ? x.urls : [x.urls]).filter((u) => !/:53(\?|$)/.test(u)),
  })).filter((x) => x.urls.length);
  return { iceServers: list, cfUser: list.find((x) => x.username)?.username };
}
const cfRevoke = (cfUser) => cfUser && fetch(`${CF_API}/${encodeURIComponent(cfUser)}/revoke`, {
  method: 'POST', headers: { Authorization: 'Bearer ' + CF_TOKEN }, signal: AbortSignal.timeout(5000),
}).catch((e) => console.warn('Thu hồi TURN Cloudflare lỗi:', e.message));

async function cloudflareGrant(key, userId) {
  const m = grants.get(key);
  const had = m?.get(userId);
  if (had && Date.now() - had.at < CF_TTL_S * 1000 - 30_000) return had.iceServers;   // xin lại trong cùng cuộc gọi -> dùng lại (còn hạn)
  const now = Date.now();
  const recent = (perHour.get(userId) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= GRANTS_PER_HOUR) throw Object.assign(new Error('rate'), { rate: true });
  // Xin TURN mà không gọi thật nhiều lần (thu hồi của Cloudflare chậm -> mật khẩu vẫn dùng được) -> tạm ngừng cấp.
  if ((wasted.get(userId) || []).filter((t) => now - t < 3600_000).length >= WASTE_MAX) throw Object.assign(new Error('rate'), { rate: true });
  perHour.set(userId, [...recent, now]);
  const g = await cfGenerate();
  if (!grants.has(key)) grants.set(key, new Map());
  grants.get(key).set(userId, { ...g, at: now });
  return g.iceServers;
}
// Cuộc gọi kết thúc / người rời phòng -> thu hồi (userId = null: mọi người trong cuộc gọi).
export function revokeCallTurn(key, userId = null) {
  const m = grants.get(key);
  if (!m) return;
  for (const [uid, g] of m) if (!userId || uid === userId) { cfRevoke(g.cfUser); m.delete(uid); }
  if (!m.size) grants.delete(key);
}
export function sweepGrants(now = Date.now()) {
  for (const [key, m] of grants) for (const [uid, g] of m) {
    if (now - g.at > CF_TTL_S * 1000 && !isLive(key, uid)) { m.delete(uid); continue; }   // đã hết hạn trên Cloudflare
    if (now - g.at > CONFIRM_MS && !isLive(key, uid)) {                               // không có cuộc gọi thật
      if (!g.confirmed) wasted.set(uid, [...(wasted.get(uid) || []).filter((t) => now - t < 3600_000), now]);
      revokeCallTurn(key, uid);
    } else if (now - g.at > CONFIRM_MS) g.confirmed = true;
  }
  for (const [k, m] of grants) if (!m.size) grants.delete(k);
}
setInterval(sweepGrants, Math.min(15_000, CONFIRM_MS / 2)).unref?.();
export const activeGrants = () => [...grants.values()].reduce((n, m) => n + m.size, 0);

// key: khóa cuộc gọi đã được ws.js xác nhận hợp lệ (null = không phải cuộc gọi -> không dùng Cloudflare).
// Cloudflare khi còn hạn mức; còn lại -> TURN tích hợp (miễn phí, nếu bật) hoặc chỉ STUN (gọi thẳng).
export async function iceConfigFor(userId, host, key = null) {
  let turnBlocked = null;
  if (cloudflareTurn && key) {
    turnBlocked = blockedReason(userId);
    if (!turnBlocked) {
      try { return { iceServers: await cloudflareGrant(key, userId), ttl: CF_TTL_S, turn: 'cloudflare' }; }
      catch (e) { if (e.rate) turnBlocked = 'rate'; else console.warn('Không lấy được TURN Cloudflare, dùng dự phòng:', e.message); }
    }
  }
  const cfg = iceServersFor(userId, host);
  return { ...cfg, turn: cfg.iceServers.some((x) => String(x.urls).includes('turn:')) ? 'builtin' : 'none', ...(turnBlocked ? { turnBlocked } : {}) };
}

export function iceServersFor(userId, host) {
  const list = STUN_URLS.length ? [{ urls: STUN_URLS }] : [];
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_S;
  if (TURN_URLS.length && TURN_SECRET) {
    const username = `${expiry}:${userId}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    list.push({ urls: TURN_URLS, username, credential });
  } else if (turn) {
    const username = `${expiry}:${crypto.randomBytes(6).toString('hex')}`;
    const credential = crypto.randomBytes(18).toString('base64url');
    turn.addUser(username, credential);
    issued.set(username, expiry * 1000);
    let h = TURN_PUBLIC_HOST || String(host || 'localhost').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!TURN_PUBLIC_HOST && /^(localhost|127\.|::1$)/.test(h)) h = lanAddress() || h;   // Chromium bỏ qua TURN trên loopback
    const hh = h.includes(':') ? `[${h}]` : h;   // IPv6
    list.push({ urls: [`turn:${hh}:${TURN_PORT}?transport=udp`], username, credential });
  }
  return { iceServers: list, ttl: TURN_TTL_S };
}

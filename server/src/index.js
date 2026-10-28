import { dbStats } from './dbtune.js';   // tối ưu SQLite — phải nạp đầu tiên
import rawDb from './db.js';
import bcrypt from 'bcryptjs';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { PORT, TLS_CERT, TLS_KEY, UPDATES_DIR, WEB_DIR, MAX_FILE_MB, DB_PATH } from './config.js';
import { startTurn, iceConfigFor } from './turn.js';
import { record as recordTurn, usageSummary as turnUsage } from './turnquota.js';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startContact, confirmContact, removeContact as removeContactInfo, contactStatus, forgotStart, forgotReset } from './verify.js';
import { channels as notifyChannels } from './notify.js';
import { newCaptcha, checkCaptcha, captchaError, captchaEnabled, checkRegisterIp, recordRegisterIp } from './captcha.js';
import * as google from './google.js';
import { searchUsers, getPrivacy, setPrivacy, setPrivacy2 } from './search.js';
import { profileOf, updateProfileExtra, birthdaysToday } from './profile.js';
import { linkPreview } from './linkpreview.js';
import { getSync, putSync } from './sync.js';
import { assertClean, getModeration, setModeration, audit, auditLog } from './moderation.js';
import { setStatus, getStatus } from './status.js';
import { gifEnabled, gifSearch, gifMedia, translateEnabled, translate } from './extras.js';
import { libraryCount, searchLibrary, readGif, listGifs, addGif, updateGif, deleteGif, stickerPacks } from './gifs.js';
import { alert, alertEnabled, record5xx, recordClientError, clientErrors, recentAlerts, startWatchdog, installCrashHandlers } from './alert.js';
installCrashHandlers();
import { register, login, verifyToken, issueToken, httpError, setMyPublicKey, updateProfile, changePassword, recoverAccount } from './auth.js';
import { newTotpSecret, otpauthUri, verifyTotp, checkLimit, recordFail } from './security.js';
import { getUserByUsername, getUserById, publicUser, recordFile, getFile,
  addContact, removeContact, listContacts, block, unblock, listBlocks,
  createFriendRequest, getFriendRequest, setRequestStatus, listIncomingRequests,
  listOutgoingRequests, areFriends, makeFriends, getRequestBetween,
  createStory, getStory, deleteStory, purgeExpiredStories, activeStoriesForUsers,
  markStoryViewed, storyViewers, storyViewCount, hasViewedStory, storyHiddenFrom, setStoryHidden, canSeeStoriesOf,
  getKeyBackup, setKeyBackup, setTotp, setRecovery, startChunked, addPart, listParts, finishChunked,
} from './db.js';
import { listSessions, revokeSession, revokeOthers, deleteAccount, deviceLabel, sessionAge } from './account.js';
import { attachWebSocket, announcePresence, turnEligible, emitToUser, kickUser, kickSession, kickOthers, onlineCount, isUserOnline, broadcastMessageUpdate, sendAsUser } from './ws.js';
import { vapidPublicKey, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe, setMuted as pushSetMuted } from './push.js';
import { createBot, listBots, regenerateToken, setWebhook, deleteBot, botFromRequest, botUpdates } from './bots.js';
import { check as rateCheck, checkQuota, checkDisk, sweepOrphans, usedBytes, QUOTA_BYTES } from './limits.js';
import { createReport, REASONS, requireAdmin, adminStats, adminUsers, setBan, setRole, adminReports, handleReport, removeMessage } from './admin.js';

const app = express();
// IP thật của người dùng: sau Cloudflare Tunnel / proxy mọi yêu cầu đến từ proxy -> đọc CF-Connecting-IP / X-Forwarded-For,
// nhưng CHỈ tin header khi yêu cầu đến từ proxy tin cậy (không cho client ngoài tự khai IP để lách giới hạn đăng nhập).
// TRUST_PROXY=loopback (mặc định): chỉ 127.x / ::1. TRUST_PROXY=all: khi cổng server chỉ mở ở loopback của máy chủ
// (vd. Docker -p 127.0.0.1:4000 — yêu cầu từ cloudflared tới với IP cầu mạng Docker 172.17.x.x).
// IP_HEADER: header chứa IP thật do proxy đặt — mặc định x-forwarded-for, lấy phần tử CUỐI (do proxy gần nhất thêm vào;
// các phần tử đầu là client tự khai). Sau Cloudflare có thể đặt IP_HEADER=cf-connecting-ip.
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
const IP_HEADER = String(process.env.IP_HEADER || 'x-forwarded-for').toLowerCase();
const clientIp = (req) => {
  const peer = req.socket?.remoteAddress || '';
  const trusted = TRUST_PROXY === 'all' || /^(::1|127\.|::ffff:127\.)/.test(peer);
  if (!trusted) return peer;
  const v = String(req.headers[IP_HEADER] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return v[v.length - 1] || peer;
};
app.use(cors());
app.use((_req, res, next) => {          // header bảo mật chung: không cho nhúng iframe (clickjacking), không đoán kiểu nội dung
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
// Thân JSON lớn (tệp base64) chỉ cho yêu cầu đã đăng nhập; yêu cầu ẩn danh (đăng ký, đăng nhập…) tối đa 64 KB.
const bigJson = express.json({ limit: Math.ceil(MAX_FILE_MB * 1.4) + 1 + 'mb' }), smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => (verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, '')) ? bigJson : smallJson)(req, res, next));

const UPLOAD_DIR = fileURLToPath(new URL('../uploads', import.meta.url));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    if (!err.status || err.status >= 500) { console.error(req.method, req.path, err); record5xx(req.method + ' ' + req.path, err.message); }
    res.status(err.status || 500).json({ error: err.message || 'Lỗi máy chủ', ...(err.need2fa ? { need2fa: true } : {}), ...(err.needPassword ? { needPassword: true } : {}), ...(err.needCode ? { needCode: true } : {}), ...(err.needCaptcha ? { needCaptcha: true } : {}) });
  });
};

// Middleware xác thực cho REST.
const requireAuth = (req, _res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = verifyToken(token);
  if (!user) throw httpError(401, 'Chưa xác thực');
  req.user = user;
  next();
};

// Thao tác nhạy cảm (đổi mã khôi phục, email/SĐT khôi phục, khóa danh tính, xóa tài khoản…): token bị đánh cắp
// không được phép leo thang thành chiếm tài khoản vĩnh viễn -> phải nhập lại mật khẩu (+ mã 2 bước nếu bật),
// trừ khi phiên vừa đăng nhập trong REAUTH_FRESH_MS (vừa chứng minh mật khẩu). Có giới hạn thử sai.
const REAUTH_FRESH_MS = 10 * 60_000;
async function reauth(req, { allowFresh = true, otp: needOtp = true } = {}) {
  const u = req.user, { password, otp } = req.body || {};
  if (allowFresh && sessionAge(u.sid) < REAUTH_FRESH_MS) return;
  checkLimit('u:' + u.username);
  if (!(await bcrypt.compare(String(password || ''), u.password_hash))) { recordFail('u:' + u.username); throw Object.assign(httpError(403, 'Mật khẩu không đúng'), { needPassword: true }); }
  if (needOtp && u.totp_on && !verifyTotp(u.id, u.totp_secret, otp)) { recordFail('u:' + u.username); throw Object.assign(httpError(403, 'Mã xác thực 2 bước không đúng'), { need2fa: true, needPassword: true }); }
}


// Cập nhật tự động (electron-updater, provider "generic"): latest.yml + bộ cài. Công khai, không cần token.
fs.mkdirSync(UPDATES_DIR, { recursive: true });
// Nhiều khoảng byte trong một Range -> multipart/byteranges (express.static không hỗ trợ) để
// electron-updater tải VI SAI (chỉ các khối đổi) thay vì cả bộ cài.
app.get('/updates/:file', (req, res, next) => {
  const ranges = /^bytes=(.+)$/.exec(req.headers.range || '')?.[1].split(',');
  if (!ranges || ranges.length < 2 || !/^[\w.-]+$/.test(req.params.file)) return next();
  const p = path.join(UPDATES_DIR, req.params.file);
  if (!fs.existsSync(p)) return next();
  const size = fs.statSync(p).size;
  const parts = ranges.map((r) => r.trim().split('-').map((x) => (x === '' ? null : Number(x))))
    .map(([a, b]) => (a == null ? [size - b, size - 1] : [a, b == null ? size - 1 : Math.min(b, size - 1)]));
  if (parts.some(([a, b]) => !(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a <= b))) return res.status(416).end();
  // Chống DoS: giới hạn số khoảng và tổng byte (≤ kích thước tệp — các khoảng chồng nhau không nhân dữ liệu lên được).
  if (parts.length > 1000 || parts.reduce((t, [a, b]) => t + b - a + 1, 0) > size) return res.status(416).end();
  const boundary = 'rc' + crypto.randomBytes(8).toString('hex');
  res.status(206).setHeader('Content-Type', 'multipart/byteranges; boundary=' + boundary);
  // Đọc bằng stream (có backpressure) thay vì nạp từng khoảng vào RAM.
  (async () => {
    for (const [a, b] of parts) {
      if (res.destroyed) return;
      res.write(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${a}-${b}/${size}\r\n\r\n`);
      await new Promise((ok, fail) => { const rs = fs.createReadStream(p, { start: a, end: b }); rs.on('end', ok); rs.on('error', fail); rs.pipe(res, { end: false }); });
    }
    res.end(`\r\n--${boundary}--\r\n`);
  })().catch(() => res.destroy());
});
app.use('/updates', express.static(UPDATES_DIR, { etag: true, maxAge: 0 }));
// Mô hình nhận dạng giọng nói (tải bằng npm run fetch-stt-model) — app tải về một lần rồi chạy trên máy.
const MODELS_DIR = process.env.MODELS_DIR || path.join(path.dirname(DB_PATH), 'models');
app.use('/models', express.static(MODELS_DIR, { maxAge: '30d', immutable: true }));
const sttReady = () => fs.existsSync(path.join(MODELS_DIR, 'Xenova', 'whisper-base', 'onnx', 'decoder_model_merged_quantized.onnx'));

// Cấu hình ICE cho cuộc gọi (STUN + TURN, thông tin đăng nhập TURN tạm thời).
app.get('/api/ice', requireAuth, wrap(async (req, res) => {
  res.json(await iceConfigFor(req.user.id, req.headers.host, turnEligible(req.user.id, req.query)));
}));

// App báo số byte đã nhận qua TURN Cloudflare (đo hạn mức miễn phí).
app.post('/api/turn/usage', requireAuth, wrap(async (req, res) => {
  rateCheck('signal', req.user.id);
  recordTurn(req.user.id, req.body?.bytes);
  res.json({ ok: true });
}));

// Captcha (ảnh SVG, dùng một lần). Mỗi IP tối đa 60 ảnh / 10 phút.
const capHits = new Map();
app.get('/api/captcha', wrap(async (req, res) => {
  const ip = clientIp(req), now = Date.now();
  const list = (capHits.get(ip) || []).filter((t) => now - t < 600_000);
  if (list.length >= 60) throw httpError(429, 'Yêu cầu captcha quá nhiều — thử lại sau ít phút');
  capHits.set(ip, [...list, now]);
  if (capHits.size > 50_000) capHits.clear();
  res.set('Cache-Control', 'no-store').json(captchaEnabled() ? newCaptcha() : { disabled: true });
}));

// Lỗi ứng dụng gửi về (không kèm nội dung tin). Mỗi IP tối đa 30 lần / 10 phút.
app.post('/api/client-errors', wrap(async (req, res) => {
  const ip = clientIp(req), now = Date.now();
  const list = (capHits.get('e:' + ip) || []).filter((t) => now - t < 600_000);
  if (list.length >= 30) { res.json({ ok: false }); return; }
  capHits.set('e:' + ip, [...list, now]);
  const user = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  recordClientError(user?.id, req.body || {});
  res.json({ ok: true });
}));

app.post('/api/register', wrap(async (req, res) => {
  const ip = clientIp(req);
  checkRegisterIp(ip);
  if (!checkCaptcha(req.body?.captcha)) throw captchaError();
  assertClean(req.body?.username, 'Username'); assertClean(req.body?.displayName, 'Tên hiển thị');
  const out = await register(req.body, { device: deviceLabel(req.body?.device, req.headers['user-agent']), ip: clientIp(req) });
  recordRegisterIp(ip);
  res.json(out);
}));

// ---- Đăng nhập bằng Google ----
const escHtml = (t) => String(t).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const googlePage = (ok, msg, code = '') => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ReaChat</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f4f6fa;color:#1d2330}@media(prefers-color-scheme:dark){body{background:#14171d;color:#e6e9ef}}
div{text-align:center;padding:24px;max-width:440px}b{font-size:20px}.code{font:700 34px/1.2 ui-monospace,Consolas,monospace;letter-spacing:6px;margin:14px 0;padding:10px 16px;border:2px dashed #7a869a;border-radius:12px;user-select:all}.warn{font-size:13px;opacity:.8}</style></head><body><div><b>${ok ? '✅ Đã xác thực với Google' : '⚠️ Chưa đăng nhập được'}</b>
<p>${escHtml(msg)}</p>${code ? `<div class="code">${escHtml(code)}</div><p class="warn">Chỉ nhập mã này vào ứng dụng ReaChat <b>bạn vừa tự mở</b>. Không đọc hay gửi mã cho bất kỳ ai — nếu bạn không đang đăng nhập ReaChat, hãy đóng trang này.</p>` : '<script>setTimeout(()=>window.close(),2500)</script>'}</div></body></html>`;
app.get('/api/auth/google/config', (_req, res) => res.json({ enabled: google.googleEnabled() }));
app.post('/api/auth/google/begin', wrap(async (req, res) => {
  const ip = clientIp(req), now = Date.now();
  const list = (capHits.get('g:' + ip) || []).filter((t) => now - t < 600_000);
  if (list.length >= 20) throw httpError(429, 'Thử lại sau ít phút');
  capHits.set('g:' + ip, [...list, now]);
  let user = null;
  if (req.body?.mode === 'link') { user = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, '')); if (!user) throw httpError(401, 'Chưa xác thực'); }
  res.json(google.begin(req.body?.mode, user?.id));
}));
app.get('/auth/google/start', (req, res) => {
  const url = google.startUrl(req.query.n);
  if (!url) { res.status(410).type('html').send(googlePage(false, 'Phiên đăng nhập đã hết hạn — hãy thử lại từ ứng dụng.')); return; }
  res.redirect(url);
});
app.get('/auth/google/callback', wrap(async (req, res) => {
  const r = await google.callback(req.query);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Frame-Options', 'DENY');
  res.type('html').send(googlePage(r.ok, r.ok ? (r.mode === 'link' ? 'Nhập mã sau vào ứng dụng ReaChat để hoàn tất liên kết:' : 'Nhập mã sau vào ứng dụng ReaChat để đăng nhập:') : r.message, r.ok ? r.code : ''));
}));
app.post('/api/auth/google/poll', wrap(async (req, res) => {
  const user = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const ip = clientIp(req);
  res.json(await google.poll(req.body || {}, user, {
    issueToken, register, ip, checkRegisterIp, recordRegisterIp,
    meta: { device: deviceLabel(req.body?.device, req.headers['user-agent']), ip },
  }));
}));
app.post('/api/me/google/unlink', requireAuth, wrap(async (req, res) => {
  await reauth(req, { allowFresh: false, otp: false });   // gỡ Google không mở thêm quyền gì -> mật khẩu là đủ
  res.json(google.unlink(req.user));
}));

app.post('/api/login', wrap(async (req, res) => {
  res.json(await login(req.body, clientIp(req), { device: deviceLabel(req.body?.device, req.headers['user-agent']) }));
}));

// ---- Bảo mật tài khoản: 2 bước (TOTP), mã khôi phục, đổi mật khẩu ----
app.get('/api/me/storage', requireAuth, wrap(async (req, res) => res.json({ used: usedBytes(req.user.id), quota: QUOTA_BYTES })));
// ---- Thiết bị đăng nhập ----
app.get('/api/me/sessions', requireAuth, wrap(async (req, res) => {
  res.json({ current: req.user.sid || null, sessions: listSessions(req.user.id).map((s) => ({ id: s.id, device: s.device, ip: s.ip, createdAt: s.created_at, lastSeen: s.last_seen })) });
}));
app.delete('/api/me/sessions/:sid', requireAuth, wrap(async (req, res) => {
  if (!revokeSession(req.user.id, req.params.sid)) throw httpError(404, 'Không tìm thấy phiên');
  kickSession(req.user.id, req.params.sid);
  res.json({ ok: true });
}));
app.post('/api/me/sessions/revoke-others', requireAuth, wrap(async (req, res) => {
  const n = revokeOthers(req.user.id, req.user.sid);
  kickOthers(req.user.id, req.user.sid);
  res.json({ ok: true, revoked: n });
}));
// ---- Xóa tài khoản (cần mật khẩu + mã 2 bước nếu bật) ----
app.post('/api/me/delete', requireAuth, wrap(async (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'XOA') throw httpError(400, 'Thiếu xác nhận xóa');
  await reauth(req, { allowFresh: false });
  if (req.user.role === 'admin' && (await import('./db.js')).default.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND banned = 0").get().n <= 1)
    throw httpError(400, 'Đây là quản trị viên cuối cùng — hãy cấp quyền cho người khác trước khi xóa');
  const r = deleteAccount(req.user.id, UPLOAD_DIR);
  kickUser(req.user.id);
  res.json({ ok: true, ...r });
}));
// ---- Tình trạng máy chủ (giám sát) ----
const STARTED = Date.now();
app.get('/health', (_req, res) => {
  let dbOk = false, freeGB = null;
  try { dbOk = (getUserById('__none__'), true); } catch {}
  try { const st = fs.statfsSync(UPLOAD_DIR); freeGB = +((st.bavail * st.bsize) / 1024 ** 3).toFixed(1); } catch {}
  const ok = dbOk && (freeGB == null || freeGB > 1);
  res.status(ok ? 200 : 503).json({ ok, uptimeSec: Math.round((Date.now() - STARTED) / 1000), db: dbOk, diskFreeGB: freeGB, online: onlineCount() });
});
// ---- Điều khoản & Chính sách ----
// Mẫu Điều khoản / Chính sách: điền thông tin đơn vị vận hành máy chủ (OPERATOR_NAME, OPERATOR_CONTACT, LEGAL_UPDATED).
// Đây chỉ là bản mẫu — đơn vị vận hành nên nhờ người có chuyên môn pháp lý rà soát cho phù hợp luật nơi mình hoạt động.
const LEGAL_DIR = fileURLToPath(new URL('../legal', import.meta.url));
const legalVars = { OPERATOR_NAME: process.env.OPERATOR_NAME || 'đơn vị vận hành máy chủ này', OPERATOR_CONTACT: process.env.OPERATOR_CONTACT || '(chưa cấu hình liên hệ)',
  LEGAL_UPDATED: process.env.LEGAL_UPDATED || '28/10/2026' };
app.get('/legal/:page.html', (req, res, next) => {
  const f = path.join(LEGAL_DIR, path.basename(req.params.page) + '.html');
  if (!fs.existsSync(f)) return next();
  res.type('html').send(fs.readFileSync(f, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in legalVars ? legalVars[k].replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) : m)));
});
app.use('/legal', express.static(LEGAL_DIR));

app.get('/api/me/security', requireAuth, wrap(async (req, res) => {
  const c = contactStatus(req.user);
  res.json({ totp: !!req.user.totp_on, recovery: !!req.user.rc_hash, email: c.emailFull, phone: c.phoneFull, channels: notifyChannels(),
    google: req.user.google_sub ? (req.user.google_email || 'đã liên kết') : null, googleEnabled: google.googleEnabled() });
}));
app.post('/api/me/2fa/setup', requireAuth, wrap(async (req, res) => {
  if (req.user.totp_on) throw httpError(400, 'Xác thực 2 bước đang bật');
  const secret = newTotpSecret();
  setTotp(req.user.id, secret, false);                  // chưa bật cho tới khi nhập đúng mã đầu tiên
  res.json({ secret, uri: otpauthUri(req.user.username, secret) });
}));
app.post('/api/me/2fa/enable', requireAuth, wrap(async (req, res) => {
  if (!req.user.totp_secret || !verifyTotp(req.user.id, req.user.totp_secret, req.body?.code)) throw httpError(400, 'Mã không đúng — kiểm tra giờ trên điện thoại');
  setTotp(req.user.id, req.user.totp_secret, true);
  res.json({ ok: true });
}));
app.post('/api/me/2fa/disable', requireAuth, wrap(async (req, res) => {
  if (req.user.totp_on && !verifyTotp(req.user.id, req.user.totp_secret, req.body?.code)) throw httpError(400, 'Mã không đúng');
  setTotp(req.user.id, null, false);
  res.json({ ok: true });
}));
app.post('/api/me/recovery', requireAuth, wrap(async (req, res) => {
  const { verifier, backup } = req.body || {};
  if (!/^[0-9a-f]{64}$/.test(String(verifier || '')) || !backup?.box || String(backup.box).length > 4000) throw httpError(400, 'Dữ liệu mã khôi phục không hợp lệ');
  await reauth(req);
  setRecovery(req.user.id, await bcrypt.hash(verifier, 10), JSON.stringify({ v: backup.v || 2, nonce: backup.nonce, box: backup.box }));
  res.json({ ok: true });
}));
// ---- Email / số điện thoại để khôi phục ----
app.post('/api/me/contact/start', requireAuth, wrap(async (req, res) => {
  await reauth(req);
  res.json(await startContact(req.user, req.body?.kind, req.body?.value));
}));
app.post('/api/me/contact/verify', requireAuth, wrap(async (req, res) => {
  res.json(confirmContact(req.user, req.body?.kind, req.body?.code));
}));
app.post('/api/me/contact/remove', requireAuth, wrap(async (req, res) => {
  res.json(await removeContactInfo(req.user, req.body?.kind, req.body?.password));
}));
// ---- Quên mật khẩu qua email / SMS ----
app.get('/api/forgot/channels', (_req, res) => res.json(notifyChannels()));
app.post('/api/forgot/start', wrap(async (req, res) => {
  res.json(await forgotStart(req.body || {}, clientIp(req)));
}));
app.post('/api/forgot/reset', wrap(async (req, res) => {
  const r = await forgotReset(req.body || {}, clientIp(req), issueToken, { device: deviceLabel(req.body?.device, req.headers['user-agent']) });
  kickUser(r.user.id);
  res.json(r);
}));
app.post('/api/recover', wrap(async (req, res) => {
  const r = await recoverAccount(req.body || {}, clientIp(req));
  kickUser(r.user.id);                                   // mọi phiên cũ (kể cả kẻ đã chiếm tài khoản) bị đăng xuất
  res.json(r);
}));
app.post('/api/me/password', requireAuth, wrap(async (req, res) => {
  const r = await changePassword(req.user, req.body || {});
  kickUser(req.user.id);
  res.json(r);
}));

// Đồng bộ khóa công khai của chính mình (gọi khi mở app).
app.post('/api/me/key', requireAuth, wrap(async (req, res) => {
  // ĐỔI khóa danh tính đã có = mọi tin mới gửi tới khóa đó -> chỉ phiên vừa đăng nhập hoặc có mật khẩu.
  if (req.body?.publicKey && req.user.public_key && req.body.publicKey !== req.user.public_key) await reauth(req);
  setMyPublicKey(req.user.id, req.body?.publicKey);
  res.json({ ok: true });
}));

// Sao lưu khóa danh tính (đa thiết bị). Client mã hóa bằng khóa sinh từ mật khẩu
// trước khi gửi -> server chỉ lưu {v,nonce,box}, không mở được.
app.get('/api/me/keybackup', requireAuth, wrap(async (req, res) => {
  const b = getKeyBackup(req.user.id);
  res.json({ backup: b ? JSON.parse(b) : null });
}));
app.post('/api/me/keybackup', requireAuth, wrap(async (req, res) => {
  const { v, nonce, box } = req.body?.backup || {};
  if (!nonce || !box || String(box).length > 4000) throw httpError(400, 'Bản sao lưu không hợp lệ');
  setKeyBackup(req.user.id, JSON.stringify({ v: v || 1, nonce, box }));
  res.json({ ok: true });
}));

// Cập nhật hồ sơ: tên hiển thị + avatar (data URL nhỏ).
app.post('/api/me/profile', requireAuth, wrap(async (req, res) => {
  const { displayName, avatar } = req.body || {};
  if (avatar && (typeof avatar !== 'string' || avatar.length > 400_000)) throw httpError(400, 'Avatar quá lớn');
  if (avatar && !/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(avatar)) throw httpError(400, 'Avatar phải là ảnh PNG/JPEG/WebP/GIF');
  if (displayName != null && (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 60)) throw httpError(400, 'Tên hiển thị 1–60 ký tự');
  assertClean(displayName, 'Tên hiển thị');
  res.json({ user: publicUser(updateProfile(req.user.id, { displayName, avatar })) });
}));

// Upload file (base64). Trả về metadata để đính vào tin nhắn.
app.post('/api/files', requireAuth, wrap(async (req, res) => {
  const { name, mime, dataB64 } = req.body || {};
  if (!dataB64) throw httpError(400, 'Thiếu dữ liệu file');
  rateCheck('upload', req.user.id);
  const buf = Buffer.from(dataB64, 'base64');
  if (buf.length > MAX_FILE_MB * 1024 * 1024) throw httpError(413, `Tệp vượt ${MAX_FILE_MB} MB`);
  checkQuota(req.user.id, buf.length);
  checkDisk(UPLOAD_DIR, buf.length);
  const id = nanoid();
  fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
  recordFile({ id, name: String(name || 'file').slice(0, 200), mime: String(mime || 'application/octet-stream'), size: buf.length, ownerId: req.user.id });
  res.json({ file: { id, name, mime, size: buf.length } });
}));

// Tải file (xác thực). Client fetch kèm token rồi tạo objectURL.
app.get('/api/files/:id', requireAuth, wrap(async (req, res) => {
  const f = getFile(req.params.id);
  const p = path.join(UPLOAD_DIR, req.params.id);
  if (!f || !fs.existsSync(p)) throw httpError(404, 'Không tìm thấy file');
  if (f.status === 'uploading') throw httpError(409, 'Tệp đang được tải lên');
  // Loại tệp do người gửi tự khai -> chỉ giữ ảnh/âm thanh/video (không SVG), còn lại là octet-stream; luôn nosniff + attachment.
  const mime = /^(image\/(png|jpe?g|gif|webp|avif)|audio\/[\w.+-]+|video\/[\w.+-]+)$/i.test(f.mime || '') ? f.mime : 'application/octet-stream';
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(p, { headers: { 'Content-Type': mime }, acceptRanges: true, cacheControl: false, dotfiles: 'allow' });   // Range -> 206 từng khúc
}));

// ---- Tải lên theo khúc (tệp không giới hạn kích thước; Cloudflare chặn yêu cầu > 100 MB nên phải chia khúc) ----
const MAX_CHUNK = 16 * 1024 * 1024;
const MAX_UPLOAD_GB = Number(process.env.MAX_UPLOAD_GB) || 0;   // 0 = không giới hạn kích thước một tệp
const countUploading = (uid) => rawDb.prepare("SELECT COUNT(*) n FROM files WHERE owner_id = ? AND status = 'uploading'").get(uid).n;
app.post('/api/files/init', requireAuth, wrap(async (req, res) => {
  const { name, mime, size, chunkSize, chunks } = req.body || {};
  const total = Number(size), cs = Number(chunkSize), n = Number(chunks);
  if (!(total > 0) || !(cs > 0 && cs <= MAX_CHUNK) || !(n >= 1) || Math.ceil(total / cs) !== n) throw httpError(400, 'Thông tin tệp không hợp lệ');
  rateCheck('upload', req.user.id);
  if (MAX_UPLOAD_GB && total > MAX_UPLOAD_GB * 1024 ** 3) throw httpError(413, `Tệp vượt ${MAX_UPLOAD_GB} GB — hãy gửi trực tiếp (P2P)`);
  if (countUploading(req.user.id) >= 5) throw httpError(429, 'Đang có quá nhiều tệp tải dở — đợi xong hoặc hủy bớt');
  checkQuota(req.user.id, total);
  checkDisk(UPLOAD_DIR, total);
  const id = nanoid();
  fs.closeSync(fs.openSync(path.join(UPLOAD_DIR, id), 'w'));
  startChunked({ id, name: String(name || 'file').slice(0, 200), mime: String(mime || 'application/octet-stream'), size: total, ownerId: req.user.id, chunkSize: cs, chunks: n });
  res.json({ id });
}));
const ownUploading = (req) => {
  const f = getFile(req.params.id);
  if (!f || f.owner_id !== req.user.id) throw httpError(404, 'Không tìm thấy tệp');
  if (f.status !== 'uploading') throw httpError(409, 'Tệp đã hoàn tất');
  return f;
};
app.put('/api/files/:id/chunk/:n', requireAuth, express.raw({ type: '*/*', limit: MAX_CHUNK + 1024 }), wrap(async (req, res) => {
  const f = ownUploading(req);
  const n = Number(req.params.n);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const expected = n === f.chunks - 1 ? f.size - n * f.chunk_size : f.chunk_size;
  if (!Number.isInteger(n) || n < 0 || n >= f.chunks || buf.length !== expected) throw httpError(400, 'Khúc không hợp lệ');
  checkDisk(UPLOAD_DIR, 0);
  const fd = fs.openSync(path.join(UPLOAD_DIR, f.id), 'r+');
  try { fs.writeSync(fd, buf, 0, buf.length, n * f.chunk_size); } finally { fs.closeSync(fd); }
  addPart(f.id, n);
  res.json({ ok: true });
}));
app.get('/api/files/:id/parts', requireAuth, wrap(async (req, res) => { const f = ownUploading(req); res.json({ parts: listParts(f.id), chunks: f.chunks }); }));
app.post('/api/files/:id/complete', requireAuth, wrap(async (req, res) => {
  const f = ownUploading(req);
  const got = listParts(f.id).length;
  if (got !== f.chunks || fs.statSync(path.join(UPLOAD_DIR, f.id)).size !== f.size) throw httpError(400, `Còn thiếu ${f.chunks - got} khúc`);
  finishChunked(f.id);
  res.json({ file: { id: f.id, size: f.size } });
}));

// Tra cứu người dùng theo username (để bắt đầu hội thoại). Trả về khóa công khai.
// ---- GIF + dịch tin nhắn (nhóm 3) ----
const xHits = new Map();
const xLimit = (key, n) => { const now = Date.now(), l = (xHits.get(key) || []).filter((t) => now - t < 60_000); if (l.length >= n) throw httpError(429, 'Quá nhiều yêu cầu — thử lại sau ít phút'); xHits.set(key, [...l, now]); };
app.get('/api/extras/config', requireAuth, (_req, res) => res.json({ gif: gifEnabled() || libraryCount() > 0, translate: translateEnabled(), stt: sttReady() }));
// Tìm GIF: kho tự quản trước; có cấu hình Klipy/Giphy thì nối thêm kết quả của họ.
app.get('/api/gif/search', requireAuth, wrap(async (req, res) => {
  xLimit('gs:' + req.user.id, 60);
  const lib = req.query.pos ? [] : searchLibrary(req.query.q);
  let ext = { items: [], next: '' };
  if (gifEnabled() && (req.query.q || !lib.length)) { try { ext = await gifSearch(req.query.q, req.query.pos); } catch (e) { if (!lib.length) throw e; } }
  res.json({ items: [...lib, ...ext.items], next: ext.next || '' });
}));
app.get('/api/stickers', requireAuth, (_req, res) => res.json({ packs: stickerPacks() }));
app.get('/api/gif/lib/:id', requireAuth, wrap(async (req, res) => {
  const g = readGif(req.params.id, req.query.use === '1');
  res.set('Cache-Control', 'private, max-age=86400').type(g.mime).sendFile(g.file);
}));
app.get('/api/gif/media', requireAuth, wrap(async (req, res) => {
  xLimit('gm:' + req.user.id, 120);
  const { type, buf } = await gifMedia(req.query.url);
  res.set('Cache-Control', 'private, max-age=86400').type(type).send(buf);
}));
app.post('/api/translate', requireAuth, wrap(async (req, res) => { xLimit('tr:' + req.user.id, 30); res.json(await translate(req.body?.text, req.body?.to || 'vi')); }));

// ---- Trạng thái tự đặt + tự động trả lời ----
app.get('/api/me/status', requireAuth, wrap(async (req, res) => res.json(getStatus(req.user, true))));
app.post('/api/me/status', requireAuth, wrap(async (req, res) => {
  const st = setStatus(req.user.id, req.body || {});
  emitToUser(req.user.id, { type: 'status:changed', status: st });
  res.json(st);
}));

// ---- Đồng bộ tùy chọn giữa các thiết bị (tài liệu đã mã hóa trên máy) ----
app.get('/api/me/sync', requireAuth, wrap(async (req, res) => res.json(getSync(req.user.id))));
app.put('/api/me/sync', requireAuth, wrap(async (req, res) => {
  try {
    const r = putSync(req.user.id, req.body || {});
    emitToUser(req.user.id, { type: 'sync:changed', version: r.version });   // các thiết bị khác tải bản mới
    res.json(r);
  } catch (e) { if (e.status === 409) return res.status(409).json({ error: e.message, current: e.current }); throw e; }
}));

// ---- Xem trước liên kết (máy chủ tải trang thay app; chặn địa chỉ nội bộ). Mỗi người 60 lần / phút. ----
const lpHits = new Map();
app.get('/api/link-preview', requireAuth, wrap(async (req, res) => {
  const now = Date.now(), list = (lpHits.get(req.user.id) || []).filter((t) => now - t < 60_000);
  if (list.length >= 60) throw httpError(429, 'Quá nhiều yêu cầu xem trước');
  lpHits.set(req.user.id, [...list, now]);
  const url = String(req.query.url || '').slice(0, 2000);
  if (!/^https?:\/\//i.test(url)) throw httpError(400, 'URL không hợp lệ');
  res.set('Cache-Control', 'private, max-age=3600').json({ preview: await linkPreview(url) });
}));

// ---- Tìm bạn bè (tên / username / email / SĐT) — đặt TRƯỚC /api/users/:username ----
app.get('/api/users/search', requireAuth, wrap(async (req, res) => {
  const { results, by } = searchUsers(req.user, req.query.q);
  res.json({ by, results: results.map((u) => {
    const out = getRequestBetween(req.user.id, u.id), inc = getRequestBetween(u.id, req.user.id);
    return { ...publicUser(u), relation: areFriends(req.user.id, u.id) ? 'friend' : out?.status === 'pending' ? 'sent' : inc?.status === 'pending' ? 'incoming' : null };
  }) });
}));
app.get('/api/me/privacy', requireAuth, wrap(async (req, res) => res.json(getPrivacy(req.user))));
app.post('/api/me/privacy', requireAuth, wrap(async (req, res) => {
  setPrivacy(req.user.id, req.body || {}); setPrivacy2(req.user.id, req.body || {});
  if (req.body?.hidePresence != null) announcePresence(req.user.id);
  res.json({ ok: true });
}));
// ---- Hồ sơ đầy đủ (giới thiệu, sinh nhật, ảnh bìa) + sinh nhật bạn bè hôm nay ----
app.get('/api/contacts/birthdays', requireAuth, wrap(async (req, res) => res.json({ today: birthdaysToday(req.user.id) })));
app.get('/api/users/:username/profile', requireAuth, wrap(async (req, res) => {
  const p = profileOf(req.user, String(req.params.username || '').toLowerCase());
  if (!p) throw httpError(404, 'Không tìm thấy người dùng');
  res.json({ profile: p });
}));
app.post('/api/me/profile/extra', requireAuth, wrap(async (req, res) => { updateProfileExtra(req.user.id, req.body || {}); res.json({ profile: profileOf(req.user, req.user.username) }); }));

app.get('/api/users/:username', requireAuth, wrap(async (req, res) => {
  const u = getUserByUsername(String(req.params.username || '').toLowerCase());
  if (!u) throw httpError(404, 'Không tìm thấy người dùng');
  res.json({ user: publicUser(u) });
}));

// ---- Danh bạ ----
app.get('/api/contacts', requireAuth, wrap(async (req, res) => {
  res.json({ contacts: listContacts(req.user.id).map(publicUser) });
}));
app.post('/api/contacts', requireAuth, wrap(async (req, res) => {
  const u = getUserByUsername(String(req.body?.username || '').toLowerCase());
  if (!u) throw httpError(404, 'Không tìm thấy người dùng');
  if (u.id === req.user.id) throw httpError(400, 'Không thể tự thêm');
  addContact(req.user.id, u.id);
  res.json({ contact: publicUser(u) });
}));
app.delete('/api/contacts/:username', requireAuth, wrap(async (req, res) => {
  const u = getUserByUsername(String(req.params.username).toLowerCase());
  if (u) removeContact(req.user.id, u.id);
  res.json({ ok: true });
}));

// ---- Chặn ----
app.get('/api/blocks', requireAuth, wrap(async (req, res) => {
  res.json({ blocked: listBlocks(req.user.id).map((id) => publicUser(getUserById(id))).filter(Boolean) });
}));
app.post('/api/block', requireAuth, wrap(async (req, res) => {
  const u = getUserByUsername(String(req.body?.username || '').toLowerCase());
  if (!u) throw httpError(404, 'Không tìm thấy');
  block(req.user.id, u.id);
  res.json({ ok: true });
}));
app.post('/api/unblock', requireAuth, wrap(async (req, res) => {
  const u = getUserByUsername(String(req.body?.username || '').toLowerCase());
  if (u) unblock(req.user.id, u.id);
  res.json({ ok: true });
}));

// ---- Kết bạn (lời mời 2 chiều) ----
app.get('/api/friends/requests', requireAuth, wrap(async (req, res) => {
  res.json({
    incoming: listIncomingRequests(req.user.id).map((r) => ({ id: r.req_id, createdAt: r.createdAt, user: publicUser(r) })),
    outgoing: listOutgoingRequests(req.user.id).map((r) => ({ id: r.req_id, createdAt: r.createdAt, user: publicUser(r) })),
  });
}));
app.post('/api/friends/request', requireAuth, wrap(async (req, res) => {
  rateCheck('friend', req.user.id);
  const u = getUserByUsername(String(req.body?.username || '').toLowerCase().replace(/^@+/, '').trim());
  if (!u) throw httpError(404, 'Không tìm thấy người dùng');
  if (u.id === req.user.id) throw httpError(400, 'Không thể tự kết bạn');
  if (areFriends(req.user.id, u.id)) throw httpError(400, 'Đã là bạn bè');
  // Nếu người kia đã gửi lời mời cho mình -> chấp nhận luôn (kết bạn ngay).
  const reverse = getRequestBetween(u.id, req.user.id);
  if (reverse && reverse.status === 'pending') {
    setRequestStatus(reverse.id, 'accepted');
    makeFriends(req.user.id, u.id);
    emitToUser(u.id, { type: 'friend:accepted', by: publicUser(getUserById(req.user.id)) });
    return res.json({ status: 'friends', user: publicUser(u) });
  }
  createFriendRequest(req.user.id, u.id);
  emitToUser(u.id, { type: 'friend:request', from: publicUser(getUserById(req.user.id)) });
  res.json({ status: 'sent', user: publicUser(u) });
}));
app.post('/api/friends/accept', requireAuth, wrap(async (req, res) => {
  const fr = getFriendRequest(req.body?.id);
  if (!fr || fr.to_id !== req.user.id) throw httpError(404, 'Không tìm thấy lời mời');
  setRequestStatus(fr.id, 'accepted');
  makeFriends(fr.from_id, fr.to_id);
  emitToUser(fr.from_id, { type: 'friend:accepted', by: publicUser(getUserById(req.user.id)) });
  res.json({ ok: true, user: publicUser(getUserById(fr.from_id)) });
}));
app.post('/api/friends/decline', requireAuth, wrap(async (req, res) => {
  const fr = getFriendRequest(req.body?.id);
  if (!fr || fr.to_id !== req.user.id) throw httpError(404, 'Không tìm thấy lời mời');
  setRequestStatus(fr.id, 'declined');
  res.json({ ok: true });
}));

// ---- Story (story) ----
app.get('/api/stories', requireAuth, wrap(async (req, res) => {
  purgeExpiredStories();
  // Hiển thị story của chính mình + bạn bè (danh bạ 2 chiều đã được tạo khi kết bạn).
  // Bạn bè đã ẩn story với mình thì không thấy.
  const friendIds = listContacts(req.user.id).map((u) => u.id).filter((id) => canSeeStoriesOf(req.user.id, id));
  const ids = [req.user.id, ...friendIds];
  const rows = activeStoriesForUsers(ids);
  const stories = rows.map((s) => ({
    id: s.id, userId: s.user_id, kind: s.kind, body: s.body, fileId: s.file_id, bg: s.bg,
    createdAt: s.created_at, expiresAt: s.expires_at,
    mine: s.user_id === req.user.id,
    viewed: hasViewedStory(s.id, req.user.id),
    views: s.user_id === req.user.id ? storyViewCount(s.id) : undefined,
    author: publicUser(getUserById(s.user_id)),
  }));
  res.json({ stories });
}));
app.post('/api/stories', requireAuth, wrap(async (req, res) => {
  const { kind, body, fileId, bg } = req.body || {};
  if (kind === 'image' && !fileId) throw httpError(400, 'Thiếu ảnh');
  if ((kind || 'text') === 'text' && !String(body || '').trim()) throw httpError(400, 'Story trống');
  const s = createStory({ userId: req.user.id, kind, body: String(body || '').slice(0, 500), fileId, bg });
  // Báo bạn bè có story mới.
  const hidden = new Set(storyHiddenFrom(req.user.id));
  for (const f of listContacts(req.user.id)) if (!hidden.has(f.id)) emitToUser(f.id, { type: 'story:new', userId: req.user.id });
  res.json({ story: { id: s.id, kind: s.kind, body: s.body, fileId: s.file_id, bg: s.bg, createdAt: s.created_at, expiresAt: s.expires_at } });
}));
app.post('/api/stories/:id/view', requireAuth, wrap(async (req, res) => {
  const s = getStory(req.params.id);
  if (s && s.user_id !== req.user.id && canSeeStoriesOf(req.user.id, s.user_id)) markStoryViewed(s.id, req.user.id);
  res.json({ ok: true });
}));
app.get('/api/stories/:id/viewers', requireAuth, wrap(async (req, res) => {
  const s = getStory(req.params.id);
  if (!s || s.user_id !== req.user.id) throw httpError(403, 'Không xem được');
  res.json({ viewers: storyViewers(s.id).map((v) => ({ ...publicUser(v), viewedAt: v.viewedAt })) });
}));
// Danh sách người bị ẩn story (thay cả danh sách mỗi lần lưu).
app.get('/api/stories/hidden', requireAuth, wrap(async (req, res) => {
  res.json({ hidden: storyHiddenFrom(req.user.id).map((id) => publicUser(getUserById(id))).filter(Boolean) });
}));
app.put('/api/stories/hidden', requireAuth, wrap(async (req, res) => {
  const names = Array.isArray(req.body?.usernames) ? req.body.usernames.slice(0, 500) : [];
  const ids = [...new Set(names.map((n) => getUserByUsername(String(n).toLowerCase())?.id))].filter((id) => id && id !== req.user.id);
  setStoryHidden(req.user.id, ids);
  res.json({ ok: true, count: ids.length });
}));
app.delete('/api/stories/:id', requireAuth, wrap(async (req, res) => {
  deleteStory(req.params.id, req.user.id);
  res.json({ ok: true });
}));

// TLS: có TLS_CERT + TLS_KEY -> https/wss; không thì http/ws (chỉ nên dùng cho dev trên máy).
const tls = TLS_CERT && TLS_KEY;
// ---- Thông báo đẩy (PWA) ----
app.get('/api/push/key', (_req, res) => res.json({ publicKey: vapidPublicKey() }));
app.post('/api/push/subscribe', requireAuth, wrap(async (req, res) => { pushSubscribe(req.user.id, req.body?.subscription, req.body?.muted || []); res.json({ ok: true }); }));
app.post('/api/push/unsubscribe', requireAuth, wrap(async (req, res) => { pushUnsubscribe(req.user.id, req.body?.endpoint); res.json({ ok: true }); }));
app.post('/api/push/muted', requireAuth, wrap(async (req, res) => { pushSetMuted(req.user.id, req.body?.endpoint, req.body?.muted); res.json({ ok: true }); }));

// ---- Bản web cài được (PWA) tại /app — cùng nguồn với API nên không cần CORS/cấu hình máy chủ ----
app.use('/app', express.static(WEB_DIR, { index: 'index.html', setHeaders: (res, p) => { if (/sw\.js$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('/', (_req, res) => res.redirect('/app/'));

// ---- Bot: quản lý (chủ bot) ----
app.get('/api/bots', requireAuth, wrap(async (req, res) => res.json({ bots: listBots(req.user) })));
app.post('/api/bots', requireAuth, wrap(async (req, res) => res.json(createBot(req.user, req.body || {}))));
app.post('/api/bots/:id/token', requireAuth, wrap(async (req, res) => res.json(regenerateToken(req.user, req.params.id))));
app.post('/api/bots/:id/webhook', requireAuth, wrap(async (req, res) => res.json(setWebhook(req.user, req.params.id, req.body?.url))));
app.delete('/api/bots/:id', requireAuth, wrap(async (req, res) => { deleteBot(req.user, req.params.id); res.json({ ok: true }); }));

// ---- Bot API (Authorization: Bot <token>) ----
const botRoute = (fn) => wrap(async (req, res) => { req.bot = botFromRequest(req); await fn(req, res); });
app.get('/bot/v1/me', botRoute(async (req, res) => res.json({ id: req.bot.id, username: req.bot.username, displayName: req.bot.display_name })));
app.post('/bot/v1/send', botRoute(async (req, res) => {
  const { to, conversationId, text, replyTo } = req.body || {};
  res.json({ message: sendAsUser(req.bot, { to, conversationId, text, replyTo }) });
}));
// Long-poll: trả ngay nếu có tin mới (seq > since), không thì chờ tối đa `timeout` giây (≤ 25).
app.get('/bot/v1/updates', botRoute(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const until = Date.now() + Math.min(25, Math.max(0, Number(req.query.timeout ?? 20))) * 1000;
  let closed = false; req.on('close', () => { closed = true; });
  for (;;) {
    const ups = botUpdates(req.bot, since);
    if (ups.length || Date.now() >= until || closed) return res.json({ updates: ups });
    await new Promise((r) => setTimeout(r, 500));
  }
}));

// ---- Báo cáo vi phạm (người dùng) ----
app.get('/api/reports/reasons', (_req, res) => res.json({ reasons: REASONS }));
app.post('/api/reports', requireAuth, wrap(async (req, res) => {
  res.json(createReport(req.user, req.body || {}));
}));

// ---- Quản trị (role = admin). Trang giao diện: /admin ----
const AUDIT_LABEL = { 'POST /api/admin/users/:id/ban': 'khóa / mở khóa tài khoản', 'POST /api/admin/users/:id/role': 'đổi quyền',
  'POST /api/admin/reports/:id': 'xử lý báo cáo', 'POST /api/admin/messages/:id/remove': 'gỡ tin vi phạm', 'POST /api/admin/gifs': 'thêm GIF/sticker',
  'POST /api/admin/gifs/:id': 'sửa GIF/sticker', 'DELETE /api/admin/gifs/:id': 'xóa GIF/sticker', 'POST /api/admin/moderation': 'sửa danh sách kiểm duyệt' };
const adminRoute = (fn) => wrap(async (req, res) => {
  requireAdmin(req);
  await fn(req, res);
  if (req.method !== 'GET' && res.statusCode < 400) {             // ghi nhật ký sau khi thao tác thành công
    const key = req.method + ' ' + (req.route?.path || req.path);
    const { dataB64, ...rest } = req.body || {};
    const tu = req.params?.id && getUserById(req.params.id);
    audit(req.user.id, AUDIT_LABEL[key] || key, tu ? '@' + tu.username : req.params?.id, Object.keys(rest).length ? JSON.stringify(rest).slice(0, 400) : null);
  }
});
// ---- Kho GIF (quản trị) ----
app.get('/api/admin/gifs', requireAuth, adminRoute(async (req, res) => res.json(listGifs({ q: req.query.q, kind: req.query.kind }))));
app.post('/api/admin/gifs', requireAuth, adminRoute(async (req, res) => res.json(addGif(req.body || {}, req.user.id))));
app.post('/api/admin/gifs/:id', requireAuth, adminRoute(async (req, res) => res.json(updateGif(req.params.id, req.body || {}))));
app.delete('/api/admin/gifs/:id', requireAuth, adminRoute(async (req, res) => res.json(deleteGif(req.params.id))));
app.get('/api/admin/gifs/:id/file', requireAuth, adminRoute(async (req, res) => { const g = readGif(req.params.id, false); res.type(g.mime).sendFile(g.file); }));

app.get('/api/admin/moderation', requireAuth, adminRoute(async (_req, res) => res.json(getModeration())));
app.post('/api/admin/moderation', requireAuth, adminRoute(async (req, res) => res.json(setModeration(req.body || {}))));
app.get('/api/admin/audit', requireAuth, adminRoute(async (_req, res) => res.json({ items: auditLog(200) })));

app.get('/api/admin/stats', requireAuth, adminRoute(async (_req, res) => res.json({ ...adminStats(onlineCount()), turn: turnUsage(),
  clientErrors24h: clientErrors(0).last24h, alerts: recentAlerts().slice(0, 5), alertEnabled: alertEnabled(), db: dbStats() })));
app.get('/api/admin/errors', requireAuth, adminRoute(async (_req, res) => res.json(clientErrors(50))));
app.get('/api/admin/users', requireAuth, adminRoute(async (req, res) => res.json({ users: adminUsers(req.query.q, isUserOnline) })));
app.post('/api/admin/users/:id/ban', requireAuth, adminRoute(async (req, res) => {
  const banned = req.body?.banned !== false;
  setBan(req.user.id, req.params.id, banned, req.body?.reason);
  if (banned) kickUser(req.params.id);                     // đăng xuất ngay trên mọi thiết bị
  res.json({ ok: true });
}));
app.post('/api/admin/users/:id/role', requireAuth, adminRoute(async (req, res) => {
  if (req.params.id === req.user.id) throw httpError(400, 'Không tự đổi vai trò của mình');
  setRole(req.params.id, req.body?.role || null);
  res.json({ ok: true });
}));
app.get('/api/admin/reports', requireAuth, adminRoute(async (req, res) => res.json({ reports: adminReports(req.query.status) })));
app.post('/api/admin/reports/:id', requireAuth, adminRoute(async (req, res) => { handleReport(req.user.id, Number(req.params.id), req.body || {}); res.json({ ok: true }); }));
app.post('/api/admin/messages/:id/remove', requireAuth, adminRoute(async (req, res) => {
  const { message, fileId } = removeMessage(req.params.id);
  if (fileId) { try { fs.unlinkSync(path.join(UPLOAD_DIR, fileId)); } catch {} }
  broadcastMessageUpdate(message);
  res.json({ ok: true });
}));
app.use('/admin', express.static(fileURLToPath(new URL('../admin', import.meta.url))));

// Dọn tệp mồ côi (tải lên nhưng không tin/story nào dùng) — lúc khởi động và mỗi 6 giờ.
const runSweep = () => { try { const r = sweepOrphans(UPLOAD_DIR); if (r.removed) console.log(`Dọn ${r.removed} tệp mồ côi (${(r.freed / 1048576).toFixed(1)} MB)`); } catch (e) { console.warn('Dọn tệp lỗi:', e.message); } };
setTimeout(runSweep, 10_000).unref?.();
setInterval(runSweep, 6 * 3600_000).unref?.();

// Lỗi ném ngoài wrap() (vd. requireAuth) -> luôn trả JSON (mặc định Express trả trang HTML, client không đọc được).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: `Tệp vượt ${MAX_FILE_MB} MB` });
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Lỗi máy chủ' });
});

const server = tls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
  : http.createServer(app);
attachWebSocket(server);
startTurn();

startWatchdog({ uploadDir: UPLOAD_DIR, minFreeGB: Number(process.env.MIN_FREE_GB) || 2, turnUsage });
if (alertEnabled()) alert('khoi-dong', 'Máy chủ vừa khởi động' + (process.uptime() < 60 ? ' (nếu không phải do bạn cập nhật/khởi động lại thì máy chủ vừa bị sập)' : ''), { force: true });
server.listen(PORT, () => {
  const [h, w] = tls ? ['https', 'wss'] : ['http', 'ws'];
  console.log(`ReaChat server: ${h}://localhost:${PORT}  (${w}://localhost:${PORT}/ws)`);
  if (tls) console.log('Vân tay chứng chỉ SHA-256:', new crypto.X509Certificate(fs.readFileSync(TLS_CERT)).fingerprint256);
  else console.log('CẢNH BÁO: đang chạy KHÔNG mã hóa truyền tải. Bật TLS: npm run gencert && npm run start:tls');
});

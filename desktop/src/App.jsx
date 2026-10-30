import React, { useEffect, useRef, useState, useCallback, useContext, createContext, Fragment } from 'react';
import * as api from './api.js';
import * as crypto from './crypto.js';
import * as ratchet from './ratchet.js';
import { CallSession } from './call.js';
import { GroupCall } from './groupcall.js';
import { CallRecorder } from './recorder.js';
import { uploadChunked, downloadChunked, openSink, BIG_THRESHOLD } from './bigfile.js';
import { startSend, startReceive } from './p2pfile.js';
import { getLang, setLang, translateText } from './i18n.js';
import QRCode from 'qrcode';
import { scanScam } from './safety.js';
import { summarize } from './summarize.js';
import * as Y from 'yjs';
import jsQR from 'jsqr';
import { playMessage, startRing, getSoundPrefs, setSoundPrefs } from './sound.js';
import { mergeDocs, mergeGroupKey, emptyDoc, docHash } from './syncdoc.js';
import { transcribe } from './stt.js';

// Cung cấp hàm lấy objectURL cho media (tự giải mã nếu file đã mã hóa).
const MediaCtx = createContext(async () => { throw new Error('no media resolver'); });
// Cung cấp dữ liệu bình chọn cho MessageContent (tránh truyền prop sâu).
const PollCtx = createContext({ tallies: {}, onVote: () => {}, requestPoll: () => {}, myUsername: '', rsvps: {}, onRsvp: () => {}, requestRsvp: () => {} });

const db = window.reachat.db;
// Nội dung giữ chỗ khi giải mã thất bại -> có thể thử lại sau khi đồng bộ khóa.
const DECRYPT_FAIL = new Set(['[không giải mã được]', '[chưa có khóa nhóm]', '[tin của bạn]']);
// Loại tin có NỘI DUNG mã hóa như text (E2E): chữ, sticker, danh thiếp.
const TEXTLIKE = new Set(['text', 'sticker', 'contact', 'p2pfile', 'location', 'event']);   // location: tọa độ mã hóa như text   // p2pfile: ghi nhận tệp đã gửi trực tiếp (mã hóa như text)
// Tương tác app cho nội dung tin (danh thiếp: nhắn tin / kết bạn).
const AppCtx = createContext({ openDirect: () => {}, addFriend: () => {}, me: '' });
const SESSION_KEY = 'reachat.session';
const directConvId = (a, b) => 'dm_' + [a, b].sort().join('_');
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡'];
// Bảng emoji chèn vào ô soạn tin.
const EMOJI_PICKER = ['😀','😁','😂','🤣','😊','😍','😘','😎','🤔','😴','😭','😡','👍','👎','👏','🙏','💪','🎉','🔥','❤️','💔','✨','🌟','🎵','☕','🍺','🍕','⚽','🚀','💯'];
// Sticker = emoji cỡ lớn gửi nhanh.
const STICKERS = ['😂','😍','😭','😡','👍','🎉','❤️','🔥','🙏','👏','🥳','😎','🤗','😅','🤩','💯'];

function loadPeers(u) { try { return JSON.parse(localStorage.getItem('reachat.peers.' + u) || '{}'); } catch { return {}; } }
function savePeers(u, p) { localStorage.setItem('reachat.peers.' + u, JSON.stringify(p)); }
function loadGroupKeys(u) { try { return JSON.parse(localStorage.getItem('reachat.groupkeys.' + u) || '{}'); } catch { return {}; } }
function saveGroupKeys(u, g) { localStorage.setItem('reachat.groupkeys.' + u, JSON.stringify(g)); }
// Trạng thái Double Ratchet mỗi hội thoại 1-1 (localStorage, serialize base64).
const rkKey = (u, convId) => 'reachat.ratchet.' + u + '.' + convId;
function loadRatchet(u, convId) { try { const s = localStorage.getItem(rkKey(u, convId)); return s ? ratchet.deserialize(s) : null; } catch { return null; } }
function saveRatchet(u, convId, st) { try { localStorage.setItem(rkKey(u, convId), ratchet.serialize(st)); } catch {} }
// Khóa giải từng ảnh/tệp DR 1-1 (ratchet message key theo fileId; lưu để sống qua reload).
function loadMediaKeys(u) { try { return JSON.parse(localStorage.getItem('reachat.mediakeys.' + u) || '{}'); } catch { return {}; } }
function saveMediaKeys(u, m) { try { localStorage.setItem('reachat.mediakeys.' + u, JSON.stringify(m)); } catch {} }

const fmtTime = (t) => new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
// Đang trong giờ yên lặng? (hỗ trợ khung qua đêm, vd 22:00 -> 07:00)
const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const isQuietNow = (q, d = new Date()) => {
  if (!q?.enabled) return false;
  const now = d.getHours() * 60 + d.getMinutes(), a = toMin(q.from), b = toMin(q.to);
  return a === b ? true : a < b ? now >= a && now < b : now >= a || now < b;
};
// Lưu tệp: app desktop -> hộp thoại "Lưu thành"; web -> tải xuống. Trả về đường dẫn (desktop) hoặc tên tệp.
const fmtSize = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

async function saveFile(name, blob, kind) {
  if (window.reachat?.files) return window.reachat.files.save(name, new Uint8Array(await blob.arrayBuffer()), kind);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return name;
}

// Thời lượng m:ss (h:mm:ss nếu quá 1 giờ) — tin thoại, lịch sử cuộc gọi.
const fmtDur = (s) => { s = Math.round(s || 0); const mm = String(Math.floor(s / 60) % 60), ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${Math.floor(s / 60)}:${ss}`; };
const fmtAgo = (t) => {
  const d = Date.now() - (t || 0);
  if (d < 60000) return 'vừa xong';
  if (d < 3600000) return `${Math.floor(d / 60000)} phút trước`;
  return `${Math.floor(d / 3600000)} giờ trước`;
};
// Mô tả ngắn một tin cho khung trả lời / trích dẫn.
const msgPreview = (mm) => mm.recalled ? '(đã thu hồi)'
  : mm.type === 'sticker' ? mm.body
  : mm.type === 'contact' ? '👤 Danh thiếp'
  : mm.type === 'poll' ? '📊 Bình chọn'
  : mm.type === 'call' ? '📞 Cuộc gọi'
  : mm.type === 'p2pfile' ? '📦 Tệp gửi trực tiếp'
  : mm.type === 'location' ? '📍 Vị trí'
  : mm.type === 'voice' ? '🎤 Tin thoại'
  : mm.type === 'video' ? '🎬 Video'
  : mm.type === 'autoreply' ? '🤖 Tự động trả lời'
  : mm.type === 'event' ? '📅 Sự kiện'
  : mm.type === 'image' ? '🖼 Hình ảnh'
  : mm.type === 'file' ? '📄 Tệp đính kèm'
  : (mm.body || '');
const callInfo = (m) => { try { return JSON.parse(m.body); } catch { return null; } };
const fmtLastSeen = (t) => {
  if (!t) return 'ngoại tuyến';
  const d = Date.now() - t;
  if (d < 60000) return 'vừa truy cập';
  if (d < 3600000) return `truy cập ${Math.floor(d / 60000)} phút trước`;
  if (d < 86400000) return `truy cập ${Math.floor(d / 3600000)} giờ trước`;
  return 'truy cập ' + new Date(t).toLocaleDateString('vi-VN');
};
const fileToBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej; r.readAsDataURL(file);
});

export default function App() {
  const [session, setSession] = useState(() => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } });
  const onLogin = (s) => { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); setSession(s); };
  const onLogout = () => { localStorage.removeItem(SESSION_KEY); setSession(null); };
  // Phiên bị thu hồi (đổi mật khẩu ở máy khác / tài khoản bị khóa) -> về màn đăng nhập.
  useEffect(() => {
    const h = () => { if (window.__reachatPwChange) return; if (localStorage.getItem(SESSION_KEY)) { localStorage.removeItem(SESSION_KEY); setSession(null); setTimeout(() => alertLogout(), 50); } };
    window.addEventListener('reachat:unauthorized', h);
    return () => window.removeEventListener('reachat:unauthorized', h);
  }, []);
  const onUpdateToken = (token) => setSession((s) => { const n = { ...s, token }; localStorage.setItem(SESSION_KEY, JSON.stringify(n)); api.setToken(token); return n; });
  const onUpdateUser = (user) => setSession((s) => { const n = { ...s, user: { ...s.user, ...user } }; localStorage.setItem(SESSION_KEY, JSON.stringify(n)); return n; });

  return (<>
    {!session ? <AuthScreen onLogin={onLogin} />
      : <><Chat key={session.user.id} session={session} onLogout={onLogout} onUpdateUser={onUpdateUser} onUpdateToken={onUpdateToken} />
          <AppLock username={session.user.username} onLogout={onLogout} /></>}
    <UpdateBar />
  </>);
}

// ---- Thanh cập nhật ứng dụng (chỉ app desktop đã đóng gói) ----
function UpdateBar() {
  const [st, setSt] = useState(null);
  useEffect(() => window.reachat.updates?.onStatus((x) => setSt(x)), []);
  if (!st || !['downloading', 'ready', 'available'].includes(st.state)) return null;
  return (<div className="update-bar" role="status">
    {st.state === 'ready' ? (<>
      <span>⬆️ Bản <b>{st.version}</b> đã sẵn sàng</span>
      <button className="primary" onClick={() => window.reachat.updates.install()}>Khởi động lại để cập nhật</button>
      <button className="link" onClick={() => setSt(null)}>Để sau</button>
    </>) : (<>
      <span>⬇️ Đang tải bản cập nhật{st.version ? ' ' + st.version : ''}…</span>
      {st.percent != null && <progress max="100" value={st.percent} />}
    </>)}
  </div>);
}

// ---- Cấu hình máy chủ: địa chỉ + ghim chứng chỉ TLS (chống nghe lén/giả mạo máy chủ) ----
function ServerSettings() {
  const cfgApi = window.reachat.config;
  const cur = cfgApi?.get() || { serverUrl: window.reachat.serverUrl, secure: !!window.reachat.transport?.secure };
  const [url, setUrl] = useState(cur.serverUrl);
  const [fp, setFp] = useState(cur.certFingerprint || '');
  const [probe, setProbe] = useState(null);
  const [msg, setMsg] = useState('');
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(cur.serverUrl);
  const badge = cur.secure ? (cur.pinned ? ['ok', '🔒 TLS · đã ghim chứng chỉ'] : ['', '🔒 TLS · tin CA hệ thống']) : [local ? '' : 'bad', local ? 'Không mã hóa (máy cục bộ)' : '⚠️ KHÔNG mã hóa truyền tải'];
  const check = async () => { setMsg(''); setProbe({ loading: true }); setProbe(await cfgApi.probe(url)); };
  const save = async () => { try { setMsg(''); await cfgApi.set({ serverUrl: url, certFingerprint: url.startsWith('https:') ? fp : '' }); } catch (e) { setMsg(e.message); } };
  return (<details className="server-cfg" open={!cur.secure && !local}>
    <summary>Máy chủ: {cur.serverUrl} <span className={'tls-badge ' + badge[0]}>{badge[1]}</span></summary>
    {!cfgApi ? <div className="muted small">Bản web dùng máy chủ của trang hiện tại.</div> : (<>
      <input value={url} onChange={(e) => { setUrl(e.target.value); setProbe(null); }} placeholder="https://chat.congty.vn:4000" />
      {url.startsWith('https:') && <input className="fp" value={fp} onChange={(e) => setFp(e.target.value)} placeholder="Vân tay SHA-256 để ghim (AA:BB:…) — để trống = tin CA hệ thống" />}
      {url.startsWith('http:') && !/\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url) && <div className="error small">Kết nối http không mã hóa — mật khẩu/token có thể bị nghe lén. Hãy dùng https.</div>}
      {probe && !probe.loading && (probe.error ? <div className="error small">{probe.error}</div> : probe.secure ? (
        <div className="small">Chứng chỉ: <b>{probe.subject}</b> {probe.trustedByCA ? '(CA tin cậy)' : '(tự ký / CA lạ)'}<div className="fp muted">{probe.fingerprint}</div>
          <div className="muted">So khớp với vân tay máy chủ in ra khi khởi động, rồi bấm “Ghim”.</div>
          <button type="button" className="mini" onClick={() => setFp(probe.fingerprint)}>Ghim vân tay này</button></div>) : <div className="muted small">Máy chủ http — không có chứng chỉ.</div>)}
      {msg && <div className="error small">{msg}</div>}
      <div className="row">
        {url.startsWith('https:') && <button type="button" className="ghost" onClick={check}>{probe?.loading ? '…' : 'Kiểm tra chứng chỉ'}</button>}
        <button type="button" className="primary" onClick={save}>Lưu & kết nối lại</button>
      </div>
      {window.reachat.version && <div className="muted small" style={{ marginTop: 8 }}>Phiên bản {window.reachat.version}
        {window.reachat.updates && <> · <button type="button" className="link" onClick={() => window.reachat.updates.check()}>Kiểm tra cập nhật</button></>}</div>}
    </>)}
  </details>);
}

// ---------------------------------------------------------------- Auth
function alertLogout() { try { sessionStorage.setItem('reachat.loggedOutReason', window.__reachatLogoutMsg || 'Phiên đăng nhập đã hết hiệu lực (mật khẩu vừa đổi, thiết bị này bị đăng xuất từ máy khác, hoặc tài khoản bị khóa). Vui lòng đăng nhập lại.'); window.dispatchEvent(new Event('reachat:logoutReason')); } catch {} }

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('login');          // login | register | recover
  const [otp, setOtp] = useState(''); const [need2fa, setNeed2fa] = useState(false);
  const [rcode, setRcode] = useState('');
  const [rmode, setRmode] = useState('code');          // cách khôi phục: code | email | sms
  const [chan, setChan] = useState({});                // kênh máy chủ hỗ trợ {email, sms}
  const [vcode, setVcode] = useState(''), [sent, setSent] = useState(false);
  const [terms, setTerms] = useState(false);
  const [captcha, setCaptcha] = useState(null), [capKey, setCapKey] = useState(0), [needCap, setNeedCap] = useState(false);
  const [gOn, setGOn] = useState(false), [gflow, setGflow] = useState(null);
  const [qrFlow, setQrFlow] = useState(false);
  useEffect(() => { api.googleConfig().then((c) => setGOn(!!c.enabled)); }, []);
  useEffect(() => { if (mode === 'recover') api.forgotChannels().then(setChan); }, [mode]);
  const showCap = mode === 'register' || (mode === 'login' && needCap) || (mode === 'recover' && rmode !== 'code' && !sent);
  const sendCode = async () => {
    setErr(''); setBusy(true);
    try { const r = await api.forgotStart(username.trim(), rmode, captcha); setSent(true); setNotice(r.message + (r.devCode ? ' [dev: ' + r.devCode + ']' : '')); }
    catch (e) { setErr(e.message); } finally { setBusy(false); setCapKey((k) => k + 1); }
  };
  const [notice, setNotice] = useState(() => { const r = sessionStorage.getItem('reachat.loggedOutReason'); sessionStorage.removeItem('reachat.loggedOutReason'); return r || ''; });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const uname = username.toLowerCase().trim();
      let res;
      if (mode === 'register') {
        if (!terms) throw new Error('Bạn cần đồng ý Điều khoản sử dụng và Chính sách quyền riêng tư');
        res = await api.register({ username: uname, password, displayName, publicKey: crypto.publicKeyBase64(uname), acceptTerms: true, captcha });
        await api.putKeyBackup(res.token, await crypto.sealKeyBackup(uname, password));
      } else if (mode === 'recover' && rmode !== 'code') {
        // Quên mật khẩu qua mã email/SMS. Bản sao lưu khóa (bọc bằng mật khẩu cũ) đã bị xóa trên máy chủ:
        // máy còn giữ khóa -> bọc lại bằng mật khẩu mới (giữ nguyên lịch sử); máy không có -> tạo khóa mới.
        if (password.length < 6) throw new Error('Mật khẩu mới tối thiểu 6 ký tự');
        res = await api.forgotReset({ ident: username.trim(), code: vcode.trim(), newPassword: password, ...(need2fa ? { otp } : {}) });
        const un = res.user.username;
        if (!crypto.hasLocalKeys(un)) localStorage.setItem('reachat.keyReset.' + un, '1');
        await api.putKeyBackup(res.token, await crypto.sealKeyBackup(un, password));
        await api.uploadKey(res.token, crypto.publicKeyBase64(un));
      } else if (mode === 'recover') {
        // Quên mật khẩu: chứng minh mã khôi phục -> mật khẩu mới; dựng lại khóa từ bản sao lưu bọc bằng mã.
        if (password.length < 6) throw new Error('Mật khẩu mới tối thiểu 6 ký tự');
        res = await api.recoverAccount({ username: uname, verifier: await crypto.recoveryVerifier(uname, rcode), newPassword: password });
        if (res.recoveryBackup && !(await crypto.openRecoveryBackup(uname, rcode, res.recoveryBackup))) throw new Error('Không mở được bản sao lưu khóa bằng mã khôi phục');
        localStorage.setItem('reachat.resync.' + uname, '1');
        await api.putKeyBackup(res.token, await crypto.sealKeyBackup(uname, password));   // bọc lại bằng mật khẩu mới
        await api.uploadKey(res.token, crypto.publicKeyBase64(uname));
        localStorage.setItem('reachat.rcUsed.' + uname, '1');   // mã đã dùng -> nhắc tạo mã mới
      } else {
        // Đăng nhập KHÔNG gửi publicKey: đồng bộ khóa danh tính từ bản sao lưu trước,
        // tránh máy mới ghi đè khóa -> mọi thiết bị dùng chung 1 khóa (Cloud, nhóm, tin cũ).
        res = await api.login({ username: uname, password, ...(need2fa ? { otp } : {}), ...(needCap ? { captcha } : {}) });
        const backup = await api.getKeyBackup(res.token);
        if (backup) {
          if (!(await crypto.openKeyBackup(uname, password, backup))) throw new Error('Không mở được bản sao lưu khóa');
          localStorage.setItem('reachat.resync.' + uname, '1'); // giải mã lại tin từng lỗi bằng khóa đồng bộ
        }
        // Tải lên bản sao lưu (đã gộp khóa cũ của máy này) -> thiết bị khác cũng nhận được.
        await api.putKeyBackup(res.token, await crypto.sealKeyBackup(uname, password));
        await api.uploadKey(res.token, crypto.publicKeyBase64(uname));
      }
      onLogin(res);
    } catch (e) {
      if (showCap || e.needCaptcha) setCapKey((k) => k + 1);         // captcha dùng một lần -> lấy ảnh mới
      if (e.needCaptcha) setNeedCap(true);
      if (e.need2fa) { setNeedCap(false); setNeed2fa(true); if (otp) setErr(e.message); setOtp(''); return; }
      setErr(e instanceof TypeError ? 'Không kết nối được máy chủ ' + window.reachat.serverUrl + (window.reachat.transport?.secure ? ' — nếu máy chủ dùng chứng chỉ tự ký, mở “Máy chủ” bên dưới để kiểm tra và ghim vân tay.' : '.') : e.message);
    } finally { setBusy(false); }
  };
  if (qrFlow) return <div className="auth"><QrLoginFlow onLogin={onLogin} onCancel={(m) => { setQrFlow(false); setErr(m || ''); }} /></div>;
  if (gflow) return <div className="auth"><GoogleFlow nonce={gflow.nonce} onLogin={onLogin} onCancel={(m) => { setGflow(null); setErr(m || ''); }} /></div>;
  const startGoogle = async () => {
    setErr('');
    if (!gOn) { setErr('Máy chủ ' + window.reachat.serverUrl + ' chưa bật đăng nhập Google. Mở mục “Máy chủ” bên dưới và chuyển sang máy chủ có hỗ trợ.'); return; }
    try { const b = await api.googleBegin('login'); window.open(b.url, '_blank'); setGflow({ nonce: b.nonce }); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>ReaChat</h1><p className="muted">Ứng dụng nhắn tin desktop độc lập</p>
        {notice && <div className="notice small">{notice}</div>}
        {mode !== 'recover' && <div className="tabs">
          <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr(''); }}>Đăng nhập</button>
          <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setNeed2fa(false); setErr(''); }}>Đăng ký</button>
        </div>}
        {mode === 'recover' && <div className="tabs">
          <button type="button" className={rmode === 'code' ? 'on' : ''} onClick={() => { setRmode('code'); setErr(''); }}>Mã khôi phục</button>
          {chan.email && <button type="button" className={rmode === 'email' ? 'on' : ''} onClick={() => { setRmode('email'); setSent(false); setErr(''); }}>Email</button>}
          {chan.sms && <button type="button" className={rmode === 'sms' ? 'on' : ''} onClick={() => { setRmode('sms'); setSent(false); setErr(''); }}>SMS</button>}
        </div>}
        {mode === 'recover' && rmode === 'code' && <div className="muted small">🔑 Khôi phục bằng <b>mã khôi phục</b> (đã tạo trong Cài đặt → Bảo mật). Mã chỉ dùng được một lần. Lịch sử mã hóa được giữ nguyên.</div>}
        {mode === 'recover' && rmode !== 'code' && <div className="muted small">{rmode === 'email' ? '✉️ Gửi mã 6 số tới email' : '📱 Gửi mã 6 số qua SMS tới số điện thoại'} đã xác minh trong Cài đặt → Bảo mật.
          Nếu máy này chưa từng đăng nhập tài khoản, tin nhắn mã hóa cũ sẽ không đọc được trên máy này.</div>}
        <input placeholder={mode === 'recover' && rmode !== 'code' ? 'username, email hoặc số điện thoại' : 'username'} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        {mode === 'register' && <input placeholder="Tên hiển thị" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
        {mode === 'recover' && rmode === 'code' && <input placeholder="Mã khôi phục (XXXX-XXXX-…)" value={rcode} onChange={(e) => setRcode(e.target.value)} />}
        {mode === 'recover' && rmode !== 'code' && <div className="row-inline">
          <input className="otp-input" inputMode="numeric" maxLength={6} placeholder="Mã 6 số" value={vcode} onChange={(e) => setVcode(e.target.value)} disabled={!sent} />
          <button type="button" className="ghost" disabled={busy || !username.trim()} onClick={sendCode}>{sent ? 'Gửi lại mã' : 'Gửi mã'}</button>
        </div>}
        {(mode !== 'recover' || rmode === 'code' || sent) && <input type="password" placeholder={mode === 'recover' ? 'mật khẩu MỚI' : 'mật khẩu'} value={password} onChange={(e) => setPassword(e.target.value)} />}
        {need2fa && mode === 'recover' && rmode !== 'code' && <input className="otp-input" inputMode="numeric" maxLength={7} placeholder="Mã 6 số từ ứng dụng xác thực" value={otp} onChange={(e) => setOtp(e.target.value)} />}
        {mode === 'register' && <label className="check-row small terms-row"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
          <span>Tôi đồng ý <a href={api.serverBase() + '/legal/terms.html'} target="_blank" rel="noreferrer">Điều khoản sử dụng</a> và <a href={api.serverBase() + '/legal/privacy.html'} target="_blank" rel="noreferrer">Chính sách quyền riêng tư</a></span></label>}
        {need2fa && mode === 'login' && <input className="otp-input" inputMode="numeric" maxLength={7} placeholder="Mã 6 số từ ứng dụng xác thực" value={otp} onChange={(e) => setOtp(e.target.value)} autoFocus />}
        {showCap && <CaptchaBox key={capKey} onChange={setCaptcha} />}
        {err && <div className="error">{err}</div>}
        <button className="primary" disabled={busy || (mode === 'recover' && rmode !== 'code' && !sent)}>{busy ? '...' : (mode === 'register' ? 'Tạo tài khoản' : mode === 'recover' ? 'Đặt mật khẩu mới & vào' : need2fa ? 'Xác nhận mã' : 'Vào')}</button>
        {mode !== 'recover' && <>
          <div className="or-line"><span>hoặc</span></div>
          <button type="button" className="google-btn" onClick={startGoogle}><GoogleG /> <span>{mode === 'register' ? 'Đăng ký bằng Google (Gmail)' : 'Đăng nhập bằng Google (Gmail)'}</span></button>
          {mode === 'login' && <button type="button" className="ghost qr-login-btn" onClick={() => { setErr(''); setQrFlow(true); }}>📱 Đăng nhập bằng mã QR</button>}
        </>}
        {mode === 'login' && <button type="button" className="link small" onClick={() => { setMode('recover'); setErr(''); setNeed2fa(false); }}>Quên mật khẩu?</button>}
        {mode === 'recover' && <button type="button" className="link small" onClick={() => { setMode('login'); setErr(''); setNeed2fa(false); setSent(false); }}>← Quay lại đăng nhập</button>}
        <ServerSettings />
        <button type="button" className="link small lang-switch" onClick={() => setLang(getLang() === 'en' ? 'vi' : 'en')}><span data-user-content>{getLang() === 'en' ? 'Tiếng Việt' : 'English'}</span></button>
      </form>
    </div>
  );
}

// Captcha: ảnh SVG do máy chủ vẽ (hiển thị qua <img> — không chạy mã), mỗi ảnh dùng một lần.
function CaptchaBox({ onChange }) {
  const [c, setC] = useState(null), [ans, setAns] = useState(''), [n, setN] = useState(0);
  useEffect(() => { let live = true; setAns(''); onChange(null);
    api.getCaptcha().then((r) => { if (!live) return; setC(r); if (r.disabled) onChange({ id: '', answer: '' }); }).catch(() => setC({ error: true }));
    return () => { live = false; }; }, [n]);
  if (!c || c.disabled) return null;
  if (c.error) return <div className="error small">Không tải được captcha. <button type="button" className="link small" onClick={() => setN(n + 1)}>Thử lại</button></div>;
  return (<div className="captcha-box">
    <img src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(c.svg)} alt="captcha" width={200} height={64} />
    <button type="button" className="ghost mini" title="Đổi ảnh khác" onClick={() => setN(n + 1)}>↻</button>
    <input placeholder="Nhập 5 ký tự trong ảnh" value={ans} maxLength={8} autoComplete="off"
      onChange={(e) => { setAns(e.target.value); onChange({ id: c.id, answer: e.target.value }); }} />
  </div>);
}
const GoogleG = () => (<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>);

// Luồng đăng nhập Google: chờ xác thực trên trình duyệt -> (mã 2 bước) -> (tạo tài khoản mới) -> mở khóa tin mã hóa.
// Đăng nhập máy mới bằng QR: hiện mã, máy đang đăng nhập quét + duyệt -> nhận token và khóa danh tính (niêm phong cho
// khóa tạm của máy này, máy chủ không đọc được) -> không cần mật khẩu, vẫn đọc được lịch sử mã hóa.
function QrLoginFlow({ onLogin, onCancel }) {
  const [qr, setQr] = useState(null), [code, setCode] = useState(''), [left, setLeft] = useState(0), [err, setErr] = useState(''), [round, setRound] = useState(0);
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        setErr(''); setQr(null);
        const eph = crypto.newEphemeral();
        const secret = btoa(String.fromCharCode(...window.crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
        const b = await api.qrLoginBegin(eph.publicKey, secret);
        const text = `reachat-login:${b.sid}.${eph.publicKey}`;
        if (stop) return;
        setCode(text); setQr(await QRCode.toDataURL(text, { margin: 1, width: 240 }));
        while (!stop && Date.now() < b.expiresAt) {
          setLeft(Math.max(0, Math.round((b.expiresAt - Date.now()) / 1000)));
          const r = await api.qrLoginPoll(b.sid, secret).catch((e) => { if (e.status === 410) return { expired: true }; throw e; });
          if (stop) return;
          if (r.expired) break;
          if (!r.pending) {
            const un = r.user.username;
            if (!crypto.openKeyBundle(un, r.sealed, eph.secretKey)) throw new Error('Không mở được gói khóa mã hóa — hãy thử lại');
            localStorage.setItem('reachat.resync.' + un, '1');          // tải lại lịch sử để giải mã bằng khóa vừa nhận
            onLogin({ token: r.token, user: r.user }); return;
          }
          await new Promise((ok) => setTimeout(ok, 2000));
        }
        if (!stop) { setQr(null); setErr('Mã đã hết hạn.'); }
      } catch (e) { if (!stop) setErr(e.message || String(e)); }
    })();
    return () => { stop = true; };
  }, [round]);
  return (<div className="auth-card qr-login">
    <h2>📱 Đăng nhập bằng mã QR</h2>
    <p className="muted small">Trên máy <b>đang đăng nhập</b> ReaChat: Cài đặt → Bảo mật → <b>Đăng nhập máy khác bằng QR</b>, rồi quét mã này (hoặc dán mã bên dưới).</p>
    {qr ? <img className="qr-img" src={qr} alt="Mã QR đăng nhập" data-code={code} /> : !err && <div className="spinner" />}
    {qr && <div className="muted small">Hết hạn sau {left} giây</div>}
    {qr && <button type="button" className="link small" onClick={() => { navigator.clipboard?.writeText(code); }}>📋 Sao chép mã (dán ở máy kia)</button>}
    {err && <div className="error">{err}</div>}
    {err && <button type="button" className="primary" onClick={() => setRound((n) => n + 1)}>Tạo mã mới</button>}
    <p className="notice small">⚠️ Chỉ quét mã hiện trên <b>máy của chính bạn</b>. Người khác đưa bạn quét mã là để chiếm tài khoản.</p>
    <button type="button" className="link small" onClick={() => onCancel('')}>← Quay lại đăng nhập</button>
  </div>);
}

// Tin nhắn mã hóa đầu-cuối được bọc bằng MẬT KHẨU ReaChat: máy mới phải nhập mật khẩu để đọc lịch sử.
function GoogleFlow({ nonce, onLogin, onCancel }) {
  const [stage, setStage] = useState('wait');          // wait | code | otp | register | unlock
  const [code, setCode] = useState(''), codeRef = useRef('');   // mã xác nhận hiện trên trang trình duyệt
  const [info, setInfo] = useState(null), [res, setRes] = useState(null);
  const [otp, setOtp] = useState(''), [form, setForm] = useState({ username: '', displayName: '', password: '', terms: false });
  const [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const finish = async (r, password) => {
    const un = r.user.username;
    if (r.created) {                                     // tài khoản mới: khóa vừa tạo trên máy này
      await api.putKeyBackup(r.token, await crypto.sealKeyBackup(un, password));
      await api.uploadKey(r.token, crypto.publicKeyBase64(un));
      onLogin(r); return;
    }
    const backup = await api.getKeyBackup(r.token);
    if (!backup || crypto.hasLocalKeys(un)) { onLogin(r); return; }
    if (!password) { setRes(r); setStage('unlock'); return; }
    if (!(await crypto.openKeyBackup(un, password, backup))) throw new Error('Mật khẩu không đúng — không mở được khóa mã hóa');
    localStorage.setItem('reachat.resync.' + un, '1');
    await api.putKeyBackup(r.token, await crypto.sealKeyBackup(un, password));
    await api.uploadKey(r.token, crypto.publicKeyBase64(un));
    onLogin(r);
  };
  const step = async (extra = {}) => {
    try {
      const r = await api.googlePoll({ nonce, ...(codeRef.current ? { code: codeRef.current } : {}), ...extra });
      if (!alive.current) return null;
      if (r.pending) return 'pending';
      if (r.needCode) { setStage('code'); return null; }
      if (r.needRegister) { setInfo(r); setForm((f) => ({ ...f, username: f.username || r.suggestedUsername, displayName: f.displayName || r.name || '' })); setStage('register'); return null; }
      await finish(r, extra.register?.password);
      return null;
    } catch (e) {
      if (!alive.current) return null;
      if (e.needCode) { codeRef.current = ''; setErr(e.message); setStage('code'); return null; }
      if (e.need2fa) { if (extra.otp) setErr(e.message); setStage('otp'); return null; }
      if (e.status === 410 || e.status === 400 && stage === 'wait') { onCancel(e.message); return null; }
      setErr(e.message); return null;
    }
  };
  // chờ người dùng xác thực trên trình duyệt: hỏi máy chủ mỗi 2 giây (tối đa 10 phút)
  useEffect(() => {
    let stop = false; const t0 = Date.now();
    (async () => { while (!stop && alive.current && Date.now() - t0 < 600_000) { if ((await step()) !== 'pending') return; await new Promise((r) => setTimeout(r, 2000)); }
      if (!stop && alive.current) onCancel('Hết thời gian chờ đăng nhập Google'); })();
    return () => { stop = true; };
  }, []);
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const submit = (e) => { e.preventDefault();
    if (stage === 'code') run(() => { codeRef.current = code.trim(); return step(); });
    if (stage === 'otp') run(() => step({ otp }));
    if (stage === 'register') run(async () => {
      const un = form.username.toLowerCase().trim();
      if (!form.terms) throw new Error('Bạn cần đồng ý Điều khoản sử dụng và Chính sách quyền riêng tư');
      if (form.password.length < 6) throw new Error('Mật khẩu tối thiểu 6 ký tự');
      await step({ register: { username: un, displayName: form.displayName, password: form.password, publicKey: crypto.publicKeyBase64(un), acceptTerms: true } });
    });
    if (stage === 'unlock') run(() => finish(res, pw));
  };
  return (<form className="auth-card" onSubmit={submit}>
    <h1>ReaChat</h1>
    <div className="google-head"><GoogleG /> <b>Đăng nhập bằng Google</b></div>
    {stage === 'wait' && <><div className="spinner" /><p className="muted small">Đã mở trình duyệt — hãy chọn tài khoản Google và cho phép. Xong thì quay lại đây, ứng dụng tự tiếp tục.</p></>}
    {stage === 'code' && <><p className="muted small">Trang trình duyệt đang hiện một <b>mã xác nhận 6 ký tự</b> — nhập mã đó vào đây.</p>
      <input className="otp-input" maxLength={8} placeholder="Mã xác nhận" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus />
      <button className="primary" disabled={busy || code.trim().length < 6}>Tiếp tục</button></>}
    {stage === 'otp' && <><p className="muted small">Tài khoản bật xác thực 2 bước.</p>
      <input className="otp-input" inputMode="numeric" maxLength={7} placeholder="Mã 6 số từ ứng dụng xác thực" value={otp} onChange={(e) => setOtp(e.target.value)} autoFocus />
      <button className="primary" disabled={busy}>Xác nhận mã</button></>}
    {stage === 'register' && <><p className="muted small">Tạo tài khoản ReaChat cho <b data-user-content>{info?.email || info?.name}</b>.
      Mật khẩu dùng để bảo vệ khóa mã hóa tin nhắn và để đăng nhập khi không dùng Google.</p>
      <input placeholder="username (a-z, 0-9, _)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoFocus />
      <input placeholder="Tên hiển thị" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      <input type="password" placeholder="Đặt mật khẩu (≥ 6 ký tự)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      <label className="check-row small terms-row"><input type="checkbox" checked={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.checked })} />
        <span>Tôi đồng ý <a href={api.serverBase() + '/legal/terms.html'} target="_blank" rel="noreferrer">Điều khoản sử dụng</a> và <a href={api.serverBase() + '/legal/privacy.html'} target="_blank" rel="noreferrer">Chính sách quyền riêng tư</a></span></label>
      <button className="primary" disabled={busy}>Tạo tài khoản</button></>}
    {stage === 'unlock' && <><p className="muted small">🔑 Máy này chưa có khóa mã hóa của <b data-user-content>@{res?.user.username}</b>. Nhập <b>mật khẩu ReaChat</b> để mở khóa lịch sử tin nhắn.</p>
      <input type="password" placeholder="Mật khẩu ReaChat" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      <button className="primary" disabled={busy || !pw}>Mở khóa & vào</button>
      <p className="muted small">Quên mật khẩu? Quay lại và dùng “Quên mật khẩu?”.</p></>}
    {err && <div className="error">{err}</div>}
    <button type="button" className="link small" onClick={() => onCancel('')}>← Quay lại</button>
  </form>);
}

// ---- Avatar tròn (chữ cái đầu hoặc ảnh) ----
function Avatar({ name, src, size = 36 }) {
  const [broken, setBroken] = useState(false);          // ảnh hỏng -> quay về chữ cái đầu
  const style = { width: size, height: size, fontSize: size * 0.42 };
  if (src && !broken) return <img className="avatar" src={src} style={style} alt="" onError={() => setBroken(true)} />;
  const ch = (name || '?').replace(/^@/, '').charAt(0).toUpperCase();
  const hue = [...(name || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return <div className="avatar ph" style={{ ...style, background: `hsl(${hue},45%,45%)` }}>{ch}</div>;
}

// ---- Bộ icon SVG nét mảnh, một màu (theo currentColor) ----
const ICONS = {
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  paperclip: <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
  smile: <><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><path d="M9 9h.01" /><path d="M15 9h.01" /></>,
  sticker: <><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5Z" /><path d="M15 3v6h6" /><path d="M8 13s1.2 2 4 2 4-2 4-2" /></>,
  timer: <><path d="M10 2h4" /><path d="m12 14 3-3" /><circle cx="12" cy="14" r="8" /></>,
  chart: <><path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  mic: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  userPlus: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6" /><path d="M22 11h-6" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />,
  video: <><path d="m22 8-6 4 6 4V8Z" /><rect x="2" y="6" width="14" height="12" rx="2" /></>,
  settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>,
  rec: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" fill="currentColor" /></>,
  monitor: <><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" /><path d="m9 12 2 2 4-4" /></>,
  ban: <><circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" /></>,
  reply: <><path d="M9 17 4 12l5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></>,
  forward: <><path d="m15 17 5-5-5-5" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" /></>,
  pin: <><path d="M12 17v5" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></>,
  eyeOff: <><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13 13 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61" /><path d="m2 2 20 20" /></>,
  pencil: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  megaphone: <><path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /></>,
  image: <><rect width="18" height="18" x="3" y="3" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></>,
  pin2: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></>,
  flag: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  chat: <><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" /><path d="M8.5 11h7" /><path d="M8.5 14.5h4.5" /></>,
  book: <><path d="M4 19.5V5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z" /><circle cx="12" cy="9" r="2.4" /><path d="M8.5 14.5a3.8 3.8 0 0 1 7 0" /></>,
  sliders: <><path d="M4 6h10" /><path d="M18 6h2" /><circle cx="16" cy="6" r="2" /><path d="M4 12h3" /><path d="M11 12h9" /><circle cx="9" cy="12" r="2" /><path d="M4 18h12" /><circle cx="18" cy="18" r="2" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  notes: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M8 13h8" /><path d="M8 17h5" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  micOff: <><path d="m2 2 20 20" /><path d="M18.89 13.23A7 7 0 0 0 19 12v-2" /><path d="M5 10v2a7 7 0 0 0 12 5" /><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12" /><path d="M12 19v3" /></>,
  videoOff: <><path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.25-3.06a.5.5 0 0 1 .75.43v8.2" /><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" /><path d="m2 2 20 20" /></>,
  phoneOff: <><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.4 19.4 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" /><path d="m22 2-20 20" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  more: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
  bellOff: <><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" /><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="m2 2 20 20" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></>,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  idCard: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="2" /><path d="M15 9h3" /><path d="M15 13h3" /><path d="M6 16c.5-1.3 1.7-2 3-2s2.5.7 3 2" /></>,
  notebook: <><path d="M2 6h4" /><path d="M2 10h4" /><path d="M2 14h4" /><path d="M2 18h4" /><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M16 2v20" /></>,
  wifi: <><path d="M12 20h.01" /><path d="M2 8.82a15 15 0 0 1 20 0" /><path d="M5 12.86a10 10 0 0 1 14 0" /><path d="M8.5 16.43a5 5 0 0 1 7 0" /></>,
  fileText: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>,
  listTodo: <><rect x="3" y="5" width="6" height="6" rx="1" /><path d="m3 17 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></>,
  mailDot: <><path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /><circle cx="19" cy="18" r="3" /></>,
};
function Icon({ name, size = 20, stroke = 2 }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>
  );
}

// Logo ReaChat (cùng thiết kế với public/icon.svg).
function BrandMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <defs><linearGradient id="rc-brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2dd4bf" /><stop offset="1" stopColor="#047857" /></linearGradient></defs>
      <rect width="512" height="512" rx="128" fill="url(#rc-brand)" />
      <path d="M150 128h212a58 58 0 0 1 58 58v120a58 58 0 0 1-58 58H222l-86 58v-58h14a58 58 0 0 1-58-58V186a58 58 0 0 1 58-58z" fill="#fff" />
      <rect x="168" y="212" width="176" height="28" rx="14" fill="#0f766e" />
      <rect x="168" y="268" width="112" height="28" rx="14" fill="#2dd4bf" />
    </svg>
  );
}

// ---------------------------------------------------------------- Chat
function Chat({ session, onLogout, onUpdateUser, onUpdateToken }) {
  const { token, user } = session;
  if (api.currentToken() !== token) api.setToken(token);    // trước mọi effect (kể cả của thành phần con)
  const [convMeta, setConvMeta] = useState({});
  const [convList, setConvList] = useState([]);
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const hasEphemeral = messages.some((m) => m.expireAt && !m.recalled && m.expireAt > Date.now());
  useEffect(() => { setProtect('ephemeral', hasEphemeral); }, [hasEphemeral]);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(() => new Set());
  const [typing, setTyping] = useState({});
  const [status, setStatus] = useState({});
  const [reactions, setReactions] = useState({});   // msgId -> [{username,emoji}]
  const [editing, setEditing] = useState(null);
  const [reply, setReply] = useState(null);         // tin đang trả lời
  const [forwarding, setForwarding] = useState(null);
  const [editHist, setEditHist] = useState(null);          // tin đang xem lịch sử sửa
  const [showGroup, setShowGroup] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [transfers, setTransfers] = useState([]);              // tiến độ tải lên / tải về tệp lớn
  const [p2pIncoming, setP2pIncoming] = useState([]);          // lời mời nhận tệp trực tiếp {id, from, meta, offer}
  const p2pSessions = useRef(new Map());
  const p2pSignalRef = useRef(null);
  const [reporting, setReporting] = useState(null);
  const [gallery, setGallery] = useState(null);               // id hội thoại đang mở kho media
  const [showChannels, setShowChannels] = useState(false);
  const [channelResults, setChannelResults] = useState(null);
  const joinChannelRef = useRef(null);           // tin đang được báo cáo
  const [invitePreview, setInvitePreview] = useState(null);   // {code, valid, title, memberCount, by, already}
  const [groupInvite, setGroupInvite] = useState({});          // convId -> {code, expiresAt} (trưởng nhóm)
  const joinedRef = useRef(null);
  const [meetLinks, setMeetLinks] = useState({});            // convId -> mã phòng họp (để chia sẻ link khi đang gọi)
  const [showMeet, setShowMeet] = useState(false);
  const meetJoinRef = useRef(null);
  const joinGroupCallRef = useRef(null);                           // convId phòng họp vừa vào bằng link -> tự vào cuộc gọi
  const [safety, setSafety] = useState(null); // {peerUsername, number} khi mở modal mã an toàn
  const [call, setCall] = useState(null); // {status:'calling'|'ringing'|'connected', peer, video, offer?, muted?, camOff?}
  // Chuông: có cuộc gọi đến -> nhạc chuông; đang gọi đi -> chuông chờ. Đổi trạng thái là dừng.
  useEffect(() => { if (call?.status === 'ringing') return startRing('in'); if (call?.status === 'calling') return startRing('out'); }, [call?.status]);
  const [callMedia, setCallMedia] = useState({ local: null, remote: null });
  const callRef = useRef(null);         // CallSession hiện tại
  const earlyIceRef = useRef([]);       // ICE đến trước khi nhận máy
  const [gcalls, setGcalls] = useState({});   // phòng gọi nhóm đang mở: convId -> {callId, participants, by, video}
  const [gcall, setGcall] = useState(null);     // cuộc gọi nhóm mình đang tham gia
  const [gpeers, setGpeers] = useState([]);
  const [glocal, setGlocal] = useState(null);
  const [gring, setGring] = useState(null);     // chuông gọi nhóm {conversationId, by, video}
  useEffect(() => { if (gring) return startRing('in'); }, [!!gring]);
  const gcallRef = useRef(null);                // GroupCall hiện tại
  const signalHandlerRef = useRef(null);
  // ---- Niêm phong tín hiệu cuộc gọi bằng khóa danh tính (nacl.box) ----
  // SDP chứa vân tay DTLS: server chuyển tiếp nhưng KHÔNG đọc/sửa được -> không thể chen giữa (MITM) cuộc gọi
  // mà không bị phát hiện qua mã an toàn. Phần ngoài (kind, callId, video, reason) vẫn rõ để server ghi lịch sử.
  // ctx (callId / mã phòng) nằm TRONG hộp -> không phát lại được gói của cuộc gọi khác.
  const pkCacheRef = useRef(new Map());
  const sigChainRef = useRef({});               // hàng đợi theo người/thiết bị: giữ đúng thứ tự offer -> ice
  const peerPk = async (u, fresh) => {
    const c = pkCacheRef.current.get(u);
    if (!fresh && c && Date.now() - c.t < 120000) return c.pk;
    let pk = null;
    try { pk = (await api.lookupUser(u, tokenRef.current))?.publicKey; } catch {}
    if (crypto.validPublicKey(pk)) pkCacheRef.current.set(u, { pk, t: Date.now() });
    return pk;
  };
  const sealSig = async (u, data, ctx) => {
    if (!data.sdp && !data.candidate && !data.meta) return data;
    const pk = await peerPk(u);
    if (!crypto.validPublicKey(pk)) throw new Error('Không có khóa công khai của @' + u);
    const { sdp, candidate, meta, ...outer } = data;
    return { ...outer, sealed: crypto.encrypt(JSON.stringify({ ctx, kind: data.kind, sdp, candidate, meta }), pk, user.username) };
  };
  const openSig = async (u, data, ctx) => {
    if (!data.sealed) return (data.sdp || data.candidate || data.meta) ? null : data;   // SDP/ICE/thông tin tệp không niêm phong -> bỏ
    let pt = crypto.decrypt(data.sealed, await peerPk(u), user.username);
    if (pt == null) pt = crypto.decrypt(data.sealed, await peerPk(u, true), user.username);   // khóa vừa đổi
    if (pt == null) return null;
    try {
      const o = JSON.parse(pt);
      if (o.ctx !== ctx || o.kind !== data.kind) return null;
      const { sealed, ...outer } = data;
      return { ...outer, sdp: o.sdp, candidate: o.candidate, meta: o.meta };
    } catch { return null; }
  };
  const queueSig = (key, fn) => {
    const p = (sigChainRef.current[key] || Promise.resolve()).then(fn).catch((e) => console.warn('[signal]', e?.message || e));
    sigChainRef.current[key] = p;
    return p;
  }; // trỏ tới handleSignal mới nhất (tránh reconnect WS)
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [unread, setUnread] = useState({});
  const openByMetaRef = useRef(null);
  // Bấm thông báo đẩy -> mở đúng hội thoại (service worker gửi message, hoặc mở trang với ?c=)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const h = (e) => { if (e.data?.type === 'open' && e.data.conversationId) { const meta = convMetaRef.current[e.data.conversationId]; if (meta) openByMetaRef.current?.(meta); } };
    navigator.serviceWorker.addEventListener('message', h);
    return () => navigator.serviceWorker.removeEventListener('message', h);
  }, []);
  // Tổng tin chưa đọc -> biểu tượng khay hệ thống (chấm đỏ + tooltip) và nháy thanh tác vụ.
  const unreadTotal = Object.values(unread).reduce((a, b) => a + (b || 0), 0);
  useEffect(() => { try { window.reachat?.win?.badge(unreadTotal); } catch {} }, [unreadTotal]);
  const [contacts, setContacts] = useState([]);
  const [blocked, setBlocked] = useState(new Set()); // usernames mình đã chặn
  const [showContacts, setShowContacts] = useState(false);
  const [friendReqs, setFriendReqs] = useState({ incoming: [], outgoing: [] });
  const [stories, setStories] = useState([]);           // story của mình + bạn bè (còn hạn)
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showStoryCompose, setShowStoryCompose] = useState(false);
  const [storyView, setStoryView] = useState(null);     // { items:[story...], index } đang xem
  const [toast, setToast] = useState(null);             // thông báo ngắn (kết bạn...)
  const [pins, setPins] = useState({});                 // convId -> [messageId] đã ghim
  const [pinnedMsgs, setPinnedMsgs] = useState([]);     // tin đã ghim (resolve từ cache) của hội thoại đang mở
  const [hidden, setHidden] = useState(() => {          // tin "xóa phía tôi" (cục bộ)
    try { return new Set(JSON.parse(localStorage.getItem('reachat.hidden.' + user.username) || '[]')); } catch { return new Set(); }
  });
  const [ttl, setTtl] = useState(0);                    // tin tự hủy (giây) cho hội thoại đang mở
  const [canLoadOlder, setCanLoadOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [destructAcks, setDestructAcks] = useState({});   // messageId -> [{username, devices}] đã xác nhận xóa
  const [pollTallies, setPollTallies] = useState({});   // messageId -> [[username,...], ...]
  const [showPoll, setShowPoll] = useState(false);      // modal tạo bình chọn
  const [scheduledItems, setScheduledItems] = useState([]); // tin đã hẹn giờ
  const [scheduling, setScheduling] = useState(null);   // {text} đang hẹn giờ
  const [showScheduled, setShowScheduled] = useState(false);
  const [reminders, setReminders] = useState(() => {      // nhắc hẹn cục bộ: [{id,msgId,convId,at,text}]
    try { return JSON.parse(localStorage.getItem('reachat.reminders.' + user.username) || '[]'); } catch { return []; }
  });
  const [reminding, setReminding] = useState(null);       // tin đang đặt nhắc
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const loadLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  // Tùy chọn từng hội thoại (cục bộ): { pinned, muted, unread }
  const [convPrefs, setConvPrefs] = useState(() => loadLS('reachat.convprefs.' + user.username, {}));
  // Đồng bộ danh sách hội thoại tắt thông báo lên máy chủ -> không đẩy những hội thoại đó (bản web/PWA).
  useEffect(() => {
    if (!window.reachat?.web || !('serviceWorker' in navigator) || !location.pathname.startsWith('/app')) return;
    const muted = Object.entries(convPrefs).filter(([, p]) => p.muted).map(([id]) => id);
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => s && api.pushMuted(s.endpoint, muted)).catch(() => {});
  }, [convPrefs]);
  const convPrefsRef = useRef(convPrefs);
  useEffect(() => { convPrefsRef.current = convPrefs; try { localStorage.setItem('reachat.convprefs.' + user.username, JSON.stringify(convPrefs)); } catch {} }, [convPrefs, user.username]);
  const setPref = (id, patch) => setConvPrefs((p) => ({ ...p, [id]: { ...(p[id] || {}), ...patch, t: Date.now() } }));
  const [drafts, setDrafts] = useState({});
  useEffect(() => {
    const read = () => { const pre = 'reachat.draft.' + user.username + '.', out = {};
      try { for (const k of Object.keys(localStorage)) if (k.startsWith(pre)) out[k.slice(pre.length)] = localStorage.getItem(k); } catch {}
      setDrafts(out); };
    read(); window.addEventListener('reachat:draft', read);
    return () => window.removeEventListener('reachat:draft', read);
  }, [user.username]);
  // Xóa cả cuộc trò chuyện (phía tôi): xóa bộ nhớ đệm + ẩn tin cũ hơn thời điểm xóa (kể cả khi tải lại lịch sử từ máy chủ).
  // Hội thoại tự hiện lại khi có tin mới.
  const [confirmClear, setConfirmClear] = useState(null);
  const [profileOf, setProfileOf] = useState(null);            // username đang xem hồ sơ
  const [showStarred, setShowStarred] = useState(false);
  const [myStatus, setMyStatusState] = useState(null), [showStatus, setShowStatus] = useState(false);
  useEffect(() => { api.getMyStatus().then(setMyStatusState).catch(() => {}); }, []);
  const [bdays, setBdays] = useState([]);                      // bạn bè sinh nhật hôm nay
  useEffect(() => { api.birthdaysToday().then(setBdays).catch(() => {}); }, []);
  const [labels, setLabelsRaw] = useState(() => loadLS('reachat.labels.' + user.username, []));
  const [labelsT, setLabelsT] = useState(() => loadLS('reachat.labelsT.' + user.username, 0));
  const setLabels = (ls) => { setLabelsRaw(ls); setLabelsT(Date.now()); };
  useEffect(() => { try { localStorage.setItem('reachat.labels.' + user.username, JSON.stringify(labels)); localStorage.setItem('reachat.labelsT.' + user.username, JSON.stringify(labelsT)); } catch {} }, [labels, labelsT, user.username]);
  // Tin đánh dấu sao: { [msgId]: { on, t, convId, preview, at } }
  // Biệt danh đặt cho người khác: { username: { name, t } } — đồng bộ giữa các máy (name '' = đã xóa).
  const [nicknames, setNicknames] = useState(() => loadLS('reachat.nicks.' + user.username, {}));
  useEffect(() => { try { localStorage.setItem('reachat.nicks.' + user.username, JSON.stringify(nicknames)); } catch {} }, [nicknames, user.username]);
  const nickOf = (u) => (u && nicknames[u]?.name) || '';
  const setNick = (u, name) => setNicknames((n) => ({ ...n, [u]: { name: String(name || '').trim().slice(0, 40), t: Date.now() } }));
  const [nickEdit, setNickEdit] = useState(null);          // username đang đặt biệt danh
  // Trò chuyện ẩn: convPrefs[id].secret; mã PIN (băm) đồng bộ; nhập đúng PIN vào ô tìm kiếm -> hiện tạm.
  const [secretPin, setSecretPin] = useState(() => loadLS('reachat.secretPin.' + user.username, { t: 0 }));
  useEffect(() => { try { localStorage.setItem('reachat.secretPin.' + user.username, JSON.stringify(secretPin)); } catch {} }, [secretPin, user.username]);
  const [revealSecret, setRevealSecret] = useState(false);
  const [pinSetup, setPinSetup] = useState(null);          // { hideId?, changing? }
  const [starred, setStarred] = useState(() => loadLS('reachat.starred.' + user.username, {}));
  useEffect(() => { try { localStorage.setItem('reachat.starred.' + user.username, JSON.stringify(starred)); } catch {} }, [starred, user.username]);
  const toggleStar = (m) => setStarred((s) => ({ ...s, [m.id]: { on: !s[m.id]?.on, t: Date.now(), convId: m.conversationId, preview: msgPreview(m).slice(0, 120), at: m.createdAt, from: m.senderUsername } }));

  // ---- Đồng bộ giữa các thiết bị: tài liệu mã hóa bằng khóa riêng (như Cloud), máy chủ chỉ giữ bản mã ----
  const syncRef = useRef({ version: 0, hash: '', ready: false, timer: null, busy: false });
  // Khóa nhóm nằm trong ref -> đổi số này để hẹn gửi tài liệu đồng bộ (máy khác của mình cần khóa để đọc tin nhóm).
  const [groupKeysVer, setGroupKeysVer] = useState(0);
  const persistGroupKeys = () => { saveGroupKeys(user.username, groupKeysRef.current); setGroupKeysVer((v) => v + 1); };
  const docGroupKeys = () => Object.fromEntries(Object.entries(groupKeysRef.current)
    .filter(([id, g]) => id !== selfConvId && g?.key).map(([id, g]) => [id, { key: g.key, old: g.old || [], by: g.by, t: g.t || 0 }]));
  // Gộp khóa nhóm từ máy khác vào máy này; hội thoại vừa có thêm khóa -> tải lại lịch sử để giải mã các tin từng lỗi.
  const applyGroupKeys = (gk) => {
    const gained = [];
    for (const [id, g] of Object.entries(gk || {})) {
      if (id === selfConvId || !g?.key) continue;
      const cur = groupKeysRef.current[id];
      const merged = mergeGroupKey(cur, g);
      const had = new Set(cur?.key ? [cur.key, ...(cur.old || [])] : []);
      if ([merged.key, ...(merged.old || [])].some((k) => !had.has(k))) { groupKeysRef.current[id] = merged; gained.push(id); }
    }
    if (!gained.length) return;
    saveGroupKeys(user.username, groupKeysRef.current);
    for (const id of gained) rtRef.current?.syncConversation(id);
  };
  const draftDoc = () => {
    const pre = 'reachat.draft.' + user.username + '.', preT = 'reachat.draftT.' + user.username + '.', out = {};
    try { for (const k of Object.keys(localStorage)) {
      if (k.startsWith(preT)) { const id = k.slice(preT.length); out[id] = { text: localStorage.getItem(pre + id) || '', t: Number(localStorage.getItem(k)) || 0 }; }
    } } catch {}
    return out;
  };
  const localDoc = () => ({ ...emptyDoc(), convPrefs, labels: { list: labels, t: labelsT }, drafts: draftDoc(),
    hidden: Object.fromEntries([...hidden].map((id) => [id, 1])), starred, groupKeys: docGroupKeys(), nicknames, secretPin });
  const applyDoc = (d) => {
    applyGroupKeys(d.groupKeys);
    setNicknames(d.nicknames || {});
    setSecretPin(d.secretPin || { t: 0 });
    setConvPrefs(d.convPrefs || {});
    setLabelsRaw(d.labels?.list || []); setLabelsT(d.labels?.t || 0);
    setStarred(d.starred || {});
    setHiddenSaved(() => new Set(Object.keys(d.hidden || {})));
    const pre = 'reachat.draft.' + user.username + '.', preT = 'reachat.draftT.' + user.username + '.';
    const openId = activeRef.current?.conversationId;
    try { for (const [id, x] of Object.entries(d.drafts || {})) {
      if (id === openId) continue;                              // đang gõ ở hội thoại này -> giữ chữ trên máy này
      localStorage.setItem(preT + id, String(x.t || 0));
      x.text ? localStorage.setItem(pre + id, x.text) : localStorage.removeItem(pre + id);
    } window.dispatchEvent(new Event('reachat:draft')); } catch {}
  };
  const syncKey = () => personalKeyRef.current?.[0];
  const pullSync = async () => {
    const r = await api.getSync();
    if (!r.blob) return { version: r.version || 0, doc: null };
    const txt = crypto.decryptGroup(r.blob, syncKey());
    return { version: r.version, doc: txt ? JSON.parse(txt) : null };
  };
  const pushSync = async (doc, tries = 2) => {
    const h = docHash(doc);
    if (h === syncRef.current.hash) return;
    try {
      const r = await api.putSync(syncRef.current.version, crypto.encryptGroup(JSON.stringify(doc), syncKey()));
      syncRef.current.version = r.version; syncRef.current.hash = h;
    } catch (e) {
      if (e.status !== 409 || tries <= 0) return;
      const cur = e.data?.current; const txt = cur?.blob && crypto.decryptGroup(cur.blob, syncKey());
      syncRef.current.version = cur?.version || 0;
      const merged = mergeDocs(doc, txt ? JSON.parse(txt) : null);   // máy khác vừa ghi -> gộp rồi ghi lại
      applyDoc(merged);
      await pushSync(merged, tries - 1);
    }
  };
  const syncNow = async () => {
    if (syncRef.current.busy || !syncKey()) return;
    syncRef.current.busy = true;
    try {
      const { version, doc } = await pullSync();
      syncRef.current.version = version;
      const merged = mergeDocs(localDoc(), doc);
      if (doc) { syncRef.current.hash = docHash(doc); applyDoc(merged); }
      syncRef.current.ready = true;
      await pushSync(merged);
    } catch {} finally { syncRef.current.busy = false; }
  };
  const syncNowRef = useRef(null); syncNowRef.current = syncNow;
  useEffect(() => { const t = setTimeout(() => syncNowRef.current?.(), 1500); return () => clearTimeout(t); }, []);
  // Có thay đổi trên máy này -> gửi lên sau 1,5 giây (gom nhiều thay đổi liên tiếp).
  useEffect(() => {
    if (!syncRef.current.ready) return;
    clearTimeout(syncRef.current.timer);
    syncRef.current.timer = setTimeout(() => pushSync(localDoc()).catch(() => {}), 1500);
  }, [convPrefs, labels, labelsT, starred, hidden, drafts, groupKeysVer, nicknames, secretPin]);
  const [convFilter, setConvFilter] = useState('all');          // all | unread | archived | <id nhãn>
  const [showLabels, setShowLabels] = useState(false);
  const clearConversation = async (id) => {
    setPref(id, { clearedAt: Date.now(), unread: false });
    try { await db.clearConversation?.(id); } catch {}
    try { localStorage.removeItem('reachat.draft.' + user.username + '.' + id); localStorage.setItem('reachat.draftT.' + user.username + '.' + id, String(Date.now())); window.dispatchEvent(new Event('reachat:draft')); } catch {}
    if (activeRef.current?.conversationId === id) { setActive(null); setMessages([]); }
    await refreshConvList(); refreshUnread();
    setConfirmClear(null); setRowMenu(null);
    flashToast('🗑️ Đã xóa cuộc trò chuyện ở phía bạn');
  };
  const [rowMenu, setRowMenu] = useState(null);           // id hội thoại đang mở menu "⋯"
  // Tin nhắn nhanh: gõ "/khóa" để chèn nội dung soạn sẵn.
  const [quickReplies, setQuickReplies] = useState(() => loadLS('reachat.quick.' + user.username, [
    { key: 'chao', text: 'Chào bạn! Mình có thể giúp gì?' },
    { key: 'cam', text: 'Cảm ơn bạn nhiều nhé 🙏' },
    { key: 'ban', text: 'Mình đang bận, lát mình trả lời sau nhé.' },
  ]));
  useEffect(() => { try { localStorage.setItem('reachat.quick.' + user.username, JSON.stringify(quickReplies)); } catch {} }, [quickReplies, user.username]);
  const [showQuick, setShowQuick] = useState(false);
  const [showContactPick, setShowContactPick] = useState(false);
  // Khóa công khai đã thấy của từng người: { username: { pk, verified, changedAt?, prev? } }
  const [keySeen, setKeySeen] = useState(() => loadLS('reachat.keyseen.' + user.username, {}));
  const keySeenRef = useRef(keySeen);
  useEffect(() => { keySeenRef.current = keySeen; try { localStorage.setItem('reachat.keyseen.' + user.username, JSON.stringify(keySeen)); } catch {} }, [keySeen, user.username]);
  // Giờ yên lặng theo lịch: { enabled, from:'22:00', to:'07:00', priority:[username], blockCalls }
  const [quiet, setQuiet] = useState(() => loadLS('reachat.quiet.' + user.username, { enabled: false, from: '22:00', to: '07:00', priority: [], blockCalls: true }));
  const quietRef = useRef(quiet);
  useEffect(() => { quietRef.current = quiet; try { localStorage.setItem('reachat.quiet.' + user.username, JSON.stringify(quiet)); } catch {} }, [quiet, user.username]);
  const [showQuiet, setShowQuiet] = useState(false);
  const [tasksByConv, setTasksByConv] = useState({});      // convId -> [task]
  const [assigning, setAssigning] = useState(null);         // tin đang được giao việc
  const [showTasks, setShowTasks] = useState(false);
  const [unreadAtOpen, setUnreadAtOpen] = useState({});    // số tin chưa đọc lúc mở hội thoại (cho tóm tắt)
  const [showSummary, setShowSummary] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const docSubsRef = useRef({});                            // convId -> { snapshot, update } của trình soạn chung đang mở
  const subscribeDoc = (convId, h) => { docSubsRef.current[convId] = h; return () => { if (docSubsRef.current[convId] === h) delete docSubsRef.current[convId]; }; };
  const unreadRef = useRef({});
  useEffect(() => { unreadRef.current = unread; }, [unread]);
  // ---- Mạng LAN (chỉ app desktop): nhắn tin mã hóa khi mất Internet ----
  const lanApi = window.reachat.lan;                       // undefined trên bản web
  const [lanOn, setLanOn] = useState(false);
  const [lanPeers, setLanPeers] = useState([]);
  const [lanMsgs, setLanMsgs] = useState(() => loadLS('reachat.lanmsgs.' + user.username, {})); // username -> [{mine,text,at}]
  const [showLan, setShowLan] = useState(false);
  const [lanUnread, setLanUnread] = useState(0);
  const showLanRef = useRef(false);
  useEffect(() => { showLanRef.current = showLan; if (showLan) setLanUnread(0); }, [showLan]);
  useEffect(() => { try { localStorage.setItem('reachat.lanmsgs.' + user.username, JSON.stringify(lanMsgs)); } catch {} }, [lanMsgs, user.username]);
  const pushLan = (peer, item) => setLanMsgs((p) => ({ ...p, [peer]: [...(p[peer] || []), item].slice(-300) }));
  useEffect(() => {
    if (!lanApi || !lanOn) return;
    const offP = lanApi.onPeers(setLanPeers);
    const offM = lanApi.onMessage((m) => {
      if (m.kind !== 'msg' || !m.from || !crypto.validPublicKey(m.fromPk)) return;
      const text = crypto.decrypt(m.data, m.fromPk, user.username);
      if (text == null) return;
      // Khóa LAN khác khóa đã biết từ server -> có thể bị mạo danh trong mạng nội bộ.
      const known = keySeenRef.current[m.from]?.pk;
      pushLan(m.from, { mine: false, text, at: m.at || Date.now(), keyMismatch: !!known && known !== m.fromPk });
      if (!showLanRef.current) { setLanUnread((n) => n + 1); flashToast('📶 LAN — @' + m.from + ': ' + text.slice(0, 60)); }
    });
    lanApi.peers().then(setLanPeers);
    return () => { offP(); offM(); };
  }, [lanOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleLan = async () => {
    if (!lanApi) return;
    if (lanOn) { await lanApi.stop(); setLanOn(false); setLanPeers([]); return; }
    await lanApi.start({ username: user.username, displayName: user.displayName, publicKey: crypto.publicKeyBase64(user.username) });
    setLanOn(true);
  };
  const sendLan = async (peer, text) => {
    const data = crypto.encrypt(text, peer.publicKey, user.username);   // nacl.box: chỉ người nhận mở được
    const ok = await lanApi.send(peer.id, { kind: 'msg', data, at: Date.now() });
    pushLan(peer.username, { mine: true, text, at: Date.now(), failed: !ok });
  };
  const [, setTick] = useState(0);                           // vẽ lại mỗi phút để cập nhật trạng thái yên lặng
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);
  // Giao diện sáng / tối (lưu theo máy).
  const [theme, setTheme] = useState(() => localStorage.getItem('reachat.theme') || 'dark');
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('reachat.theme', theme); } catch {} }, [theme]);

  const rtRef = useRef(null);
  const peersRef = useRef(loadPeers(user.username));
  const tokenRef = useRef(token); tokenRef.current = token;
  const shareGroupKeysRef = useRef(null);
  const ensuringRef = useRef({});
  const askedKeyRef = useRef(new Set());
  const ensureGroupKeyRef = useRef(null);
  const keyChainRef = useRef({});              // convId -> Promise xử lý gói khóa gần nhất
  const groupKeysRef = useRef(loadGroupKeys(user.username)); // convId -> { key, by }
  // "Ghi chú riêng" = hội thoại với chính mình, mã hóa bằng khóa CÁ NHÂN (dùng chung
  // luồng secretbox của nhóm: encryptGroup/decryptGroup + media genc).
  const selfConvId = directConvId(user.id, user.id);
  const personalKeyRef = useRef(null);   // [khóa Cloud hiện tại, ...khóa từ các khóa danh tính cũ]
  if (!personalKeyRef.current) personalKeyRef.current = crypto.personalKeys(user.username);
  groupKeysRef.current[selfConvId] = { key: personalKeyRef.current[0], by: user.username };
  const resyncRef = useRef(false);       // true: tải lại lịch sử để giải mã lại các tin từng lỗi
  // Đa thiết bị 1-1: "bản sao cho chính mình" mã hóa bằng khóa cá nhân ({t: nội dung} | {mk: khóa media}).
  const pendingCopiesRef = useRef({});   // bản sao tới TRƯỚC khi tin được lưu (race) -> dùng lúc persist
  const sealSelf = (obj) => crypto.encryptGroup(JSON.stringify(obj), personalKeyRef.current[0]);
  const openSelf = (data) => {
    if (!data) return null;
    for (const k of personalKeyRef.current) { const s = crypto.decryptGroup(data, k); if (s != null) { try { return JSON.parse(s); } catch { return null; } } }
    return null;
  };
  const ratchetRef = useRef({});      // convId -> Double Ratchet state (in-memory)
  const sentPlainRef = useRef(new Map()); // ct -> plaintext (giải tin của chính mình khi server dội lại)
  const mediaKeysRef = useRef(loadMediaKeys(user.username)); // fileId -> mkB64 (ảnh/tệp DR 1-1)
  const mediaCache = useRef(new Map()); // fileId -> objectURL (đã giải mã nếu cần)
  const maxSeqRef = useRef(0);
  const maxModRef = useRef(0);           // mốc thay đổi (sửa/thu hồi/tự hủy) đã đồng bộ
  const viewLimitRef = useRef(40);       // số tin đang hiển thị (giữ nguyên khi làm mới sau "tải tin cũ")
  const historyRef = useRef(null);       // {convId} đang chờ trang lịch sử từ server
  const deviceIdRef = useRef((() => {    // định danh thiết bị (xác nhận xóa tin tự hủy theo từng máy)
    const k = 'reachat.device.' + user.username;
    try { let d = localStorage.getItem(k); if (!d) { d = 'd_' + Math.random().toString(36).slice(2, 12); localStorage.setItem(k, d); } return d; } catch { return 'd_unknown'; }
  })());
  const pendingAcksRef = useRef((() => { try { return new Set(JSON.parse(localStorage.getItem('reachat.dack.' + user.username) || '[]')); } catch { return new Set(); } })());
  const activeRef = useRef(null);
  const convMetaRef = useRef({});
  const typingTimers = useRef({});
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { convMetaRef.current = convMeta; }, [convMeta]);
  useEffect(() => { api.setToken(token); }, [token]);

  const peerUsernameOf = useCallback((meta) => {
    if (!meta || meta.type !== 'direct') return null;
    return meta.members?.find((m) => m.username !== user.username)?.username || null;
  }, [user.username]);
  const memberOf = useCallback((meta, username) => meta?.members?.find((m) => m.username === username), []);

  const resolvePeerKey = useCallback(async (convId, username) => {
    let peer = peersRef.current[convId];
    if (peer && crypto.validPublicKey(peer.publicKey)) return peer; // bỏ qua khóa đã cache nhưng rác
    const uname = username || peer?.username;
    if (!uname || uname === user.username) return peer || null;
    try {
      const u = await api.lookupUser(uname, token);
      const publicKey = crypto.validPublicKey(u.publicKey) ? u.publicKey : null; // không cache khóa rác
      peer = { username: u.username, publicKey };
      peersRef.current[convId] = peer; savePeers(user.username, peersRef.current);
    } catch {}
    return peer;
  }, [token, user.username]);

  // Nhận tin phân phối khóa nhóm: mở phần envelope của mình, cache khóa nhóm.
  // keydist: phân phối khóa ban đầu | chia khóa cho thành viên mới (kèm oldKeys) | xoay khóa (rot).
  // Khóa cũ được giữ trong `old` để vẫn giải mã được tin trước thời điểm xoay.
  const cacheKeydist = useCallback(async (m) => {
    try {
      const data = JSON.parse(m.body);
      const env = data.keys?.[user.username];
      if (!env) return;                                          // không có phần của mình
      const cur = groupKeysRef.current[m.conversationId];
      const sealer = await api.lookupUser(data.by, token);       // khóa công khai người niêm phong
      if (cur && !data.rot && !data.oldKeys) {
        // Phân phối "ban đầu" khi mình ĐÃ có khóa: nhóm cũ được hai người nâng cấp cùng lúc, hoặc máy người kia
        // thiếu khóa. Giữ khóa đó để vẫn đọc được tin của họ, rồi chia khóa chung cho họ -> cả nhóm hội tụ một khóa.
        const k2 = crypto.openGroupKey(env, sealer.publicKey, user.username);
        if (!k2 || k2 === cur.key || (cur.old || []).includes(k2)) return;
        cur.old = [...(cur.old || []), k2];
        persistGroupKeys();
        const meta = convMetaRef.current[m.conversationId];
        if (meta && data.by !== user.username && (meta.ownerId === user.id || cur.by === user.username)) shareGroupKeysRef.current?.(meta, [data.by], { [data.by]: sealer.publicKey });
        return;
      }
      const key = crypto.openGroupKey(env, sealer.publicKey, user.username);
      if (!key || (cur && cur.key === key)) return;
      const shared = (data.oldKeys?.[user.username] || []).map((e) => crypto.openGroupKey(e, sealer.publicKey, user.username)).filter(Boolean);
      const old = [...new Set([...(cur ? [cur.key, ...(cur.old || [])] : []), ...shared])].filter((k) => k !== key);
      groupKeysRef.current[m.conversationId] = { key, by: data.by, old, t: Date.now() };
      persistGroupKeys();
      // Vừa được chia khóa (thành viên mới) -> kéo lịch sử nhóm để giải mã các tin trước đó.
      if (data.oldKeys) rtRef.current?.syncConversation(m.conversationId);   // kể cả khi trước đó tự tạo khóa riêng
    } catch {}
  }, [user.username, token]);

  // Dọn khóa media: bỏ khóa của tệp không còn trong cache (đã thu hồi/tự hủy/xóa). Chạy tối đa 1 lần/ngày,
  // sau khi đồng bộ xong; cache rỗng (máy mới, đang tải) thì bỏ qua để không xóa nhầm.
  const pruneMediaKeys = async () => {
    try {
      const last = Number(await db.getMeta('mediaPrune')) || 0;
      if (Date.now() - last < 86400000) return;
      const live = new Set(await db.liveFileIds());
      const keys = mediaKeysRef.current;
      if (!live.size && Object.keys(keys).length) return;
      let n = 0;
      for (const id of Object.keys(keys)) if (!live.has(id)) { delete keys[id]; n++; }
      if (n) saveMediaKeys(user.username, keys);
      await db.setMeta('mediaPrune', String(Date.now()));
      if (n) console.log('[media] đã dọn', n, 'khóa không còn dùng');
    } catch {}
  };

  // Metadata tệp mã hóa (x): thử khóa media DR, khóa nhóm (cả khóa cũ), khóa cá nhân (Cloud).
  // Mở được -> trả body có name/mime/size; chưa có khóa -> giữ nguyên (mở lại khi bản sao/khóa tới).
  const openFileMeta = (m, mkOverride) => {
    try {
      const meta = JSON.parse(m.body);
      if (!meta.x) return m.body;
      const keys = [];
      if (meta.dr) { const mk = mkOverride || mediaKeysRef.current[meta.fileId]; if (mk) keys.push(mk); }
      else if (m.conversationId === selfConvId) keys.push(...personalKeyRef.current);
      else { const g = groupKeysRef.current[m.conversationId]; if (g?.key) keys.push(g.key, ...(g.old || [])); }
      for (const k of keys) {
        const pt = crypto.decryptGroup(meta.x, k);
        if (pt != null) { const { x, ...rest } = meta; return JSON.stringify({ ...rest, ...JSON.parse(pt) }); }
      }
      return m.body;
    } catch { return m.body; }
  };

  // Ảnh/tệp DR 1-1: tiến ratchet ĐÚNG THỨ TỰ lúc nhận để lấy khóa giải file, lưu theo fileId.
  const deriveMediaKey = useCallback(async (m, opts) => {
    try {
      const meta = JSON.parse(m.body);
      if (!meta.dr || !meta.fileId) return;                      // không phải media DR
      if (mediaKeysRef.current[meta.fileId]) return;             // đã có khóa
      if (m.senderUsername === user.username) return;            // tin của mình: khóa đã lưu lúc gửi
      const copy = openSelf(m.selfCopy);                         // thiết bị khác của mình đã giải sẵn
      if (copy?.mk) { mediaKeysRef.current[meta.fileId] = copy.mk; saveMediaKeys(user.username, mediaKeysRef.current); return; }
      if (opts?.historical) return;                              // tin cũ tải lại: không đụng chuỗi ratchet hiện tại
      const peer = await resolvePeerKey(m.conversationId, m.senderUsername);
      if (!peer?.publicKey) return;
      let st = ratchetRef.current[m.conversationId] || loadRatchet(user.username, m.conversationId);
      if (!st) st = await ratchet.initResponder(crypto.getOrCreateKeypair(user.username), peer.publicKey);
      const work = ratchet.deserialize(ratchet.serialize(st));
      const mkB64 = await ratchet.receiveKey(work, meta.header);
      ratchetRef.current[m.conversationId] = work; saveRatchet(user.username, m.conversationId, work);
      mediaKeysRef.current[meta.fileId] = mkB64; saveMediaKeys(user.username, mediaKeysRef.current);
      if (m.id) rtRef.current?.putCopy(m.id, sealSelf({ mk: mkB64 }));   // cho các thiết bị khác của mình
    } catch {}
  }, [resolvePeerKey, user.username]);

  // opts.historical: tin CŨ tải từ server (phân trang) -> chỉ dùng bản sao/khóa đã lưu, không tiến ratchet
  // (tiến ratchet bằng tin cũ có thể ghi đè phiên hiện tại).
  const decodeIncoming = useCallback(async (m, opts) => {
    if (m.type === 'keydist') {                                    // tin hệ thống, không hiển thị
      // Xếp hàng theo nhóm: tin nhóm đến SAU gói khóa phải chờ khóa mở xong (mở khóa cần tra khóa công khai, bất đồng bộ).
      const p = (keyChainRef.current[m.conversationId] || Promise.resolve()).then(() => cacheKeydist(m));
      keyChainRef.current[m.conversationId] = p.catch(() => {});
      await p; return '';
    }
    if (m.recalled) return m.body;
    if (!TEXTLIKE.has(m.type)) {                                  // ảnh/tệp/thoại: body là metadata JSON
      if (m.conversationId.startsWith('dm_')) await deriveMediaKey(m, opts); // DR 1-1 -> tiến ratchet
      if (m.conversationId.startsWith('grp_')) await keyChainRef.current[m.conversationId];
      return openFileMeta(m);
    }                                                             // sticker: giải mã như text (body = emoji)
    if (!m.enc) return m.body;
    if (m.conversationId === selfConvId) {                       // Cloud: thử khóa hiện tại rồi khóa cũ
      for (const k of personalKeyRef.current) { const pt = crypto.decryptGroup(m.body, k); if (pt != null) return pt; }
      return '[không giải mã được]';
    }
    if (m.conversationId.startsWith('grp_')) {                   // nhóm -> secretbox: khóa hiện tại rồi khóa cũ
      await keyChainRef.current[m.conversationId];
      const g = groupKeysRef.current[m.conversationId];
      if (!g?.key) {
        // Chưa có khóa (vào nhóm khi chưa có khóa công khai, hoặc máy mất khóa): tự phát một khóa -> người giữ
        // khóa chung sẽ chia lại cho mình (xem cacheKeydist) rồi lịch sử được giải mã lại. Mỗi nhóm chỉ xin 1 lần/phiên.
        if (!askedKeyRef.current.has(m.conversationId) && convMetaRef.current[m.conversationId]) {
          askedKeyRef.current.add(m.conversationId);
          // Chờ các gói khóa trong lô sync VÀ tài liệu đồng bộ (máy khác của mình có thể đã giữ khóa) rồi mới tự phát khóa.
          const cid = m.conversationId;
          (async () => {
            await new Promise((r) => setTimeout(r, 1500));
            for (let i = 0; i < 40 && !syncRef.current.ready; i++) await new Promise((r) => setTimeout(r, 250));
            if (!groupKeysRef.current[cid]?.key) ensureGroupKeyRef.current?.(cid);
          })();
        }
        return '[chưa có khóa nhóm]';
      }
      for (const k of [g.key, ...(g.old || [])]) { const pt = crypto.decryptGroup(m.body, k); if (pt != null) return pt; }
      return '[không giải mã được]';
    }
    // 1-1: thử Double Ratchet (body có "dr"), nếu không thì rơi về box tĩnh (tương thích cũ).
    let parsed = null; try { parsed = JSON.parse(m.body); } catch {}
    if (parsed && parsed.dr) {
      if (m.senderUsername === user.username) {                 // tin của chính mình server dội lại
        const mem = sentPlainRef.current.get(parsed.ct);
        if (mem != null) return mem;
        if (parsed.sc) for (const k of personalKeyRef.current) { const pt = crypto.decryptGroup(parsed.sc, k); if (pt != null) return pt; }
        const own = openSelf(m.selfCopy);                       // tin cũ (trước khi có sc) được thiết bị gửi sao lưu lại
        if (own && typeof own.t === 'string') return own.t;
        return '[tin của bạn]';
      }
      const copy = openSelf(m.selfCopy);                        // thiết bị khác của mình đã giải sẵn
      if (copy && typeof copy.t === 'string') return copy.t;
      if (opts?.historical) return '[không giải mã được]';
      const peer = await resolvePeerKey(m.conversationId, m.senderUsername);
      if (!peer?.publicKey) return '[không giải mã được]';
      try {
        let st = ratchetRef.current[m.conversationId] || loadRatchet(user.username, m.conversationId);
        if (!st) st = await ratchet.initResponder(crypto.getOrCreateKeypair(user.username), peer.publicKey);
        const work = ratchet.deserialize(ratchet.serialize(st)); // bản sao: tin lỗi không làm hỏng state đã cam kết
        const pt = await ratchet.ratchetDecrypt(work, { header: parsed.header, nonce: parsed.nonce, ct: parsed.ct });
        ratchetRef.current[m.conversationId] = work; saveRatchet(user.username, m.conversationId, work);
        if (m.id) rtRef.current?.putCopy(m.id, sealSelf({ t: pt }));   // cho các thiết bị khác của mình
        return pt;
      } catch {
        // Tin đầu của một PHIÊN MỚI (thiết bị mới của đối phương / hai bên cùng gửi trước):
        // header n=0, pn=0 -> khởi tạo lại phía nhận và thử giải; thành công thì nhận phiên mới.
        if (parsed.header?.n === 0 && parsed.header?.pn === 0) {
          try {
            const fresh = await ratchet.initResponder(crypto.getOrCreateKeypair(user.username), peer.publicKey);
            const pt = await ratchet.ratchetDecrypt(fresh, { header: parsed.header, nonce: parsed.nonce, ct: parsed.ct });
            ratchetRef.current[m.conversationId] = fresh; saveRatchet(user.username, m.conversationId, fresh);
            if (m.id) rtRef.current?.putCopy(m.id, sealSelf({ t: pt }));
            return pt;
          } catch {}
        }
        return '[không giải mã được]';
      }
    }
    let peer = peersRef.current[m.conversationId];
    if ((!peer || !peer.publicKey) && m.senderUsername && m.senderUsername !== user.username)
      peer = await resolvePeerKey(m.conversationId, m.senderUsername);
    if (!peer || !peer.publicKey) return '[không giải mã được]';
    return crypto.decrypt(m.body, peer.publicKey, user.username) ?? '[không giải mã được]';
  }, [resolvePeerKey, user.username, cacheKeydist, deriveMediaKey]);

  const applyReactions = useCallback((m) => {
    if (m.reactions) setReactions((prev) => ({ ...prev, [m.id]: m.reactions }));
  }, []);

  // Tin nhắn chờ: hội thoại 1-1 với người KHÔNG có trong danh bạ, mình chưa từng gửi tin và chưa bấm "Chấp nhận".
  const [showRequests, setShowRequests] = useState(false);
  const isRequestRow = (r) => r.type === 'direct' && !r.mine && !convPrefs[r.id]?.accepted
    && !!peerUsernameOf(r.meta) && !contacts.some((c) => c.username === peerUsernameOf(r.meta));
  const contactsRef = useRef([]); useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  const convListRef = useRef([]); useEffect(() => { convListRef.current = convList; }, [convList]);
  const isRequestConv = (convId, from) => convId?.startsWith('dm_') && !convPrefsRef.current[convId]?.accepted
    && !contactsRef.current.some((c) => c.username === from) && !convListRef.current.find((c) => c.conversationId === convId)?.mine;
  const acceptRequest = (convId) => setConvPrefs((p) => ({ ...p, [convId]: { ...(p[convId] || {}), accepted: true, t: Date.now() } }));
  const refreshConvList = useCallback(async () => setConvList(await db.listConversations(user.id)), [user.id]);
  // Nạp khung tin từ cache + khôi phục cảm xúc đã lưu (trước đây chỉ có trong bộ nhớ -> mất sau khi mở lại app).
  const restoreReactions = useCallback((list) => {
    const rx = {};
    for (const m of list) {
      if (!m.reactions) continue;
      try { const r = typeof m.reactions === 'string' ? JSON.parse(m.reactions) : m.reactions; if (Array.isArray(r)) rx[m.id] = r; } catch {}
    }
    if (Object.keys(rx).length) setReactions((prev) => ({ ...prev, ...rx }));   // cache luôn cập nhật theo sự kiện -> là nguồn đúng
    return list;
  }, []);
  const loadView = useCallback(async (convId) => restoreReactions(await db.getMessages(convId, Math.max(40, viewLimitRef.current))), [restoreReactions]);
  const refreshUnread = useCallback(async () => setUnread(await db.unreadCounts(user.id)), [user.id]);
  const refreshContacts = useCallback(async () => { try { setContacts(await api.listContacts()); } catch {} }, []);
  const refreshFriendReqs = useCallback(async () => { try { setFriendReqs(await api.friendRequests()); } catch {} }, []);
  const refreshStories = useCallback(async () => { try { setStories(await api.listStories()); } catch {} }, []);
  // Thông báo ngắn, tùy chọn kèm 1 nút hành động (vd "Hoàn tác").
  const toastTimer = useRef(null);
  const flashToast = useCallback((text, action) => {
    clearTimeout(toastTimer.current);
    setToast({ text, action });
    toastTimer.current = setTimeout(() => setToast(null), action ? 8000 : 4000); // có "Hoàn tác" -> giữ lâu hơn
  }, []);
  // Đánh dấu mọi hội thoại đã đọc (gửi con trỏ đã đọc cho từng hội thoại + bỏ cờ "chưa đọc" đặt tay).
  const hideSecret = (id) => {
    setPref(id, { secret: true });
    if (activeRef.current?.conversationId === id && !revealSecret) { setActive(null); setMessages([]); }
    flashToast('🔒 Đã ẩn trò chuyện — gõ mã PIN vào ô Tìm tin nhắn để xem lại');
  };
  const savePin = async (pin) => {
    const h = await hashPin(pin);
    setSecretPin({ ...h, t: Date.now() });
    const id = pinSetup?.hideId; setPinSetup(null);
    if (id) hideSecret(id); else flashToast('🔒 Đã đổi mã PIN');
  };
  // Quên PIN: xóa (phía mình) mọi trò chuyện ẩn rồi bỏ PIN — không để lộ nội dung đã ẩn.
  const resetSecretRef = useRef(null);
  resetSecretRef.current = async () => {
    for (const [id, x] of Object.entries(convPrefsRef.current)) if (x?.secret) { await clearConversation(id); setPref(id, { secret: false }); }
    setSecretPin({ hash: '', salt: '', t: Date.now() }); setRevealSecret(false);
    flashToast('Đã xóa các trò chuyện ẩn và bỏ mã PIN');
  };
  useEffect(() => {
    const h = () => resetSecretRef.current?.();
    window.addEventListener('reachat:secret-reset', h); return () => window.removeEventListener('reachat:secret-reset', h);
  }, []);
  const markAllRead = async () => {
    const ids = Object.entries(unread).filter(([, n]) => n > 0).map(([id]) => id);
    for (const id of ids) { try { await markRead(id, await loadView(id)); } catch {} }
    setConvPrefs((p) => Object.fromEntries(Object.entries(p).map(([id, x]) => [id, x?.unread ? { ...x, unread: false, t: Date.now() } : x])));
    flashToast('✓ Đã đánh dấu tất cả là đã đọc');
  };
  // Phím tắt: Ctrl+K tìm kiếm · Alt+↑/↓ hội thoại trước/sau · Esc đóng cửa sổ con · Ctrl+/ xem danh sách phím tắt.
  const navRef = useRef({ rows: [], activeId: null, open: null });
  useEffect(() => {
    const onKey = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault(); const s = document.querySelector('input.search'); s?.focus(); s?.select(); return;
      }
      if (ctrl && e.key === '/') { e.preventDefault(); flashToast('⌨️ Ctrl+K tìm kiếm · Alt+↑/↓ chuyển hội thoại · Esc đóng cửa sổ · Ctrl+V dán ảnh'); return; }
      if (e.altKey && !ctrl && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const { rows, activeId, open } = navRef.current; if (!rows.length || !open) return;
        e.preventDefault();
        const i = rows.findIndex((r) => r.id === activeId);
        const next = rows[i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowUp' ? -1 : 1)))];
        if (next?.meta) open(next.meta);
        return;
      }
      if (e.key === 'Escape') {
        const bds = document.querySelectorAll('.modal-backdrop');
        if (bds.length) { e.preventDefault(); bds[bds.length - 1].click(); }
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [flashToast]);
  // Hàm ngoài component (vd jumpToMsg) báo toast qua sự kiện cửa sổ.
  useEffect(() => {
    const h = (e) => flashToast(String(e.detail || ''));
    window.addEventListener('reachat:toast', h); return () => window.removeEventListener('reachat:toast', h);
  }, [flashToast]);

  useEffect(() => {
    const k = 'reachat.keyReset.' + user.username;
    if (localStorage.getItem(k)) {
      localStorage.removeItem(k);
      setTimeout(() => flashToast('🔑 Đã đặt lại mật khẩu bằng mã email/SMS trên máy mới: tạo khóa mã hóa mới — tin nhắn mã hóa cũ không đọc được trên máy này. Hãy tạo mã khôi phục mới trong Cài đặt → Bảo mật.', { label: 'Đã hiểu', fn: () => {} }), 800);
    }
  }, [user.username, flashToast]);

  // Hết hạn mức chuyển tiếp cuộc gọi (TURN) tháng này: vẫn gọi được nếu hai máy nối thẳng; báo một lần mỗi phiên.
  useEffect(() => {
    let shown = false;
    const h = (e) => { if (shown) return; shown = true;
      flashToast(e.detail === 'user' ? '⚠️ Bạn đã dùng hết hạn mức chuyển tiếp cuộc gọi tháng này — cuộc gọi chỉ kết nối được khi hai máy nối thẳng với nhau.'
        : '⚠️ Máy chủ đã dùng hết hạn mức chuyển tiếp cuộc gọi miễn phí tháng này — cuộc gọi chỉ kết nối được khi hai máy nối thẳng với nhau.', { label: 'Đã hiểu', fn: () => {} }); };
    window.addEventListener('reachat:turnBlocked', h);
    return () => window.removeEventListener('reachat:turnBlocked', h);
  }, [flashToast]);

  const markRead = useCallback(async (convId, msgs) => {
    const top = Math.max(0, ...(msgs || []).map((m) => m.seq || 0));
    if (top > 0) {
      rtRef.current?.read(convId, top);
      await db.setMeta('read.' + convId, top);
      refreshUnread();
    }
  }, [refreshUnread]);

  // Thông báo desktop khi có tin mới và cửa sổ/không ở đúng hội thoại.
  const notify = useCallback((m, text) => {
    try {
      const cur = activeRef.current;
      if (!document.hidden && cur && cur.conversationId === m.conversationId) return;
      // Đã tắt thông báo hội thoại -> chỉ báo khi được nhắc tên @mình.
      const mentioned = typeof text === 'string' && new RegExp('@' + user.username + '\\b', 'i').test(text);
      if (convPrefsRef.current[m.conversationId]?.muted && !mentioned) return;
      // Giờ yên lặng: chỉ người ưu tiên mới được báo.
      if (isQuietNow(quietRef.current) && !(quietRef.current.priority || []).includes(m.senderUsername)) return;
      if (convPrefsRef.current[m.conversationId]?.secret) {           // trò chuyện ẩn: không lộ người gửi / nội dung
        playMessage();
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('ReaChat', { body: translateText('Bạn có tin nhắn mới') });
        return;
      }
      const title = (mentioned ? '🔔 Nhắc tới bạn — ' : '') + (m.senderUsername ? '@' + m.senderUsername : 'Tin nhắn mới');
      if (m.type === 'call') { const o = callInfo(m); if (!o || !['missed', 'cancelled'].includes(o.status)) return; }
      playMessage();                                              // âm báo (tắt được trong Cài đặt → Tùy chọn)
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const body = m.type === 'image' ? '[hình ảnh]' : m.type === 'file' ? '[tệp]' : m.type === 'video' ? '🎬 Video' : m.type === 'location' ? '📍 Vị trí' : m.type === 'call' ? '📞 Cuộc gọi nhỡ' : text;
      const n = new Notification(translateText(title), { body: m.type === 'text' ? String(body).slice(0, 120) : translateText(String(body).slice(0, 120)) });
      n.onclick = () => {                                         // bấm thông báo: hiện cửa sổ (kể cả đang ở khay) + mở hội thoại
        window.reachat?.win?.show(); window.focus();
        const meta = convMetaRef.current[m.conversationId];
        if (meta) openByMetaRef.current?.(meta);
      };
    } catch {}
  }, [user.username]);

  // ---- Tin tự hủy: xóa mọi dấu vết cục bộ rồi gửi xác nhận "đã xóa trên thiết bị này" ----
  const sendAcks = useCallback(() => {
    const ids = [...pendingAcksRef.current];
    if (ids.length && rtRef.current?.isOpen) rtRef.current.destructAck(ids.slice(0, 200), deviceIdRef.current);
  }, []);
  const wipeLocal = useCallback((m, oldBody) => {
    try {
      const meta = JSON.parse(oldBody || '{}');
      if (meta.fileId) {
        const u = mediaCache.current.get(meta.fileId); if (u) { try { URL.revokeObjectURL(u); } catch {} }
        mediaCache.current.delete(meta.fileId);
        if (mediaKeysRef.current[meta.fileId]) { delete mediaKeysRef.current[meta.fileId]; saveMediaKeys(user.username, mediaKeysRef.current); }
      }
    } catch {}
    pendingAcksRef.current.add(m.id);
    try { localStorage.setItem('reachat.dack.' + user.username, JSON.stringify([...pendingAcksRef.current])); } catch {}
    setTimeout(sendAcks, 50);
  }, [user.username, sendAcks]);

  const persist = useCallback(async (m, plaintext) => {
    if (m.type === 'keydist') { if (m.seq > maxSeqRef.current) maxSeqRef.current = m.seq; return; } // không lưu/hiển thị
    if (DECRYPT_FAIL.has(plaintext) && m.conversationId?.startsWith('dm_')) {
      const early = pendingCopiesRef.current[m.id];                 // bản sao đã tới trước
      if (typeof early?.t === 'string') { plaintext = early.t; delete pendingCopiesRef.current[m.id]; }
      else setTimeout(() => rtRef.current?.getCopies([m.id]), 1500); // thiết bị khác có thể đang giải -> xin lại
    }
    const prev = await db.getMessageById(m.id);
    if (m.recalled && m.expireAt) wipeLocal(m, prev?.body);       // tự hủy: xóa khóa/ảnh đã giải mã + xác nhận
    // Lịch sử sửa: giữ bản đọc được TRƯỚC khi sửa (chỉ trên máy này, trong cache cục bộ); thu hồi thì xóa luôn.
    try {
      if (m.recalled && prev && !prev.recalled) await db.setMeta('edits.' + m.id, '');
      else if (prev && !m.recalled && m.editedAt && (prev.editedAt || null) !== m.editedAt && prev.body !== plaintext && !DECRYPT_FAIL.has(prev.body) && !DECRYPT_FAIL.has(plaintext)) {
        const hist = JSON.parse((await db.getMeta('edits.' + m.id)) || '[]');
        hist.push({ body: prev.body, at: prev.editedAt || prev.createdAt });
        await db.setMeta('edits.' + m.id, JSON.stringify(hist.slice(-20)));
      }
    } catch {}
    // Đang xem rộng hơn mặc định (đã "tải tin cũ") -> tin mới không được đẩy tin cũ nhất ra khỏi khung.
    if (!prev && viewLimitRef.current > 40 && activeRef.current?.conversationId === m.conversationId) viewLimitRef.current++;
    await db.upsertMessage({ ...m, body: plaintext });
    applyReactions(m);
    if (m.destructAcks) setDestructAcks((p) => ({ ...p, [m.id]: m.destructAcks }));
    if (m.seq && m.seq > maxSeqRef.current) maxSeqRef.current = m.seq;
    if (m.modSeq > maxModRef.current) { maxModRef.current = m.modSeq; db.setMeta('modSeq', m.modSeq); }
    await refreshConvList();
    const cur = activeRef.current;
    if (cur && cur.conversationId === m.conversationId) {
      const msgs = await loadView(m.conversationId);
      setMessages(msgs);
      if (m.senderUsername && m.senderUsername !== user.username) markRead(m.conversationId, msgs);
      else await refreshUnread();
    } else {
      await refreshUnread();
    }
  }, [applyReactions, refreshConvList, markRead, refreshUnread, loadView, wipeLocal, user.username]);

  // Người tạo nhóm: sinh khóa nhóm, niêm phong cho từng thành viên, gửi tin keydist.
  // conversation:new chỉ phát khi nhóm vừa tạo -> không ghi đè khóa nhóm cũ.
  const distributeGroupKeyIfOwner = useCallback(async (c) => {
    if (!c || c.type !== 'group' || c.ownerId !== user.id || c.channel) return;
    if (groupKeysRef.current[c.id]) return;
    const key = crypto.newGroupKey();
    const keys = {};
    for (const mem of c.members || []) {
      if (mem.username === user.username || !mem.publicKey) continue;
      keys[mem.username] = crypto.sealGroupKey(key, mem.publicKey, user.username);
    }
    groupKeysRef.current[c.id] = { key, by: user.username, t: Date.now() };
    persistGroupKeys();
    rtRef.current?.send({ conversationId: c.id, body: JSON.stringify({ keys, by: user.username }), enc: false, msgType: 'keydist' });
  }, [user.id, user.username]);

  // Thêm thành viên: người thêm niêm phong khóa HIỆN TẠI + các khóa CŨ cho thành viên mới
  // (đọc được lịch sử nhóm).
  // Nhóm chưa có khóa (tạo trước khi có E2E nhóm): người gửi đầu tiên tự sinh + phân phối khóa, từ đó tin nhóm được mã hóa.
  const ensureGroupKey = async (convId) => {
    const g = groupKeysRef.current[convId];
    if (g?.key) return g.key;
    const c = convMetaRef.current[convId];
    if (!c || c.type !== 'group' || c.left || c.channel) return null;      // kênh công khai: không mã hóa
    if (ensuringRef.current[convId]) return ensuringRef.current[convId];       // đang tạo (gửi liên tiếp)
    const job = (async () => {
      const key = crypto.newGroupKey();
      const keys = {};
      for (const mem of c.members || []) {
        if (mem.username === user.username) continue;
        let pk = mem.publicKey;
        if (!crypto.validPublicKey(pk)) { try { pk = (await api.lookupUser(mem.username, token))?.publicKey; } catch {} }
        if (crypto.validPublicKey(pk)) keys[mem.username] = crypto.sealGroupKey(key, pk, user.username);
      }
      return { key, keys };
    })();
    ensuringRef.current[convId] = job.then((r) => r.key);
    const { key, keys } = await job;
    delete ensuringRef.current[convId];
    if (groupKeysRef.current[convId]?.key) return groupKeysRef.current[convId].key;   // khóa tới trong lúc chờ
    groupKeysRef.current[convId] = { key, by: user.username, t: Date.now() };
    persistGroupKeys();
    rtRef.current?.send({ conversationId: convId, body: JSON.stringify({ keys, by: user.username, upgrade: true }), enc: false, msgType: 'keydist' });
    return key;
  };

  ensureGroupKeyRef.current = ensureGroupKey;

  const shareGroupKeys = useCallback((c, usernames, pkOverride = {}) => {
    const g = groupKeysRef.current[c.id];
    if (!g?.key) return;
    const keys = {}, oldKeys = {};
    for (const mem of c.members || []) {
      const pk = pkOverride[mem.username] || mem.publicKey;
      if (!usernames.includes(mem.username) || !crypto.validPublicKey(pk)) continue;
      keys[mem.username] = crypto.sealGroupKey(g.key, pk, user.username);
      oldKeys[mem.username] = (g.old || []).map((k) => crypto.sealGroupKey(k, pk, user.username));
    }
    if (!Object.keys(keys).length) return;
    rtRef.current?.send({ conversationId: c.id, body: JSON.stringify({ keys, oldKeys, by: user.username }), enc: false, msgType: 'keydist' });
  }, [user.username]);
  shareGroupKeysRef.current = shareGroupKeys;

  // Có người rời / bị mời ra: trưởng nhóm XOAY khóa, chỉ phát cho người còn lại
  // -> người đã rời không đọc được tin mới. Khóa cũ giữ để đọc tin cũ.
  const rotateGroupKey = useCallback((c) => {
    const g = groupKeysRef.current[c.id];
    const key = crypto.newGroupKey();
    const keys = {};
    for (const mem of c.members || []) {
      if (mem.username === user.username || !crypto.validPublicKey(mem.publicKey)) continue;
      keys[mem.username] = crypto.sealGroupKey(key, mem.publicKey, user.username);
    }
    groupKeysRef.current[c.id] = { key, by: user.username, old: g?.key ? [g.key, ...(g.old || [])] : [], t: Date.now() };
    persistGroupKeys();
    rtRef.current?.send({ conversationId: c.id, body: JSON.stringify({ keys, by: user.username, rot: true }), enc: false, msgType: 'keydist' });
  }, [user.username]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { maxSeq } = await db.init(user.username);
      maxSeqRef.current = maxSeq || 0;
      maxModRef.current = Number(await db.getMeta('modSeq')) || 0;
      // Vừa đồng bộ khóa từ bản sao lưu -> kéo lại lịch sử, chỉ giải mã lại tin từng lỗi.
      if (localStorage.getItem('reachat.resync.' + user.username)) {
        localStorage.removeItem('reachat.resync.' + user.username);
        maxSeqRef.current = 0; maxModRef.current = 0; resyncRef.current = true;
      }
      try { await api.uploadKey(token, crypto.publicKeyBase64(user.username)); } catch {}
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission(); } catch {}
      await refreshConvList();
      await refreshUnread();
      await refreshContacts();
      await refreshFriendReqs();
      await refreshStories();
      try { setBlocked(new Set((await api.listBlocks()).map((u) => u.username))); } catch {}
      const rt = new api.Realtime(token, {
        currentSeq: () => maxSeqRef.current,
        currentMod: () => maxModRef.current,
        onUnauthorized: () => window.dispatchEvent(new Event('reachat:unauthorized')),
        onReady: () => {
          setTimeout(() => pruneMediaKeys(), 5000);
          rtRef.current?.gcallList();
          if (gcallRef.current) {                                       // rớt mạng giữa cuộc gọi nhóm -> tự vào lại
            const g = gcallRef.current;
            g.resetPeers();
            setGcall((c) => (c ? { ...c, status: 'joining' } : c));
            rtRef.current?.gcallJoin(g.conversationId, g.video, true);
          }
          if (alive) setConnected(true); sendAcks(); setTimeout(() => recoverOldCopies(), 1500); },
        onDestructAcks: (id, acks) => setDestructAcks((p) => ({ ...p, [id]: acks })),
        onDestructAcked: (ids) => {
          for (const id of ids || []) pendingAcksRef.current.delete(id);
          try { localStorage.setItem('reachat.dack.' + user.username, JSON.stringify([...pendingAcksRef.current])); } catch {}
        },
        onHistory: async ({ conversationId, messages: list, hasMore }) => {
          const h = historyRef.current; historyRef.current = null;
          for (const m of list) if (m.type === 'keydist') await decodeIncoming(m);
          let added = 0;
          for (const m of list) {
            if (m.type === 'keydist') continue;
            const old = await db.getMessageById(m.id);
            if (old && !DECRYPT_FAIL.has(old.body)) continue;
            await db.upsertMessage({ ...m, body: await decodeIncoming(m, { historical: true }) });
            applyReactions(m); added++;
          }
          const cur = activeRef.current;
          if (cur && cur.conversationId === conversationId) {
            viewLimitRef.current += added;
            setMessages(await loadView(conversationId));
            setCanLoadOlder(hasMore);
            const failed = list.filter((m) => m.conversationId.startsWith('dm_')).map((m) => m.id);
            if (failed.length) rtRef.current?.getCopies(failed);
          }
          if (h) setLoadingOlder(false);
        },
        onError: (e) => { console.warn('WS error:', e); flashToast('⚠️ ' + e); },
        onPresenceInit: (list) => setOnline(new Set(list.map((x) => x.username))),
        onPresence: (p) => setOnline((s) => { const n = new Set(s); p.online ? n.add(p.username) : n.delete(p.username); return n; }),
        onTyping: (t) => {
          setTyping((prev) => { const set = new Set(prev[t.conversationId] || []); t.isTyping ? set.add(t.username) : set.delete(t.username); return { ...prev, [t.conversationId]: [...set] }; });
          clearTimeout(typingTimers.current[t.conversationId + t.username]);
          if (t.isTyping) typingTimers.current[t.conversationId + t.username] = setTimeout(() =>
            setTyping((prev) => ({ ...prev, [t.conversationId]: (prev[t.conversationId] || []).filter((u) => u !== t.username) })), 4000);
        },
        onReceipt: (r) => setStatus((prev) => {
          const cur = prev[r.conversationId] || { deliveredSeq: 0, reads: {} };
          if (r.state === 'delivered') return { ...prev, [r.conversationId]: { ...cur, deliveredSeq: Math.max(cur.deliveredSeq, r.seq) } };
          if (r.state === 'read') return { ...prev, [r.conversationId]: { ...cur, reads: { ...cur.reads, [r.username]: r.lastReadSeq } } };
          return prev;
        }),
        onMessage: async (m) => {
          // Hội thoại 1-1 do người kia vừa tạo (tin đầu tiên): máy chủ không gửi conversation:new -> xin lại danh sách,
          // nếu không dòng hội thoại hiện "@…" và bấm không mở được.
          if (!convMetaRef.current[m.conversationId]) rtRef.current?.requestConversations();
          const text = await decodeIncoming(m);
          await persist(m, text);
          if (m.type !== 'keydist' && m.senderUsername && m.senderUsername !== user.username && !isRequestConv(m.conversationId, m.senderUsername)) notify(m, text);
        },
        onAck: async (ack) => { await persist(ack.message, await decodeIncoming(ack.message)); },
        onMessageUpdate: async (m) => { await persist(m, await decodeIncoming(m)); },
        onSyncBatch: async (list, more) => {
          // Khóa trước: mọi keydist trong lô (phân phối/chia/xoay) -> rồi mới giải mã tin.
          for (const m of list) if (m.type === 'keydist') await decodeIncoming(m);
          for (const m of list) {
            if (m.type === 'keydist') { if (m.seq > maxSeqRef.current) maxSeqRef.current = m.seq; continue; }
            // Tin đã có trong cache và ĐỌC ĐƯỢC -> không giải mã lại (DR không giải lại được);
            // chỉ thử lại tin từng lỗi (sau khi có khóa mới / đồng bộ khóa).
            const old = await db.getMessageById(m.id);
            if (m.modSeq > maxModRef.current) maxModRef.current = m.modSeq;
            if (m.destructAcks) setDestructAcks((p) => ({ ...p, [m.id]: m.destructAcks }));
            // Thay đổi khi offline (thu hồi/tự hủy/sửa) phải áp dụng dù tin cũ đọc được.
            const changed = old && ((m.recalled && !old.recalled) || (m.editedAt || null) !== (old.editedAt || null));
            if (old && !DECRYPT_FAIL.has(old.body) && !changed) {
              applyReactions(m);
              if (m.reactions) await db.upsertMessage({ ...old, reactions: m.reactions });   // giữ cảm xúc trong cache
              if (m.seq > maxSeqRef.current) maxSeqRef.current = m.seq;
              continue;
            }
            if (m.recalled && m.expireAt && !old?.recalled) wipeLocal(m, old?.body);   // kể cả chưa từng lưu: xác nhận máy này không giữ bản nào
            const body = await decodeIncoming(m);               // cache khóa nhóm nếu là keydist
            if (!old && viewLimitRef.current > 40 && activeRef.current?.conversationId === m.conversationId) viewLimitRef.current++;
            if (m.type !== 'keydist') await db.upsertMessage({ ...m, body });
            applyReactions(m);
            if (m.seq > maxSeqRef.current) maxSeqRef.current = m.seq;
          }
          db.setMeta('modSeq', maxModRef.current);
          if (more) rtRef.current?.sync(maxSeqRef.current, maxModRef.current);   // còn lô nữa
          await refreshConvList();
          await refreshUnread();                              // tin mới từ đồng bộ -> cập nhật số chưa đọc
          const cur = activeRef.current; if (cur) setMessages(await loadView(cur.conversationId));
        },
        onConversations: (list) => setConvMeta((prev) => { const n = { ...prev }; for (const c of list) n[c.id] = c; return n; }),
        onConversationNew: (c) => { setConvMeta((prev) => ({ ...prev, [c.id]: c })); refreshConvList(); distributeGroupKeyIfOwner(c); },
        onSignal: (from, data) => queueSig('in:' + from, async () => {
          const d = data && await openSig(from, data, data.callId);
          if (d) await signalHandlerRef.current?.(from, d);
          else console.warn('[signal] bỏ gói không xác thực được từ @' + from, data?.kind);
        }),
        onInvite: (m) => setGroupInvite((p) => ({ ...p, [m.conversationId]: { code: m.code, expiresAt: m.expiresAt } })),
        onInvitePreview: (m) => setInvitePreview(m),
        onChannelResults: (m) => setChannelResults(m.items),
        onChannelJoined: (convId) => { joinChannelRef.current = convId; setTimeout(() => { const meta = convMetaRef.current[convId]; if (meta) { openByMetaRef.current?.(meta); rtRef.current?.syncConversation(convId); } }, 300); },
        onMeetCreated: (m) => {
          setMeetLinks((p) => ({ ...p, [m.conversationId]: m.code }));
          setShowMeet(false);
          setTimeout(() => joinGroupCallRef.current?.(m.conversationId, true), 300);   // người tạo vào phòng ngay
        },
        onInviteJoined: (convId) => {
          if (meetJoinRef.current?.convId === convId || convMetaRef.current[convId]?.meeting) {
            const code = meetJoinRef.current?.code; meetJoinRef.current = null;
            if (code) setMeetLinks((p) => ({ ...p, [convId]: code }));
            setInvitePreview(null);
            setTimeout(() => joinGroupCallRef.current?.(convId, true), 400);
            return;
          }
          joinedRef.current = convId; setInvitePreview(null); flashToast('✓ Đã tham gia nhóm'); const meta = convMetaRef.current[convId]; if (meta) openByMetaRef.current?.(meta); },
        onGcallActive: (m) => {
          setGcalls((p) => { const n = { ...p }; if (m.callId) n[m.conversationId] = m; else delete n[m.conversationId]; return n; });
          if (!m.callId) { setGring((r) => (r?.conversationId === m.conversationId ? null : r)); return; }
          if (!m.ring || m.by === user.username || gcallRef.current || callRef.current) return;
          const q = quietRef.current;
          if (isQuietNow(q) && q.blockCalls && !(q.priority || []).includes(m.by)) return;   // giờ yên lặng: chỉ hiện dải "Tham gia"
          if (convPrefsRef.current[m.conversationId]?.muted) return;                          // nhóm đã tắt thông báo
          setGring({ conversationId: m.conversationId, by: m.by, video: m.video });
          try { window.reachat?.win?.show(); } catch {}
          try { if (document.hidden && Notification.permission === 'granted')
            new Notification(translateText('📞 Cuộc gọi nhóm'), { body: '@' + m.by + (getLang() === 'en' ? ' is calling ' : ' đang gọi ') + (convMetaRef.current[m.conversationId]?.title || 'nhóm') }).onclick = () => window.reachat?.win?.show(); } catch {}
        },
        onGcallJoined: (m) => {
          const g = gcallRef.current;
          if (!g) { rtRef.current?.gcallLeave(); return; }
          g.callId = m.callId;
          setGcall((c) => (c ? { ...c, status: 'in', pid: m.pid, callId: m.callId } : c));
          g.connectAll(m.peers);
        },
        onGcallPeer: (m) => {
          if (!m.joined) { gcallRef.current?.remove(m.pid); return; }
          if (recRef.current) setTimeout(() => rtRef.current?.gsignal(m.pid, { kind: 'record', on: true }), 1500);   // người mới vào cũng được báo đang ghi
        },
        onGcallEnded: (m) => {
          if (!gcallRef.current) return;
          flashToast(m.reason === 'elsewhere' ? 'Bạn đã vào cuộc gọi nhóm từ thiết bị khác'
            : m.reason === 'over' ? 'Cuộc gọi nhóm đã kết thúc trong lúc bạn mất kết nối' : 'Bạn không còn trong cuộc gọi nhóm');
          gcallRef.current.leave(); gcallRef.current = null;
          setGcall(null); setGpeers([]); setGlocal(null);
        },
        onGsignal: (m) => queueSig('gin:' + m.pid, async () => {
          const g = gcallRef.current;
          if (!g || !m.data) return;
          const d = await openSig(m.username, m.data, g.callId);
          if (d) await g.onSignal(m.pid, m.username, d);
          else console.warn('[gsignal] bỏ gói không xác thực được từ @' + m.username);
        }),
        onSyncChanged: (m) => { if (m.version > syncRef.current.version) syncNowRef.current?.(); },
        onGroupPending: (m) => flashToast('🛂 Đã gửi đề xuất thêm ' + m.usernames.map((u) => '@' + u).join(', ') + ' — chờ trưởng/phó nhóm duyệt'),
        onInvitePending: (m) => flashToast('🛂 Đã gửi yêu cầu tham gia “' + (m.title || 'nhóm') + '” — chờ trưởng/phó nhóm duyệt'),
        onFriendRequest: (from) => { refreshFriendReqs(); flashToast('💌 ' + (from?.displayName || from?.username) + ' muốn kết bạn'); },
        onFriendAccepted: (by) => { refreshFriendReqs(); refreshContacts(); refreshStories(); flashToast('🎉 ' + (by?.displayName || by?.username) + ' đã chấp nhận kết bạn'); },
        onStoryNew: () => refreshStories(),
        onPins: (conversationId, ids) => setPins((prev) => ({ ...prev, [conversationId]: ids })),
        onPoll: (messageId, tally) => setPollTallies((prev) => ({ ...prev, [messageId]: tally })),
        onEventRsvp: (messageId, tally) => setRsvps((prev) => ({ ...prev, [messageId]: tally })),
        onConversationUpdate: ({ conversation: c, by, added = [], removed = [], via }) => {
          setConvMeta((prev) => ({ ...prev, [c.id]: c }));
          refreshConvList();
          if (added.includes(user.username)) rtRef.current?.syncConversation(c.id); // mình vừa được thêm
          if (by === user.username && added.length && via !== 'invite') shareGroupKeys(c, added);   // mình thêm -> chia khóa
          if (via === 'invite' && c.ownerId === user.id) shareGroupKeys(c, added);  // vào bằng link mời -> trưởng nhóm chia khóa
          if (via === 'invite' && joinedRef.current === c.id && added.includes(user.username)) { joinedRef.current = null; openByMetaRef.current?.(c); }
          if (removed.length && c.ownerId === user.id) rotateGroupKey(c);           // trưởng nhóm xoay khóa
        },
        onTasks: (convId, items) => setTasksByConv((p) => ({ ...p, [convId]: items })),
        onDocUpdate: (m) => docSubsRef.current[m.conversationId]?.update(m),
        // Thiết bị khác của mình vừa giải được 1 tin 1-1 -> dùng bản sao để sửa tin lỗi / nạp khóa media.
        onCopy: async ({ messageId, data }) => {
          const copy = openSelf(data);
          if (!copy) return;
          const old = await db.getMessageById(messageId);
          if (!old) { pendingCopiesRef.current[messageId] = copy; return; }   // tin chưa kịp lưu -> giữ lại
          if (typeof copy.t === 'string' && DECRYPT_FAIL.has(old.body)) {
            await db.upsertMessage({ ...old, body: copy.t });
          } else if (copy.mk) {
            try {
              const meta = JSON.parse(old.body);
              if (meta.fileId && !mediaKeysRef.current[meta.fileId]) { mediaKeysRef.current[meta.fileId] = copy.mk; saveMediaKeys(user.username, mediaKeysRef.current); mediaCache.current.delete(meta.fileId); }
              if (meta.x) await db.upsertMessage({ ...old, body: openFileMeta(old, copy.mk) });
            } catch {}
          } else return;
          await refreshConvList();
          const cur = activeRef.current; if (cur && cur.conversationId === old.conversationId) setMessages(await loadView(cur.conversationId));
        },
        onDocSnapshot: (convId, updates) => docSubsRef.current[convId]?.snapshot(updates),
        onConversationRemoved: (convId, isChannel) => {
          setConvMeta((prev) => ({ ...prev, [convId]: { ...(prev[convId] || { id: convId, type: 'group' }), left: true } }));
          flashToast((isChannel ? 'Đã bỏ theo dõi kênh ' : 'Bạn không còn trong nhóm ') + (convMetaRef.current[convId]?.title || ''));
        },
        onScheduled: (m) => {
          const when = new Date(m.sendAt).toLocaleString('vi-VN');
          const msg = {
            created: m.cond === 'online' ? '📶 Sẽ gửi khi người nhận online' : m.cond === 'read' ? '👀 Sẽ gửi sau khi họ xem tin trước của bạn'
              : m.cond === 'noreply' ? '↩️ Sẽ gửi lúc ' + when + ' nếu họ chưa trả lời' : '⏰ Đã hẹn gửi lúc ' + when,
            sent: '✅ Tin chờ điều kiện đã được gửi',
            skipped: '↩️ Họ đã trả lời — tin nhắc lại đã được huỷ',
            expired: '⌛ Hết hạn chờ — tin chưa được gửi',
          }[m.action];
          if (msg) flashToast(msg);
          rtRef.current?.listScheduled();
        },
        onScheduledList: (items) => setScheduledItems(items),
      });
      rt.connect(maxSeqRef.current); rtRef.current = rt;
    })();
    return () => { alive = false; };
  }, [token, user.username, persist, decodeIncoming, applyReactions, refreshConvList, refreshUnread, refreshContacts, refreshFriendReqs, refreshStories, flashToast, notify, distributeGroupKeyIfOwner, shareGroupKeys, rotateGroupKey]);

  // Tin tự hủy hết hạn: xóa khỏi cache NGAY trên máy (không chờ server, kể cả khi offline).
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const gone = (await db.purgeExpired?.(Date.now())) || [];
        if (!gone.length) return;
        for (const g of gone) wipeLocal(g, g.body);
        await refreshConvList();
        const cur = activeRef.current;
        if (cur && gone.some((g) => g.conversationId === cur.conversationId)) setMessages(await loadView(cur.conversationId));
      } catch {}
    }, 1000);
    return () => clearInterval(t);
  }, [wipeLocal, refreshConvList, loadView]);

  // Kiểm tra khóa công khai mới nhất của đối phương; đổi so với lần trước -> cảnh báo.
  const checkPeerKey = useCallback(async (convId, peer) => {
    try {
      const u = await api.lookupUser(peer, token);
      if (!crypto.validPublicKey(u.publicKey)) return;
      const prev = keySeenRef.current[peer];
      if (!prev) { setKeySeen((s) => ({ ...s, [peer]: { pk: u.publicKey, verified: false } })); return; }
      if (prev.pk === u.publicKey) return;
      setKeySeen((s) => ({ ...s, [peer]: { pk: u.publicKey, verified: false, changedAt: Date.now(), prev: prev.pk, wasVerified: !!prev.verified } }));
      peersRef.current[convId] = { username: peer, publicKey: u.publicKey }; savePeers(user.username, peersRef.current);
    } catch {}
  }, [token, user.username]);

  useEffect(() => { openByMetaRef.current = openByMeta; });
  const openByMeta = useCallback(async (meta) => {
    const isCloud = meta.id === selfConvId;
    const peerUsername = isCloud ? user.username : peerUsernameOf(meta);
    setActive({ conversationId: meta.id, type: meta.type, title: meta.title, peerUsername, isCloud });
    setReply(null); setEditing(null); setTtl(0);
    setConvPrefs((p) => (p[meta.id]?.unread ? { ...p, [meta.id]: { ...p[meta.id], unread: false, t: Date.now() } } : p));
    setUnreadAtOpen((p) => ({ ...p, [meta.id]: unreadRef.current[meta.id] || 0 }));   // nhớ trước khi đánh dấu đã đọc
    if (peerUsername) await resolvePeerKey(meta.id, peerUsername);
    if (peerUsername && !isCloud) checkPeerKey(meta.id, peerUsername);   // phát hiện khóa đổi
    viewLimitRef.current = 40; historyRef.current = null; setLoadingOlder(false);
    const msgs = restoreReactions(await db.getMessages(meta.id, 40)); setMessages(msgs); markRead(meta.id, msgs);
    setCanLoadOlder(msgs.length >= 40 || !!meta.id);   // cache ít -> vẫn có thể còn tin cũ trên server
    const failed = msgs.filter((x) => DECRYPT_FAIL.has(x.body)).map((x) => x.id);   // xin bản sao từ thiết bị khác
    if (failed.length) rtRef.current?.getCopies(failed);
    const gone = msgs.filter((x) => x.recalled && x.expireAt).map((x) => x.id);   // tin tự hủy: ai đã xác nhận xóa
    if (gone.length) rtRef.current?.destructStatus(gone);
    rtRef.current?.requestPins(meta.id);                 // lấy danh sách tin đã ghim
    rtRef.current?.listTasks(meta.id);                   // việc cần làm của hội thoại
    try { const t = await db.getMeta('ttl.' + meta.id); if (t) setTtl(Number(t) || 0); } catch {}
  }, [peerUsernameOf, resolvePeerKey, markRead, checkPeerKey]);

  // Mở "Ghi chú riêng" (hội thoại với chính mình).
  const openCloud = () => openByMeta(convMetaRef.current[selfConvId] ||
    { id: selfConvId, type: 'direct', members: [{ username: user.username, displayName: user.displayName, avatar: user.avatar }] });

  // Tải thêm tin cũ hơn (phân trang).
  // Cache cục bộ trước; hết cache -> xin trang cũ hơn từ server (thiết bị mới / cache bị xóa / >500 tin).
  const loadOlder = useCallback(async () => {
    const cur = activeRef.current; if (!cur || historyRef.current) return;
    const oldest = messages[0];
    const older = oldest ? restoreReactions(await db.getMessages(cur.conversationId, 40, oldest.createdAt)) : [];
    if (older.length) { viewLimitRef.current += older.length; setMessages((m) => [...older, ...m]); }
    if (older.length >= 40) return;
    const seqs = [...older, ...messages].map((m) => m.seq).filter((x) => x > 0);
    const before = seqs.length ? Math.min(...seqs) : 0;
    if (before === 1) { setCanLoadOlder(false); return; }
    historyRef.current = { convId: cur.conversationId }; setLoadingOlder(true);
    rtRef.current?.history(cur.conversationId, before, 50);
    setTimeout(() => { if (historyRef.current) { historyRef.current = null; setLoadingOlder(false); } }, 8000);
  }, [messages]);

  // Tin 1-1 cũ hiện "[tin của bạn]"/lỗi: thiết bị NÀO còn bản đọc được trong cache thì sao lưu lên
  // (mã hóa khóa cá nhân) cho các thiết bị khác; đồng thời xin bản sao cho các tin lỗi của máy này.
  const recoverOldCopies = useCallback(async () => {
    try {
      if (!(await db.getMeta('backfill.v1'))) {
        const rows = (await db.listDmForBackfill?.()) || [];
        let n = 0;
        for (const r of rows) {
          if (TEXTLIKE.has(r.type)) { if (!DECRYPT_FAIL.has(r.body)) { rtRef.current?.putCopy(r.id, sealSelf({ t: r.body })); n++; } }
          else { try { const meta = JSON.parse(r.body); const mk = meta.dr && mediaKeysRef.current[meta.fileId]; if (mk) { rtRef.current?.putCopy(r.id, sealSelf({ mk })); n++; } } catch {} }
        }
        await db.setMeta('backfill.v1', String(Date.now()));
        if (n) console.log('[backfill] đã sao lưu', n, 'tin 1-1 cũ cho các thiết bị khác');
      }
      const failed = (await db.failedDmIds?.()) || [];
      for (let i = 0; i < failed.length; i += 200) rtRef.current?.getCopies(failed.slice(i, i + 200));
    } catch (e) { console.warn('recoverOldCopies', e); }
  }, []);

  const openDirect = async (peerUsername) => {
    peerUsername = peerUsername.toLowerCase().trim().replace(/^@+/, '');
    if (!peerUsername || peerUsername === user.username) return;
    const peer = await api.lookupUser(peerUsername, token);
    const convId = directConvId(user.id, peer.id);
    peersRef.current[convId] = { username: peer.username, publicKey: peer.publicKey }; savePeers(user.username, peersRef.current);
    const meta = convMetaRef.current[convId] || { id: convId, type: 'direct',
      members: [{ username: user.username, displayName: user.displayName, avatar: user.avatar },
                { username: peer.username, displayName: peer.displayName, lastSeen: peer.lastSeen, avatar: peer.avatar, isBot: !!peer.isBot }] };
    setConvMeta((prev) => ({ ...prev, [convId]: meta }));
    await openByMeta(meta);
  };

  const encryptFor = async (convId, type, peerUsername, text) => {
    if (convId === selfConvId) return { body: crypto.encryptGroup(text, groupKeysRef.current[selfConvId].key), enc: true };
    if (type === 'direct') {
      const peer = await resolvePeerKey(convId, peerUsername);
      if (peer?.publicKey) {
        // Double Ratchet: dùng phiên sẵn có, hoặc tạo mới (mình làm initiator).
        let st = ratchetRef.current[convId] || loadRatchet(user.username, convId);
        if (!st) st = await ratchet.initInitiator(crypto.getOrCreateKeypair(user.username), peer.publicKey);
        const msg = await ratchet.ratchetEncrypt(st, text);
        ratchetRef.current[convId] = st; saveRatchet(user.username, convId, st);
        sentPlainRef.current.set(msg.ct, text);            // để tự giải khi server dội lại
        // sc = bản sao cho CHÍNH MÌNH (khóa cá nhân): người nhận bỏ qua, mọi thiết bị của mình đọc lại được.
        const sc = crypto.encryptGroup(text, personalKeyRef.current[0]);
        return { body: JSON.stringify({ dr: 1, header: msg.header, nonce: msg.nonce, ct: msg.ct, sc }), enc: true };
      }
    } else if (type === 'group') {
      const gk = await ensureGroupKey(convId);
      if (gk) return { body: crypto.encryptGroup(text, gk), enc: true };
    }
    return { body: text, enc: false };
  };

  const sendMessage = async (text, msgType) => {
    if (!active || !text.trim()) return;
    if (text.length > 20000) {                                   // tin rất dài -> gửi thành tệp văn bản (không giới hạn độ dài)
      flashToast('📄 Tin dài được gửi dưới dạng tệp văn bản');
      return sendFile(new File([text], 'tin-nhan-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt', { type: 'text/plain' }));
    }
    const { body, enc } = await encryptFor(active.conversationId, active.type, active.peerUsername, text);
    if (editing) { rtRef.current?.edit(editing.id, body, enc); setEditing(null); return; }
    const common = { body, enc, replyTo: reply?.id || null, ...(msgType ? { msgType } : {}), ...(ttl ? { ttl: ttl * 1000 } : {}) };
    if (active.type === 'direct') rtRef.current?.send({ to: active.peerUsername, ...common });
    else rtRef.current?.send({ conversationId: active.conversationId, ...common });
    setReply(null);
  };

  // Gửi ảnh/file. 1-1: Double Ratchet (khóa từng tin). Nhóm: secretbox (khóa nhóm).
  // Server chỉ giữ ciphertext octet-stream trong mọi trường hợp đã mã hóa.
  // target: hội thoại đích (mặc định hội thoại đang mở; chuyển tiếp truyền hội thoại khác, không kèm trả lời/hẹn hủy).
  // Gửi tệp: chọn khóa (DR 1-1 / khóa nhóm / khóa Cloud / không mã hóa) -> tải lên (nhỏ: một lần; lớn: theo khúc,
  // không giới hạn kích thước) -> gửi tin metadata (tên/loại/kích thước nằm trong hộp mã hóa `x`).
  // target: hội thoại đích (mặc định hội thoại đang mở; chuyển tiếp truyền hội thoại khác, không kèm trả lời/hẹn hủy).
  const sendFile = async (file, msgTypeOverride, extra = {}, target = null) => {   // extra: vd { once: true } (xem một lần)
    const tgt = target || active;
    if (!tgt || !file) return;
    const fwd = !!target;
    const isImg = (file.type || '').startsWith('image/');
    const typeOf = () => msgTypeOverride || (isImg ? 'image' : 'file');
    const mime = file.type || 'application/octet-stream';
    const isCloud = tgt.conversationId === selfConvId;
    let key = null, encMeta = {}, onUploaded = null;
    if (tgt.type === 'direct' && !isCloud) {
      const peer = await resolvePeerKey(tgt.conversationId, tgt.peerUsername);
      if (peer?.publicKey) {
        // Double Ratchet: mỗi tệp một message key mới.
        let st = ratchetRef.current[tgt.conversationId] || loadRatchet(user.username, tgt.conversationId);
        if (!st) st = await ratchet.initInitiator(crypto.getOrCreateKeypair(user.username), peer.publicKey);
        const { header, mkB64 } = await ratchet.sendKey(st);
        ratchetRef.current[tgt.conversationId] = st; saveRatchet(user.username, tgt.conversationId, st);
        key = mkB64; encMeta = { dr: 1, header };
        onUploaded = (fileId) => { mediaKeysRef.current[fileId] = mkB64; saveMediaKeys(user.username, mediaKeysRef.current); };
      }
    } else if (tgt.type === 'group' || isCloud) {             // nhóm: khóa nhóm; Cloud: khóa cá nhân
      const gk = await ensureGroupKey(tgt.conversationId);
      if (gk) { key = gk; encMeta = { genc: true }; }
    }
    const info = { name: file.name, mime, size: file.size, dur: file.dur || 0 };
    const upId = 'u' + Math.random().toString(36).slice(2);
    let fileId, nonce = null, chunked = null;
    try {
      if (file.size > BIG_THRESHOLD) {
        setTransfers((t) => [...t, { id: upId, dir: 'up', name: file.name, pct: 0 }]);
        const r = await uploadChunked({ serverUrl: window.reachat.serverUrl, token, file, name: file.name, keyB64: key,
          onProgress: (p) => setTransfers((t) => t.map((x) => (x.id === upId ? { ...x, pct: p } : x))) });
        fileId = r.fileId; nonce = r.nonce; chunked = r.chunked;
      } else {
        let dataB64 = await fileToBase64(file);
        if (key) { const e = crypto.encryptGroupFileB64(dataB64, key); dataB64 = e.cipherB64; nonce = e.nonce; }
        const { file: fm } = await api.uploadFile({ name: key ? 'blob' : file.name, mime: 'application/octet-stream', dataB64 });
        fileId = fm.id;
      }
    } catch (e) { flashToast('⚠️ Không gửi được tệp: ' + (e.message || e)); return; }
    finally { setTransfers((t) => t.filter((x) => x.id !== upId)); }
    onUploaded?.(fileId);
    const meta = key ? { x: crypto.encryptGroup(JSON.stringify(info), key), nonce } : info;   // không khóa (bot): như cũ
    const body = JSON.stringify({ fileId, ...meta, ...(chunked ? { chunked } : {}), ...extra, ...encMeta });
    const frame = { body, enc: false, msgType: typeOf(), replyTo: fwd ? null : reply?.id || null, ...(ttl && !fwd ? { ttl: ttl * 1000 } : {}) };
    if (tgt.type === 'direct') rtRef.current?.send({ to: tgt.peerUsername, ...frame });
    else rtRef.current?.send({ conversationId: tgt.conversationId, ...frame });
    if (!fwd) setReply(null);
  };

  // ---- Vị trí trực tiếp: gửi tin vị trí rồi "sửa" tin đó mỗi khi vị trí đổi (tối đa 20 giây/lần) tới khi hết giờ ----
  const liveRef = useRef({});                                  // liveId -> { tgt, until, watchId, msgId, last, timer }
  const liveEdit = async (L, extra = {}) => {
    if (!L.msgId) {                                            // tìm tin vừa gửi trong bộ nhớ đệm
      const msgs = await db.getMessages(L.tgt.conversationId, 60);
      L.msgId = msgs.find((x) => x.type === 'location' && x.senderId === user.id && String(x.body).includes(L.id))?.id;
      if (!L.msgId) return;
    }
    const body = JSON.stringify({ ...L.pos, live: L.id, until: L.until, at: Date.now(), ...extra });
    const enc = await encryptFor(L.tgt.conversationId, L.tgt.type, L.tgt.peerUsername, body);
    rtRef.current?.edit(L.msgId, enc.body, enc.enc);
  };
  const stopLive = useCallback(async (id) => {
    const L = liveRef.current[id]; if (!L) return;
    delete liveRef.current[id];
    try { navigator.geolocation.clearWatch(L.watchId); } catch {}
    clearTimeout(L.timer);
    await liveEdit(L, { ended: true }).catch(() => {});
  }, []);
  useEffect(() => {
    const h = (e) => stopLive(e.detail);
    window.addEventListener('reachat:stopLive', h);
    return () => { window.removeEventListener('reachat:stopLive', h); for (const id of Object.keys(liveRef.current)) stopLive(id); };
  }, [stopLive]);
  const startLive = (mins) => {
    const tgt = active; if (!tgt || !navigator.geolocation) { flashToast('⚠️ Thiết bị không hỗ trợ định vị'); return; }
    flashToast('📍 Đang lấy vị trí…');
    const id = 'lv' + Math.random().toString(36).slice(2, 10), until = Date.now() + mins * 60_000;
    const L = { id, tgt, until, pos: null, last: 0 };
    const fail = setTimeout(() => { if (!L.pos) { try { navigator.geolocation.clearWatch(L.watchId); } catch {} flashToast('⚠️ Không lấy được vị trí tự động — chia sẻ trực tiếp cần bật định vị của thiết bị'); } }, 15000);
    L.watchId = navigator.geolocation.watchPosition(async (p) => {
      const pos = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy || 0) };
      if (!L.pos) {                                             // lần đầu: gửi tin
        clearTimeout(fail); L.pos = pos; L.last = Date.now(); liveRef.current[id] = L;
        L.timer = setTimeout(() => stopLive(id), until - Date.now());
        const enc = await encryptFor(tgt.conversationId, tgt.type, tgt.peerUsername, JSON.stringify({ ...pos, live: id, until, at: Date.now() }));
        const common = { body: enc.body, enc: enc.enc, msgType: 'location' };
        if (tgt.type === 'direct') rtRef.current?.send({ to: tgt.peerUsername, ...common }); else rtRef.current?.send({ conversationId: tgt.conversationId, ...common });
        flashToast('🔴 Đang chia sẻ vị trí trực tiếp');
        return;
      }
      L.pos = pos;
      if (Date.now() - L.last < 20_000 || !liveRef.current[id]) return;
      L.last = Date.now();
      liveEdit(L).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 10_000 });
  };

  // ---- Chia sẻ vị trí (một lần) — mã hóa như tin chữ ----
  // Tự lấy vị trí (GPS/Windows); không được trong 10 giây -> mở hộp nhập tay (dán link bản đồ / tọa độ).
  // Ghi chú: bộ định vị của Electron có thể không trả lời (không có dịch vụ định vị mạng) nên phải tự hẹn giờ.
  const [locAsk, setLocAsk] = useState(null);                 // { reason } khi cần nhập tay
  const sendLocation = () => {
    if (!active) return;
    if (!navigator.geolocation) { setLocAsk({ reason: 'Thiết bị không hỗ trợ định vị tự động.' }); return; }
    flashToast('📍 Đang lấy vị trí…');
    let done = false;
    const fail = (why) => { if (done) return; done = true; setLocAsk({ reason: why }); };
    const timer = setTimeout(() => fail('Không lấy được vị trí tự động (quá 10 giây).'), 10000);
    navigator.geolocation.getCurrentPosition(
      (p) => { if (done) return; done = true; clearTimeout(timer); sendMessage(JSON.stringify({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy || 0) }), 'location'); },
      (e) => { clearTimeout(timer); fail(e.code === 1 ? 'Bạn chưa cho phép định vị.' : 'Không xác định được vị trí tự động.'); },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
  };

  // ---- Gửi tệp trực tiếp máy-tới-máy (không lưu trên máy chủ) ----
  const p2pSignal = (peer, id) => (d) => queueSig('out:' + peer, async () => rtRef.current?.signal(peer, await sealSig(peer, { callId: id, ...d }, id)));
  const setPct = (id, p) => setTransfers((t) => t.map((x) => (x.id === id ? { ...x, pct: p } : x)));
  const sendP2P = async (file) => {
    const tgt = active;
    if (!tgt || tgt.type !== 'direct' || tgt.isCloud || !file) return;
    const peer = tgt.peerUsername;
    const viaServer = { label: 'Gửi qua máy chủ', fn: () => sendFile(file) };
    const id = 'ft_' + Math.random().toString(36).slice(2);
    setTransfers((t) => [...t, { id, dir: 'p2p', name: file.name, pct: 0 }]);
    const sess = startSend({ id, file, rtcConfig: await api.iceConfig(), signal: p2pSignal(peer, id), onProgress: (p) => setPct(id, p) });
    p2pSessions.current.set(id, { ...sess, peer });
    const giveUp = setTimeout(() => sess.cancel(), 120000);       // không ai nhận trong 2 phút -> huỷ
    try {
      await sess.done;
      const { body, enc } = await encryptFor(tgt.conversationId, tgt.type, peer, JSON.stringify({ name: file.name, size: file.size }));
      rtRef.current?.send({ to: peer, body, enc, msgType: 'p2pfile' });
      flashToast('📦 Đã gửi trực tiếp «' + file.name + '» — không lưu trên máy chủ');
    } catch (e) { flashToast('⚠️ Gửi trực tiếp không thành: ' + (e.message || e), viaServer); }
    finally { clearTimeout(giveUp); p2pSessions.current.delete(id); setTransfers((t) => t.filter((x) => x.id !== id)); }
  };
  const acceptP2P = async (inv) => {
    setP2pIncoming((l) => l.filter((x) => x.id !== inv.id));
    const sink = await openSink(inv.meta.name || 'tệp', inv.meta.mime);
    if (!sink) { p2pSignal(inv.from, inv.id)({ kind: 'ft-cancel' }); return; }
    setTransfers((t) => [...t, { id: inv.id, dir: 'down', name: inv.meta.name, pct: 0 }]);
    const sess = startReceive({ id: inv.id, offer: inv.offer, meta: inv.meta, rtcConfig: await api.iceConfig(), signal: p2pSignal(inv.from, inv.id), sink, onProgress: (p) => setPct(inv.id, p) });
    p2pSessions.current.set(inv.id, { ...sess, peer: inv.from, accepted: true });
    try { await sess.done; flashToast('✓ Đã nhận trực tiếp: ' + sink.where); }
    catch (e) { flashToast('⚠️ Nhận tệp không thành: ' + (e.message || e)); }
    finally { p2pSessions.current.delete(inv.id); setTransfers((t) => t.filter((x) => x.id !== inv.id)); }
  };
  const declineP2P = (inv) => { setP2pIncoming((l) => l.filter((x) => x.id !== inv.id)); p2pSignal(inv.from, inv.id)({ kind: 'ft-cancel' }); };
  p2pSignalRef.current = (from, d) => {
    const id = d.callId;
    const sess = p2pSessions.current.get(id);
    if (sess) { if (sess.peer === from) sess.onSignal(d); return; }
    if (d.kind === 'ft-offer' && d.meta && d.sdp) {
      setP2pIncoming((l) => (l.some((x) => x.id === id) ? l : [...l, { id, from, meta: d.meta, offer: d.sdp }]));
      try { window.reachat?.win?.show(); } catch {}
      notify({ conversationId: null, senderUsername: from, type: 'text' }, '📦 Muốn gửi trực tiếp: ' + d.meta.name);
    } else if (d.kind === 'ft-cancel' || d.kind === 'ft-taken') setP2pIncoming((l) => l.filter((x) => x.id !== id));   // huỷ / thiết bị khác đã nhận
  };

  // Các khóa có thể giải một tệp: DR -> khóa riêng của tin; nhóm -> khóa hiện tại + khóa cũ; Cloud -> khóa cá nhân.
  const fileKeysFor = (m, meta) => {
    if (meta.dr) return mediaKeysRef.current[meta.fileId] ? [mediaKeysRef.current[meta.fileId]] : [];
    if (meta.genc) {
      const g = groupKeysRef.current[m.conversationId];
      return m.conversationId === selfConvId ? [...personalKeyRef.current] : [g?.key, ...(g?.old || [])].filter(Boolean);
    }
    return [];
  };
  // Tệp lớn: tải từng khúc, giải mã, ghi thẳng ra đĩa (không nạp cả tệp vào bộ nhớ).
  const downloadBig = async (m, meta) => {
    const keys = fileKeysFor(m, meta);
    if (meta.chunked.enc && !keys.length) { flashToast('⚠️ Chưa có khóa để giải mã tệp này'); return; }
    const sink = await openSink(meta.name || 'tệp', meta.mime);
    if (!sink) return;
    const id = 'd' + Math.random().toString(36).slice(2);
    setTransfers((t) => [...t, { id, dir: 'down', name: meta.name || 'tệp', pct: 0 }]);
    try {
      await downloadChunked({ serverUrl: window.reachat.serverUrl, token, meta, keys, write: sink.write,
        onProgress: (p) => setTransfers((t) => t.map((x) => (x.id === id ? { ...x, pct: p } : x))) });
      await sink.close();
      flashToast('✓ Đã lưu: ' + sink.where);
    } catch (e) { try { await sink.close(); } catch {} flashToast('⚠️ Tải tệp lỗi: ' + (e.message || e)); }
    finally { setTransfers((t) => t.filter((x) => x.id !== id)); }
  };

  // Lấy objectURL cho ảnh/tệp: nếu đã mã hóa thì tải ciphertext + giải mã bằng
  // khóa peer của hội thoại (đối phương), rồi dựng blob với mime gốc.
  // Giữ Blob đã giải mã (chuyển tiếp cần lại byte; CSP không cho fetch(blob:)).
  const mediaBlobs = useRef(new Map());
  const keepBlob = (id, blob) => { mediaBlobs.current.set(id, blob); return URL.createObjectURL(blob); };
  const getMediaURL = useCallback(async (m, meta) => {
    if (!meta?.fileId) throw new Error('thiếu fileId');
    if (mediaCache.current.has(meta.fileId)) return mediaCache.current.get(meta.fileId);
    let url;
    if (meta.chunked) {
      const parts = [];
      await downloadChunked({ serverUrl: window.reachat.serverUrl, token, meta, keys: fileKeysFor(m, meta), write: (u8) => parts.push(u8) });
      url = keepBlob(meta.fileId, new Blob(parts, { type: meta.mime || 'application/octet-stream' }));
    } else if (meta.dr) {                                              // 1-1 Double Ratchet: secretbox với khóa từng tin
      const mkB64 = mediaKeysRef.current[meta.fileId];
      if (!mkB64) throw new Error('thiếu khóa file (ratchet)');
      const cipher = await api.fileBytes(meta.fileId);
      const plain = crypto.decryptGroupFileBytes(cipher, meta.nonce, mkB64);
      if (!plain) throw new Error('giải mã thất bại');
      url = keepBlob(meta.fileId, new Blob([plain], { type: meta.mime || 'application/octet-stream' }));
    } else if (meta.enc) {                                      // 1-1 cũ: box với khóa peer tĩnh
      const peer = await resolvePeerKey(m.conversationId);
      if (!peer?.publicKey) throw new Error('thiếu khóa peer');
      const cipher = await api.fileBytes(meta.fileId);
      const plain = crypto.decryptFileBytes(cipher, meta.nonce, peer.publicKey, user.username);
      if (!plain) throw new Error('giải mã thất bại');
      url = keepBlob(meta.fileId, new Blob([plain], { type: meta.mime || 'application/octet-stream' }));
    } else if (meta.genc) {                                     // nhóm: secretbox với khóa nhóm
      // Cloud: mọi khóa cá nhân (kể cả khóa cũ); nhóm: khóa nhóm.
      const g = groupKeysRef.current[m.conversationId];
      const keys = m.conversationId === selfConvId ? personalKeyRef.current : [g?.key, ...(g?.old || [])].filter(Boolean);
      if (!keys.length) throw new Error('thiếu khóa nhóm');
      const cipher = await api.fileBytes(meta.fileId);
      let plain = null;
      for (const k of keys) { plain = crypto.decryptGroupFileBytes(cipher, meta.nonce, k); if (plain) break; }
      if (!plain) throw new Error('giải mã thất bại');
      url = keepBlob(meta.fileId, new Blob([plain], { type: meta.mime || 'application/octet-stream' }));
    } else {
      url = await api.fileObjectURL(meta.fileId);
    }
    mediaCache.current.set(meta.fileId, url);
    return url;
  }, [resolvePeerKey, user.username]);

  // forwarding: 1 tin hoặc mảng tin (chọn nhiều) -> gửi lần lượt theo thứ tự thời gian.
  const doForward = async (targetMeta) => {
    const list = [].concat(forwarding || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    setForwarding(null);
    if (!list.length || !targetMeta) return;
    for (const m of list) await forwardOne(m, targetMeta);
    if (list.length > 1) flashToast(`Đã chuyển tiếp ${list.length} tin`);
  };
  const forwardOne = async (m, targetMeta) => {
    const peerU = peerUsernameOf(targetMeta);
    let body = m.body, enc = false, msgType = m.type;
    if (m.type === 'text') { const r = await encryptFor(targetMeta.id, targetMeta.type, peerU, m.body); body = r.body; enc = r.enc; }
    let plainMedia = false;
    try { const mm = JSON.parse(m.body); plainMedia = !mm.dr && !mm.genc && !mm.enc && !mm.x; } catch {}
    if (['image', 'file', 'voice'].includes(m.type) && !plainMedia) {   // tệp không mã hóa (cũ): gửi lại metadata như trước
      // Ảnh/tệp: giải mã bằng khóa hội thoại GỐC rồi gửi như tệp mới (mã hóa lại cho hội thoại đích).
      try {
        const meta = JSON.parse(m.body);
        if (meta.once) { flashToast('Không chuyển tiếp được ảnh xem một lần'); return; }
        if (meta.chunked && (meta.size || 0) > 500 * 1048576) { flashToast('Tệp trên 500 MB: hãy tải về rồi gửi lại'); return; }
        mediaCache.current.delete(meta.fileId);              // giải mã lại để chắc chắn có Blob
        await getMediaURL(m, meta);
        const blob = mediaBlobs.current.get(meta.fileId);
        if (!blob) throw new Error('tệp gốc không mã hóa — không chuyển tiếp được');
        const file = new File([blob], meta.name || 'tệp', { type: meta.mime || blob.type });
        if (meta.dur) file.dur = meta.dur;
        const isSelf = targetMeta.id === selfConvId;
        await sendFile(file, m.type, {}, { conversationId: targetMeta.id, type: isSelf ? 'direct' : targetMeta.type, peerUsername: isSelf ? user.username : peerU });
        flashToast('Đã chuyển tiếp');
      } catch (e) { flashToast('⚠️ Không chuyển tiếp được: ' + (e.message || e)); }
      return;
    }
    if (targetMeta.type === 'direct') rtRef.current?.send({ to: peerU, body, enc, msgType });
    else rtRef.current?.send({ conversationId: targetMeta.id, body, enc, msgType });
  };

  // ---- Sao lưu lịch sử ra tệp (mã hóa bằng mật khẩu sao lưu) ----
  // Gồm: mọi tin trong cache (đã giải mã), khóa nhóm, khóa media, tùy chọn trên máy. KHÔNG gồm khóa danh tính
  // (đã có bản sao lưu bọc mật khẩu trên server) và phiên ratchet (phiên cũ khôi phục sẽ lệch với đối phương).
  const LS_KEYS = ['groupkeys', 'mediakeys', 'hidden', 'convprefs', 'quick', 'keyseen', 'reminders', 'lanmsgs', 'quiet'];
  const exportBackup = async (password) => {
    const messages = await db.exportMessages();
    const local = {};
    for (const k of LS_KEYS) { const v = localStorage.getItem('reachat.' + k + '.' + user.username); if (v != null) local[k] = v; }
    const text = await crypto.sealBackupFile({ app: 'reachat', v: 1, user: user.username, createdAt: Date.now(), messages, local }, password);
    const name = `ReaChat-${user.username}-${new Date().toISOString().slice(0, 10)}.reachat-backup`;
    const where = await saveFile(name, new Blob([text], { type: 'application/json' }), 'doc');
    return { where, count: messages.length };
  };
  const importBackup = async (text, password) => {
    const b = await crypto.openBackupFile(text, password);
    if (b.user !== user.username) throw new Error(`Tệp sao lưu của @${b.user}, không phải tài khoản này`);
    const r = await db.importMessages(b.messages);
    const L = b.local || {};
    // Khóa nhóm: gộp (khóa trong tệp mà máy chưa có -> thêm vào danh sách khóa cũ để vẫn đọc được).
    try {
      const theirs = JSON.parse(L.groupkeys || '{}');
      for (const [cid, g] of Object.entries(theirs)) {
        const cur = groupKeysRef.current[cid];
        if (!cur) groupKeysRef.current[cid] = g;
        else for (const k of [g.key, ...(g.old || [])]) if (k && k !== cur.key && !(cur.old || []).includes(k)) cur.old = [...(cur.old || []), k];
      }
      persistGroupKeys();
    } catch {}
    try { const mine = { ...mediaKeysRef.current }; Object.assign(mediaKeysRef.current, JSON.parse(L.mediakeys || '{}'), mine); saveMediaKeys(user.username, mediaKeysRef.current); } catch {}
    // Tùy chọn khác: chỉ điền khi máy này chưa có (không đè cài đặt hiện tại).
    for (const k of ['hidden', 'convprefs', 'quick', 'keyseen', 'reminders', 'lanmsgs', 'quiet'])
      if (L[k] != null && localStorage.getItem('reachat.' + k + '.' + user.username) == null) localStorage.setItem('reachat.' + k + '.' + user.username, L[k]);
    mediaCache.current.clear();
    await refreshConvList(); await refreshUnread();
    const cur = activeRef.current; if (cur) setMessages(await loadView(cur.conversationId));
    return { ...r, total: b.messages.length, createdAt: b.createdAt };
  };

  const saveProfile = async ({ displayName, avatar }) => {
    const { user: u } = await api.updateProfile({ displayName, avatar });
    onUpdateUser({ displayName: u.displayName, avatar: u.avatar });
    setShowProfile(false);
  };

  const [sFilter, setSFilter] = useState({ kind: 'text', convId: '', sender: '', from: '', to: '' });
  const [showSFilter, setShowSFilter] = useState(false);
  const filterOn = (f) => f.kind !== 'text' || f.convId || f.sender || f.from || f.to;
  const runSearch = async (q, f = sFilter) => {
    setSearch(q);
    if (!q.trim()) setRevealSecret(false);                      // xóa ô tìm kiếm -> trò chuyện ẩn lại biến mất
    if (/^\d{4,6}$/.test(q) && secretPin?.hash && (await hashPin(q, secretPin.salt)).hash === secretPin.hash) {
      setRevealSecret(true); setSearch(''); setSearchResults(null); flashToast('🔓 Đang hiện trò chuyện ẩn — gõ rồi xóa ô tìm kiếm để ẩn lại'); return;
    }
    if (!q.trim() && !filterOn(f)) { setSearchResults(null); return; }
    const day = (s, end) => (s ? new Date(s + (end ? 'T23:59:59' : 'T00:00:00')).getTime() : null);
    const found = await db.searchMessages(q.trim(), 100, { kind: f.kind, convId: f.convId || null, sender: f.sender.trim() || null, from: day(f.from), to: day(f.to, true) });
    setSearchResults(revealSecret ? found : found.filter((r) => !convPrefsRef.current[r.conversationId]?.secret));
  };
  const setFilter = (patch) => { const f = { ...sFilter, ...patch }; setSFilter(f); runSearch(search, f); };

  // Danh bạ một chiều cũ đã gộp vào kết bạn: "thêm" = gửi lời mời kết bạn.
  const doAddContact = async (username) => { await sendFriendRequest(username.toLowerCase().replace(/^@+/, '').trim()); };
  // Link mời nhóm: reachat://join/<mã> hoặc chỉ mã. Trả true nếu chuỗi là link mời.
  const openInvite = (text) => {
    // Link kênh: KHÔNG tự theo dõi (trang web bất kỳ có thể mở link reachat://) -> mở bảng Kênh để người dùng tự bấm.
    const ch = String(text || '').trim().match(/^(?:reachat:\/\/)?c\/([a-z0-9_]{3,30})\/?$/i);
    if (ch) { setShowChannels(true); setChannelResults(null); rtRef.current?.channelSearch(ch[1].toLowerCase()); return true; }
    const mt = String(text || '').trim().match(/^(?:reachat:\/\/)?meet\/([a-z0-9]{6,20})\/?$/i);
    if (mt) { rtRef.current?.invitePreview(mt[1].toLowerCase()); return true; }
    const m = String(text || '').trim().match(/^(?:reachat:\/\/)?join\/([a-z0-9]{6,20})\/?$/i);
    if (!m) return false;
    rtRef.current?.invitePreview(m[1].toLowerCase());
    return true;
  };
  const openInviteRef = useRef(openInvite); openInviteRef.current = openInvite;
  useEffect(() => {                                               // mở từ thông báo đẩy: ?c=<hội thoại>
    if (!connected) return;
    const cid = new URLSearchParams(location.search).get('c');
    if (!cid) return;
    const t = setTimeout(() => { const meta = convMetaRef.current[cid]; if (meta) openByMetaRef.current?.(meta); history.replaceState(null, '', location.pathname); }, 800);
    return () => clearTimeout(t);
  }, [connected]);
  useEffect(() => {                                               // app mở bằng link reachat:// (bản cài đặt)
    const dl = window.reachat?.deeplink;
    if (!dl || !connected) return;
    dl.take().then((l) => l && openInviteRef.current(l));
    return dl.on((l) => openInviteRef.current(l));
  }, [connected]);
  const toggleBlock = async (username) => {
    if (blocked.has(username)) { await api.unblockUser(username); setBlocked((s) => { const n = new Set(s); n.delete(username); return n; }); }
    else { await api.blockUser(username); setBlocked((s) => new Set(s).add(username)); }
  };

  // ---- Kết bạn ----
  const sendFriendRequest = async (username) => {
    const res = await api.sendFriendRequest(username);
    await refreshFriendReqs();
    if (res.status === 'friends') { await refreshContacts(); flashToast('🎉 Đã là bạn bè với ' + (res.user.displayName || res.user.username)); }
    else flashToast('💌 Đã gửi lời mời tới ' + (res.user.displayName || res.user.username));
  };
  const acceptFriend = async (id) => { await api.acceptFriend(id); await refreshFriendReqs(); await refreshContacts(); await refreshStories(); };
  const declineFriend = async (id) => { await api.declineFriend(id); await refreshFriendReqs(); };

  // ---- Story (story) ----
  const postStory = async ({ kind, text, bg, file }) => {
    if (kind === 'image' && file) {
      const dataB64 = await fileToBase64(file);
      const { file: meta } = await api.uploadFile({ name: file.name, mime: file.type || 'image/jpeg', dataB64 });
      await api.postStory({ kind: 'image', fileId: meta.id, body: text || '' });
    } else {
      await api.postStory({ kind: 'text', body: text, bg });
    }
    setShowStoryCompose(false);
    await refreshStories();
    flashToast('✨ Đã đăng story (sống 24 giờ)');
  };
  // Mở xem story của một người (gộp các story còn hạn của họ).
  const openStories = async (authorId) => {
    const items = stories.filter((s) => s.userId === authorId);
    if (!items.length) return;
    setStoryView({ items, index: 0 });
    for (const s of items) if (!s.mine) { try { await api.viewStory(s.id); } catch {} }
    refreshStories();
  };
  const removeStory = async (id) => { await api.deleteStory(id); setStoryView(null); await refreshStories(); };

  // ---- Ghim / Xóa-phía-tôi / Tin tự hủy ----
  const togglePin = (m) => {
    const pinned = (pins[active?.conversationId] || []).includes(m.id);
    rtRef.current?.pin(m.id, !pinned);
  };
  const setHiddenSaved = (fn) => setHidden((s) => {
    const n = fn(new Set(s));
    try { localStorage.setItem('reachat.hidden.' + user.username, JSON.stringify([...n])); } catch {}
    return n;
  });
  const hideMessage = (id) => {
    setHiddenSaved((n) => { n.add(id); return n; });
    flashToast('Đã ẩn tin ở phía bạn', { label: 'Hoàn tác', fn: () => setHiddenSaved((n) => { n.delete(id); return n; }) });
  };
  const changeTtl = (secs) => { setTtl(secs); if (active) db.setMeta('ttl.' + active.conversationId, secs); };

  // ---- Nhắc hẹn trên tin (cục bộ, sống qua reload) ----
  useEffect(() => {
    try { localStorage.setItem('reachat.reminders.' + user.username, JSON.stringify(reminders)); } catch {}
    const timers = reminders.map((r) => setTimeout(() => {
      setReminders((list) => list.filter((x) => x.id !== r.id));
      flashToast('🔔 Nhắc hẹn: ' + r.text);
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(translateText('ReaChat — Nhắc hẹn'), { body: r.text }); } catch {}
    }, Math.max(0, r.at - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [reminders, user.username, flashToast]);
  const addReminder = (m, at) => {
    const title = m.conversationId === selfConvId ? 'Ghi chú riêng' : (convMeta[m.conversationId]?.title || '@' + (m.senderUsername || ''));
    const text = `${title}: ${msgPreview(m).slice(0, 80) || '[tin]'}`;
    setReminders((list) => [...list.filter((x) => x.msgId !== m.id), { id: 'r' + Date.now(), msgId: m.id, convId: m.conversationId, at, text }]);
    setReminding(null);
    flashToast('🔔 Sẽ nhắc lúc ' + new Date(at).toLocaleString('vi-VN'));
  };
  const removeReminder = (msgId) => { setReminders((list) => list.filter((x) => x.msgId !== msgId)); setReminding(null); };

  // ---- Giao việc: tiêu đề mã hóa bằng khóa của hội thoại ----
  const taskKeys = (convId) => {
    if (convId === selfConvId) return personalKeyRef.current;
    const g = groupKeysRef.current[convId]; if (g?.key) return [g.key, ...(g.old || [])];
    const peer = peersRef.current[convId];
    return peer && crypto.validPublicKey(peer.publicKey) ? crypto.sharedKeys(peer.publicKey, user.username) : [];
  };
  const encTitle = (convId, title) => { const k = taskKeys(convId)[0]; return k ? 'e:' + crypto.encryptGroup(title, k) : 'p:' + title; };
  const decTitle = (convId, s) => {
    if (s?.startsWith('p:')) return s.slice(2);
    for (const k of taskKeys(convId)) { const pt = crypto.decryptGroup(String(s).slice(2), k); if (pt != null) return pt; }
    return '[không giải mã được]';
  };
  const createTask = async ({ messageId, title, assignee, dueAt }) => {
    if (active.conversationId.startsWith('grp_')) await ensureGroupKey(active.conversationId);
    rtRef.current?.createTask({ conversationId: active.conversationId, messageId, titleEnc: encTitle(active.conversationId, title), assignee, dueAt });
    setAssigning(null);
  };
  // Việc giao cho MÌNH có hạn chót -> tự đặt nhắc hẹn; việc xong -> bỏ nhắc.
  useEffect(() => {
    for (const [convId, items] of Object.entries(tasksByConv)) {
      for (const t of items) {
        const rid = 'task:' + t.id;
        const has = reminders.some((r) => r.msgId === rid);
        if (t.assignee === user.username && t.dueAt > Date.now() && !t.done && !has) {
          setReminders((l) => [...l, { id: 'r' + t.id, msgId: rid, convId, at: t.dueAt, text: '📋 Đến hạn việc: ' + decTitle(convId, t.titleEnc).slice(0, 80) }]);
        } else if (t.done && has) setReminders((l) => l.filter((r) => r.msgId !== rid));
      }
    }
  }, [tasksByConv]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Trả lời story: gửi tin riêng (E2E) cho người đăng, kèm trích dẫn ----
  const replyToStory = async (s, text) => {
    const peer = s.author.username;
    const convId = directConvId(user.id, s.userId);
    if (!convMetaRef.current[convId]) setConvMeta((prev) => ({ ...prev, [convId]: { id: convId, type: 'direct',
      members: [{ username: user.username, displayName: user.displayName, avatar: user.avatar },
                { username: peer, displayName: s.author.displayName, avatar: s.author.avatar }] } }));
    const quote = s.kind === 'text' ? s.body : '[ảnh]' + (s.body ? ' ' + s.body : '');
    const content = `↩ Trả lời story: “${quote.slice(0, 60)}”\n${text}`;
    const { body, enc } = await encryptFor(convId, 'direct', peer, content);
    rtRef.current?.send({ to: peer, body, enc });
    flashToast('Đã gửi trả lời tới ' + (s.author.displayName || peer));
  };

  // ---- Bình chọn ----
  const sendPoll = (q, opts) => {
    if (!active) return;
    const body = JSON.stringify({ q, opts });            // poll KHÔNG mã hóa (cần đếm phiếu phía server)
    const frame = { body, enc: false, msgType: 'poll' };
    if (active.type === 'direct') rtRef.current?.send({ to: active.peerUsername, ...frame });
    else rtRef.current?.send({ conversationId: active.conversationId, ...frame });
    setShowPoll(false);
  };
  const votePoll = (messageId, idx) => rtRef.current?.vote(messageId, idx);
  const requestPoll = useCallback((messageId) => rtRef.current?.requestPoll(messageId), []);
  const [rsvps, setRsvps] = useState({});
  const requestRsvp = useCallback((messageId) => rtRef.current?.rsvpGet(messageId), []);
  // Trả lời sự kiện; "Tham gia" -> tự đặt nhắc 15 phút trước giờ bắt đầu (bỏ nhắc nếu đổi ý).
  const onRsvp = useCallback((m, status, ev) => {
    rtRef.current?.rsvp(m.id, status);
    setReminders((list) => {
      const rest = list.filter((r) => !(r.msgId === m.id && r.event));
      const at = (ev.at || 0) - 15 * 60_000;
      return status === 'yes' && at > Date.now() ? [...rest, { id: 'ev' + m.id, msgId: m.id, convId: m.conversationId, at, text: '📅 15 phút nữa: ' + ev.title, event: true }] : rest;
    });
  }, []);

  // ---- Hẹn giờ gửi ----
  // cond: null (hẹn giờ) | {kind:'online'|'read'|'noreply', fallback}; sendAt = giờ gửi / hạn chờ / giờ kiểm tra.
  const scheduleMessage = async (text, sendAt, cond = null) => {
    if (!active || !text.trim()) return;
    if (!(sendAt > Date.now())) { flashToast('⚠️ Thời điểm phải ở tương lai'); return; }
    const { body, enc } = await encryptFor(active.conversationId, active.type, active.peerUsername, text);
    const frame = { body, enc, sendAt, ...(cond ? { cond } : {}) };
    if (active.type === 'direct') rtRef.current?.schedule({ to: active.peerUsername, ...frame });
    else rtRef.current?.schedule({ conversationId: active.conversationId, ...frame });
    setScheduling(null);
  };
  const cancelScheduled = (id) => rtRef.current?.cancelScheduled(id);

  // Resolve nội dung tin đã ghim của hội thoại đang mở (từ cache cục bộ).
  useEffect(() => {
    let on = true;
    (async () => {
      const ids = (active && pins[active.conversationId]) || [];
      if (!ids.length) { if (on) setPinnedMsgs([]); return; }
      const found = await Promise.all(ids.map((id) => db.getMessageById(id).catch(() => null)));
      if (on) setPinnedMsgs(found.filter(Boolean));
    })();
    return () => { on = false; };
  }, [pins, active]);

  // Mở mã an toàn E2E cho hội thoại 1-1 đang mở: lấy khóa peer rồi tính 60 chữ số.
  const openSafety = async () => {
    if (!active || active.type !== 'direct' || !active.peerUsername) return;
    const peer = await resolvePeerKey(active.conversationId, active.peerUsername);
    if (!peer?.publicKey) { setSafety({ peerUsername: active.peerUsername, number: null }); return; }
    const myPub = crypto.publicKeyBase64(user.username);
    const number = crypto.safetyNumber(myPub, user.username, peer.publicKey, active.peerUsername);
    setSafety({ peerUsername: active.peerUsername, number, pk: peer.publicKey });
  };
  // Xác minh = gắn cờ cho ĐÚNG khóa hiện tại; khóa đổi sau đó -> mất xác minh + cảnh báo.
  const markVerified = (peer, pk, ok) => setKeySeen((s) => ({ ...s, [peer]: { ...(s[peer] || {}), pk, verified: ok, changedAt: ok ? undefined : s[peer]?.changedAt } }));
  const ackKeyChange = (peer) => setKeySeen((s) => ({ ...s, [peer]: { ...(s[peer] || {}), changedAt: undefined } }));

  // ---- Cuộc gọi WebRTC 1-1 ----------------------------------------------
  // ---- Chia sẻ màn hình (1-1 và nhóm) ----
  const [screenPick, setScreenPick] = useState(null);   // {resolve} khi đang chọn nguồn
  const screenRef = useRef(null);                       // track màn hình đang chia sẻ
  const pickScreen = () => new Promise((resolve) => setScreenPick({ resolve }));
  const stopScreen = useCallback(async (notify = true) => {
    const t = screenRef.current; screenRef.current = null;
    t?.stop();
    if (callRef.current?.setScreen) { await callRef.current.setScreen(null); if (notify) rtRef.current?.signal(callRef.current.peer, { callId: callRef.current.callId, kind: 'screen', on: false }); }
    const g = gcallRef.current;
    if (g) { await g.setScreen(null); if (notify) for (const pid of g.peers.keys()) rtRef.current?.gsignal(pid, { kind: 'screen', on: false }); }
    setCall((c) => (c ? { ...c, sharing: false } : c)); setGcall((c) => (c ? { ...c, sharing: false } : c));
  }, []);
  const startScreen = useCallback(async () => {
    if (screenRef.current) return stopScreen();
    try {
      if (window.reachat?.screen) {                     // app desktop: tự chọn màn hình/cửa sổ
        const id = await pickScreen();
        if (!id) return;
        await window.reachat.screen.choose(id);
      }
      const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      const track = st.getVideoTracks()[0];
      track.contentHint = 'detail';
      track.onended = () => stopScreen();               // người dùng dừng từ hệ thống / đóng cửa sổ đang chia sẻ
      screenRef.current = track;
      if (callRef.current?.setScreen) {
        await callRef.current.setScreen(track);
        rtRef.current?.signal(callRef.current.peer, { callId: callRef.current.callId, kind: 'screen', on: true });
        setCall((c) => (c ? { ...c, sharing: true } : c));
      } else if (gcallRef.current) {
        const g = gcallRef.current;
        await g.setScreen(track);
        for (const pid of g.peers.keys()) rtRef.current?.gsignal(pid, { kind: 'screen', on: true });
        setGcall((c) => (c ? { ...c, sharing: true } : c));
      } else track.stop();
    } catch (e) { if (e?.name !== 'NotAllowedError') flashToast('⚠️ Không chia sẻ được màn hình: ' + (e?.message || e)); }
  }, [stopScreen]);

  // ---- Ghi cuộc gọi (trên máy) ----
  const recRef = useRef(null);
  const notifyRec = (on) => {
    if (callRef.current?.peer) rtRef.current?.signal(callRef.current.peer, { callId: callRef.current.callId, kind: 'record', on });
    if (gcallRef.current) for (const pid of gcallRef.current.peers.keys()) rtRef.current?.gsignal(pid, { kind: 'record', on });
  };
  const stopRecording = useCallback(async (notify = true) => {
    const r = recRef.current; if (!r) return;
    recRef.current = null;
    if (notify) notifyRec(false);
    setCall((c) => (c ? { ...c, recording: false } : c)); setGcall((c) => (c ? { ...c, recording: false } : c));
    const blob = await r.stop();
    if (!blob) return;
    const name = 'ReaChat-cuoc-goi-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.webm';
    await saveFile(name, blob, 'video');
  }, []);
  const toggleRecording = useCallback(() => {
    if (recRef.current) return stopRecording();
    const g = gcallRef.current, c = callRef.current;
    const title = g ? (convMetaRef.current[g.conversationId]?.title || 'Cuộc gọi nhóm') : '@' + (c?.peer || '');
    const r = new CallRecorder({
      title,
      getVideos: () => [...document.querySelectorAll('.call-overlay video')].filter((v) => v.offsetWidth > 1 && !v.classList.contains('call-local')),
      getStreams: () => [g?.local || c?.localStream, ...[...document.querySelectorAll('.call-overlay video, .call-overlay audio')].map((e) => e.srcObject)].filter(Boolean),
    });
    try { r.start(); } catch (e) { flashToast('⚠️ Không ghi được: ' + e.message); return; }
    recRef.current = r;
    notifyRec(true);
    setCall((x) => (x ? { ...x, recording: true } : x)); setGcall((x) => (x ? { ...x, recording: true } : x));
    flashToast('🔴 Đang ghi cuộc gọi — mọi người trong cuộc gọi đã được báo');
  }, [stopRecording]);

  const cleanupCall = useCallback(() => {
    if (recRef.current) stopRecording(false);
    screenRef.current?.stop(); screenRef.current = null;
    try { callRef.current?.hangup?.(false); } catch {}
    callRef.current = null; earlyIceRef.current = [];
    setCallMedia({ local: null, remote: null });
    setCall(null);
  }, []);

  const buildSession = useCallback((peer, video, callId, rtcConfig, initiator) => {
    const sendSignal = (data) => queueSig('out:' + peer, async () => rtRef.current?.signal(peer, await sealSig(peer, { callId, ...data }, callId)));
    return new CallSession({
      callId, peer, video, sendSignal, rtcConfig, initiator,
      onState: (s, extra) => {
        if (s === 'connected' || s === 'reconnecting') setCall((c) => (c ? { ...c, status: s } : c));
        else if (s === 'route') setCall((c) => (c ? { ...c, route: extra } : c));
        else if (s === 'ended') cleanupCall();
      },
      onRemoteStream: (st) => setCallMedia((m) => ({ ...m, remote: st })),
      onLocalStream: (st) => setCallMedia((m) => ({ ...m, local: st })),
    });
  }, [cleanupCall]);

  // Thông báo lỗi thiết bị KHÔNG chặn (thay window.alert), có lý do dễ hiểu.
  const failCall = useCallback((peer, e, notifyPeer, callId) => {
    if (notifyPeer && callId) rtRef.current?.signal(peer, { callId, kind: 'hangup' });
    try { callRef.current?.hangup?.(false); } catch {}
    callRef.current = null; earlyIceRef.current = [];
    setCallMedia({ local: null, remote: null });
    const n = e?.name || '';
    const msg = n === 'NotAllowedError' ? 'Bạn chưa cấp quyền micro/camera.'
      : (n === 'NotReadableError' || n === 'TrackStartError') ? 'Micro/camera đang bị dùng bởi ứng dụng khác (hoặc cửa sổ kia trên cùng máy đang giữ camera). Thử gọi thoại 📞, hoặc đóng bên kia.'
      : n === 'NotFoundError' ? 'Không tìm thấy micro/camera trên máy.'
      : (e?.message || 'Lỗi thiết bị.');
    setCall({ status: 'error', peer, error: msg });
  }, []);

  const startCall = useCallback(async (peer, video) => {
    if (callRef.current || gcallRef.current) return;
    const callId = 'c_' + Math.random().toString(36).slice(2);
    callRef.current = { pending: true };                         // giữ chỗ trong lúc xin cấu hình ICE
    setCall({ status: 'calling', peer, video, callId });
    const rtcConfig = await api.iceConfig({ callId, peer });
    if (!callRef.current?.pending) return;                        // đã huỷ trong lúc chờ
    const sess = buildSession(peer, video, callId, rtcConfig, true);
    callRef.current = sess;
    try { await sess.start(); }
    catch (e) { failCall(peer, e, false, callId); }
  }, [buildSession, failCall]);

  const acceptCall = useCallback(async () => {
    const c = call; if (!c || c.status !== 'ringing') return;
    setCall({ ...c, status: 'connecting' });
    const sess = buildSession(c.peer, c.video, c.callId, await api.iceConfig({ callId: c.callId }), false);
    callRef.current = sess;
    try {
      await sess.accept(c.offer);
      for (const cand of earlyIceRef.current.splice(0)) await sess.onIce(cand);
    } catch (e) {
      failCall(c.peer, e, true, c.callId); // báo đối phương TRƯỚC rồi hiện lỗi
    }
  }, [call, buildSession, failCall]);

  const rejectCall = useCallback(() => {
    const c = call; if (c) rtRef.current?.signal(c.peer, { callId: c.callId, kind: 'reject' });
    cleanupCall();
  }, [call, cleanupCall]);

  const endCall = useCallback(() => { callRef.current?.hangup?.(true); cleanupCall(); }, [cleanupCall]);
  const toggleMute = () => { const muted = callRef.current?.toggleMute?.(); setCall((c) => (c ? { ...c, muted } : c)); };
  const toggleCam = () => { const camOff = callRef.current?.toggleCam?.(); setCall((c) => (c ? { ...c, camOff } : c)); };

  const handleSignal = useCallback(async (from, data) => {
    if (!data) return;
    const { kind, callId } = data;
    if (String(kind).startsWith('ft-')) { p2pSignalRef.current?.(from, data); return; }
    if (kind === 'offer') {
      if (callRef.current || call || gcallRef.current) { rtRef.current?.signal(from, { callId, kind: 'reject', reason: 'busy' }); return; }
      const q = quietRef.current;                                  // giờ yên lặng: tự từ chối người không ưu tiên
      if (isQuietNow(q) && q.blockCalls && !(q.priority || []).includes(from)) {
        rtRef.current?.signal(from, { callId, kind: 'reject', reason: 'quiet' });
        flashToast('🌙 Đã tự từ chối cuộc gọi của @' + from + ' (giờ yên lặng)');
        return;
      }
      setCall({ status: 'ringing', peer: from, video: !!data.video, offer: data.sdp, callId });
      try { window.reachat?.win?.show(); } catch {}                // đang ở khay -> hiện cửa sổ để thấy chuông
    } else if (kind === 'answer') {
      await callRef.current?.onAnswer?.(data.sdp);
    } else if (kind === 'screen') {
      setCall((c) => (c && c.peer === from ? { ...c, remoteScreen: !!data.on } : c));
    } else if (kind === 'record') {
      setCall((c) => (c && c.peer === from ? { ...c, remoteRec: !!data.on } : c));
      flashToast(data.on ? '🔴 @' + from + ' đang ghi lại cuộc gọi' : '@' + from + ' đã dừng ghi');
    } else if (kind === 'reoffer') {                               // ICE restart giữa cuộc gọi
      try { await callRef.current?.onReoffer?.(data.sdp); } catch {}
    } else if (kind === 'ice') {
      if (callRef.current?.onIce) await callRef.current.onIce(data.candidate);
      else earlyIceRef.current.push(data.candidate);
    } else if (kind === 'hangup' || kind === 'reject') {
      const cur = callRef.current?.callId || call?.callId;
      if (callId && cur && cur !== callId) return;
      const why = { offline: '@' + from + ' đang ngoại tuyến — đã ghi cuộc gọi nhỡ',
        timeout: '@' + from + ' không trả lời', unavailable: 'Không thể gọi @' + from,
        dropped: 'Mất kết nối với @' + from }[data.reason];
      if (why) flashToast(why);
      else if (kind === 'reject' && data.reason === 'quiet') flashToast('🌙 @' + from + ' đang trong giờ yên lặng — thử nhắn tin nhé');
      else if (kind === 'reject' && data.reason === 'busy') flashToast('@' + from + ' đang bận cuộc gọi khác');
      cleanupCall();
    }
  }, [call, cleanupCall]);
  useEffect(() => { signalHandlerRef.current = handleSignal; }, [handleSignal]);

  // ---- Cuộc gọi nhóm (mesh) ----
  const leaveGroupCall = useCallback(() => {
    if (recRef.current) stopRecording(false);
    screenRef.current = null;
    gcallRef.current?.leave(); gcallRef.current = null;
    rtRef.current?.gcallLeave();
    setGcall(null); setGpeers([]); setGlocal(null);
  }, []);
  const joinGroupCall = useCallback(async (conversationId, video) => {
    if (callRef.current || gcallRef.current) { flashToast('Bạn đang trong một cuộc gọi khác'); return; }
    setGring(null);
    setGcall({ conversationId, title: convMetaRef.current[conversationId]?.title || 'Nhóm', video, status: 'joining' });
    const g = new GroupCall({ video, rtcConfig: await api.iceConfig({ group: conversationId }), send: (pid, data, username) => queueSig('gout:' + pid, async () => rtRef.current?.gsignal(pid, await sealSig(username, data, g.callId))),
      onChange: setGpeers, onLocalStream: setGlocal });
    g.conversationId = conversationId;
    gcallRef.current = g;
    try { await g.init(); }
    catch (e) {
      gcallRef.current = null; setGcall(null);
      flashToast('⚠️ ' + (e?.name === 'NotAllowedError' ? 'Bạn chưa cấp quyền micro.' : e?.name === 'NotFoundError' ? 'Không tìm thấy micro.' : 'Không mở được micro/camera.'));
      return;
    }
    if (gcallRef.current !== g) { g.leave(); return; }               // đã bấm rời trong lúc chờ thiết bị
    setGcall((c) => (c ? { ...c, video: g.video } : c));
    rtRef.current?.gcallJoin(conversationId, g.video);
  }, []);
  joinGroupCallRef.current = joinGroupCall;
  const gToggleMute = () => { const muted = gcallRef.current?.toggleMute(); setGcall((c) => (c ? { ...c, muted } : c)); };
  const gToggleCam = () => { const camOff = gcallRef.current?.toggleCam(); setGcall((c) => (c ? { ...c, camOff } : c)); };

  const previews = Object.fromEntries(convList.map((c) => [c.conversationId, c]));
  const allIds = new Set([...Object.keys(convMeta), ...convList.map((c) => c.conversationId)]);
  const rows = [...allIds].map((id) => {
    const meta = convMeta[id];
    // Chưa có metadata (đang kết nối) -> đoán loại theo tiền tố id, không lộ id thô ra UI.
    const isGrp = meta ? meta.type === 'group' : id.startsWith('grp_');
    const title = isGrp ? (meta?.title || 'Nhóm…') : (peerUsernameOf(meta) || '…');
    return { id, meta, title, type: isGrp ? 'group' : 'direct', ...previews[id] };
  }).filter((r) => r.id !== selfConvId)                // Cloud hiển thị riêng ở đầu danh sách
    .filter((r) => revealSecret || !convPrefs[r.id]?.secret)      // trò chuyện ẩn: chỉ hiện khi đã nhập đúng PIN
    .filter((r) => !(convPrefs[r.id]?.clearedAt && (r.lastAt || 0) <= convPrefs[r.id].clearedAt))   // đã xóa, chưa có tin mới
    .map((r) => ({ ...r, request: isRequestRow(r) }))
    .sort((a, b) => (!!convPrefs[b.id]?.pinned - !!convPrefs[a.id]?.pinned) || ((b.lastAt || 0) - (a.lastAt || 0)));
  const requestRows = rows.filter((r) => r.request);
  const archivedRows = rows.filter((r) => !r.request && convPrefs[r.id]?.archived);
  const shownRows = rows.filter((r) => !!r.request === showRequests).filter((r) => {
    if (showRequests) return true;
    const pr = convPrefs[r.id] || {};
    if (convFilter === 'archived') return !!pr.archived;
    if (pr.archived) return false;                               // hội thoại lưu trữ: ẩn khỏi danh sách chính
    if (convFilter === 'unread') return unread[r.id] > 0 || pr.unread;
    if (convFilter !== 'all') return (pr.labels || []).includes(convFilter);
    return true;
  });
  navRef.current = { rows: shownRows, activeId: active?.conversationId || null, open: openByMeta };

  const activeMeta = active && convMeta[active.conversationId];
  const activeTyping = (typing[active?.conversationId] || []).filter((u) => u !== user.username);

  // Gộp story theo người đăng.
  const storyByUser = {};
  for (const s of stories) (storyByUser[s.userId] ||= []).push(s);
  const myStories = storyByUser[user.id] || [];
  const friendStoryGroups = Object.entries(storyByUser)
    .filter(([uid]) => uid !== user.id)
    .map(([uid, items]) => ({ uid, items, author: items[0].author, unseen: items.some((s) => !s.viewed) }));
  const incoming = friendReqs.incoming || [];
  const totalUnread = rows.reduce((n, r) => n + (convPrefs[r.id]?.muted ? 0 : unread[r.id] || 0), 0);

  return (
    <div className={'chat' + (active ? ' has-active' : '')}>
      {/* Thanh điều hướng dọc: logo, các khu vực chính, cài đặt và tài khoản ở dưới cùng */}
      <nav className="rail" aria-label="Điều hướng">
        <div className="rail-logo" title="ReaChat"><BrandMark size={30} /></div>
        <button className={'rail-btn' + (!showContacts ? ' on' : '')} title="Tin nhắn" onClick={() => setShowContacts(false)}>
          <Icon name="chat" size={21} />{totalUnread > 0 && <span className="rail-badge">{totalUnread > 99 ? '99+' : totalUnread}</span>}<span className="rail-label">Tin nhắn</span></button>
        <button className={'rail-btn' + (showContacts ? ' on' : '')} title="Danh bạ" onClick={() => setShowContacts((v) => !v)}>
          <Icon name="book" size={21} />{incoming.length > 0 && <span className="rail-badge">{incoming.length}</span>}<span className="rail-label">Danh bạ</span></button>
        <button className="rail-btn" title="Kênh công khai" onClick={() => { setShowChannels(true); setChannelResults(null); rtRef.current?.channelSearch(''); }}>
          <Icon name="megaphone" size={21} /><span className="rail-label">Kênh</span></button>
        <button className="rail-btn" title="Phòng họp" onClick={() => setShowMeet(true)}>
          <Icon name="video" size={21} /><span className="rail-label">Họp</span></button>
        {lanApi && (
          <button className={'rail-btn' + (lanOn ? ' on' : '')} title="Mạng LAN — nhắn tin khi không có Internet" onClick={() => setShowLan(true)}>
            <Icon name="wifi" size={21} />{lanUnread > 0 && <span className="rail-badge">{lanUnread}</span>}<span className="rail-label">LAN</span></button>
        )}
        <div className="rail-spacer" />
        <button className={'rail-btn small' + (isQuietNow(quiet) ? ' on' : '')} title="Giờ yên lặng" onClick={() => setShowQuiet(true)}><Icon name="bellOff" size={19} /></button>
        <button className="rail-btn small" title={theme === 'dark' ? 'Giao diện sáng' : 'Giao diện tối'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} /></button>
        <button className="rail-btn small" title="Cài đặt" onClick={() => setShowSettings(true)}><Icon name="settings" size={19} /></button>
        <button className="rail-me" title="Sửa hồ sơ" onClick={() => setShowProfile(true)}>
          <Avatar name={user.username} src={user.avatar} size={36} /><span className={'rail-presence ' + (connected ? 'ok' : 'off')} /></button>
        <button className="rail-btn small" title="Đăng xuất" onClick={onLogout}><Icon name="logout" size={19} /></button>
      </nav>

      <aside className="sidebar">
        <header className="side-head">
          <div className="side-title">
            <h2>{showContacts ? 'Danh bạ' : 'Tin nhắn'}</h2>
            <div className="my-status" onClick={() => setShowStatus(true)} title="Đặt trạng thái">
              {myStatus?.text ? <span><span data-user-content>{myStatus.text}</span>{myStatus.autoReply ? ' · 🤖' : ''}</span>
                : <span className="muted">＋ Đặt trạng thái</span>}</div>
          </div>
          <div className="side-actions">
            <button className="icon-btn" title="Kết bạn / Mã QR" onClick={() => setShowAddFriend(true)}>
              <Icon name="userPlus" size={19} />{incoming.length > 0 && <span className="dot-badge">{incoming.length}</span>}</button>
            <button className="icon-btn accent" title="Tạo nhóm" onClick={() => setShowGroup(true)}><Icon name="edit" size={18} /></button>
          </div>
        </header>
        {(!connected || isQuietNow(quiet)) && <div className={'status ' + (connected ? 'ok' : 'off')}>{connected ? '' : '○ Đang kết nối...'}
          {isQuietNow(quiet) && <span className="quiet-chip" onClick={() => setShowQuiet(true)}>🌙 Yên lặng đến {quiet.to}</span>}
          {!connected && lanApi && <span className="quiet-chip" onClick={() => setShowLan(true)}>📶 Dùng Mạng LAN</span>}</div>}

        <div className="toolbar">
          <div className="search-wrap">
            <Icon name="search" size={16} />
            <input className="search" placeholder="Tìm tin nhắn" value={search} onChange={(e) => runSearch(e.target.value)} />
            <button className={'icon-btn mini-ic' + (filterOn(sFilter) ? ' on' : '')} title="Bộ lọc tìm kiếm" onClick={() => setShowSFilter(!showSFilter)}><Icon name="sliders" size={15} /></button>
          </div>
        </div>

        {/* Story của mình + bạn bè */}
        {!showContacts && <div className="story-bar">
          <div className="story-item">
            <div className={'story-ring' + (myStories.length ? ' mine' : ' add')}
                 onClick={() => (myStories.length ? openStories(user.id) : setShowStoryCompose(true))} title="Story của bạn">
              <Avatar name={user.username} src={user.avatar} size={44} />
              <span className="story-plus" onClick={(e) => { e.stopPropagation(); setShowStoryCompose(true); }}>＋</span>
            </div>
            <span className="story-name">Của bạn</span>
          </div>
          {friendStoryGroups.map((g) => (
            <div className="story-item" key={g.uid} onClick={() => openStories(g.uid)} title={g.author.displayName || g.author.username}>
              <div className={'story-ring' + (g.unseen ? ' unseen' : ' seen')}>
                <Avatar name={g.author.username} src={g.author.avatar} size={44} />
              </div>
              <span className="story-name">{g.author.displayName || g.author.username}</span>
            </div>
          ))}
        </div>}

        {incoming.length > 0 && (
          <div className="friend-reqs">
            <div className="fr-head">Lời mời kết bạn ({incoming.length})</div>
            {incoming.map((r) => (
              <div className="fr-row" key={r.id}>
                <Avatar name={r.user.username} src={r.user.avatar} size={32} />
                <div className="fr-main"><b>{r.user.displayName}</b><div className="muted small">@{r.user.username}</div></div>
                <button className="mini ok" onClick={() => acceptFriend(r.id)}>Đồng ý</button>
                <button className="mini" onClick={() => declineFriend(r.id)}>Từ chối</button>
              </div>
            ))}
          </div>
        )}
        <NewChat onOpen={(v) => (openInvite(v) ? null : openDirect(v))} />
        {showContacts && (
          <div className="contacts-panel">
            <AddContact onAdd={doAddContact} />
            <ul className="contact-list">
              {contacts.map((c) => (
                <li key={c.username} onClick={() => { openDirect(c.username); setShowContacts(false); }}>
                  <Avatar name={c.username} src={c.avatar} size={36} />
                  <div className="contact-main"><b data-user-content>{c.displayName || c.username}</b><span className="muted small">@{c.username}</span></div>
                  {online.has(c.username) && <span className="dot-on" />}
                </li>
              ))}
              {contacts.length === 0 && <li className="muted small">Chưa có liên hệ</li>}
            </ul>
          </div>
        )}
        {showSFilter && <div className="search-filter">
          <select value={sFilter.kind} onChange={(e) => setFilter({ kind: e.target.value })}>
            <option value="text">Tin chữ</option><option value="link">Có liên kết</option><option value="image">Ảnh</option><option value="file">Tệp / tin thoại / video</option></select>
          <select value={sFilter.convId} onChange={(e) => setFilter({ convId: e.target.value })}>
            <option value="">Mọi hội thoại</option>{rows.map((r) => <option key={r.id} value={r.id}>{r.type === 'group' ? r.title : '@' + r.title}</option>)}</select>
          <input placeholder="Người gửi: @username" value={sFilter.sender} onChange={(e) => setFilter({ sender: e.target.value })} />
          <div className="row-inline"><span className="small">Từ</span><input type="date" value={sFilter.from} onChange={(e) => setFilter({ from: e.target.value })} />
            <span className="small">đến</span><input type="date" value={sFilter.to} onChange={(e) => setFilter({ to: e.target.value })} /></div>
          {filterOn(sFilter) && <button className="link small" onClick={() => { const f = { kind: 'text', convId: '', sender: '', from: '', to: '' }; setSFilter(f); runSearch(search, f); }}>Xóa bộ lọc</button>}
        </div>}
        {bdays.length > 0 && <div className="bday-banner">🎂 <span>Hôm nay là sinh nhật của</span> {bdays.map((u, i) => (<span key={u.username}>{i ? ', ' : ' '}
          <button className="link" onClick={() => openDirect(u.username)}><span data-user-content>{u.displayName || u.username}</span></button></span>))} 🎉</div>}
        {!searchResults && !showRequests && !showContacts && <div className="conv-filter">
          <button className={convFilter === 'all' ? 'on' : ''} onClick={() => setConvFilter('all')}>Tất cả</button>
          <button className={convFilter === 'unread' ? 'on' : ''} onClick={() => setConvFilter('unread')}>Chưa đọc</button>
          {labels.map((l) => <button key={l.id} className={convFilter === l.id ? 'on' : ''} onClick={() => setConvFilter(l.id)}><span className="label-dot" style={{ background: l.color }} /> <span data-user-content>{l.name}</span></button>)}
          {archivedRows.length > 0 && <button className={convFilter === 'archived' ? 'on' : ''} onClick={() => setConvFilter('archived')}>🗄️ <span>Lưu trữ</span> ({archivedRows.length})</button>}
          {(Object.values(unread).some((n) => n > 0) || Object.values(convPrefs).some((x) => x?.unread)) &&
            <button title="Đánh dấu tất cả đã đọc" onClick={markAllRead}>✓</button>}
          <button title="Tin đã đánh dấu sao" onClick={() => setShowStarred(true)}>⭐</button>
          <button className="icon-btn" title="Quản lý nhãn" onClick={() => setShowLabels(true)}>🏷️</button>
        </div>}
        {searchResults ? (
          <ul className="conv-list">
            <li className="muted small">{searchResults.length} kết quả</li>
            {searchResults.map((r) => (
              <li key={r.id} onClick={() => { const meta = convMeta[r.conversationId]; if (meta) openByMeta(meta); setSearch(''); setSearchResults(null); }}>
                <div className="preview" data-user-content>{r.type && r.type !== 'text' ? msgPreview(r) : r.body}</div>
                <div className="muted small"><span data-user-content>{(() => { const mm = convMeta[r.conversationId]; return mm ? (mm.type === 'group' ? mm.title : '@' + (peerUsernameOf(mm) || '')) : ''; })()}</span>{r.senderUsername ? ' · @' + r.senderUsername : ''} · {fmtTime(r.createdAt)}</div>
              </li>
            ))}
          </ul>
        ) : showContacts ? null : (
          <ul className="conv-list">
            {!showRequests && (<li className={'cloud-row' + (active?.conversationId === selfConvId ? ' on' : '')} onClick={openCloud} title="Ghi chú & tệp riêng — mã hóa bằng khóa của bạn">
              <div className="conv-row">
                <div className="cloud-av"><Icon name="notes" size={21} /></div>
                <div className="conv-main">
                  <b>Ghi chú riêng</b>
                  <div className="muted preview">{previews[selfConvId]?.preview || <span data-i18n>Lưu ghi chú, ảnh, tệp — chỉ mình bạn đọc được</span>}</div>
                </div>
              </div>
            </li>)}
            {(requestRows.length > 0 || showRequests) && (
              <li className={'requests-row' + (showRequests ? ' on' : '')} onClick={() => setShowRequests(!showRequests)}>
                {showRequests ? <span>‹ <span>Quay lại hội thoại</span></span>
                  : <span>📨 <b>Tin nhắn chờ</b> <span className="muted small">— từ người lạ, không báo thông báo</span></span>}
                {!showRequests && <span className="badge muted-badge">{requestRows.length}</span>}
              </li>)}
            {showRequests && requestRows.length === 0 && <li className="muted small" style={{ padding: '10px 14px' }}>Không còn tin nhắn chờ.</li>}
            {shownRows.map((r) => {
              const peerU = r.meta ? peerUsernameOf(r.meta) : null;
              const mem = peerU && memberOf(r.meta, peerU);
              const pr = convPrefs[r.id] || {};
              return (
                <li key={r.id} className={(active?.conversationId === r.id ? 'on' : '') + (pr.pinned ? ' pinned-conv' : '')} onClick={() => (r.meta ? openByMeta(r.meta) : null)}>
                  <div className="conv-row">
                    <Avatar name={r.type === 'group' ? r.title : peerU} src={r.type === 'group' ? r.meta?.avatar || null : mem?.avatar} size={40} />
                    <div className="conv-main">
                      <b>{r.type === 'group' ? (r.meta?.channel ? '📢 ' : r.meta?.meeting ? '📹 ' : '') + r.title : (nickOf(peerU) || mem?.displayName || '@' + r.title)}{peerU && online.has(peerU) && <span className="dot-on" />}</b>
                      <div className="muted preview">{drafts[r.id] && active?.conversationId !== r.id
                        ? <><span className="draft-tag">Nháp:</span> <span data-user-content>{drafts[r.id]}</span></> : (r.preview || '')}</div>
                    </div>
                    <div className="conv-side">
                      <div className="conv-flags">
                        {pr.secret && <span title="Trò chuyện ẩn">🔒</span>}
                        {pr.pinned && <span title="Đã ghim"><Icon name="pin" size={13} /></span>}
                        {pr.muted && <span title="Đã tắt thông báo"><Icon name="bellOff" size={13} /></span>}
                        {(pr.labels || []).map((id) => labels.find((l) => l.id === id)).filter(Boolean).map((l) => <span key={l.id} className="label-dot" title={l.name} style={{ background: l.color }} />)}
                      </div>
                      {unread[r.id] > 0 ? <span className={'badge' + (pr.muted ? ' muted-badge' : '')}>{unread[r.id]}</span>
                        : pr.unread ? <span className="unread-dot" title="Đánh dấu chưa đọc" /> : null}
                    </div>
                    <button className="icon-btn row-more" title="Tùy chọn" onClick={(e) => { e.stopPropagation(); setRowMenu(rowMenu === r.id ? null : r.id); }}>
                      <Icon name="more" size={18} />
                    </button>
                  </div>
                  {rowMenu === r.id && (<>
                    <div className="menu-veil" onClick={(e) => { e.stopPropagation(); setRowMenu(null); }} />
                    <div className="row-menu" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setPref(r.id, { pinned: !pr.pinned }); setRowMenu(null); }}><Icon name="pin" size={16} />{pr.pinned ? 'Bỏ ghim hội thoại' : 'Ghim hội thoại'}</button>
                      <button onClick={() => { setPref(r.id, { muted: !pr.muted }); setRowMenu(null); }}><Icon name={pr.muted ? 'bell' : 'bellOff'} size={16} />{pr.muted ? 'Bật thông báo' : 'Tắt thông báo'}</button>
                      <button onClick={() => { setPref(r.id, { unread: !pr.unread }); setRowMenu(null); }}><Icon name="mailDot" size={16} />{pr.unread ? 'Đánh dấu đã đọc' : 'Đánh dấu chưa đọc'}</button>
                      <button onClick={() => { setPref(r.id, { archived: !pr.archived }); setRowMenu(null); flashToast(pr.archived ? 'Đã bỏ lưu trữ' : '🗄️ Đã lưu trữ — xem ở bộ lọc “Lưu trữ”'); }}>
                        <Icon name="eyeOff" size={16} />{pr.archived ? 'Bỏ lưu trữ' : 'Lưu trữ hội thoại'}</button>
                      {labels.length > 0 && <div className="menu-labels">{labels.map((l) => { const on = (pr.labels || []).includes(l.id); return (
                        <button key={l.id} className={on ? 'on' : ''} onClick={() => setPref(r.id, { labels: on ? (pr.labels || []).filter((x) => x !== l.id) : [...(pr.labels || []), l.id] })}>
                          <span className="label-dot" style={{ background: l.color }} /> <span data-user-content>{l.name}</span> {on ? '✓' : ''}</button>); })}</div>}
                      {pr.secret
                        ? <><button onClick={() => { setPref(r.id, { secret: false }); setRowMenu(null); flashToast('Đã bỏ ẩn trò chuyện'); }}>🔓 <span>Bỏ ẩn trò chuyện</span></button>
                            <button onClick={() => { setPinSetup({ changing: true }); setRowMenu(null); }}>🔢 <span>Đổi mã PIN</span></button></>
                        : <button onClick={() => { setRowMenu(null); secretPin?.hash ? hideSecret(r.id) : setPinSetup({ hideId: r.id }); }}>🔒 <span>Ẩn trò chuyện</span></button>}
                      {r.type === 'direct' && peerU && <button onClick={() => { setNickEdit(peerU); setRowMenu(null); }}>✏️ <span>{nickOf(peerU) ? 'Đổi biệt danh' : 'Đặt biệt danh'}</span></button>}
                      <button onClick={() => { setShowLabels(true); setRowMenu(null); }}>🏷️ <span>{labels.length ? 'Quản lý nhãn' : 'Tạo nhãn phân loại'}</span></button>
                      <button className="danger" onClick={() => (confirmClear === r.id ? clearConversation(r.id) : setConfirmClear(r.id))}>
                        <Icon name="trash" size={16} />{confirmClear === r.id ? 'Bấm lần nữa để xóa' : 'Xóa cuộc trò chuyện'}</button>
                      {confirmClear === r.id && <div className="menu-note">Chỉ xóa ở phía bạn (mọi tin hiện có). Người kia vẫn giữ.</div>}
                      {pr.muted && <div className="menu-note">Vẫn báo khi có người nhắc @{user.username}</div>}
                    </div>
                  </>)}
                </li>
              );
            })}
            {rows.length === 0 && <li className="muted">Chưa có hội thoại</li>}
          </ul>
        )}
      </aside>

      <main className="pane">
        {active ? (
          <MediaCtx.Provider value={getMediaURL}>
          <PollCtx.Provider value={{ tallies: pollTallies, onVote: votePoll, requestPoll, myUsername: user.username, rsvps, onRsvp, requestRsvp }}>
          <AppCtx.Provider value={{ me: user.username, destructAcks,
            openDirect: (u) => openDirect(u).catch((e) => flashToast('⚠️ ' + e.message)),
            addFriend: (u) => sendFriendRequest(u).catch((e) => flashToast('⚠️ ' + e.message)),
            onceViewed: (id) => rtRef.current?.onceViewed(id),
            gcalls,
            report: (m) => setReporting(m),
            showEdits: (m) => setEditHist(m),
            nickOf,
            downloadBig,
            downloadSmall: async (m, meta) => {                       // tệp nhỏ: giải mã rồi lưu qua hộp thoại Lưu của app
              const url = await getMediaURL(m, meta);
              const blob = mediaBlobs.current.get(meta.fileId);
              if (blob) { const where = await saveFile(meta.name || 'tệp', blob, 'doc'); if (where && window.reachat?.files) flashToast('✓ Đã lưu: ' + where); }
              else { const a = document.createElement('a'); a.href = url; a.download = meta.name || 'file'; a.click(); }
            },
            callBack: (video) => (active?.type === 'group' ? joinGroupCall(active.conversationId, video)
              : active?.peerUsername && startCall(active.peerUsername, video)) }}>
          <ChatView active={active} meta={activeMeta} me={user} messages={messages.filter((m) => !hidden.has(m.id) && !(convPrefs[active.conversationId]?.clearedAt >= (m.createdAt || 0)))}
            online={online} typingUsers={activeTyping} status={status[active.conversationId]} reactions={reactions}
            editing={editing} onCancelEdit={() => setEditing(null)} reply={reply} onCancelReply={() => setReply(null)}
            onSend={(...a) => { if (showRequests) setShowRequests(false); return sendMessage(...a); }} onSendFile={sendFile} onSendSticker={(e) => sendMessage(e, 'sticker')}
            onTyping={() => rtRef.current?.typing(active.conversationId, true)}
            onRecall={(id) => rtRef.current?.recall(id)} onEdit={(m) => setEditing({ id: m.id, body: m.enc ? '' : m.body })}
            onReply={(m) => setReply(m)} onReact={(id, e) => rtRef.current?.react(id, e)} onForward={(m) => setForwarding(m)} onForwardMany={(list) => setForwarding(list)}
            peerUsername={active.peerUsername} memberOf={memberOf}
            pinnedIds={pins[active.conversationId] || []} pinnedMsgs={pinnedMsgs} onTogglePin={togglePin}
            hiddenHas={(id) => hidden.has(id)} onHide={hideMessage}
            starredHas={(id) => !!starred[id]?.on} onStar={toggleStar}
            ttl={ttl} onChangeTtl={changeTtl}
            canLoadOlder={canLoadOlder} onLoadOlder={loadOlder} loadingOlder={loadingOlder}
            isPeerBlocked={active.peerUsername && blocked.has(active.peerUsername)}
            onToggleBlock={() => active.peerUsername && toggleBlock(active.peerUsername)}
            onShowSafety={openSafety}
            remindIds={new Set(reminders.map((r) => r.msgId))} onRemind={(m) => setReminding(m)}
            onShowGroupInfo={() => setShowGroupInfo(true)}
            onShowProfile={(u) => setProfileOf(u)}
            openTasks={(tasksByConv[active.conversationId] || []).filter((t) => !t.done).length}
            unreadAtOpen={unreadAtOpen[active.conversationId] || 0} onShowSummary={() => setShowSummary(true)}
            onShowNotes={() => setShowNotes(true)}
            onShowTasks={() => setShowTasks(true)} onAssign={(m) => setAssigning(m)}
            onOpenPoll={() => setShowPoll(true)} onSchedule={(text) => setScheduling({ text })}
            scheduledCount={scheduledItems.filter((s) => s.conversationId === active.conversationId).length}
            onShowScheduled={() => { rtRef.current?.listScheduled(); setShowScheduled(true); }}
            quickReplies={quickReplies} onManageQuick={() => setShowQuick(true)} onPickContact={() => setShowContactPick(true)}
            keyInfo={active.peerUsername && !active.isCloud ? keySeen[active.peerUsername] : null}
            onAckKey={() => ackKeyChange(active.peerUsername)}
            isStranger={active.type === 'direct' && !active.isCloud && !!active.peerUsername && !contacts.some((c) => c.username === active.peerUsername)}
            isRequest={!!rows.find((r) => r.id === active.conversationId)?.request}
            onAcceptRequest={() => { acceptRequest(active.conversationId); setShowRequests(false); flashToast('✓ Đã chấp nhận — hội thoại chuyển về danh sách chính'); }}
            onCall={(video) => active.peerUsername && startCall(active.peerUsername, video)}
            groupCall={active.type === 'group' ? gcalls[active.conversationId] : null} inGroupCall={gcall?.conversationId === active.conversationId}
            onGroupCall={(video) => joinGroupCall(active.conversationId, video)} onBack={() => setActive(null)}
            onShowGallery={() => setGallery(active.conversationId)}
            onSendLocation={sendLocation}
            onStartLive={active?.isCloud ? null : startLive}
            onThreadSend={async (root, t) => {
              const { body, enc } = await encryptFor(active.conversationId, active.type, active.peerUsername, t);
              const common = { body, enc, replyTo: root.id, ...(ttl ? { ttl: ttl * 1000 } : {}) };
              if (active.type === 'direct') rtRef.current?.send({ to: active.peerUsername, ...common }); else rtRef.current?.send({ conversationId: active.conversationId, ...common });
            }}
            onSendP2P={active.type === 'direct' && !active.isCloud && !memberOf(activeMeta, active.peerUsername)?.isBot ? sendP2P : null} />
          {gallery && <GalleryModal convId={gallery} onClose={() => setGallery(null)} />}
          </AppCtx.Provider>
          </PollCtx.Provider>
          </MediaCtx.Provider>
        ) : <div className="empty muted">Chọn hội thoại, nhập @username, hoặc ＋ để tạo nhóm</div>}
      </main>

      {showGroup && <NewGroupModal onClose={() => setShowGroup(false)} onCreate={(t, m) => { rtRef.current?.createGroup(t, m); setShowGroup(false); }} />}
      {showProfile && <ProfileModal user={user} onClose={() => setShowProfile(false)} onSave={saveProfile} />}
      {showStatus && <StatusModal cur={myStatus} onClose={() => setShowStatus(false)} onSaved={(st) => { setMyStatusState(st); setShowStatus(false); }} />}
      {showStarred && <StarredModal items={Object.entries(starred).filter(([, x]) => x.on).map(([id, x]) => ({ id, ...x })).sort((a, b) => (b.at || 0) - (a.at || 0))}
        titleOf={(cid) => { const mm = convMeta[cid]; return mm ? (mm.type === 'group' ? mm.title : '@' + (peerUsernameOf(mm) || '')) : ''; }}
        onOpen={(it) => { const mm = convMeta[it.convId]; if (mm) openByMeta(mm); setShowStarred(false); }}
        onUnstar={(it) => setStarred((s) => ({ ...s, [it.id]: { ...s[it.id], on: false, t: Date.now() } }))} onClose={() => setShowStarred(false)} />}
      {profileOf && <UserProfileModal username={profileOf} me={user} onClose={() => setProfileOf(null)} onMessage={(u) => { setShowGroupInfo(false); openDirect(u); }} onAddFriend={(u) => api.sendFriendRequest(u)} />}
      {showLabels && <LabelsModal labels={labels} onChange={(ls) => { setLabels(ls); const ids = new Set(ls.map((l) => l.id)); if (convFilter !== 'all' && convFilter !== 'unread' && convFilter !== 'archived' && !ids.has(convFilter)) setConvFilter('all'); }} onClose={() => setShowLabels(false)} />}
      {pinSetup && <PinSetupModal changing={!!pinSetup.changing} onClose={() => setPinSetup(null)} onSave={savePin} />}
      {nickEdit && <NicknameModal username={nickEdit} current={nickOf(nickEdit)} onClose={() => setNickEdit(null)}
        onSave={(name) => { setNick(nickEdit, name); setNickEdit(null); flashToast(name.trim() ? '✏️ Đã đặt biệt danh' : 'Đã xóa biệt danh'); }} />}
      {editHist && <EditHistoryModal m={editHist} onClose={() => setEditHist(null)} />}
      {forwarding && <ForwardModal rows={rows} onClose={() => setForwarding(null)} onPick={doForward} />}
      {safety && <SafetyNumberModal me={user.username} safety={safety} verified={!!(keySeen[safety.peerUsername]?.verified && keySeen[safety.peerUsername]?.pk === safety.pk)}
        onVerify={(ok) => markVerified(safety.peerUsername, safety.pk, ok)} onClose={() => setSafety(null)} />}
      {gcall && <GroupCallUI meetLink={meetLinks[gcall.conversationId] ? 'reachat://meet/' + meetLinks[gcall.conversationId] : null}
        onCopied={() => flashToast('Đã sao chép link phòng họp')} onScreen={startScreen} onRecord={toggleRecording} gcall={gcall} verifiedOf={(u) => !!(keySeen[u]?.verified && keySeen[u]?.pk === pkCacheRef.current.get(u)?.pk)} peers={gpeers} local={glocal} me={user.username}
        onLeave={leaveGroupCall} onToggleMute={gToggleMute} onToggleCam={gToggleCam} />}
      {gring && !gcall && (
        <div className="modal-backdrop">
          <div className="modal call-incoming">
            <div className="call-av"><Avatar name={convMeta[gring.conversationId]?.title || 'Nhóm'} size={72} /></div>
            <h3>{convMeta[gring.conversationId]?.title || 'Nhóm'}</h3>
            <div className="muted">@{gring.by} đang gọi {gring.video ? 'video' : 'thoại'} nhóm…</div>
            <div className="call-ring-actions">
              <button className="call-btn reject" onClick={() => setGring(null)} title="Bỏ qua"><Icon name="phoneOff" size={24} /></button>
              <button className="call-btn accept" onClick={() => joinGroupCall(gring.conversationId, gring.video)} title="Tham gia"><Icon name={gring.video ? 'video' : 'phone'} size={24} /></button>
            </div>
          </div>
        </div>
      )}
      {screenPick && <ScreenPicker onClose={(id) => { screenPick.resolve(id || null); setScreenPick(null); }} />}
      {call && <CallUI onScreen={startScreen} onRecord={toggleRecording} call={call} verified={!!(keySeen[call.peer]?.verified && keySeen[call.peer]?.pk === pkCacheRef.current.get(call.peer)?.pk)} media={callMedia} onAccept={acceptCall} onReject={rejectCall}
        onEnd={endCall} onToggleMute={toggleMute} onToggleCam={toggleCam} />}
      {showMeet && <MeetModal onClose={() => setShowMeet(false)} onCreate={(t) => rtRef.current?.meetCreate(t)}
        onJoin={(v) => { if (openInvite(v.includes('/') ? v : 'meet/' + v.trim())) setShowMeet(false); else flashToast('Mã/link phòng họp không hợp lệ'); }} />}
      {showChannels && <ChannelsModal results={channelResults} onClose={() => setShowChannels(false)}
        onSearch={(q) => rtRef.current?.channelSearch(q)}
        onCreate={(f) => { rtRef.current?.channelCreate(f); setShowChannels(false); flashToast('📢 Đã tạo kênh @' + f.handle); }}
        onJoin={(c) => { setShowChannels(false); if (c.joined) { const meta = convMetaRef.current[c.id]; if (meta) openByMeta(meta); } else rtRef.current?.channelJoin({ id: c.id }); }} />}
      {p2pIncoming.length > 0 && <div className="p2p-incoming">{p2pIncoming.map((inv) => (
        <div key={inv.id} className="p2p-card">
          <div>📦 <b>@{inv.from}</b> muốn gửi trực tiếp cho bạn:</div>
          <div className="p2p-name"><b data-user-content>{inv.meta.name}</b> · {fmtSize(inv.meta.size || 0)}</div>
          <div className="muted small">Tệp đi thẳng giữa hai máy (mã hóa), không lưu trên máy chủ.</div>
          <div className="row-inline"><button className="primary" onClick={() => acceptP2P(inv)}>Nhận & lưu…</button><button className="ghost" onClick={() => declineP2P(inv)}>Từ chối</button></div>
        </div>))}</div>}
      {transfers.length > 0 && <div className="transfer-panel">{transfers.map((t) => (
        <div key={t.id} className="transfer-row"><span>{t.dir === 'up' ? '⬆' : t.dir === 'p2p' ? '📦' : '⬇'} <span data-user-content>{t.name}</span></span>
          <span className="transfer-bar"><i style={{ width: Math.round(t.pct * 100) + '%' }} /></span><b>{Math.round(t.pct * 100)}%</b></div>))}</div>}
      {locAsk && <LocationModal reason={locAsk.reason} onClose={() => setLocAsk(null)}
        onSend={(loc) => { setLocAsk(null); sendMessage(JSON.stringify(loc), 'location'); }} />}
      {reporting && <ReportModal m={reporting} onClose={() => setReporting(null)} onDone={() => { setReporting(null); flashToast('✓ Đã gửi báo cáo — cảm ơn bạn. Bạn có thể chặn người này nếu muốn.'); }} />}
      {showSettings && <SettingsModal user={user} onClose={() => setShowSettings(false)} onExport={exportBackup} onImport={importBackup} onUpdateToken={onUpdateToken} />}
      {showAddFriend && <AddFriendModal me={user} outgoing={friendReqs.outgoing || []} onClose={() => setShowAddFriend(false)} onSend={sendFriendRequest}
        onInvite={(v) => { if (openInvite(v)) { setShowAddFriend(false); return true; } return false; }} />}
      {invitePreview && <InviteJoinModal p={invitePreview} onClose={() => setInvitePreview(null)}
        onJoin={() => { if (invitePreview.meeting) meetJoinRef.current = { convId: invitePreview.conversationId, code: invitePreview.code }; rtRef.current?.inviteJoin(invitePreview.code); }}
        onEnterMeeting={() => { const c = invitePreview.conversationId; setMeetLinks((p) => ({ ...p, [c]: invitePreview.code })); setInvitePreview(null); joinGroupCall(c, true); }}
        onOpen={() => { const meta = convMetaRef.current[invitePreview.conversationId]; setInvitePreview(null); if (meta) openByMeta(meta); }} />}
      {showPoll && <PollComposeModal onClose={() => setShowPoll(false)} onCreate={sendPoll} />}
      {scheduling && <ScheduleModal text={scheduling.text} isDirect={active?.type === 'direct' && !active?.isCloud} onClose={() => setScheduling(null)} onSchedule={scheduleMessage} />}
      {showScheduled && <ScheduledListModal items={scheduledItems} onClose={() => setShowScheduled(false)} onCancel={cancelScheduled} />}
      {showStoryCompose && <StoryComposeModal contacts={contacts} onClose={() => setShowStoryCompose(false)} onPost={postStory} />}
      {storyView && <StoryViewer view={storyView} me={user} setView={setStoryView} onClose={() => setStoryView(null)} onDelete={removeStory} onReply={replyToStory} />}
      {showGroupInfo && activeMeta?.channel && <ChannelInfoModal meta={activeMeta} me={user} onClose={() => setShowGroupInfo(false)}
        onLeave={() => { rtRef.current?.groupLeave(active.conversationId); setShowGroupInfo(false); }} />}
      {showGroupInfo && active?.type === 'group' && activeMeta && !activeMeta.channel && (
        <GroupInfoModal meta={activeMeta} me={user} online={online} onClose={() => setShowGroupInfo(false)}
          onRename={(t) => rtRef.current?.groupRename(active.conversationId, t)}
          onAdd={(names) => rtRef.current?.groupAdd(active.conversationId, names)}
          onKick={(u) => rtRef.current?.groupKick(active.conversationId, u)}
          onRole={(u, role) => rtRef.current?.groupRole(active.conversationId, u, role)}
          onTransfer={(u) => rtRef.current?.groupTransfer(active.conversationId, u)}
          onAvatar={(av) => rtRef.current?.groupAvatar(active.conversationId, av)}
          onSettings={(s) => rtRef.current?.groupSettings(active.conversationId, s)}
          onApprove={(u, ok) => rtRef.current?.groupApprove(active.conversationId, u, ok)}
          onShowProfile={(u) => setProfileOf(u)}
          onLeave={() => { rtRef.current?.groupLeave(active.conversationId); setShowGroupInfo(false); }}
          invite={groupInvite[active.conversationId]} onInvite={(action) => rtRef.current?.invite(action, active.conversationId)} />
      )}
      {assigning && active && <TaskModal m={assigning} members={active.isCloud ? [{ username: user.username, displayName: user.displayName }]
          : activeMeta?.members || [{ username: user.username }, { username: active.peerUsername }]}
        me={user.username} onClose={() => setAssigning(null)} onCreate={createTask} />}
      {showTasks && active && <TasksModal items={tasksByConv[active.conversationId] || []} me={user.username}
        title={(t) => decTitle(active.conversationId, t.titleEnc)} onClose={() => setShowTasks(false)}
        onToggle={(id) => rtRef.current?.toggleTask(id)} onDelete={(id) => rtRef.current?.deleteTask(id)} />}
      {showNotes && active && rtRef.current && (
        <SharedNotes key={active.conversationId} convId={active.conversationId} rt={rtRef.current} me={user.username}
          keys={() => taskKeys(active.conversationId)} subscribe={subscribeDoc} onClose={() => setShowNotes(false)} />
      )}
      {showLan && <LanPanel on={lanOn} peers={lanPeers} msgs={lanMsgs} keySeen={keySeen} onToggle={toggleLan} onSend={sendLan} onClose={() => setShowLan(false)} />}
      {showSummary && active && <SummaryModal messages={messages.filter((m) => !hidden.has(m.id))} unreadN={unreadAtOpen[active.conversationId] || 0}
        me={user.username} onClose={() => setShowSummary(false)} />}
      {showQuiet && <QuietModal value={quiet} contacts={contacts} onChange={setQuiet} onClose={() => setShowQuiet(false)} />}
      {showQuick && <QuickRepliesModal items={quickReplies} onChange={setQuickReplies} onClose={() => setShowQuick(false)} />}
      {showContactPick && <ContactPickModal contacts={contacts} me={user} onClose={() => setShowContactPick(false)}
        onPick={(c) => { sendMessage(JSON.stringify({ username: c.username, displayName: c.displayName || c.username }), 'contact'); setShowContactPick(false); }} />}
      {reminding && <ReminderModal m={reminding} existing={reminders.find((r) => r.msgId === reminding.id)}
        onClose={() => setReminding(null)} onSet={(at) => addReminder(reminding, at)} onRemove={() => removeReminder(reminding.id)} />}
      {toast && (
        <div className="toast">
          {toast.text}
          {toast.action && <button className="toast-act" onClick={() => { toast.action.fn(); setToast(null); }}>{toast.action.label}</button>}
        </div>
      )}
    </div>
  );
}

function NewChat({ onOpen }) {
  const [v, setV] = useState(''); const [err, setErr] = useState('');
  const go = async (e) => { e.preventDefault(); setErr(''); try { await onOpen(v); setV(''); } catch (e) { setErr(e.message); } };
  return (<form className="new-chat" onSubmit={go}>
    <input placeholder="nhắn tới @username hoặc dán link mời nhóm" value={v} onChange={(e) => setV(e.target.value)} />
    {err && <div className="error small">{err}</div>}
  </form>);
}

function AddContact({ onAdd }) {
  const [v, setV] = useState(''); const [err, setErr] = useState('');
  const go = async (e) => { e.preventDefault(); setErr(''); try { await onAdd(v); setV(''); } catch (e) { setErr(e.message); } };
  return (<form className="add-contact" onSubmit={go}>
    <input placeholder="+ kết bạn @username" value={v} onChange={(e) => setV(e.target.value)} />
    {err && <div className="error small">{err}</div>}
  </form>);
}

// Mã PIN trò chuyện ẩn: PBKDF2-SHA256 (muối ngẫu nhiên, 150k vòng) — chỉ lưu bản băm.
async function hashPin(pin, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : window.crypto.getRandomValues(new Uint8Array(16));
  const base = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await window.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, base, 256);
  const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  return { hash: b64(bits), salt: b64(salt) };
}
// Đặt / đổi mã PIN (4–6 số, nhập 2 lần).
function PinSetupModal({ changing, onClose, onSave }) {
  const [a, setA] = useState(''), [b, setB] = useState(''), [err, setErr] = useState('');
  return (<div className="modal-backdrop" onClick={onClose}>
    <form className="modal pin-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
      e.preventDefault();
      if (!/^\d{4,6}$/.test(a)) return setErr('Mã PIN gồm 4–6 chữ số');
      if (a !== b) return setErr('Hai lần nhập không khớp');
      onSave(a);
    }}>
      <h3>🔒 {changing ? 'Đổi mã PIN trò chuyện ẩn' : 'Đặt mã PIN để ẩn trò chuyện'}</h3>
      <p className="muted small">Trò chuyện ẩn biến khỏi danh sách và không hiện nội dung trong thông báo. Muốn xem lại: gõ mã PIN vào ô <b>Tìm tin nhắn</b>.</p>
      <input type="password" inputMode="numeric" maxLength={6} placeholder="Mã PIN (4–6 số)" value={a} onChange={(e) => setA(e.target.value.replace(/\D/g, ''))} autoFocus />
      <input type="password" inputMode="numeric" maxLength={6} placeholder="Nhập lại mã PIN" value={b} onChange={(e) => setB(e.target.value.replace(/\D/g, ''))} />
      {err && <div className="error small">{err}</div>}
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Hủy</button><button className="primary">Lưu</button></div>
    </form>
  </div>);
}

// Đặt biệt danh (chỉ mình thấy, đồng bộ giữa các máy của mình); để trống = xóa.
function NicknameModal({ username, current, onClose, onSave }) {
  const [v, setV] = useState(current || '');
  return (<div className="modal-backdrop" onClick={onClose}>
    <form className="modal nickname-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
      <h3>✏️ Biệt danh cho @{username}</h3>
      <input value={v} maxLength={40} placeholder="Tên gợi nhớ (để trống để xóa)" onChange={(e) => setV(e.target.value)} autoFocus />
      <p className="muted small">Chỉ bạn nhìn thấy biệt danh này — người kia không được báo.</p>
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Hủy</button><button className="primary">Lưu</button></div>
    </form>
  </div>);
}

// Lịch sử sửa của một tin: các bản trước (chỉ những bản máy này từng nhận được, lưu trong cache cục bộ).
function EditHistoryModal({ m, onClose }) {
  const [hist, setHist] = useState(null);
  useEffect(() => { db.getMeta('edits.' + m.id).then((v) => { try { setHist(JSON.parse(v || '[]')); } catch { setHist([]); } }).catch(() => setHist([])); }, [m.id]);
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal edit-history" onClick={(e) => e.stopPropagation()}>
      <h3>✏️ Lịch sử sửa tin</h3>
      {hist === null ? <p className="muted">Đang tải…</p> : (<ul className="edit-list">
        {[...hist].reverse().map((h, i) => <li key={i}><time className="muted small">{fmtTime(h.at)}</time><div data-user-content>{h.body}</div></li>)}
        {!hist.length && <li className="muted small">Máy này không có bản trước khi sửa (tin được sửa trước khi máy nhận được bản gốc).</li>}
      </ul>)}
      <div className="edit-now"><span className="muted small">Hiện tại · {fmtTime(m.editedAt)}</span><div data-user-content>{m.body}</div></div>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

function NewGroupModal({ onClose, onCreate }) {
  const [title, setTitle] = useState(''); const [members, setMembers] = useState('');
  return (<div className="modal-backdrop" onClick={onClose}>
    <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => {
      e.preventDefault();
      const list = members.split(/[\s,]+/).map((s) => s.toLowerCase().replace(/^@+/, '').trim()).filter(Boolean);
      if (title.trim()) onCreate(title.trim(), list);              // có thể tạo nhóm trống rồi mời bằng link
    }}>
      <h3>Tạo nhóm</h3>
      <input placeholder="Tên nhóm" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <input placeholder="Thành viên (tuỳ chọn): username, cách nhau dấu phẩy — hoặc mời bằng link sau" value={members} onChange={(e) => setMembers(e.target.value)} />
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Hủy</button><button className="primary">Tạo</button></div>
    </form>
  </div>);
}

function ProfileModal({ user, onClose, onSave }) {
  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [avatar, setAvatar] = useState(user.avatar || null);
  const [ext, setExt] = useState(null);                       // { bio, birthday, showBirthday, cover }
  const [err, setErr] = useState('');
  useEffect(() => { api.getProfile(user.username).then((p) => setExt({ bio: p.bio || '', birthday: p.birthday || '', showBirthday: p.showBirthday ?? 1, cover: p.cover || null })).catch(() => setExt({ bio: '', birthday: '', showBirthday: 1, cover: null })); }, [user.username]);
  const pickCover = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const img = new Image(), url = URL.createObjectURL(f);
    img.onload = () => {                                       // ảnh bìa 900x300 (cắt giữa)
      const W = 900, H = 300, c = document.createElement('canvas'); c.width = W; c.height = H;
      const s = Math.max(W / img.width, H / img.height), w = img.width * s, h = img.height * s;
      c.getContext('2d').drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      setExt((x) => ({ ...x, cover: c.toDataURL('image/jpeg', 0.78) })); URL.revokeObjectURL(url);
    };
    img.src = url; e.target.value = '';
  };
  const pick = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    // Thu nhỏ ảnh về <=128px, lưu dạng dataURL nhẹ.
    const img = new Image(); const url = URL.createObjectURL(f);
    img.onload = () => {
      const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
      const ctx = c.getContext('2d'); const r = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - r) / 2, (img.height - r) / 2, r, r, 0, 0, s, s);
      setAvatar(c.toDataURL('image/jpeg', 0.8)); URL.revokeObjectURL(url);
    };
    img.src = url;
  };
  return (<div className="modal-backdrop" onClick={onClose}>
    <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
      e.preventDefault(); setErr('');
      try { if (ext) await api.saveProfileExtra({ bio: ext.bio, birthday: ext.birthday || null, showBirthday: ext.showBirthday, cover: ext.cover }); onSave({ displayName: displayName.trim(), avatar }); }
      catch (x) { setErr(x.message); }
    }}>
      <h3>Hồ sơ</h3>
      <div className="cover small-cover" style={ext?.cover ? { backgroundImage: `url("${ext.cover}")` } : undefined}>
        <label className="ghost mini file-btn">Ảnh bìa<input type="file" accept="image/*" hidden onChange={pickCover} /></label>
        {ext?.cover && <button type="button" className="ghost mini" onClick={() => setExt({ ...ext, cover: null })}>Xóa</button>}
      </div>
      <div className="profile-av"><Avatar name={user.username} src={avatar} size={72} /><label className="ghost file-btn">Đổi ảnh<input type="file" accept="image/*" hidden onChange={pick} /></label></div>
      <input placeholder="Tên hiển thị" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      {ext && <>
        <textarea placeholder="Giới thiệu bản thân (tối đa 200 ký tự)" maxLength={200} rows={2} value={ext.bio} onChange={(e) => setExt({ ...ext, bio: e.target.value })} />
        <div className="row-inline"><span className="small">🎂 <span>Sinh nhật</span></span>
          <input type="date" value={ext.birthday} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setExt({ ...ext, birthday: e.target.value })} />
          <select value={ext.showBirthday} onChange={(e) => setExt({ ...ext, showBirthday: Number(e.target.value) })}>
            <option value={0}>Ẩn</option><option value={1}>Hiện ngày/tháng</option><option value={2}>Hiện đủ ngày/tháng/năm</option>
          </select></div>
      </>}
      {err && <div className="error small">{err}</div>}
      <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Hủy</button><button className="primary">Lưu</button></div>
    </form>
  </div>);
}

// ---- Cài đặt ----
function SettingsModal({ user, onClose, onExport, onImport, onUpdateToken }) {
  const [tab, setTab] = useState('security');
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
      <h3>⚙️ Cài đặt</h3>
      <div className="tabs">
        <button type="button" className={tab === 'security' ? 'on' : ''} onClick={() => setTab('security')}>Bảo mật</button>
        <button type="button" className={tab === 'backup' ? 'on' : ''} onClick={() => setTab('backup')}>Sao lưu lịch sử</button>
        <button type="button" className={tab === 'bots' ? 'on' : ''} onClick={() => setTab('bots')}>Bot</button>
        {window.reachat?.web && <button type="button" className={tab === 'push' ? 'on' : ''} onClick={() => setTab('push')}>Thông báo</button>}
        <button type="button" className={tab === 'prefs' ? 'on' : ''} onClick={() => setTab('prefs')}>Tùy chọn</button>
        <button type="button" className={tab === 'lang' ? 'on' : ''} onClick={() => setTab('lang')}>Ngôn ngữ</button>
      </div>
      {tab === 'lang' && <div className="lang-panel">
        {[['vi', 'Tiếng Việt'], ['en', 'English']].map(([k, label]) => (
          <label key={k} className="check-row"><input type="radio" name="lang" checked={getLang() === k} onChange={() => setLang(k)} /> <span data-user-content>{label}</span></label>
        ))}
        <p className="muted small">English interface translates menus, buttons and hints. Your messages are never translated or sent anywhere.</p>
      </div>}
      {tab === 'push' && <PushPanel />}
      {tab === 'prefs' && <><PrefsPanel /><div className="security-panel"><AppLockSettings username={user.username} /></div></>}
      {tab === 'bots' && <BotsPanel />}
      {tab === 'security' && <SecurityPanel user={user} onUpdateToken={onUpdateToken} />}
      {tab === 'backup' && <BackupPanel onExport={onExport} onImport={onImport} />}
      <div className="modal-actions"><button className="ghost" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// ---- Khóa ứng dụng bằng mã PIN (trên máy này) ----
// Khóa khi mở app và khi không thao tác quá N phút. Sai 5 lần -> đăng xuất. Đây là lớp che màn hình
// (chống người khác cầm máy đọc tin), không thay cho mật khẩu tài khoản. Quên PIN: đăng xuất rồi đăng nhập lại.
const LOCK_KEY = (u) => 'reachat.applock.' + u;
const getLockCfg = (u) => { try { return JSON.parse(localStorage.getItem(LOCK_KEY(u)) || 'null'); } catch { return null; } };
async function pinHash(pin, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const k = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await window.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150_000 }, k, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function setAppPin(u, pin, idleMin) {
  const salt = [...window.crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(LOCK_KEY(u), JSON.stringify({ salt, hash: await pinHash(pin, salt), idleMin }));
}
function AppLock({ username, onLogout }) {
  const [cfg, setCfg] = useState(() => getLockCfg(username));
  const [locked, setLocked] = useState(() => !!getLockCfg(username));
  const [pin, setPin] = useState(''), [err, setErr] = useState(''), [tries, setTries] = useState(0);
  const lastRef = useRef(Date.now());
  useEffect(() => {
    const reload = () => setCfg(getLockCfg(username));
    const lockNow = () => { if (getLockCfg(username)) setLocked(true); };
    const touch = () => { lastRef.current = Date.now(); };
    window.addEventListener('reachat:applock', reload); window.addEventListener('reachat:lockNow', lockNow);
    ['pointerdown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, touch, true));
    const iv = setInterval(() => { const c = getLockCfg(username); if (c?.idleMin && Date.now() - lastRef.current > c.idleMin * 60_000) setLocked(true); }, 15_000);
    return () => { window.removeEventListener('reachat:applock', reload); window.removeEventListener('reachat:lockNow', lockNow);
      ['pointerdown', 'keydown', 'wheel'].forEach((ev) => window.removeEventListener(ev, touch, true)); clearInterval(iv); };
  }, [username]);
  if (!cfg || !locked) return null;
  const unlock = async (e) => {
    e.preventDefault();
    if ((await pinHash(pin, cfg.salt)) === cfg.hash) { setLocked(false); setPin(''); setErr(''); setTries(0); lastRef.current = Date.now(); return; }
    const n = tries + 1; setTries(n); setPin('');
    if (n >= 5) { localStorage.removeItem(LOCK_KEY(username)); onLogout(); return; }
    setErr(`Mã PIN không đúng (còn ${5 - n} lần thử, sau đó sẽ đăng xuất)`);
  };
  return (<div className="app-lock">
    <form className="auth-card" onSubmit={unlock}>
      <h1>🔒 ReaChat</h1>
      <p className="muted">@{username} · <span>Nhập mã PIN để mở khóa</span></p>
      <input className="otp-input" type="password" inputMode="numeric" autoFocus maxLength={8} placeholder="Mã PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={pin.length < 4}>Mở khóa</button>
      <button type="button" className="link small" onClick={() => { localStorage.removeItem(LOCK_KEY(username)); onLogout(); }}>Quên mã PIN? Đăng xuất</button>
    </form>
  </div>);
}
function AppLockSettings({ username }) {
  const [cfg, setCfg] = useState(() => getLockCfg(username));
  const [pin, setPin] = useState(''), [pin2, setPin2] = useState(''), [idle, setIdle] = useState(cfg?.idleMin ?? 5), [msg, setMsg] = useState(''), [err, setErr] = useState('');
  const save = async () => {
    setErr(''); setMsg('');
    if (!/^\d{4,8}$/.test(pin)) { setErr('Mã PIN gồm 4–8 chữ số'); return; }
    if (pin !== pin2) { setErr('Hai lần nhập không khớp'); return; }
    await setAppPin(username, pin, Number(idle)); setCfg(getLockCfg(username)); setPin(''); setPin2('');
    window.dispatchEvent(new Event('reachat:applock')); setMsg('✓ Đã bật khóa ứng dụng');
  };
  const off = () => { localStorage.removeItem(LOCK_KEY(username)); setCfg(null); window.dispatchEvent(new Event('reachat:applock')); setMsg('Đã tắt khóa ứng dụng'); };
  const changeIdle = (v) => { setIdle(v); if (cfg) { const c = { ...cfg, idleMin: Number(v) }; localStorage.setItem(LOCK_KEY(username), JSON.stringify(c)); setCfg(c); } };
  return (<section>
    <h4>Khóa ứng dụng bằng mã PIN {cfg ? <span className="pill ok">Đang bật</span> : <span className="pill">Tắt</span>}</h4>
    <p className="muted small">Hỏi mã PIN khi mở app và khi không thao tác một lúc — tránh người khác cầm máy đọc tin. Sai 5 lần sẽ đăng xuất.</p>
    <div className="row-inline"><span className="small">Tự khóa sau</span>
      <select value={idle} onChange={(e) => changeIdle(e.target.value)}>
        <option value={1}>1 phút</option><option value={5}>5 phút</option><option value={15}>15 phút</option><option value={60}>1 giờ</option><option value={0}>Chỉ khi mở app</option>
      </select>
      {cfg && <button type="button" className="ghost mini" onClick={() => window.dispatchEvent(new Event('reachat:lockNow'))}>Khóa ngay</button>}</div>
    <div className="row-inline">
      <input className="otp-input" type="password" inputMode="numeric" maxLength={8} placeholder={cfg ? 'PIN mới' : 'Mã PIN (4–8 số)'} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
      <input className="otp-input" type="password" inputMode="numeric" maxLength={8} placeholder="Nhập lại" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
      <button type="button" className="primary" onClick={save}>{cfg ? 'Đổi PIN' : 'Bật khóa'}</button>
      {cfg && <button type="button" className="ghost danger" onClick={off}>Tắt</button>}
    </div>
    {msg && <div className="ok-msg small">{msg}</div>}
    {err && <div className="error small">{err}</div>}
  </section>);
}

// Tùy chọn trên máy này: âm thanh, xem trước liên kết.
// Cỡ chữ tin nhắn (theo máy): hệ số nhân cho nội dung tin + ô soạn.
const FONT_SCALES = [[0.9, 'Nhỏ'], [1, 'Vừa'], [1.15, 'Lớn'], [1.3, 'Rất lớn']];
const getFontScale = () => { try { return Number(localStorage.getItem('reachat.fontScale')) || 1; } catch { return 1; } };
const applyFontScale = (v) => document.documentElement.style.setProperty('--msg-scale', String(v || 1));
applyFontScale(getFontScale());

function PrefsPanel() {
  const [s, setS] = useState(getSoundPrefs);
  const [lp, setLp] = useState(linkPreviewOn);
  const [fs, setFs] = useState(getFontScale);
  const setFont = (v) => { setFs(v); applyFontScale(v); try { localStorage.setItem('reachat.fontScale', String(v)); } catch {} };
  const auto = window.reachat?.autostart;                      // chỉ có trên app desktop
  const [as, setAs] = useState(null);                           // { supported, on }
  useEffect(() => { auto?.get().then(setAs).catch(() => {}); }, []);
  const ringStop = useRef(null);
  useEffect(() => () => ringStop.current?.(), []);
  const upd = (p) => { setSoundPrefs(p); setS(getSoundPrefs()); };
  const testRing = () => { if (ringStop.current) { ringStop.current(); ringStop.current = null; return; } ringStop.current = startRing('in', true); setTimeout(() => { ringStop.current?.(); ringStop.current = null; }, 5200); };
  return (<div className="security-panel">
    <section>
      <h4>Âm thanh</h4>
      <label className="check-row"><input type="checkbox" checked={s.msg} onChange={(e) => upd({ msg: e.target.checked })} /> <span>Âm báo khi có tin nhắn mới</span></label>
      <label className="check-row"><input type="checkbox" checked={s.call} onChange={(e) => upd({ call: e.target.checked })} /> <span>Nhạc chuông cuộc gọi đến / chuông chờ khi gọi đi</span></label>
      <div className="row-inline"><span className="small">Âm lượng</span>
        <input type="range" min="0.1" max="1" step="0.1" value={s.volume} onChange={(e) => upd({ volume: Number(e.target.value) })} />
        <button type="button" className="ghost mini" onClick={() => playMessage(true)}>Thử âm báo</button>
        <button type="button" className="ghost mini" onClick={testRing}>Thử nhạc chuông</button></div>
      <p className="muted small">Giờ yên lặng và hội thoại đã tắt thông báo thì không phát âm báo.</p>
    </section>
    <section>
      <h4>Cỡ chữ tin nhắn</h4>
      <div className="row-inline font-scale">{FONT_SCALES.map(([v, l]) => (
        <button key={v} type="button" className={'ghost mini' + (fs === v ? ' on' : '')} style={{ fontSize: 13 * v }} onClick={() => setFont(v)}>{l}</button>))}</div>
    </section>
    {auto && <section>
      <h4>Khởi động</h4>
      <label className="check-row"><input type="checkbox" disabled={!as?.supported} checked={!!as?.on}
        onChange={(e) => auto.set(e.target.checked).then(setAs).catch(() => {})} />
        <span>Tự mở ReaChat khi đăng nhập Windows (chạy nền ở khay hệ thống)</span></label>
      {as && !as.supported && <p className="muted small">Chỉ dùng được ở bản cài đặt (bản chạy thử từ mã nguồn không đăng ký khởi động).</p>}
    </section>}
    <section>
      <h4>Xem trước liên kết</h4>
      <label className="check-row"><input type="checkbox" checked={lp} onChange={(e) => { setLp(e.target.checked); try { localStorage.setItem('reachat.linkPreview', e.target.checked ? '1' : '0'); } catch {} }} />
        <span>Hiện tiêu đề + ảnh của liên kết trong tin nhắn</span></label>
      <p className="muted small">Máy chủ ReaChat tải trang thay bạn (trang đích không thấy IP của bạn), nhưng máy chủ sẽ biết đường link. Tắt nếu không muốn.</p>
    </section>
  </div>);
}

// Bảo mật tài khoản: xác thực 2 bước (TOTP), mã khôi phục, đổi mật khẩu.
// Thao tác nhạy cảm: máy chủ đòi nhập lại mật khẩu (+ mã 2 bước) nếu phiên đăng nhập đã cũ -> hiện ô xác nhận tại chỗ
// rồi chạy lại. call(auth) nhận { password, otp } (rỗng ở lần thử đầu).
function useReauth(run) {
  const [box, setBox] = useState(null), [ra, setRa] = useState({ password: '', otp: '' });
  const guard = (call) => run(async () => {
    try { await call({}); }
    catch (e) { if (!e.needPassword) throw e; setBox({ call }); throw new Error('Vì an toàn, hãy nhập lại mật khẩu để xác nhận thao tác này'); }
  });
  const confirm = () => run(async () => { await box.call(ra); setBox(null); setRa({ password: '', otp: '' }); });
  const ui = box && (<div className="row-inline reauth-box">
    <input type="password" placeholder="Mật khẩu ReaChat" value={ra.password} onChange={(e) => setRa({ ...ra, password: e.target.value })} autoFocus />
    <input className="otp-input" inputMode="numeric" maxLength={7} placeholder="Mã 2 bước (nếu bật)" value={ra.otp} onChange={(e) => setRa({ ...ra, otp: e.target.value })} />
    <button type="button" className="primary" disabled={!ra.password} onClick={confirm}>Xác nhận</button>
    <button type="button" className="link small" onClick={() => { setBox(null); setRa({ password: '', otp: '' }); }}>Huỷ</button>
  </div>);
  return [guard, ui];
}

function SecurityPanel({ user, onUpdateToken }) {
  const [st, setSt] = useState(null);
  const [setup, setSetup] = useState(null);           // {secret, qr}
  const [code, setCode] = useState('');
  const [rc, setRc] = useState(null);                 // mã khôi phục vừa tạo (chỉ hiện 1 lần)
  const [pw, setPw] = useState({ old: '', next: '', otp: '' });
  const [msg, setMsg] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const load = () => api.securityStatus().then(setSt).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn) => { setBusy(true); setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); } };
  const startTotp = () => run(async () => {
    const r = await api.totpSetup();
    setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 200 }) });
  });
  const enableTotp = () => run(async () => { await api.totpEnable(code); setSetup(null); setCode(''); setMsg('✓ Đã bật xác thực 2 bước'); await load(); });
  const disableTotp = () => run(async () => { await api.totpDisable(code); setCode(''); setMsg('Đã tắt xác thực 2 bước'); await load(); });
  const [guard, reauthUi] = useReauth(run);
  const makeRc = () => guard(async (auth) => {
    const r = await crypto.makeRecovery(user.username);
    await api.setRecoveryCode(r.verifier, r.backup, auth);
    localStorage.removeItem('reachat.rcUsed.' + user.username);
    setRc(r.code); await load();
  });
  const saveRc = () => saveFile(`ReaChat-ma-khoi-phuc-${user.username}.txt`,
    new Blob([`Mã khôi phục ReaChat cho @${user.username}\n\n${rc}\n\nDùng ở màn đăng nhập → "Quên mật khẩu?". Mã dùng được MỘT lần. Giữ kín như mật khẩu.\n`], { type: 'text/plain' }), 'doc');
  const changePw = () => run(async () => {
    if (pw.next.length < 6) throw new Error('Mật khẩu mới tối thiểu 6 ký tự');
    window.__reachatPwChange = true;                        // phiên của chính máy này sắp bị đóng -> không coi là bị đăng xuất
    const r = await api.changePassword({ oldPassword: pw.old, newPassword: pw.next, otp: pw.otp });
    onUpdateToken(r.token);
    await api.putKeyBackup(r.token, await crypto.sealKeyBackup(user.username, pw.next));   // bọc lại khóa bằng mật khẩu mới
    setPw({ old: '', next: '', otp: '' });
    setMsg('✓ Đã đổi mật khẩu — các thiết bị khác đã bị đăng xuất. Đang kết nối lại…');
    setTimeout(() => window.location.reload(), 1500);        // kết nối lại bằng token mới
  });
  if (!st) return <div className="muted">{err || 'Đang tải…'}</div>;
  return (<div className="security-panel">
    <section>
      <h4>Xác thực 2 bước {st.totp ? <span className="pill ok">Đang bật</span> : <span className="pill">Tắt</span>}</h4>
      {!st.totp && !setup && <><p className="muted small">Khi đăng nhập ở máy mới, ngoài mật khẩu còn cần mã 6 số từ ứng dụng xác thực
        (Google Authenticator, Microsoft Authenticator, Authy…).</p>
        <button className="primary" disabled={busy} onClick={startTotp}>Bật xác thực 2 bước</button></>}
      {setup && <div className="totp-setup">
        <img src={setup.qr} alt="QR" />
        <div>
          <p className="small">1. Quét mã QR bằng ứng dụng xác thực (hoặc nhập khóa: <code>{setup.secret.match(/.{1,4}/g).join(' ')}</code>)</p>
          <p className="small">2. Nhập mã 6 số đang hiện để xác nhận:</p>
          <input className="otp-input" inputMode="numeric" maxLength={7} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="primary" disabled={busy || code.replace(/\s/g, '').length !== 6} onClick={enableTotp}>Xác nhận & bật</button>
        </div>
      </div>}
      {st.totp && <div className="row-inline">
        <input className="otp-input" inputMode="numeric" maxLength={7} placeholder="Mã 6 số để tắt" value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="ghost danger" disabled={busy} onClick={disableTotp}>Tắt 2 bước</button>
      </div>}
    </section>
    <section>
      <h4>Mã khôi phục {st.recovery ? <span className="pill ok">Đã tạo</span> : <span className="pill warn">Chưa có</span>}</h4>
      <p className="muted small">Quên mật khẩu (hoặc mất điện thoại xác thực) thì dùng mã này để đặt lại — <b>lịch sử mã hóa vẫn giữ nguyên</b>
        vì khóa của bạn được bọc bằng chính mã này. Server chỉ giữ dấu băm, không đọc được mã. Tạo mã mới thì mã cũ hết hiệu lực.</p>
      {rc ? <div className="rc-box">
        <code className="rc-code">{rc}</code>
        <div className="small">⚠️ Mã chỉ hiện <b>một lần</b>. Hãy lưu lại ngay.</div>
        <div className="row-inline"><button className="primary" onClick={saveRc}>Lưu thành tệp .txt</button>
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(rc)}>Sao chép</button></div>
      </div> : <button className="ghost" disabled={busy} onClick={makeRc}>{st.recovery ? 'Tạo mã mới' : 'Tạo mã khôi phục'}</button>}
      {reauthUi}
    </section>
    <section>
      <h4>Đổi mật khẩu</h4>
      <input type="password" placeholder="Mật khẩu hiện tại" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} />
      <input type="password" placeholder="Mật khẩu mới (≥ 6 ký tự)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
      {st.totp && <input className="otp-input" inputMode="numeric" placeholder="Mã 2 bước" value={pw.otp} onChange={(e) => setPw({ ...pw, otp: e.target.value })} />}
      <button className="ghost" disabled={busy || !pw.old || !pw.next} onClick={changePw}>Đổi mật khẩu</button>
      <p className="muted small">Đổi mật khẩu sẽ đăng xuất mọi thiết bị khác.</p>
    </section>
    {st.googleEnabled && <GoogleLinkSection st={st} reload={load} />}
    <ContactSection st={st} reload={load} />
    <PrivacySection />
    <DevicesSection me={user.username} />
    <SecretChatsSection />
    <DeleteAccountSection user={user} totp={st.totp} />
    {msg && <div className="ok-msg small">{msg}</div>}
    {err && <div className="error small">{err}</div>}
  </div>);
}

// Liên kết tài khoản Google (đăng nhập nhanh). Gỡ cần mật khẩu.
function GoogleLinkSection({ st, reload }) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(''), [err, setErr] = useState(''), [pw, setPw] = useState(''), [rm, setRm] = useState(false);
  const [lnonce, setLnonce] = useState(null), [lcode, setLcode] = useState('');   // chờ nhập mã xác nhận từ trang trình duyệt
  const link = async () => {
    setBusy(true); setErr(''); setMsg('Đã mở trình duyệt — chọn tài khoản Google rồi quay lại đây…');
    try {
      const b = await api.googleBegin('link', api.currentToken()); window.open(b.url, '_blank');
      const t0 = Date.now();
      for (;;) {
        if (Date.now() - t0 > 600_000) throw new Error('Hết thời gian chờ');
        await new Promise((r) => setTimeout(r, 2000));
        const r = await api.googlePoll({ nonce: b.nonce }, api.currentToken());
        if (r.needCode) { setLnonce(b.nonce); setMsg('Nhập mã xác nhận đang hiện trên trang trình duyệt:'); break; }
      }
    } catch (e) { setMsg(''); setErr(e.message); } finally { setBusy(false); }
  };
  const confirmLink = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.googlePoll({ nonce: lnonce, code: lcode.trim() }, api.currentToken());
      if (r.linked) { setLnonce(null); setLcode(''); setMsg('✓ Đã liên kết ' + (r.email || 'Google')); await reload(); }
    } catch (e) { setErr(e.message); if (e.status === 410) { setLnonce(null); setMsg(''); } } finally { setBusy(false); }
  };
  const unlink = async () => { setBusy(true); setErr(''); try { await api.googleUnlink(pw); setRm(false); setPw(''); setMsg('Đã gỡ liên kết Google'); await reload(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (<section>
    <h4>Tài khoản Google {st.google ? <span className="pill ok">Đã liên kết</span> : <span className="pill">Chưa liên kết</span>}</h4>
    {st.google ? <div className="row-inline"><GoogleG /> <span data-user-content>{st.google}</span>
      <button type="button" className="link small danger" onClick={() => setRm(!rm)}>Gỡ</button></div>
      : <><p className="muted small">Đăng nhập nhanh bằng Google. Máy mới vẫn cần mật khẩu ReaChat để mở khóa tin nhắn mã hóa.</p>
        <button type="button" className="google-btn" disabled={busy} onClick={link}><GoogleG /> <span>Liên kết Google</span></button></>}
    {lnonce && <div className="row-inline"><input maxLength={8} placeholder="Mã xác nhận" value={lcode} onChange={(e) => setLcode(e.target.value.toUpperCase())} autoFocus />
      <button type="button" className="ghost" disabled={busy || lcode.trim().length < 6} onClick={confirmLink}>Xác nhận</button></div>}
    {rm && <div className="row-inline"><input type="password" placeholder="Mật khẩu để xác nhận" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button type="button" className="ghost danger" disabled={busy || !pw} onClick={unlink}>Gỡ liên kết</button></div>}
    {msg && <div className="ok-msg small" data-user-content>{msg}</div>}
    {err && <div className="error small">{err}</div>}
  </section>);
}

// Email / số điện thoại để nhận mã khi quên mật khẩu (xác minh bằng mã 6 số).
function ContactSection({ st, reload }) {
  const ch = st.channels || {};
  if (!ch.email && !ch.sms) return (<section><h4>Email / số điện thoại khôi phục</h4>
    <p className="muted small">Máy chủ chưa cấu hình gửi email/SMS — hãy dùng <b>mã khôi phục</b> ở trên.</p></section>);
  return (<section>
    <h4>Email / số điện thoại khôi phục</h4>
    <p className="muted small">Dùng để nhận mã 6 số khi quên mật khẩu (màn đăng nhập → “Quên mật khẩu?”). Không hiển thị cho người khác.</p>
    {ch.email && <ContactRow kind="email" label="Email" current={st.email} placeholder="ban@congty.vn" reload={reload} />}
    {ch.sms && <ContactRow kind="phone" label="Số điện thoại" current={st.phone} placeholder="0912 345 678" reload={reload} />}
  </section>);
}
function ContactRow({ kind, label, current, placeholder, reload }) {
  const [edit, setEdit] = useState(false), [v, setV] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState(false);
  const [pw, setPw] = useState(''), [removing, setRemoving] = useState(false);
  const [msg, setMsg] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const [guard, reauthUi] = useReauth(run);
  const send = () => guard(async (auth) => { const r = await api.contactStart(kind, v, auth); setSent(true); setMsg('Đã gửi mã tới ' + v + (r.devCode ? ' [dev: ' + r.devCode + ']' : '')); });
  const verify = () => run(async () => { await api.contactVerify(kind, code); setEdit(false); setSent(false); setV(''); setCode(''); setMsg('✓ Đã xác minh'); await reload(); });
  const remove = () => run(async () => { await api.contactRemove(kind, pw); setRemoving(false); setPw(''); setMsg('Đã gỡ'); await reload(); });
  return (<div className="contact-row">
    <div className="row-inline"><b>{label}:</b> {current ? <><span data-user-content>{current}</span> <span className="pill ok">Đã xác minh</span></> : <span className="pill warn">Chưa có</span>}
      {!edit && <button type="button" className="link small" onClick={() => { setEdit(true); setRemoving(false); }}>{current ? 'Đổi' : 'Thêm'}</button>}
      {current && !edit && <button type="button" className="link small danger" onClick={() => setRemoving(!removing)}>Gỡ</button>}</div>
    {edit && <div className="row-inline">
      <input value={v} placeholder={placeholder} onChange={(e) => { setV(e.target.value); setSent(false); }} />
      <button type="button" className="ghost" disabled={busy || !v.trim()} onClick={send}>{sent ? 'Gửi lại' : 'Gửi mã'}</button>
      {sent && <><input className="otp-input" inputMode="numeric" maxLength={6} placeholder="Mã 6 số" value={code} onChange={(e) => setCode(e.target.value)} />
        <button type="button" className="primary" disabled={busy || code.trim().length !== 6} onClick={verify}>Xác minh</button></>}
      <button type="button" className="link small" onClick={() => { setEdit(false); setSent(false); setErr(''); }}>Huỷ</button>
    </div>}
    {reauthUi}
    {removing && <div className="row-inline"><input type="password" placeholder="Mật khẩu để xác nhận" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button type="button" className="ghost danger" disabled={busy || !pw} onClick={remove}>Gỡ {label.toLowerCase()}</button></div>}
    {msg && <div className="ok-msg small" data-user-content>{msg}</div>}
    {err && <div className="error small">{err}</div>}
  </div>);
}

// Quyền riêng tư: ai tìm thấy tôi.
function PrivacySection() {
  const [p, setP] = useState(null), [err, setErr] = useState('');
  useEffect(() => { api.getPrivacy().then(setP).catch((e) => setErr(e.message)); }, []);
  const toggle = async (k) => {
    const next = { ...p, [k]: !p[k] }; setP(next); setErr('');
    try { await api.setPrivacy({ [k]: next[k] }); } catch (e) { setErr(e.message); setP(p); }
  };
  return (<section>
    <h4>Quyền riêng tư</h4>
    {!p ? <div className="muted small">{err || 'Đang tải…'}</div> : <>
      <label className="check-row"><input type="checkbox" checked={p.findByName} onChange={() => toggle('findByName')} /> <span>Cho người khác tìm thấy tôi theo tên</span></label>
      <label className="check-row"><input type="checkbox" checked={p.findByContact} onChange={() => toggle('findByContact')} /> <span>Cho tìm thấy tôi bằng email / số điện thoại (phải nhập đúng chính xác)</span></label>
      <p className="muted small">Tắt cả hai thì người khác chỉ kết bạn được khi biết đúng username của bạn hoặc quét mã QR.</p>
      <label className="check-row"><input type="checkbox" checked={!p.hidePresence} onChange={() => toggle('hidePresence')} /> <span>Hiện trạng thái “đang hoạt động” và “truy cập lần cuối”</span></label>
      <label className="check-row"><input type="checkbox" checked={p.readReceipts} onChange={() => toggle('readReceipts')} /> <span>Gửi trạng thái “Đã xem”</span></label>
      <p className="muted small">Tắt “Đã xem” thì bạn cũng không thấy người khác đã xem tin của bạn hay chưa (có đi có lại).</p>
    </>}
    {err && p && <div className="error small">{err}</div>}
  </section>);
}

// Thiết bị đang đăng nhập: xem, đăng xuất từng máy hoặc mọi máy khác.
// Duyệt đăng nhập máy mới: quét/dán mã -> xem thiết bị + IP đang xin -> cho phép (gửi khóa danh tính niêm phong cho máy đó).
const QR_LOGIN_RE = /^reachat-login:([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9+/]{43}=)$/;
function QrApproveModal({ me, onClose }) {
  const [code, setCode] = useState(''), [req, setReq] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [cam, setCam] = useState(false);
  const check = async (text) => {
    setErr(''); const m = String(text || '').trim().match(QR_LOGIN_RE);
    if (!m) { setErr('Không phải mã đăng nhập ReaChat'); return; }
    setCam(false); setBusy(true);
    try {
      const i = await api.qrLoginInfo(m[1]);
      if (i.epk !== m[2]) throw new Error('Mã không khớp với máy chủ — không an toàn, hãy tạo mã mới');
      setReq({ sid: m[1], epk: m[2], ...i });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const allow = async () => {
    setBusy(true); setErr('');
    try { await api.qrLoginApprove(req.sid, crypto.sealKeyBundleFor(me, req.epk)); setDone(true); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal qr-approve" onClick={(e) => e.stopPropagation()}>
      <h3>📷 Đăng nhập máy khác bằng QR</h3>
      {done ? <p className="ok-msg">✓ Đã cho phép — máy kia sẽ vào tài khoản trong giây lát.</p> : !req ? (<>
        <p className="muted small">Trên máy mới chọn <b>Đăng nhập bằng mã QR</b>, rồi quét mã bằng camera hoặc dán mã vào đây.</p>
        {cam ? <QrScanner onResult={check} onError={(e) => { setCam(false); setErr(e); }} />
          : <button type="button" className="ghost" onClick={() => setCam(true)}>📷 Mở camera quét mã</button>}
        <form className="row-inline" onSubmit={(e) => { e.preventDefault(); check(code); }}>
          <input className="grow" placeholder="reachat-login:…" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="primary" disabled={busy || !code.trim()}>Kiểm tra</button>
        </form>
      </>) : (<>
        <div className="notice">Thiết bị <b data-user-content>{req.device || 'không rõ'}</b> · IP <b data-user-content>{req.ip || '?'}</b> đang xin đăng nhập
          <b> @{me}</b> và nhận khóa mã hóa để đọc tin nhắn của bạn.</div>
        <p className="error small">Chỉ cho phép nếu đó là máy của chính bạn, bạn vừa tự mở mã QR trên đó. Không ai từ ReaChat yêu cầu bạn quét mã.</p>
        <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Từ chối</button>
          <button type="button" className="primary" disabled={busy} onClick={allow}>Cho phép đăng nhập</button></div>
      </>)}
      {err && <div className="error">{err}</div>}
      {(done || !req) && <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Đóng</button></div>}
    </div>
  </div>);
}

// Quên mã PIN trò chuyện ẩn: chỉ có cách xóa các trò chuyện đó (phía mình) rồi đặt PIN mới — như Zalo.
function SecretChatsSection() {
  const [ask, setAsk] = useState(false);
  return (<section>
    <h4>Trò chuyện ẩn</h4>
    <p className="muted small">Ẩn: ⋯ ở một hội thoại → <b>Ẩn trò chuyện</b>. Xem lại: gõ mã PIN vào ô Tìm tin nhắn.</p>
    {!ask ? <button type="button" className="link small danger-text" onClick={() => setAsk(true)}>Quên mã PIN?</button>
      : <div className="row-inline"><span className="small">Xóa mọi trò chuyện ẩn trên máy này và bỏ mã PIN?</span>
        <button type="button" className="ghost mini danger" onClick={() => { window.dispatchEvent(new Event('reachat:secret-reset')); setAsk(false); }}>Xóa & bỏ PIN</button>
        <button type="button" className="link small" onClick={() => setAsk(false)}>Hủy</button></div>}
  </section>);
}

function DevicesSection({ me }) {
  const [d, setD] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const [qrApprove, setQrApprove] = useState(false);
  const load = () => api.listSessions().then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const fmt = (t) => new Date(t).toLocaleString();
  return (<section>
    <h4>Thiết bị đăng nhập {d && <span className="pill">{d.sessions.length}</span>}</h4>
    <button type="button" className="ghost mini" onClick={() => setQrApprove(true)}>📷 Đăng nhập máy khác bằng QR</button>
    {qrApprove && <QrApproveModal me={me} onClose={() => { setQrApprove(false); load(); }} />}
    {!d ? <div className="muted small">{err || 'Đang tải…'}</div> : <ul className="session-list">
      {d.sessions.map((s) => (<li key={s.id}>
        <div><b data-user-content>{s.device || 'Thiết bị không rõ'}</b> {s.id === d.current && <span className="pill ok">Thiết bị này</span>}
          <div className="muted small"><span data-user-content>{s.ip || '—'}</span> · <span>Đăng nhập</span> <span data-user-content>{fmt(s.createdAt)}</span> · <span>Hoạt động</span> <span data-user-content>{fmt(s.lastSeen)}</span></div></div>
        {s.id !== d.current && <button type="button" className="ghost danger mini" disabled={busy} onClick={() => run(() => api.revokeSession(s.id))}>Đăng xuất</button>}
      </li>))}
    </ul>}
    {d && d.sessions.some((s) => s.id !== d.current) && <button type="button" className="ghost" disabled={busy} onClick={() => run(() => api.revokeOtherSessions())}>Đăng xuất mọi thiết bị khác</button>}
    <p className="muted small">Thiết bị không hoạt động quá 30 ngày tự đăng xuất.</p>
    {err && d && <div className="error small">{err}</div>}
  </section>);
}

// Vùng nguy hiểm: tự xóa tài khoản (mật khẩu + mã 2 bước + gõ XOA).
function DeleteAccountSection({ user, totp }) {
  const [open, setOpen] = useState(false), [pw, setPw] = useState(''), [otp, setOtp] = useState(''), [typed, setTyped] = useState('');
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const del = async () => {
    setBusy(true); setErr('');
    try {
      await api.deleteAccount({ password: pw, otp, confirm: 'XOA' });
      for (const k of Object.keys(localStorage)) if (k.endsWith('.' + user.username) || k.endsWith(':' + user.username)) localStorage.removeItem(k);
      window.__reachatLogoutMsg = 'Tài khoản @' + user.username + ' đã được xóa.';
      window.dispatchEvent(new Event('reachat:unauthorized'));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (<section className="danger-zone">
    <h4>Xóa tài khoản</h4>
    {!open ? <><p className="muted small">Xóa vĩnh viễn: thu hồi mọi tin bạn đã gửi, xóa tệp, danh bạ, story và khóa mã hóa. Không thể hoàn tác.</p>
      <button type="button" className="ghost danger" onClick={() => setOpen(true)}>Xóa tài khoản…</button></> : <>
      <p className="small">⚠️ Tin nhắn bạn đã gửi sẽ bị thu hồi ở mọi người nhận; bạn rời mọi nhóm (quyền trưởng nhóm chuyển cho thành viên khác); bot của bạn bị vô hiệu hóa.</p>
      <input type="password" placeholder="Mật khẩu" value={pw} onChange={(e) => setPw(e.target.value)} />
      {totp && <input className="otp-input" inputMode="numeric" maxLength={7} placeholder="Mã 2 bước" value={otp} onChange={(e) => setOtp(e.target.value)} />}
      <input placeholder='Gõ "XOA" để xác nhận' value={typed} onChange={(e) => setTyped(e.target.value)} />
      <div className="row-inline"><button type="button" className="ghost" onClick={() => setOpen(false)}>Huỷ</button>
        <button type="button" className="danger-btn" disabled={busy || !pw || typed.trim().toUpperCase() !== 'XOA'} onClick={del}>Xóa vĩnh viễn</button></div>
      {err && <div className="error small">{err}</div>}
    </>}
  </section>);
}

// Bot của tôi: tạo, token (hiện một lần), webhook, đổi token, xóa + hướng dẫn gọi API.
function BotsPanel() {
  const [bots, setBots] = useState(null);
  const [form, setForm] = useState({ username: '', displayName: '' });
  const [secret, setSecret] = useState(null);         // {botId, token} | {botId, webhookSecret}
  const [hook, setHook] = useState({});
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const load = () => api.listBots().then(setBots).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const create = () => run(async () => { const r = await api.createBot(form); setSecret({ botId: r.bot.id, token: r.token }); setForm({ username: '', displayName: '' }); await load(); });
  const regen = (b) => run(async () => { const r = await api.botToken(b.id); setSecret({ botId: b.id, token: r.token }); });
  const saveHook = (b) => run(async () => { const r = await api.botWebhook(b.id, hook[b.id] ?? b.webhook ?? ''); setSecret(r.webhook ? { botId: b.id, webhookSecret: r.secret } : null); await load(); });
  const remove = (b) => run(async () => { await api.deleteBot(b.id); await load(); });
  const base = api.serverBase();
  return (<div className="bots-panel">
    <p className="muted small">Bot là tài khoản tự động bạn điều khiển bằng token qua API (trả lời tự động, thông báo, tích hợp hệ thống khác).
      Tin nhắn với bot <b>không mã hóa đầu-cuối</b>; bot không đọc được tin nhóm mã hóa.</p>
    <div className="row-inline">
      <input placeholder="tên bot (kết thúc bằng bot, vd. thoitiet_bot)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
      <input placeholder="Tên hiển thị" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      <button className="primary" disabled={busy || !form.username} onClick={create}>Tạo bot</button>
    </div>
    {secret?.token && <div className="rc-box"><div className="small">🔑 Token bot (chỉ hiện <b>một lần</b> — giữ kín như mật khẩu):</div>
      <code className="rc-code small-code">{secret.token}</code>
      <div className="row-inline"><button className="ghost" onClick={() => navigator.clipboard?.writeText(secret.token)}>Sao chép</button><button className="link" onClick={() => setSecret(null)}>Đã lưu</button></div></div>}
    {secret?.webhookSecret && <div className="rc-box"><div className="small">Bí mật ký webhook (kiểm tra header <code>X-ReaChat-Signature</code> = HMAC-SHA256(bí mật, thân yêu cầu)):</div>
      <code className="rc-code small-code">{secret.webhookSecret}</code></div>}
    {!bots ? <div className="muted">Đang tải…</div> : bots.length === 0 ? <div className="muted small">Chưa có bot nào.</div> : (
      <ul className="bot-list">{bots.map((b) => (
        <li key={b.id}>
          <div className="row-inline"><b>🤖 @{b.username}</b><span className="muted small">{b.displayName}</span>
            <span className="grow" /><button className="ghost" disabled={busy} onClick={() => regen(b)}>Token mới</button>
            <button className="link danger-text" disabled={busy} onClick={() => remove(b)}>Xóa</button></div>
          <div className="row-inline"><input className="grow" placeholder="Webhook URL (tuỳ chọn) — https://…" value={hook[b.id] ?? b.webhook ?? ''} onChange={(e) => setHook({ ...hook, [b.id]: e.target.value })} />
            <button className="ghost" disabled={busy} onClick={() => saveHook(b)}>Lưu webhook</button></div>
        </li>))}</ul>)}
    <details className="bot-docs"><summary>Cách dùng API</summary>
      <pre>{`# Nhận tin (long-poll, chờ tối đa 25 giây)
curl -H "Authorization: Bot <TOKEN>" "${base}/bot/v1/updates?since=0&timeout=25"

# Gửi tin (tới username hoặc conversationId từ updates)
curl -X POST -H "Authorization: Bot <TOKEN>" -H "Content-Type: application/json" \\
  -d '{"to":"username","text":"Xin chào!"}' ${base}/bot/v1/send

# Bot mẫu có sẵn trên máy chủ:
REACHAT_BOT_TOKEN=<TOKEN> node server/scripts/echo-bot.mjs ${base}`}</pre>
    </details>
    {err && <div className="error small">{err}</div>}
  </div>);
}

// Thông báo đẩy cho bản web/PWA: nhận tin & cuộc gọi nhỡ khi đã đóng tab (điện thoại: cài app ra màn hình chính).
const b64uToBytes = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
function PushPanel() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && location.pathname.startsWith('/app');
  const [sub, setSub] = useState(null), [msg, setMsg] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (supported) navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setSub).catch(() => {}); }, []);
  const enable = async () => {
    setBusy(true); setMsg('');
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Bạn chưa cho phép thông báo trong trình duyệt');
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(await api.pushKey()) });
      const muted = Object.entries(JSON.parse(localStorage.getItem('reachat.convprefs.' + (JSON.parse(localStorage.getItem('reachat.session'))?.user?.username)) || '{}')).filter(([, p]) => p.muted).map(([id]) => id);
      await api.pushSubscribe(s.toJSON(), muted);
      setSub(s); setMsg('✓ Đã bật — bạn sẽ nhận thông báo khi không mở ReaChat');
    } catch (e) { setMsg('⚠️ ' + e.message); } finally { setBusy(false); }
  };
  const disable = async () => { setBusy(true); try { await api.pushUnsubscribe(sub.endpoint); await sub.unsubscribe(); setSub(null); setMsg('Đã tắt thông báo đẩy trên thiết bị này'); } catch (e) { setMsg('⚠️ ' + e.message); } finally { setBusy(false); } };
  if (!supported) return <p className="muted small">Thông báo đẩy dùng cho bản web mở từ máy chủ (<code>{location.origin}/app</code>) trên trình duyệt hỗ trợ.
    Trên điện thoại: mở trang đó → “Thêm vào màn hình chính” để cài như ứng dụng.</p>;
  return (<div className="security-panel">
    <section>
      <h4>Thông báo đẩy trên thiết bị này {sub ? <span className="pill ok">Đang bật</span> : <span className="pill">Tắt</span>}</h4>
      <p className="muted small">Khi bạn đóng ReaChat, máy chủ vẫn báo có tin mới / cuộc gọi nhỡ. Nội dung tin mã hóa đầu-cuối nên thông báo chỉ ghi
        “tin nhắn mới từ @…”. Hội thoại đã tắt thông báo sẽ không đẩy.</p>
      {sub ? <button className="ghost" disabled={busy} onClick={disable}>Tắt thông báo đẩy</button> : <button className="primary" disabled={busy} onClick={enable}>Bật thông báo đẩy</button>}
    </section>
    <section>
      <h4>Cài lên điện thoại</h4>
      <p className="muted small">Android (Chrome): menu ⋮ → <b>Cài đặt ứng dụng</b>. iPhone (Safari, iOS 16.4+): nút Chia sẻ → <b>Thêm vào MH chính</b>,
        rồi mở ReaChat từ màn hình chính để bật thông báo.</p>
    </section>
    {msg && <div className="small">{msg}</div>}
  </div>);
}

function BackupPanel({ onExport, onImport }) {
  const [pw, setPw] = useState(''), [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(''), [err, setErr] = useState('');
  const run = async (fn) => { setBusy(true); setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); } };
  const doExport = () => run(async () => {
    if (pw.length < 8) throw new Error('Mật khẩu sao lưu tối thiểu 8 ký tự');
    if (pw !== pw2) throw new Error('Hai lần nhập mật khẩu không khớp');
    const r = await onExport(pw);
    if (r.where) setMsg(`✓ Đã lưu ${r.count} tin vào: ${r.where}`);
  });
  const doImport = () => run(async () => {
    if (!pw) throw new Error('Nhập mật khẩu của tệp sao lưu');
    let text;
    if (window.reachat?.files) { const f = await window.reachat.files.open([{ name: 'Sao lưu ReaChat', extensions: ['reachat-backup'] }]); if (!f) return; text = new TextDecoder().decode(f.data); }
    else text = await new Promise((res) => { const i = Object.assign(document.createElement('input'), { type: 'file', accept: '.reachat-backup' }); i.onchange = () => i.files[0]?.text().then(res); i.click(); });
    const r = await onImport(text, pw);
    setMsg(`✓ Khôi phục xong (bản sao lưu ${new Date(r.createdAt).toLocaleString('vi-VN')}): thêm ${r.added} tin, sửa ${r.fixed} tin đang lỗi, bỏ qua ${r.total - r.added - r.fixed} tin đã có.`);
  });
  const [store, setStore] = useState(null);
  useEffect(() => { api.myStorage().then(setStore).catch(() => {}); }, []);
  return (<div className="backup-panel">
    {store && <div className="storage-row small"><span>Dung lượng tệp trên máy chủ:</span> <b data-user-content>{(store.used / 1048576).toFixed(1)} MB{store.quota ? ' / ' + (store.quota / 1048576).toFixed(0) + ' MB' : ''}</b>
      {store.quota ? <span className="storage-bar"><i style={{ width: Math.min(100, (store.used / store.quota) * 100) + '%' }} /></span> : <span className="muted">(không giới hạn)</span>}</div>}
    <p className="muted small">Tệp sao lưu chứa toàn bộ tin trên máy này (đã giải mã) + khóa nhóm/ảnh — <b>mã hóa bằng mật khẩu sao lưu</b>
      bạn đặt dưới đây. Dùng để chuyển sang máy mới hoặc giữ lại lịch sử khi không còn thiết bị cũ. Mất mật khẩu = không mở được tệp.</p>
    <input type="password" placeholder="Mật khẩu sao lưu (≥ 8 ký tự)" value={pw} onChange={(e) => setPw(e.target.value)} />
    <input type="password" placeholder="Nhập lại (khi xuất tệp)" value={pw2} onChange={(e) => setPw2(e.target.value)} />
    <div className="backup-actions">
      <button className="primary" disabled={busy} onClick={doExport}>{busy ? '…' : '⬇ Xuất tệp sao lưu'}</button>
      <button className="ghost" disabled={busy} onClick={doImport}>⬆ Khôi phục từ tệp</button>
    </div>
    {msg && <div className="ok-msg small">{msg}</div>}
    {err && <div className="error small">{err}</div>}
  </div>);
}

function ForwardModal({ rows, onClose, onPick }) {
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>Chuyển tiếp tới…</h3>
      <ul className="fwd-list">
        {rows.filter((r) => r.meta).map((r) => (
          <li key={r.id} onClick={() => onPick(r.meta)}>{r.type === 'group' ? '👥 ' + r.title : '@' + r.title}</li>
        ))}
      </ul>
      <div className="modal-actions"><button className="ghost" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

function CallUI({ call, onScreen, onRecord, verified, media, onAccept, onReject, onEnd, onToggleMute, onToggleCam }) {
  const bind = (st) => (el) => { if (el && st && el.srcObject !== st) el.srcObject = st; };
  const localRef = bind(media.local), remoteRef = bind(media.remote);
  const showVideo = call.video || call.remoteScreen;          // gọi thoại: hiện hình khi đối phương chia sẻ màn hình

  if (call.status === 'error') {
    return (<div className="modal-backdrop">
      <div className="modal call-incoming">
        <h3>Không gọi được</h3>
        <div className="muted">@{call.peer}</div>
        <div className="error small" style={{ textAlign: 'center' }}>{call.error}</div>
        <div className="modal-actions" style={{ justifyContent: 'center' }}>
          <button className="primary" onClick={onEnd}>Đóng</button>
        </div>
      </div>
    </div>);
  }

  if (call.status === 'ringing') {
    return (<div className="modal-backdrop">
      <div className="modal call-incoming">
        <div className="call-av"><Avatar name={call.peer} size={72} /></div>
        <h3>@{call.peer}</h3>
        <div className="muted">{call.video ? 'Cuộc gọi video đến…' : 'Cuộc gọi thoại đến…'}</div>
        <div className="call-ring-actions">
          <button className="call-btn reject" onClick={onReject} title="Từ chối"><Icon name="phoneOff" size={24} /></button>
          <button className="call-btn accept" onClick={onAccept} title="Nghe"><Icon name={call.video ? 'video' : 'phone'} size={24} /></button>
        </div>
      </div>
    </div>);
  }

  const connected = call.status === 'connected';
  return (<div className="call-overlay">
    {showVideo ? (
      <>
        <video ref={remoteRef} className={'call-remote' + (call.remoteScreen ? ' screen' : '')} autoPlay playsInline />
        {call.video && <video ref={localRef} className="call-local" autoPlay playsInline muted />}
        {!connected && <div className="call-remote-ph"><Avatar name={call.peer} size={96} /></div>}
      </>
    ) : (
      <div className="call-audio">
        <Avatar name={call.peer} size={120} />
        <audio ref={remoteRef} autoPlay />
      </div>
    )}
    <div className="call-status">
      <b>@{call.peer}</b>
      <div className="muted">{connected ? 'Đang trong cuộc gọi' : call.status === 'reconnecting' ? 'Mất kết nối — đang thử lại…' : call.status === 'calling' ? 'Đang gọi…' : 'Đang kết nối…'}</div>
      {connected && call.route && <div className="muted small" title={call.route === 'relay' ? 'Đi qua máy chủ TURN (vẫn mã hóa DTLS-SRTP đầu-cuối)' : 'Kết nối trực tiếp giữa hai máy'}>
        {call.route === 'relay' ? '🛰 Chuyển tiếp qua TURN · 🔒' : '⚡ Trực tiếp P2P · 🔒'}
        {verified ? ' · ✅ đã xác minh mã an toàn' : ''}</div>}
      {call.sharing && <div className="share-chip">🖥 Bạn đang chia sẻ màn hình</div>}
      {call.remoteScreen && <div className="share-chip">🖥 @{call.peer} đang chia sẻ màn hình</div>}
      {(call.recording || call.remoteRec) && <div className="share-chip rec-chip">🔴 {call.recording ? 'Bạn đang ghi cuộc gọi' : '@' + call.peer + ' đang ghi cuộc gọi'}</div>}
    </div>
    <div className="call-controls">
      <button className={'call-btn' + (call.muted ? ' on' : '')} onClick={onToggleMute} title={call.muted ? 'Mở mic' : 'Tắt mic'}><Icon name={call.muted ? 'micOff' : 'mic'} size={24} /></button>
      {connected && <button className={'call-btn rec' + (call.recording ? ' on' : '')} onClick={onRecord} title={call.recording ? 'Dừng ghi & lưu tệp' : 'Ghi cuộc gọi'}><Icon name="rec" size={24} /></button>}
      {connected && <button className={'call-btn' + (call.sharing ? ' on' : '')} onClick={onScreen} title={call.sharing ? 'Dừng chia sẻ màn hình' : 'Chia sẻ màn hình'}><Icon name="monitor" size={24} /></button>}
      {call.video && <button className={'call-btn' + (call.camOff ? ' on' : '')} onClick={onToggleCam} title={call.camOff ? 'Mở camera' : 'Tắt camera'}><Icon name={call.camOff ? 'videoOff' : 'video'} size={24} /></button>}
      <button className="call-btn end" onClick={onEnd} title="Kết thúc"><Icon name="phoneOff" size={24} /></button>
    </div>
  </div>);
}

// Chọn màn hình / cửa sổ để chia sẻ (app desktop). onClose(id | null).
function ScreenPicker({ onClose }) {
  const [list, setList] = useState(null);
  useEffect(() => { window.reachat.screen.list().then(setList).catch(() => setList([])); }, []);
  return (<div className="modal-backdrop screen-picker-bd" onClick={() => onClose(null)}>
    <div className="modal screen-picker" onClick={(e) => e.stopPropagation()}>
      <h3>🖥 Chia sẻ màn hình</h3>
      {!list ? <div className="muted">Đang lấy danh sách…</div> : (
        <div className="screen-grid">
          {list.map((s) => (
            <button key={s.id} className="screen-item" onClick={() => onClose(s.id)} title={s.name}>
              <img src={s.thumb} alt="" /><span>{s.id.startsWith('screen') ? '🖥 ' : '🪟 '}{s.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="muted small">Người trong cuộc gọi sẽ thấy nội dung bạn chọn cho tới khi bạn bấm dừng.</div>
      <div className="modal-actions"><button className="ghost" onClick={() => onClose(null)}>Huỷ</button></div>
    </div>
  </div>);
}

// Cuộc gọi nhóm: lưới ô (mình + từng người), mỗi ô một <video> (gọi thoại thì ẩn hình, hiện avatar).
function GroupCallUI({ gcall, meetLink, onCopied, onScreen, onRecord, verifiedOf, peers, local, me, onLeave, onToggleMute, onToggleCam }) {
  const n = peers.length + 1;
  return (<div className="call-overlay gcall">
    <div className="gcall-head">
      <b>{gcall.title}</b>
      {meetLink && <button className="meet-link" onClick={() => { navigator.clipboard?.writeText(meetLink); onCopied?.(); }} title="Sao chép link mời vào phòng họp">🔗 {meetLink}</button>}
      <span className="muted small">{gcall.status === 'joining' ? (gcall.pid ? 'Mất kết nối — đang vào lại…' : 'Đang vào cuộc gọi…')
        : peers.length === 0 ? 'Đang chờ mọi người tham gia…' : `${n} người · 🔒 mã hóa đầu-cuối`}</span>
      {(gcall.recording || peers.some((p) => p.recording)) && <span className="share-chip rec-chip">🔴 {[gcall.recording ? 'Bạn' : null, ...peers.filter((p) => p.recording).map((p) => '@' + p.username)].filter(Boolean).join(', ')} đang ghi cuộc gọi</span>}
    </div>
    <div className={'gcall-grid n' + Math.min(n, 6)}>
      <GTile username={me} label={gcall.sharing ? 'Bạn · 🖥 đang chia sẻ' : 'Bạn'} stream={local} video={gcall.video && !gcall.camOff} self muted={gcall.muted} />
      {peers.map((p) => <GTile key={p.pid} username={p.username} label={'@' + p.username + (p.sharing ? ' · 🖥 đang chia sẻ' : '')} stream={p.stream} video={gcall.video || p.sharing} sharing={p.sharing}
        status={p.status} route={p.route} verified={verifiedOf(p.username)} />)}
    </div>
    <div className="call-controls">
      <button className={'call-btn' + (gcall.muted ? ' on' : '')} onClick={onToggleMute} title={gcall.muted ? 'Mở mic' : 'Tắt mic'}><Icon name={gcall.muted ? 'micOff' : 'mic'} size={24} /></button>
      {gcall.status === 'in' && <button className={'call-btn rec' + (gcall.recording ? ' on' : '')} onClick={onRecord} title={gcall.recording ? 'Dừng ghi & lưu tệp' : 'Ghi cuộc gọi'}><Icon name="rec" size={24} /></button>}
      {gcall.status === 'in' && <button className={'call-btn' + (gcall.sharing ? ' on' : '')} onClick={onScreen} title={gcall.sharing ? 'Dừng chia sẻ màn hình' : 'Chia sẻ màn hình'}><Icon name="monitor" size={24} /></button>}
      {gcall.video && <button className={'call-btn' + (gcall.camOff ? ' on' : '')} onClick={onToggleCam} title={gcall.camOff ? 'Mở camera' : 'Tắt camera'}><Icon name={gcall.camOff ? 'videoOff' : 'video'} size={24} /></button>}
      <button className="call-btn end" onClick={onLeave} title="Rời cuộc gọi"><Icon name="phoneOff" size={24} /></button>
    </div>
  </div>);
}

function GTile({ username, label, stream, video, self, muted, status, route, verified, sharing }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null; }, [stream]);
  const waiting = !self && status !== 'connected';
  return (<div className={'gtile' + (video && stream && !waiting ? ' has-video' : '') + (sharing ? ' sharing' : '')}>
    <video ref={ref} autoPlay playsInline muted={self} className={self ? 'mirror' : ''} />
    {!(video && stream && !waiting) && <div className="gtile-ph"><Avatar name={username} size={72} /></div>}
    <div className="gtile-label">
      {label}{verified ? ' ✅' : ''}{self && muted ? ' · 🔇' : ''}
      {waiting && <span className="muted"> · {status === 'reconnecting' ? 'đang nối lại…' : 'đang kết nối…'}</span>}
      {!self && status === 'connected' && route && <span title={route === 'relay' ? 'Qua TURN' : 'Trực tiếp'}> {route === 'relay' ? '🛰' : '⚡'}</span>}
    </div>
  </div>);
}

// Quét QR bằng camera (jsQR). Gọi onResult(text) khi đọc được mã.
function QrScanner({ onResult, onError }) {
  const videoRef = useRef(null);
  useEffect(() => {
    let stream = null, raf = 0, alive = true;
    const canvas = document.createElement('canvas');
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!alive) return;
        const v = videoRef.current; v.srcObject = stream; await v.play();
        const tick = () => {
          if (!alive) return;
          if (v.readyState === v.HAVE_ENOUGH_DATA) {
            canvas.width = v.videoWidth; canvas.height = v.videoHeight;
            const ctx = canvas.getContext('2d'); ctx.drawImage(v, 0, 0);
            const res = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
            if (res?.data) { onResult(res.data); return; }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) { onError?.(e?.name === 'NotAllowedError' ? 'Chưa cấp quyền camera.' : 'Không mở được camera.'); }
    })();
    return () => { alive = false; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return <video ref={videoRef} className="qr-video" playsInline muted />;
}

// Mã an toàn: 60 chữ số + QR. Quét QR trên máy đối phương: KHỚP -> xác minh (khiên xanh).
function SafetyNumberModal({ me, safety, verified, onVerify, onClose }) {
  const groups = safety.number ? safety.number.split(' ') : [];
  const [qr, setQr] = useState(''); const [scan, setScan] = useState(false); const [result, setResult] = useState(null);
  useEffect(() => { if (safety.number) QRCode.toDataURL('reachat-safety:' + safety.number.replace(/\s/g, ''), { margin: 1, width: 180 }).then(setQr).catch(() => {}); }, [safety.number]);
  const onScanned = (text) => {
    setScan(false);
    const ok = text.replace(/^reachat-safety:/, '').replace(/\s/g, '') === safety.number.replace(/\s/g, '');
    setResult(ok ? 'ok' : 'bad'); onVerify(ok);
  };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>🔒 Mã an toàn {verified && <span className="verified-tag">✓ Đã xác minh</span>}</h3>
      <div className="muted small">Giữa <b>@{me}</b> và <b>@{safety.peerUsername}</b></div>
      {safety.number ? (<>
        <div className="safety-row">
          {scan ? <QrScanner onResult={onScanned} onError={(m) => { setScan(false); setResult(m); }} />
            : qr && <img className="safety-qr" src={qr} alt="QR mã an toàn" />}
          <div className="safety-grid">{groups.map((g, i) => <span key={i} className="safety-cell">{g}</span>)}</div>
        </div>
        {result === 'ok' && <div className="ok-box">✅ Khớp — kênh với @{safety.peerUsername} an toàn, đã đánh dấu xác minh.</div>}
        {result === 'bad' && <div className="error">❌ KHÔNG khớp — có thể bị chèn khóa (nghe lén). Đừng gửi thông tin nhạy cảm.</div>}
        {result && result !== 'ok' && result !== 'bad' && <div className="error small">{result}</div>}
        <div className="muted small">Cách xác minh: mở mã an toàn trên máy @{safety.peerUsername} rồi quét QR của nhau, hoặc đọc so 60 chữ số qua điện thoại/gặp mặt.</div>
        <div className="quick-row">
          <button className="ghost" onClick={() => { setResult(null); setScan(!scan); }}>{scan ? '✕ Tắt camera' : '📷 Quét QR của đối phương'}</button>
          {verified
            ? <button className="ghost" onClick={() => onVerify(false)}>Bỏ xác minh</button>
            : <button className="ghost" onClick={() => { onVerify(true); setResult('ok'); }}>Đã so khớp bằng mắt ✓</button>}
        </div>
      </>) : (
        <div className="error small">Chưa lấy được khóa công khai của @{safety.peerUsername}. Hãy nhắn một tin để đồng bộ khóa rồi thử lại.</div>
      )}
      <div className="modal-actions"><button className="primary" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Mã kết bạn: chuỗi "reachat:<username>" hiển thị dạng QR + nhập tay để gửi lời mời.
const friendCode = (u) => 'reachat:' + u;
const parseFriendCode = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/^reachat:(.+)$/i);
  return (m ? m[1] : s).toLowerCase().replace(/^@+/, '').trim();
};

function AddFriendModal({ me, outgoing, onClose, onSend, onInvite }) {
  const [qr, setQr] = useState('');
  const [v, setV] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false); const [scanMsg, setScanMsg] = useState('');
  const videoRef = useRef(null); const scanRef = useRef(null);
  const code = friendCode(me.username);
  useEffect(() => { QRCode.toDataURL(code, { margin: 1, width: 220 }).then(setQr).catch(() => {}); }, [code]);

  const trySend = async (value) => {
    if (onInvite?.(value)) return;                                // link mời nhóm (gõ / quét QR)
    setErr(''); setBusy(true);
    try { await onSend(parseFriendCode(value)); setV(''); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const submit = (e) => { e.preventDefault(); trySend(v); };
  // Tìm bạn bè khi gõ (≥ 2 ký tự, chờ 350 ms sau phím cuối): tên, username, email / số điện thoại đã xác minh.
  const [found, setFound] = useState(null);          // null | { by, results }
  const [rel, setRel] = useState({});                // username -> quan hệ sau khi bấm (cập nhật tại chỗ)
  useEffect(() => {
    const q = v.trim();
    if (q.length < 2 || /^reachat:/i.test(q) || /\/(join|meet|c)\//i.test(q)) { setFound(null); return; }
    let live = true;
    const t = setTimeout(() => { api.searchUsers(q).then((r) => { if (live) setFound(r); }).catch((e) => { if (live) setFound({ results: [], error: e.message }); }); }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [v]);
  const addFromResult = async (u) => {
    setErr('');
    try { await onSend(u.username); setRel((m) => ({ ...m, [u.username]: u.relation === 'incoming' ? 'friend' : 'sent' })); }
    catch (e) { setErr(e.message); }
  };

  // Quét QR qua camera: lấy khung hình -> canvas -> jsQR; phát hiện reachat:... thì gửi lời mời.
  const stopScan = () => {
    cancelAnimationFrame(scanRef.current?.raf);
    scanRef.current?.stream?.getTracks().forEach((t) => t.stop());
    scanRef.current = null; setScanning(false);
  };
  useEffect(() => () => stopScan(), []);
  const startScan = async () => {
    setErr(''); setScanMsg('Đang mở camera…'); setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      scanRef.current = { stream };
      const video = videoRef.current; video.srcObject = stream; await video.play();
      const canvas = document.createElement('canvas');
      const tick = () => {
        if (!scanRef.current) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const res = jsQR(img.data, img.width, img.height);
          if (res && /reachat:/i.test(res.data)) { setScanMsg('Đã quét: ' + res.data); stopScan(); trySend(res.data); return; }
          setScanMsg('Đưa mã QR vào khung hình…');
        }
        scanRef.current.raf = requestAnimationFrame(tick);
      };
      scanRef.current.raf = requestAnimationFrame(tick);
    } catch (e) {
      setScanning(false);
      setErr(e?.name === 'NotAllowedError' ? 'Chưa cấp quyền camera.' : 'Không mở được camera: ' + (e?.message || e?.name));
    }
  };

  return (<div className="modal-backdrop" onClick={() => { stopScan(); onClose(); }}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>👤 Kết bạn</h3>
      {scanning ? (
        <div className="qr-scan">
          <video ref={videoRef} playsInline muted />
          <div className="muted small">{scanMsg}</div>
          <button className="link" onClick={stopScan}>Dừng quét</button>
        </div>
      ) : (
        <div className="qr-box">
          {qr ? <img src={qr} alt="QR" width={200} height={200} /> : <div className="muted">đang tạo QR…</div>}
          <div className="muted small">Mã kết bạn của bạn</div>
          <code className="friend-code">{code}</code>
        </div>
      )}
      <form onSubmit={submit} className="add-friend-form">
        <div className="muted small">Tìm theo tên, username, email hoặc số điện thoại — hoặc dán mã / quét QR:</div>
        <input placeholder="Tên, @username, email, số điện thoại…" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        {found && <div className="search-results">
          {found.error ? <div className="error small">{found.error}</div>
            : !found.results.length ? <div className="muted small">{found.by === 'email' || found.by === 'phone' ? 'Không có ai dùng email / số điện thoại này (hoặc họ đã tắt tìm kiếm).' : 'Không tìm thấy ai.'}</div>
            : found.results.map((u) => { const r = rel[u.username] || u.relation; return (
              <div key={u.id} className="search-row">
                <Avatar name={u.displayName || u.username} src={u.avatar} size={34} />
                <div className="search-who"><b data-user-content>{u.displayName || u.username}</b><span className="muted small" data-user-content>@{u.username}</span></div>
                {r === 'friend' ? <span className="pill ok">Bạn bè</span>
                  : r === 'sent' ? <span className="pill">Đã gửi lời mời</span>
                  : <button type="button" className="primary mini" onClick={() => addFromResult(u)}>{r === 'incoming' ? 'Chấp nhận' : 'Kết bạn'}</button>}
              </div>); })}
        </div>}
        {err && <div className="error small">{err}</div>}
        <div className="quick-row">
          <button type="button" className="ghost" onClick={scanning ? stopScan : startScan}>{scanning ? '✕ Tắt camera' : '📷 Quét QR'}</button>
          <button className="primary" disabled={busy || !v.trim()}>{busy ? '...' : 'Gửi lời mời'}</button>
        </div>
      </form>
      {outgoing.length > 0 && (
        <div className="muted small">Đang chờ chấp nhận: {outgoing.map((o) => '@' + o.user.username).join(', ')}</div>
      )}
      <div className="modal-actions"><button className="link" onClick={() => { stopScan(); onClose(); }}>Đóng</button></div>
    </div>
  </div>);
}

const STORY_BGS = ['#0f9f7f', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#334155'];
// Ai xem được story: mọi bạn bè TRỪ những người được chọn ẩn (áp dụng cho mọi story, cả cái đã đăng).
function StoryAudience({ contacts }) {
  const [hidden, setHidden] = useState(null);      // Set username | null khi đang tải
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { api.storyHidden().then((l) => setHidden(new Set(l.map((u) => u.username)))).catch(() => setHidden(new Set())); }, []);
  const toggle = async (u) => {
    const next = new Set(hidden);
    next.has(u) ? next.delete(u) : next.add(u);
    setHidden(next);
    try { await api.setStoryHidden([...next]); setMsg(''); } catch (e) { setMsg('⚠️ ' + e.message); setHidden(hidden); }
  };
  if (!hidden) return <div className="muted small">Đang tải quyền xem…</div>;
  const list = contacts.filter((c) => !q || (c.username + ' ' + (c.displayName || '')).toLowerCase().includes(q.toLowerCase()));
  return (<div className="story-audience">
    <div className="story-aud-row">
      <span><Icon name="users" size={15} /> Ai xem được: <b>{hidden.size ? `Bạn bè, trừ ${hidden.size} người` : 'Tất cả bạn bè'}</b></span>
      <button type="button" className="link" onClick={() => setOpen(!open)}>{open ? 'Xong' : 'Chỉnh'}</button>
    </div>
    {open && (<>
      {contacts.length > 6 && <input placeholder="Tìm bạn…" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="story-aud-list">
        {list.length === 0 && <div className="muted small">Chưa có bạn bè.</div>}
        {list.map((c) => (
          <label key={c.username} className={'check-row' + (hidden.has(c.username) ? ' off' : '')}>
            <input type="checkbox" checked={hidden.has(c.username)} onChange={() => toggle(c.username)} />
            <Avatar name={c.username} src={c.avatar} size={26} /> @{c.username}
            {hidden.has(c.username) && <span className="muted small"> · đã ẩn</span>}
          </label>
        ))}
      </div>
      <div className="muted small">Người được đánh dấu sẽ không thấy story của bạn (kể cả cái đang hiển thị) và không được báo khi bạn đăng mới.</div>
    </>)}
    {msg && <div className="error small">{msg}</div>}
  </div>);
}

function StoryComposeModal({ contacts = [], onClose, onPost }) {
  const [tab, setTab] = useState('text');     // 'text' | 'image'
  const [text, setText] = useState('');
  const [bg, setBg] = useState(STORY_BGS[0]);
  const [file, setFile] = useState(null); const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const pick = (f) => { if (!f) return; setFile(f); setPreview(URL.createObjectURL(f)); };
  const submit = async () => {
    setErr(''); setBusy(true);
    try { await onPost(tab === 'image' ? { kind: 'image', file, text } : { kind: 'text', text, bg }); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  const canPost = tab === 'image' ? !!file : !!text.trim();
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>✨ Đăng story</h3>
      <div className="tabs">
        <button type="button" className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}>Chữ</button>
        <button type="button" className={tab === 'image' ? 'on' : ''} onClick={() => setTab('image')}>Ảnh</button>
      </div>
      {tab === 'text' ? (
        <>
          <div className="story-preview" style={{ background: bg }}>{text || 'Nội dung…'}</div>
          <div className="bg-row">{STORY_BGS.map((c) => <span key={c} className={'bg-dot' + (c === bg ? ' on' : '')} style={{ background: c }} onClick={() => setBg(c)} />)}</div>
          <input placeholder="Bạn đang nghĩ gì?" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </>
      ) : (
        <>
          {preview && <img className="story-img-preview" src={preview} alt="" />}
          <input type="file" accept="image/*" onChange={(e) => pick(e.target.files?.[0])} />
          <input placeholder="Chú thích (tuỳ chọn)" value={text} onChange={(e) => setText(e.target.value)} />
        </>
      )}
      {err && <div className="error small">{err}</div>}
      <StoryAudience contacts={contacts} />
      <div className="muted small">Story hiển thị trong 24 giờ. (Không mã hoá E2E)</div>
      <div className="modal-actions">
        <button className="link" onClick={onClose}>Huỷ</button>
        <button className="primary" disabled={!canPost || busy} onClick={submit}>{busy ? '...' : 'Đăng'}</button>
      </div>
    </div>
  </div>);
}

function StoryViewer({ view, me, setView, onClose, onDelete, onReply }) {
  const { items, index } = view;
  const s = items[index];
  const getMediaURL = useContext(MediaCtx);
  const [imgUrl, setImgUrl] = useState(null);
  const [viewers, setViewers] = useState(null);
  const [reply, setReply] = useState('');
  const sendReply = async (e) => {
    e.preventDefault(); if (!reply.trim()) return;
    await onReply(s, reply.trim()); setReply('');
  };
  useEffect(() => {
    setImgUrl(null); setViewers(null); setReply('');
    if (s.kind === 'image' && s.fileId) getMediaURL({ conversationId: 'story' }, { fileId: s.fileId, mime: 'image/jpeg' }).then(setImgUrl).catch(() => {});
    if (s.mine) api.storyViewers(s.id).then(setViewers).catch(() => {});
  }, [s.id]);
  const go = (d) => { const n = index + d; if (n < 0) onClose(); else if (n >= items.length) onClose(); else setView({ items, index: n }); };
  return (<div className="story-overlay" onClick={onClose}>
    <div className="story-stage" onClick={(e) => e.stopPropagation()}>
      <div className="story-progress">{items.map((_, i) => <span key={i} className={i <= index ? 'on' : ''} />)}</div>
      <div className="story-top">
        <Avatar name={s.author.username} src={s.author.avatar} size={34} />
        <div><b>{s.author.displayName || s.author.username}</b><div className="muted small">{fmtAgo(s.createdAt)}</div></div>
        <div style={{ flex: 1 }} />
        {s.mine && <button className="link" title="Xoá" onClick={() => onDelete(s.id)}>🗑</button>}
        <button className="link" onClick={onClose}>✕</button>
      </div>
      <div className="story-view-body" style={s.kind === 'text' ? { background: s.bg || '#0f9f7f' } : null}>
        {s.kind === 'image'
          ? (imgUrl ? <img src={imgUrl} alt="" /> : <div className="muted">đang tải…</div>)
          : <div className="story-text">{s.body}</div>}
        {s.kind === 'image' && s.body && <div className="story-caption">{s.body}</div>}
      </div>
      <div className="story-nav"><button onClick={() => go(-1)}>‹</button><button onClick={() => go(1)}>›</button></div>
      {s.mine && <div className="story-viewers muted small">👁 {viewers ? viewers.length : (s.views || 0)} lượt xem{viewers && viewers.length ? ': ' + viewers.map((v) => v.displayName || v.username).join(', ') : ''}</div>}
      {!s.mine && (
        <form className="story-reply" onSubmit={sendReply}>
          <input placeholder={'Trả lời ' + (s.author.displayName || s.author.username) + '…'} value={reply} onChange={(e) => setReply(e.target.value)} />
          <button className="send-btn" title="Gửi trả lời" disabled={!reply.trim()}><Icon name="send" size={17} /></button>
        </form>
      )}
    </div>
  </div>);
}

const TTL_OPTS = [0, 10, 60, 3600, 86400];
const ttlLabel = (s) => s === 0 ? '' : s < 60 ? s + 's' : s < 3600 ? (s / 60) + 'm' : s < 86400 ? (s / 3600) + 'h' : (s / 86400) + 'd';

function ChatView({ active, meta, me, messages, online, typingUsers, status, reactions, editing, onCancelEdit, reply, onCancelReply, onSend, onSendFile, onSendSticker, onTyping, onRecall, onEdit, onReply, onReact, onForward, onForwardMany, peerUsername, memberOf, pinnedIds, pinnedMsgs, onTogglePin, hiddenHas, onHide, ttl, onChangeTtl, canLoadOlder, onLoadOlder, loadingOlder, onOpenPoll, onSchedule, scheduledCount, onShowScheduled, remindIds, onRemind, onShowGroupInfo, quickReplies, onManageQuick, onPickContact, isStranger, keyInfo, onAckKey, openTasks, onShowTasks, onAssign, unreadAtOpen, onShowSummary, onShowNotes, isPeerBlocked, onToggleBlock, onShowSafety, onCall, groupCall, inGroupCall, onGroupCall, onBack, onSendP2P, onShowGallery, isRequest, onAcceptRequest, onSendLocation, onShowProfile, onStartLive, starredHas, onStar, onThreadSend }) {
  const { nickOf } = useContext(AppCtx);
  const [text, setText] = useState('');
  const [gifOpen, setGifOpen] = useState(false), [videoNote, setVideoNote] = useState(false), [liveAsk, setLiveAsk] = useState(false);
  const [thread, setThread] = useState(null);            // tin gốc của luồng đang mở
  // Chọn nhiều tin: null = tắt; Set id = đang chọn. Đổi hội thoại -> thoát.
  const [sel, setSel] = useState(null);
  const [recallAsk, setRecallAsk] = useState(false);
  useEffect(() => { setSel(null); setRecallAsk(false); }, [active.conversationId]);
  const toggleSel = (m) => { setRecallAsk(false); setSel((cur) => { const n = new Set(cur || []); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; }); };
  const [eventAsk, setEventAsk] = useState(false);
  useEffect(() => { setThread(null); }, [active?.conversationId]);
  const replyCounts = {};
  for (const m of messages) if (m.replyTo && !m.recalled) replyCounts[m.replyTo] = (replyCounts[m.replyTo] || 0) + 1;
  const extras = useExtras();
  const [panel, setPanel] = useState(null);           // 'emoji' | 'sticker' | null
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [mention, setMention] = useState(null);         // gợi ý @mention trong nhóm
  const [quick, setQuick] = useState(null);             // gợi ý tin nhắn nhanh khi gõ "/"
  const endRef = useRef(null); const fileRef = useRef(null); const inputRef = useRef(null); const onceRef = useRef(null); const p2pRef = useRef(null);
  const recRef = useRef(null);                          // { mr, chunks, start, timer }
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, typingUsers]);
  useEffect(() => { if (editing) setText(editing.body); }, [editing]);
  // Bản nháp mỗi hội thoại: chuyển hội thoại không mất chữ đang gõ (lưu trên máy).
  const draftKey = active && !editing ? 'reachat.draft.' + me.username + '.' + active.conversationId : null;
  useEffect(() => { if (draftKey) setText(localStorage.getItem(draftKey) || ''); }, [draftKey]);
  useEffect(() => {
    if (!draftKey) return;
    const t = setTimeout(() => { try {
      const had = localStorage.getItem(draftKey) || '';
      if ((text.trim() ? text : '') === had) return;
      (text.trim() ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey));
      localStorage.setItem(draftKey.replace('reachat.draft.', 'reachat.draftT.'), String(Date.now()));
      window.dispatchEvent(new Event('reachat:draft'));
    } catch {} }, 400);
    return () => clearTimeout(t);
  }, [text, draftKey]);
  useEffect(() => () => { try { recRef.current?.mr?.stop(); clearInterval(recRef.current?.timer); } catch {} }, []);
  const submit = (e) => {
    e.preventDefault();
    const q = quickReplies.find((x) => '/' + x.key === text.trim());   // "/chao" + Enter -> nội dung soạn sẵn
    onSend(q ? q.text : text); setText(''); setPanel(null); setMention(null); setQuick(null);
    if (draftKey) { try { localStorage.removeItem(draftKey); localStorage.setItem(draftKey.replace('reachat.draft.', 'reachat.draftT.'), String(Date.now())); window.dispatchEvent(new Event('reachat:draft')); } catch {} }
  };
  const pickQuick = (x) => { setText(x.text); setQuick(null); requestAnimationFrame(() => inputRef.current?.focus()); };

  // @mention trong nhóm: phát hiện "@tu" ở trước con trỏ -> gợi ý thành viên.
  const onText = (e) => {
    const val = e.target.value; setText(val); onTyping();
    const qm = val.match(/^\/(\S*)$/);                                  // tin nhắn nhanh
    if (qm) {
      const items = quickReplies.filter((x) => x.key.toLowerCase().startsWith(qm[1].toLowerCase())).slice(0, 6);
      setQuick(items.length ? items : null);
    } else setQuick(null);
    if (active.type !== 'group') return;
    const upto = val.slice(0, e.target.selectionStart ?? val.length);
    const mm = upto.match(/@([\p{L}0-9_.]*)$/u);
    if (mm) {
      const q = mm[1].toLowerCase();
      const items = (meta?.members || []).filter((u) => u.username !== me.username &&
        (u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q))).slice(0, 6);
      setMention(items.length ? { items } : null);
    } else setMention(null);
  };
  const pickMention = (u) => {
    const el = inputRef.current; const pos = el?.selectionStart ?? text.length;
    const before = text.slice(0, pos).replace(/@([\p{L}0-9_.]*)$/u, '@' + u.username + ' ');
    const next = before + text.slice(pos);
    setText(next); setMention(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(before.length, before.length); });
  };

  const insertEmoji = (emo) => {
    const el = inputRef.current;
    if (!el) { setText((t) => t + emo); return; }
    const s = el.selectionStart ?? text.length, en = el.selectionEnd ?? text.length;
    const next = text.slice(0, s) + emo + text.slice(en);
    setText(next);
    requestAnimationFrame(() => { el.focus(); const p = s + emo.length; el.setSelectionRange(p, p); });
  };

  // Ghi âm tin nhắn thoại qua MediaRecorder; gửi dưới dạng media E2E (type 'voice').
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(recRef.current?.timer);
        const secs = Math.round((Date.now() - recRef.current.start) / 1000);
        setRecording(false); setRecSecs(0);
        if (recRef.current?.cancelled || !chunks.length) { recRef.current = null; return; }
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const file = new File([blob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
        file.dur = secs;                                 // kèm thời lượng để hiển thị
        recRef.current = null;
        onSendFile(file, 'voice');
      };
      recRef.current = { mr, chunks, start: Date.now(), cancelled: false,
        timer: setInterval(() => setRecSecs((s) => s + 1), 1000) };
      mr.start();
      setRecording(true); setRecSecs(0);
    } catch (e) {
      setRecording(false);
      alert(e?.name === 'NotAllowedError' ? 'Bạn chưa cấp quyền micro.' : 'Không ghi âm được: ' + (e?.message || e?.name || ''));
    }
  };
  const stopRec = (cancelled) => { if (recRef.current) { recRef.current.cancelled = cancelled; try { recRef.current.mr.stop(); } catch {} } };

  let subtitle = '';
  const isChannel = !!meta?.channel, isChannelOwner = isChannel && meta.ownerId === me.id;
  if (isChannel) subtitle = `📢 Kênh công khai · @${meta.channel.handle} · ${meta.channel.subscribers} người theo dõi`;
  else if (active.type === 'group') subtitle = `${meta?.members?.length || 0} thành viên`;
  else {
    subtitle = online.has(peerUsername) ? 'Đang hoạt động' : fmtLastSeen(memberOf(meta, peerUsername)?.lastSeen);
    const pm = memberOf(meta, peerUsername);
    if (pm?.statusText && (!pm.statusUntil || pm.statusUntil > Date.now()))
      subtitle = '💬 ' + pm.statusText + (pm.statusUntil ? ' (đến ' + new Date(pm.statusUntil).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) + ')' : '') + ' · ' + subtitle;
  }
  if (typingUsers.length) subtitle = active.type === 'group' ? `${typingUsers.join(', ')} đang soạn tin…` : 'đang soạn tin…';

  const myMsgs = messages.filter((m) => m.senderId === me.id && !m.recalled && m.type !== 'system');
  const lastMine = myMsgs[myMsgs.length - 1];
  let receipt = '';
  if (lastMine && active.type === 'direct' && !active.isCloud && status) {
    const peerRead = Math.max(0, ...Object.values(status.reads || {}));
    receipt = peerRead >= lastMine.seq ? 'Đã xem' : (status.deliveredSeq || 0) >= lastMine.seq ? 'Đã nhận' : 'Đã gửi';
  }
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  // Gửi nhiều tệp lần lượt (chọn nhiều / kéo-thả vào khung chat)
  const sendMany = async (files) => { for (const f of files) await onSendFile(f); };
  const [dragOver, setDragOver] = useState(false);
  const dropProps = {
    onDragOver: (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true); } },
    onDragLeave: (e) => { if (e.currentTarget === e.target) setDragOver(false); },
    onDrop: (e) => { e.preventDefault(); setDragOver(false); const fs = [...(e.dataTransfer?.files || [])]; if (fs.length && !meta?.left) sendMany(fs); },
  };
  const tasksBtn = (<>
    <button className="icon-btn" title="Ghi chú chung — soạn cùng lúc, mã hóa đầu-cuối" onClick={onShowNotes}><Icon name="notebook" /></button>
    <button className="icon-btn" title="Kho media: ảnh, tệp, link đã gửi" onClick={onShowGallery}><Icon name="image" /></button>
    <button className="icon-btn" title="Tóm tắt hội thoại (chạy trên máy)" onClick={onShowSummary}><Icon name="fileText" /></button>
    <button className="icon-btn" title={'Việc cần làm' + (openTasks ? ` (${openTasks} chưa xong)` : '')} onClick={onShowTasks}>
      <Icon name="listTodo" />{openTasks > 0 && <span className="dot-badge">{openTasks}</span>}
    </button>
  </>);
  const [sumDismissed, setSumDismissed] = useState(null);   // id hội thoại đã ẩn gợi ý tóm tắt

  return (<>
    <header className="pane-head">
      <div className="head-row">
        <button className="icon-btn mobile-back" title="Quay lại" onClick={onBack}>‹</button>
        {active.isCloud ? (
          <div className="head-title">
            <span className="cloud-av sm"><Icon name="notes" size={16} /></span>
            <div><div>Ghi chú riêng</div><div className="muted small">🔐 Mã hóa bằng khóa riêng — server không đọc được</div></div>
          </div>
        ) : (
          <div>
            <div className={active.type === 'direct' ? 'clickable' : ''} title={active.type === 'direct' ? 'Xem hồ sơ' : undefined} onClick={() => active.type === 'direct' && onShowProfile?.(peerUsername)}>{active.type === 'group' ? (isChannel ? '📢 ' : meta?.meeting ? '📹 ' : '👥 ') + (meta?.title || 'Nhóm') : (nickOf?.(peerUsername) ? nickOf(peerUsername) + ' (@' + peerUsername + ')' : '@' + peerUsername)}</div>
            <div className="muted small">{isPeerBlocked ? 'Đã chặn' : subtitle}</div>
          </div>
        )}
        {active.isCloud && <div className="head-actions">{tasksBtn}</div>}
        {isChannel && !meta?.left && (
          <div className="head-actions">
            <button className="icon-btn" title="Thông tin kênh" onClick={onShowGroupInfo}><Icon name="megaphone" /></button>
          </div>
        )}
        {active.type === 'group' && !isChannel && !meta?.left && (
          <div className="head-actions">
            {tasksBtn}
            <button className="icon-btn" title={groupCall ? 'Tham gia cuộc gọi nhóm' : 'Gọi thoại nhóm'} onClick={() => onGroupCall(groupCall ? groupCall.video : false)}><Icon name="phone" /></button>
            <button className="icon-btn" title={groupCall ? 'Tham gia cuộc gọi nhóm' : 'Gọi video nhóm'} onClick={() => onGroupCall(groupCall ? groupCall.video : true)}><Icon name="video" /></button>
            <button className="icon-btn" title="Thành viên & quản lý nhóm" onClick={onShowGroupInfo}><Icon name="users" /></button>
          </div>
        )}
        {active.type === 'direct' && !active.isCloud && (
          <div className="head-actions">
            {tasksBtn}
            <button className="icon-btn" title="Gọi thoại" onClick={() => onCall(false)}><Icon name="phone" /></button>
            <button className="icon-btn" title="Gọi video" onClick={() => onCall(true)}><Icon name="video" /></button>
            <button className={'icon-btn safe' + (keyInfo?.verified ? ' verified' : '') + (keyInfo?.changedAt ? ' warn' : '')}
              title={keyInfo?.verified ? 'Đã xác minh mã an toàn' : keyInfo?.changedAt ? 'Mã an toàn VỪA THAY ĐỔI — hãy đối chiếu lại' : 'Mã an toàn E2E — đối chiếu chống nghe lén'}
              onClick={onShowSafety}><Icon name="shield" /></button>
            <button className={'icon-btn' + (isPeerBlocked ? ' danger on' : '')} title={isPeerBlocked ? 'Bỏ chặn' : 'Chặn người này'} onClick={onToggleBlock}><Icon name="ban" /></button>
          </div>
        )}
      </div>
    </header>
    {groupCall && !inGroupCall && (
      <div className="gcall-banner">
        <span className="gcall-pulse"><Icon name={groupCall.video ? 'video' : 'phone'} size={15} /></span>
        <span><b>Cuộc gọi nhóm đang diễn ra</b> · {groupCall.participants.map((u) => '@' + u).join(', ')}</span>
        <button className="primary" onClick={() => onGroupCall(groupCall.video)}>Tham gia</button>
      </div>
    )}
    {pinnedMsgs.length > 0 && (
      <div className="pinned-bar" title="Tin đã ghim">
        📌 <b>{pinnedMsgs.length} ghim:</b>
        {pinnedMsgs.map((pm) => <span key={pm.id} className="pinned-item clickable" title="Đi tới tin" onClick={() => jumpToMsg(pm.id)}>{msgPreview(pm).slice(0, 44) || '[tin]'}</span>)}
      </div>
    )}
    {keyInfo?.changedAt && (
      <div className="key-banner">
        <span>🔐 <b>Mã an toàn của @{peerUsername} vừa thay đổi</b>{keyInfo.wasVerified ? ' (trước đó ĐÃ xác minh)' : ''}. Có thể họ đổi thiết bị / cài lại — hoặc kênh đang bị can thiệp. Hãy đối chiếu lại trước khi gửi thông tin nhạy cảm.</span>
        <button onClick={onShowSafety}>Đối chiếu</button>
        <button onClick={onAckKey}>Đã hiểu</button>
      </div>
    )}
    {unreadAtOpen >= 8 && sumDismissed !== active.conversationId && (
      <div className="sum-banner">
        <span>📝 Bạn có <b>{unreadAtOpen}</b> tin chưa đọc ở đây.</span>
        <button onClick={onShowSummary}>Xem tóm tắt</button>
        <button className="icon-btn" title="Ẩn" onClick={() => setSumDismissed(active.conversationId)}><Icon name="x" size={14} /></button>
      </div>
    )}
    {peerUsername && memberOf(meta, peerUsername)?.isBot
      ? <div className="bot-banner">🤖 <b>@{peerUsername}</b> là bot (chương trình tự động). Tin nhắn với bot <b>không mã hóa đầu-cuối</b> — máy chủ và chủ bot đọc được.</div>
      : isRequest && !isPeerBlocked ? <div className="request-banner">📨 <span><b>Tin nhắn chờ</b> từ @{peerUsername} — người này chưa có trong danh bạ. Chấp nhận để nhận thông báo; bạn trả lời cũng là chấp nhận.</span>
          <button className="primary" onClick={onAcceptRequest}>Chấp nhận</button><button className="ghost danger" onClick={onToggleBlock}>Chặn</button></div>
      : isStranger && !isPeerBlocked && <StrangerBanner peer={peerUsername} onBlock={onToggleBlock} />}
    <div className={'messages' + (dragOver ? ' drag-over' : '')} {...dropProps}>
      {canLoadOlder && <button className="load-older" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? 'Đang tải từ máy chủ…' : '↑ Tải tin cũ hơn'}</button>}
      {groupAlbums(messages).map((g) => {
        const bubble = (m) => (
          <MessageBubble key={m.id} m={m} mine={m.senderId === me.id}
            senderName={active.type === 'group' && m.senderId !== me.id ? (m.senderUsername || '') : ''}
            replyTo={m.replyTo ? byId[m.replyTo] : null} reactions={reactions[m.id] || []} myUsername={me.username}
            pinned={pinnedIds.includes(m.id)} onTogglePin={onTogglePin} onHide={onHide}
            hasReminder={remindIds.has(m.id)} onRemind={onRemind} onAssign={onAssign}
            onRecall={onRecall} onEdit={onEdit} onReply={onReply} onReact={onReact} onForward={onForward}
            starred={starredHas?.(m.id)} onStar={onStar}
            threadCount={replyCounts[m.id] || 0} onOpenThread={() => setThread(m)}
            selecting={!!sel} selected={!!sel?.has(m.id)} onSelect={toggleSel} />);
        return g.album
          ? <div key={'al-' + g.items[0].id} className={'album-run ' + (g.items[0].senderId === me.id ? 'mine' : 'their') + (g.items.length === 2 ? ' two' : '')}>{g.items.map(bubble)}</div>
          : bubble(g.items[0]);
      })}
      {!!typingUsers.length && <div className="bubble their typing-ind">đang soạn tin…</div>}
      <div ref={endRef} />
    </div>
    {receipt && <div className="receipt muted small">{receipt}</div>}
    {reply && <div className="editing-bar">Trả lời: <i>{msgPreview(reply).slice(0, 60)}</i> <button className="link" onClick={onCancelReply}>hủy</button></div>}
    {editing && <div className="editing-bar">Đang sửa tin nhắn <button className="link" onClick={onCancelEdit}>hủy</button></div>}
    {panel === 'emoji' && (
      <div className="pick-panel">
        {EMOJI_PICKER.map((e) => <span key={e} onClick={() => insertEmoji(e)}>{e}</span>)}
      </div>
    )}
    {panel === 'sticker' && <StickerPanel onPick={(s) => { onSendSticker(s); setPanel(null); }} />}
    {eventAsk && <EventComposeModal onClose={() => setEventAsk(false)} onCreate={(ev) => { setEventAsk(false); onSend(JSON.stringify(ev), 'event'); }} />}
    {thread && <ThreadPanel root={thread} convId={active.conversationId} me={me} live={messages} onClose={() => setThread(null)} onSend={(t) => onThreadSend(thread, t)} />}
    {gifOpen && <GifPicker onClose={() => setGifOpen(false)} onPick={(f) => onSendFile(f, 'image')} />}
    {videoNote && <VideoNoteModal onClose={() => setVideoNote(false)} onSend={(f) => onSendFile(f, 'video')} />}
    {liveAsk && <div className="modal-backdrop" onClick={() => setLiveAsk(false)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>📍 Chia sẻ vị trí trực tiếp</h3>
      <p className="muted small">Vị trí của bạn tự cập nhật trong tin nhắn (mã hóa đầu-cuối) cho tới khi hết thời gian hoặc bạn bấm dừng. Cần thiết bị bật định vị.</p>
      <div className="row-inline center">{[[15, '15 phút'], [60, '1 giờ'], [480, '8 giờ']].map(([m, l]) => <button key={m} className="primary" onClick={() => { setLiveAsk(false); onStartLive(m); }}>{l}</button>)}</div>
      <div className="modal-actions"><button className="link" onClick={() => setLiveAsk(false)}>Hủy</button></div>
    </div></div>}
    {sel && (() => {
      const picked = messages.filter((m) => sel.has(m.id)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const allMine = picked.length > 0 && picked.every((m) => m.senderId === me.id);
      const copy = () => {
        const txt = picked.map((m) => `[${fmtTime(m.createdAt)}] ${m.senderUsername || ''}: ${msgPreview(m)}`).join('\n');
        navigator.clipboard?.writeText(txt); window.dispatchEvent(new CustomEvent('reachat:toast', { detail: `Đã sao chép ${picked.length} tin` }));
      };
      return (<div className="select-bar">
        <b>Đã chọn {picked.length}</b>
        <button className="ghost mini" disabled={!picked.length} onClick={copy}>📋 Sao chép</button>
        <button className="ghost mini" disabled={!picked.length} onClick={() => { onForwardMany(picked); setSel(null); }}>↪ Chuyển tiếp</button>
        <button className="ghost mini" disabled={!picked.length} onClick={() => { picked.forEach((m) => onHide(m.id)); setSel(null); }}>🙈 Xóa phía tôi</button>
        {allMine && <button className="ghost mini danger" onClick={() => { if (!recallAsk) return setRecallAsk(true); picked.forEach((m) => onRecall(m.id)); setSel(null); }}>
          {recallAsk ? 'Bấm lần nữa để thu hồi' : '🗑 Thu hồi'}</button>}
        <span className="grow" />
        <button className="link" onClick={() => setSel(null)}>Hủy</button>
      </div>);
    })()}
    {isChannel && !meta?.left && <div className="bot-banner">📢 Kênh công khai — nội dung <b>không mã hóa đầu-cuối</b> (ai theo dõi cũng đọc được).</div>}
    {meta?.left ? (
      <div className="left-banner">{isChannel ? 'Bạn đã bỏ theo dõi kênh này.' : 'Bạn không còn là thành viên của nhóm này — không gửi được tin mới.'}</div>
    ) : isChannel && !isChannelOwner ? (
      <div className="left-banner">📢 Bạn đang theo dõi kênh — chỉ chủ kênh đăng bài. Thả cảm xúc để tương tác.</div>
    ) : meta?.adminOnly && !isChannel && meta.ownerId !== me.id && !(meta.deputies || []).includes(me.username) ? (
      <div className="left-banner">📣 Chỉ trưởng nhóm và phó nhóm được gửi tin trong nhóm này. Thả cảm xúc để tương tác.</div>
    ) : recording ? (
      <div className="composer rec-bar">
        <button type="button" className="icon-btn" title="Huỷ ghi âm" onClick={() => stopRec(true)}><Icon name="trash" /></button>
        <div className="rec-wave"><span className="rec-dot" /> Đang ghi âm <b>{fmtDur(recSecs)}</b></div>
        <button type="button" className="send-btn" title="Gửi tin thoại" onClick={() => stopRec(false)}><Icon name="send" size={18} /></button>
      </div>
    ) : (
      <form className="composer" onSubmit={submit}>
        {quick && (
          <div className="mention-pop">
            <div className="pop-head"><Icon name="zap" size={13} /> Tin nhắn nhanh <button type="button" className="link" onClick={onManageQuick}>Quản lý</button></div>
            {quick.map((x) => (
              <div key={x.key} className="mention-item" onClick={() => pickQuick(x)}>
                <b className="quick-key">/{x.key}</b> <span className="muted">{x.text}</span>
              </div>
            ))}
          </div>
        )}
        {mention && (
          <div className="mention-pop">
            {mention.items.map((u) => (
              <div key={u.username} className="mention-item" onClick={() => pickMention(u)}>
                <Avatar name={u.username} src={u.avatar} size={24} /> <b>{u.displayName}</b> <span className="muted small">@{u.username}</span>
              </div>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { sendMany([...(e.target.files || [])]); e.target.value = ''; }} />
        <input ref={p2pRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onSendP2P?.(f); e.target.value = ''; }} />
        <input ref={onceRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onSendFile(f, 'image', { once: true }); e.target.value = ''; }} />

        {/* Nút ＋ : gom các thao tác phụ vào một menu có nhãn */}
        <div className="more-wrap">
          <button type="button" className={'icon-btn plus' + (panel === 'more' ? ' open' : '')} title="Thêm"
            onClick={() => setPanel(panel === 'more' ? null : 'more')}><Icon name="plus" size={22} /></button>
          {panel === 'more' && (<>
            <div className="menu-veil" onClick={() => setPanel(null)} />
            <div className="more-menu">
              <button type="button" onClick={() => { setPanel(null); fileRef.current?.click(); }}>
                <span className="mi c-blue"><Icon name="paperclip" size={18} /></span>Ảnh / Tệp</button>
              {onSendP2P && <button type="button" onClick={() => { setPanel(null); p2pRef.current?.click(); }}>
                <span className="mi c-green"><Icon name="send" size={18} /></span>Gửi trực tiếp (P2P)<span className="hint">không lưu máy chủ</span></button>}
              {<button type="button" onClick={() => { setPanel(null); onSendLocation(); }}>
                <span className="mi c-red"><Icon name="pin2" size={18} /></span>Vị trí</button>}
              {onStartLive && <button type="button" onClick={() => { setPanel(null); setLiveAsk(true); }}>
                <span className="mi c-red"><Icon name="pin2" size={18} /></span>Vị trí trực tiếp<span className="hint">15 phút / 1 giờ</span></button>}
              {active.type === 'group' && <button type="button" onClick={() => { setPanel(null); setEventAsk(true); }}>
                <span className="mi c-red"><Icon name="clock" size={18} /></span>Sự kiện / lịch hẹn<span className="hint">mời tham gia + nhắc giờ</span></button>}
              <button type="button" onClick={() => { setPanel(null); setVideoNote(true); }}>
                <span className="mi c-green"><Icon name="video" size={18} /></span>Quay video ngắn<span className="hint">tối đa 60 giây</span></button>
              {extras.gif && <button type="button" onClick={() => { setPanel(null); setGifOpen(true); }}>
                <span className="mi c-green"><Icon name="image" size={18} /></span>GIF</button>}
              <button type="button" onClick={() => { setPanel(null); onceRef.current?.click(); }}>
                <span className="mi c-red"><Icon name="eyeOff" size={18} /></span>Ảnh xem một lần</button>
              <button type="button" onClick={() => setPanel('sticker')}>
                <span className="mi c-pink"><Icon name="sticker" size={18} /></span>Sticker</button>
              <button type="button" onClick={() => { setPanel(null); onOpenPoll(); }}>
                <span className="mi c-green"><Icon name="chart" size={18} /></span>Bình chọn</button>
              <button type="button" onClick={() => { setPanel(null); onPickContact(); }}>
                <span className="mi c-blue"><Icon name="idCard" size={18} /></span>Danh thiếp</button>
              <button type="button" onClick={() => { setPanel(null); onManageQuick(); }}>
                <span className="mi c-amber"><Icon name="zap" size={18} /></span>Tin nhắn nhanh<span className="hint">gõ /</span></button>
              <button type="button" disabled={!text.trim()} title={text.trim() ? '' : 'Nhập nội dung trước'}
                onClick={() => { setPanel(null); onSchedule(text); }}>
                <span className="mi c-amber"><Icon name="clock" size={18} /></span>Hẹn giờ gửi</button>
              {scheduledCount > 0 && (
                <button type="button" onClick={() => { setPanel(null); onShowScheduled(); }}>
                  <span className="mi c-amber"><Icon name="clock" size={18} /></span>Tin đã hẹn<span className="count">{scheduledCount}</span></button>
              )}
              <div className="menu-sep" />
              <div className="menu-label"><span className="mi c-red"><Icon name="timer" size={18} /></span>Tin tự hủy</div>
              <div className="ttl-chips">
                {TTL_OPTS.map((s) => (
                  <button type="button" key={s} className={ttl === s ? 'on' : ''}
                    onClick={() => { onChangeTtl(s); setPanel(null); inputRef.current?.focus(); }}>{s ? ttlLabel(s) : 'Tắt'}</button>
                ))}
              </div>
            </div>
          </>)}
        </div>

        <div className={'input-wrap' + (ttl ? ' ttl' : '')}>
          {ttl > 0 && (
            <button type="button" className="ttl-chip" title="Tắt tin tự hủy" onClick={() => onChangeTtl(0)}>
              <Icon name="timer" size={14} />{ttlLabel(ttl)}<Icon name="x" size={12} />
            </button>
          )}
          <input ref={inputRef} placeholder={ttl ? 'Tin sẽ tự hủy…' : 'Nhập tin nhắn…'} value={text} onChange={onText} autoFocus
            onPaste={(e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length && !meta?.left) { e.preventDefault(); sendMany(fs); } }} />
          <button type="button" className={'icon-btn in' + (panel === 'emoji' ? ' active' : '')} title="Emoji"
            onClick={() => setPanel(panel === 'emoji' ? null : 'emoji')}><Icon name="smile" /></button>
        </div>

        {text.trim()
          ? <button className="send-btn" title={editing ? 'Lưu' : 'Gửi'}>{editing ? '✓' : <Icon name="send" size={18} />}</button>
          : <button type="button" className="icon-btn mic" title="Ghi âm tin nhắn thoại" onClick={startRec}><Icon name="mic" /></button>}
      </form>
    )}
  </>);
}

// Đếm ngược thời gian còn lại của tin tự hủy.
// Bằng chứng tự hủy: thiết bị nào đã xác nhận xóa bản cục bộ (do ứng dụng ReaChat trên máy đó gửi về).
function DestructProof({ id }) {
  const { destructAcks, me } = useContext(AppCtx);
  const acks = destructAcks?.[id] || [];
  if (!acks.length) return <div className="destruct-proof muted small">Server đã xóa nội dung · chờ thiết bị xác nhận…</div>;
  return (<div className="destruct-proof small" title="Mỗi thiết bị chạy ReaChat tự xóa bản lưu trên máy rồi gửi xác nhận. Không ngăn được chụp màn hình hay ứng dụng bị sửa đổi.">
    ✓ Đã xóa trên: {acks.map((a) => (a.username === me ? 'máy của bạn' : '@' + a.username) + (a.devices > 1 ? ` (${a.devices} thiết bị)` : '')).join(', ')}
  </div>);
}

// Tin lịch sử cuộc gọi do server ghi khi cuộc gọi kết thúc (góc nhìn tùy người xem).
function CallLogBubble({ m }) {
  const { me, callBack, gcalls } = useContext(AppCtx);
  const o = callInfo(m);
  if (!o) return null;
  if (o.group) {
    const live = gcalls?.[m.conversationId];
    return (<div className={'call-log ' + (o.by === me ? 'mine' : 'their')}>
      <span className="call-log-ic"><Icon name={o.video ? 'video' : 'phone'} size={16} /></span>
      <div className="call-log-main">
        <b>Cuộc gọi nhóm {o.video ? 'video' : 'thoại'} · @{o.by}</b>
        <span className="muted small">{fmtTime(m.createdAt)} · {o.status === 'answered' ? `${o.peak} người · ${fmtDur(o.duration)}` : 'không ai tham gia'}</span>
      </div>
      <button className="mini" onClick={() => callBack(live ? live.video : o.video)}>{live ? 'Tham gia' : 'Gọi lại'}</button>
    </div>);
  }
  const outgoing = o.by === me;
  const kind = o.video ? 'video' : 'thoại';
  const missedForMe = !outgoing && ['missed', 'cancelled'].includes(o.status);
  const label = o.status === 'answered' ? `Cuộc gọi ${kind} ${outgoing ? 'đi' : 'đến'}`
    : outgoing ? ({ declined: 'Bị từ chối', busy: 'Người nhận đang bận', quiet: 'Người nhận đang yên lặng',
        cancelled: 'Đã hủy', missed: 'Không trả lời' }[o.status] || 'Cuộc gọi đi') + ` · gọi ${kind}`
    : ({ declined: 'Bạn đã từ chối', busy: 'Cuộc gọi nhỡ (bạn đang bận)', quiet: 'Cuộc gọi nhỡ (giờ yên lặng)' }[o.status] || 'Cuộc gọi nhỡ') + ` · ${kind}`;

  return (<div className={'call-log ' + (outgoing ? 'mine' : 'their') + (missedForMe ? ' missed' : '')}>
    <span className="call-log-ic"><Icon name={o.video ? 'video' : 'phone'} size={16} /></span>
    <div className="call-log-main">
      <b>{label}</b>
      <span className="muted small">{fmtTime(m.createdAt)}{o.status === 'answered' ? ' · ' + fmtDur(o.duration) : ''}</span>
    </div>
    <button className="mini" onClick={() => callBack(o.video)}>Gọi lại</button>
  </div>);
}

// Báo cáo vi phạm: tin mã hóa đầu-cuối nên quản trị viên chỉ xem được nội dung nếu người báo cáo gửi kèm.
const REPORT_REASONS = { scam: 'Lừa đảo / chiếm đoạt', harass: 'Quấy rối / đe dọa', spam: 'Spam / quảng cáo', nsfw: 'Nội dung đồi trụy / bạo lực', other: 'Khác' };
function ReportModal({ m, onClose, onDone }) {
  const [reason, setReason] = useState(m.__reason || 'scam');
  const [note, setNote] = useState('');
  const [attach, setAttach] = useState(true);
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const content = (() => {
    if (['text', 'sticker'].includes(m.type)) return m.body;
    try { const o = JSON.parse(m.body); return `[${m.type === 'image' ? 'Ảnh' : m.type === 'voice' ? 'Tin thoại' : 'Tệp'}: ${o.name || 'không tên'}]`; } catch { return msgPreview(m); }
  })();
  const send = async () => {
    setBusy(true); setErr('');
    try { await api.report({ messageId: m.id, reason, note, content: attach ? content : null }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>🚩 Báo cáo tin của @{m.senderUsername}</h3>
      <div className="report-reasons">
        {Object.entries(REPORT_REASONS).map(([k, label]) => (
          <label key={k} className="check-row"><input type="radio" name="rr" checked={reason === k} onChange={() => setReason(k)} /> {label}</label>
        ))}
      </div>
      <textarea rows={2} placeholder="Mô tả thêm (tuỳ chọn)" value={note} onChange={(e) => setNote(e.target.value)} />
      <label className="check-row"><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Gửi kèm nội dung tin này cho quản trị viên</label>
      {attach && <div className="quote-box">{String(content).slice(0, 300)}</div>}
      <div className="muted small">Tin nhắn mã hóa đầu-cuối: quản trị viên <b>chỉ</b> thấy nội dung nếu bạn gửi kèm. Người bị báo cáo không biết ai báo cáo.</div>
      {err && <div className="error small">{err}</div>}
      <div className="modal-actions"><button className="ghost" onClick={onClose}>Huỷ</button><button className="primary" disabled={busy} onClick={send}>{busy ? '…' : 'Gửi báo cáo'}</button></div>
    </div>
  </div>);
}

function ExpireCountdown({ at }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((at - now) / 1000));
  return <span className="expire-badge" title="Tin tự hủy"> · ⏱{left >= 60 ? Math.ceil(left / 60) + 'm' : left + 's'}</span>;
}

function MessageBubble({ m, mine, senderName, replyTo, reactions, myUsername, pinned, onTogglePin, onHide, hasReminder, onRemind, onAssign, onRecall, onEdit, onReply, onReact, onForward, starred, onStar, threadCount, onOpenThread, selecting, selected, onSelect }) {
  const [pick, setPick] = useState(false);
  const { report: openReport, showEdits, nickOf } = useContext(AppCtx);
  const report = (mm, reason) => openReport({ ...mm, __reason: reason });
  // Hook phải gọi TRƯỚC mọi return sớm: tin chuyển sang "đã thu hồi" mà bớt hook -> React lỗi #300, trắng cả app.
  const extras = useExtras();
  const [tr, setTr] = useState(null);                     // null | { ask } | { loading } | { text } | { error }
  if (m.type === 'system') return <div className="sys-msg">{m.body}</div>;   // sự kiện nhóm
  if (m.type === 'call') return <CallLogBubble m={m} />;
  if (m.recalled) return (
    <div className={'bubble ' + (mine ? 'mine' : 'their') + ' recalled'}>
      <i>{(() => { try { const o = JSON.parse(m.body); if (o.onceViewed) return `👁 Ảnh xem một lần — @${o.by} đã xem`; if (o.removedByAdmin) return '🚫 Tin đã bị quản trị viên gỡ do vi phạm'; } catch {}
        return m.expireAt ? '⏱ Tin tự hủy đã biến mất' : 'Tin đã được thu hồi'; })()}</i>
      {m.expireAt ? <DestructProof id={m.id} /> : null}
    </div>
  );

  // Gộp reactions theo emoji.
  const grouped = reactions.reduce((a, r) => ((a[r.emoji] = (a[r.emoji] || []).concat(r.username)), a), {});
  const mentioned = m.type === 'text' && new RegExp('@' + myUsername + '\\b', 'i').test(m.body || '');
  // Cảnh báo lừa đảo cho tin của NGƯỜI KHÁC (phân tích bản giải mã ngay trên máy).
  const warns = !mine && m.type === 'text' ? scanScam(m.body) : [];
  const doTranslate = async () => {
    setTr({ loading: true });
    try { const r = await api.translate(m.body, getLang() === 'en' ? 'en' : 'vi'); setTr({ text: r.same ? null : r.text, same: r.same }); }
    catch (e) { setTr({ error: e.message }); }
  };
  const askTranslate = () => { try { if (localStorage.getItem('reachat.translateOk') === '1') return doTranslate(); } catch {} setTr({ ask: true }); };

  return (
    <div data-mid={m.id} className={'bubble ' + (mine ? 'mine' : 'their') + (pinned ? ' pinned' : '') + (mentioned ? ' mentioned' : '') + (selecting ? ' selecting' : '') + (selected ? ' selected' : '')}
      onClickCapture={selecting ? (e) => { e.preventDefault(); e.stopPropagation(); onSelect(m); } : undefined}>
      {pinned && <span className="pin-mark" title="Đã ghim">📌</span>}
      {senderName && <div className="sender">{nickOf?.(senderName) || '@' + senderName}</div>}
      {replyTo && <div className="quote clickable" title="Đi tới tin gốc" onClick={() => jumpToMsg(replyTo.id)}>{msgPreview(replyTo).slice(0, 80)}</div>}
      <MessageContent m={m} myUsername={myUsername} />
      {warns.length > 0 && (
        <details className="scam-warn">
          <summary>⚠️ Có dấu hiệu lừa đảo: {warns.map((w) => w.label).join(' · ')}</summary>
          <ul>{warns.map((w) => <li key={w.kind}>{w.tip}</li>)}</ul>
          <button className="link small" onClick={() => report(m, 'scam')}>🚩 Báo cáo lừa đảo cho quản trị viên</button>
        </details>
      )}
      {tr && <div className="translate-box">
        {tr.ask ? <><span className="small">🌐 <span>Để dịch, nội dung tin này được gửi tới máy chủ và dịch vụ dịch bên ngoài — đoạn này không còn được mã hóa đầu-cuối.</span></span>
            <span className="row-inline"><button className="mini ok" onClick={() => { try { localStorage.setItem('reachat.translateOk', '1'); } catch {} doTranslate(); }}>Đồng ý, dịch</button><button className="mini" onClick={() => setTr(null)}>Hủy</button></span></>
          : tr.loading ? <span className="muted small">🌐 <span>Đang dịch…</span></span>
          : tr.error ? <span className="error small" data-user-content>{tr.error}</span>
          : tr.same ? <span className="muted small">🌐 <span>Tin đã ở ngôn ngữ của bạn.</span></span>
          : <><span className="muted small">🌐 <span>Bản dịch</span> · <button className="link small" onClick={() => setTr(null)}>Ẩn</button></span><div data-user-content>{tr.text}</div></>}
      </div>}
      <time>{fmtTime(m.createdAt)}{m.enc ? ' · 🔒' : ''}{m.editedAt && m.type !== 'location' ? <> · <span className="edited-link" title="Xem lịch sử sửa" onClick={(e) => { e.stopPropagation(); showEdits?.(m); }}>đã sửa</span></> : ''}{m.expireAt ? <ExpireCountdown at={m.expireAt} /> : null}{hasReminder ? <span className="remind-mark" title="Đã đặt nhắc hẹn"> · 🔔</span> : null}{starred ? <span title="Đã đánh dấu sao"> · ⭐</span> : null}</time>
      {Object.keys(grouped).length > 0 && (
        <div className="reactions">{Object.entries(grouped).map(([e, us]) =>
          <span key={e} className={'react-chip' + (us.includes(myUsername) ? ' mine' : '')} title={us.join(', ')} onClick={() => onReact(m.id, e)}>{e} {us.length}</span>)}</div>
      )}
      <div className="msg-actions">
        <button title="Thả cảm xúc" onClick={() => setPick(!pick)}><Icon name="smile" size={15} /></button>
        <button title="Trả lời" onClick={() => onReply(m)}><Icon name="reply" size={15} /></button>
        {onSelect && <button title="Chọn nhiều tin" onClick={() => onSelect(m)}>☑</button>}
        {onOpenThread && <button title="Trả lời trong luồng" onClick={onOpenThread}>💬</button>}
        <button title="Chuyển tiếp" onClick={() => onForward(m)}><Icon name="forward" size={15} /></button>
        {extras.translate && m.type === 'text' && !mine && <button title="Dịch" onClick={askTranslate}>🌐</button>}
        <button title={pinned ? 'Bỏ ghim' : 'Ghim'} className={pinned ? 'on' : ''} onClick={() => onTogglePin(m)}><Icon name="pin" size={15} /></button>
        {onStar && <button title={starred ? 'Bỏ đánh dấu sao' : 'Đánh dấu sao'} className={starred ? 'on' : ''} onClick={() => onStar(m)}>{starred ? '★' : '☆'}</button>}
        <button title="Nhắc tôi về tin này" className={hasReminder ? 'on' : ''} onClick={() => onRemind(m)}><Icon name="bell" size={15} /></button>
        <button title="Giao việc từ tin này" onClick={() => onAssign(m)}><Icon name="listTodo" size={15} /></button>
        {!mine && <button title="Báo cáo vi phạm" onClick={() => report(m)}><Icon name="flag" size={15} /></button>}
        <span className="sep" />
        <button title="Xóa phía tôi" onClick={() => onHide(m.id)}><Icon name="eyeOff" size={15} /></button>
        {mine && <button title="Sửa" onClick={() => onEdit(m)}><Icon name="pencil" size={15} /></button>}
        {mine && <button title="Thu hồi" className="danger" onClick={() => onRecall(m.id)}><Icon name="trash" size={15} /></button>}
      </div>
      {threadCount > 0 && onOpenThread && <button className="thread-link" onClick={onOpenThread}>💬 {threadCount} <span>trả lời</span> ›</button>}
      {pick && <div className="emoji-pick">{EMOJIS.map((e) => <span key={e} onClick={() => { onReact(m.id, e); setPick(false); }}>{e}</span>)}</div>}
    </div>
  );
}

// Sticker trong kho của máy chủ: tin chỉ mang mã "lib:<mã>" (mã hóa như tin chữ), ảnh tải qua máy chủ + nhớ trên máy.
const stickerUrls = new Map();
function LibSticker({ id, size = 120 }) {
  const [u, setU] = useState(stickerUrls.get(id) || null);
  useEffect(() => {
    if (stickerUrls.has(id)) return;
    let live = true;
    api.gifMedia('lib:' + id).then((b) => { const x = URL.createObjectURL(b); stickerUrls.set(id, x); if (live) setU(x); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  return u ? <img className="lib-sticker" src={u} alt="sticker" width={size} height={size} /> : <div className="lib-sticker ph" style={{ width: size, height: size }} />;
}

// Bảng sticker: sticker biểu tượng có sẵn + các gói sticker của máy chủ.
function StickerPanel({ onPick }) {
  const [packs, setPacks] = useState([]), [tab, setTab] = useState(0);
  useEffect(() => { api.stickerPacks().then(setPacks).catch(() => {}); }, []);
  return (<div className="pick-panel stickers sticker-panel">
    {packs.length > 0 && <div className="sticker-tabs">
      <button type="button" className={tab === 0 ? 'on' : ''} onClick={() => setTab(0)}>😀</button>
      {packs.map((p, i) => <button key={p.pack} type="button" className={tab === i + 1 ? 'on' : ''} onClick={() => setTab(i + 1)} title={p.pack}><LibSticker id={p.items[0].id} size={26} /></button>)}
    </div>}
    <div className="sticker-grid">
      {tab === 0 ? STICKERS.map((e) => <span key={e} onClick={() => onPick(e)}>{e}</span>)
        : packs[tab - 1]?.items.map((s) => <span key={s.id} className="lib" title={s.title} onClick={() => onPick('lib:' + s.id)}><LibSticker id={s.id} size={64} /></span>)}
    </div>
  </div>);
}

// Cấu hình GIF / dịch của máy chủ (tải một lần).
function useExtras() {
  const [x, setX] = useState({});
  useEffect(() => { let live = true; api.extrasConfig().then((c) => live && setX(c || {})); return () => { live = false; }; }, []);
  return x;
}

function EventComposeModal({ onClose, onCreate }) {
  const d0 = new Date(Date.now() + 86400e3); d0.setHours(9, 0, 0, 0);
  const local = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [title, setTitle] = useState(''), [at, setAt] = useState(local(d0)), [place, setPlace] = useState(''), [note, setNote] = useState('');
  const ok = title.trim() && at && new Date(at).getTime() > Date.now();
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>📅 Tạo sự kiện</h3>
      <input autoFocus placeholder="Tên sự kiện (vd. Họp giao ban tuần)" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="row-inline"><span className="small">Thời gian</span><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></div>
      <input placeholder="Địa điểm / link họp (tuỳ chọn)" maxLength={150} value={place} onChange={(e) => setPlace(e.target.value)} />
      <textarea rows={2} placeholder="Ghi chú (tuỳ chọn)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="muted small">Nội dung sự kiện mã hóa đầu-cuối. Người chọn “Tham gia” được nhắc 15 phút trước giờ bắt đầu.</p>
      <div className="modal-actions"><button className="ghost" onClick={onClose}>Hủy</button>
        <button className="primary" disabled={!ok} onClick={() => onCreate({ title: title.trim(), at: new Date(at).getTime(), place: place.trim() || undefined, note: note.trim() || undefined })}>Gửi lời mời</button></div>
    </div>
  </div>);
}

// Gom ảnh gửi liền nhau (cùng người, cách nhau ≤ 2 phút, không phải ảnh xem một lần / trả lời) thành một album.
function groupAlbums(messages) {
  const isAlbumImg = (m) => m.type === 'image' && !m.recalled && !m.replyTo && !String(m.body).includes('"once":true');
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1], prev = last?.items[last.items.length - 1];
    if (prev && isAlbumImg(m) && isAlbumImg(prev) && prev.senderId === m.senderId && (m.createdAt - prev.createdAt) <= 120_000) {
      last.items.push(m); last.album = true;
    } else out.push({ items: [m], album: false });
  }
  return out;
}

// Luồng trả lời: tin gốc + mọi tin trả lời nó (tìm cả trong bộ nhớ đệm, không chỉ phần đang hiển thị) + ô trả lời riêng.
function ThreadPanel({ root, convId, me, live, onClose, onSend }) {
  const [older, setOlder] = useState([]), [text, setText] = useState('');
  const endRef = useRef(null);
  useEffect(() => { db.getMessages(convId, 5000).then((all) => setOlder((all || []).filter((x) => x.replyTo === root.id))); }, [convId, root.id]);
  const byId = new Map([...older, ...live.filter((x) => x.replyTo === root.id)].map((x) => [x.id, x]));
  const replies = [...byId.values()].filter((x) => !x.recalled).sort((a, b) => a.createdAt - b.createdAt);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [replies.length]);
  const submit = (e) => { e.preventDefault(); if (!text.trim()) return; onSend(text); setText(''); };
  return (<aside className="thread-panel">
    <div className="thread-head"><b>💬 Luồng trả lời</b><button className="icon-btn" title="Đóng" onClick={onClose}><Icon name="x" size={16} /></button></div>
    <div className="thread-root"><div className="muted small">@{root.senderUsername} · {fmtTime(root.createdAt)}</div><MessageContent m={root} myUsername={me.username} /></div>
    <div className="thread-list">
      {!replies.length && <div className="muted small">Chưa có trả lời. Trả lời đầu tiên nhé!</div>}
      {replies.map((r) => (<div key={r.id} className={'thread-item' + (r.senderId === me.id ? ' mine' : '')}>
        <div className="muted small">@{r.senderUsername} · {fmtTime(r.createdAt)}</div><MessageContent m={r} myUsername={me.username} /></div>))}
      <div ref={endRef} />
    </div>
    <form className="composer thread-composer" onSubmit={submit}>
      <input placeholder="Trả lời trong luồng…" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <button className="send-btn" title="Gửi"><Icon name="send" size={18} /></button>
    </form>
  </aside>);
}

// Tách text thành đoạn thường + @mention (tô sáng, đậm hơn nếu nhắc tới mình).
function renderWithMentions(text, myUsername) {
  const parts = String(text || '').split(/(@[\p{L}0-9_.]+)/u);
  return parts.map((p, i) => {
    if (p[0] === '@') {
      const name = p.slice(1).toLowerCase();
      const me = name === String(myUsername || '').toLowerCase();
      return <span key={i} className={'mention' + (me ? ' mention-me' : '')}>{p}</span>;
    }
    return p;
  });
}
// Định dạng chữ kiểu Zalo/Telegram: `code`, **đậm**, _nghiêng_, ~gạch~ (tạo phần tử React, không dùng HTML thô).
// _ và ~ phải đứng ở ranh giới từ để không phá tên như @nam_1 hay đường dẫn.
const RICH_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\p{L}0-9_@/])_[^_\n]+_(?![\p{L}0-9_])|(?<![\p{L}0-9~/])~[^~\n]+~(?![\p{L}0-9~]))/u;
// Cuộn tới một tin đang hiển thị và nháy sáng; tin chưa tải (quá cũ) -> báo bằng toast.
function jumpToMsg(id) {
  const el = document.querySelector(`.messages [data-mid="${CSS.escape(String(id))}"]`);
  if (!el) { window.dispatchEvent(new CustomEvent('reachat:toast', { detail: 'Tin gốc chưa tải — bấm “Tải tin cũ hơn” rồi thử lại' })); return false; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
  return true;
}
function renderRich(text, myUsername) {
  return String(text || '').split(RICH_RE).map((p, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{renderWithMentions(p, myUsername)}</Fragment>;
    if (p[0] === '`') return <code key={i} className="inline-code">{p.slice(1, -1)}</code>;
    if (p.startsWith('**')) return <b key={i}>{renderWithMentions(p.slice(2, -2), myUsername)}</b>;
    if (p[0] === '_') return <i key={i}>{renderWithMentions(p.slice(1, -1), myUsername)}</i>;
    return <s key={i}>{renderWithMentions(p.slice(1, -1), myUsername)}</s>;
  });
}

// Nội dung tin: text / sticker / ảnh / tệp / thoại / bình chọn.
function MessageContent({ m, myUsername }) {
  if (m.type === 'sticker') return String(m.body).startsWith('lib:') ? <LibSticker id={m.body.slice(4)} /> : <div className="sticker">{m.body}</div>;
  if (m.type === 'location') {
    let o = {}; try { o = JSON.parse(m.body); } catch {}
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) return <div className="body">📍 [vị trí lỗi]</div>;
    const osm = `https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lng}#map=17/${o.lat}/${o.lng}`;
    const gmap = `https://www.google.com/maps?q=${o.lat},${o.lng}`;
    const liveOn = o.live && !o.ended && o.until > Date.now();
    return (<div className={'loc-card' + (liveOn ? ' live' : '')}>
      <div className="loc-pin"><Icon name="pin2" size={22} /></div>
      <div className="loc-main"><b>📍 {o.label ? <span data-user-content>{o.label}</span> : <span>{o.live ? 'Vị trí trực tiếp' : 'Vị trí'}</span>}</b>
        {o.live && (liveOn
          ? <span className="small live-line">🔴 <span>Đang chia sẻ</span> · <span>cập nhật</span> {fmtTime(o.at || m.createdAt)} · <span>còn</span> {Math.max(1, Math.round((o.until - Date.now()) / 60000))} <span>phút</span>
              {m.senderUsername === myUsername && <button className="link small" onClick={() => window.dispatchEvent(new CustomEvent('reachat:stopLive', { detail: o.live }))}>Dừng</button>}</span>
          : <span className="muted small">⏹ <span>Đã kết thúc chia sẻ</span> · <span>vị trí cuối lúc</span> {fmtTime(o.at || m.createdAt)}</span>)}
        <span className="muted small" data-user-content>{o.lat}, {o.lng}{o.acc ? ` (±${o.acc} m)` : ''}</span>
        <span className="row-inline"><a href={osm} target="_blank" rel="noreferrer">OpenStreetMap</a> · <a href={gmap} target="_blank" rel="noreferrer">Google Maps</a></span></div>
    </div>);
  }
  if (m.type === 'autoreply') {
    let o = {}; try { o = JSON.parse(m.body); } catch {}
    return (<div className="autoreply">
      <div className="muted small">🤖 <span>Tự động trả lời</span>{o.status ? <> · <span data-user-content>{o.status}</span></> : null}</div>
      <div className="body" data-user-content>{o.text || ''}</div>
      <div className="muted small">Tin do máy chủ gửi thay — không mã hóa đầu-cuối</div>
    </div>);
  }
  if (m.type === 'p2pfile') {
    let o = {}; try { o = JSON.parse(m.body); } catch {}
    return <div className="p2p-msg">📦 <span>Đã gửi trực tiếp</span> <b data-user-content>{o.name || 'tệp'}</b> <span className="muted small">· {fmtSize(o.size || 0)} · <span>không lưu trên máy chủ</span></span></div>;
  }
  if (m.type === 'poll') return <PollContent m={m} />;
  if (m.type === 'event') return <EventContent m={m} />;
  if (m.type === 'contact') return <ContactCard m={m} />;
  if (m.type === 'image') {
    let meta = {}; try { meta = JSON.parse(m.body); } catch {}
    return meta.once ? <OnceImage m={m} meta={meta} /> : <ImageContent m={m} />;
  }
  if (m.type === 'voice') {
    let meta = {}; try { meta = JSON.parse(m.body); } catch {}
    return <VoiceContent m={m} meta={meta} />;
  }
  if (m.type === 'file') {
    let meta = {}; try { meta = JSON.parse(m.body); } catch {}
    return <FileContent m={m} meta={meta} />;
  }
  if (m.type === 'video') {
    let meta = {}; try { meta = JSON.parse(m.body); } catch {}
    return <VideoContent m={m} meta={meta} />;
  }
  const url = m.type === 'text' && !m.recalled && linkPreviewOn() ? firstUrl(m.body) : null;
  return (<>
    <div className="body">{renderRich(m.body, myUsername)}</div>
    {url && <LinkPreview url={url} />}
  </>);
}

// Xem trước liên kết: máy chủ tải trang thay app (không lộ IP của bạn cho trang đích), kết quả nhớ trên máy.
// Tắt được trong Cài đặt → Tùy chọn (khi tắt, máy chủ không biết bạn mở link nào).
const linkPreviewOn = () => { try { return localStorage.getItem('reachat.linkPreview') !== '0'; } catch { return true; } };
const firstUrl = (t) => String(t || '').match(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/i)?.[0] || null;
const lpCache = new Map();
function LinkPreview({ url }) {
  const [p, setP] = useState(() => lpCache.get(url));
  useEffect(() => {
    if (lpCache.has(url)) { setP(lpCache.get(url)); return; }
    let live = true;
    api.linkPreview(url).then((r) => { lpCache.set(url, r || null); if (live) setP(r || null); }).catch(() => { lpCache.set(url, null); });
    return () => { live = false; };
  }, [url]);
  if (!p) return null;
  return (<a className="link-card" href={p.url || url} target="_blank" rel="noreferrer">
    {p.image && <img src={p.image} alt="" loading="lazy" />}
    <div className="link-meta">
      <span className="muted small" data-user-content>{p.siteName}</span>
      {p.title && <b data-user-content>{p.title}</b>}
      {p.description && <span className="small" data-user-content>{p.description}</span>}
    </div>
  </a>);
}

// Tin nhắn thoại: tải + giải mã (dùng chung getMediaURL) rồi phát bằng <audio>.
function VoiceContent({ m, meta }) {
  const getMediaURL = useContext(MediaCtx);
  const [url, setUrl] = useState(null); const [err, setErr] = useState(false);
  useEffect(() => {
    let on = true;
    if (meta.fileId) getMediaURL(m, meta).then((u) => on && setUrl(u)).catch(() => on && setErr(true));
    return () => { on = false; };
  }, [meta.fileId]);
  // Chuyển thành chữ ngay trên máy (Whisper). Kết quả nhớ trên máy theo từng tin.
  const extras = useExtras();
  const [stt, setStt] = useState(() => { try { const t = localStorage.getItem('reachat.stt.' + m.id); return t != null ? { text: t } : null; } catch { return null; } });
  const runStt = async () => {
    setStt({ busy: true, pct: 0 });
    try {
      const text = await transcribe(url, (p) => setStt({ busy: true, pct: p.total ? Math.round((p.loaded / p.total) * 100) : 0, file: p.file }));
      try { localStorage.setItem('reachat.stt.' + m.id, text); } catch {}
      setStt({ text });
    } catch (e) { setStt({ error: e.message }); }
  };
  if (err) return <div className="body">[không tải được tin thoại]</div>;
  return (<div className="voice-wrap">
    <div className="voice-msg">
      <span className="voice-ic">🎤</span>
      {url ? <audio controls src={url} /> : <span className="body muted">🔒 đang giải mã…</span>}
      {meta.dur ? <span className="muted small">{fmtDur(meta.dur)}</span> : null}
      {url && extras.stt && !stt && <button type="button" className="link small" title="Nhận dạng ngay trên máy — giọng nói không gửi đi đâu" onClick={runStt}>📝 Chuyển thành chữ</button>}
    </div>
    {stt?.busy && <div className="muted small">📝 {stt.file && stt.pct < 100 ? <><span>Đang tải mô hình nhận dạng (một lần)</span> {stt.pct}%</> : <span>Đang nhận dạng trên máy…</span>}</div>}
    {stt?.text != null && <div className="stt-text" data-user-content>{stt.text || '(không nghe rõ)'}</div>}
    {stt?.error && <div className="error small">Không nhận dạng được: <span data-user-content>{stt.error}</span> <button className="link small" onClick={runStt}>Thử lại</button></div>}
  </div>);
}

// Tin nhắn video ngắn: tải + giải mã như tin thoại rồi phát bằng <video>.
function VideoContent({ m, meta }) {
  const getMediaURL = useContext(MediaCtx);
  const [url, setUrl] = useState(null); const [err, setErr] = useState(false);
  useEffect(() => {
    let on = true;
    if (meta.fileId) getMediaURL(m, meta).then((u) => on && setUrl(u)).catch(() => on && setErr(true));
    return () => { on = false; };
  }, [meta.fileId]);
  if (err) return <div className="body">[không tải được video]</div>;
  return (<div className="video-msg">
    {url ? <video controls playsInline preload="metadata" src={url} /> : <div className="video-ph">🔒 <span>đang giải mã…</span></div>}
    {meta.dur ? <span className="muted small">🎬 {fmtDur(meta.dur)}</span> : null}
  </div>);
}

// Quay video ngắn (tối đa 60 giây) bằng camera, xem lại rồi gửi.
function VideoNoteModal({ onClose, onSend }) {
  const vRef = useRef(null), recRef = useRef(null), streamRef = useRef(null);
  const [state, setState] = useState('init');              // init | ready | rec | done | error
  const [secs, setSecs] = useState(0), [blob, setBlob] = useState(null), [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: true }).then((s) => {
      if (!live) { s.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = s; if (vRef.current) { vRef.current.srcObject = s; vRef.current.muted = true; vRef.current.play().catch(() => {}); }
      setState('ready');
    }).catch((e) => { setErr(e?.name === 'NotAllowedError' ? 'Chưa cấp quyền camera/micro.' : 'Không mở được camera: ' + (e?.message || e?.name)); setState('error'); });
    return () => { live = false; try { recRef.current?.mr?.stop(); } catch {} clearInterval(recRef.current?.timer); streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, []);
  const start = () => {
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    const mr = new MediaRecorder(streamRef.current, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 900_000 });
    const chunks = [], t0 = Date.now();
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => { clearInterval(recRef.current.timer); const b = new Blob(chunks, { type: 'video/webm' }); b.dur = Math.round((Date.now() - t0) / 1000); setBlob(b); setState('done');
      if (vRef.current) { vRef.current.srcObject = null; vRef.current.muted = false; vRef.current.src = URL.createObjectURL(b); vRef.current.controls = true; } };
    recRef.current = { mr, timer: setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); setSecs(s); if (s >= 60) mr.stop(); }, 250) };
    mr.start(500); setState('rec'); setSecs(0);
  };
  const send = () => { const f = new File([blob], 'video-' + Date.now() + '.webm', { type: 'video/webm' }); f.dur = blob.dur; onSend(f); onClose(); };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal video-note" onClick={(e) => e.stopPropagation()}>
      <h3>🎬 Quay video ngắn</h3>
      {state === 'error' ? <div className="error">{err}</div> : <video ref={vRef} playsInline className="vn-view" />}
      <div className="row-inline center">
        {state === 'ready' && <button className="primary" onClick={start}>⏺ Bắt đầu quay</button>}
        {state === 'rec' && <><span className="rec-dot" /> <b>{fmtDur(secs)}</b> <span className="muted small">/ 1:00</span> <button className="primary" onClick={() => recRef.current?.mr.stop()}>⏹ Dừng</button></>}
        {state === 'done' && <><button className="ghost" onClick={() => { setBlob(null); onClose(); }}>Hủy</button><button className="primary" onClick={send}>Gửi video ({fmtDur(blob?.dur || 0)})</button></>}
      </div>
      <div className="modal-actions"><button className="link" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Chọn GIF: kho tự quản của máy chủ (+ Klipy/Giphy nếu bật). Chọn xong: tải về rồi gửi như ẢNH (mã hóa đầu-cuối).
function GifPicker({ onClose, onPick }) {
  const [q, setQ] = useState(''), [items, setItems] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(null);
  const [thumbs, setThumbs] = useState({});
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => { api.gifSearch(q).then((r) => { if (live) { setItems(r.items); setErr(''); } }).catch((e) => live && setErr(e.message)); }, q ? 400 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  // Ảnh xem trước tải qua máy chủ (CSP của app chặn tải thẳng từ bên thứ ba).
  useEffect(() => {
    let live = true;
    (items || []).forEach((it) => { if (thumbs[it.id]) return;
      api.gifMedia(it.preview).then((b) => live && setThumbs((m) => ({ ...m, [it.id]: URL.createObjectURL(b) }))).catch(() => {}); });
    return () => { live = false; };
  }, [items]);
  const pick = async (it) => {
    setBusy(it.id);
    try { const b = await api.gifMedia(it.url, true); onPick(new File([b], 'gif-' + it.id + '.gif', { type: b.type || 'image/gif' })); onClose(); }
    catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal gif-picker" onClick={(e) => e.stopPropagation()}>
      <h3>GIF</h3>
      <input autoFocus placeholder="Tìm GIF (vd. chúc mừng, cảm ơn, haha)…" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <div className="error small">{err}</div>}
      <div className="gif-grid">
        {!items ? <div className="muted small">Đang tải…</div> : !items.length ? <div className="muted small">Không có kết quả.</div>
          : items.map((it) => <button key={it.id} type="button" className="gif-cell" disabled={!!busy} onClick={() => pick(it)} title={it.title}>
            {thumbs[it.id] ? <img src={thumbs[it.id]} alt="" /> : <span className="muted small">…</span>}{busy === it.id && <span className="gif-busy">⏳</span>}</button>)}
      </div>
      <div className="muted small">GIF từ kho của máy chủ (và Klipy/Giphy nếu được bật) · gửi như ảnh, mã hóa đầu-cuối.</div>
      <div className="modal-actions"><button className="link" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Nhập vị trí tay: dán link Google Maps / OpenStreetMap / Apple Maps, hoặc gõ "vĩ độ, kinh độ".
function parseLocation(text) {
  const t = String(text || '');
  const pats = [/@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /[?&](?:q|ll|query|center)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
    /mlat=(-?\d{1,2}\.\d+)&mlon=(-?\d{1,3}\.\d+)/, /#map=\d+\/(-?\d{1,2}\.\d+)\/(-?\d{1,3}\.\d+)/, /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/];
  for (const re of pats) { const m = re.exec(t); if (m) { const lat = +m[1], lng = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) }; } }
  return null;
}
function LocationModal({ reason, onClose, onSend }) {
  const [v, setV] = useState(''), [label, setLabel] = useState('');
  const loc = parseLocation(v);
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>📍 Gửi vị trí</h3>
      <div className="muted small">{reason} Dán link Google Maps / OpenStreetMap, hoặc nhập tọa độ dạng <code>21.0285, 105.8520</code>.</div>
      <input autoFocus placeholder="Link bản đồ hoặc vĩ độ, kinh độ" value={v} onChange={(e) => setV(e.target.value)} />
      <input placeholder="Tên địa điểm (tuỳ chọn), vd. Văn phòng công ty" value={label} onChange={(e) => setLabel(e.target.value)} />
      {v && !loc && <div className="error small">Chưa nhận ra tọa độ trong nội dung này.</div>}
      {loc && <div className="ok-msg small">✓ {loc.lat}, {loc.lng}</div>}
      <div className="modal-actions"><button className="ghost" onClick={onClose}>Huỷ</button>
        <button className="primary" disabled={!loc} onClick={() => onSend({ ...loc, ...(label.trim() ? { label: label.trim().slice(0, 100) } : {}) })}>Gửi vị trí</button></div>
    </div>
  </div>);
}

// Kho media của hội thoại: ảnh (lưới), tệp (danh sách), link (danh sách). Đọc từ cache trên máy (đã giải mã).
const LINK_RE = /https?:\/\/[^\s<>"')\]]+/gi;
function GalleryModal({ convId, onClose }) {
  const [tab, setTab] = useState('image');
  const [items, setItems] = useState(null);
  const [view, setView] = useState(null);                   // ảnh đang xem lớn (url)
  useEffect(() => { setItems(null); window.reachat.db.mediaOf(convId, tab).then(setItems).catch(() => setItems([])); }, [convId, tab]);
  const meta = (m) => { try { return JSON.parse(m.body); } catch { return {}; } };
  const links = tab === 'link' && items ? items.flatMap((m) => [...new Set(String(m.body).match(LINK_RE) || [])].map((u) => ({ u, m }))) : [];
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal gallery-modal" onClick={(e) => e.stopPropagation()}>
      <h3>🗂 Kho media</h3>
      <div className="tabs">
        {[['image', 'Ảnh'], ['file', 'Tệp'], ['link', 'Link']].map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {!items ? <div className="muted">Đang tải…</div> : (tab === 'link' ? links.length : items.length) === 0 ? <div className="muted small">Chưa có gì trong hội thoại này.</div> : (
        tab === 'image' ? <div className="gallery-grid">{items.map((m) => <GalleryThumb key={m.id} m={m} onOpen={setView} />)}</div>
        : tab === 'file' ? <ul className="gallery-list">{items.map((m) => (
            <li key={m.id}>{m.type === 'p2pfile' ? <MessageContent m={m} /> : m.type === 'voice' ? <VoiceContent m={m} /> : <FileContent m={m} meta={meta(m)} />}
              <span className="muted small">@{m.senderUsername} · {new Date(m.createdAt).toLocaleString('vi-VN')}</span></li>))}</ul>
        : <ul className="gallery-list">{links.map(({ u, m }, i) => (
            <li key={m.id + i}><a href={u} target="_blank" rel="noreferrer" data-user-content>{u}</a>
              <span className="muted small">@{m.senderUsername} · {new Date(m.createdAt).toLocaleString('vi-VN')}</span></li>))}</ul>
      )}
      <div className="modal-actions"><button className="ghost" onClick={onClose}>Đóng</button></div>
    </div>
    {view && <div className="lightbox" onClick={(e) => { e.stopPropagation(); setView(null); }}><img src={view} alt="" /></div>}
  </div>);
}
function GalleryThumb({ m, onOpen }) {
  const getMediaURL = useContext(MediaCtx);
  const [url, setUrl] = useState(null);
  let meta = {}; try { meta = JSON.parse(m.body); } catch {}
  useEffect(() => { let on = true; if (meta.fileId && !meta.once) getMediaURL(m, meta).then((u) => on && setUrl(u)).catch(() => {}); return () => { on = false; }; }, [m.id]);
  if (meta.once) return <div className="gthumb once"><Icon name="eyeOff" size={20} /></div>;
  return <button className="gthumb" onClick={() => url && onOpen(url)}>{url ? <img src={url} alt="" /> : <span className="muted small">🔒…</span>}</button>;
}

function ImageContent({ m }) {
  const getMediaURL = useContext(MediaCtx);
  const [url, setUrl] = useState(null); const [err, setErr] = useState(false);
  let meta = {}; try { meta = JSON.parse(m.body); } catch {}
  useEffect(() => {
    let on = true;
    if (meta.fileId) getMediaURL(m, meta).then((u) => on && setUrl(u)).catch(() => on && setErr(true));
    return () => { on = false; };
  }, [meta.fileId]);
  if (err) return <div className="body">[không tải được ảnh]</div>;
  return url
    ? <img className="msg-image" src={url} alt={meta.name || ''} />
    : <div className="body muted">{(meta.enc || meta.dr || meta.genc) ? '🔒 đang giải mã ảnh…' : 'đang tải ảnh…'}</div>;
}

// Ảnh xem một lần: không tự tải; bấm để mở toàn màn, đóng lại -> báo server xoá vĩnh viễn.
// Bật/tắt chống chụp màn hình theo số nội dung nhạy cảm đang hiển thị (Windows: ảnh chụp/quay ra khung đen).
const protectReasons = new Set();
function setProtect(key, on) {
  on ? protectReasons.add(key) : protectReasons.delete(key);
  try { window.reachat?.win?.protect(protectReasons.size > 0); } catch {}
}

function OnceImage({ m, meta }) {
  const getMediaURL = useContext(MediaCtx);
  const { me, onceViewed } = useContext(AppCtx);
  const [url, setUrl] = useState(null); const [busy, setBusy] = useState(false);
  const mine = m.senderUsername === me;
  if (mine) return <div className="once-box mine-once"><Icon name="eyeOff" size={18} /> Ảnh xem một lần · đã gửi</div>;
  const open = async () => {
    setBusy(true);
    try { setUrl(await getMediaURL(m, meta)); } catch { setUrl('error'); } finally { setBusy(false); }
  };
  const close = () => { if (url && url !== 'error') URL.revokeObjectURL(url); setUrl(null); onceViewed(m.id); };
  useEffect(() => { if (!url) return; setProtect('once:' + m.id, true); return () => setProtect('once:' + m.id, false); }, [url, m.id]);
  return (<>
    <button className="once-box" onClick={open} disabled={busy}><Icon name="eyeOff" size={18} /> {busy ? 'Đang giải mã…' : 'Ảnh xem một lần — bấm để xem'}</button>
    {url && (
      <div className="once-overlay" onClick={close} onContextMenu={(e) => e.preventDefault()}>
        {url === 'error' ? <div className="muted">Không mở được ảnh</div>
          : <img src={url} alt="" draggable={false} onContextMenu={(e) => e.preventDefault()} />}
        <div className="once-hint">Ảnh chỉ xem được một lần — bấm bất kỳ đâu để đóng và xoá vĩnh viễn</div>
      </div>
    )}
  </>);
}

function FileContent({ m, meta }) {
  const getMediaURL = useContext(MediaCtx);
  const { downloadBig, downloadSmall } = useContext(AppCtx);
  const download = async () => {
    if (meta.chunked) return downloadBig(m, meta);
    try { await downloadSmall(m, meta); } catch {}
  };
  const kb = meta.size ? fmtSize(meta.size) : '';
  return <div className="file-att" onClick={download}>{(meta.enc || meta.dr || meta.genc) ? '🔒' : '📄'} <span>{meta.name || (meta.x ? 'tệp mã hóa (chưa có khóa)' : 'tệp')}</span> <span className="muted small">{kb}</span></div>;
}

// Bình chọn: hiển thị câu hỏi + phương án với thanh kết quả, bấm để bầu/bỏ bầu.
// Sự kiện / lịch hẹn: thời gian, địa điểm, ghi chú + trả lời Tham gia / Có thể / Không.
function EventContent({ m }) {
  const { rsvps, onRsvp, requestRsvp, myUsername } = useContext(PollCtx);
  let ev = {}; try { ev = JSON.parse(m.body); } catch {}
  useEffect(() => { requestRsvp(m.id); }, [m.id]);
  if (!ev.title) return <div className="body">📅 [sự kiện lỗi]</div>;
  const t = rsvps[m.id] || { yes: [], maybe: [], no: [] };
  const mine = ['yes', 'maybe', 'no'].find((k) => t[k].includes(myUsername));
  const when = ev.at ? new Date(ev.at) : null, past = when && when.getTime() < Date.now();
  const L = { yes: 'Tham gia', maybe: 'Có thể', no: 'Không' };
  return (<div className={'event-card' + (past ? ' past' : '')}>
    <div className="ev-date">{when ? <><b>{when.getDate()}</b><span>Th{when.getMonth() + 1}</span></> : '📅'}</div>
    <div className="ev-main">
      <b data-user-content>{ev.title}</b>
      {when && <span className="small">🕒 {when.toLocaleString('vi-VN', { weekday: 'long', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' })}{past ? ' · đã diễn ra' : ''}</span>}
      {ev.place && <span className="small">📍 <span data-user-content>{ev.place}</span></span>}
      {ev.note && <span className="small muted" data-user-content>{ev.note}</span>}
      <div className="ev-rsvp">{['yes', 'maybe', 'no'].map((k) => (
        <button key={k} type="button" className={mine === k ? 'on' : ''} title={t[k].map((u) => '@' + u).join(', ')} onClick={() => onRsvp(m, mine === k ? null : k, ev)}>
          {L[k]} {t[k].length ? '· ' + t[k].length : ''}</button>))}</div>
      {mine === 'yes' && !past && <span className="muted small">🔔 Sẽ nhắc bạn 15 phút trước</span>}
    </div>
  </div>);
}

function PollContent({ m }) {
  const { tallies, onVote, requestPoll, myUsername } = useContext(PollCtx);
  let poll = { q: '', opts: [] }; try { poll = JSON.parse(m.body); } catch {}
  useEffect(() => { requestPoll(m.id); }, [m.id]);
  const tally = tallies[m.id] || poll.opts.map(() => []);
  const total = tally.reduce((a, v) => a + v.length, 0);
  return (
    <div className="poll">
      <div className="poll-q">📊 {poll.q}</div>
      {poll.opts.map((opt, i) => {
        const voters = tally[i] || [];
        const mine = voters.includes(myUsername);
        const pct = total ? Math.round((voters.length / total) * 100) : 0;
        return (
          <div key={i} className={'poll-opt' + (mine ? ' mine' : '')} onClick={() => onVote(m.id, i)} title={voters.map((v) => '@' + v).join(', ')}>
            <div className="poll-bar" style={{ width: pct + '%' }} />
            <span className="poll-opt-text">{mine ? '✓ ' : ''}{opt}</span>
            <span className="poll-opt-n">{voters.length}</span>
          </div>
        );
      })}
      <div className="muted small">{total} lượt bình chọn · bấm để bầu / bỏ bầu</div>
    </div>
  );
}

function PollComposeModal({ onClose, onCreate }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '']);
  const setOpt = (i, v) => setOpts((a) => a.map((x, j) => (j === i ? v : x)));
  const clean = opts.map((o) => o.trim()).filter(Boolean);
  const canCreate = q.trim() && clean.length >= 2;
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>📊 Tạo bình chọn</h3>
      <input placeholder="Câu hỏi" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {opts.map((o, i) => (
        <input key={i} placeholder={'Phương án ' + (i + 1)} value={o} onChange={(e) => setOpt(i, e.target.value)} />
      ))}
      <button className="link" onClick={() => setOpts((a) => [...a, ''])}>＋ Thêm phương án</button>
      <div className="muted small">Bình chọn hiển thị cho mọi người trong hội thoại (không mã hoá E2E).</div>
      <div className="modal-actions">
        <button className="link" onClick={onClose}>Huỷ</button>
        <button className="primary" disabled={!canCreate} onClick={() => onCreate(q.trim(), clean)}>Tạo</button>
      </div>
    </div>
  </div>);
}

// Hẹn giờ + gửi có điều kiện. Nội dung mã hóa NGAY trên máy; server chỉ giữ bản mã tới khi điều kiện thỏa.
const SCHED_MODES = [
  { k: 'time', label: '⏰ Vào lúc', hint: 'Gửi đúng thời điểm đã chọn.' },
  { k: 'online', label: '📶 Khi họ online', hint: 'Gửi ngay khi người nhận mở ReaChat (đang online thì gửi luôn). Chờ tối đa tới hạn bên dưới.', direct: true },
  { k: 'read', label: '👀 Khi họ đã xem', hint: 'Gửi sau khi người nhận xem tin gần nhất của bạn — tránh dồn nhiều tin khi họ chưa đọc.', direct: true },
  { k: 'noreply', label: '↩️ Nếu chưa trả lời', hint: 'Tới giờ đã chọn, chỉ gửi nếu chưa ai trả lời trong hội thoại (nhắc lại nhẹ nhàng). Có trả lời -> tự huỷ.' },
];
function ScheduleModal({ text, isDirect, onClose, onSchedule }) {
  const pad = (n) => String(n).padStart(2, '0');
  const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const [mode, setMode] = useState('time');
  const [when, setWhen] = useState(toLocal(new Date(Date.now() + 3600000)));
  const [fallback, setFallback] = useState(false);
  const modes = SCHED_MODES.filter((m) => isDirect || !m.direct);
  const cur = modes.find((m) => m.k === mode) || modes[0];
  const waiting = mode === 'online' || mode === 'read';
  const submit = (at) => onSchedule(text, at, mode === 'time' ? null : { kind: mode, ...(waiting && fallback ? { fallback: 'send' } : {}) });
  const quick = (ms) => submit(Date.now() + ms);
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>⏰ Hẹn gửi / gửi có điều kiện</h3>
      <div className="muted small">Nội dung: <i>{text.slice(0, 80)}</i></div>
      <div className="sched-modes">
        {modes.map((m) => <button key={m.k} type="button" className={'chip' + (m.k === mode ? ' on' : '')} onClick={() => setMode(m.k)}>{m.label}</button>)}
      </div>
      <div className="muted small">{cur.hint}</div>
      <div className="small">{waiting ? 'Chờ tối đa tới:' : mode === 'noreply' ? 'Kiểm tra lúc:' : 'Gửi lúc:'}</div>
      <div className="quick-row">
        {waiting ? (<>
          <button className="ghost" onClick={() => quick(3 * 3600000)}>3 giờ</button>
          <button className="ghost" onClick={() => quick(86400000)}>1 ngày</button>
          <button className="ghost" onClick={() => quick(7 * 86400000)}>7 ngày</button>
        </>) : (<>
          <button className="ghost" onClick={() => quick(60000)}>1 phút</button>
          <button className="ghost" onClick={() => quick(3600000)}>1 giờ</button>
          <button className="ghost" onClick={() => quick(86400000)}>1 ngày</button>
        </>)}
      </div>
      <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      {waiting && <label className="small check-row"><input type="checkbox" checked={fallback} onChange={(e) => setFallback(e.target.checked)} /> Hết hạn chờ vẫn gửi</label>}
      <div className="modal-actions">
        <button className="link" onClick={onClose}>Huỷ</button>
        <button className="primary" onClick={() => submit(new Date(when).getTime())}>{mode === 'time' ? 'Hẹn gửi' : 'Đặt điều kiện'}</button>
      </div>
    </div>
  </div>);
}

// Đặt nhắc hẹn về một tin: nhanh (10 phút / 1 giờ / 9h sáng mai) hoặc chọn giờ.
function ReminderModal({ m, existing, onClose, onSet, onRemove }) {
  const pad = (n) => String(n).padStart(2, '0');
  const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const [when, setWhen] = useState(toLocal(new Date(Date.now() + 3600000)));
  const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); };
  const at = new Date(when).getTime();
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>🔔 Nhắc tôi về tin này</h3>
      <div className="quote-box">{msgPreview(m).slice(0, 120) || '[tin]'}</div>
      {existing && (
        <div className="fr-row">
          <div className="fr-main muted small">Đang hẹn nhắc lúc <b>{new Date(existing.at).toLocaleString('vi-VN')}</b></div>
          <button className="mini" onClick={onRemove}>Bỏ nhắc</button>
        </div>
      )}
      <div className="quick-row">
        <button className="ghost" onClick={() => onSet(Date.now() + 10 * 60000)}>10 phút</button>
        <button className="ghost" onClick={() => onSet(Date.now() + 3600000)}>1 giờ</button>
        <button className="ghost" onClick={() => onSet(tomorrow9())}>9h sáng mai</button>
      </div>
      <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      <div className="muted small">Nhắc hẹn lưu trên máy này, báo bằng thông báo desktop.</div>
      <div className="modal-actions">
        <button className="link" onClick={onClose}>Huỷ</button>
        <button className="primary" disabled={!(at > Date.now())} onClick={() => onSet(at)}>Đặt nhắc</button>
      </div>
    </div>
  </div>);
}

// Thông tin & quản lý nhóm: đổi tên, danh sách thành viên, thêm, mời ra (trưởng nhóm), rời nhóm.
// ---- Kênh công khai ----
// Phòng họp: tạo phòng (người có link vào thẳng cuộc gọi) hoặc vào bằng mã / link.
function MeetModal({ onClose, onCreate, onJoin }) {
  const [title, setTitle] = useState(''), [code, setCode] = useState('');
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>📹 Phòng họp</h3>
      <form className="new-channel" onSubmit={(e) => { e.preventDefault(); onCreate(title.trim()); }}>
        <b className="small">Tạo phòng mới</b>
        <input placeholder="Tên cuộc họp (tuỳ chọn)" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <button className="primary">Tạo phòng & bắt đầu</button>
        <div className="muted small">Bạn nhận một link <code>reachat://meet/…</code> để gửi cho người khác (hết hạn sau 7 ngày). Tối đa 6 người.</div>
      </form>
      <form className="new-channel" onSubmit={(e) => { e.preventDefault(); if (code.trim()) onJoin(code.trim()); }}>
        <b className="small">Vào phòng bằng mã hoặc link</b>
        <input placeholder="reachat://meet/… hoặc mã phòng" value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="ghost" disabled={!code.trim()}>Vào phòng</button>
      </form>
      <div className="modal-actions"><button className="ghost" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

function ChannelsModal({ results, onClose, onSearch, onCreate, onJoin }) {
  const [tab, setTab] = useState('find');
  const [q, setQ] = useState('');
  const [f, setF] = useState({ title: '', handle: '', description: '' });
  useEffect(() => { const t = setTimeout(() => onSearch(q), 250); return () => clearTimeout(t); }, [q]);
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal channels-modal" onClick={(e) => e.stopPropagation()}>
      <h3>📢 Kênh công khai</h3>
      <div className="tabs">
        <button type="button" className={tab === 'find' ? 'on' : ''} onClick={() => setTab('find')}>Khám phá</button>
        <button type="button" className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>Tạo kênh</button>
      </div>
      {tab === 'find' ? (<>
        <input placeholder="Tìm theo tên hoặc @mã kênh…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <ul className="channel-list">
          {!results ? <li className="muted">Đang tìm…</li> : results.length === 0 ? <li className="muted small">Không có kênh phù hợp.</li>
            : results.map((c) => (
              <li key={c.id}>
                <Avatar name={c.title} size={38} />
                <div className="fr-main"><b data-user-content>{c.title}</b><div className="muted small">@{c.handle} · {c.subscribers} người theo dõi</div>
                  {c.description && <div className="small" data-user-content>{c.description}</div>}</div>
                <button className={c.joined ? 'ghost' : 'primary'} onClick={() => onJoin(c)}>{c.joined ? 'Mở' : 'Theo dõi'}</button>
              </li>))}
        </ul>
      </>) : (<form className="new-channel" onSubmit={(e) => { e.preventDefault(); onCreate({ ...f, handle: f.handle.toLowerCase().replace(/^@/, '') }); }}>
        <input placeholder="Tên kênh" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input placeholder="@mã-kênh (3-30 ký tự a-z, 0-9, _)" value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value })} />
        <textarea rows={2} placeholder="Mô tả (tuỳ chọn)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="muted small">Chỉ bạn đăng bài; ai cũng tìm thấy và theo dõi được. Nội dung kênh <b>công khai, không mã hóa đầu-cuối</b>.</div>
        <button className="primary" disabled={!f.title.trim() || !/^@?[a-z0-9_]{3,30}$/i.test(f.handle)}>Tạo kênh</button>
      </form>)}
      <div className="modal-actions"><button className="ghost" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

function ChannelInfoModal({ meta, me, onClose, onLeave }) {
  const link = 'reachat://c/' + meta.channel.handle;
  const [qr, setQr] = useState('');
  useEffect(() => { QRCode.toDataURL(link, { margin: 1, width: 150 }).then(setQr).catch(() => {}); }, [link]);
  const owner = meta.members?.find((m) => m.id === meta.ownerId);
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>📢 {meta.title}</h3>
      <div className="muted small">@{meta.channel.handle} · {meta.channel.subscribers} người theo dõi · chủ kênh @{owner?.username}</div>
      {meta.channel.description && <p>{meta.channel.description}</p>}
      <div className="invite-row">{qr && <img src={qr} alt="QR kênh" />}
        <div className="invite-main"><code className="invite-link">{link}</code>
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(link)}>Sao chép link kênh</button></div></div>
      <div className="modal-actions">
        {meta.ownerId !== me.id && <button className="link danger-text" onClick={onLeave}>Bỏ theo dõi</button>}
        <button className="primary" onClick={onClose}>Đóng</button>
      </div>
    </div>
  </div>);
}

// Link mời nhóm (trưởng nhóm): tạo / sao chép / QR / thu hồi. Hết hạn sau 7 ngày.
function InviteSection({ invite, onInvite }) {
  const [qr, setQr] = useState('');
  useEffect(() => { onInvite('get'); }, []);
  const link = invite?.code ? 'reachat://join/' + invite.code : '';
  useEffect(() => { if (link) QRCode.toDataURL(link, { margin: 1, width: 150 }).then(setQr).catch(() => {}); else setQr(''); }, [link]);
  return (<div className="invite-section">
    <b className="small">🔗 Link mời vào nhóm</b>
    {link ? (<div className="invite-row">
      {qr && <img src={qr} alt="QR link mời" />}
      <div className="invite-main">
        <code className="invite-link">{link}</code>
        <div className="muted small">Hết hạn {new Date(invite.expiresAt).toLocaleString('vi-VN')}. Ai có link (hoặc quét QR) đều vào được nhóm.</div>
        <div className="row-inline">
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(link)}>Sao chép</button>
          <button className="ghost" onClick={() => onInvite('create')}>Tạo link mới</button>
          <button className="link danger-text" onClick={() => onInvite('revoke')}>Thu hồi</button>
        </div>
      </div>
    </div>) : <button className="ghost" onClick={() => onInvite('create')}>Tạo link mời</button>}
  </div>);
}

// Xem trước nhóm trước khi tham gia bằng link mời.
function InviteJoinModal({ p, onClose, onJoin, onOpen, onEnterMeeting }) {
  if (p.valid && p.meeting) return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal call-incoming" onClick={(e) => e.stopPropagation()}>
      <div className="call-av"><span className="meet-av"><Icon name="video" size={30} /></span></div>
      <h3>{p.title}</h3>
      <div className="muted">📹 Phòng họp của @{p.by} · {p.inCall ? p.inCall + ' người đang trong cuộc gọi' : 'chưa ai vào'}</div>
      <div className="muted small">Cuộc gọi mã hóa DTLS-SRTP, tín hiệu niêm phong bằng khóa danh tính; chat của phòng mã hóa đầu-cuối.</div>
      <div className="modal-actions" style={{ justifyContent: 'center' }}>
        <button className="ghost" onClick={onClose}>Để sau</button>
        <button className="primary" onClick={p.already ? onEnterMeeting : onJoin}>Vào phòng họp</button>
      </div>
    </div>
  </div>);
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal call-incoming" onClick={(e) => e.stopPropagation()}>
      {!p.valid ? (<><h3>Link mời không hợp lệ</h3><div className="muted">Link đã hết hạn hoặc đã bị thu hồi.</div>
        <div className="modal-actions" style={{ justifyContent: 'center' }}><button className="primary" onClick={onClose}>Đóng</button></div></>) : (<>
        <div className="call-av"><Avatar name={p.title} size={64} /></div>
        <h3>{p.title}</h3>
        <div className="muted">{p.memberCount} thành viên · link của @{p.by}</div>
        <div className="muted small">Tin nhắn nhóm mã hóa đầu-cuối — sau khi vào, trưởng nhóm sẽ chia khóa để bạn đọc được.</div>
        <div className="modal-actions" style={{ justifyContent: 'center' }}>
          <button className="ghost" onClick={onClose}>Để sau</button>
          {p.already ? <button className="primary" onClick={onOpen}>Mở nhóm</button> : <button className="primary" onClick={onJoin}>Tham gia nhóm</button>}
        </div>
      </>)}
    </div>
  </div>);
}

// Thu nhỏ ảnh về hình vuông size px (dataURL JPEG nhẹ) — dùng cho ảnh đại diện / ảnh nhóm.
const squareImage = (file, size = 128) => new Promise((resolve, reject) => {
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const r = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - r) / 2, (img.height - r) / 2, r, r, 0, 0, size, size);
    URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.82));
  };
  img.onerror = reject; img.src = url;
});

// Quản lý nhóm: tên, ảnh nhóm, thành viên (trưởng/phó nhóm), duyệt thành viên mới, chỉ quản trị viên nhắn, link mời.
function GroupInfoModal({ meta, me, online, onClose, onRename, onAdd, onKick, onLeave, invite, onInvite, onRole, onTransfer, onAvatar, onSettings, onApprove, onShowProfile }) {
  const [title, setTitle] = useState(meta.title || '');
  const [add, setAdd] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [menu, setMenu] = useState(null), [confirmTransfer, setConfirmTransfer] = useState(null);
  const isOwner = meta.ownerId === me.id;
  const deputies = new Set(meta.deputies || []);
  const isAdmin = isOwner || deputies.has(me.username);
  const rank = (m) => (m.id === meta.ownerId ? 2 : deputies.has(m.username) ? 1 : 0);
  const members = [...(meta.members || [])].sort((a, b) => rank(b) - rank(a));
  const pending = meta.pending || [];
  const submitAdd = (e) => {
    e.preventDefault();
    const names = add.split(/[\s,]+/).map((s) => s.replace(/^@+/, '').trim().toLowerCase()).filter(Boolean);
    if (names.length) { onAdd(names); setAdd(''); }
  };
  const pickAvatar = async (e) => { const f = e.target.files?.[0]; if (f) onAvatar(await squareImage(f, 160)); e.target.value = ''; };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal group-info" onClick={(e) => e.stopPropagation()}>
      <h3>👥 Thông tin nhóm</h3>
      <div className="group-head">
        <Avatar name={meta.title} src={meta.avatar} size={64} />
        {isAdmin && <div className="col-actions">
          <label className="ghost mini file-btn">Đổi ảnh nhóm<input type="file" accept="image/*" hidden onChange={pickAvatar} /></label>
          {meta.avatar && <button type="button" className="link small" onClick={() => onAvatar(null)}>Xóa ảnh</button>}
        </div>}
      </div>
      <div className="quick-row">
        <input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tên nhóm" />
        <button className="ghost" disabled={!title.trim() || title.trim() === meta.title} onClick={() => onRename(title.trim())}>Đổi tên</button>
      </div>
      <div className="muted small">{members.length} thành viên · 🔐 tin nhóm mã hóa đầu-cuối, khóa được xoay khi có người rời</div>
      {isAdmin && <div className="group-settings">
        <label className="check-row"><input type="checkbox" checked={!!meta.approval} onChange={(e) => onSettings({ approval: e.target.checked })} /> <span>Duyệt thành viên mới (thêm bởi thành viên thường / vào bằng link)</span></label>
        <label className="check-row"><input type="checkbox" checked={!!meta.adminOnly} onChange={(e) => onSettings({ adminOnly: e.target.checked })} /> <span>Chỉ trưởng nhóm và phó nhóm được gửi tin</span></label>
      </div>}
      {!isAdmin && (meta.approval || meta.adminOnly) && <div className="muted small">{meta.approval ? '🛂 Nhóm duyệt thành viên mới. ' : ''}{meta.adminOnly ? '📣 Chỉ trưởng/phó nhóm được gửi tin.' : ''}</div>}
      {isAdmin && pending.length > 0 && <div className="pending-box">
        <b>Chờ duyệt ({pending.length})</b>
        {pending.map((p) => (<div key={p.username} className="fr-row">
          <Avatar name={p.username} src={p.avatar} size={28} />
          <div className="fr-main"><b data-user-content>{p.displayName || p.username}</b>
            <div className="muted small">@{p.username}{p.byUsername && p.byUsername !== p.username ? <> · <span>do</span> @{p.byUsername} <span>thêm</span></> : <> · <span>qua link mời</span></>}</div></div>
          <button className="mini ok" onClick={() => onApprove(p.username, true)}>Duyệt</button>
          <button className="mini" onClick={() => onApprove(p.username, false)}>Từ chối</button>
        </div>))}
      </div>}
      <ul className="member-list">
        {members.map((m) => {
          const r = rank(m), canKick = m.username !== me.username && (isOwner || (isAdmin && r === 0));
          return (<li key={m.username}>
            <span className="clickable" onClick={() => onShowProfile?.(m.username)}><Avatar name={m.username} src={m.avatar} size={32} /></span>
            <div className="fr-main clickable" onClick={() => onShowProfile?.(m.username)}>
              <b>{m.displayName || m.username}{m.username === me.username ? ' (bạn)' : ''}</b>
              <div className="muted small">@{m.username}{online.has(m.username) ? ' · đang hoạt động' : ''}</div>
            </div>
            {r === 2 && <span className="owner-badge">Trưởng nhóm</span>}
            {r === 1 && <span className="owner-badge deputy">Phó nhóm</span>}
            {(isOwner || canKick) && m.username !== me.username && <button className="icon-btn" title="Tùy chọn" onClick={() => setMenu(menu === m.username ? null : m.username)}><Icon name="more" size={16} /></button>}
            {menu === m.username && (<div className="member-menu">
              {isOwner && <button onClick={() => { onRole(m.username, r === 1 ? null : 'deputy'); setMenu(null); }}>{r === 1 ? 'Gỡ quyền phó nhóm' : 'Bổ nhiệm phó nhóm'}</button>}
              {isOwner && (confirmTransfer === m.username
                ? <button className="danger" onClick={() => { onTransfer(m.username); setMenu(null); setConfirmTransfer(null); }}>Xác nhận chuyển quyền trưởng nhóm</button>
                : <button onClick={() => setConfirmTransfer(m.username)}>Chuyển quyền trưởng nhóm</button>)}
              {canKick && <button className="danger" onClick={() => { onKick(m.username); setMenu(null); }}>Mời ra khỏi nhóm</button>}
            </div>)}
          </li>);
        })}
      </ul>
      <form className="quick-row" onSubmit={submitAdd}>
        <input className="grow" value={add} onChange={(e) => setAdd(e.target.value)} placeholder={meta.approval && !isAdmin ? 'Đề xuất thêm thành viên (chờ duyệt): @username, …' : 'Thêm thành viên: @username, …'} />
        <button className="primary" disabled={!add.trim()}>Thêm</button>
      </form>
      {isAdmin && <InviteSection invite={invite} onInvite={onInvite} />}
      <div className="modal-actions">
        {confirmLeave
          ? <button className="danger-btn" onClick={onLeave}>{isOwner ? 'Xác nhận rời nhóm (quyền trưởng nhóm chuyển cho phó nhóm)' : 'Xác nhận rời nhóm'}</button>
          : <button className="link danger-text" onClick={() => setConfirmLeave(true)}>Rời nhóm</button>}
        <button className="primary" onClick={onClose}>Đóng</button>
      </div>
    </div>
  </div>);
}

// Hồ sơ người khác: ảnh bìa, ảnh đại diện, giới thiệu, sinh nhật; nút nhắn tin / kết bạn.
function UserProfileModal({ username, me, onClose, onMessage, onAddFriend }) {
  const [p, setP] = useState(null), [err, setErr] = useState(''), [sent, setSent] = useState(false);
  useEffect(() => { api.getProfile(username).then(setP).catch((e) => setErr(e.message)); }, [username]);
  const bd = p?.birthday ? (p.birthday.startsWith('--') ? p.birthday.slice(2).split('-').reverse().join('/') : p.birthday.split('-').reverse().join('/')) : null;
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal user-profile" onClick={(e) => e.stopPropagation()}>
      {!p ? <div className="muted">{err || 'Đang tải…'}</div> : <>
        <div className="cover" style={p.cover ? { backgroundImage: `url("${p.cover}")` } : undefined} />
        <div className="up-av"><Avatar name={p.username} src={p.avatar} size={84} /></div>
        <h3 data-user-content>{p.displayName || p.username}</h3>
        <div className="muted small">@{p.username}</div>
        {p.bio && <p className="up-bio" data-user-content>{p.bio}</p>}
        {bd && <div className="small">🎂 <span>Sinh nhật</span> <span data-user-content>{bd}</span></div>}
        {p.blocked && <div className="muted small">Không xem được hồ sơ.</div>}
        {p.username !== me.username && !p.blocked && <div className="modal-actions center">
          <button className="primary" onClick={() => { onMessage(p.username); onClose(); }}>Nhắn tin</button>
          {!p.friend && <button className="ghost" disabled={sent} onClick={async () => { try { await onAddFriend(p.username); setSent(true); } catch (e) { setErr(e.message); } }}>{sent ? 'Đã gửi lời mời' : 'Kết bạn'}</button>}
        </div>}
        {err && <div className="error small">{err}</div>}
      </>}
      <div className="modal-actions"><button className="link" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Đặt trạng thái ("Đang họp", "Nghỉ phép đến 5/11") + tự động trả lời khi có người nhắn 1-1.
const STATUS_PRESETS = ['📅 Đang họp', '⛔ Đang bận', '🏖️ Nghỉ phép', '🚗 Đang lái xe', '🤒 Nghỉ ốm', '🏠 Làm việc ở nhà'];
function StatusModal({ cur, onClose, onSaved }) {
  const [text, setText] = useState(cur?.text || '');
  const [dur, setDur] = useState(cur?.until ? 'custom' : 'none');
  const [custom, setCustom] = useState(cur?.until ? new Date(cur.until - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const [ar, setAr] = useState(!!cur?.autoReply), [arText, setArText] = useState(cur?.autoReply || 'Mình đang bận, sẽ trả lời bạn sau nhé.');
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const untilOf = () => {
    const now = Date.now();
    if (dur === '1h') return now + 3600e3;
    if (dur === '4h') return now + 4 * 3600e3;
    if (dur === 'today') { const d = new Date(); d.setHours(23, 59, 0, 0); return d.getTime(); }
    if (dur === 'week') return now + 7 * 86400e3;
    if (dur === 'custom') return custom ? new Date(custom).getTime() : null;
    return null;
  };
  const save = async (clear = false) => {
    setBusy(true); setErr('');
    try { onSaved(await api.setMyStatus(clear ? { text: null } : { text: text.trim(), until: untilOf(), autoReply: ar ? arText.trim() : null })); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>💬 Trạng thái</h3>
      <div className="preset-row">{STATUS_PRESETS.map((p) => <button key={p} type="button" className={'chip' + (text === p ? ' on' : '')} onClick={() => setText(p)}>{p}</button>)}</div>
      <input placeholder="Hoặc tự viết (vd. Nghỉ phép đến 5/11)" maxLength={80} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row-inline"><span className="small">Tự xóa sau</span>
        <select value={dur} onChange={(e) => setDur(e.target.value)}>
          <option value="none">Không tự xóa</option><option value="1h">1 giờ</option><option value="4h">4 giờ</option><option value="today">Hết hôm nay</option><option value="week">1 tuần</option><option value="custom">Chọn thời điểm…</option>
        </select>
        {dur === 'custom' && <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />}</div>
      <label className="check-row"><input type="checkbox" checked={ar} onChange={(e) => setAr(e.target.checked)} /> <span>Tự động trả lời khi có người nhắn riêng</span></label>
      {ar && <><textarea rows={2} maxLength={300} value={arText} onChange={(e) => setArText(e.target.value)} />
        <p className="muted small">Mỗi người chỉ nhận tối đa 1 tin tự động trả lời mỗi 6 giờ. Tin này do máy chủ gửi thay bạn (kể cả khi bạn tắt máy) nên <b>không mã hóa đầu-cuối</b>.</p></>}
      {err && <div className="error small">{err}</div>}
      <div className="modal-actions">
        {cur?.text && <button className="ghost danger" disabled={busy} onClick={() => save(true)}>Xóa trạng thái</button>}
        <button className="ghost" onClick={onClose}>Hủy</button>
        <button className="primary" disabled={busy || !text.trim()} onClick={() => save(false)}>Lưu</button>
      </div>
    </div>
  </div>);
}

// Tin đã đánh dấu sao (đồng bộ giữa các thiết bị).
function StarredModal({ items, titleOf, onOpen, onUnstar, onClose }) {
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>⭐ Tin đã đánh dấu sao</h3>
      {!items.length ? <p className="muted small">Chưa có tin nào. Di chuột vào tin nhắn → ⭐ để đánh dấu.</p> : <ul className="starred-list">
        {items.map((it) => (<li key={it.id} onClick={() => onOpen(it)}>
          <div className="preview" data-user-content>{it.preview}</div>
          <div className="muted small"><span data-user-content>{titleOf(it.convId)}</span>{it.from ? ' · @' + it.from : ''} · {fmtTime(it.at)}
            <button className="link small" onClick={(e) => { e.stopPropagation(); onUnstar(it); }}>Bỏ sao</button></div>
        </li>))}
      </ul>}
      <div className="modal-actions"><button className="primary" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Quản lý nhãn hội thoại (lưu trên máy).
const LABEL_COLORS = ['#e5484d', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#ec4899', '#64748b'];
function LabelsModal({ labels, onChange, onClose }) {
  const [name, setName] = useState(''), [color, setColor] = useState(LABEL_COLORS[0]);
  const add = (e) => { e.preventDefault(); const n = name.trim(); if (!n) return; onChange([...labels, { id: 'l' + Date.now().toString(36), name: n.slice(0, 24), color }]); setName(''); };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>🏷️ Nhãn hội thoại</h3>
      <p className="muted small">Phân loại hội thoại (vd. Gia đình, Công việc, Khách hàng). Gắn nhãn ở menu ⋯ của từng hội thoại. Nhãn lưu trên máy này.</p>
      <ul className="label-list">
        {labels.map((l) => (<li key={l.id}><span className="label-dot" style={{ background: l.color }} /> <span data-user-content>{l.name}</span>
          <button className="icon-btn" title="Xóa nhãn" onClick={() => onChange(labels.filter((x) => x.id !== l.id))}><Icon name="trash" size={15} /></button></li>))}
        {!labels.length && <li className="muted small">Chưa có nhãn.</li>}
      </ul>
      <form className="quick-row" onSubmit={add}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên nhãn mới" maxLength={24} />
        <div className="color-pick">{LABEL_COLORS.map((c) => <span key={c} className={'label-dot big' + (c === color ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} />)}</div>
        <button className="primary" disabled={!name.trim()}>Thêm</button>
      </form>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Xong</button></div>
    </div>
  </div>);
}

// Ghi chú soạn chung realtime (CRDT Yjs). Mỗi cập nhật được mã hóa bằng khóa hội thoại
// trước khi gửi -> server chỉ lưu/chuyển tiếp dữ liệu mờ.
function SharedNotes({ convId, rt, me, keys, subscribe, onClose }) {
  const docRef = useRef(null); const taRef = useRef(null);
  const clientId = useRef(Math.random().toString(36).slice(2)).current;
  const [text, setText] = useState(''); const [status, setStatus] = useState('Đang tải…');
  const [editors, setEditors] = useState({});              // username -> lần sửa gần nhất
  const [, tick] = useState(0);
  useEffect(() => {
    const doc = new Y.Doc(); docRef.current = doc;
    const yt = doc.getText('note');
    const seal = (u8) => { const k = keys()[0]; return k ? crypto.sealBytes(u8, k) : null; };
    let pending = [], timer = null;
    const flush = () => {                                  // gom cập nhật cục bộ 250ms -> 1 gói mã hóa
      timer = null; if (!pending.length) return;
      const data = seal(Y.mergeUpdates(pending)); pending = [];
      if (data) rt.docPush(convId, data, clientId); else setStatus('⚠️ Chưa có khóa mã hóa cho hội thoại này');
    };
    doc.on('update', (u, origin) => { if (origin === 'remote') return; pending.push(u); if (!timer) timer = setTimeout(flush, 250); });
    yt.observe((ev) => {
      const ta = taRef.current;
      let ss = ta?.selectionStart ?? 0, se = ta?.selectionEnd ?? 0;
      const remote = ev.transaction.origin === 'remote';
      if (remote && ta) {                                  // dịch con trỏ theo thay đổi của người khác
        let pos = 0;
        for (const d of ev.delta) {
          if (d.retain) pos += d.retain;
          else if (d.insert) { const l = d.insert.length; if (pos < ss) ss += l; if (pos < se) se += l; pos += l; }
          else if (d.delete) { if (pos < ss) ss -= Math.min(d.delete, ss - pos); if (pos < se) se -= Math.min(d.delete, se - pos); }
        }
      }
      setText(yt.toString());
      if (remote && ta && document.activeElement === ta) requestAnimationFrame(() => ta.setSelectionRange(ss, se));
    });
    const unsub = subscribe(convId, {
      snapshot: (updates) => {
        let bad = 0;
        doc.transact(() => { for (const x of updates) { const p = crypto.openBytes(x.data, keys()); if (p) Y.applyUpdate(doc, p, 'remote'); else bad++; } }, 'remote');
        setText(yt.toString());
        setStatus(bad ? `⚠️ ${bad} cập nhật không giải mã được` : '🔐 Đã đồng bộ · mã hóa đầu-cuối');
        if (updates.length > 80) { const data = seal(Y.encodeStateAsUpdate(doc)); if (data) rt.docCompact(convId, updates[updates.length - 1].id, data); }
      },
      update: (m) => {
        if (m.clientId === clientId) return;               // gói của chính mình
        const p = crypto.openBytes(m.data, keys());
        if (p) { Y.applyUpdate(doc, p, 'remote'); if (m.by !== me) setEditors((e) => ({ ...e, [m.by]: Date.now() })); }
      },
    });
    rt.docPull(convId);
    const t = setInterval(() => tick((x) => x + 1), 3000);
    return () => { clearInterval(t); flush(); unsub(); doc.destroy(); };
  }, [convId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (e) => {                                // diff tối thiểu -> thao tác Y.Text
    const nv = e.target.value; const yt = docRef.current.getText('note'); const ov = yt.toString();
    let s = 0; while (s < ov.length && s < nv.length && ov[s] === nv[s]) s++;
    let eo = ov.length, en = nv.length;
    while (eo > s && en > s && ov[eo - 1] === nv[en - 1]) { eo--; en--; }
    docRef.current.transact(() => { if (eo > s) yt.delete(s, eo - s); if (en > s) yt.insert(s, nv.slice(s, en)); }, 'local');
  };
  const active = Object.entries(editors).filter(([, t]) => Date.now() - t < 8000).map(([u]) => '@' + u);
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal notes-modal" onClick={(e) => e.stopPropagation()}>
      <div className="head-row"><h3>📒 Ghi chú chung</h3><span className="muted small">{status}</span></div>
      <textarea ref={taRef} className="notes-area" value={text} onChange={onChange}
        placeholder="Mọi người trong hội thoại cùng soạn ở đây — biên bản họp, danh sách việc, ý tưởng…" autoFocus />
      <div className="muted small">{active.length ? '✍️ ' + active.join(', ') + ' đang soạn' : 'Thay đổi được đồng bộ tức thì cho mọi người đang mở ghi chú.'}</div>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Mạng LAN: danh sách máy cùng mạng + chat mã hóa đầu-cuối, không cần Internet/server.
function LanPanel({ on, peers, msgs, keySeen, onToggle, onSend, onClose }) {
  const [sel, setSel] = useState(null); const [text, setText] = useState('');
  const endRef = useRef(null);
  const peer = peers.find((p) => p.username === sel) || null;
  const list = (sel && msgs[sel]) || [];
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [list.length, sel]);
  const mismatch = peer && keySeen[peer.username]?.pk && keySeen[peer.username].pk !== peer.publicKey;
  const submit = (e) => { e.preventDefault(); if (!peer || !text.trim()) return; onSend(peer, text.trim()); setText(''); };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal lan-modal" onClick={(e) => e.stopPropagation()}>
      <div className="head-row">
        <h3>📶 Mạng LAN</h3>
        <label className="switch-row"><input type="checkbox" checked={on} onChange={onToggle} /> {on ? 'Đang bật' : 'Đang tắt'}</label>
      </div>
      <div className="muted small">Nhắn tin trực tiếp giữa các máy trong cùng mạng nội bộ khi mất Internet. Mã hóa đầu-cuối bằng khóa danh tính, không qua server.</div>
      <div className="lan-body">
        <ul className="lan-peers">
          {!on && <li className="muted small">Bật để tìm máy xung quanh.</li>}
          {on && !peers.length && <li className="muted small">Đang tìm máy trong mạng…</li>}
          {peers.map((p) => (
            <li key={p.id} className={sel === p.username ? 'on' : ''} onClick={() => setSel(p.username)}>
              <Avatar name={p.username} size={28} />
              <div className="fr-main"><b>{p.displayName || p.username}</b><div className="muted small">@{p.username} · {p.address}</div></div>
            </li>
          ))}
        </ul>
        <div className="lan-chat">
          {!sel ? <div className="muted small lan-empty">Chọn một máy để nhắn tin.</div> : (<>
            {mismatch && <div className="error small">⚠️ Khóa của @{sel} trong LAN KHÁC khóa đã biết — có thể có người mạo danh. Đừng gửi thông tin nhạy cảm.</div>}
            <div className="lan-msgs">
              {list.map((m, i) => (
                <div key={i} className={'bubble ' + (m.mine ? 'mine' : 'their')}>
                  <div className="body">{m.text}</div>
                  <time>{fmtTime(m.at)} · 🔒 LAN{m.failed ? ' · ❌ chưa gửi được' : ''}{m.keyMismatch ? ' · ⚠️ khóa lạ' : ''}</time>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            <form className="lan-compose" onSubmit={submit}>
              <input placeholder={peer ? 'Nhắn @' + sel + ' qua LAN…' : '@' + sel + ' hiện không có trong mạng'} disabled={!peer} value={text} onChange={(e) => setText(e.target.value)} />
              <button className="send-btn" disabled={!peer || !text.trim()}><Icon name="send" size={17} /></button>
            </form>
          </>)}
        </div>
      </div>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Tóm tắt hội thoại chạy TRÊN MÁY (trích xuất), không gửi nội dung đi đâu.
function SummaryModal({ messages, unreadN, me, onClose }) {
  const [scope, setScope] = useState(unreadN > 0 ? 'unread' : 'recent');
  const src = scope === 'unread' ? messages.slice(-unreadN).filter((m) => m.type !== 'call') : messages.filter((m) => m.type !== 'call').slice(-50);
  const s = summarize(src, me);
  const Line = ({ x }) => <li><b>@{x.who}:</b> {x.text}</li>;
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal summary-modal" onClick={(e) => e.stopPropagation()}>
      <h3>📝 Tóm tắt hội thoại</h3>
      <div className="tabs">
        {unreadN > 0 && <button className={scope === 'unread' ? 'on' : ''} onClick={() => setScope('unread')}>{unreadN} tin chưa đọc</button>}
        <button className={scope === 'recent' ? 'on' : ''} onClick={() => setScope('recent')}>50 tin gần nhất</button>
      </div>
      {s.total === 0 ? <div className="muted">Không có nội dung để tóm tắt.</div> : (<div className="summary-body">
        <div className="muted small">{s.total} tin · {s.people.map((p) => '@' + p.name + ' (' + p.count + ')').join(', ')}
          {s.span ? ' · ' + new Date(s.span[0]).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + '–' + new Date(s.span[1]).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : ''}</div>
        {s.keywords.length > 0 && <div className="kw-row">{s.keywords.map((k) => <span key={k} className="kw">{k}</span>)}</div>}
        {s.mentions.length > 0 && <><h4>🔔 Nhắc tới bạn</h4><ul>{s.mentions.map((x, i) => <Line key={i} x={x} />)}</ul></>}
        {s.urgent.length > 0 && <><h4>⚡ Việc gấp / hạn chót</h4><ul>{s.urgent.map((x, i) => <Line key={i} x={x} />)}</ul></>}
        {s.questions.length > 0 && <><h4>❓ Câu hỏi đang chờ trả lời</h4><ul>{s.questions.map((x, i) => <Line key={i} x={x} />)}</ul></>}
        {s.highlights.length > 0 && <><h4>⭐ Ý chính</h4><ul>{s.highlights.map((x, i) => <Line key={i} x={x} />)}</ul></>}
        {s.times.length > 0 && <><h4>🕒 Mốc thời gian được nhắc</h4><ul>{s.times.map((x, i) => <Line key={i} x={x} />)}</ul></>}
        {(s.events.length > 0 || s.polls > 0) && <div className="muted small">{s.polls ? s.polls + ' bình chọn · ' : ''}{s.events.join(' · ')}</div>}
      </div>)}
      <div className="muted small">🔐 Tóm tắt được tạo ngay trên máy bạn — nội dung không rời khỏi thiết bị.</div>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Giao việc từ một tin: tiêu đề (mặc định = nội dung tin), người phụ trách, hạn chót.
function TaskModal({ m, members, me, onClose, onCreate }) {
  const [title, setTitle] = useState(msgPreview(m).slice(0, 200));
  const [assignee, setAssignee] = useState(m.senderUsername && m.senderUsername !== me ? m.senderUsername : me);
  const [due, setDue] = useState('');
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>📋 Giao việc</h3>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Việc cần làm" autoFocus />
      <div className="quick-row">
        <span className="muted small">Người làm</span>
        <select className="grow sel" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          {members.filter((x) => x.username).map((x) => <option key={x.username} value={x.username}>@{x.username}{x.username === me ? ' (bạn)' : ''}</option>)}
        </select>
      </div>
      <div className="quick-row"><span className="muted small">Hạn chót</span><input className="grow" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></div>
      <div className="muted small">🔐 Tiêu đề việc được mã hóa đầu-cuối. Người làm sẽ được tự đặt nhắc hẹn khi đến hạn.</div>
      <div className="modal-actions">
        <button className="link" onClick={onClose}>Huỷ</button>
        <button className="primary" disabled={!title.trim()} onClick={() => onCreate({ messageId: m.id, title: title.trim(), assignee, dueAt: due ? new Date(due).getTime() : null })}>Giao việc</button>
      </div>
    </div>
  </div>);
}

function TasksModal({ items, me, title, onClose, onToggle, onDelete }) {
  const [tab, setTab] = useState('open');
  const list = items.filter((t) => (tab === 'open' ? !t.done : tab === 'mine' ? t.assignee === me && !t.done : t.done));
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal tasks-modal" onClick={(e) => e.stopPropagation()}>
      <h3>📋 Việc cần làm</h3>
      <div className="tabs">
        <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Chưa xong ({items.filter((t) => !t.done).length})</button>
        <button className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>Của tôi</button>
        <button className={tab === 'done' ? 'on' : ''} onClick={() => setTab('done')}>Đã xong</button>
      </div>
      <ul className="member-list">
        {list.map((t) => {
          const overdue = !t.done && t.dueAt && t.dueAt < Date.now();
          return (
            <li key={t.id} className={t.done ? 'task-done' : ''}>
              <input type="checkbox" className="task-check" checked={t.done} onChange={() => onToggle(t.id)} />
              <div className="fr-main">
                <b>{title(t)}</b>
                <div className="muted small">
                  {t.assignee ? '→ @' + t.assignee : 'chưa giao'}
                  {t.dueAt ? <span className={overdue ? 'overdue' : ''}> · hạn {new Date(t.dueAt).toLocaleString('vi-VN')}{overdue ? ' (quá hạn)' : ''}</span> : null}
                  {t.done && t.doneBy ? ' · ✅ @' + t.doneBy : ''} · giao bởi @{t.createdBy}
                </div>
              </div>
              {t.createdBy === me && <button className="icon-btn danger-hover" title="Xoá việc" onClick={() => onDelete(t.id)}><Icon name="trash" size={15} /></button>}
            </li>
          );
        })}
        {!list.length && <li className="muted small">Không có việc nào. Rê chuột vào một tin → biểu tượng 📋 để giao việc.</li>}
      </ul>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

// Giờ yên lặng: khung giờ + người ưu tiên + tự từ chối cuộc gọi.
function QuietModal({ value, contacts, onChange, onClose }) {
  const [q, setQ] = useState({ ...value, priority: [...(value.priority || [])] });
  const togglePri = (u) => setQ((s) => ({ ...s, priority: s.priority.includes(u) ? s.priority.filter((x) => x !== u) : [...s.priority, u] }));
  const nowQuiet = isQuietNow(q);
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>🌙 Giờ yên lặng</h3>
      <label className="switch-row"><input type="checkbox" checked={q.enabled} onChange={(e) => setQ({ ...q, enabled: e.target.checked })} /> Bật giờ yên lặng theo lịch</label>
      <div className="quick-row">
        <span className="muted small">Từ</span><input type="time" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} />
        <span className="muted small">đến</span><input type="time" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} />
      </div>
      <label className="switch-row"><input type="checkbox" checked={q.blockCalls} onChange={(e) => setQ({ ...q, blockCalls: e.target.checked })} /> Tự từ chối cuộc gọi (người gọi được báo bạn đang yên lặng)</label>
      <div className="muted small">Người ưu tiên — vẫn được báo tin & gọi được:</div>
      <ul className="member-list">
        {contacts.map((c) => (
          <li key={c.username} className="clickable" onClick={() => togglePri(c.username)}>
            <input type="checkbox" readOnly checked={q.priority.includes(c.username)} />
            <Avatar name={c.username} src={c.avatar} size={26} />
            <div className="fr-main"><b>{c.displayName || c.username}</b> <span className="muted small">@{c.username}</span></div>
          </li>
        ))}
        {!contacts.length && <li className="muted small">Chưa có bạn bè trong danh bạ.</li>}
      </ul>
      <div className={'small ' + (nowQuiet ? 'ok-box' : 'muted')}>{nowQuiet ? '🌙 Đang trong giờ yên lặng' : q.enabled ? 'Ngoài giờ yên lặng' : 'Đang tắt'}</div>
      <div className="modal-actions">
        <button className="link" onClick={onClose}>Huỷ</button>
        <button className="primary" onClick={() => { onChange(q); onClose(); }}>Lưu</button>
      </div>
    </div>
  </div>);
}

// Người lạ (chưa kết bạn): nhắc cảnh giác với yêu cầu tiền / OTP.
function StrangerBanner({ peer, onBlock }) {
  const { addFriend } = useContext(AppCtx);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="stranger-banner">
      <span>⚠️ <b>@{peer}</b> chưa là bạn bè. Cẩn thận nếu được nhờ chuyển tiền, mua thẻ hoặc gửi mã OTP.</span>
      <button onClick={() => addFriend(peer)}>Kết bạn</button>
      <button className="danger" onClick={onBlock}>Chặn</button>
      <button className="icon-btn" title="Ẩn" onClick={() => setHidden(true)}><Icon name="x" size={14} /></button>
    </div>
  );
}

// Danh thiếp trong tin nhắn: nhắn tin / kết bạn ngay từ thẻ.
function ContactCard({ m }) {
  const { openDirect, addFriend, me } = useContext(AppCtx);
  let c = null; try { c = JSON.parse(m.body); } catch {}
  if (!c?.username) return <div className="body">[danh thiếp lỗi]</div>;
  const self = c.username === me;
  return (
    <div className="contact-card">
      <div className="cc-top">
        <Avatar name={c.username} size={40} />
        <div className="fr-main"><b>{c.displayName || c.username}</b><div className="muted small">@{c.username}</div></div>
      </div>
      <div className="cc-label"><Icon name="idCard" size={13} /> Danh thiếp ReaChat</div>
      {!self && (
        <div className="cc-actions">
          <button onClick={() => openDirect(c.username)}>Nhắn tin</button>
          <button onClick={() => addFriend(c.username)}>Kết bạn</button>
        </div>
      )}
    </div>
  );
}

function ContactPickModal({ contacts, me, onClose, onPick }) {
  const [v, setV] = useState('');
  const list = [{ username: me.username, displayName: me.displayName + ' (bạn)' }, ...contacts]
    .filter((c) => !v || (c.username + ' ' + (c.displayName || '')).toLowerCase().includes(v.toLowerCase()));
  const manual = v.trim().replace(/^@+/, '').toLowerCase();
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>👤 Gửi danh thiếp</h3>
      <input placeholder="Tìm trong danh bạ hoặc nhập @username" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      <ul className="member-list">
        {list.map((c) => (
          <li key={c.username} className="clickable" onClick={() => onPick(c)}>
            <Avatar name={c.username} src={c.avatar} size={30} />
            <div className="fr-main"><b>{c.displayName || c.username}</b><div className="muted small">@{c.username}</div></div>
          </li>
        ))}
        {!list.length && manual && (
          <li className="clickable" onClick={() => onPick({ username: manual, displayName: manual })}>
            <Avatar name={manual} size={30} /><div className="fr-main"><b>Gửi danh thiếp @{manual}</b></div>
          </li>
        )}
      </ul>
      <div className="muted small">Danh thiếp được mã hóa đầu-cuối như tin nhắn thường.</div>
      <div className="modal-actions"><button className="link" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

function QuickRepliesModal({ items, onChange, onClose }) {
  const [key, setKey] = useState(''); const [text, setText] = useState('');
  const k = key.trim().replace(/^\/+/, '').replace(/\s+/g, '').toLowerCase();
  const exists = items.some((x) => x.key === k);
  const add = (e) => { e.preventDefault(); if (!k || !text.trim()) return; onChange([...items.filter((x) => x.key !== k), { key: k, text: text.trim() }]); setKey(''); setText(''); };
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>⚡ Tin nhắn nhanh</h3>
      <div className="muted small">Trong ô soạn tin, gõ <b>/</b> + từ khóa rồi Enter để chèn nội dung.</div>
      <ul className="member-list">
        {items.map((x) => (
          <li key={x.key}>
            <b className="quick-key">/{x.key}</b>
            <div className="fr-main muted small">{x.text}</div>
            <button className="icon-btn danger-hover" title="Xoá" onClick={() => onChange(items.filter((y) => y.key !== x.key))}><Icon name="trash" size={15} /></button>
          </li>
        ))}
        {!items.length && <li className="muted small">Chưa có tin nhắn nhanh.</li>}
      </ul>
      <form className="quick-form" onSubmit={add}>
        <input placeholder="từ khóa (vd: diachi)" value={key} onChange={(e) => setKey(e.target.value)} />
        <input placeholder="Nội dung" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="primary" disabled={!k || !text.trim()}>{exists ? 'Cập nhật' : 'Thêm'}</button>
      </form>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Xong</button></div>
    </div>
  </div>);
}

function ScheduledListModal({ items, onClose, onCancel }) {
  return (<div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3>⏰ Tin đã hẹn / chờ điều kiện ({items.length})</h3>
      {items.length === 0 && <div className="muted small">Chưa có tin nào đang chờ gửi.</div>}
      {items.map((s) => (
        <div className="fr-row" key={s.id}>
          <div className="fr-main"><b>{s.type === 'text' ? '✉️' : '📎'} {s.cond ? ({ online: '📶 Khi họ online', read: '👀 Khi họ đã xem', noreply: '↩️ Nếu chưa trả lời' }[s.cond.kind] || '') + ' · ' : ''}{s.cond && s.cond.kind !== 'noreply' ? 'hạn ' : ''}{new Date(s.sendAt).toLocaleString('vi-VN')}</b>
            <div className="muted small">{s.type === 'text' ? '(đã mã hoá)' : s.type}{s.cond?.fallback === 'send' ? ' · hết hạn vẫn gửi' : ''}</div></div>
          <button className="mini" onClick={() => onCancel(s.id)}>Huỷ gửi</button>
        </div>
      ))}
      <div className="modal-actions"><button className="primary" onClick={onClose}>Đóng</button></div>
    </div>
  </div>);
}

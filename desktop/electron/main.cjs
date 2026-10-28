const { app, BrowserWindow, ipcMain, session, protocol, net, desktopCapturer, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const tls = require('node:tls');
const localdb = require('./localdb.cjs');
const { LanNode } = require('./lan.cjs');
let lan = null;                       // nút LAN (nhắn tin khi không có Internet)

let win = null;

// ---- Chỉ chính trang ứng dụng được gọi IPC ----
// Nếu cửa sổ bị điều hướng sang trang lạ (kéo-thả liên kết, chuyển hướng…), trang đó KHÔNG được dùng các kênh
// IPC (đổi máy chủ, đọc/ghi CSDL cục bộ, tệp…). Kết hợp chặn will-navigate trong createWindow().
const DEV_URL = process.env.ELECTRON_START_URL || null;
// So sánh đường dẫn tệp đã giải mã (+ không phân biệt hoa/thường trên Windows) để khỏi lệch cách mã hóa URL.
const normFile = (u) => { try { const p = decodeURIComponent(new URL(u).pathname); return process.platform === 'win32' ? p.toLowerCase() : p; } catch { return null; } };
const APP_PAGE = normFile(require('node:url').pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href);
const isAppUrl = (u) => {
  u = String(u || '');
  if (DEV_URL) return u.startsWith(new URL(DEV_URL).origin + '/');
  return u.startsWith('file:') && normFile(u) === APP_PAGE;
};
const fromApp = (e) => isAppUrl(e.senderFrame?.url);
for (const m of ['handle', 'on']) {
  const orig = ipcMain[m].bind(ipcMain);
  ipcMain[m] = (channel, fn) => orig(channel, (e, ...a) => {
    if (!fromApp(e)) { console.warn('IPC bị chặn từ', e.senderFrame?.url, channel); if (m === 'on') e.returnValue = null; return m === 'handle' ? Promise.reject(new Error('blocked')) : undefined; }
    return fn(e, ...a);
  });
}

// ---- Cấu hình máy chủ (userData/config.json): địa chỉ + vân tay chứng chỉ được ghim ----
// Ưu tiên biến môi trường REACHAT_SERVER / REACHAT_CERT_FP (dùng khi test/triển khai).
const DEFAULT_SERVER = 'http://localhost:4000';
let cfg = { serverUrl: DEFAULT_SERVER, certFingerprint: '', tray: true };   // tray: đóng cửa sổ = chạy nền
const configFile = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) }; } catch {}
  if (process.env.REACHAT_SERVER) cfg.serverUrl = process.env.REACHAT_SERVER;
  if (process.env.REACHAT_CERT_FP) cfg.certFingerprint = process.env.REACHAT_CERT_FP;
  if (process.env.REACHAT_TRAY === '0') cfg.tray = false;      // test tự động: đóng cửa sổ = thoát
}
function saveConfig() {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2)); } catch {}
}
const normFp = (fp) => String(fp || '').replace(/^sha256\//i, '').replace(/[^0-9a-f]/gi, '').toUpperCase();
const serverHost = () => { try { return new URL(cfg.serverUrl).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } };
const publicConfig = () => {
  const u = cfg.serverUrl.replace(/\/+$/, '');
  const secure = u.startsWith('https:');
  return { serverUrl: u, wsUrl: u.replace(/^http/, 'ws') + '/ws', secure, pinned: secure && !!normFp(cfg.certFingerprint), certFingerprint: cfg.certFingerprint || '' };
};

// CSP theo máy chủ đã cấu hình: chỉ được kết nối tới đúng máy chủ đó (+ dev server khi phát triển).
function cspHeader() {
  const c = publicConfig();
  const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const dev = process.env.ELECTRON_START_URL ? origin(process.env.ELECTRON_START_URL) + ' ' + origin(process.env.ELECTRON_START_URL).replace(/^http/, 'ws') : '';
  return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    `connect-src 'self' blob: ${origin(c.serverUrl)} ${c.wsUrl.replace(/\/ws$/, '')} ${dev}`.trim() + ';';
}
function installCsp() {
  // Bản đóng gói (file://): chặn giao thức file để gắn header CSP cho trang (origin vẫn là file:// -> giữ localStorage cũ).
  const distDir = path.join(__dirname, '..', 'dist');
  protocol.handle('file', async (req) => {
    const res = await net.fetch(req, { bypassCustomProtocolHandlers: true });
    let p = ''; try { p = decodeURIComponent(new URL(req.url).pathname); } catch {}
    if (!/\.html?$/i.test(p) || !path.normalize(p.replace(/^\/(\w:)/, '$1')).toLowerCase().startsWith(path.normalize(distDir).toLowerCase())) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', cspHeader());
    return new Response(res.body, { status: res.status, headers });
  });
  // Dev (vite qua http): gắn header cho tài liệu chính.
  session.defaultSession.webRequest.onHeadersReceived((d, cb) => {
    if (d.resourceType !== 'mainFrame') return cb({});
    cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [cspHeader()] } });
  });
}

// Ghim chứng chỉ: với máy chủ đã cấu hình vân tay -> CHỈ chấp nhận đúng chứng chỉ đó (kể cả tự ký),
// sai vân tay -> từ chối (chống MITM dù có CA "hợp lệ"). Máy chủ khác -> kiểm tra mặc định của Chromium.
function installCertPinning() {
  session.defaultSession.setCertificateVerifyProc((req, cb) => {
    const want = normFp(cfg.certFingerprint);
    if (!want || req.hostname.replace(/^\[|\]$/g, '') !== serverHost()) return cb(-3);
    try {
      const got = normFp(new crypto.X509Certificate(req.certificate.data).fingerprint256);
      cb(got === want ? 0 : -2);
      if (got !== want) console.warn('[tls] SAI vân tay chứng chỉ cho', req.hostname, got);
    } catch { cb(-2); }
  });
}

// Lấy vân tay chứng chỉ máy chủ (để người dùng đối chiếu với vân tay server in ra rồi ghim).
function probeCert(url) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ error: 'Địa chỉ không hợp lệ' }); }
    if (u.protocol !== 'https:') return resolve({ secure: false });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const sock = tls.connect({ host, port: Number(u.port) || 443, servername: /^[\d.:]+$/.test(host) ? undefined : host, rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate();
      resolve({ secure: true, fingerprint: c.fingerprint256, subject: c.subject?.CN, validTo: c.valid_to, trustedByCA: sock.authorized, caError: sock.authorizationError ? String(sock.authorizationError) : null });
      sock.end();
    });
    sock.setTimeout(6000, () => { sock.destroy(); resolve({ error: 'Hết thời gian kết nối' }); });
    sock.on('error', (e) => resolve({ error: e.message }));
  });
}

ipcMain.on('config:get', (e) => { e.returnValue = publicConfig(); });
ipcMain.handle('config:probe', (_e, url) => probeCert(url));
ipcMain.handle('config:set', (_e, next) => {
  const url = String(next?.serverUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/i.test(url)) throw new Error('Địa chỉ máy chủ dạng http(s)://tên-máy:cổng');
  cfg = { ...cfg, serverUrl: url, certFingerprint: String(next?.certFingerprint || '').trim() };
  saveConfig();
  setupUpdater();                                  // nguồn cập nhật đi theo máy chủ
  // Khởi động lại hẳn: Chromium cache kết quả xác minh chứng chỉ + giữ kết nối cũ -> reload là chưa đủ.
  setTimeout(() => { app.relaunch(); app.exit(0); }, 100);
  return publicConfig();
});

// ---- Tự động cập nhật (electron-updater, nguồn "generic" = <máy chủ>/updates) ----
// Bộ cài được kiểm tra SHA-512 theo latest.yml; kênh tải đi qua TLS + ghim chứng chỉ ở trên.
let updater = null, updateTimer = null;
const sendUpdate = (st) => win?.webContents.send('update:status', st);
function setupUpdater() {
  if (!app.isPackaged) return;
  // Chỉ bản CÀI bằng bộ cài NSIS mới tự cập nhật; bản chạy thẳng (win-unpacked/portable) thì bỏ qua
  // để không tự cài thêm một bản khác vào máy.
  if (process.platform === 'win32' && !fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall ' + path.basename(process.execPath, '.exe') + '.exe'))) return;
  // Bộ cài là mã chạy trên máy -> chỉ tải qua HTTPS (máy chủ http:// thì kẻ chen giữa đường truyền có thể đẩy bộ cài giả).
  if (!/^https:\/\//i.test(publicConfig().serverUrl)) { sendUpdate({ state: 'insecure' }); return; }
  try {
    if (!updater) {
      ({ autoUpdater: updater } = require('electron-updater'));
      const logFile = path.join(app.getPath('userData'), 'updater.log');
      const log = (lvl) => (...a) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${lvl} ${a.join(' ')}\n`); } catch {} };
      updater.logger = { info: log('INFO'), warn: log('WARN'), error: log('ERROR'), debug: () => {} };
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
      updater.on('update-available', (i) => sendUpdate({ state: 'available', version: i.version }));
      updater.on('update-not-available', (i) => sendUpdate({ state: 'none', version: i?.version }));
      updater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
      updater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
      updater.on('error', (e) => sendUpdate({ state: 'error', error: String(e?.message || e).slice(0, 200) }));
    }
    updater.setFeedURL({ provider: 'generic', url: publicConfig().serverUrl + '/updates' });
    clearInterval(updateTimer);
    const check = () => updater.checkForUpdates().catch(() => {});
    setTimeout(check, 3000);
    updateTimer = setInterval(check, 4 * 3600 * 1000);
  } catch (e) { console.warn('updater:', e.message); }
}
ipcMain.handle('update:check', () => (updater ? updater.checkForUpdates().then(() => true).catch((e) => { sendUpdate({ state: 'error', error: e.message }); return false; }) : (sendUpdate({ state: 'dev' }), false)));
// Cài im lặng (/S) rồi mở lại app — bộ cài assisted không hiện wizard khi cập nhật.
ipcMain.handle('update:install', () => { if (updater) setImmediate(() => updater.quitAndInstall(true, true)); return !!updater; });
ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });

// Cho phép micro/camera cho cuộc gọi WebRTC (nếu không sẽ bị từ chối mặc định).
// ---- Chia sẻ màn hình: renderer liệt kê nguồn (màn hình/cửa sổ) -> người dùng chọn -> getDisplayMedia dùng nguồn đó.
let chosenScreen = null;
ipcMain.handle('screen:list', async () => (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }))
  .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));
ipcMain.handle('screen:choose', (_e, id) => { chosenScreen = String(id || ''); return true; });

function allowMediaPermissions() {
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const src = srcs.find((s) => s.id === chosenScreen);
    chosenScreen = null;
    if (src) cb({ video: src }); else cb({});                     // chưa chọn nguồn -> từ chối
  });
  // Quyền cho phép: micro/camera (gọi) + thông báo desktop (trước đây thiếu 'notifications' -> app không hiện thông báo).
  const ALLOWED = new Set(['media', 'microphone', 'camera', 'notifications', 'geolocation']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: 'ReaChat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,   // renderer bị cô lập khỏi Node
      nodeIntegration: false,   // không bật Node trong renderer
      sandbox: true,            // preload chỉ dùng contextBridge + ipcRenderer -> chạy được trong sandbox
    },
  });

  // Không cho cửa sổ chính rời trang ứng dụng (liên kết http(s) mở bằng trình duyệt ngoài).
  const guardNav = (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) require('electron').shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guardNav);
  win.webContents.on('will-redirect', guardNav);
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  const devUrl = DEV_URL;
  if (devUrl) {
    // Dev: chuyển LỖI/CẢNH BÁO của renderer ra stdout để dễ chẩn đoán.
    // Electron ≥35: thông tin nằm trong event (level là chuỗi 'warning' | 'error' ...).
    win.webContents.on('console-message', (e) => {
      const { level, message, lineNumber, sourceId } = e;
      if (level === 'warning' || level === 'error') console.log(`[renderer:${level}]`, message, sourceId ? '(' + sourceId + ':' + lineNumber + ')' : '');
    });
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  // Đóng cửa sổ = ẩn xuống khay (vẫn nhận tin/cuộc gọi); thoát hẳn từ menu khay.
  win.on('close', (e) => {
    if (quitting || !cfg.tray) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && tray) { trayHintShown = true; tray.displayBalloon?.({ title: 'ReaChat vẫn đang chạy', content: 'Bạn vẫn nhận được tin nhắn và cuộc gọi. Thoát hẳn: chuột phải biểu tượng ở khay.' }); }
  });
}

// ---- Khay hệ thống ----
let tray = null, quitting = false, trayHintShown = false;
app.on('before-quit', () => { quitting = true; });
const showWin = () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); };
// Biểu tượng 16x16 vẽ bằng mã (hình tròn xanh + chấm đỏ khi có tin chưa đọc) — không cần tệp ảnh.
function trayIcon(unread) {
  const n = 16, buf = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4, dx = x - 7.5, dy = y - 7.5, inCircle = dx * dx + dy * dy <= 56;
    const dot = unread && (x - 12) ** 2 + (y - 3.5) ** 2 <= 10;
    if (dot) { buf[i] = 0x30; buf[i + 1] = 0x30; buf[i + 2] = 0xf2; buf[i + 3] = 255; }          // BGRA đỏ
    else if (inCircle) { buf[i] = 0xf0; buf[i + 1] = 0x6d; buf[i + 2] = 0x2f; buf[i + 3] = 255; } // xanh #2f6df0
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n });
}
function trayMenu() {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: 'Mở ReaChat', click: showWin },
    { type: 'separator' },
    { label: 'Đóng cửa sổ = chạy nền', type: 'checkbox', checked: !!cfg.tray, click: (it) => { cfg.tray = it.checked; saveConfig(); } },
    { label: 'Khởi động cùng Windows', type: 'checkbox', checked: login, enabled: app.isPackaged,
      click: (it) => app.setLoginItemSettings({ openAtLogin: it.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: 'Thoát ReaChat', click: () => { quitting = true; app.quit(); } },
  ]);
}
function setupTray() {
  tray = new Tray(trayIcon(false));
  tray.setToolTip('ReaChat');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWin);
}
ipcMain.handle('win:show', () => { showWin(); return true; });

// ---- Lưu / mở tệp (bản ghi cuộc gọi, tệp sao lưu lịch sử) ----
ipcMain.handle('file:save', async (_e, { name, data, kind }) => {
  const base = kind === 'video' ? app.getPath('videos') : app.getPath('documents');
  let file;
  if (process.env.REACHAT_SAVE_DIR) file = path.join(process.env.REACHAT_SAVE_DIR, path.basename(name));
  else {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(base, path.basename(name)) });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, Buffer.from(data));
  return file;
});
// Ghi tệp tải về theo luồng (tệp rất lớn: không giữ cả tệp trong bộ nhớ renderer).
const sinks = new Map(); let sinkSeq = 0;
ipcMain.handle('file:openWrite', async (_e, name) => {
  let file;
  if (process.env.REACHAT_SAVE_DIR) file = path.join(process.env.REACHAT_SAVE_DIR, path.basename(name));
  else {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.basename(name)) });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  const id = ++sinkSeq;
  sinks.set(id, { fd: fs.openSync(file, 'w'), file });
  return { id, path: file };
});
ipcMain.handle('file:write', (_e, id, data) => { const s = sinks.get(id); if (!s) throw new Error('sink đã đóng'); fs.writeSync(s.fd, Buffer.from(data)); return true; });
ipcMain.handle('file:closeWrite', (_e, id) => { const s = sinks.get(id); if (s) { fs.closeSync(s.fd); sinks.delete(id); } return s?.file || null; });
ipcMain.handle('file:open', async (_e, { filters } = {}) => {
  let file = process.env.REACHAT_OPEN_FILE;
  if (!file) {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }
  return { name: path.basename(file), data: fs.readFileSync(file) };
});
ipcMain.handle('win:badge', (_e, n) => {
  n = Number(n) || 0;
  tray?.setImage(trayIcon(n > 0));
  tray?.setToolTip(n > 0 ? `ReaChat — ${n} tin chưa đọc` : 'ReaChat');
  if (n > 0 && win && !win.isFocused()) win.flashFrame(true);
  return true;
});
// Chống chụp màn hình (Windows: cửa sổ hiện đen trong ảnh chụp/ghi hình) — bật khi xem nội dung nhạy cảm.
ipcMain.handle('win:protect', (_e, on) => { win?.setContentProtection(!!on); return true; });

// ---- IPC: renderer <-> local SQLite cache (trong main) -----------------
ipcMain.handle('db:init', async (_e, scopeKey) => {
  await localdb.initLocalDb(app.getPath('userData'), scopeKey);
  return { ok: true, maxSeq: localdb.maxSeq() };
});
ipcMain.handle('db:upsertMessage', (_e, m) => { localdb.upsertMessage(m); return true; });
ipcMain.handle('db:getMessages', (_e, convId, limit, before) => localdb.getMessages(convId, limit, before));
ipcMain.handle('db:getMessageById', (_e, id) => localdb.getMessageById(id));
ipcMain.handle('db:searchMessages', (_e, q, limit, f) => localdb.searchMessages(q, limit, f || {}));
ipcMain.handle('db:listConversations', (_e, myId) => localdb.listConversations(myId));
ipcMain.handle('db:clearConversation', (_e, convId) => localdb.clearConversation(String(convId)));
ipcMain.handle('db:unreadCounts', (_e, myId) => localdb.unreadCounts(myId));
ipcMain.handle('db:maxSeq', () => localdb.maxSeq());
ipcMain.handle('db:getMeta', (_e, key) => localdb.getMeta(key));
ipcMain.handle('db:setMeta', (_e, key, value) => { localdb.setMeta(key, value); return true; });
ipcMain.handle('db:purgeExpired', (_e, now) => localdb.purgeExpired(now));
ipcMain.handle('db:listDmForBackfill', () => localdb.listDmForBackfill());
ipcMain.handle('db:failedDmIds', () => localdb.failedDmIds());
ipcMain.handle('db:liveFileIds', () => localdb.liveFileIds());
ipcMain.handle('db:mediaOf', (_e, convId, kind) => localdb.mediaOf(convId, kind));
ipcMain.handle('db:exportMessages', () => localdb.exportMessages());
ipcMain.handle('db:importMessages', (_e, list) => localdb.importMessages(list));

// ---- IPC: Mạng LAN (UDP tìm nhau + TCP gửi gói đã mã hóa) ----
ipcMain.handle('lan:start', async (_e, info) => {
  lan?.stop();
  lan = new LanNode(info);
  lan.on('peers', (list) => win?.webContents.send('lan:peers', list));
  lan.on('message', (m) => win?.webContents.send('lan:message', m));
  lan.on('error', (e) => win?.webContents.send('lan:error', String(e?.message || e)));
  return lan.start();
});
ipcMain.handle('lan:stop', () => { lan?.stop(); lan = null; return true; });
ipcMain.handle('lan:send', (_e, peerId, payload) => (lan ? lan.send(peerId, payload) : false));
ipcMain.handle('lan:peers', () => (lan ? lan.list() : []));
app.on('before-quit', () => lan?.stop());

// Định vị: dùng dịch vụ vị trí của Windows (WinRT) thay vì dịch vụ mạng của Google (Electron không kèm khóa API Google).
if (process.platform === 'win32') app.commandLine.appendSwitch('enable-features', 'WinrtGeolocationImplementation');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // nhạc chuông cuộc gọi đến khi chưa tương tác
// Mỗi hồ sơ (userData) chỉ một bản chạy; mở lần nữa -> hiện cửa sổ đang có.
// Link reachat://join/<mã> mở bằng app (bản cài đặt). Lần mở thứ hai -> chuyển link cho cửa sổ đang chạy.
if (app.isPackaged) app.setAsDefaultProtocolClient('reachat');
let pendingLink = process.argv.find((a) => a.startsWith('reachat://')) || null;
const sendLink = (link) => { if (!link) return; if (win?.webContents && !win.webContents.isLoading()) win.webContents.send('deeplink', link); else pendingLink = link; };
ipcMain.handle('deeplink:take', () => { const l = pendingLink; pendingLink = null; return l; });
// Windows: toast thông báo cần AppUserModelId trùng appId của bộ cài (hiện tên/biểu tượng ReaChat).
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'vn.aksoft.reachat' : process.execPath);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => { showWin(); sendLink(argv.find((a) => a.startsWith('reachat://'))); });
  app.whenReady().then(() => {
    loadConfig(); installCertPinning(); installCsp(); allowMediaPermissions(); createWindow(); setupTray(); setupUpdater();
    if (process.argv.includes('--hidden') && cfg.tray) win.hide();     // tự khởi động cùng Windows -> nằm ở khay
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

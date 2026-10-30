const { contextBridge, ipcRenderer } = require('electron');

// Chỉ mở đúng những hàm cần thiết cho renderer qua contextBridge (renderer không có quyền Node).
// Renderer KHÔNG có quyền truy cập fs/Node — mọi thao tác DB đi qua các kênh này.
// Cấu hình máy chủ đọc ĐỒNG BỘ lúc nạp trang (đổi máy chủ -> main lưu rồi reload cửa sổ).
const conf = ipcRenderer.sendSync('config:get');

contextBridge.exposeInMainWorld('reachat', {
  serverUrl: conf.serverUrl,
  wsUrl: conf.wsUrl,
  transport: { secure: conf.secure, pinned: conf.pinned },
  version: ipcRenderer.sendSync('app:version'),
  config: {
    get: () => ({ ...conf }),
    set: (next) => ipcRenderer.invoke('config:set', next),
    probe: (url) => ipcRenderer.invoke('config:probe', url),
  },
  autostart: {
    get: () => ipcRenderer.invoke('autostart:get'),
    set: (on) => ipcRenderer.invoke('autostart:set', !!on),
  },
  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (cb) => { const h = (_e, st) => cb(st); ipcRenderer.on('update:status', h); return () => ipcRenderer.removeListener('update:status', h); },
  },
  db: {
    init: (scopeKey) => ipcRenderer.invoke('db:init', scopeKey),
    upsertMessage: (m) => ipcRenderer.invoke('db:upsertMessage', m),
    getMessages: (convId, limit, before) => ipcRenderer.invoke('db:getMessages', convId, limit, before),
    getMessageById: (id) => ipcRenderer.invoke('db:getMessageById', id),
    searchMessages: (q, limit, f) => ipcRenderer.invoke('db:searchMessages', q, limit, f),
    listConversations: (myId) => ipcRenderer.invoke('db:listConversations', myId),
    clearConversation: (convId) => ipcRenderer.invoke('db:clearConversation', convId),
    unreadCounts: (myId) => ipcRenderer.invoke('db:unreadCounts', myId),
    maxSeq: () => ipcRenderer.invoke('db:maxSeq'),
    getMeta: (key) => ipcRenderer.invoke('db:getMeta', key),
    setMeta: (key, value) => ipcRenderer.invoke('db:setMeta', key, value),
    purgeExpired: (now) => ipcRenderer.invoke('db:purgeExpired', now),
    listDmForBackfill: () => ipcRenderer.invoke('db:listDmForBackfill'),
    failedDmIds: () => ipcRenderer.invoke('db:failedDmIds'),
    liveFileIds: () => ipcRenderer.invoke('db:liveFileIds'),
    mediaOf: (convId, kind) => ipcRenderer.invoke('db:mediaOf', convId, kind),
    exportMessages: () => ipcRenderer.invoke('db:exportMessages'),
    importMessages: (list) => ipcRenderer.invoke('db:importMessages', list),
  },
  // Chia sẻ màn hình: danh sách nguồn + chọn nguồn trước khi gọi getDisplayMedia.
  screen: {
    list: () => ipcRenderer.invoke('screen:list'),
    choose: (id) => ipcRenderer.invoke('screen:choose', id),
  },
  // Lưu / mở tệp qua hộp thoại hệ thống.
  files: {
    save: (name, data, kind) => ipcRenderer.invoke('file:save', { name, data, kind }),
    open: (filters) => ipcRenderer.invoke('file:open', { filters }),
    openWrite: (name) => ipcRenderer.invoke('file:openWrite', name),
    write: (id, data) => ipcRenderer.invoke('file:write', id, data),
    closeWrite: (id) => ipcRenderer.invoke('file:closeWrite', id),
  },
  // Link reachat://… mở app: lấy link lúc khởi động + nhận link khi app đang chạy.
  deeplink: {
    take: () => ipcRenderer.invoke('deeplink:take'),
    on: (cb) => { const h = (_e, l) => cb(l); ipcRenderer.on('deeplink', h); return () => ipcRenderer.removeListener('deeplink', h); },
  },
  // Cửa sổ: hiện lại (bấm thông báo), số chưa đọc trên khay, chống chụp màn hình.
  win: {
    show: () => ipcRenderer.invoke('win:show'),
    badge: (n) => ipcRenderer.invoke('win:badge', n),
    protect: (on) => ipcRenderer.invoke('win:protect', on),
  },
  // Mạng LAN (chỉ có trên app desktop). Gói tin do renderer mã hóa trước khi gửi.
  lan: {
    start: (info) => ipcRenderer.invoke('lan:start', info),
    stop: () => ipcRenderer.invoke('lan:stop'),
    send: (peerId, payload) => ipcRenderer.invoke('lan:send', peerId, payload),
    peers: () => ipcRenderer.invoke('lan:peers'),
    onPeers: (cb) => { const h = (_e, l) => cb(l); ipcRenderer.on('lan:peers', h); return () => ipcRenderer.removeListener('lan:peers', h); },
    onMessage: (cb) => { const h = (_e, m) => cb(m); ipcRenderer.on('lan:message', h); return () => ipcRenderer.removeListener('lan:message', h); },
  },
});

// Lớp giao tiếp với server: REST cho auth + tra cứu, WebSocket cho realtime & sync.
const { serverUrl, wsUrl } = window.reachat;

async function post(path, body, token) {
  const res = await fetch(serverUrl + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const e = new Error(data.error || 'Lỗi yêu cầu');
    if (data.need2fa) e.need2fa = true;
    if (data.needCaptcha) e.needCaptcha = true;
    if (data.needPassword) e.needPassword = true;
    if (data.needCode) e.needCode = true;
    e.data = data;
    e.status = res.status;
    if (res.status === 401 && token && token === authToken) window.dispatchEvent(new Event('reachat:unauthorized'));
    throw e;
  }
  return data;
}

let authToken = null;
export const setToken = (t) => { authToken = t; };
export const currentToken = () => authToken;

export const register = (b) => post('/api/register', { ...b, device: deviceName() });
export const login = (b) => post('/api/login', { ...b, device: deviceName() });
// Bảo mật tài khoản
export const securityStatus = () => get('/api/me/security');
export const totpSetup = () => post('/api/me/2fa/setup', {}, authToken);
export const totpEnable = (code) => post('/api/me/2fa/enable', { code }, authToken);
export const totpDisable = (code) => post('/api/me/2fa/disable', { code }, authToken);
export const setRecoveryCode = (verifier, backup, auth = {}) => post('/api/me/recovery', { verifier, backup, ...auth }, authToken);
export const recoverAccount = (b) => post('/api/recover', { ...b, device: deviceName() });
// Nhãn thiết bị gửi kèm khi đăng nhập (hiện trong "Thiết bị đăng nhập"). Bản web: để máy chủ đoán từ trình duyệt.
export function deviceName() {
  if (window.reachat?.web) return undefined;
  const u = navigator.userAgent;
  return 'ReaChat Desktop · ' + (/Windows/.test(u) ? 'Windows' : /Mac OS/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : 'máy tính');
}
// Thiết bị đăng nhập / xóa tài khoản
export const listSessions = () => get('/api/me/sessions');
export const revokeSession = (sid) => del('/api/me/sessions/' + encodeURIComponent(sid));
export const revokeOtherSessions = () => post('/api/me/sessions/revoke-others', {}, authToken);
export const deleteAccount = (b) => post('/api/me/delete', b, authToken);
// Email / SĐT khôi phục + quên mật khẩu qua mã
export const contactStart = (kind, value, auth = {}) => post('/api/me/contact/start', { kind, value, ...auth }, authToken);
export const contactVerify = (kind, code) => post('/api/me/contact/verify', { kind, code }, authToken);
export const contactRemove = (kind, password) => post('/api/me/contact/remove', { kind, password }, authToken);
export const forgotChannels = () => fetch(serverUrl + '/api/forgot/channels').then((r) => r.json()).catch(() => ({}));
export const forgotStart = (ident, channel, captcha) => post('/api/forgot/start', { ident, channel, captcha });
// Captcha + đăng nhập Google + báo lỗi ứng dụng
export const getCaptcha = () => fetch(serverUrl + '/api/captcha', { cache: 'no-store' }).then((r) => r.json());
export const googleConfig = () => fetch(serverUrl + '/api/auth/google/config').then((r) => r.json()).catch(() => ({}));
export const googleBegin = (mode, token) => post('/api/auth/google/begin', { mode }, token);
export const googlePoll = (body, token) => post('/api/auth/google/poll', { ...body, device: deviceName() }, token);
export const qrLoginBegin = (epk, secret) => post('/api/qrlogin/begin', { epk, secret, device: deviceName() });
export const qrLoginPoll = (sid, secret) => post('/api/qrlogin/poll', { sid, secret, device: deviceName() });
export const qrLoginInfo = (sid) => post('/api/qrlogin/info', { sid }, authToken);
export const qrLoginApprove = (sid, sealed) => post('/api/qrlogin/approve', { sid, sealed }, authToken);
export const googleUnlink =(password) => post('/api/me/google/unlink', { password }, authToken);
export const reportClientError = (b) => fetch(serverUrl + '/api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}) }, body: JSON.stringify(b) }).catch(() => {});
export const forgotReset = (b) => post('/api/forgot/reset', { ...b, device: deviceName() });
export const changePassword = (b) => post('/api/me/password', b, authToken);
export const report = (b) => post('/api/reports', b, authToken);
export const myStorage = () => get('/api/me/storage');
// Bot
export const listBots = () => get('/api/bots').then((d) => d.bots);
export const createBot = (b) => post('/api/bots', b, authToken);
export const botToken = (id) => post('/api/bots/' + encodeURIComponent(id) + '/token', {}, authToken);
export const botWebhook = (id, url) => post('/api/bots/' + encodeURIComponent(id) + '/webhook', { url }, authToken);
export const deleteBot = (id) => del('/api/bots/' + encodeURIComponent(id));
export const serverBase = () => serverUrl;
// Thông báo đẩy (PWA)
export const pushKey = () => get('/api/push/key').then((d) => d.publicKey);
export const pushSubscribe = (subscription, muted) => post('/api/push/subscribe', { subscription, muted }, authToken);
export const pushUnsubscribe = (endpoint) => post('/api/push/unsubscribe', { endpoint }, authToken);
export const pushMuted = (endpoint, muted) => post('/api/push/muted', { endpoint, muted }, authToken);
export const uploadKey = (token, publicKey) => post('/api/me/key', { publicKey }, token);
export const updateProfile = (body) => post('/api/me/profile', body, authToken);
export const putKeyBackup = (token, backup) => post('/api/me/keybackup', { backup }, token);
export async function getKeyBackup(token) {
  const res = await fetch(serverUrl + '/api/me/keybackup', { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Lỗi tải sao lưu khóa');
  return data.backup;
}
export const addContact = (username) => post('/api/contacts', { username }, authToken);
export const blockUser = (username) => post('/api/block', { username }, authToken);
export const unblockUser = (username) => post('/api/unblock', { username }, authToken);
async function get(path) {
  const sent = authToken;
  const res = await fetch(serverUrl + path, { headers: sent ? { Authorization: 'Bearer ' + sent } : {} });
  const data = await res.json();
  // Chỉ coi là "phiên bị thu hồi" khi yêu cầu gửi kèm đúng token đang dùng (yêu cầu chạy trước khi nạp token thì không).
  if (res.status === 401 && sent && sent === authToken) window.dispatchEvent(new Event('reachat:unauthorized'));
  if (!res.ok) throw new Error(data.error || 'Lỗi');
  return data;
}
export const listContacts = () => get('/api/contacts').then((d) => d.contacts);
export const listBlocks = () => get('/api/blocks').then((d) => d.blocked);
async function del(path) {
  const res = await fetch(serverUrl + path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + authToken } });
  return res.json();
}
export const removeContact = (username) => del('/api/contacts/' + encodeURIComponent(username));
export const uploadFile = ({ name, mime, dataB64 }) => post('/api/files', { name, mime, dataB64 }, authToken);
// Cấu hình ICE cho cuộc gọi (STUN + TURN tạm thời do server cấp). Lỗi -> chỉ STUN công khai.
export const reportTurnUsage = (bytes) => post('/api/turn/usage', { bytes }, authToken);
// ctx: { callId, peer } (gọi đi) | { callId } (nghe) | { group } (gọi nhóm) — máy chủ chỉ cấp TURN Cloudflare cho cuộc gọi thật.
export const iceConfig = (ctx = {}) => get('/api/ice?' + new URLSearchParams(Object.entries(ctx).filter(([, v]) => v))).then((c) => { if (c.turnBlocked) window.dispatchEvent(new CustomEvent('reachat:turnBlocked', { detail: c.turnBlocked })); return c; }).catch(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }));

// ---- Kết bạn ----
export const friendRequests = () => get('/api/friends/requests');
export const stickerPacks = () => get('/api/stickers').then((d) => d.packs || []);
export const getMyStatus = () => get('/api/me/status');
export const setMyStatus = (b) => post('/api/me/status', b, authToken);
// Đồng bộ tùy chọn giữa thiết bị (tài liệu đã mã hóa)
export const getSync = () => get('/api/me/sync');
export async function putSync(baseVersion, blob) {
  const res = await fetch(serverUrl + '/api/me/sync', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken }, body: JSON.stringify({ baseVersion, blob }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Lỗi đồng bộ'), { status: res.status, data });
  return data;
}
// GIF + dịch (nhóm 3)
let extrasP = null;
export const extrasConfig = () => (extrasP ||= get('/api/extras/config').catch(() => { extrasP = null; return {}; }));
export const gifSearch = (q, pos = '') => get('/api/gif/search?q=' + encodeURIComponent(q || '') + '&pos=' + encodeURIComponent(pos));
// url "lib:<mã>" = GIF trong kho của máy chủ; use = đếm lượt dùng (khi gửi, không tính lúc xem trước).
export async function gifMedia(url, use = false) {
  const path = String(url).startsWith('lib:') ? '/api/gif/lib/' + encodeURIComponent(url.slice(4)) + (use ? '?use=1' : '') : '/api/gif/media?url=' + encodeURIComponent(url);
  const res = await fetch(serverUrl + path, { headers: { Authorization: 'Bearer ' + authToken } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Không tải được GIF');
  return res.blob();
}
export const translate = (text, to) => post('/api/translate', { text, to }, authToken);
export const getProfile = (username) => get('/api/users/' + encodeURIComponent(username) + '/profile').then((d) => d.profile);
export const saveProfileExtra = (b) => post('/api/me/profile/extra', b, authToken).then((d) => d.profile);
export const birthdaysToday = () => get('/api/contacts/birthdays').then((d) => d.today || []);
export const linkPreview = (url) => get('/api/link-preview?url=' + encodeURIComponent(url)).then((d) => d.preview);
export const searchUsers = (q) => get('/api/users/search?q=' + encodeURIComponent(q));
export const getPrivacy = () => get('/api/me/privacy');
export const setPrivacy = (b) => post('/api/me/privacy', b, authToken);
export const sendFriendRequest = (username) => post('/api/friends/request', { username }, authToken);
export const acceptFriend = (id) => post('/api/friends/accept', { id }, authToken);
export const declineFriend = (id) => post('/api/friends/decline', { id }, authToken);

// ---- Story (story) ----
export const listStories = () => get('/api/stories').then((d) => d.stories);
export const storyHidden = () => get('/api/stories/hidden').then((d) => d.hidden);
export async function setStoryHidden(usernames) {
  const res = await fetch(serverUrl + '/api/stories/hidden', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken }, body: JSON.stringify({ usernames }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Lỗi');
  return data;
}
export const postStory = (body) => post('/api/stories', body, authToken);
export const viewStory = (id) => post('/api/stories/' + encodeURIComponent(id) + '/view', {}, authToken);
export const storyViewers = (id) => get('/api/stories/' + encodeURIComponent(id) + '/viewers').then((d) => d.viewers);
export const deleteStory = (id) => del('/api/stories/' + encodeURIComponent(id));

// Tải file kèm token rồi tạo objectURL (dùng cho <img>/tải xuống, file KHÔNG mã hóa).
const urlCache = new Map();
export async function fileObjectURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const res = await fetch(serverUrl + '/api/files/' + id, { headers: { Authorization: 'Bearer ' + authToken } });
  if (!res.ok) throw new Error('Tải file lỗi');
  const url = URL.createObjectURL(await res.blob());
  urlCache.set(id, url);
  return url;
}

// Tải byte thô (ciphertext) để giải mã phía client (file ĐÃ mã hóa 1-1).
export async function fileBytes(id) {
  const res = await fetch(serverUrl + '/api/files/' + id, { headers: { Authorization: 'Bearer ' + authToken } });
  if (!res.ok) throw new Error('Tải file lỗi');
  return new Uint8Array(await res.arrayBuffer());
}

export async function lookupUser(username, token) {
  const res = await fetch(serverUrl + '/api/users/' + encodeURIComponent(username), {
    headers: { Authorization: 'Bearer ' + token },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Không tìm thấy');
  return data.user;
}

export class Realtime {
  constructor(token, handlers) {
    this.token = token;
    this.handlers = handlers;
    this.ws = null;
    this.refCounter = 0;
    this.pending = [];
    this.parked = false;
    // Trang bị cất vào bộ nhớ đệm khi chuyển trang (bfcache) -> đóng kết nối để máy chủ biết mình đã rời
    // (gửi thông báo đẩy thay vì tưởng vẫn online); quay lại trang -> kết nối lại.
    addEventListener('pagehide', (e) => { if (e.persisted) { this.parked = true; try { this.ws?.close(); } catch {} } });
    addEventListener('pageshow', (e) => { if (e.persisted && this.parked) { this.parked = false; this.connect(this.handlers.currentSeq?.() ?? 0); } });
  }

  connect(sinceSeq = 0) {
    this.ws = new WebSocket(wsUrl + '?token=' + encodeURIComponent(this.token));
    this.ws.onopen = () => {
      this._raw({ type: 'sync', sinceSeq, sinceMod: this.handlers.currentMod?.() || 0 });
      this._raw({ type: 'conversations' });
      for (const p of this.pending.splice(0)) this._raw(p);
    };
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const h = this.handlers;
      switch (m.type) {
        case 'ready': h.onReady?.(m.user); break;
        case 'message': h.onMessage?.(m.message); break;
        case 'message:update': h.onMessageUpdate?.(m.message); break;
        case 'sync:batch': h.onSyncBatch?.(m.messages, !!m.more); break;
        case 'history': h.onHistory?.(m); break;
        case 'destruct:acks': h.onDestructAcks?.(m.messageId, m.acks); break;
        case 'destruct:acked': h.onDestructAcked?.(m.ids); break;
        case 'ack': h.onAck?.(m); break;
        case 'receipt': h.onReceipt?.(m); break;
        case 'typing': h.onTyping?.(m); break;
        case 'presence': h.onPresence?.(m); break;
        case 'presence:init': h.onPresenceInit?.(m.online); break;
        case 'conversations': h.onConversations?.(m.conversations); break;
        case 'conversation:new': h.onConversationNew?.(m.conversation); break;
        case 'pins': h.onPins?.(m.conversationId, m.ids); break;
        case 'conversation:update': h.onConversationUpdate?.(m); break;
        case 'tasks': h.onTasks?.(m.conversationId, m.items); break;
        case 'doc:update': h.onDocUpdate?.(m); break;
        case 'copy': h.onCopy?.(m); break;
        case 'copies': for (const it of m.items || []) h.onCopy?.(it); break;
        case 'doc:snapshot': h.onDocSnapshot?.(m.conversationId, m.updates); break;
        case 'conversation:removed': h.onConversationRemoved?.(m.conversationId, m.channel); break;
        case 'channel:results': h.onChannelResults?.(m); break;
        case 'channel:joined': h.onChannelJoined?.(m.conversationId); break;
        case 'poll': h.onPoll?.(m.messageId, m.tally); break;
        case 'event:rsvp': h.onEventRsvp?.(m.messageId, m.tally); break;
        case 'scheduled': h.onScheduled?.(m); break;
        case 'scheduled:list': h.onScheduledList?.(m.items); break;
        case 'signal': h.onSignal?.(m.from, m.data); break;
        case 'gcall:active': h.onGcallActive?.(m); break;
        case 'invite': h.onInvite?.(m); break;
        case 'invite:preview': h.onInvitePreview?.(m); break;
        case 'invite:joined': h.onInviteJoined?.(m.conversationId); break;
        case 'meet:created': h.onMeetCreated?.(m); break;
        case 'gcall:joined': h.onGcallJoined?.(m); break;
        case 'gcall:peer': h.onGcallPeer?.(m); break;
        case 'gcall:ended': h.onGcallEnded?.(m); break;
        case 'gsignal': h.onGsignal?.(m); break;
        case 'friend:request': h.onFriendRequest?.(m.from); break;
        case 'group:pending': h.onGroupPending?.(m); break;
        case 'sync:changed': h.onSyncChanged?.(m); break;
        case 'invite:pending': h.onInvitePending?.(m); break;
        case 'friend:accepted': h.onFriendAccepted?.(m.by); break;
        case 'story:new': h.onStoryNew?.(m.userId); break;
        case 'error': h.onError?.(m.error); break;
      }
    };
    this.ws.onclose = (ev) => {
      if (ev.code === 4401) { this.handlers.onUnauthorized?.(); return; }   // phiên bị thu hồi -> không kết nối lại
      if (this.parked) return;                                              // đang nằm trong bfcache: chờ pageshow
      setTimeout(() => this.connect(this.handlers.currentSeq?.() ?? sinceSeq), 1500);
    };
  }

  // Đồng bộ tiếp (khi lô trước còn `more`).
  sync(sinceSeq, sinceMod) { this._raw({ type: 'sync', sinceSeq, sinceMod }); }
  history(conversationId, beforeSeq, limit = 50) { this._raw({ type: 'history', conversationId, beforeSeq, limit }); }
  destructAck(ids, deviceId) { this._raw({ type: 'destruct:ack', ids, deviceId }); }
  destructStatus(ids) { this._raw({ type: 'destruct:ack', ids, query: true }); }   // chỉ hỏi, không xác nhận
  get isOpen() { return this.ws?.readyState === WebSocket.OPEN; }

  _raw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    else this.pending.push(obj);
  }

  // Gửi tin: tới username (direct) hoặc conversationId (nhóm/direct đã biết).
  send({ to, conversationId, body, enc, msgType, replyTo, ttl }) {
    const ref = 'r' + (++this.refCounter);
    this._raw({ type: 'send', to, conversationId, body, enc, msgType, replyTo, ttl, ref });
    return ref;
  }
  typing(conversationId, isTyping) { this._raw({ type: 'typing', conversationId, isTyping }); }
  read(conversationId, seq) { this._raw({ type: 'read', conversationId, seq }); }
  recall(messageId) { this._raw({ type: 'recall', messageId }); }
  edit(messageId, body, enc) { this._raw({ type: 'edit', messageId, body, enc }); }
  react(messageId, emoji) { this._raw({ type: 'react', messageId, emoji }); }
  createGroup(title, members) { this._raw({ type: 'group:create', title, members }); }
  requestConversations() { this._raw({ type: 'conversations' }); }
  signal(to, data) { this._raw({ type: 'signal', to, data }); } // relay tín hiệu WebRTC
  gcallJoin(conversationId, video, rejoin = false) { this._raw({ type: 'gcall:join', conversationId, video, rejoin }); }
  gcallLeave() { this._raw({ type: 'gcall:leave' }); }
  gcallList() { this._raw({ type: 'gcall:list' }); }
  invite(action, conversationId) { this._raw({ type: 'invite:' + action, conversationId }); }   // create | get | revoke
  invitePreview(code) { this._raw({ type: 'invite:preview', code }); }
  channelCreate(frame) { this._raw({ type: 'channel:create', ...frame }); }
  channelSearch(q) { this._raw({ type: 'channel:search', q }); }
  channelJoin(by) { this._raw({ type: 'channel:join', ...by }); }   // {id} | {handle}
  inviteJoin(code) { this._raw({ type: 'invite:join', code }); }
  meetCreate(title) { this._raw({ type: 'meet:create', title }); }
  gsignal(pid, data) { this._raw({ type: 'gsignal', pid, data }); }
  pin(messageId, pinned) { this._raw({ type: 'pin', messageId, pinned }); }
  requestPins(conversationId) { this._raw({ type: 'pins', conversationId }); }
  vote(messageId, option) { this._raw({ type: 'vote', messageId, option }); }
  rsvp(messageId, status) { this._raw({ type: 'rsvp', messageId, status }); }
  rsvpGet(messageId) { this._raw({ type: 'rsvp:get', messageId }); }
  requestPoll(messageId) { this._raw({ type: 'poll:get', messageId }); }
  schedule(frame) { this._raw({ type: 'schedule', ...frame }); }
  listScheduled() { this._raw({ type: 'scheduled:list' }); }
  cancelScheduled(id) { this._raw({ type: 'scheduled:cancel', id }); }
  groupRename(conversationId, title) { this._raw({ type: 'group:rename', conversationId, title }); }
  groupAdd(conversationId, members) { this._raw({ type: 'group:add', conversationId, members }); }
  groupLeave(conversationId) { this._raw({ type: 'group:leave', conversationId }); }
  groupKick(conversationId, username) { this._raw({ type: 'group:kick', conversationId, username }); }
  groupRole(conversationId, username, role) { this._raw({ type: 'group:role', conversationId, username, role }); }
  groupTransfer(conversationId, username) { this._raw({ type: 'group:transfer', conversationId, username }); }
  groupAvatar(conversationId, avatar) { this._raw({ type: 'group:avatar', conversationId, avatar }); }
  groupSettings(conversationId, s) { this._raw({ type: 'group:settings', conversationId, ...s }); }
  groupApprove(conversationId, username, accept) { this._raw({ type: 'group:approve', conversationId, username, accept }); }
  syncConversation(conversationId) { this._raw({ type: 'sync:conv', conversationId }); }
  onceViewed(messageId) { this._raw({ type: 'once:viewed', messageId }); }
  createTask(frame) { this._raw({ type: 'task:create', ...frame }); }
  toggleTask(id) { this._raw({ type: 'task:toggle', id }); }
  deleteTask(id) { this._raw({ type: 'task:delete', id }); }
  listTasks(conversationId) { this._raw({ type: 'task:list', conversationId }); }
  docPush(conversationId, data, clientId) { this._raw({ type: 'doc:push', conversationId, data, clientId }); }
  docPull(conversationId) { this._raw({ type: 'doc:pull', conversationId }); }
  putCopy(messageId, data) { this._raw({ type: 'copy:put', messageId, data }); }
  getCopies(ids) { this._raw({ type: 'copy:get', ids }); }
  docCompact(conversationId, upto, data) { this._raw({ type: 'doc:compact', conversationId, upto, data }); }
}

import { setLiveCheck, revokeCallTurn } from './turn.js';
import { autoReplyFor } from './status.js';
import { assertClean } from './moderation.js';
import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';
import {
  ensureDirectConversation, createGroup, getConversation, conversationMembers,
  isMember, listConversationsForUser, contactsOf, serializeConversation,
  insertMessage, getMessageById, recallMessage, editMessage,
  messagesSince, serializeMessage, setRead, getReads, setLastSeen,
  toggleReaction, getReactions, isBlocked,
  getUserByUsername, getUserById, publicUser,
  setPinned, pinnedIds, expiredMessageIds,
  votePoll, pollTally, createScheduled, dueScheduled, deleteScheduled, listScheduled,
  renameGroup, addMembers, removeMember, setOwner, conversationMessages, markOnceViewed,
  createTask, getTask, toggleTask, deleteTask, listTasks,
  pushDocUpdate, docUpdates, compactDoc, putSelfCopy, getSelfCopy,
  messagesChangedSince, messagesBefore, destroyMessage, addDestructAck, destructAcks,
  getScheduled, scheduledWaitingOn, repliedAfter, lastSeqOf, readSeqOf,
  createInvite, activeInvite, getInvite, revokeInvites, useInvite,
  makeChannel, getChannelByHandle, searchChannels, channelCount, makeMeeting,
  setRsvp, rsvpTally, isGroupAdmin, setMemberRole, setGroupAvatar, setGroupSettings, addJoinRequest, removeJoinRequest, readReceiptsOn, presenceHidden, getFile,
} from './db.js';
import fs from 'node:fs';
import { pushWebhooks } from './bots.js';
import { pushNewMessage } from './push.js';
import { take, check, WS_BUCKET } from './limits.js';
import { MAX_MSG_KB, GROUP_MAX_MEMBERS } from './config.js';
const tooLong = (s) => Buffer.byteLength(String(s ?? '')) > MAX_MSG_KB * 1024;
// Loại tin client được tự gửi. 'system' / 'call' / 'autoreply' chỉ máy chủ tạo (không cho giả tin hệ thống).
const CLIENT_TYPES = new Set(['text', 'sticker', 'contact', 'location', 'event', 'poll', 'p2pfile', 'image', 'file', 'video', 'voice', 'gif', 'album', 'keydist']);
const msgTypeOf = (t) => { const v = t == null ? 'text' : String(t); if (!CLIENT_TYPES.has(v)) throw new Error('Loại tin không hợp lệ'); return v; };
const groupFull = (convId, adding) => GROUP_MAX_MEMBERS > 0 && conversationMembers(convId).length + adding > GROUP_MAX_MEMBERS;   // 0 = không giới hạn
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UPLOAD_DIR = fileURLToPath(new URL('../uploads', import.meta.url));

// userId -> Set<WebSocket>
const online = new Map();
const WS_MAX_PER_USER = Number(process.env.WS_MAX_PER_USER) || 20;
const isOnline = (userId) => online.has(userId);
const addSocket = (userId, ws) => {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(ws);
};
const removeSocket = (userId, ws) => {
  const set = online.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) { online.delete(userId); return true; } // không còn socket nào
  return false;
};
const sendTo = (userId, payload) => {
  const set = online.get(userId);
  if (!set) return false;
  const data = JSON.stringify(payload);
  let sent = false;
  for (const ws of set) if (ws.readyState === ws.OPEN) { ws.send(data); sent = true; }
  return sent;
};
// Cho phép REST (index.js) đẩy sự kiện realtime tới một user (nếu online).
export const emitToUser = (userId, payload) => sendTo(userId, payload);
// Bot (REST) gửi tin như một người dùng: cùng luật chặn/thành viên với tin thường; luôn là văn bản thường.
export function sendAsUser(user, { to, conversationId, text, replyTo }) {
  if (conversationId) {
    conversationId = String(conversationId);
    try { assertCanPost(user.id, conversationId, { type: 'text', body: text }); }          // cùng luật: kênh, nhóm chỉ quản trị, chặn
    catch (e) { throw Object.assign(e, { status: 403 }); }
  } else {
    const peer = getUserByUsername(String(to || '').toLowerCase().replace(/^@/, ''));
    if (!peer) throw Object.assign(new Error('Người nhận không tồn tại'), { status: 404 });
    if (isBlocked(peer.id, user.id) || isBlocked(user.id, peer.id)) throw Object.assign(new Error('Không gửi được (đã chặn)'), { status: 403 });
    conversationId = ensureDirectConversation(user.id, peer.id);
  }
  const body = String(text ?? '');
  if (!body.trim() || body.length > 4000) throw Object.assign(new Error('Nội dung trống hoặc quá dài (tối đa 4000 ký tự)'), { status: 400 });
  const stored = insertMessage({ conversationId, senderId: user.id, body, enc: false, type: 'text', replyTo: replyTo || null });
  const members = conversationMembers(conversationId);
  for (const uid of members) sendTo(uid, { type: 'message', message: enrich(stored) });
  pushWebhooks(stored, members);
  pushNewMessage(stored, members, isOnline);
  return enrich(stored);
}

// Cho trang quản trị: số người online, trạng thái online, phát cập nhật tin (gỡ tin vi phạm).
export const onlineCount = () => online.size;
export const isUserOnline = (userId) => online.has(userId);
export const broadcastMessageUpdate = (m) => broadcastMembers(m.conversationId, { type: 'message:update', message: { ...m, senderUsername: getUserById(m.senderId)?.username || null, reactions: [] } });
// Thu hồi phiên: đóng mọi kết nối của user (đổi/đặt lại mật khẩu, bị khóa tài khoản) -> client về màn đăng nhập.
// Thu hồi MỘT phiên: chỉ đóng các kết nối của thiết bị đó.
export const kickOthers = (userId, keepSid) => { for (const ws of online.get(userId) || []) if (ws.sid !== keepSid) { try { ws.close(4401, 'unauthorized'); } catch {} } };
export const kickSession = (userId, sid) => { for (const ws of online.get(userId) || []) if (ws.sid === sid) { try { ws.close(4401, 'unauthorized'); } catch {} } };
// Đổi cài đặt "ẩn trạng thái trực tuyến" khi đang online -> báo ngay cho bạn bè (ẩn = như vừa offline, không kèm lần cuối truy cập).
export function announcePresence(userId) {
  if (!isOnline(userId)) return;
  const u = getUserById(userId), hidden = presenceHidden(userId);
  for (const cid of contactsOf(userId))
    sendTo(cid, hidden ? { type: 'presence', userId, username: u.username, online: false, lastSeen: null } : { type: 'presence', userId, username: u.username, online: true });
}
export const kickUser = (userId) => { for (const ws of online.get(userId) || []) { try { ws.close(4401, 'unauthorized'); } catch {} } };
const broadcastMembers = (conversationId, payload, exceptUserId = null) => {
  for (const uid of conversationMembers(conversationId)) {
    if (uid !== exceptUserId) sendTo(uid, payload);
  }
};

// Gắn thêm username người gửi để client map sang khóa công khai.
const enrich = (m) => {
  const s = serializeMessage(m);
  const sender = getUserById(s.senderId);
  const out = { ...s, senderUsername: sender ? sender.username : null, reactions: getReactions(s.id) };
  if (s.expireAt && s.recalled) out.destructAcks = destructAcks(s.id);   // tin tự hủy: thiết bị nào đã xác nhận xóa
  return out;
};

// Quyền đăng tin vào một hội thoại — dùng chung cho gửi ngay, hẹn giờ và lúc tin hẹn tới hạn:
// thành viên; kênh chỉ chủ kênh (không mã hóa, qua kiểm duyệt); nhóm "chỉ quản trị"; 1-1 không chặn nhau.
function assertCanPost(userId, conversationId, { enc = false, type = 'text', body = '' } = {}) {
  if (!conversationId || !isMember(conversationId, userId)) throw new Error('Không thuộc hội thoại này');
  const cc = getConversation(conversationId);
  if (cc?.is_channel && cc.owner_id !== userId) throw new Error('Chỉ chủ kênh được đăng bài');
  if (cc?.is_channel && enc) throw new Error('Kênh công khai không dùng mã hóa');
  if (cc?.is_channel && type === 'text') assertClean(body, 'Bài đăng');                       // kênh công khai: máy chủ đọc được
  if (cc?.admin_only && !cc.is_channel && type !== 'keydist' && !isGroupAdmin(cc, userId)) throw new Error('Chỉ trưởng nhóm và phó nhóm được gửi tin trong nhóm này');
  if (cc?.type === 'direct') {
    const other = conversationMembers(conversationId).find((uid) => uid !== userId);
    if (other && (isBlocked(other, userId) || isBlocked(userId, other))) throw new Error('Không gửi được (đã chặn)');
  }
  return cc;
}

// Danh sách username từ client: phải là mảng, tối đa 1000 phần tử, chuẩn hóa.
const memberList = (v) => {
  if (!Array.isArray(v)) return [];
  if (v.length > 1000) throw new Error('Danh sách thành viên quá dài');
  return v.map((u) => String(u).toLowerCase().replace(/^@+/, '').trim()).filter((u) => /^[a-z0-9_]{1,32}$/.test(u));
};

// Kênh công khai: người theo dõi chỉ đọc (không ghim, không ghi chú chung, không giao việc).
const ownerOnlyInChannel = (conversationId, userId) => { const c = getConversation(conversationId); return !!c?.is_channel && c.owner_id !== userId; };

// ---- Gửi tin đã hẹn / chờ điều kiện ----
const deliverScheduled = (s) => {
  // Tới hạn mới gửi -> kiểm lại quyền (có thể đã rời nhóm, bị chặn, nhóm chuyển sang chỉ quản trị…).
  try { assertCanPost(s.sender_id, s.conversation_id, { enc: !!s.enc, type: s.type, body: s.body }); }
  catch { return dropScheduled(s, 'skipped'); }
  deleteScheduled(s.id);
  const stored = insertMessage({ conversationId: s.conversation_id, senderId: s.sender_id, body: s.body, enc: !!s.enc, type: s.type, replyTo: s.reply_to });
  const payload = { type: 'message', message: enrich(stored) };
  const members = conversationMembers(s.conversation_id);
  for (const uid of members) sendTo(uid, payload);
  pushNewMessage(stored, members, isOnline);
  sendTo(s.sender_id, { type: 'scheduled', action: 'sent', id: s.id, conversationId: s.conversation_id });
};
const dropScheduled = (s, reason) => {
  deleteScheduled(s.id);
  sendTo(s.sender_id, { type: 'scheduled', action: reason, id: s.id, conversationId: s.conversation_id });
};
const condOf = (s) => { try { return s.cond ? JSON.parse(s.cond) : null; } catch { return null; } };
// Tới hạn (send_at): hẹn giờ thường -> gửi; "nếu chưa trả lời" -> gửi hoặc bỏ;
// chờ online/đã xem mà hết hạn chờ -> gửi nếu chọn "vẫn gửi", không thì bỏ.
const onScheduledDue = (s) => {
  const c = condOf(s);
  if (!c) return deliverScheduled(s);
  if (c.kind === 'noreply') return repliedAfter(s.conversation_id, s.sender_id, c.sinceSeq || 0) ? dropScheduled(s, 'skipped') : deliverScheduled(s);
  return c.fallback === 'send' ? deliverScheduled(s) : dropScheduled(s, 'expired');
};
// Kiểm tra ngay các điều kiện chờ của một người (khi họ online / khi họ đọc).
const checkWaiting = (kind, userId) => {
  for (const s of scheduledWaitingOn(kind, userId)) {
    const c = condOf(s);
    if (kind === 'online' || (kind === 'read' && readSeqOf(s.conversation_id, userId) >= (c.seq || 0))) deliverScheduled(s);
  }
};

export const attachWebSocket = (server) => {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    // Lỗi giao thức (gói quá lớn, khung hỏng…) -> chỉ đóng kết nối đó. Thiếu listener này một client có thể làm SẬP cả server.
    ws.on('error', () => { try { ws.terminate(); } catch {} });
    const url = new URL(req.url, 'http://localhost');
    const user = verifyToken(url.searchParams.get('token') || '');
    if (!user) { ws.close(4401, 'unauthorized'); return; }   // token sai/hết hạn/mật khẩu đã đổi/tài khoản bị khóa

    // Tối đa WS_MAX_PER_USER kết nối cùng lúc mỗi tài khoản (mỗi kết nối có hạn mức gói riêng -> mở nhiều để lách).
    if ((online.get(user.id)?.size || 0) >= WS_MAX_PER_USER) { ws.close(4429, 'too many connections'); return; }
    ws.userId = user.id;

    ws.connId = user.id + ':' + Math.random().toString(36).slice(2);

    ws.sid = user.sid || null;
    ws.username = user.username;
    const firstSocket = !isOnline(user.id);
    addSocket(user.id, ws);
    ws.send(JSON.stringify({ type: 'ready', user: publicUser(user) }));

    // Phát trạng thái online cho các liên hệ + báo cho mình ai đang online.
    const contacts = contactsOf(user.id);
    const hidePresence = presenceHidden(user.id);
    if (firstSocket) {
      if (!hidePresence) for (const cid of contacts) sendTo(cid, { type: 'presence', userId: user.id, username: user.username, online: true });
      checkWaiting('online', user.id);   // tin "gửi khi người này online"
    }
    ws.send(JSON.stringify({
      type: 'presence:init',
      online: contacts.filter((id) => isOnline(id) && !presenceHidden(id)).map((id) => {
        const u = getUserById(id); return { userId: id, username: u.username };
      }),
    }));

    let floods = 0;
    ws.on('message', (raw) => {
      // Giới hạn tổng số gói của kết nối; xả liên tục -> đóng kết nối (4429) để bảo vệ máy chủ.
      if (take('frame', ws.connId)) {
        if (++floods > 200) { try { ws.close(4429, 'rate limit'); } catch {} }
        return;
      }
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      try { const g = WS_BUCKET[msg?.type]; if (g) check(g, ws.userId); }
      catch (err) { ws.send(JSON.stringify({ type: 'error', error: err.message, ref: msg?.ref, rateLimited: true })); return; }
      handle(ws, msg).catch((err) =>
        ws.send(JSON.stringify({ type: 'error', error: err.message, ref: msg?.ref })));
    });

    ws.on('close', () => {
      const last = removeSocket(user.id, ws);
      dropCallsOf(user.id, ws);
      gcallLeave(ws);
      if (last) {
        setLastSeen(user.id);
        if (!presenceHidden(user.id)) for (const cid of contactsOf(user.id))
          sendTo(cid, { type: 'presence', userId: user.id, username: user.username, online: false, lastSeen: Date.now() });
      }
    });
  });

  // Quét mỗi 5s: (1) thu hồi tin tự hủy hết hạn, (2) gửi tin đã hẹn giờ tới hạn.
  setInterval(() => {
    // Tự hủy: xóa nội dung + file + bản sao + cảm xúc trên server; client tự xóa bản cục bộ rồi gửi xác nhận.
    for (const { id, conversation_id } of expiredMessageIds()) {
      const r = destroyMessage(id);
      if (!r) continue;
      if (r.fileId) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.fileId)); } catch {} }
      broadcastMembers(conversation_id, { type: 'message:update', message: enrich(r.message) });
    }
    for (const s of dueScheduled()) onScheduledDue(s);
  }, 2000).unref?.();

  return wss;
};

// Kèm bản sao cho chính mình (nếu có) khi đồng bộ — thiết bị mới đọc được tin 1-1 cũ.
const withSelfCopy = (m, userId) => { const c = getSelfCopy(m.id, userId); return c ? { ...m, selfCopy: c } : m; };

// Tin hệ thống (sự kiện nhóm) hiển thị trong dòng thời gian, không mã hóa.
// ---- Lịch sử cuộc gọi ----
// Server vốn đã chuyển tiếp tín hiệu nên biết ai gọi ai, lúc nào, bắt máy hay không (KHÔNG thấy media).
// Kết thúc cuộc gọi -> chèn tin type 'call' vào hội thoại 1-1 (body JSON, không mã hóa).
const calls = new Map();   // callId -> { callerId, calleeId, video, startedAt, answeredAt, calleeWs, timer }

// TURN Cloudflare chỉ cho cuộc gọi thật. Trả khóa cuộc gọi nếu hợp lệ, null nếu không.
//  - Người gọi: { callId, peer } — người nhận tồn tại, đang trực tuyến, không chặn nhau, callId chưa thuộc người khác.
//  - Người nghe: { callId } — cuộc gọi đang đổ chuông / đã nhận, và mình là người nhận.
//  - Gọi nhóm: { group } — thành viên của nhóm (không phải kênh).
export function turnEligible(userId, q = {}) {
  const callId = String(q.callId || '');
  if (q.group) {
    const conv = getConversation(String(q.group));
    return conv && conv.type === 'group' && !conv.is_channel && isMember(conv.id, userId) && conversationMembers(conv.id).length >= 2 ? 'g:' + conv.id : null;
  }
  if (!callId || callId.length > 64 || callId.startsWith('g:')) return null;
  const c = calls.get(callId);
  if (!q.peer) return c && c.calleeId === userId ? callId : null;
  const peer = getUserByUsername(String(q.peer).toLowerCase());
  if (!peer || peer.id === userId || peer.banned || !isOnline(peer.id)) return null;
  if (isBlocked(peer.id, userId) || isBlocked(userId, peer.id)) return null;
  if (c && c.callerId !== userId) return null;
  return callId;
}
setLiveCheck((key, userId) => {
  if (key.startsWith('g:')) {          // gọi nhóm thật: mình đang trong phòng VÀ có ít nhất một người khác
    const ids = new Set([...(rooms.get(key.slice(2))?.peers.values() || [])].map((p) => p.userId));
    return ids.has(userId) && ids.size >= 2;
  }
  const c = calls.get(key);
  return !!c && (c.callerId === userId || c.calleeId === userId);
});
const RING_TIMEOUT_MS = Number(process.env.RING_TIMEOUT_MS) || 45_000;

function callOffer(ws, to, data) {
  const id = String(data.callId || '');
  if (!id || id.length > 64 || calls.has(id)) return;
  const timer = setTimeout(() => {   // không ai bắt máy -> báo cả hai bên dừng đổ chuông
    const c = calls.get(id);
    if (!c || c.answeredAt) return;
    const caller = getUserById(c.callerId);
    sendTo(c.calleeId, { type: 'signal', from: caller?.username, data: { callId: id, kind: 'hangup', reason: 'timeout' } });
    sendTo(c.callerId, { type: 'signal', from: to.username, data: { callId: id, kind: 'reject', reason: 'timeout' } });
    callEnd(id, 'timeout');
  }, RING_TIMEOUT_MS);
  timer.unref?.();
  calls.set(id, { callerId: ws.userId, calleeId: to.id, video: !!data.video, startedAt: Date.now(), timer });
}

function callAnswer(ws, callId) {
  const c = calls.get(callId);
  if (!c || c.answeredAt || ws.userId !== c.calleeId) return;
  c.answeredAt = Date.now();
  c.calleeWs = ws;
  clearTimeout(c.timer);
  // Các thiết bị khác của người nhận ngừng đổ chuông.
  const caller = getUserById(c.callerId);
  const stop = JSON.stringify({ type: 'signal', from: caller?.username, data: { callId, kind: 'hangup', reason: 'elsewhere' } });
  for (const other of online.get(c.calleeId) || []) if (other !== ws && other.readyState === other.OPEN) other.send(stop);
}

// reason: hangup | rejected | busy | quiet | offline | timeout | dropped
function callEnd(callId, reason, byUserId = null) {
  revokeCallTurn(callId);
  const c = calls.get(callId);
  if (!c) return;
  calls.delete(callId);
  clearTimeout(c.timer);
  const now = Date.now();
  let status;
  if (c.answeredAt) status = 'answered';
  else if (reason === 'rejected' && byUserId === c.calleeId) status = 'declined';
  else if (reason === 'busy' || reason === 'quiet' || reason === 'offline') status = reason === 'offline' ? 'missed' : reason;
  else if (byUserId === c.callerId && reason === 'hangup') status = 'cancelled';
  else status = 'missed';
  const caller = getUserById(c.callerId);
  const body = JSON.stringify({
    callId, status, video: c.video, by: caller?.username,
    duration: c.answeredAt ? Math.round((now - c.answeredAt) / 1000) : 0,
  });
  const conversationId = ensureDirectConversation(c.callerId, c.calleeId);
  const m = insertMessage({ conversationId, senderId: c.callerId, body, enc: false, type: 'call' });
  broadcastMembers(conversationId, { type: 'message', message: enrich(m) });
  if (status !== 'answered') pushNewMessage(m, [c.calleeId], isOnline);   // cuộc gọi nhỡ -> đẩy cho người nhận
}

// Một bên mất kết nối hẳn (đóng app) -> chốt các cuộc gọi đang dở của người đó.
function dropCallsOf(userId, ws) {
  for (const [id, c] of calls) {
    const involved = c.callerId === userId || c.calleeId === userId;
    if (!involved) continue;
    if (c.calleeWs && c.calleeId === userId && c.calleeWs !== ws) continue;   // thiết bị khác đang nghe máy
    if (!c.calleeWs && c.calleeId === userId && isOnline(userId)) continue;   // thiết bị khác vẫn đang đổ chuông
    const peerId = c.callerId === userId ? c.calleeId : c.callerId;
    const me = getUserById(userId);
    sendTo(peerId, { type: 'signal', from: me?.username, data: { callId: id, kind: 'hangup', reason: 'dropped' } });
    callEnd(id, 'dropped', userId);
  }
}

// ---- Cuộc gọi nhóm (mesh WebRTC, tối đa GCALL_MAX người) ----
// Server chỉ giữ danh sách ai đang trong phòng + chuyển tín hiệu tới ĐÚNG thiết bị (pid), không thấy media.
const GCALL_MAX = Number(process.env.GCALL_MAX) || 6;
const rooms = new Map();   // conversationId -> { callId, video, by, startedAt, peak, peers: Map<pid,{ws,userId,username}> }

const roomInfo = (conversationId, room, extra = {}) => ({
  type: 'gcall:active', conversationId, callId: room?.callId || null, video: !!room?.video,
  by: room ? getUserById(room.by)?.username : null,
  participants: room ? [...room.peers.values()].map((p) => p.username) : [], ...extra,
});

function gcallJoin(ws, msg) {
  const conversationId = String(msg.conversationId || '');
  const conv = getConversation(conversationId);
  if (!conv || conv.type !== 'group' || !isMember(conversationId, ws.userId)) throw new Error('Không thuộc nhóm này');
  if (conv.is_channel) throw new Error('Kênh không có cuộc gọi nhóm');
  if (ws.gcall) gcallLeave(ws);
  let room = rooms.get(conversationId);
  // Vào lại sau khi rớt mạng: phòng đã kết thúc thì KHÔNG mở phòng mới (tránh đổ chuông cả nhóm).
  if (!room && msg.rejoin) { ws.send(JSON.stringify({ type: 'gcall:ended', conversationId, reason: 'over' })); return; }
  const created = !room;
  if (!room) {
    room = { callId: 'g_' + crypto.randomUUID().slice(0, 12), video: !!msg.video, by: ws.userId, startedAt: Date.now(), peak: 0, peers: new Map() };
    rooms.set(conversationId, room);
  }
  // Cùng tài khoản vào từ thiết bị khác -> thiết bị cũ rời phòng.
  for (const p of [...room.peers.values()]) if (p.userId === ws.userId) {
    p.ws.send(JSON.stringify({ type: 'gcall:ended', conversationId, reason: 'elsewhere' }));
    gcallLeave(p.ws);
  }
  if (room.peers.size >= GCALL_MAX) throw new Error(`Cuộc gọi nhóm đã đủ ${GCALL_MAX} người`);
  const pid = crypto.randomUUID().slice(0, 8);
  const others = [...room.peers.entries()].map(([id, p]) => ({ pid: id, username: p.username }));
  room.peers.set(pid, { ws, userId: ws.userId, username: ws.username });
  room.peak = Math.max(room.peak, room.peers.size);
  ws.gcall = { conversationId, pid };
  ws.send(JSON.stringify({ type: 'gcall:joined', conversationId, callId: room.callId, video: room.video, pid, peers: others }));
  for (const [id, p] of room.peers) if (id !== pid) p.ws.send(JSON.stringify({ type: 'gcall:peer', conversationId, pid, username: ws.username, joined: true }));
  // ring: chỉ lần mở phòng -> các thành viên khác đổ chuông.
  broadcastMembers(conversationId, roomInfo(conversationId, room, created ? { ring: true } : {}));
}

function gcallLeave(ws) {
  const g = ws.gcall;
  if (g && ![...(rooms.get(g.conversationId)?.peers.values() || [])].some((p) => p.ws !== ws && p.userId === ws.userId)) revokeCallTurn('g:' + g.conversationId, ws.userId);
  if (!g) return;
  ws.gcall = null;
  const room = rooms.get(g.conversationId);
  if (!room || !room.peers.delete(g.pid)) return;
  for (const p of room.peers.values()) if (p.ws.readyState === p.ws.OPEN)
    p.ws.send(JSON.stringify({ type: 'gcall:peer', conversationId: g.conversationId, pid: g.pid, username: ws.username, joined: false }));
  if (room.peers.size === 0) {
    rooms.delete(g.conversationId);
    const body = JSON.stringify({
      callId: room.callId, group: true, video: room.video, by: getUserById(room.by)?.username,
      status: room.peak > 1 ? 'answered' : 'missed', peak: room.peak,
      duration: Math.round((Date.now() - room.startedAt) / 1000),
    });
    const m = insertMessage({ conversationId: g.conversationId, senderId: room.by, body, enc: false, type: 'call' });
    broadcastMembers(g.conversationId, { type: 'message', message: enrich(m) });
    broadcastMembers(g.conversationId, roomInfo(g.conversationId, null));
  } else broadcastMembers(g.conversationId, roomInfo(g.conversationId, room));
}

function systemMessage(ws, conversationId, text) {
  const s = insertMessage({ conversationId, senderId: ws.userId, body: text, enc: false, type: 'system' });
  broadcastMembers(conversationId, { type: 'message', message: enrich(s) });
}

async function handle(ws, msg) {
  switch (msg.type) {
    // Đồng bộ theo lô 500: tin mới (seq > sinceSeq) + thay đổi của tin đã biết (mod_seq > sinceMod).
    // `more` = còn nữa -> client gửi tiếp với mốc mới (trước đây chỉ 1 lô, offline lâu sẽ mất tin).
    case 'sync': {
      const sinceSeq = Number(msg.sinceSeq) || 0;
      const rows = messagesSince(ws.userId, sinceSeq);
      const changes = sinceSeq > 0 ? messagesChangedSince(ws.userId, sinceSeq, Number(msg.sinceMod) || 0) : [];
      const more = rows.length >= 500 || changes.length >= 500;
      ws.send(JSON.stringify({ type: 'sync:batch', more,
        messages: [...changes, ...rows].map((r) => withSelfCopy(enrich(r), ws.userId)) }));
      return;
    }

    // Phân trang lịch sử từ server (thiết bị mới / cache bị xóa): tin cũ hơn beforeSeq.
    case 'history': {
      const conv = msg.conversationId;
      if (!conv || !isMember(conv, ws.userId)) return;
      const limit = Math.min(Math.max(Number(msg.limit) || 50, 1), 200);
      const rows = messagesBefore(conv, Number(msg.beforeSeq) || 0, limit);
      ws.send(JSON.stringify({ type: 'history', conversationId: conv, hasMore: rows.length >= limit,
        messages: rows.map((r) => withSelfCopy(enrich(r), ws.userId)) }));
      return;
    }

    // Thiết bị xác nhận ĐÃ xóa bản cục bộ của tin tự hủy -> báo cho mọi thành viên (người gửi xem được).
    case 'destruct:ack': {
      const done = [];
      for (const id of (msg.ids || []).slice(0, 200)) {
        const m = getMessageById(String(id));
        if (!m || !m.expire_at || !m.recalled || !isMember(m.conversation_id, ws.userId)) continue;
        if (msg.query) { ws.send(JSON.stringify({ type: 'destruct:acks', messageId: m.id, acks: destructAcks(m.id) })); continue; }
        addDestructAck(m.id, ws.userId, String(msg.deviceId || 'unknown').slice(0, 40));
        done.push(m.id);
        broadcastMembers(m.conversation_id, { type: 'destruct:acks', messageId: m.id, acks: destructAcks(m.id) });
      }
      ws.send(JSON.stringify({ type: 'destruct:acked', ids: done }));
      return;
    }

    // Danh sách hội thoại kèm thành viên (để client biết tên nhóm, ai là ai).
    case 'conversations': {
      const list = listConversationsForUser(ws.userId).map((c) => serializeConversation(c));
      ws.send(JSON.stringify({ type: 'conversations', conversations: list }));
      return;
    }

    case 'group:create': {
      const title = String(msg.title || 'Nhóm mới').slice(0, 80);
      assertClean(title, 'Tên nhóm');
      const names = memberList(msg.members);
      if (GROUP_MAX_MEMBERS > 0 && names.length + 1 > GROUP_MAX_MEMBERS) throw new Error(`Nhóm tối đa ${GROUP_MAX_MEMBERS} thành viên`);
      const ids = [];
      for (const uname of names) {
        const u = getUserByUsername(uname);
        if (u && u.id !== ws.userId && !isBlocked(u.id, ws.userId) && !ids.includes(u.id)) ids.push(u.id);   // người đã chặn mình: không kéo vào nhóm
      }
      const conv = createGroup(title, ws.userId, ids);
      const payload = { type: 'conversation:new', conversation: serializeConversation(conv) };
      for (const uid of conversationMembers(conv.id)) sendTo(uid, payload);
      return;
    }

    // ---- Quản lý nhóm: đổi tên / thêm / rời / mời ra + tin hệ thống ----
    case 'group:rename': {
      const c = getConversation(msg.conversationId);
      if (!c || c.type !== 'group' || !isMember(c.id, ws.userId)) return;
      const title = String(msg.title || '').trim().slice(0, 80);
      if (!title) return;
      assertClean(title, 'Tên nhóm');
      const conv = renameGroup(c.id, title);
      broadcastMembers(c.id, { type: 'conversation:update', conversation: serializeConversation(conv), by: ws.username });
      systemMessage(ws, c.id, `@${ws.username} đã đổi tên nhóm thành “${title}”`);
      return;
    }
    case 'group:add': {
      const c = getConversation(msg.conversationId);
      if (!c || c.type !== 'group' || !isMember(c.id, ws.userId)) return;
      if (c.is_channel) throw new Error('Kênh: người dùng tự theo dõi, không thêm thủ công');
      const fresh = memberList(msg.members)
        .map((u) => getUserByUsername(u))
        .filter((u, i, a) => u && !isMember(c.id, u.id) && !isBlocked(u.id, ws.userId) && a.findIndex((x) => x?.id === u.id) === i);
      if (!fresh.length) throw new Error('Không có thành viên mới hợp lệ');
      if (groupFull(c.id, fresh.length)) throw new Error(`Nhóm tối đa ${GROUP_MAX_MEMBERS} thành viên`);
      if (c.approval && !isGroupAdmin(c, ws.userId)) {
        for (const u of fresh) addJoinRequest(c.id, u.id, ws.userId);
        broadcastMembers(c.id, { type: 'conversation:update', conversation: serializeConversation(getConversation(c.id)), by: ws.username, pendingAdded: fresh.map((u) => u.username) });
        ws.send(JSON.stringify({ type: 'group:pending', conversationId: c.id, usernames: fresh.map((u) => u.username) }));
        return;
      }
      for (const u of fresh) removeJoinRequest(c.id, u.id);
      addMembers(c.id, fresh.map((u) => u.id));
      broadcastMembers(c.id, { type: 'conversation:update', conversation: serializeConversation(getConversation(c.id)),
        by: ws.username, added: fresh.map((u) => u.username) });
      systemMessage(ws, c.id, `@${ws.username} đã thêm ${fresh.map((u) => '@' + u.username).join(', ')} vào nhóm`);
      return;
    }
    // ---- Quyền nhóm: phó nhóm, chuyển trưởng nhóm, ảnh nhóm, cài đặt, duyệt thành viên ----
    case 'group:role':
    case 'group:transfer':
    case 'group:avatar':
    case 'group:settings':
    case 'group:approve': {
      const c = getConversation(msg.conversationId);
      if (!c || c.type !== 'group' || c.is_channel || !isMember(c.id, ws.userId)) throw new Error('Không thuộc nhóm này');
      const owner = c.owner_id === ws.userId, admin = isGroupAdmin(c, ws.userId);
      const target = msg.username ? getUserByUsername(String(msg.username).toLowerCase().replace(/^@+/, '')) : null;
      const update = (extra = {}) => broadcastMembers(c.id, { type: 'conversation:update', conversation: serializeConversation(getConversation(c.id)), by: ws.username, ...extra });
      if (msg.type === 'group:role') {
        if (!owner) throw new Error('Chỉ trưởng nhóm được bổ nhiệm phó nhóm');
        if (!target || target.id === ws.userId || !isMember(c.id, target.id)) throw new Error('Không tìm thấy thành viên');
        const on = msg.role === 'deputy';
        setMemberRole(c.id, target.id, on ? 'deputy' : null);
        update();
        systemMessage(ws, c.id, on ? `@${ws.username} đã bổ nhiệm @${target.username} làm phó nhóm` : `@${ws.username} đã gỡ quyền phó nhóm của @${target.username}`);
      } else if (msg.type === 'group:transfer') {
        if (!owner) throw new Error('Chỉ trưởng nhóm được chuyển quyền');
        if (!target || target.id === ws.userId || !isMember(c.id, target.id)) throw new Error('Không tìm thấy thành viên');
        setOwner(c.id, target.id); setMemberRole(c.id, target.id, null);
        update();
        systemMessage(ws, c.id, `@${ws.username} đã chuyển quyền trưởng nhóm cho @${target.username}`);
      } else if (msg.type === 'group:avatar') {
        if (!admin) throw new Error('Chỉ trưởng nhóm / phó nhóm được đổi ảnh nhóm');
        const av = msg.avatar ? String(msg.avatar) : null;
        if (av && (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(av) || av.length > 300_000)) throw new Error('Ảnh nhóm không hợp lệ hoặc quá lớn');
        setGroupAvatar(c.id, av);
        update();
        systemMessage(ws, c.id, `@${ws.username} đã ${av ? 'đổi' : 'xóa'} ảnh nhóm`);
      } else if (msg.type === 'group:settings') {
        if (!admin) throw new Error('Chỉ trưởng nhóm / phó nhóm được đổi cài đặt nhóm');
        setGroupSettings(c.id, { approval: msg.approval, adminOnly: msg.adminOnly });
        update();
        const parts = [];
        if (msg.approval != null) parts.push(msg.approval ? 'bật duyệt thành viên mới' : 'tắt duyệt thành viên mới');
        if (msg.adminOnly != null) parts.push(msg.adminOnly ? 'chỉ cho trưởng/phó nhóm gửi tin' : 'cho mọi thành viên gửi tin');
        if (parts.length) systemMessage(ws, c.id, `@${ws.username} đã ${parts.join(', ')}`);
      } else {   // group:approve
        if (!admin) throw new Error('Chỉ trưởng nhóm / phó nhóm được duyệt thành viên');
        if (!target || !removeJoinRequest(c.id, target.id)) throw new Error('Không có yêu cầu tham gia này');
        if (msg.accept && !isMember(c.id, target.id)) {
          if (groupFull(c.id, 1)) throw new Error(`Nhóm tối đa ${GROUP_MAX_MEMBERS} thành viên`);
          addMembers(c.id, [target.id]);
          update({ added: [target.username] });                  // người duyệt (đang giữ khóa nhóm) chia khóa cho người mới
          systemMessage(ws, c.id, `@${ws.username} đã duyệt @${target.username} vào nhóm`);
        } else update();
      }
      return;
    }
    // ---- Kênh công khai ----
    case 'channel:create': {
      const title = String(msg.title || '').trim().slice(0, 80);
      const handle = String(msg.handle || '').toLowerCase().replace(/^@/, '').trim();
      if (!title) throw new Error('Thiếu tên kênh');
      assertClean(title, 'Tên kênh'); assertClean(msg.description, 'Mô tả kênh'); assertClean(msg.handle, 'Mã kênh');
      if (!/^[a-z0-9_]{3,30}$/.test(handle)) throw new Error('Mã kênh 3-30 ký tự a-z, 0-9, _');
      if (getChannelByHandle(handle) || getUserByUsername(handle)) throw new Error('Mã kênh @' + handle + ' đã có');
      const conv = createGroup(title, ws.userId, []);
      makeChannel(conv.id, handle, String(msg.description || '').slice(0, 300));
      sendTo(ws.userId, { type: 'conversation:new', conversation: serializeConversation(getConversation(conv.id)) });
      return;
    }
    case 'channel:search': {
      const items = searchChannels(msg.q).map((c) => ({ id: c.id, title: c.title, handle: c.handle, description: c.description || '',
        subscribers: channelCount(c.id), joined: isMember(c.id, ws.userId), owner: getUserById(c.owner_id)?.username }));
      ws.send(JSON.stringify({ type: 'channel:results', q: msg.q || '', items }));
      return;
    }
    case 'channel:join': {
      const c = msg.handle ? getChannelByHandle(msg.handle) : getConversation(msg.id);
      if (!c?.is_channel) throw new Error('Không tìm thấy kênh');
      if (!isMember(c.id, ws.userId)) addMembers(c.id, [ws.userId]);
      // Chỉ báo cho chính người theo dõi (không phát tới cả kênh).
      sendTo(ws.userId, { type: 'conversation:new', conversation: serializeConversation(getConversation(c.id)) });
      ws.send(JSON.stringify({ type: 'channel:joined', conversationId: c.id }));
      return;
    }

    // ---- Phòng họp: tạo nhóm ẩn danh nghĩa + link mời; người có link vào thẳng cuộc gọi ----
    case 'meet:create': {
      const title = String(msg.title || '').trim().slice(0, 80) || `Phòng họp của @${ws.username}`;
      const conv = createGroup(title, ws.userId, []);
      makeMeeting(conv.id);
      const inv = createInvite(conv.id, ws.userId);
      sendTo(ws.userId, { type: 'conversation:new', conversation: serializeConversation(getConversation(conv.id)) });
      ws.send(JSON.stringify({ type: 'meet:created', conversationId: conv.id, code: inv.code, expiresAt: inv.expiresAt }));
      return;
    }

    // ---- Link mời vào nhóm (chỉ trưởng nhóm tạo/thu hồi; ai có mã đều xem trước + tham gia được) ----
    case 'invite:create':
    case 'invite:get':
    case 'invite:revoke': {
      const c = getConversation(msg.conversationId);
      if (!c || c.type !== 'group' || !isMember(c.id, ws.userId)) return;
      if (c.owner_id !== ws.userId) throw new Error('Chỉ trưởng nhóm quản lý link mời');
      if (c.is_channel) throw new Error('Kênh dùng link reachat://c/' + c.handle);
      if (msg.type === 'invite:revoke') revokeInvites(c.id);
      const inv = msg.type === 'invite:create' ? createInvite(c.id, ws.userId) : msg.type === 'invite:get' ? activeInvite(c.id) : null;
      ws.send(JSON.stringify({ type: 'invite', conversationId: c.id, code: inv?.code || null, expiresAt: inv?.expiresAt || inv?.expires_at || null }));
      return;
    }
    case 'invite:preview': {
      const inv = getInvite(msg.code);
      const c = inv && getConversation(inv.conversation_id);
      if (!c) { ws.send(JSON.stringify({ type: 'invite:preview', code: msg.code, valid: false })); return; }
      const members = conversationMembers(c.id);
      ws.send(JSON.stringify({ type: 'invite:preview', code: inv.code, valid: true, conversationId: c.id, title: c.title,
        memberCount: members.length, by: getUserById(inv.created_by)?.username, already: members.includes(ws.userId),
        meeting: !!c.is_meeting, inCall: rooms.get(c.id)?.peers.size || 0 }));
      return;
    }
    case 'invite:join': {
      const inv = getInvite(msg.code);
      const c = inv && getConversation(inv.conversation_id);
      if (!c) throw new Error('Link mời không hợp lệ hoặc đã hết hạn');
      if (!isMember(c.id, ws.userId)) {
        if (isBlocked(c.owner_id, ws.userId)) throw new Error('Bạn không thể tham gia nhóm này');
        if (groupFull(c.id, 1)) throw new Error(`Nhóm tối đa ${GROUP_MAX_MEMBERS} thành viên`);
        if (c.approval && !c.is_meeting) {
          addJoinRequest(c.id, ws.userId, ws.userId);
          broadcastMembers(c.id, { type: 'conversation:update', conversation: serializeConversation(getConversation(c.id)), by: ws.username, pendingAdded: [ws.username] });
          ws.send(JSON.stringify({ type: 'invite:pending', conversationId: c.id, title: c.title }));
          return;
        }
        addMembers(c.id, [ws.userId]);
        useInvite(inv.code);
        // via:'invite' -> trưởng nhóm (máy đang mở) chia khóa nhóm cho người mới.
        broadcastMembers(c.id, { type: 'conversation:update', conversation: serializeConversation(getConversation(c.id)),
          by: ws.username, added: [ws.username], via: 'invite' });
        systemMessage(ws, c.id, c.is_meeting ? `@${ws.username} đã vào phòng họp` : `@${ws.username} đã tham gia nhóm qua link mời`);
      }
      ws.send(JSON.stringify({ type: 'invite:joined', conversationId: c.id }));
      return;
    }

    case 'group:leave':
    case 'group:kick': {
      const c = getConversation(msg.conversationId);
      if (!c || c.type !== 'group' || !isMember(c.id, ws.userId)) return;
      if (c.is_channel) {
        if (msg.type === 'group:kick' || c.owner_id === ws.userId) throw new Error('Chủ kênh không rời kênh của mình');
        removeMember(c.id, ws.userId);
        sendTo(ws.userId, { type: 'conversation:removed', conversationId: c.id, channel: true });
        return;
      }
      let target = ws.userId, targetName = ws.username;
      if (msg.type === 'group:kick') {
        const u = getUserByUsername(String(msg.username || '').toLowerCase());
        if (!u || u.id === ws.userId || !isMember(c.id, u.id)) return;
        if (c.owner_id !== ws.userId && !(isGroupAdmin(c, ws.userId) && !isGroupAdmin(c, u.id)))
          throw new Error('Chỉ trưởng nhóm (hoặc phó nhóm với thành viên thường) được mời ra khỏi nhóm');
        target = u.id; targetName = u.username;
      }
      // Tin hệ thống gửi TRƯỚC khi xóa để người rời cũng thấy.
      systemMessage(ws, c.id, msg.type === 'group:kick' ? `@${ws.username} đã mời @${targetName} ra khỏi nhóm` : `@${targetName} đã rời nhóm`);
      removeMember(c.id, target);
      const room = rooms.get(c.id);                                      // rời/bị mời ra -> ra khỏi cuộc gọi nhóm
      for (const p of room ? [...room.peers.values()] : []) if (p.userId === target) {
        p.ws.send(JSON.stringify({ type: 'gcall:ended', conversationId: c.id, reason: 'removed' }));
        gcallLeave(p.ws);
      }
      const rest = conversationMembers(c.id);
      if (c.owner_id === target && rest.length) {                          // trưởng nhóm rời -> ưu tiên phó nhóm
        const dep = rest.find((uid) => isGroupAdmin({ id: c.id, owner_id: null }, uid));
        setOwner(c.id, dep || rest[0]); setMemberRole(c.id, dep || rest[0], null);
      }
      sendTo(target, { type: 'conversation:removed', conversationId: c.id });
      broadcastMembers(c.id, { type: 'conversation:update', conversation: serializeConversation(getConversation(c.id)),
        by: ws.username, removed: [targetName] });
      return;
    }
    // Thành viên mới: tải toàn bộ lịch sử của một hội thoại.
    case 'sync:conv': {
      if (!msg.conversationId || !isMember(msg.conversationId, ws.userId)) return;
      ws.send(JSON.stringify({ type: 'sync:batch', messages: conversationMessages(msg.conversationId).map((r) => withSelfCopy(enrich(r), ws.userId)) }));
      return;
    }

    case 'send': {
      if (tooLong(msg.body)) throw new Error(`Tin nhắn quá dài (tối đa ${MAX_MSG_KB} KB)`);
      let conversationId;
      let targetUsername = null;
      const type = msgTypeOf(msg.msgType);
      if (msg.conversationId) {
        conversationId = String(msg.conversationId);
        const cc = assertCanPost(ws.userId, conversationId, { enc: !!msg.enc, type, body: msg.body });
        if (cc?.type === 'direct') targetUsername = getUserById(conversationMembers(conversationId).find((uid) => uid !== ws.userId))?.username || null;
      } else {
        const to = getUserByUsername(String(msg.to || '').toLowerCase());
        if (!to) throw new Error('Người nhận không tồn tại');
        if (isBlocked(to.id, ws.userId)) throw new Error('Bạn đã bị người này chặn');
        if (isBlocked(ws.userId, to.id)) throw new Error('Bạn đã chặn người này');
        conversationId = ensureDirectConversation(ws.userId, to.id);
        targetUsername = to.username;
      }
      const stored = insertMessage({
        conversationId,
        senderId: ws.userId,
        body: String(msg.body ?? ''),
        enc: !!msg.enc,
        type,
        replyTo: msg.replyTo || null,
        ttlMs: Number(msg.ttl) > 0 ? Number(msg.ttl) : null,   // tin tự hủy
      });
      const payload = { type: 'message', message: enrich(stored) };

      let deliveredToOther = false;
      const members = conversationMembers(conversationId);
      for (const uid of members) {
        const sent = sendTo(uid, payload);
        if (uid !== ws.userId && sent) deliveredToOther = true;
      }
      pushWebhooks(stored, members);                       // bot trong hội thoại có webhook -> báo ngay
      pushNewMessage(stored, members, isOnline);           // người không mở app (PWA) -> thông báo đẩy
      // Tự động trả lời (chỉ hội thoại 1-1; người nhận đang đặt trạng thái + bật tự trả lời)
      if (targetUsername) {
        const other = members.find((uid) => uid !== ws.userId);
        const ar = other && autoReplyFor(other, ws.userId);
        if (ar) setTimeout(() => {
          const auto = insertMessage({ conversationId, senderId: other, body: ar, enc: false, type: 'autoreply' });
          for (const uid of members) sendTo(uid, { type: 'message', message: enrich(auto) });
        }, 600);
      }
      ws.send(JSON.stringify({ type: 'ack', ref: msg.ref, message: enrich(stored) }));
      if (deliveredToOther) {
        ws.send(JSON.stringify({
          type: 'receipt', state: 'delivered',
          conversationId, seq: stored.seq,
        }));
      }
      return;
    }

    case 'read': {
      const conversationId = msg.conversationId;
      if (!conversationId || !isMember(conversationId, ws.userId)) return;
      setRead(conversationId, ws.userId, msg.seq || 0);
      if (getConversation(conversationId)?.is_channel) return;   // kênh: không lộ ai đã xem
      if (readReceiptsOn(ws.userId)) {
        const rc = { type: 'receipt', state: 'read', conversationId, userId: ws.userId, username: ws.username, lastReadSeq: msg.seq || 0 };
        for (const uid of conversationMembers(conversationId)) if (uid !== ws.userId && readReceiptsOn(uid)) sendTo(uid, rc);
        sendTo(ws.userId, rc);                                    // các thiết bị khác của mình vẫn đồng bộ đã đọc
      } else sendTo(ws.userId, { type: 'receipt', state: 'read', conversationId, userId: ws.userId, username: ws.username, lastReadSeq: msg.seq || 0 });
      checkWaiting('read', ws.userId);   // tin "gửi sau khi người này xem tin trước"
      return;
    }

    case 'typing': {
      const conversationId = msg.conversationId;
      if (!conversationId || !isMember(conversationId, ws.userId)) return;
      if (getConversation(conversationId)?.is_channel) return;
      broadcastMembers(conversationId, {
        type: 'typing', conversationId,
        userId: ws.userId, username: ws.username, isTyping: !!msg.isTyping,
      }, ws.userId);
      return;
    }

    case 'recall': {
      const m = getMessageById(msg.messageId);
      if (!m || !isMember(m.conversation_id, ws.userId)) return;          // đã rời nhóm -> không động vào tin cũ
      if (m.sender_id !== ws.userId) throw new Error('Chỉ thu hồi được tin của mình');
      const updated = recallMessage(m.id);
      broadcastMembers(m.conversation_id, { type: 'message:update', message: enrich(updated) });
      return;
    }

    // Ghim / bỏ ghim (dùng chung cho cả hội thoại). Gửi lại danh sách id đã ghim.
    case 'pin': {
      const m = getMessageById(msg.messageId);
      if (!m || !isMember(m.conversation_id, ws.userId)) return;
      if (ownerOnlyInChannel(m.conversation_id, ws.userId)) throw new Error('Chỉ chủ kênh được ghim');
      setPinned(m.id, !!msg.pinned);
      broadcastMembers(m.conversation_id, { type: 'pins', conversationId: m.conversation_id, ids: pinnedIds(m.conversation_id) });
      return;
    }
    case 'pins': {
      const conversationId = msg.conversationId;
      if (!conversationId || !isMember(conversationId, ws.userId)) return;
      ws.send(JSON.stringify({ type: 'pins', conversationId, ids: pinnedIds(conversationId) }));
      return;
    }

    case 'edit': {
      if (tooLong(msg.body)) throw new Error(`Tin nhắn quá dài (tối đa ${MAX_MSG_KB} KB)`);
      const m = getMessageById(msg.messageId);
      if (!m || !isMember(m.conversation_id, ws.userId)) return;
      if (m.sender_id !== ws.userId) throw new Error('Chỉ sửa được tin của mình');
      if (m.recalled) throw new Error('Tin đã thu hồi');
      if (m.type !== 'text') throw new Error('Chỉ sửa được tin văn bản');          // không sửa bình chọn/sự kiện/tệp sau khi gửi
      const updated = editMessage(m.id, String(msg.body ?? ''), !!msg.enc);
      broadcastMembers(m.conversation_id, { type: 'message:update', message: enrich(updated) });
      return;
    }

    case 'react': {
      const m = getMessageById(msg.messageId);
      if (!m || !isMember(m.conversation_id, ws.userId)) return;
      toggleReaction(m.id, ws.userId, String(msg.emoji || '').slice(0, 8));
      broadcastMembers(m.conversation_id, { type: 'message:update', message: enrich(getMessageById(m.id)) });
      return;
    }

    // Relay tín hiệu WebRTC (offer/answer/ice/hangup/reject) tới đúng người.
    // Server KHÔNG tham gia luồng media — chỉ chuyển gói signaling P2P.
    case 'gcall:join': gcallJoin(ws, msg); return;
    case 'gcall:leave': gcallLeave(ws); return;
    case 'gcall:list': {
      for (const [cid, room] of rooms) if (isMember(cid, ws.userId)) ws.send(JSON.stringify(roomInfo(cid, room)));
      return;
    }
    // Tín hiệu trong phòng: chỉ giữa hai thiết bị cùng phòng.
    case 'gsignal': {
      const g = ws.gcall;
      const room = g && rooms.get(g.conversationId);
      const target = room?.peers.get(String(msg.pid || ''));
      if (!target || target.ws === ws) return;
      target.ws.send(JSON.stringify({ type: 'gsignal', conversationId: g.conversationId, pid: g.pid, username: ws.username, data: msg.data }));
      return;
    }

    case 'signal': {
      const to = getUserByUsername(String(msg.to || '').toLowerCase());
      const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
      if (!to || to.id === ws.userId) return;
      if (JSON.stringify(data).length > 64 * 1024) return;                      // SDP/ICE thật chỉ vài KB
      const back = (d) => ws.send(JSON.stringify({ type: 'signal', from: to.username, data: { callId: data.callId, ...d } }));
      // Đã chặn (chiều nào cũng vậy): không chuyển bất kỳ tín hiệu nào.
      const blocked = isBlocked(to.id, ws.userId) || isBlocked(ws.userId, to.id);
      if (blocked && data.kind !== 'offer' && data.kind !== 'ft-offer') return;
      // Gửi tệp trực tiếp (P2P): người nhận offline / đã chặn -> báo ngay cho bên gửi (để chuyển sang gửi qua máy chủ).
      if (data.kind === 'ft-offer') {
        if (isBlocked(to.id, ws.userId) || isBlocked(ws.userId, to.id)) { back({ kind: 'ft-cancel', reason: 'unavailable' }); return; }
        if (!isOnline(to.id)) { back({ kind: 'ft-cancel', reason: 'offline' }); return; }
      }
      if (data.kind === 'offer') {
        // Bị chặn (chiều nào cũng vậy): không đổ chuông, không ghi lịch sử, không lộ lý do.
        if (isBlocked(to.id, ws.userId) || isBlocked(ws.userId, to.id)) { back({ kind: 'reject', reason: 'unavailable' }); return; }
        callOffer(ws, to, data);
        if (!isOnline(to.id)) { back({ kind: 'reject', reason: 'offline' }); callEnd(data.callId, 'offline'); return; }
      } else if (data.kind === 'answer') callAnswer(ws, data.callId);
      const c = calls.get(data.callId);
      const out = { type: 'signal', from: ws.username, data };
      // Sau khi một thiết bị bắt máy: tín hiệu của người gọi chỉ tới đúng thiết bị đó.
      if (c?.calleeWs && c.callerId === ws.userId && to.id === c.calleeId) {
        if (c.calleeWs.readyState === c.calleeWs.OPEN) c.calleeWs.send(JSON.stringify(out));
      } else sendTo(to.id, out);
      // Chỉ người trong cuộc gọi mới kết thúc được nó (không cho người ngoài biết callId cắt ngang / ghi lịch sử giả).
      if ((data.kind === 'hangup' || data.kind === 'reject') && c && (c.callerId === ws.userId || c.calleeId === ws.userId))
        callEnd(data.callId, data.kind === 'reject' ? (String(data.reason || 'rejected').slice(0, 20)) : 'hangup', ws.userId);
      return;
    }

    // ---- Đa thiết bị: lưu bản sao (mã hóa khóa cá nhân) + đẩy tới các thiết bị khác của MÌNH ----
    case 'copy:put': {
      const m = getMessageById(msg.messageId);
      if (!m || !isMember(m.conversation_id, ws.userId)) return;
      const data = String(msg.data || '');
      if (!data || data.length > 200000) return;
      if (putSelfCopy(m.id, ws.userId, data)) sendTo(ws.userId, { type: 'copy', messageId: m.id, data });
      return;
    }

    // Xin lại bản sao cho các tin đang lỗi (tự hồi phục khi bản sao tới trước/khi mở hội thoại).
    case 'copy:get': {
      const items = [];
      for (const id of (msg.ids || []).slice(0, 200)) {
        const m = getMessageById(String(id));
        if (!m || !isMember(m.conversation_id, ws.userId)) continue;
        const data = getSelfCopy(m.id, ws.userId);
        if (data) items.push({ messageId: m.id, data });
      }
      ws.send(JSON.stringify({ type: 'copies', items }));
      return;
    }

    // ---- Ghi chú soạn chung: relay + lưu nhật ký cập nhật mã hóa ----
    case 'doc:push': {
      const conv = msg.conversationId;
      if (!conv || !isMember(conv, ws.userId)) return;
      if (ownerOnlyInChannel(conv, ws.userId)) throw new Error('Kênh không có ghi chú chung');
      const data = String(msg.data || '');
      if (!data || data.length > 400000) throw new Error('Cập nhật ghi chú không hợp lệ');
      const id = pushDocUpdate(conv, data);
      broadcastMembers(conv, { type: 'doc:update', conversationId: conv, id, data, by: ws.username, clientId: msg.clientId });
      return;
    }
    case 'doc:pull': {
      const conv = msg.conversationId;
      if (!conv || !isMember(conv, ws.userId)) return;
      ws.send(JSON.stringify({ type: 'doc:snapshot', conversationId: conv, updates: docUpdates(conv) }));
      return;
    }
    case 'doc:compact': {
      const conv = msg.conversationId;
      if (!conv || !isMember(conv, ws.userId) || !msg.data || !(Number(msg.upto) > 0) || ownerOnlyInChannel(conv, ws.userId)) return;
      if (String(msg.data).length > 2_000_000) throw new Error('Ghi chú quá lớn');
      compactDoc(conv, Number(msg.upto), String(msg.data));
      return;
    }

    // ---- Giao việc (tiêu đề đã mã hóa phía client) ----
    case 'task:create': {
      const conv = msg.conversationId;
      if (!conv || !isMember(conv, ws.userId)) return;
      const cc = getConversation(conv);
      if (cc?.is_channel || (cc?.admin_only && !isGroupAdmin(cc, ws.userId))) throw new Error('Không có quyền giao việc ở đây');
      const titleEnc = String(msg.titleEnc || '');
      if (!titleEnc || titleEnc.length > 4000) throw new Error('Việc không hợp lệ');
      const assignee = msg.assignee ? String(msg.assignee).toLowerCase().replace(/^@+/, '') : null;
      if (assignee && !/^[a-z0-9_]{1,32}$/.test(assignee)) throw new Error('Người được giao không hợp lệ');
      createTask({ conversationId: conv, messageId: msg.messageId, titleEnc, assignee, dueAt: Number(msg.dueAt) || null, createdBy: ws.username });
      broadcastMembers(conv, { type: 'tasks', conversationId: conv, items: listTasks(conv) });
      systemMessage(ws, conv, assignee ? `📋 @${ws.username} đã giao một việc cho @${assignee}` : `📋 @${ws.username} đã tạo một việc cần làm`);
      return;
    }
    case 'task:toggle':
    case 'task:delete': {
      const t = getTask(msg.id);
      if (!t || !isMember(t.conversation_id, ws.userId)) return;
      if (msg.type === 'task:delete') {
        if (t.created_by !== ws.username) throw new Error('Chỉ người giao việc được xoá');
        deleteTask(t.id);
      } else {
        const u = toggleTask(t.id, ws.username);
        if (u.done) systemMessage(ws, t.conversation_id, `✅ @${ws.username} đã hoàn thành một việc`);
      }
      broadcastMembers(t.conversation_id, { type: 'tasks', conversationId: t.conversation_id, items: listTasks(t.conversation_id) });
      return;
    }
    case 'task:list': {
      if (!msg.conversationId || !isMember(msg.conversationId, ws.userId)) return;
      ws.send(JSON.stringify({ type: 'tasks', conversationId: msg.conversationId, items: listTasks(msg.conversationId) }));
      return;
    }

    // ---- Ảnh xem một lần: người nhận xem xong -> xoá file + thu hồi tin ----
    case 'once:viewed': {
      const m = getMessageById(msg.messageId);
      if (!m || m.recalled || m.type !== 'image' || !isMember(m.conversation_id, ws.userId) || m.sender_id === ws.userId) return;
      let meta = {}; try { meta = JSON.parse(m.body); } catch {}
      if (!meta.once) return;
      // Chỉ xóa tệp do chính người gửi tải lên (không cho dẫn fileId của người khác vào ảnh "xem một lần").
      if (meta.fileId && /^[\w-]+$/.test(meta.fileId) && getFile(meta.fileId)?.owner_id === m.sender_id) { try { fs.unlinkSync(path.join(UPLOAD_DIR, meta.fileId)); } catch {} }
      broadcastMembers(m.conversation_id, { type: 'message:update', message: enrich(markOnceViewed(m.id, ws.username)) });
      return;
    }

    // ---- Bình chọn (poll) ----
    case 'vote': {
      const m = getMessageById(msg.messageId);
      if (!m || m.type !== 'poll' || !isMember(m.conversation_id, ws.userId)) return;
      let opts = []; try { opts = JSON.parse(m.body).opts || []; } catch {}
      votePoll(m.id, ws.userId, Number(msg.option));
      broadcastMembers(m.conversation_id, { type: 'poll', messageId: m.id, tally: pollTally(m.id, opts.length) });
      return;
    }
    case 'rsvp':
    case 'rsvp:get': {
      const m = getMessageById(msg.messageId);
      if (!m || m.type !== 'event' || !isMember(m.conversation_id, ws.userId)) return;
      if (msg.type === 'rsvp') {
        if (msg.status != null && !['yes', 'maybe', 'no'].includes(msg.status)) return;
        setRsvp(m.id, ws.userId, msg.status || null);
        broadcastMembers(m.conversation_id, { type: 'event:rsvp', messageId: m.id, tally: rsvpTally(m.id) });
      } else ws.send(JSON.stringify({ type: 'event:rsvp', messageId: m.id, tally: rsvpTally(m.id) }));
      return;
    }
    case 'poll:get': {
      const m = getMessageById(msg.messageId);
      if (!m || m.type !== 'poll' || !isMember(m.conversation_id, ws.userId)) return;
      let opts = []; try { opts = JSON.parse(m.body).opts || []; } catch {}
      ws.send(JSON.stringify({ type: 'poll', messageId: m.id, tally: pollTally(m.id, opts.length) }));
      return;
    }

    // ---- Tin hẹn giờ gửi ----
    // Hẹn giờ / gửi có điều kiện. cond: {kind:'online'|'read'|'noreply', fallback?:'send'}; send_at là
    // hạn chờ (online/read) hoặc thời điểm kiểm tra (noreply). Nội dung đã mã hóa sẵn phía client.
    case 'schedule': {
      if (tooLong(msg.body)) throw new Error(`Tin nhắn quá dài (tối đa ${MAX_MSG_KB} KB)`);
      let conversationId = msg.conversationId, peer = null;
      if (!conversationId) {
        peer = getUserByUsername(String(msg.to || '').toLowerCase());
        if (!peer) throw new Error('Người nhận không tồn tại');
        if (isBlocked(peer.id, ws.userId) || isBlocked(ws.userId, peer.id)) throw new Error('Không gửi được (đã chặn)');
        conversationId = ensureDirectConversation(ws.userId, peer.id);
      } else conversationId = String(conversationId);
      const type = msgTypeOf(msg.msgType);
      assertCanPost(ws.userId, conversationId, { enc: !!msg.enc, type, body: msg.body });   // cùng luật với gửi ngay
      const sendAt = Number(msg.sendAt) || 0;
      if (sendAt <= Date.now()) throw new Error('Thời điểm hẹn phải ở tương lai');
      let cond = null;
      const kind = msg.cond?.kind;
      if (kind) {
        if (!['online', 'read', 'noreply'].includes(kind)) throw new Error('Điều kiện không hỗ trợ');
        if (kind !== 'noreply' && !peer) throw new Error('Điều kiện này chỉ dùng cho chat 1-1');
        // Không để "gửi khi online / khi đã xem" thành cách dò người đã ẩn trạng thái / tắt thông báo đã xem.
        if (kind === 'online' && presenceHidden(peer.id)) throw new Error('Người này ẩn trạng thái trực tuyến');
        if (kind === 'read' && !readReceiptsOn(peer.id)) throw new Error('Người này tắt thông báo đã xem');
        cond = { kind, fallback: msg.cond.fallback === 'send' ? 'send' : 'drop' };
        if (peer) cond.userId = peer.id;
        if (kind === 'noreply') cond.sinceSeq = lastSeqOf(conversationId);
        if (kind === 'read') cond.seq = lastSeqOf(conversationId, ws.userId);
      }
      if (listScheduled(ws.userId).length >= 200) throw new Error('Quá nhiều tin đang hẹn giờ');
      const s = createScheduled({ conversationId, senderId: ws.userId, body: String(msg.body ?? ''), enc: !!msg.enc, type, replyTo: msg.replyTo || null, sendAt, cond });
      ws.send(JSON.stringify({ type: 'scheduled', action: 'created', id: s.id, conversationId, sendAt, cond: cond?.kind || null }));
      // Điều kiện đã thỏa ngay lúc hẹn -> gửi luôn.
      if (kind === 'online' && isOnline(peer.id)) deliverScheduled(getScheduled(s.id));
      else if (kind === 'read' && readSeqOf(conversationId, peer.id) >= cond.seq) deliverScheduled(getScheduled(s.id));
      return;
    }
    case 'scheduled:list': {
      ws.send(JSON.stringify({ type: 'scheduled:list', items: listScheduled(ws.userId).map((r) => {
        let cond = null; try { cond = r.cond ? JSON.parse(r.cond) : null; } catch {}
        return { id: r.id, conversationId: r.conversation_id, body: r.body, type: r.type, sendAt: r.send_at,
          cond: cond ? { kind: cond.kind, fallback: cond.fallback } : null };
      }) }));
      return;
    }
    case 'scheduled:cancel': {
      deleteScheduled(msg.id, ws.userId);
      ws.send(JSON.stringify({ type: 'scheduled', action: 'cancelled', id: msg.id }));
      return;
    }

    case 'ping': ws.send(JSON.stringify({ type: 'pong' })); return;
    default: throw new Error(`Loại message không hỗ trợ: ${msg.type}`);
  }
}

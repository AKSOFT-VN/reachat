// Web shim: khi mở trong TRÌNH DUYỆT (không có preload của Electron), cung cấp
// window.reachat tương đương — serverUrl/wsUrl + "db" cache tin nhắn.
// Cache: giữ trong bộ nhớ (truy vấn tức thì) + lưu bền vào IndexedDB (dung lượng lớn, không giới hạn ~5 MB như localStorage).
// Chỉ ghi những tin vừa thay đổi (gom 300 ms) thay vì ghi lại toàn bộ. Dữ liệu cũ ở localStorage tự chuyển sang lần đầu.
// Trong Electron, window.reachat đã có từ preload nên shim không làm gì.
if (!window.reachat) {
  // Loopback IPv6 ([::1]) -> dùng localhost (server có thể chỉ trả lời qua IPv4).
  const host = ['[::1]', '::1', ''].includes(location.hostname) ? 'localhost' : location.hostname;
  const secure = location.protocol === 'https:';
  // Bản web do chính máy chủ phục vụ (/app) -> dùng cùng nguồn; chạy dev (vite) -> máy chủ cổng 4000.
  const sameOrigin = location.pathname.startsWith('/app');
  const serverUrl = sameOrigin ? location.origin : `${secure ? 'https' : 'http'}://${host}:4000`;
  const wsUrl = sameOrigin ? `${secure ? 'wss' : 'ws'}://${location.host}/ws` : `${secure ? 'wss' : 'ws'}://${host}:4000/ws`;

  let KEY = 'reachat.web.default';
  let store = { messages: [], meta: {} };
  let idb = null;                                   // IDBDatabase của tài khoản đang mở
  const dirty = new Set(), dirtyMeta = new Set(), removed = new Set();
  let flushT = null;
  const req = (r) => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  const openIdb = (name) => new Promise((ok, bad) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id' }); if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta'); };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
  // Ghi xuống IndexedDB các tin/meta đã đổi kể từ lần ghi trước.
  const flush = () => {
    flushT = null;
    if (!idb || (!dirty.size && !dirtyMeta.size && !removed.size)) return;
    try {
      const tx = idb.transaction(['messages', 'meta'], 'readwrite');
      const ms = tx.objectStore('messages'), mt = tx.objectStore('meta');
      const byId = new Map(store.messages.map((m) => [m.id, m]));
      for (const id of removed) ms.delete(id);
      for (const id of dirty) { const m = byId.get(id); if (m) ms.put(m); }
      for (const k of dirtyMeta) mt.put(store.meta[k], k);
      removed.clear(); dirty.clear(); dirtyMeta.clear();
    } catch (e) { console.warn('[cache] không ghi được IndexedDB:', e); }
  };
  const save = (ids = [], metaKeys = []) => {
    ids.forEach((id) => dirty.add(id)); metaKeys.forEach((k) => dirtyMeta.add(k));
    if (!flushT) flushT = setTimeout(flush, 300);
  };
  addEventListener('pagehide', flush);
  async function load() {
    store = { messages: [], meta: {} };
    try {
      idb = await openIdb(KEY);
      const tx = idb.transaction(['messages', 'meta'], 'readonly');
      const [msgs, keys, vals] = await Promise.all([req(tx.objectStore('messages').getAll()), req(tx.objectStore('meta').getAllKeys()), req(tx.objectStore('meta').getAll())]);
      store.messages = msgs; keys.forEach((k, i) => { store.meta[k] = vals[i]; });
      // Lần đầu: chuyển cache cũ từ localStorage sang IndexedDB rồi xóa bản cũ.
      const old = localStorage.getItem(KEY);
      if (old) {
        try { const o = JSON.parse(old); if (!store.messages.length) { store.messages = o.messages || []; store.meta = o.meta || {}; save(store.messages.map((m) => m.id), Object.keys(store.meta)); flush(); } } catch {}
        localStorage.removeItem(KEY);
      }
    } catch (e) {
      // Trình duyệt chặn IndexedDB (vd. chế độ riêng tư một số trình duyệt) -> chỉ dùng bộ nhớ, tải lại từ máy chủ khi mở app.
      console.warn('[cache] IndexedDB không dùng được, chỉ giữ trong bộ nhớ:', e); idb = null;
    }
  }

  const db = {
    async init(scopeKey) { flush(); KEY = 'reachat.web.' + scopeKey; await load(); return { maxSeq: db.maxSeq() }; },
    upsertMessage(m) {
      const i = store.messages.findIndex((x) => x.id === m.id);
      const row = {
        seq: m.seq ?? null, id: m.id, conversationId: m.conversationId, senderId: m.senderId,
        senderUsername: m.senderUsername ?? null, body: m.body, enc: !!m.enc, type: m.type || 'text',
        recalled: !!m.recalled, editedAt: m.editedAt ?? null, replyTo: m.replyTo ?? null,
        expireAt: m.expireAt ?? null, createdAt: m.createdAt,
        reactions: m.reactions !== undefined ? m.reactions : (i >= 0 ? store.messages[i].reactions ?? null : null),
      };
      if (i >= 0) store.messages[i] = row; else store.messages.push(row);
      save([row.id]);
    },
    getMessages(conversationId, limit = 40, before = null) {
      let rows = store.messages.filter((m) => m.conversationId === conversationId);
      if (before) rows = rows.filter((m) => m.createdAt < before);
      rows.sort((a, b) => a.createdAt - b.createdAt);
      return rows.slice(-limit);
    },
    getMessageById(id) { return store.messages.find((m) => m.id === id) || null; },
    searchMessages(q, limit = 50, f = {}) {
      const ql = String(q || '').toLowerCase(), kind = f.kind || 'text';
      const sender = f.sender ? String(f.sender).replace(/^@/, '').toLowerCase() : null;
      const okType = (m) => (kind === 'image' ? m.type === 'image' : kind === 'file' ? ['file', 'voice', 'video', 'p2pfile'].includes(m.type)
        : m.type === 'text' && (!ql || (m.body || '').toLowerCase().includes(ql)) && (kind !== 'link' || /https?:\/\//.test(m.body || '')));
      return store.messages.filter((m) => !m.recalled && !['[không giải mã được]', '[chưa có khóa nhóm]'].includes(m.body) && okType(m)
          && (!f.convId || m.conversationId === f.convId) && (!sender || m.senderUsername === sender)
          && (!f.from || m.createdAt >= f.from) && (!f.to || m.createdAt <= f.to))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
        .map((m) => ({ id: m.id, conversationId: m.conversationId, senderId: m.senderId, senderUsername: m.senderUsername, body: m.body, type: m.type, createdAt: m.createdAt }));
    },
    clearConversation(convId) {
      for (const m of store.messages) if (m.conversationId === convId) removed.add(m.id);
      store.messages = store.messages.filter((m) => m.conversationId !== convId); save(); return true;
    },
    listConversations(myId) {
      const by = {};
      for (const m of store.messages) {
        const c = (by[m.conversationId] ||= { conversationId: m.conversationId, lastAt: 0, preview: '', mine: 0 });
        if (m.senderId === myId) c.mine = 1;
        if (m.createdAt >= c.lastAt) {
          c.lastAt = m.createdAt;
          const label = { contact: '👤 Danh thiếp', poll: '📊 Bình chọn', call: '📞 Cuộc gọi', location: '📍 Vị trí', p2pfile: '📦 Tệp gửi trực tiếp', voice: '🎤 Tin thoại', video: '🎬 Video', autoreply: '🤖 Tự động trả lời', event: '📅 Sự kiện' }[m.type];
          c.preview = m.recalled ? '(đã thu hồi)' : ['text', 'system', 'sticker'].includes(m.type) ? m.body : (label || '[' + m.type + ']');
        }
      }
      return Object.values(by).sort((a, b) => b.lastAt - a.lastAt);
    },
    unreadCounts(myUserId) {
      const out = {};
      for (const m of store.messages) {
        if (m.senderId === myUserId || m.recalled) continue;
        const cursor = Number(store.meta['read.' + m.conversationId] || 0);
        if ((m.seq || 0) > cursor) out[m.conversationId] = (out[m.conversationId] || 0) + 1;
      }
      return out;
    },
    getMeta(key) { return store.meta[key] ?? null; },
    setMeta(key, value) { store.meta[key] = String(value); save([], [key]); },
    maxSeq() { return store.messages.reduce((a, m) => Math.max(a, m.seq || 0), 0); },
    purgeExpired(now) {
      const gone = [];
      for (const m of store.messages) if (m.expireAt && m.expireAt <= now && !m.recalled) { gone.push({ ...m }); m.body = ''; m.recalled = true; }
      if (gone.length) save(gone.map((m) => m.id));
      return gone;
    },
    listDmForBackfill() {
      return store.messages.filter((m) => m.conversationId.startsWith('dm_') && !m.recalled &&
        ((m.enc && ['text', 'sticker', 'contact'].includes(m.type)) || ['image', 'file', 'voice'].includes(m.type)));
    },
    exportMessages() { return store.messages.slice().sort((a, b) => a.createdAt - b.createdAt); },
    importMessages(list) {
      const FAIL = ['[không giải mã được]', '[chưa có khóa nhóm]', '[tin của bạn]'];
      let added = 0, fixed = 0;
      for (const m of list || []) {
        const cur = store.messages.find((x) => x.id === m.id);
        if ((cur && !FAIL.includes(cur.body)) || FAIL.includes(m.body)) continue;
        this.upsertMessage(m); cur ? fixed++ : added++;
      }
      return { added, fixed };
    },
    mediaOf(convId, kind) {
      const ok = (m) => (kind === 'image' ? m.type === 'image' : kind === 'file' ? ['file', 'voice', 'p2pfile'].includes(m.type) : m.type === 'text' && /https?:\/\//.test(m.body || ''));
      return store.messages.filter((m) => m.conversationId === convId && !m.recalled && ok(m)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300);
    },
    liveFileIds() {
      const ids = [];
      for (const m of store.messages) if (['image', 'file', 'voice'].includes(m.type) && !m.recalled) { try { const id = JSON.parse(m.body).fileId; if (id) ids.push(id); } catch {} }
      return ids;
    },
    failedDmIds() {
      return store.messages.filter((m) => m.conversationId.startsWith('dm_') && !m.recalled &&
        ['[không giải mã được]', '[chưa có khóa nhóm]', '[tin của bạn]'].includes(m.body)).map((m) => m.id);
    },
  };

  window.reachat = { serverUrl, wsUrl, db, web: true, transport: { secure, pinned: false } };
}

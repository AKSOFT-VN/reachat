// Service worker của bản web cài được (PWA): chạy app khi mất mạng (khung app) + nhận thông báo đẩy.
const CACHE = 'reachat-shell-v1';
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon-192.png'])).catch(() => {}));
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
// Mạng trước (luôn bản mới khi có mạng), rơi về bộ nhớ đệm khi mất mạng. Không đụng API/WebSocket/tệp.
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
});
// Thông báo đẩy: máy chủ chỉ gửi khi bạn không mở app; nội dung tin mã hóa nên chỉ báo "tin mới từ …".
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data?.json() || {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'ReaChat', {
    body: d.body || 'Tin nhắn mới', tag: d.tag, renotify: !!d.tag, icon: './icon-192.png', badge: './icon-192.png',
    data: { conversationId: d.conversationId || null }, requireInteraction: d.kind === 'call',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const cid = e.notification.data?.conversationId || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins[0]) { await wins[0].focus(); wins[0].postMessage({ type: 'open', conversationId: cid }); }
    else await self.clients.openWindow('./' + (cid ? '?c=' + encodeURIComponent(cid) : ''));
  })());
});

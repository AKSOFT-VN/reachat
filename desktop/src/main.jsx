import './webshim.js';   // PHẢI nạp trước App/api (đặt window.reachat khi chạy trên web)
import { startI18n } from './i18n.js';
import './turnmeter.js';
import { reportClientError } from './api.js';
// Lỗi JS không bắt được -> gửi về máy chủ (chỉ thông báo lỗi + vị trí trong mã, KHÔNG kèm nội dung tin nhắn).
// Trùng lặp chỉ gửi một lần; tối đa 20 lỗi mỗi lần mở app.
{
  const seen = new Set();
  const send = (message, stack) => {
    const key = String(message).slice(0, 200);
    if (seen.has(key) || seen.size >= 20) return;
    seen.add(key);
    reportClientError({ message: key, stack: String(stack || '').slice(0, 3000), version: window.reachat?.version || 'web', platform: window.reachat?.web ? 'web' : navigator.platform });
  };
  window.addEventListener('error', (e) => { if (e.message) send(e.message, e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`); });
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (r && !(r instanceof TypeError && /fetch/i.test(r.message))) send('Promise: ' + (r?.message || r), r?.stack); });
}   // đo lưu lượng TURN Cloudflare (hạn mức miễn phí)
startI18n();            // giao diện tiếng Anh (nếu đã chọn) — dịch trên DOM, không đụng nội dung tin
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

// Bản web cài được (PWA): service worker cho chạy khi mất mạng + thông báo đẩy. Chỉ khi do máy chủ phục vụ tại /app.
if (window.reachat?.web && 'serviceWorker' in navigator && location.pathname.startsWith('/app')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

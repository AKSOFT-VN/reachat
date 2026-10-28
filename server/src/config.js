// Cấu hình tập trung (biến môi trường — danh sách đầy đủ: docs/CONFIGURATION.md).
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PORT = Number(process.env.PORT || 4000);
export const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('../data.db', import.meta.url));
// Khóa ký phiên đăng nhập. Không đặt JWT_SECRET -> tự sinh khóa ngẫu nhiên, lưu cạnh CSDL (.jwt-secret, chỉ chủ tệp đọc được).
// TUYỆT ĐỐI không dùng khóa viết cứng trong mã nguồn: mã nguồn công khai -> ai cũng giả mạo được phiên.
export const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const f = path.join(path.dirname(DB_PATH), '.jwt-secret');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s.length >= 32) return s; } catch {}
  const s = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
})();
export const JWT_TTL = process.env.JWT_TTL || '30d';   // token dài hạn nhưng gắn với PHIÊN (thu hồi được, tự hết hạn khi không hoạt động)

// ---- TLS (wss/https). Đặt TLS_CERT + TLS_KEY (đường dẫn PEM) để bật; `npm run gencert` tạo chứng chỉ tự ký cho dev. ----
const certDir = fileURLToPath(new URL('../certs/', import.meta.url));
export const TLS_CERT = process.env.TLS_CERT || (process.env.TLS === '1' ? certDir + 'cert.pem' : '');
export const TLS_KEY = process.env.TLS_KEY || (process.env.TLS === '1' ? certDir + 'key.pem' : '');

// ---- TURN (chuyển tiếp media cuộc gọi khi P2P thất bại do NAT) ----
// Mặc định chạy TURN tích hợp (node-turn, UDP). Dùng coturn riêng: đặt TURN_URLS (phân cách dấu phẩy)
// + TURN_SECRET (static-auth-secret của coturn) -> server cấp thông tin đăng nhập tạm thời (chuẩn TURN REST API).
export const TURN_BUILTIN = process.env.TURN_BUILTIN !== '0' && !process.env.TURN_URLS;
export const TURN_PORT = Number(process.env.TURN_PORT || 3478);
export const TURN_PUBLIC_HOST = process.env.TURN_PUBLIC_HOST || '';      // host/IP công khai máy chủ TURN (mặc định lấy theo Host của request)
export const TURN_EXTERNAL_IP = process.env.TURN_EXTERNAL_IP || '';      // IP công khai khi máy chủ nằm sau NAT
export const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
export const TURN_SECRET = process.env.TURN_SECRET || '';
export const TURN_TTL_S = 6 * 3600;
// Dải cổng UDP cấp cho relay (phải mở trên tường lửa). Mặc định hẹp: 49160-49200 (~20 cuộc gọi qua relay cùng lúc).
export const TURN_MIN_PORT = Number(process.env.TURN_MIN_PORT) || 49160;
export const TURN_MAX_PORT = Number(process.env.TURN_MAX_PORT) || 49200;
export const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean);

// ---- Cập nhật tự động: thư mục chứa latest.yml + bộ cài (electron-builder, provider "generic") ----
export const UPDATES_DIR = process.env.UPDATES_DIR || fileURLToPath(new URL('../updates', import.meta.url));

// ---- Thông báo đẩy (Web Push / PWA) ----
export const VAPID_FILE = process.env.VAPID_FILE || fileURLToPath(new URL('../vapid.json', import.meta.url));
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@reachat.local';
// ---- Bản web (PWA) phục vụ tại /app: thư mục build của desktop (vite build) ----
export const WEB_DIR = process.env.WEB_DIR || fileURLToPath(new URL('../../desktop/dist', import.meta.url));

// ---- Giới hạn nội dung ----
export const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 25;                 // mỗi tệp đính kèm
export const MAX_MSG_KB = Number(process.env.MAX_MSG_KB) || 256;                  // một tin (đã mã hóa)
// Số thành viên tối đa mỗi nhóm: mặc định KHÔNG giới hạn (0). Đặt GROUP_MAX_MEMBERS=<số> nếu muốn chặn trên.
export const GROUP_MAX_MEMBERS = Number(process.env.GROUP_MAX_MEMBERS) || 0;

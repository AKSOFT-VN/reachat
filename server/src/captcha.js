// Captcha tự dựng (không phụ thuộc dịch vụ ngoài — chạy được cả trong app desktop) + giới hạn đăng ký theo IP.
// Ảnh SVG: ký tự vẽ bằng nét (không có <text> để đọc thẳng), mỗi nét lệch ngẫu nhiên, xoay/nghiêng, có nét nhiễu
// cùng kiểu. Mỗi mã dùng MỘT lần (đúng hay sai đều hủy), hết hạn sau 3 phút; máy chủ chỉ giữ băm của đáp án.
import crypto from 'node:crypto';

const ON = process.env.CAPTCHA !== '0';
const DEV_ECHO = process.env.CAPTCHA_DEV_ECHO === '1';      // CHỈ dùng khi chạy test
export const captchaEnabled = () => ON;

// Ký tự kiểu 7 đoạn (không có ký tự dễ nhầm như 0/O, 1/I, 8/B).
const SEG = { a: [[0, 0], [1, 0]], b: [[1, 0], [1, 1]], c: [[1, 1], [1, 2]], d: [[0, 2], [1, 2]], e: [[0, 1], [0, 2]], f: [[0, 0], [0, 1]], g: [[0, 1], [1, 1]] };
const GLYPH = { 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 9: 'abcdfg', A: 'abcefg', C: 'adef', E: 'adefg', F: 'aefg', H: 'bcefg', L: 'def', P: 'abefg', U: 'bcdef' };
const CHARS = Object.keys(GLYPH);
const r = (a, b) => a + crypto.randomInt(0, 10_000) / 10_000 * (b - a);
const hash = (s) => crypto.createHash('sha256').update(String(s).toUpperCase()).digest('hex');

const store = new Map();   // id -> { h, exp }
const TTL = 3 * 60_000;

function render(text) {
  const W = 200, H = 64, paths = [];
  const hue = crypto.randomInt(0, 360);
  const col = () => `hsl(${(hue + crypto.randomInt(-40, 40) + 360) % 360},${crypto.randomInt(45, 70)}%,${crypto.randomInt(25, 40)}%)`;
  const curve = ([x1, y1], [x2, y2], w, c) => {
    const mx = (x1 + x2) / 2 + r(-4, 4), my = (y1 + y2) / 2 + r(-4, 4);
    paths.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${c}" stroke-width="${w.toFixed(1)}" fill="none" stroke-linecap="round"/>`);
  };
  // nét nhiễu dài + ngắn, cùng độ dày với chữ
  for (let i = 0; i < 2; i++) curve([r(0, 30), r(5, H - 5)], [r(W - 30, W), r(5, H - 5)], r(1.2, 1.8), col());
  const items = [];
  [...text].forEach((ch, i) => {
    const cx = 16 + i * 37 + r(-2, 2), cy = 10 + r(-3, 3), sx = r(15, 18), sy = r(19, 22), ang = r(-0.22, 0.22), sk = r(-0.2, 0.2);
    const P = ([x, y]) => { const px = x * sx + y * sy * sk, py = y * sy; return [cx + px * Math.cos(ang) - py * Math.sin(ang) + r(-1.6, 1.6), cy + px * Math.sin(ang) + py * Math.cos(ang) + r(-1.6, 1.6)]; };
    const c = col();
    for (const s of GLYPH[ch]) items.push(() => curve(P(SEG[s][0]), P(SEG[s][1]), r(2.6, 3.4), c));
  });
  for (let i = 0; i < 4; i++) { const x = r(5, W - 25), y = r(8, H - 8); items.push(() => curve([x, y], [x + r(-14, 14), y + r(-14, 14)], r(2.6, 3.4), col())); }
  // trộn thứ tự nét chữ và nét nhiễu -> không suy ra ký tự từ thứ tự trong mã SVG
  for (let i = items.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [items[i], items[j]] = [items[j], items[i]]; }
  items.forEach((f) => f());
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="8" fill="hsl(${hue},30%,92%)"/>${paths.join('')}</svg>`;
}

export function newCaptcha() {
  const now = Date.now();
  if (store.size > 20_000) for (const [k, v] of store) if (v.exp < now) store.delete(k);
  const text = Array.from({ length: 5 }, () => CHARS[crypto.randomInt(0, CHARS.length)]).join('');
  const id = crypto.randomBytes(12).toString('base64url');
  store.set(id, { h: hash(text), exp: now + TTL });
  return { id, svg: render(text), ...(DEV_ECHO ? { devAnswer: text } : {}) };
}
// Một lần dùng: kiểm xong (đúng/sai) là hủy.
export function checkCaptcha(c) {
  if (!ON) return true;
  const e = c && store.get(String(c.id || ''));
  if (!e) return false;
  store.delete(String(c.id));
  return e.exp > Date.now() && crypto.timingSafeEqual(Buffer.from(e.h), Buffer.from(hash(String(c.answer || '').replace(/\s/g, ''))));
}
export const captchaError = (msg = 'Mã captcha không đúng hoặc đã hết hạn') => Object.assign(new Error(msg), { status: 400, needCaptcha: true });

// ---- Giới hạn đăng ký theo IP (cửa sổ trượt; REG_PER_IP_HOUR / REG_PER_IP_DAY, 0 = tắt) ----
const PER_HOUR = Number(process.env.REG_PER_IP_HOUR ?? 3), PER_DAY = Number(process.env.REG_PER_IP_DAY ?? 10);
const regs = new Map();   // ip -> [thời điểm...]
export function checkRegisterIp(ip) {
  const now = Date.now();
  const list = (regs.get(ip) || []).filter((t) => now - t < 86400_000);
  regs.set(ip, list);
  if (PER_HOUR && list.filter((t) => now - t < 3600_000).length >= PER_HOUR) throw Object.assign(new Error('Mạng của bạn vừa tạo nhiều tài khoản — thử lại sau 1 giờ'), { status: 429 });
  if (PER_DAY && list.length >= PER_DAY) throw Object.assign(new Error('Mạng của bạn đã tạo quá nhiều tài khoản hôm nay — thử lại ngày mai'), { status: 429 });
}
export const recordRegisterIp = (ip) => { regs.set(ip, [...(regs.get(ip) || []), Date.now()]); };

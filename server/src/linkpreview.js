// Xem trước liên kết: máy chủ tải trang (thay cho app — tránh CORS và không lộ IP người dùng cho trang đích),
// đọc thẻ Open Graph / <title>, kèm ảnh nhỏ dạng data URL.
// An toàn (chống SSRF): chỉ http/https, cổng 80/443, mọi địa chỉ phân giải ra đều phải là IP công khai
// (kiểm ngay lúc kết nối — chống DNS rebinding), tối đa 3 lần chuyển hướng, 5 giây, 512 KB HTML, ảnh ≤ 300 KB.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const isPrivate4 = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
};
// IPv6 -> 8 nhóm 16 bit (hỗ trợ "::" và đuôi IPv4 "a.b.c.d").
const v6groups = (s) => {
  let tail = [];
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const p = m[2].split('.').map(Number); tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]]; s = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1); }
  const [h, t = null] = s.split('::');
  const part = (x) => (x ? x.split(':').map((g) => parseInt(g, 16)) : []);
  const head = part(h), rest = t === null ? [] : part(t);
  const fill = t === null ? [] : new Array(8 - head.length - rest.length - tail.length).fill(0);
  return [...head, ...fill, ...rest, ...tail];
};
const g4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
const isPrivate = (ip) => {
  ip = String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(ip)) return isPrivate4(ip);
  if (!net.isIPv6(ip)) return true;                           // không phải IP hợp lệ: coi như bị chặn
  const g = v6groups(ip.toLowerCase());
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true;
  // IPv4 nhúng trong IPv6: ::a.b.c.d (compat), ::ffff:a.b.c.d (mapped), 64:ff9b::/96 (NAT64), 2002::/16 (6to4)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return g[6] === 0 && g[7] <= 1 && g[5] === 0 ? true : isPrivate4(g4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivate4(g4(g[6], g[7]));
  if (g[0] === 0x2002) return isPrivate4(g4(g[1], g[2]));
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00 || g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)
    || g[0] === 0x2001 && g[1] === 0xdb8;
};
// lookup dùng khi kết nối: từ chối nếu tên miền trỏ về mạng nội bộ.
const safeLookup = (host, opts, cb) => dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
  if (err) return cb(err);
  const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: opts.family || 4 }];
  if (!list.length || list.some((a) => isPrivate(a.address))) return cb(Object.assign(new Error('Địa chỉ nội bộ bị chặn'), { code: 'EBLOCKED' }));
  if (opts.all) return cb(null, list);
  cb(null, list[0].address, list[0].family);
});

function get(url, { max, accept }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('URL không hợp lệ')); }
    if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port)) || u.username || net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivate(u.hostname.replace(/^\[|\]$/g, '')))
      return reject(new Error('URL không được phép'));
    const req = (u.protocol === 'https:' ? https : http).get(u, {
      lookup: safeLookup, timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReaChatPreview/1.0)', Accept: accept, 'Accept-Language': 'vi,en;q=0.8' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: new URL(res.headers.location, u).href }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size > max) { req.destroy(); resolve({ body: Buffer.concat(chunks), type: res.headers['content-type'] || '', truncated: true }); } else chunks.push(d); });
      res.on('end', () => resolve({ body: Buffer.concat(chunks), type: res.headers['content-type'] || '', url: u.href }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Quá thời gian')));
    req.on('error', reject);
  });
}
async function follow(url, opts) {
  for (let i = 0; i < 4; i++) {
    const r = await get(url, opts);
    if (!r.redirect) return { ...r, url };
    url = r.redirect;
  }
  throw new Error('Chuyển hướng quá nhiều');
}

const decode = (s) => String(s || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, e) => {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
  if (map[e.toLowerCase()]) return map[e.toLowerCase()];
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(n) ? String.fromCodePoint(n) : m;
}).replace(/\s+/g, ' ').trim();
function meta(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (c) return decode(c);
  }
  return '';
}

const cache = new Map();   // url -> { at, data, size }
const TTL = 6 * 3600_000, CACHE_MAX_BYTES = 64 * 1024 * 1024;   // trần bộ nhớ đệm theo tổng dung lượng (ảnh data URL lớn)
let cacheBytes = 0;
export async function linkPreview(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let data = null;
  try {
    const r = await follow(url, { max: 512 * 1024, accept: 'text/html,application/xhtml+xml' });
    if (/text\/html|xhtml/i.test(r.type)) {
      const cs = (r.type.match(/charset=([\w-]+)/i)?.[1] || 'utf-8').toLowerCase();
      let html; try { html = new TextDecoder(cs).decode(r.body); } catch { html = r.body.toString('utf8'); }
      const title = (meta(html, ['og:title', 'twitter:title']) || decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1])).slice(0, 200);
      const description = meta(html, ['og:description', 'twitter:description', 'description']).slice(0, 300);
      const siteName = (meta(html, ['og:site_name']) || new URL(r.url).hostname.replace(/^www\./, '')).slice(0, 80);
      let image = null;
      const imgUrl = meta(html, ['og:image', 'og:image:url', 'twitter:image']);
      if (imgUrl) {
        try {
          const im = await follow(new URL(imgUrl, r.url).href, { max: 300 * 1024, accept: 'image/*' });
          if (!im.truncated && /^image\/(png|jpe?g|gif|webp)/i.test(im.type)) image = `data:${im.type.split(';')[0]};base64,${im.body.toString('base64')}`;
        } catch {}
      }
      if (title || description) data = { url: r.url, title, description, siteName, image };
    }
  } catch {}
  const size = url.length + (data ? JSON.stringify(data).length : 0);
  if (cache.has(url)) cacheBytes -= cache.get(url).size;
  cache.set(url, { at: Date.now(), data, size }); cacheBytes += size;
  while (cache.size > 3000 || cacheBytes > CACHE_MAX_BYTES) { const k = cache.keys().next().value; cacheBytes -= cache.get(k).size; cache.delete(k); }
  return data;
}
export const _isPrivate = isPrivate;   // cho test

// POST JSON tới URL do người dùng cung cấp (webhook bot) với cùng lớp chống SSRF: không tới địa chỉ nội bộ
// (trừ khi allowPrivate), KHÔNG theo chuyển hướng, 5 giây, bỏ qua phản hồi.
export function safePost(url, body, headers = {}, { allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('URL không hợp lệ')); }
    if (!/^https?:$/.test(u.protocol) || u.username) return reject(new Error('URL không được phép'));
    if (!allowPrivate && isPrivateHost(u.hostname)) return reject(new Error('Địa chỉ nội bộ bị chặn'));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST', timeout: 5000, ...(allowPrivate ? {} : { lookup: safeLookup }),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(new Error('Quá thời gian')));
    req.on('error', reject);
    req.end(body);
  });
}
export function isPrivateHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '');
  return net.isIP(h) ? isPrivate(h) : /^(localhost|.+\.localhost|.+\.local|.+\.internal)$/i.test(h);
}

// Tiện ích nhóm 3: tìm GIF (Klipy / Giphy) và dịch tin nhắn.
// GIF: KLIPY_API_KEY (klipy.com/developers — API tương thích Tenor; Tenor API của Google đã đóng ngày 30/6/2026)
//   hoặc GIPHY_API_KEY. Không có -> tắt.
//   App không tải thẳng từ Klipy/Giphy (CSP chỉ cho kết nối tới máy chủ ReaChat): máy chủ tải hộ ảnh (chỉ từ máy chủ
//   ảnh của nhà cung cấp), app gửi GIF như ẢNH thường -> mã hóa đầu-cuối, người nhận không phải tải từ bên thứ ba.
// Dịch: TRANSLATE_PROVIDER = mymemory (mặc định, miễn phí ~5.000 ký tự/ngày/IP máy chủ; MYMEMORY_EMAIL nâng lên 50.000)
//   | libre (LIBRETRANSLATE_URL [+ LIBRETRANSLATE_KEY], tự cài được trên máy chủ riêng) | google (GOOGLE_TRANSLATE_KEY) | off.
//   Dịch = gửi đoạn chữ đó ra khỏi lớp mã hóa đầu-cuối -> app hỏi người dùng đồng ý trước.
const err = (status, message) => Object.assign(new Error(message), { status });
const KLIPY = process.env.KLIPY_API_KEY, GIPHY = process.env.GIPHY_API_KEY;
const KLIPY_BASE = (process.env.KLIPY_API_BASE || 'https://api.klipy.com/v2').replace(/\/$/, '');
export const gifEnabled = () => !!(KLIPY || GIPHY);
const MEDIA_HOSTS = /^(([\w-]+\.)*klipy\.com|media\d*\.giphy\.com|i\.giphy\.com)$/i;

export async function gifSearch(q, pos = '') {
  if (!gifEnabled()) throw err(503, 'Máy chủ chưa cấu hình GIF');
  const query = String(q || '').trim().slice(0, 60);
  if (KLIPY) {                                              // định dạng Tenor v2 (Klipy tương thích)
    const u = new URL(KLIPY_BASE + '/' + (query ? 'search' : 'featured'));
    u.search = new URLSearchParams({ key: KLIPY, client_key: 'reachat', limit: '24', media_filter: 'tinygif,gif', contentfilter: 'medium', locale: 'vi_VN', ...(query ? { q: query } : {}), ...(pos ? { pos } : {}) });
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw err(502, 'Klipy lỗi ' + r.status);
    const d = await r.json();
    return { next: d.next || '', items: (d.results || []).map((x) => ({ id: x.id, preview: x.media_formats?.tinygif?.url, url: x.media_formats?.gif?.url || x.media_formats?.tinygif?.url,
      w: x.media_formats?.tinygif?.dims?.[0], h: x.media_formats?.tinygif?.dims?.[1], title: x.content_description || '' })).filter((x) => x.preview) };
  }
  const u = new URL('https://api.giphy.com/v1/gifs/' + (query ? 'search' : 'trending'));
  u.search = new URLSearchParams({ api_key: GIPHY, limit: '24', rating: 'pg-13', lang: 'vi', offset: String(Number(pos) || 0), ...(query ? { q: query } : {}) });
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw err(502, 'Giphy lỗi ' + r.status);
  const d = await r.json();
  return { next: String((Number(pos) || 0) + 24), items: (d.data || []).map((x) => ({ id: x.id, preview: x.images?.fixed_width_small?.url || x.images?.preview_gif?.url,
    url: x.images?.downsized?.url || x.images?.original?.url, w: +x.images?.fixed_width_small?.width, h: +x.images?.fixed_width_small?.height, title: x.title || '' })).filter((x) => x.preview) };
}
// Tải hộ ảnh GIF (chỉ từ máy chủ ảnh của Tenor/Giphy, tối đa 8 MB).
export async function gifMedia(url) {
  let u; try { u = new URL(String(url)); } catch { throw err(400, 'URL không hợp lệ'); }
  if (u.protocol !== 'https:' || !MEDIA_HOSTS.test(u.hostname)) throw err(400, 'Chỉ tải được ảnh từ Klipy/Giphy');
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw err(502, 'Không tải được GIF');
  const type = r.headers.get('content-type') || 'image/gif';
  if (!/^image\//.test(type)) throw err(400, 'Không phải ảnh');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw err(413, 'GIF quá lớn');
  return { type, buf };
}

// ---- Dịch ----
const PROVIDER = (process.env.TRANSLATE_PROVIDER || 'mymemory').toLowerCase();
export const translateEnabled = () => PROVIDER !== 'off' && !(PROVIDER === 'libre' && !process.env.LIBRETRANSLATE_URL) && !(PROVIDER === 'google' && !process.env.GOOGLE_TRANSLATE_KEY);
const LANGS = new Set(['vi', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'ru', 'th', 'lo', 'km', 'es', 'id']);
export async function translate(text, to = 'vi') {
  if (!translateEnabled()) throw err(503, 'Máy chủ chưa bật dịch');
  const t = String(text || '').slice(0, 1500);
  if (!t.trim()) return { text: '' };
  if (!LANGS.has(to)) throw err(400, 'Ngôn ngữ không hỗ trợ');
  if (PROVIDER === 'google') {
    const r = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(process.env.GOOGLE_TRANSLATE_KEY), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: t, target: to, format: 'text' }), signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    if (!r.ok) throw err(502, 'Dịch lỗi: ' + (d.error?.message || r.status));
    return { text: d.data.translations[0].translatedText, from: d.data.translations[0].detectedSourceLanguage };
  }
  if (PROVIDER === 'libre') {
    const r = await fetch(process.env.LIBRETRANSLATE_URL.replace(/\/$/, '') + '/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ q: t, source: 'auto', target: to, format: 'text', ...(process.env.LIBRETRANSLATE_KEY ? { api_key: process.env.LIBRETRANSLATE_KEY } : {}) }) });
    const d = await r.json();
    if (!r.ok) throw err(502, 'Dịch lỗi: ' + (d.error || r.status));
    return { text: d.translatedText, from: d.detectedLanguage?.language };
  }
  // MyMemory: cần biết ngôn ngữ nguồn -> đoán thô: có dấu tiếng Việt -> vi, chữ Hán/Nhật/Hàn/Thái -> tương ứng, còn lại en.
  const from = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(t) ? 'vi' : /[぀-ヿ]/.test(t) ? 'ja' : /[가-힯]/.test(t) ? 'ko'
    : /[一-鿿]/.test(t) ? 'zh' : /[฀-๿]/.test(t) ? 'th' : /[Ѐ-ӿ]/.test(t) ? 'ru' : 'en';
  if (from === to) return { text: t, from, same: true };
  const u = new URL('https://api.mymemory.translated.net/get');
  u.search = new URLSearchParams({ q: t.slice(0, 500), langpair: `${from}|${to}`, ...(process.env.MYMEMORY_EMAIL ? { de: process.env.MYMEMORY_EMAIL } : {}) });
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.responseStatus !== 200) throw err(502, 'Dịch lỗi: ' + (d.responseDetails || r.status));
  return { text: d.responseData.translatedText, from };
}

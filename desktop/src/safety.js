// Cảnh báo lừa đảo chạy NGAY TRÊN MÁY (sau khi giải mã) — không gửi nội dung đi đâu,
// nên giữ nguyên mã hóa đầu-cuối. Dựa trên các kiểu lừa đảo phổ biến tại Việt Nam.

const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'ow.ly', 's.id', 'v.gd', 'shorten.asia'];
const RISKY_TLD = /\.(xyz|top|click|icu|cyou|buzz|rest|cam|work|zip|mov|vip|shop|online|site|fun|monster|sbs|cfd|lol|quest)$/i;
// Thương hiệu hay bị giả mạo -> tên miền chính thức.
const OFFICIAL = {
  vietcombank: ['vietcombank.com.vn'], vcb: ['vietcombank.com.vn'],
  techcombank: ['techcombank.com', 'techcombank.com.vn'], mbbank: ['mbbank.com.vn'], bidv: ['bidv.com.vn'],
  agribank: ['agribank.com.vn'], vietinbank: ['vietinbank.vn'], momo: ['momo.vn'], shopee: ['shopee.vn'],
  lazada: ['lazada.vn'], tiki: ['tiki.vn'], vnpay: ['vnpay.vn'], tpbank: ['tpb.vn', 'tpbank.vn'], sacombank: ['sacombank.com.vn'],
  vpbank: ['vpbank.com.vn'], facebook: ['facebook.com', 'fb.com'], paypal: ['paypal.com'], binance: ['binance.com'],
  evn: ['evn.com.vn'], vneid: ['vneid.gov.vn'], dichvucong: ['dichvucong.gov.vn'], bocongan: ['bocongan.gov.vn'],
};

// Bỏ dấu tiếng Việt để so khớp từ khóa ổn định ("chuyển khoản" ~ "chuyen khoan").
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

const RULES = [
  { kind: 'otp', label: 'Yêu cầu mã OTP / mã xác thực', tip: 'Không bao giờ đưa mã OTP cho bất kỳ ai, kể cả người tự xưng ngân hàng.',
    re: /\b(otp|ma xac (thuc|nhan|minh)|ma kich hoat)\b/ },
  { kind: 'urgent-money', label: 'Giục chuyển tiền gấp', tip: 'Gọi điện xác minh trực tiếp trước khi chuyển tiền.',
    re: /(chuyen khoan|chuyen tien|nap tien|\bck\b|gui tien|muon tien|vay tien).{0,40}(gap|ngay|lien|khan|truoc \d|trong \d+ ?(phut|gio))|(gap|khan cap|cap cuu).{0,30}(chuyen|tien|vay|muon)/ },
  { kind: 'prize', label: 'Trúng thưởng / nhận quà / hoàn tiền', tip: 'Chương trình thật không yêu cầu phí hay mã OTP để nhận thưởng.',
    re: /(trung thuong|nhan qua|qua tang mien phi|trung giai|tri an khach hang|hoan tien|nhan thuong|quay so may man)/ },
  { kind: 'job', label: 'Việc nhẹ lương cao / làm nhiệm vụ', tip: 'Kiểu "làm nhiệm vụ, nạp tiền nhận hoa hồng" là lừa đảo phổ biến.',
    re: /(viec nhe luong cao|lam nhiem vu|chot don|hoa hong \d|cong tac vien online|kiem tien tai nha|dau tu sinh loi)/ },
  { kind: 'authority', label: 'Mạo danh công an / khóa tài khoản', tip: 'Cơ quan chức năng không làm việc qua tin nhắn hay yêu cầu chuyển tiền.',
    re: /(khoa tai khoan|tai khoan (cua ban )?(bi|se bi) (khoa|dong bang|tam dung)|cong an|toa an|lenh bat|vien kiem sat|dieu tra vu an|rua tien)/ },
  { kind: 'bank-account', label: 'Có số tài khoản ngân hàng', tip: 'Kiểm tra kỹ tên chủ tài khoản; người quen bị chiếm nick thường xin chuyển vào tài khoản lạ.',
    re: /(stk|so tai khoan|tai khoan|\btk\b|ngan hang|bank|vietcombank|techcombank|mbbank|bidv|agribank|vietinbank|tpbank|vpbank|acb|sacombank)\D{0,20}\d{8,16}\b/ },
];

const hostOf = (url) => { try { return new URL(/^https?:/i.test(url) ? url : 'http://' + url).hostname.toLowerCase(); } catch { return ''; } };

function scanLinks(text, out) {
  // URL có giao thức/www, hoặc tên miền trần (vd "vietcombank-xacminh.xyz").
  const urls = String(text).match(/\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|vn|net|org|xyz|top|click|link|info|online|site|shop|vip|icu|cyou|buzz|cam|sbs|cfd|lol|me|live|work|fun)(?:\/[^\s]*)?/gi) || [];
  for (const u of urls) {
    const h = hostOf(u);
    if (!h) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) out.push({ kind: 'link-ip', label: 'Liên kết dùng địa chỉ IP thay tên miền', tip: 'Trang thật hầu như không dùng địa chỉ IP trần.' });
    if (SHORTENERS.some((s) => h === s || h.endsWith('.' + s))) out.push({ kind: 'link-short', label: 'Liên kết rút gọn (ẩn địa chỉ thật)', tip: 'Đừng nhập mật khẩu/OTP sau khi mở link rút gọn.' });
    if (RISKY_TLD.test(h)) out.push({ kind: 'link-tld', label: 'Tên miền đuôi lạ (' + h.split('.').pop() + ')', tip: 'Đuôi tên miền rẻ tiền thường dùng cho trang giả mạo.' });
    if (h.includes('xn--')) out.push({ kind: 'link-puny', label: 'Tên miền chứa ký tự đánh lừa (punycode)', tip: 'Ký tự trông giống chữ thật nhưng là tên miền khác.' });
    for (const [brand, domains] of Object.entries(OFFICIAL)) {
      if (h.replace(/[^a-z0-9]/g, '').includes(brand) && !domains.some((d) => h === d || h.endsWith('.' + d))) {
        out.push({ kind: 'link-brand', label: 'Giả mạo tên miền "' + brand + '" (' + h + ')', tip: 'Trang chính thức: ' + domains.join(', ') + '.' });
        break;
      }
    }
  }
}

// Trả về danh sách cảnh báo (không trùng loại), sắp theo mức độ.
export function scanScam(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const f = fold(text);
  for (const r of RULES) if (r.re.test(f)) out.push({ kind: r.kind, label: r.label, tip: r.tip });
  scanLinks(text, out);
  const seen = new Set();
  return out.filter((w) => (seen.has(w.kind) ? false : seen.add(w.kind)));
}

// Nền mã hóa đầu-cuối bằng TweetNaCl: khóa danh tính X25519, box (X25519 + XSalsa20-Poly1305), secretbox
// cho khóa nhóm / khóa cá nhân / tệp, mã an toàn, sao lưu khóa (PBKDF2).
//
// Tin 1-1 KHÔNG dùng box tĩnh ở đây mà đi qua Double Ratchet (ratchet.js, có forward secrecy); box tĩnh chỉ
// còn cho: niêm phong khóa nhóm, tín hiệu cuộc gọi, tin LAN, và giải mã tin 1-1 rất cũ.
// Khóa bí mật chỉ nằm ở máy người dùng; server chỉ lưu khóa công khai (+ bản sao lưu đã bọc bằng mật khẩu).
import nacl from 'tweetnacl';
import { decodeUTF8, encodeUTF8, encodeBase64, decodeBase64 } from 'tweetnacl-util';

const KEY_STORE = 'reachat.keypair.';

// Máy này đã có khóa danh tính của username chưa (vd. sau khi đặt lại mật khẩu qua email/SMS).
export const hasLocalKeys = (username) => !!localStorage.getItem(KEY_STORE + username);

// Lấy (hoặc tạo mới) cặp khóa cho một username, lưu ở localStorage của renderer.
export function getOrCreateKeypair(username) {
  const k = KEY_STORE + username;
  const saved = localStorage.getItem(k);
  if (saved) {
    const { publicKey, secretKey } = JSON.parse(saved);
    return { publicKey: decodeBase64(publicKey), secretKey: decodeBase64(secretKey) };
  }
  const kp = nacl.box.keyPair();
  localStorage.setItem(k, JSON.stringify({
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  }));
  return kp;
}

// ---- Lịch sử khóa: khóa cũ KHÔNG bị xóa khi đồng bộ, để vẫn giải mã được dữ liệu cũ ----
const KEY_HIST = 'reachat.keyhist.';
const loadHist = (u) => { try { return JSON.parse(localStorage.getItem(KEY_HIST + u) || '[]'); } catch { return []; } };
function addHist(u, kp) {
  const h = loadHist(u);
  if (kp?.publicKey && !h.some((x) => x.publicKey === kp.publicKey)) { h.push(kp); localStorage.setItem(KEY_HIST + u, JSON.stringify(h)); }
}
// Khóa hiện tại trước, rồi các khóa cũ (để thử giải mã lần lượt).
export function allKeypairs(username) {
  const cur = getOrCreateKeypair(username);
  const hist = loadHist(username)
    .filter((k) => k.publicKey !== encodeBase64(cur.publicKey))
    .map((k) => ({ publicKey: decodeBase64(k.publicKey), secretKey: decodeBase64(k.secretKey) }));
  return [cur, ...hist];
}

export function publicKeyBase64(username) {
  return encodeBase64(getOrCreateKeypair(username).publicKey);
}

// Khóa công khai hợp lệ = base64 giải ra đúng 32 byte (X25519). Chặn khóa rác
// (vd dữ liệu test) làm decodeBase64 ném lỗi ở các luồng giải mã.
export function validPublicKey(b64) {
  if (typeof b64 !== 'string' || !b64) return false;
  try { return decodeBase64(b64).length === nacl.box.publicKeyLength; } catch { return false; }
}

// ---- Sao lưu khóa danh tính (đồng bộ nhiều thiết bị) ----
// Khóa bọc = PBKDF2-SHA256(mật khẩu, "reachat-keybackup:<user>", 200k vòng). Bản sao lưu là
// secretbox(JSON cặp khóa) -> server chỉ giữ ciphertext. Giới hạn: server nhận mật khẩu khi
// đăng nhập nên chống được lộ DB, KHÔNG chống được server cố ý bắt mật khẩu.
async function wrapKeyFromPassword(username, password) {
  const enc = new TextEncoder();
  const base = await globalThis.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('reachat-keybackup:' + username), iterations: 200000 }, base, 256);
  return new Uint8Array(bits);
}
// ---- Mã khôi phục: 20 ký tự base32 (100 bit). Server chỉ nhận verifier = SHA-256(nhãn|user|mã) để kiểm tra,
// và bản sao lưu khóa bọc bằng PBKDF2(mã) -> không biết mã thì không mở được (kể cả server).
const RC_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normRecovery = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function rcWrapKey(username, code) {
  const enc = new TextEncoder();
  const base = await globalThis.crypto.subtle.importKey('raw', enc.encode(normRecovery(code)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('reachat-rc-wrap:' + username), iterations: 200000 }, base, 256));
}
export async function recoveryVerifier(username, code) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('reachat-rc-verify:' + username + ':' + normRecovery(code)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function makeRecovery(username) {
  const r = nacl.randomBytes(20);
  const raw = [...r].map((b) => RC_ALPHA[b & 31]).join('');
  const code = raw.match(/.{4}/g).join('-');
  getOrCreateKeypair(username);
  const payload = JSON.stringify({ cur: JSON.parse(localStorage.getItem(KEY_STORE + username)), hist: loadHist(username) });
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(decodeUTF8(payload), nonce, await rcWrapKey(username, code));
  return { code, verifier: await recoveryVerifier(username, code), backup: { v: 2, nonce: encodeBase64(nonce), box: encodeBase64(box) } };
}
// Mở bản sao lưu bọc bằng mã khôi phục và cài khóa (giống openKeyBackup).
export async function openRecoveryBackup(username, code, backup) {
  try {
    const opened = nacl.secretbox.open(decodeBase64(backup.box), decodeBase64(backup.nonce), await rcWrapKey(username, code));
    if (!opened) return false;
    const obj = JSON.parse(encodeUTF8(opened));
    if (!validPublicKey(obj.cur?.publicKey)) return false;
    const local = localStorage.getItem(KEY_STORE + username);
    if (local) { const lk = JSON.parse(local); if (lk.publicKey !== obj.cur.publicKey) addHist(username, lk); }
    for (const h of obj.hist || []) if (h.publicKey !== obj.cur.publicKey) addHist(username, h);
    localStorage.setItem(KEY_STORE + username, JSON.stringify(obj.cur));
    return true;
  } catch { return false; }
}

// ---- Chuyển khóa danh tính sang máy mới qua QR: bó khóa niêm phong cho khóa tạm (X25519) của máy mới ----
// Máy mới tạo cặp khóa tạm, đưa khóa công khai vào QR; máy cũ niêm phong { cur, hist } bằng một cặp khóa tạm khác.
export const newEphemeral = () => { const k = nacl.box.keyPair(); return { publicKey: encodeBase64(k.publicKey), secretKey: k.secretKey }; };
export function sealKeyBundleFor(username, ephemeralPubB64) {
  getOrCreateKeypair(username);
  const payload = JSON.stringify({ u: username, cur: JSON.parse(localStorage.getItem(KEY_STORE + username)), hist: loadHist(username) });
  const mine = nacl.box.keyPair(), nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(decodeUTF8(payload), nonce, decodeBase64(ephemeralPubB64), mine.secretKey);
  return { epk: encodeBase64(mine.publicKey), nonce: encodeBase64(nonce), box: encodeBase64(box) };
}
// Mở bó khóa bằng khóa tạm bí mật rồi CÀI như mở bản sao lưu. Trả về true nếu đúng người dùng và cài được.
export function openKeyBundle(username, sealed, ephemeralSecret) {
  try {
    const opened = nacl.box.open(decodeBase64(sealed.box), decodeBase64(sealed.nonce), decodeBase64(sealed.epk), ephemeralSecret);
    if (!opened) return false;
    const obj = JSON.parse(encodeUTF8(opened));
    if (obj.u !== username || !validPublicKey(obj.cur?.publicKey)) return false;
    return installKeys(username, obj);
  } catch { return false; }
}
function installKeys(username, obj) {
  const cur = obj.cur || obj;
  if (!validPublicKey(cur.publicKey)) return false;
  const local = localStorage.getItem(KEY_STORE + username);
  if (local) { const lk = JSON.parse(local); if (lk.publicKey !== cur.publicKey) addHist(username, lk); }
  for (const h of obj.hist || []) if (h.publicKey !== cur.publicKey) addHist(username, h);
  localStorage.setItem(KEY_STORE + username, JSON.stringify(cur));
  return true;
}

// Bản sao lưu v2 = { cur: cặp khóa hiện tại, hist: [các cặp khóa cũ] }.
export async function sealKeyBackup(username, password) {
  getOrCreateKeypair(username);
  const payload = JSON.stringify({ cur: JSON.parse(localStorage.getItem(KEY_STORE + username)), hist: loadHist(username) });
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(decodeUTF8(payload), nonce, await wrapKeyFromPassword(username, password));
  return { v: 2, nonce: encodeBase64(nonce), box: encodeBase64(box) };
}
// Mở bản sao lưu, CÀI khóa hiện tại; khóa cũ của máy này + lịch sử trong bản sao lưu
// được giữ lại trong lịch sử khóa. Trả về true nếu thành công.
export async function openKeyBackup(username, password, backup) {
  try {
    const opened = nacl.secretbox.open(decodeBase64(backup.box), decodeBase64(backup.nonce), await wrapKeyFromPassword(username, password));
    if (!opened) return false;
    return installKeys(username, JSON.parse(encodeUTF8(opened)));   // v1 = chỉ có cặp khóa
  } catch { return false; }
}

// ---- Tệp sao lưu lịch sử: JSON -> gzip -> secretbox(khóa = PBKDF2-SHA256(mật khẩu sao lưu, muối ngẫu nhiên)) ----
const BACKUP_ITER = 300000;
async function backupKey(password, salt, iter) {
  const base = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 256));
}
const pipeBytes = async (u8, stream) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
export async function sealBackupFile(obj, password) {
  const salt = nacl.randomBytes(16), nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const gz = await pipeBytes(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream('gzip'));
  const box = nacl.secretbox(gz, nonce, await backupKey(password, salt, BACKUP_ITER));
  return JSON.stringify({ reachatBackup: 1, kdf: 'PBKDF2-SHA256', iter: BACKUP_ITER, salt: encodeBase64(salt), nonce: encodeBase64(nonce), box: encodeBase64(box) });
}
export async function openBackupFile(text, password) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error('Không phải tệp sao lưu ReaChat'); }
  if (!o?.reachatBackup) throw new Error('Không phải tệp sao lưu ReaChat');
  const gz = nacl.secretbox.open(decodeBase64(o.box), decodeBase64(o.nonce), await backupKey(password, decodeBase64(o.salt), o.iter));
  if (!gz) throw new Error('Sai mật khẩu sao lưu (hoặc tệp bị sửa)');
  return JSON.parse(new TextDecoder().decode(await pipeBytes(gz, new DecompressionStream('gzip'))));
}

// Khóa đối xứng CÁ NHÂN (cho "Ghi chú riêng"): SHA-512(secretKey || nhãn) lấy 32 byte đầu.
// Chỉ máy giữ khóa bí mật mới dựng lại được -> server không đọc được ghi chú/tệp của bạn.
// Mã hóa / giải mã MẢNG BYTE bằng khóa đối xứng (secretbox) -> chuỗi JSON {n,c}. Dùng cho cập nhật CRDT.
export function sealBytes(u8, keyB64) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return JSON.stringify({ n: encodeBase64(nonce), c: encodeBase64(nacl.secretbox(u8, nonce, decodeBase64(keyB64))) });
}
export function openBytes(sealed, keys) {
  try {
    const o = JSON.parse(sealed); const c = decodeBase64(o.c), n = decodeBase64(o.n);
    for (const k of keys) { const p = nacl.secretbox.open(c, n, decodeBase64(k)); if (p) return p; }
  } catch {}
  return null;
}

// Khóa đối xứng chung giữa mình và 1 người (X25519 DH, box.before) — cả hai tính ra giống nhau.
// Dùng cho dữ liệu phụ cần đọc lại nhiều lần (vd tiêu đề việc) trong chat 1-1. Thử cả khóa cũ.
export function sharedKeys(peerPubB64, myUsername) {
  try { return allKeypairs(myUsername).map((k) => encodeBase64(nacl.box.before(decodeBase64(peerPubB64), k.secretKey))); }
  catch { return []; }
}

const derivePersonal = (secretKey) => {
  const label = decodeUTF8('reachat-cloud-v1');
  const buf = new Uint8Array(secretKey.length + label.length);
  buf.set(secretKey); buf.set(label, secretKey.length);
  return encodeBase64(nacl.hash(buf).slice(0, nacl.secretbox.keyLength));
};
export function personalKey(username) { return derivePersonal(getOrCreateKeypair(username).secretKey); }
// Khóa Cloud hiện tại + của các khóa cũ (giải mã ghi chú/tệp tạo trên thiết bị/khóa trước đó).
export function personalKeys(username) { return allKeypairs(username).map((k) => derivePersonal(k.secretKey)); }

// Mã hóa plaintext gửi tới peer (peerPublicKey base64). Trả về chuỗi "nonce.cipher" base64.
export function encrypt(plaintext, peerPublicKeyB64, myUsername) {
  const { secretKey } = getOrCreateKeypair(myUsername);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(
    decodeUTF8(plaintext),
    nonce,
    decodeBase64(peerPublicKeyB64),
    secretKey
  );
  return encodeBase64(nonce) + '.' + encodeBase64(box);
}

// Giải mã từ peer. Trả về null nếu thất bại (sai khóa / bị can thiệp).
export function decrypt(payload, peerPublicKeyB64, myUsername) {
  try {
    const [nonceB64, boxB64] = payload.split('.');
    for (const { secretKey } of allKeypairs(myUsername)) {       // thử khóa hiện tại rồi khóa cũ
      const opened = nacl.box.open(decodeBase64(boxB64), decodeBase64(nonceB64), decodeBase64(peerPublicKeyB64), secretKey);
      if (opened) return encodeUTF8(opened);
    }
    return null;
  } catch {
    return null;
  }
}

// ---- E2E cho NHÓM: khóa nhóm đối xứng (secretbox) ------------------------
// Khóa nhóm được tạo ngẫu nhiên, rồi NIÊM PHONG riêng cho từng thành viên bằng
// box (chỉ họ mở được). Server không bao giờ thấy khóa nhóm hay nội dung.
export function newGroupKey() {
  return encodeBase64(nacl.randomBytes(nacl.secretbox.keyLength));
}

// Niêm phong khóa nhóm gửi tới 1 thành viên -> "nonce.cipher" (box).
export function sealGroupKey(groupKeyB64, memberPubB64, myUsername) {
  const { secretKey } = getOrCreateKeypair(myUsername);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(decodeBase64(groupKeyB64), nonce, decodeBase64(memberPubB64), secretKey);
  return encodeBase64(nonce) + '.' + encodeBase64(box);
}

// Mở envelope để lấy khóa nhóm (cần khóa công khai của người niêm phong).
export function openGroupKey(envelope, sealerPubB64, myUsername) {
  try {
    const [n, c] = envelope.split('.');
    for (const { secretKey } of allKeypairs(myUsername)) {       // envelope có thể niêm phong cho khóa cũ
      const opened = nacl.box.open(decodeBase64(c), decodeBase64(n), decodeBase64(sealerPubB64), secretKey);
      if (opened) return encodeBase64(opened);
    }
    return null;
  } catch {
    return null;
  }
}

// Mã hóa/giải mã tin nhóm bằng secretbox với khóa nhóm.
export function encryptGroup(plaintext, groupKeyB64) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(decodeUTF8(plaintext), nonce, decodeBase64(groupKeyB64));
  return encodeBase64(nonce) + '.' + encodeBase64(box);
}
export function decryptGroup(payload, groupKeyB64) {
  try {
    const [n, c] = payload.split('.');
    const opened = nacl.secretbox.open(decodeBase64(c), decodeBase64(n), decodeBase64(groupKeyB64));
    return opened ? encodeUTF8(opened) : null;
  } catch {
    return null;
  }
}

// Mã hóa/giải mã ảnh-tệp nhóm (secretbox trên byte).
export function encryptGroupFileB64(plainB64, groupKeyB64) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(decodeBase64(plainB64), nonce, decodeBase64(groupKeyB64));
  return { cipherB64: encodeBase64(box), nonce: encodeBase64(nonce) };
}
export function decryptGroupFileBytes(cipherBytes, nonceB64, groupKeyB64) {
  try {
    return nacl.secretbox.open(cipherBytes, decodeBase64(nonceB64), decodeBase64(groupKeyB64));
  } catch {
    return null;
  }
}

// ---- Mã hóa ảnh/tệp 1-1 (box với khóa peer, giống tin text) --------------
// Nhận base64 của plaintext -> trả { cipherB64, nonce }. Dùng chung DH pair
// nên cả người gửi lẫn người nhận đều giải mã bằng khóa công khai của ĐỐI PHƯƠNG.
export function encryptFileB64(plainB64, peerPublicKeyB64, myUsername) {
  const { secretKey } = getOrCreateKeypair(myUsername);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const cipher = nacl.box(decodeBase64(plainB64), nonce, decodeBase64(peerPublicKeyB64), secretKey);
  return { cipherB64: encodeBase64(cipher), nonce: encodeBase64(nonce) };
}

// Giải mã mảng byte ciphertext -> Uint8Array (hoặc null nếu hỏng/giả mạo).
export function decryptFileBytes(cipherBytes, nonceB64, peerPublicKeyB64, myUsername) {
  try {
    const { secretKey } = getOrCreateKeypair(myUsername);
    return nacl.box.open(cipherBytes, decodeBase64(nonceB64), decodeBase64(peerPublicKeyB64), secretKey);
  } catch {
    return null;
  }
}

// ---- Safety number / mã an toàn E2E (đối chiếu khóa để phát hiện kẻ đứng giữa) ----
// Hai người đối chiếu cùng một dãy 60 chữ số; nếu khớp -> không ai chèn khóa
// (man-in-the-middle). Tất cả suy ra từ khóa công khai, không lộ khóa bí mật.
const SN_ITER = 1024;

function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// Vân tay 30 chữ số cho (khóa công khai, định danh), lặp SHA-512 cho chắc.
function fingerprint(keyBytes, identStr) {
  const VERSION = new Uint8Array([0, 0]);
  let h = nacl.hash(concatBytes(VERSION, keyBytes, decodeUTF8(identStr))); // SHA-512
  for (let i = 0; i < SN_ITER; i++) h = nacl.hash(concatBytes(h, keyBytes));
  let digits = '';
  for (let g = 0; g < 6; g++) {               // 6 nhóm × 5 byte = 30 byte
    let n = 0;
    for (let i = 0; i < 5; i++) n = (n * 256 + h[g * 5 + i]) % 100000;
    digits += String(n).padStart(5, '0');     // mỗi nhóm -> 5 chữ số
  }
  return digits; // 30 chữ số
}

// Mã an toàn 60 chữ số; giống hệt ở cả hai máy khi kênh không bị can thiệp.
export function safetyNumber(myPubB64, myUser, peerPubB64, peerUser) {
  const a = fingerprint(decodeBase64(myPubB64), myUser);
  const b = fingerprint(decodeBase64(peerPubB64), peerUser);
  const combined = a < b ? a + b : b + a;     // thứ tự ổn định -> hai bên khớp
  return combined.match(/.{1,5}/g).join(' ');
}

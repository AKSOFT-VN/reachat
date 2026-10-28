// Double Ratchet (forward secrecy + post-compromise security) cho chat 1-1.
//
// Bám đặc tả Signal (https://signal.org/docs/specifications/doubleratchet/):
//  - DH ratchet: mỗi lượt đổi khóa ratchet -> làm mới root key.
//  - Symmetric ratchet: mỗi tin dùng một message key RIÊNG, dùng xong BỎ đi
//    -> lộ khóa/tin hiện tại KHÔNG giải được tin cũ (forward secrecy).
//
// Nguyên thủy: X25519 (nacl.box.before) cho DH, HKDF/HMAC-SHA256 (WebCrypto)
// cho KDF, XSalsa20-Poly1305 (nacl.secretbox) cho AEAD từng tin.
//
// GIỚI HẠN TRUNG THỰC:
//  - Bootstrap KHÔNG có X3DH/prekey server: khóa gốc ban đầu suy từ DH của hai
//    khóa định danh tĩnh. Forward secrecy có hiệu lực SAU lượt ratchet đầu.
//  - Người GỬI đầu tiên là initiator; nếu cả hai cùng gửi trước khi nhận (đua),
//    phiên lệch nhau -> cần thiết lập lại. Không deniability như X3DH đầy đủ.
//  - Đây là cài đặt tự viết cho mục đích học tập; production nên dùng thư viện
//    đã được kiểm toán (libsignal).
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { decodeUTF8, encodeUTF8, encodeBase64, decodeBase64 } = naclUtil;

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const MAX_SKIP = 256; // số tin tối đa được phép bỏ qua trong một chuỗi (chống DoS)

// ---- nguyên thủy ---------------------------------------------------------
async function hmac(keyBytes, dataBytes) {
  const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, dataBytes));
}
async function hkdf64(ikm, saltBytes, infoStr) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: te.encode(infoStr) }, k, 512);
  return new Uint8Array(bits); // 64 byte
}
const DH = (pair, pubBytes) => nacl.box.before(pubBytes, pair.secretKey); // 32 byte dùng chung
const genDH = () => nacl.box.keyPair();

// KDF cho root chain: (RK', CK) = HKDF(salt=RK, ikm=dh_out)
async function kdfRK(rk, dhOut) {
  const out = await hkdf64(dhOut, rk, 'ReaChatDoubleRatchet');
  return [out.slice(0, 32), out.slice(32, 64)];
}
// KDF cho symmetric chain: mk = HMAC(CK,1); CK' = HMAC(CK,2)
async function kdfCK(ck) {
  const mk = await hmac(ck, new Uint8Array([0x01]));
  const nck = await hmac(ck, new Uint8Array([0x02]));
  return [nck, mk];
}

// ---- khởi tạo phiên ------------------------------------------------------
// identity = cặp khóa định danh tĩnh { publicKey, secretKey } (Uint8Array).
// Người GỬI đầu tiên gọi hàm này để làm initiator.
export async function initInitiator(identity, peerIdPubB64) {
  const peerIdPub = decodeBase64(peerIdPubB64);
  const SK = nacl.box.before(peerIdPub, identity.secretKey);
  const DHs = genDH();
  const [RK, CKs] = await kdfRK(SK, DH(DHs, peerIdPub));
  return { RK, DHs, DHr: peerIdPub, CKs, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {} };
}
// Người NHẬN tin đầu (chưa có phiên) gọi hàm này để làm responder.
export async function initResponder(identity, peerIdPubB64) {
  const peerIdPub = decodeBase64(peerIdPubB64);
  const SK = nacl.box.before(peerIdPub, identity.secretKey);
  // DHs ban đầu = khóa định danh -> khớp DH mà initiator đã dùng.
  return { RK: SK, DHs: { publicKey: identity.publicKey, secretKey: identity.secretKey },
           DHr: null, CKs: null, CKr: null, Ns: 0, Nr: 0, PN: 0, skipped: {} };
}

// ---- bước ratchet gửi/nhận (trả về message key) --------------------------
// Tiến chuỗi gửi một bước -> { header, mk }. Dùng cho cả text lẫn ảnh/tệp.
async function sendStep(st) {
  if (!st.CKs) throw new Error('chưa thể gửi: phiên chưa sẵn sàng (chờ tin đầu)');
  const [CKs, mk] = await kdfCK(st.CKs);
  st.CKs = CKs;
  const header = { dh: encodeBase64(st.DHs.publicKey), pn: st.PN, n: st.Ns };
  st.Ns += 1;
  return { header, mk };
}

// Tiến chuỗi nhận theo header -> message key (xử lý DH ratchet + tin bỏ qua).
async function receiveStep(st, header) {
  const sk = skKey(header.dh, header.n);
  if (st.skipped[sk]) { const mk = decodeBase64(st.skipped[sk]); delete st.skipped[sk]; return mk; }
  const curDHr = st.DHr ? encodeBase64(st.DHr) : null;
  if (header.dh !== curDHr) {
    await skipMessageKeys(st, header.pn);
    await dhRatchet(st, header);
  }
  await skipMessageKeys(st, header.n);
  const [CKr, mk] = await kdfCK(st.CKr);
  st.CKr = CKr; st.Nr += 1;
  return mk;
}

// ---- gửi -----------------------------------------------------------------
export async function ratchetEncrypt(st, plaintext) {
  const { header, mk } = await sendStep(st);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(decodeUTF8(plaintext), nonce, mk);
  return { header, nonce: encodeBase64(nonce), ct: encodeBase64(ct) };
}

// Lấy message key để tự mã hóa payload lớn (ảnh/tệp) ngoài luồng -> { header, mkB64 }.
export async function sendKey(st) {
  const { header, mk } = await sendStep(st);
  return { header, mkB64: encodeBase64(mk) };
}

// ---- nhận ----------------------------------------------------------------
function skKey(dhB64, n) { return dhB64 + '|' + n; }

async function skipMessageKeys(st, until) {
  if (st.Nr + MAX_SKIP < until) throw new Error('vượt quá số tin bỏ qua cho phép');
  if (!st.CKr) return;
  const dhB64 = encodeBase64(st.DHr);
  while (st.Nr < until) {
    const [CKr, mk] = await kdfCK(st.CKr);
    st.skipped[skKey(dhB64, st.Nr)] = encodeBase64(mk);
    st.CKr = CKr; st.Nr += 1;
  }
}

async function dhRatchet(st, header) {
  st.PN = st.Ns; st.Ns = 0; st.Nr = 0;
  st.DHr = decodeBase64(header.dh);
  [st.RK, st.CKr] = await kdfRK(st.RK, DH(st.DHs, st.DHr));
  st.DHs = genDH();
  [st.RK, st.CKs] = await kdfRK(st.RK, DH(st.DHs, st.DHr));
}

export async function ratchetDecrypt(st, msg) {
  const { header, nonce, ct } = msg;
  const mk = await receiveStep(st, header);
  const pt = nacl.secretbox.open(decodeBase64(ct), decodeBase64(nonce), mk);
  if (!pt) throw new Error('giải mã thất bại (sai khóa / giả mạo)');
  return encodeUTF8(pt);
}

// Lấy message key của tin ảnh/tệp đến (tiến ratchet đúng thứ tự) -> mkB64.
export async function receiveKey(st, header) {
  return encodeBase64(await receiveStep(st, header));
}

// ---- lưu/khôi phục state (JSON-an toàn cho localStorage) -----------------
export function serialize(st) {
  return JSON.stringify({
    RK: encodeBase64(st.RK),
    DHs: { publicKey: encodeBase64(st.DHs.publicKey), secretKey: encodeBase64(st.DHs.secretKey) },
    DHr: st.DHr ? encodeBase64(st.DHr) : null,
    CKs: st.CKs ? encodeBase64(st.CKs) : null,
    CKr: st.CKr ? encodeBase64(st.CKr) : null,
    Ns: st.Ns, Nr: st.Nr, PN: st.PN, skipped: st.skipped,
  });
}
export function deserialize(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  return {
    RK: decodeBase64(o.RK),
    DHs: { publicKey: decodeBase64(o.DHs.publicKey), secretKey: decodeBase64(o.DHs.secretKey) },
    DHr: o.DHr ? decodeBase64(o.DHr) : null,
    CKs: o.CKs ? decodeBase64(o.CKs) : null,
    CKr: o.CKr ? decodeBase64(o.CKr) : null,
    Ns: o.Ns, Nr: o.Nr, PN: o.PN, skipped: o.skipped || {},
  };
}

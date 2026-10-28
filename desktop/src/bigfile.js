// Tệp lớn: tải lên / tải xuống THEO KHÚC, mã hóa từng khúc (secretbox), không nạp cả tệp vào bộ nhớ.
// - Mỗi khúc gốc PLAIN_CS byte -> bản mã PLAIN_CS + 16 (MAC). Nonce khúc i = nonce gốc với 4 byte cuối XOR i.
// - Không có khóa (vd. chat với bot) -> gửi nguyên khúc (cs = PLAIN_CS).
// - Tải xuống dùng Range đọc từng khúc, giải mã rồi ghi ra "sink" (tệp trên đĩa / bộ nhớ).
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

export const PLAIN_CS = 4 * 1024 * 1024;
export const BIG_THRESHOLD = 8 * 1024 * 1024;     // tệp lớn hơn -> đi đường theo khúc
const CONCURRENCY = 3;

const chunkNonce = (base, i) => {
  const n = new Uint8Array(base);
  const v = new DataView(n.buffer);
  v.setUint32(20, v.getUint32(20) ^ i);
  return n;
};

// Gửi một yêu cầu, thử lại khi lỗi mạng / 5xx (không thử lại lỗi 4xx).
async function retry(fn, tries = 4) {
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      if (a >= tries - 1 || (e.status >= 400 && e.status < 500)) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** a));
    }
  }
}

// file: File/Blob; keyB64: khóa secretbox hoặc null. onProgress(0..1). Trả { fileId, nonce, chunked }.
export async function uploadChunked({ serverUrl, token, file, name, keyB64, onProgress }) {
  const key = keyB64 ? decodeBase64(keyB64) : null;
  const n = Math.max(1, Math.ceil(file.size / PLAIN_CS));
  const cs = PLAIN_CS + (key ? 16 : 0);
  const total = file.size + (key ? 16 * n : 0);
  const auth = { Authorization: 'Bearer ' + token };
  const init = await fetch(serverUrl + '/api/files/init', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: key ? 'blob' : name, mime: 'application/octet-stream', size: total, chunkSize: cs, chunks: n }) });
  const ij = await init.json();
  if (!init.ok) throw Object.assign(new Error(ij.error || 'Không khởi tạo được tải lên'), { status: init.status });
  const base = nacl.randomBytes(nacl.secretbox.nonceLength);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      const plain = new Uint8Array(await file.slice(i * PLAIN_CS, Math.min(file.size, (i + 1) * PLAIN_CS)).arrayBuffer());
      const body = key ? nacl.secretbox(plain, chunkNonce(base, i), key) : plain;
      await retry(async () => {
        const r = await fetch(`${serverUrl}/api/files/${ij.id}/chunk/${i}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error || 'Tải khúc lỗi'), { status: r.status }); }
      });
      done += plain.length;
      onProgress?.(done / file.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, worker));
  const fin = await fetch(`${serverUrl}/api/files/${ij.id}/complete`, { method: 'POST', headers: auth });
  if (!fin.ok) throw new Error((await fin.json().catch(() => ({}))).error || 'Không hoàn tất được tải lên');
  return { fileId: ij.id, nonce: key ? encodeBase64(base) : null, chunked: { cs: PLAIN_CS, n, enc: !!key } };
}

// Đọc + giải mã từng khúc theo thứ tự, gọi write(Uint8Array). keys: danh sách khóa thử (khóa nhóm cũ…), [] nếu không mã hóa.
export async function downloadChunked({ serverUrl, token, meta, keys, write, onProgress }) {
  const { n, enc } = meta.chunked;
  const cs = meta.chunked.cs + (enc ? 16 : 0);
  const base = enc ? decodeBase64(meta.nonce) : null;
  let key = null, got = 0;
  for (let i = 0; i < n; i++) {
    const buf = await retry(async () => {
      const r = await fetch(`${serverUrl}/api/files/${meta.fileId}`, { headers: { Authorization: 'Bearer ' + token, Range: `bytes=${i * cs}-${(i + 1) * cs - 1}` } });
      if (!r.ok) throw Object.assign(new Error('Tải khúc lỗi'), { status: r.status });
      return new Uint8Array(await r.arrayBuffer());
    });
    let plain = buf;
    if (enc) {
      const nonce = chunkNonce(base, i);
      if (!key) for (const k of keys) { const p = nacl.secretbox.open(buf, nonce, decodeBase64(k)); if (p) { key = k; plain = p; break; } }
      else plain = nacl.secretbox.open(buf, nonce, decodeBase64(key));
      if (!key || !plain) throw new Error('Giải mã thất bại (sai khóa hoặc tệp bị sửa)');
    }
    await write(plain);
    got += plain.length;
    onProgress?.(meta.size ? got / meta.size : (i + 1) / n);
  }
}

// Nơi ghi tệp tải về: app desktop -> ghi thẳng ra đĩa (hộp thoại Lưu); trình duyệt hỗ trợ File System Access -> ghi
// thẳng ra tệp; còn lại -> gom trong bộ nhớ rồi tải xuống (giới hạn bởi RAM thiết bị).
export async function openSink(name, mime) {
  const f = window.reachat?.files;
  if (f?.openWrite) {
    const h = await f.openWrite(name);
    if (!h) return null;                                       // người dùng huỷ
    return { write: (u8) => f.write(h.id, u8), close: () => f.closeWrite(h.id), where: h.path };
  }
  if (window.showSaveFilePicker) {
    try {
      const fh = await window.showSaveFilePicker({ suggestedName: name });
      const w = await fh.createWritable();
      return { write: (u8) => w.write(u8), close: () => w.close(), where: fh.name };
    } catch (e) { if (e.name === 'AbortError') return null; }
  }
  const parts = [];
  return {
    write: (u8) => { parts.push(u8); },
    close: () => {
      const url = URL.createObjectURL(new Blob(parts, { type: mime || 'application/octet-stream' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
    where: name,
  };
}

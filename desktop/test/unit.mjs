// Unit test các module chạy trên máy người dùng: mã hóa (box/nhóm/ratchet), mã an toàn, cảnh báo lừa đảo,
// tóm tắt, mạng LAN. Chạy: npm test (trong desktop) — không cần server.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// crypto.js lưu khóa ở localStorage của renderer -> giả lập cho Node.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

// Gói các module bằng esbuild (đi kèm Vite) như lúc build app: tweetnacl-util là CommonJS, Node không import tên trực tiếp được.
const { build } = await import('esbuild');
const out = path.join(os.tmpdir(), 'reachat-unit-' + process.pid + '.mjs');
await build({
  stdin: { contents: "export * as crypto from './src/crypto.js'; export * as ratchet from './src/ratchet.js'; export { scanScam } from './src/safety.js'; export { summarize } from './src/summarize.js'; export * as syncdoc from './src/syncdoc.js';", resolveDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..') },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { crypto, ratchet, scanScam, summarize, syncdoc } = await import(pathToFileURL(out).href);
process.on('exit', () => { try { fs.unlinkSync(out); } catch {} });

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };

console.log('1) Box (khóa danh tính) + khóa nhóm');
const pkA = crypto.publicKeyBase64('an'), pkB = crypto.publicKeyBase64('bao'), pkC = crypto.publicKeyBase64('cuong');
ok(crypto.validPublicKey(pkA) && !crypto.validPublicKey('pk_rac') && !crypto.validPublicKey(null), 'kiểm tra khóa công khai hợp lệ / rác');
const boxed = crypto.encrypt('xin chào', pkB, 'an');
ok(crypto.decrypt(boxed, pkA, 'bao') === 'xin chào', 'box: người nhận giải được');
ok(crypto.decrypt(boxed, pkA, 'cuong') == null, 'box: người thứ ba không giải được');
const gk = crypto.newGroupKey();
const env = crypto.sealGroupKey(gk, pkB, 'an');
ok(crypto.openGroupKey(env, pkA, 'bao') === gk, 'niêm phong khóa nhóm cho thành viên');
ok(crypto.openGroupKey(env, pkA, 'cuong') == null, 'người ngoài không mở được khóa nhóm');
const gct = crypto.encryptGroup('họp lúc 9h', gk);
ok(crypto.decryptGroup(gct, gk) === 'họp lúc 9h' && crypto.decryptGroup(gct, crypto.newGroupKey()) == null, 'secretbox nhóm: đúng khóa giải được, sai khóa thì không');
const sealed = crypto.sealBytes(new Uint8Array([1, 2, 3]), gk);
ok(String(crypto.openBytes(sealed, [crypto.newGroupKey(), gk])) === '1,2,3', 'sealBytes/openBytes thử nhiều khóa');

console.log('2) Mã an toàn');
const sn1 = crypto.safetyNumber(pkA, 'an', pkB, 'bao'), sn2 = crypto.safetyNumber(pkB, 'bao', pkA, 'an');
ok(sn1 === sn2 && sn1.replace(/ /g, '').length === 60, 'hai bên ra cùng 60 chữ số');
ok(crypto.safetyNumber(pkA, 'an', pkC, 'bao') !== sn1, 'khóa bị tráo (MITM) -> mã khác');

console.log('3) Double Ratchet');
const kpA = crypto.getOrCreateKeypair('an'), kpB = crypto.getOrCreateKeypair('bao');
const A = await ratchet.initInitiator(kpA, pkB);
const B = await ratchet.initResponder(kpB, pkA);
const m1 = await ratchet.ratchetEncrypt(A, 'một'), m2 = await ratchet.ratchetEncrypt(A, 'hai'), m3 = await ratchet.ratchetEncrypt(A, 'ba');
ok(await ratchet.ratchetDecrypt(B, m1) === 'một', 'A -> B');
ok(await ratchet.ratchetDecrypt(B, m3) === 'ba' && await ratchet.ratchetDecrypt(B, m2) === 'hai', 'tin đến sai thứ tự (khóa bỏ qua)');
const r1 = await ratchet.ratchetEncrypt(B, 'trả lời');
ok(await ratchet.ratchetDecrypt(A, r1) === 'trả lời', 'B -> A (xoay DH)');
ok(await throws(() => ratchet.ratchetDecrypt(B, m1)), 'forward secrecy: không giải lại tin đã dùng khóa');
const B2 = ratchet.deserialize(ratchet.serialize(B));
const m4 = await ratchet.ratchetEncrypt(A, 'sau khi lưu');
ok(await ratchet.ratchetDecrypt(B2, m4) === 'sau khi lưu', 'serialize/deserialize giữ phiên');
const m5 = await ratchet.ratchetEncrypt(A, 'giả mạo');
const bad = { ...m5, ct: m5.ct.slice(0, -4) + (m5.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
ok(await throws(() => ratchet.ratchetDecrypt(ratchet.deserialize(ratchet.serialize(B2)), bad)), 'sửa bản mã -> bị phát hiện (Poly1305)');
const { header, mkB64 } = await ratchet.sendKey(A);
ok(await ratchet.receiveKey(B2, header) === mkB64, 'khóa media (sendKey/receiveKey) khớp hai bên');

console.log('4) Cảnh báo lừa đảo');
ok(scanScam('Cho mình xin mã OTP vừa gửi về điện thoại nhé').length > 0, 'xin mã OTP -> cảnh báo');
ok(scanScam('Chúc mừng bạn trúng thưởng iPhone, chuyển phí nhận quà 500k').length > 0, 'trúng thưởng + chuyển phí -> cảnh báo');
ok(scanScam('Đăng nhập lại tại http://vietcombank-xacminh.top để tránh khóa tài khoản').length > 0, 'link giả mạo ngân hàng -> cảnh báo');
ok(scanScam('Chiều nay 3h họp nhóm ở phòng 204 nhé').length === 0, 'tin bình thường -> không cảnh báo');

console.log('5) Tóm tắt');
const t0 = Date.now();
const s = summarize([
  { type: 'text', senderUsername: 'an', body: 'Mai họp dự án lúc 9h nhé @bao', createdAt: t0 },
  { type: 'text', senderUsername: 'cuong', body: 'Ok, ai chuẩn bị báo cáo dự án?', createdAt: t0 + 1 },   // câu hỏi của người khác
  { type: 'text', senderUsername: 'an', body: 'Gấp: gửi báo cáo dự án trước 17h', createdAt: t0 + 2 },
  { type: 'text', senderUsername: 'cuong', body: 'đã thu hồi', recalled: true, createdAt: t0 + 3 },
], 'bao');
ok(s.total === 3 && s.people[0].name === 'an', 'đếm tin + người nói nhiều nhất (bỏ tin thu hồi)');
ok(s.mentions.length === 1 && s.questions.length === 1 && s.urgent.length >= 1, 'nhắc tên mình / câu hỏi của người khác / việc gấp');

console.log('6) Giao diện tiếng Anh');
const { translateText } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n.js')).href);
ok(translateText('Sai username hoặc mật khẩu') === 'Wrong username or password' && translateText('  Gửi ') === '  Send ', 'dịch chuỗi giao diện, giữ khoảng trắng');
ok(translateText('3 thành viên') === '3 members' && translateText('@an đã vào phòng họp') === '@an joined the meeting', 'mẫu cho chuỗi có số / tên');
ok(translateText('🔔 Nhắc hẹn: gọi cho mẹ lúc 5h') === '🔔 Reminder: gọi cho mẹ lúc 5h', 'giữ nguyên phần nội dung người dùng trong thông báo');
ok(translateText('mai họp lúc 9h nhé') === 'mai họp lúc 9h nhé' && translateText('Hello') === 'Hello', 'tin nhắn bình thường không bị đổi');

console.log('7) Mạng LAN (UDP tìm nhau + TCP gửi tin)');
const require = createRequire(import.meta.url);
const { LanNode } = require('../electron/lan.cjs');
const n1 = new LanNode({ username: 'an', displayName: 'An', publicKey: pkA });
const n2 = new LanNode({ username: 'bao', displayName: 'Bảo', publicKey: pkB });
try {
  await n1.start(); await n2.start();
  const found = await new Promise((res) => { const t = setTimeout(() => res(null), 8000); n1.on('peers', (l) => { const p = l.find((x) => x.username === 'bao'); if (p) { clearTimeout(t); res(p); } }); });
  ok(!!found && found.publicKey === pkB, 'tìm thấy máy cùng mạng kèm khóa công khai');
  const got = new Promise((res) => { const t = setTimeout(() => res(null), 5000); n2.on('message', (m) => { clearTimeout(t); res(m); }); });
  if (found) await n1.send(found.id, { body: crypto.encrypt('qua LAN', pkB, 'an') });
  const msg = await got;
  ok(msg && crypto.decrypt(msg.body, pkA, 'bao') === 'qua LAN', 'gửi + giải mã tin qua LAN');
} catch (e) { ok(false, 'LAN: ' + e.message); }
finally { n1.stop(); n2.stop(); }

console.log('8) Đồng bộ giữa thiết bị (gộp tài liệu)');
{
  const { mergeDocs, emptyDoc, docHash } = syncdoc;
  const may1 = { ...emptyDoc(), convPrefs: { A: { pinned: true, t: 10 }, B: { muted: true, t: 5 } }, labels: { list: [{ id: 'l1', name: 'Việc' }], t: 3 },
    drafts: { A: { text: 'nháp máy 1', t: 20 } }, hidden: { m1: 1 }, starred: { s1: { on: true, t: 4 } } };
  const may2 = { ...emptyDoc(), convPrefs: { B: { muted: false, archived: true, t: 9 }, C: { pinned: true, t: 1 } }, labels: { list: [], t: 8 },
    drafts: { A: { text: '', t: 30 } }, hidden: { m2: 1 }, starred: { s1: { on: false, t: 7 } } };
  const g = mergeDocs(may1, may2);
  ok(g.convPrefs.A.pinned && g.convPrefs.B.archived && !g.convPrefs.B.muted && g.convPrefs.C.pinned, 'mỗi hội thoại lấy bản sửa sau (A từ máy 1, B và C từ máy 2)');
  ok(g.labels.t === 8 && g.labels.list.length === 0, 'nhãn: lấy bản sửa sau');
  ok(g.drafts.A.text === '', 'nháp đã gửi (xóa) ở máy 2 không bị máy 1 hồi sinh');
  ok(g.hidden.m1 && g.hidden.m2, 'tin xóa phía tôi: gộp cả hai');
  ok(g.starred.s1.on === false, 'bỏ sao ở máy 2 (sau) thắng');
  ok(docHash(mergeDocs(may2, may1)) === docHash(g), 'gộp theo thứ tự nào cũng ra cùng kết quả');
  ok(docHash(mergeDocs(g, g)) === docHash(g), 'gộp với chính nó không đổi');
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);

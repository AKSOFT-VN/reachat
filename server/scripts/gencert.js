// Tạo chứng chỉ TLS tự ký cho dev/LAN: certs/cert.pem + certs/key.pem, in vân tay SHA-256 để ghim trên client.
// Dùng: npm run gencert -- [tên-máy hoặc IP ...]   (mặc định: localhost, 127.0.0.1, ::1)
import selfsigned from 'selfsigned';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const names = process.argv.slice(2);
const hosts = ['localhost', '127.0.0.1', '::1', ...names];
const altNames = hosts.map((h) => (/^[\d.]+$/.test(h) || h.includes(':') ? { type: 7, ip: h } : { type: 2, value: h }));
const pems = selfsigned.generate([{ name: 'commonName', value: names[0] || 'localhost' }], {
  keySize: 2048, days: 825, algorithm: 'sha256',
  extensions: [{ name: 'basicConstraints', cA: false }, { name: 'subjectAltName', altNames }],
});
const dir = fileURLToPath(new URL('../certs/', import.meta.url));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + 'cert.pem', pems.cert);
fs.writeFileSync(dir + 'key.pem', pems.private, { mode: 0o600 });
const fp = new crypto.X509Certificate(pems.cert).fingerprint256;
console.log('Đã tạo', dir + 'cert.pem', 'cho', hosts.join(', '));
console.log('Vân tay SHA-256 (nhập vào ô "Ghim chứng chỉ" trên client):\n  ' + fp);

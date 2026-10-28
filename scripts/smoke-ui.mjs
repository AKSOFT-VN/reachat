// Kiểm tra giao diện tự động TRƯỚC khi phát hành: dựng máy chủ tạm + mở bản build thật (desktop/dist) trong Electron,
// rồi đi qua các luồng chính bằng Chrome DevTools Protocol:
//   đăng nhập -> tải lại app 2 lần (không được bị đăng xuất) -> mở mọi tab Cài đặt -> gửi tin -> mở bảng ＋ -> không có lỗi JS.
// Dùng: node scripts/smoke-ui.mjs   (scripts/release.mjs tự gọi). Thoát mã 1 nếu có bước hỏng.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4120, DBG = 9390, base = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachat-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv, app, failed = 0;
const step = (ok, name, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
const cleanup = () => { try { app?.kill(); } catch {} try { srv?.kill(); } catch {} setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 1500); };
process.on('exit', cleanup);

// ---- máy chủ tạm ----
const env = { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 't.db'), GIF_DIR: path.join(dir, 'gifs'), UPDATES_DIR: path.join(dir, 'up'),
  VAPID_FILE: path.join(dir, 'v.json'), TURN_BUILTIN: '0', CAPTCHA: '0', REG_PER_IP_HOUR: '0', REG_PER_IP_DAY: '0', TLS: '' };
srv = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env, stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await sleep(250); }
const reg = (u) => fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'smoke123', acceptTerms: true }) }).then((r) => r.json());
const [ra] = [await reg('smoke_a'), await reg('smoke_b')];
step(!!ra.token, 'máy chủ tạm + tài khoản thử');

// ---- mở app (bản build trong desktop/dist, hoặc bản đã đóng gói nếu đặt SMOKE_EXE=…/win-unpacked/ReaChat.exe) ----
const exe = process.env.SMOKE_EXE;
const electron = exe || createRequire(import.meta.url)(path.join(ROOT, 'node_modules', 'electron'));   // đường dẫn tệp chạy Electron
app = spawn(electron, [...(exe ? [] : ['.']), `--user-data-dir=${path.join(dir, 'ud')}`, `--remote-debugging-port=${DBG}`], {
  cwd: path.join(ROOT, 'desktop'), env: { ...process.env, REACHAT_SERVER: base, REACHAT_TRAY: '0' }, stdio: 'ignore' });
let page = null;
for (let i = 0; i < 80 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()).find((t) => t.type === 'page' && !t.url.startsWith('devtools')); } catch {}
  if (!page) await sleep(250);
}
if (!page) { step(false, 'mở được app'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let seq = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: `(async()=>{${HELP}${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || 'lỗi' };
  return r.result?.result?.value;
};
const HELP = `const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
const waitFor=async(sel,ms=10000)=>{for(let t=0;t<ms;t+=200){const e=document.querySelector(sel);if(e)return e;await sleep(200);}return null;};`;
// Ghi lại lỗi JS ở MỌI lần tải trang (kể cả sau reload)
await cdp('Page.enable');
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs=[];addEventListener('error',e=>window.__errs.push(e.message));addEventListener('unhandledrejection',e=>window.__errs.push('Promise: '+(e.reason?.message||e.reason)));` });
await cdp('Page.reload');
await sleep(2500);
const errs = async () => (await run('return window.__errs || []')) || [];

// 1) đăng nhập
let r = await run(`const u=await waitFor('.auth-card input'); if(!u) return 'không thấy màn đăng nhập';
  const ins=[...document.querySelectorAll('.auth-card input')]; set(ins[0],'smoke_a'); set(ins.find(i=>i.type==='password'),'smoke123');
  document.querySelector('.auth-card button.primary').click(); return (await waitFor('.cloud-row', 15000)) ? 'ok' : (document.querySelector('.auth-card .error')?.innerText || 'không vào được');`);
step(r === 'ok', 'đăng nhập', r !== 'ok' ? String(r?.__error || r) : '');
// 2) tải lại 2 lần — không được bị đăng xuất (lỗi của 0.8.0)
for (const n of [1, 2]) {
  await cdp('Page.reload'); await sleep(1500);
  r = await run(`return (await waitFor('.cloud-row', 12000)) ? 'ok' : (document.querySelector('.auth-card') ? 'BỊ ĐĂNG XUẤT' : 'không tải được');`);
  step(r === 'ok', `tải lại lần ${n} vẫn đăng nhập`, r !== 'ok' ? String(r) : '');
}
// 3) mọi tab Cài đặt
r = await run(`document.querySelector('button[title="Cài đặt"]').click(); await sleep(600);
  const tabs=[...document.querySelectorAll('.settings-modal .tabs button')]; const out=[];
  for (const t of tabs) { t.click(); await sleep(500); out.push(t.innerText.trim()); }
  document.querySelector('.modal-backdrop')?.click(); return out;`);
step(Array.isArray(r) && r.length >= 4, 'mở mọi tab Cài đặt', Array.isArray(r) ? r.join(', ') : String(r?.__error || r));
// 4) mở hội thoại với smoke_b + gửi tin
r = await run(`const i=document.querySelector('.new-chat input, input[placeholder*="username"]'); set(i,'smoke_b'); i.closest('form').requestSubmit();
  const c=await waitFor('.composer input:not([type=file]):not([type=hidden])', 10000); if(!c) return 'không mở được hội thoại';
  set(c,'tin kiểm tra tự động'); await sleep(200); c.closest('form').requestSubmit();
  for (let t=0;t<40;t++){ if([...document.querySelectorAll('.bubble.mine .body')].some(b=>b.innerText.includes('tin kiểm tra tự động'))) return 'ok'; await sleep(250); }
  return 'tin không hiện';`);
step(r === 'ok', 'mở hội thoại + gửi tin', r !== 'ok' ? String(r?.__error || r) : '');
// 5) bảng ＋
r = await run(`document.querySelector('.icon-btn.plus')?.click(); await sleep(500); const n=document.querySelectorAll('.more-menu button').length; document.querySelector('.icon-btn.plus')?.click(); return n;`);
step(r >= 5, 'mở bảng ＋', `${r} mục`);
// 6) CSP cho phép thứ mà nhận dạng giọng nói cần: WebAssembly + Worker từ blob:
r = await run(`try { await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); } catch (e) { return 'wasm: ' + e.message; }
  const u = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
  try { const w = new Worker(u); const v = await new Promise((ok, no) => { w.onmessage = (m) => ok(m.data); w.onerror = () => no(new Error('worker bị chặn')); setTimeout(() => no(new Error('worker hết giờ')), 3000); }); w.terminate(); return v === 1 ? 'ok' : 'sai'; }
  catch (e) { return 'worker: ' + e.message; }`);
step(r === 'ok', 'CSP cho WebAssembly + Worker (giọng nói→chữ)', r !== 'ok' ? String(r?.__error || r) : '');
// 7) không rời được trang ứng dụng (chặn điều hướng sang trang/tệp lạ — trang lạ sẽ không được dùng IPC)
{
  const before = await run('return location.href;');
  await cdp('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(process.platform === 'win32' ? 'file:///C:/Windows/win.ini' : 'file:///etc/hosts')}` });
  await sleep(800);
  r = await run('return location.href === ' + JSON.stringify(before) + ' && !!window.reachat?.config ? "ok" : location.href;');
  step(r === 'ok', 'chặn điều hướng cửa sổ sang tệp lạ', r !== 'ok' ? String(r?.__error || r) : '');
}
// 8) không có lỗi JS
const e = await errs();
step(!e.length, 'không có lỗi JavaScript', e.slice(0, 3).join(' | '));

try { ws.send(JSON.stringify({ id: ++seq, method: 'Browser.close' })); } catch {}   // trình duyệt đóng thì không trả lời -> không chờ
console.log(failed ? `\n✗ Kiểm tra giao diện: ${failed} bước hỏng` : '\n✓ Kiểm tra giao diện đạt');
await sleep(500);
process.exit(failed ? 1 : 0);

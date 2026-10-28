// Âm thanh: nhạc chuông cuộc gọi đến, chuông chờ khi gọi đi, âm báo tin nhắn — tự tạo bằng Web Audio (không cần tệp).
// Tùy chọn lưu ở localStorage 'reachat.sound' = { msg, call, volume }.
let ctx = null;
const ac = () => {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
};
// Trình duyệt chặn phát âm thanh trước lần tương tác đầu tiên -> mở khóa ở cú bấm/phím đầu tiên.
if (typeof window !== 'undefined') {
  const unlock = () => { try { ac(); } catch {} window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
}

export function getSoundPrefs() {
  try { return { msg: true, call: true, volume: 0.6, ...JSON.parse(localStorage.getItem('reachat.sound') || '{}') }; }
  catch { return { msg: true, call: true, volume: 0.6 }; }
}
export const setSoundPrefs = (p) => { try { localStorage.setItem('reachat.sound', JSON.stringify({ ...getSoundPrefs(), ...p })); } catch {} };

// Một nốt: tần số (Hz), bắt đầu sau `at` giây, kéo dài `dur` giây, có bao (attack/release) để không lách cách.
function note(freq, at, dur, gain = 0.25, type = 'sine') {
  const c = ac(), t0 = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq;
  const v = gain * getSoundPrefs().volume;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(v, t0 + 0.015);
  g.gain.setValueAtTime(v, t0 + Math.max(0.02, dur - 0.06));
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

// Âm báo tin nhắn: hai nốt ngắn đi lên.
export function playMessage(force = false) {
  if (!force && !getSoundPrefs().msg) return;
  try { note(880, 0, 0.12, 0.22, 'triangle'); note(1318.5, 0.11, 0.18, 0.2, 'triangle'); } catch {}
}

// Nhạc chuông: 'in' = có cuộc gọi đến (giai điệu lặp mỗi 2,6 s), 'out' = chuông chờ khi đang gọi (425 Hz như tổng đài VN).
// Trả về hàm dừng.
export function startRing(kind = 'in', force = false) {
  if (!force && !getSoundPrefs().call) return () => {};
  const play = () => {
    try {
      if (kind === 'out') { note(425, 0, 1.0, 0.18); return; }
      [659.25, 783.99, 987.77, 783.99].forEach((f, i) => note(f, i * 0.16, 0.15, 0.24, 'triangle'));
      [659.25, 783.99, 987.77, 783.99].forEach((f, i) => note(f, 0.75 + i * 0.16, 0.15, 0.24, 'triangle'));
    } catch {}
  };
  play();
  const iv = setInterval(play, kind === 'out' ? 4000 : 2600);
  return () => clearInterval(iv);
}

// Chuyển tin thoại thành chữ NGAY TRÊN MÁY (giọng nói không gửi đi đâu). Dùng: transcribe(blobUrl, onProgress) -> text.
import wasmMjs from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import wasmBin from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url';

export const STT_MODEL = 'Xenova/whisper-base';
let worker = null, seq = 0;
const waiting = new Map();
const getWorker = () => {
  if (worker) return worker;
  worker = new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const w = waiting.get(e.data.id); if (!w) return;
    if (e.data.progress) return w.onProgress?.(e.data.progress);
    waiting.delete(e.data.id);
    e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data.text);
  };
  return worker;
};
// Giải mã âm thanh (webm/opus...) -> mono 16 kHz Float32 (đầu vào của Whisper).
async function decode16k(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
    return (await off.startRendering()).getChannelData(0);
  } finally { ctx.close(); }
}
export async function transcribe(url, onProgress, language) {
  const audio = await decode16k(url);
  const id = ++seq;
  const abs = (u) => new URL(u, location.href).href;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, audio, base: window.reachat.serverUrl, model: STT_MODEL, language, wasm: { mjs: abs(wasmMjs), wasm: abs(wasmBin) } }, [audio.buffer]);
  });
}

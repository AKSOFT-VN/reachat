// Web Worker nhận dạng giọng nói (Whisper qua transformers.js / ONNX WebAssembly) — chạy hoàn toàn trên máy.
// Mô hình tải từ máy chủ ReaChat (/models/...) lần đầu rồi trình duyệt tự nhớ (Cache Storage).
import { pipeline, env } from '@huggingface/transformers';

let asr = null, loading = null;
self.onmessage = async (e) => {
  const { id, audio, base, model, wasm, language } = e.data;
  try {
    if (!asr) {
      loading ||= (async () => {
        env.allowLocalModels = false;
        env.remoteHost = base + '/models/';
        env.remotePathTemplate = '{model}/';
        env.backends.onnx.wasm.wasmPaths = wasm;          // tệp .wasm/.mjs đóng gói kèm app (không tải từ CDN)
        env.backends.onnx.wasm.numThreads = 1;
        asr = await pipeline('automatic-speech-recognition', model, {
          dtype: 'q8', device: 'wasm',
          progress_callback: (p) => { if (p.status === 'progress') self.postMessage({ id, progress: { file: p.file, loaded: p.loaded, total: p.total } }); },
        });
      })();
      await loading;
    }
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe', ...(language ? { language } : {}) });
    self.postMessage({ id, text: String(out.text || '').trim() });
  } catch (err) {
    loading = null; asr = null;
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

// Tải mô hình nhận dạng giọng nói (Whisper, bản ONNX nén cho transformers.js) về máy chủ — app tải từ máy chủ ReaChat,
// không cần kết nối tới Hugging Face. Chạy một lần: npm run fetch-stt-model   (STT_MODEL mặc định Xenova/whisper-base)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = process.env.STT_MODEL || 'Xenova/whisper-base';
const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('../data.db', import.meta.url));
const DIR = process.env.MODELS_DIR || path.join(path.dirname(DB_PATH), 'models');
const FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
for (const f of FILES) {
  const out = path.join(DIR, MODEL, f);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) { console.log('đã có', f); continue; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${f}`);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  fs.writeFileSync(out + '.part', Buffer.from(await r.arrayBuffer())); fs.renameSync(out + '.part', out);
  console.log('tải xong', f, (fs.statSync(out).size / 1048576).toFixed(1), 'MB');
}
console.log('Mô hình ở', path.join(DIR, MODEL));

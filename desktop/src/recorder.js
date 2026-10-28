// Ghi cuộc gọi NGAY TRÊN MÁY (không qua server): ghép hình các ô đang hiển thị lên một canvas + trộn tiếng
// của mọi người (mic mình + luồng nhận) -> MediaRecorder -> tệp .webm. Người trong cuộc gọi được báo "đang ghi".
import fixWebmDuration from 'fix-webm-duration';

export class CallRecorder {
  // getVideos(): các <video> đang hiển thị; getStreams(): mọi MediaStream có tiếng (mình + người khác).
  constructor({ getVideos, getStreams, title }) {
    this.getVideos = getVideos; this.getStreams = getStreams; this.title = title || 'Cuộc gọi';
    this.chunks = []; this.sources = new Map(); this.timer = null;
  }

  start() {
    const W = 1280, H = 720;
    this.canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const g = this.canvas.getContext('2d');
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
    this.started = Date.now();
    const draw = () => {
      this._syncAudio();
      g.fillStyle = '#0b0d11'; g.fillRect(0, 0, W, H);
      const vids = this.getVideos().filter((v) => v.videoWidth > 0 && !v.paused);
      if (!vids.length) {                                        // gọi thoại: khung chữ + thời lượng
        g.fillStyle = '#e6e8ec'; g.font = '600 40px system-ui'; g.textAlign = 'center';
        g.fillText('🔊 ' + this.title, W / 2, H / 2 - 10);
      } else {
        const n = vids.length, cols = n <= 1 ? 1 : n <= 4 ? 2 : 3, rows = Math.ceil(n / cols);
        const cw = W / cols, ch = H / rows;
        vids.forEach((v, i) => {
          const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
          const r = Math.min(cw / v.videoWidth, ch / v.videoHeight), w = v.videoWidth * r, h = v.videoHeight * r;
          g.drawImage(v, x + (cw - w) / 2, y + (ch - h) / 2, w, h);
        });
      }
      const s = Math.round((Date.now() - this.started) / 1000);
      g.fillStyle = 'rgba(229,72,77,.9)'; g.beginPath(); g.arc(28, 28, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = '600 20px system-ui'; g.textAlign = 'left';
      g.fillText(`REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, 46, 35);
    };
    draw();
    this.timer = setInterval(draw, 66);                          // ~15 khung/giây (setInterval vẫn chạy khi cửa sổ ẩn)
    const mixed = new MediaStream([...this.canvas.captureStream(15).getVideoTracks(), ...this.dest.stream.getAudioTracks()]);
    const type = ['video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(mixed, { mimeType: type, videoBitsPerSecond: 1_500_000 });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
  }

  // Nối thêm nguồn tiếng mới (người vừa vào, track được thay khi chia sẻ/khôi phục mic).
  _syncAudio() {
    const seen = new Set();
    for (const st of this.getStreams()) for (const t of st?.getAudioTracks() || []) {
      seen.add(t.id);
      if (this.sources.has(t.id) || t.readyState !== 'live') continue;
      const src = this.ctx.createMediaStreamSource(new MediaStream([t]));
      src.connect(this.dest);
      this.sources.set(t.id, src);
    }
    for (const [id, src] of this.sources) if (!seen.has(id)) { try { src.disconnect(); } catch {} this.sources.delete(id); }
  }

  // Dừng và trả về Blob .webm (null nếu chưa ghi được gì).
  stop() {
    return new Promise((resolve) => {
      clearInterval(this.timer);
      const done = () => {
        try { this.ctx.close(); } catch {}
        if (!this.chunks.length) return resolve(null);
        // MediaRecorder không ghi thời lượng vào tệp webm -> bổ sung để trình phát tua được.
        const blob = new Blob(this.chunks, { type: 'video/webm' });
        fixWebmDuration(blob, Date.now() - this.started, { logger: false }).then(resolve, () => resolve(blob));
      };
      if (!this.rec || this.rec.state === 'inactive') return done();
      this.rec.onstop = done;
      this.rec.stop();
    });
  }
}

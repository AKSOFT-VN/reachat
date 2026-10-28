// Đo lưu lượng qua TURN Cloudflare để máy chủ giữ hạn mức miễn phí (xem server/src/turnquota.js).
// Bọc RTCPeerConnection: mọi kết nối (gọi 1-1, gọi nhóm, gửi tệp P2P) có TURN Cloudflare trong cấu hình đều được đo.
// Mỗi 20 giây: nếu cặp ứng viên đang dùng là "relay" -> cộng phần byte NHẬN tăng thêm, báo về máy chủ.
import { reportTurnUsage } from './api.js';

const tracked = new Map();     // pc -> byte đã tính
let pending = 0;
const Native = window.RTCPeerConnection;

async function sample(pc) {
  try {
    const st = await pc.getStats();
    let pair = null;
    st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
    if (!pair) st.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const local = pair && st.get(pair.localCandidateId);
    if (local?.candidateType !== 'relay') return;
    const now = pair.bytesReceived || 0, last = tracked.get(pc) || 0;
    if (now > last) { pending += now - last; tracked.set(pc, now); }
  } catch {}
}
async function tick() {
  for (const [pc] of tracked) {
    await sample(pc);
    if (pc.connectionState === 'closed' || pc.signalingState === 'closed') tracked.delete(pc);
  }
  if (pending > 0) { const b = pending; pending = 0; reportTurnUsage(b).catch(() => { pending += b; }); }
}

if (Native) {
  window.RTCPeerConnection = class extends Native {
    constructor(cfg, ...rest) {
      super(cfg, ...rest);
      if (JSON.stringify(cfg?.iceServers || []).includes('turn.cloudflare.com')) {
        tracked.set(this, 0);
        const close = this.close.bind(this);
        this.close = () => { Promise.race([sample(this), new Promise((r) => setTimeout(r, 300))]).finally(() => { close(); tick(); }); };   // lấy số cuối rồi mới đóng
      }
    }
  };
  setInterval(tick, 20000);
}

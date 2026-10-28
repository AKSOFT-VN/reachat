// Cuộc gọi nhóm dạng MESH: mỗi cặp người tham gia có một RTCPeerConnection riêng (tái dùng CallSession).
// Người VÀO SAU chủ động gửi offer tới từng người đã có trong phòng -> không bao giờ hai bên cùng offer.
// Media đi thẳng giữa các máy (hoặc qua TURN), mã hóa DTLS-SRTP; server chỉ chuyển tín hiệu theo pid.
// Mesh hợp lý tới ~6 người (mỗi máy gửi N-1 luồng) — đông hơn cần SFU.
import { CallSession, keepTracksAlive } from './call.js';

export class GroupCall {
  // send(pid, data, username): gửi tín hiệu tới đúng thiết bị trong phòng (App niêm phong theo username). onChange(peers): danh sách peer đổi.
  constructor({ video, rtcConfig, send, onChange, onLocalStream }) {
    this.video = video; this.rtcConfig = rtcConfig; this.send = send;
    this.onChange = onChange; this.onLocalStream = onLocalStream;
    this.local = null;
    this.peers = new Map();   // pid -> { username, sess, stream, status, route }
    this.ended = false;
  }

  async init() {
    try {
      this.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: this.video });
    } catch (e) {
      if (!this.video) throw e;
      this.video = false;      // không có camera -> vào bằng tiếng
      this.local = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    this.onLocalStream?.(this.local);
    keepTracksAlive(this.local, {
      senders: () => [...this.peers.values()].flatMap((p) => p.sess?.pc?.getSenders() || []),
      isEnded: () => this.ended,
      onReplaced: (st) => this.onLocalStream?.(new MediaStream(st.getTracks())),   // ô "Bạn" vẽ lại
    });
  }

  _emit() {
    this.onChange?.([...this.peers.entries()].map(([pid, p]) => ({ pid, username: p.username, stream: p.stream, status: p.status, route: p.route, sharing: !!p.sharing, recording: !!p.recording })));
  }

  _session(pid, username, initiator) {
    const p = { username, stream: null, status: 'connecting', route: null };
    p.sess = new CallSession({
      callId: pid, peer: username, video: this.video, rtcConfig: this.rtcConfig, initiator,
      localStream: this.local,
      sendSignal: (data) => { if (data.kind !== 'hangup') this.send(pid, data, username); },   // rời phòng do server báo
      onRemoteStream: (st) => { p.stream = st; this._emit(); },
      onState: (s, extra) => {
        if (s === 'route') p.route = extra;
        else if (s === 'ended') { this.peers.delete(pid); }
        else p.status = s;
        this._emit();
      },
    });
    this.peers.set(pid, p);
    this._emit();
    return p.sess;
  }

  // Vừa vào phòng: gọi tới tất cả người đang có.
  async connectAll(list) {
    await Promise.all(list.map(async ({ pid, username }) => {
      const sess = this._session(pid, username, true);
      try { await sess.start(); if (this.screen) { await sess.setScreen(this.screen); this.send(pid, { kind: 'screen', on: true }, username); } } catch { this.remove(pid); }
    }));
  }

  // Chia sẻ màn hình tới mọi người trong phòng (cả người vào sau).
  async setScreen(track) {
    this.screen = track || null;
    await Promise.all([...this.peers.values()].map((p) => p.sess?.setScreen(track).catch(() => {})));
  }

  async onSignal(pid, username, data) {
    if (this.ended || !data) return;
    const p = this.peers.get(pid);
    if (data.kind === 'offer') {
      if (p) return;                                               // trùng offer -> bỏ qua
      try { const sess = this._session(pid, username, false); await sess.accept(data.sdp); if (this.screen) { await sess.setScreen(this.screen); this.send(pid, { kind: 'screen', on: true }, username); } } catch { this.remove(pid); }
      return;
    }
    if (!p) return;                                                // server giữ thứ tự: offer luôn tới trước ICE
    if (data.kind === 'screen') { p.sharing = !!data.on; this._emit(); return; }
    if (data.kind === 'record') { p.recording = !!data.on; this._emit(); return; }
    if (data.kind === 'answer') await p.sess?.onAnswer(data.sdp);
    else if (data.kind === 'reoffer') { try { await p.sess?.onReoffer(data.sdp); } catch {} }
    else if (data.kind === 'ice') await p.sess?.onIce(data.candidate);
  }

  remove(pid) {
    const p = this.peers.get(pid);
    if (!p) return;
    this.peers.delete(pid);
    try { p.sess?.hangup(false); } catch {}
    this._emit();
  }

  // Rớt kết nối máy chủ: server đã cho mình rời phòng -> bỏ mọi kết nối cũ, GIỮ mic/camera để vào lại.
  resetPeers() { for (const pid of [...this.peers.keys()]) this.remove(pid); }

  toggleMute() { const a = this.local?.getAudioTracks()[0]; if (!a) return false; a.enabled = !a.enabled; return !a.enabled; }
  toggleCam() { const v = this.local?.getVideoTracks()[0]; if (!v) return false; v.enabled = !v.enabled; return !v.enabled; }

  leave() {
    if (this.ended) return;
    this.ended = true;
    this.screen?.stop(); this.screen = null;
    for (const pid of [...this.peers.keys()]) this.remove(pid);
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
  }
}

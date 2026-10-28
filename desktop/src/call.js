// Cuộc gọi thoại/video 1-1 qua WebRTC. Server chỉ relay signaling (offer/answer/
// ICE) — luồng âm thanh/hình ảnh đi THẲNG giữa hai máy (P2P).
//
// NAT: cấu hình ICE do server cấp (/api/ice): STUN + TURN (thông tin đăng nhập tạm thời). Khi P2P
// trực tiếp thất bại (NAT đối xứng/tường lửa), media đi qua TURN — vẫn mã hóa đầu-cuối DTLS-SRTP,
// máy chủ TURN chỉ chuyển gói đã mã hóa. Rớt mạng giữa chừng -> thử ICE restart trước khi cúp.
const DEFAULT_ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Giữ mic/camera sống: track kết thúc NGOÀI Ý MUỐN (rút thiết bị, driver khởi động lại, hoặc Chromium đóng
// thiết bị trễ ngay sau cuộc gọi trước) -> lấy lại thiết bị cùng loại và thay vào mọi kết nối (replaceTrack,
// không cần đàm phán lại). stop() chủ động không phát sự kiện 'ended' nên không bị kích hoạt khi cúp máy.
export function keepTracksAlive(stream, { senders, onReplaced, isEnded }) {
  const tries = { audio: 0, video: 0 };
  const watch = (t) => t.addEventListener('ended', async () => {
    if (isEnded() || tries[t.kind] >= 3) return;
    tries[t.kind]++;
    await new Promise((r) => setTimeout(r, 300 * tries[t.kind]));
    if (isEnded()) return;
    try {
      const fresh = (await navigator.mediaDevices.getUserMedia({ [t.kind]: true })).getTracks()[0];
      if (isEnded()) { fresh.stop(); return; }
      fresh.enabled = t.enabled;
      stream.removeTrack(t); stream.addTrack(fresh);
      for (const s of senders()) if (s.track === t || (s.track?.kind === t.kind && s.track.readyState === 'ended')) await s.replaceTrack(fresh).catch(() => {});
      watch(fresh);
      onReplaced?.(stream);
    } catch {}
  });
  stream.getTracks().forEach(watch);
}


export class CallSession {
  // sendSignal(data): gửi gói signaling (kèm callId) tới đối phương.
  constructor({ callId, peer, video, sendSignal, onState, onRemoteStream, onLocalStream, rtcConfig, initiator = false, localStream = null }) {
    this.callId = callId; this.peer = peer; this.video = video;
    this.rtcConfig = rtcConfig || DEFAULT_ICE; this.initiator = initiator;
    this.restarts = 0; this.dropTimer = null;
    this.sendSignal = sendSignal;
    this.onState = onState; this.onRemoteStream = onRemoteStream; this.onLocalStream = onLocalStream;
    this.pc = null; this.localStream = null; this.pendingIce = []; this.remoteSet = false;
    this.ended = false;
    this.sharedStream = localStream;   // gọi nhóm: dùng chung một luồng mic/camera cho mọi kết nối
  }

  _setupPc() {
    const pc = new RTCPeerConnection(this.rtcConfig);
    this.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) this.sendSignal({ kind: 'ice', candidate: e.candidate }); };
    // Gom mọi track nhận được vào một luồng (kênh video của gọi thoại không gắn stream).
    this.remote = new MediaStream();
    pc.ontrack = (e) => {
      if (!this.remote.getTracks().includes(e.track)) this.remote.addTrack(e.track);
      this.onRemoteStream?.(new MediaStream(this.remote.getTracks()));
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') { clearTimeout(this.dropTimer); this.restarts = 0; this.onState?.('connected'); this._reportRoute(); }
      else if (s === 'closed') this.hangup(false);
      else if (s === 'disconnected') {                    // thường tự hồi phục; quá 5s -> ICE restart
        this.onState?.('reconnecting');
        clearTimeout(this.dropTimer);
        this.dropTimer = setTimeout(() => { if (this.pc?.connectionState !== 'connected') this._restart(); }, 5000);
      } else if (s === 'failed') this._restart();
    };
  }

  // ICE restart (bên gọi tạo offer mới); tối đa 2 lần rồi mới cúp máy.
  async _restart() {
    if (this.ended || !this.pc) return;
    if (this.restarts >= 2) { this.hangup(true); return; }
    this.restarts++;
    this.onState?.('reconnecting');
    if (!this.initiator) return;                          // bên nhận chờ offer restart từ bên gọi
    try {
      this.remoteSet = false;
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ kind: 'reoffer', sdp: offer });
    } catch { this.hangup(true); }
    clearTimeout(this.dropTimer);
    this.dropTimer = setTimeout(() => { if (this.pc?.connectionState !== 'connected') this._restart(); }, 10000);
  }

  // Bên nhận: offer ICE-restart giữa cuộc gọi.
  async onReoffer(offer) {
    if (!this.pc) return;
    this.remoteSet = false;
    await this.pc.setRemoteDescription(offer);
    this.remoteSet = true;
    await this._flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal({ kind: 'answer', sdp: answer });
  }

  // Loại đường truyền đang dùng: 'relay' = qua TURN, 'host'/'srflx' = P2P trực tiếp.
  async _reportRoute() {
    try {
      const stats = await this.pc.getStats();
      let pair = null; const cands = {};
      stats.forEach((r) => { if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r; });
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const lt = cands[pair?.localCandidateId]?.candidateType, rt = cands[pair?.remoteCandidateId]?.candidateType;
      if (lt) this.onState?.('route', lt === 'relay' || rt === 'relay' ? 'relay' : 'p2p');
    } catch {}
  }

  async _getMedia() {
    this.localStream = this.sharedStream || await navigator.mediaDevices.getUserMedia({ audio: true, video: this.video });
    if (!this.sharedStream) {
      this.onLocalStream?.(this.localStream);
      keepTracksAlive(this.localStream, { senders: () => this.pc?.getSenders() || [], isEnded: () => this.ended,
        onReplaced: (st) => this.onLocalStream?.(new MediaStream(st.getTracks())) });
    }
    for (const t of this.localStream.getTracks()) this.pc.addTrack(t, this.localStream);
  }

  // Người gọi khởi tạo. Gọi thoại vẫn mở sẵn một kênh video rỗng -> chia sẻ màn hình chỉ cần replaceTrack.
  async start() {
    this._setupPc();
    await this._getMedia();
    if (!this.pc.getTransceivers().some((t) => t.receiver.track?.kind === 'video')) this.pc.addTransceiver('video', { direction: 'sendrecv' });
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ kind: 'offer', video: this.video, sdp: offer });
  }

  // Người nhận chấp nhận (offer đã nhận từ signaling).
  async accept(offer) {
    this._setupPc();
    await this._getMedia();
    await this.pc.setRemoteDescription(offer);
    this.remoteSet = true;
    // Kênh video chưa có nguồn (gọi thoại) -> vẫn để hai chiều để mình cũng chia sẻ màn hình được.
    for (const t of this.pc.getTransceivers()) if (t.receiver.track?.kind === 'video' && !t.sender.track) t.direction = 'sendrecv';
    await this._flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal({ kind: 'answer', sdp: answer });
  }

  // Chia sẻ màn hình: thay hình gửi đi bằng track màn hình; dừng thì trả lại camera (hoặc để trống khi gọi thoại).
  async setScreen(track) {
    const tr = this.pc?.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
    if (!tr) return;
    if (track) { if (this.camTrack === undefined) this.camTrack = tr.sender.track; await tr.sender.replaceTrack(track); }
    else { await tr.sender.replaceTrack(this.camTrack ?? null); this.camTrack = undefined; }
  }

  // Người gọi nhận answer.
  async onAnswer(answer) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(answer);
    this.remoteSet = true;
    await this._flushIce();
  }

  async onIce(candidate) {
    if (!this.pc) { this.pendingIce.push(candidate); return; }
    if (this.remoteSet) { try { await this.pc.addIceCandidate(candidate); } catch {} }
    else this.pendingIce.push(candidate);
  }
  async _flushIce() {
    for (const c of this.pendingIce.splice(0)) { try { await this.pc.addIceCandidate(c); } catch {} }
  }

  toggleMute() { const a = this.localStream?.getAudioTracks()[0]; if (!a) return false; a.enabled = !a.enabled; return !a.enabled; }
  toggleCam() { const v = this.localStream?.getVideoTracks()[0]; if (!v) return false; v.enabled = !v.enabled; return !v.enabled; }

  hangup(notify = true) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.dropTimer);
    if (notify) { try { this.sendSignal({ kind: 'hangup' }); } catch {} }
    try { this.pc?.close(); } catch {}
    if (!this.sharedStream) this.localStream?.getTracks().forEach((t) => t.stop());
    this.pc = null; this.localStream = null;
    this.onState?.('ended');
  }
}

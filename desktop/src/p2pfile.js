// Gửi tệp TRỰC TIẾP máy-tới-máy (WebRTC DataChannel, mã hóa DTLS): máy chủ chỉ chuyển tín hiệu bắt tay
// (đã niêm phong bằng khóa danh tính), KHÔNG lưu tệp. Không giới hạn kích thước; hai bên phải cùng online.
// Tín hiệu: ft-offer {sdp, meta} -> ft-answer {sdp} / ft-ice {candidate} / ft-cancel / ft-taken (đã có thiết bị khác nhận).
const MSG = 64 * 1024;                 // kích thước mỗi gói DataChannel
const READ = 1024 * 1024;              // đọc tệp từng 1 MB
const HIGH = 8 * 1024 * 1024, LOW = 1024 * 1024;   // chống tràn bộ đệm gửi

// Bên gửi. signal(data) gửi tín hiệu tới người nhận. Trả về { id, cancel, onSignal, done: Promise }.
export function startSend({ id, file, rtcConfig, signal, onProgress, onState }) {
  const pc = new RTCPeerConnection(rtcConfig);
  const dc = pc.createDataChannel('file', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW;
  let answered = false, closed = false, resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const close = (err) => { if (closed) return; closed = true; try { dc.close(); } catch {} try { pc.close(); } catch {} err ? rejectDone(err) : resolveDone(); };
  pc.onicecandidate = (e) => { if (e.candidate) signal({ kind: 'ft-ice', candidate: e.candidate }); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') close(new Error('Không kết nối trực tiếp được giữa hai máy (tường lửa / NAT)')); };
  dc.onmessage = (e) => { if (e.data === 'done') { onState?.('done'); close(); } };
  dc.onopen = async () => {
    onState?.('sending');
    let sent = 0;
    try {
      for (let off = 0; off < file.size && !closed; off += READ) {
        const buf = new Uint8Array(await file.slice(off, Math.min(file.size, off + READ)).arrayBuffer());
        for (let i = 0; i < buf.length && !closed; i += MSG) {
          if (dc.bufferedAmount > HIGH) await new Promise((r) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); }; });
          dc.send(buf.subarray(i, i + MSG));
          sent += Math.min(MSG, buf.length - i);
          onProgress?.(sent / file.size);
        }
      }
      onState?.('waiting');                                   // chờ bên nhận ghi xong
    } catch (e) { close(e); }
  };
  dc.onclose = () => { if (!closed) close(new Error('Kết nối bị đóng giữa chừng')); };
  (async () => {
    await pc.setLocalDescription(await pc.createOffer());
    signal({ kind: 'ft-offer', sdp: pc.localDescription, meta: { name: file.name, size: file.size, mime: file.type || '' } });
  })().catch((e) => close(e));
  return {
    id, done,
    cancel: () => { signal({ kind: 'ft-cancel' }); close(new Error('Đã huỷ')); },
    async onSignal(d) {
      if (d.kind === 'ft-answer' && !answered) { answered = true; await pc.setRemoteDescription(d.sdp); signal({ kind: 'ft-taken' }); }
      else if (d.kind === 'ft-ice' && d.candidate) { try { await pc.addIceCandidate(d.candidate); } catch {} }
      else if (d.kind === 'ft-cancel') close(new Error(d.reason === 'offline' ? 'Người nhận đang offline' : d.reason === 'unavailable' ? 'Không gửi được cho người này' : 'Người nhận đã từ chối / huỷ'));
    },
  };
}

// Bên nhận (sau khi người dùng bấm Nhận và chọn nơi lưu). sink: { write(u8), close() }.
export function startReceive({ id, offer, meta, rtcConfig, signal, sink, onProgress }) {
  const pc = new RTCPeerConnection(rtcConfig);
  let got = 0, closed = false, chain = Promise.resolve(), resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const close = (err) => { if (closed) return; closed = true; try { pc.close(); } catch {} err ? rejectDone(err) : resolveDone(); };
  pc.onicecandidate = (e) => { if (e.candidate) signal({ kind: 'ft-ice', candidate: e.candidate }); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') close(new Error('Không kết nối trực tiếp được giữa hai máy (tường lửa / NAT)')); };
  pc.ondatachannel = (e) => {
    const dc = e.channel;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      const u8 = new Uint8Array(ev.data);
      got += u8.length;
      onProgress?.(got / meta.size);
      chain = chain.then(() => sink.write(u8));                // ghi đĩa theo đúng thứ tự
      if (got >= meta.size) chain.then(() => sink.close()).then(() => { try { dc.send('done'); } catch {} setTimeout(() => close(), 500); }, (err) => close(err));
    };
    dc.onclose = () => { if (got < meta.size) close(new Error('Kết nối bị đóng giữa chừng')); };
  };
  (async () => {
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    signal({ kind: 'ft-answer', sdp: pc.localDescription });
  })().catch((e) => close(e));
  return {
    id, done,
    cancel: () => { signal({ kind: 'ft-cancel' }); close(new Error('Đã huỷ')); },
    async onSignal(d) {
      if (d.kind === 'ft-ice' && d.candidate) { try { await pc.addIceCandidate(d.candidate); } catch {} }
      else if (d.kind === 'ft-cancel') close(new Error('Người gửi đã huỷ'));
    },
  };
}

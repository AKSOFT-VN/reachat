// Nhắn tin trong mạng LAN khi KHÔNG có Internet/server.
// - Tìm nhau: UDP broadcast (cổng 41234) mỗi 3s một gói giới thiệu {username, publicKey, port}.
// - Gửi tin: TCP tới cổng của đối phương, mỗi dòng 1 JSON (NDJSON).
// Nội dung đã được renderer mã hóa đầu-cuối (nacl.box) -> lớp này chỉ chuyển dữ liệu mờ.
const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DISCOVERY_PORT = Number(process.env.REACHAT_LAN_PORT || 41234);
const ANNOUNCE_MS = 3000, PEER_TTL_MS = 10000;

// Địa chỉ broadcast của từng card mạng IPv4 (+ 255.255.255.255 + loopback để test cùng máy).
function broadcastAddrs() {
  const out = new Set(['255.255.255.255', '127.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number);
      out.add(ip.map((b, k) => (b & mask[k]) | (~mask[k] & 255)).join('.'));
    }
  }
  return [...out];
}

class LanNode extends EventEmitter {
  constructor({ username, displayName, publicKey }) {
    super();
    this.me = { username, displayName: displayName || username, publicKey, id: crypto.randomBytes(6).toString('hex') };
    this.peers = new Map();            // id -> { id, username, displayName, publicKey, address, port, lastSeen }
  }

  async start() {
    // TCP nhận tin
    this.server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        buf += d;
        if (buf.length > 2e6) return sock.destroy();       // chặn gói quá lớn
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { this.emit('message', { ...JSON.parse(line), address: sock.remoteAddress }); } catch {}
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(0, '0.0.0.0', res); });
    this.port = this.server.address().port;

    // UDP tìm nhau
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('message', (buf, rinfo) => {
      try {
        const a = JSON.parse(buf.toString());
        if (a.app !== 'reachat-lan' || a.id === this.me.id || !a.username || !a.port) return;
        const known = this.peers.has(a.id);
        this.peers.set(a.id, { id: a.id, username: a.username, displayName: a.displayName, publicKey: a.publicKey,
          address: rinfo.address, port: a.port, lastSeen: Date.now() });
        if (!known) this.emit('peers', this.list());
      } catch {}
    });
    this.udp.on('error', (e) => this.emit('error', e));
    await new Promise((res) => this.udp.bind(DISCOVERY_PORT, () => { try { this.udp.setBroadcast(true); } catch {} res(); }));

    const announce = () => {
      const pkt = Buffer.from(JSON.stringify({ app: 'reachat-lan', v: 1, ...this.me, port: this.port }));
      for (const addr of broadcastAddrs()) this.udp.send(pkt, DISCOVERY_PORT, addr, () => {});
      // Dọn peer không còn phát
      let changed = false;
      for (const [id, p] of this.peers) if (Date.now() - p.lastSeen > PEER_TTL_MS) { this.peers.delete(id); changed = true; }
      if (changed) this.emit('peers', this.list());
    };
    announce();
    this.timer = setInterval(announce, ANNOUNCE_MS);
    return { port: this.port, id: this.me.id };
  }

  list() { return [...this.peers.values()].map(({ id, username, displayName, publicKey, address }) => ({ id, username, displayName, publicKey, address })); }

  // Gửi 1 gói (đã mã hóa) tới peer. Trả về Promise<boolean>.
  send(peerId, payload) {
    const p = this.peers.get(peerId);
    if (!p) return Promise.resolve(false);
    return new Promise((res) => {
      const sock = net.createConnection({ host: p.address, port: p.port }, () => {
        sock.end(JSON.stringify({ ...payload, from: this.me.username, fromId: this.me.id, fromPk: this.me.publicKey }) + '\n');
      });
      sock.setTimeout(4000, () => { sock.destroy(); res(false); });
      sock.on('close', (hadErr) => res(!hadErr));
      sock.on('error', () => res(false));
    });
  }

  stop() {
    clearInterval(this.timer);
    try { this.udp?.close(); } catch {}
    try { this.server?.close(); } catch {}
    this.peers.clear();
  }
}

module.exports = { LanNode };

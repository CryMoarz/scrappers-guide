// Radio links for the LoRa bridge, with no dependencies. Every link offers the same interface:
//   send(text, {to, port})   to: a node number for a direct message, or undefined to broadcast
//   on('text', ({text, from, port}) => …), on('position', ({from, lat, lon}) => …), on('status', s => …)
//
//   meshtastic-tcp     a Meshtastic radio on Wi-Fi or Ethernet, or meshtasticd on Linux (port 4403)
//   meshtastic-serial  a Meshtastic radio on USB (Linux: /dev/ttyUSB0 or /dev/ttyACM0)
//   uart               a plain LoRa module in transparent mode (E22, E32, RYLR and similar): one line per message
//   udp                LAN broadcast, for testing two nodes without radios
//
// Meshtastic support follows its published stream API (0x94 0xC3, 16-bit length, protobuf
// ToRadio/FromRadio). Test a radio with `node tools/lora.js listen` before relying on it.
const net = require('net');
const fs = require('fs');
const dgram = require('dgram');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');

// ---- the few protobuf pieces Meshtastic needs ----
const PB = {
  varint(n) {
    const out = [];
    n = Number(n);
    while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
    out.push(n);
    return Buffer.from(out);
  },
  key: (no, wt) => PB.varint(no * 8 + wt),
  field(no, wt, v) {
    if (wt === 0) return Buffer.concat([PB.key(no, 0), PB.varint(v)]);
    if (wt === 5) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return Buffer.concat([PB.key(no, 5), b]); }
    const data = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
    return Buffer.concat([PB.key(no, 2), PB.varint(data.length), data]);
  },
  decode(buf) {
    const out = [];
    let i = 0;
    const readVarint = () => { let r = 0, mul = 1, b; do { b = buf[i++]; r += (b & 127) * mul; mul *= 128; } while (b & 128 && i < buf.length); return r; };
    while (i < buf.length) {
      const k = readVarint(), no = Math.floor(k / 8), wt = k % 8;
      if (wt === 0) out.push({ no, wt, v: readVarint() });
      else if (wt === 5) { out.push({ no, wt, v: buf.readUInt32LE(i) }); i += 4; }
      else if (wt === 1) { out.push({ no, wt, v: buf.subarray(i, i + 8) }); i += 8; }
      else if (wt === 2) { const n = readVarint(); out.push({ no, wt, v: buf.subarray(i, i + n) }); i += n; }
      else throw new Error('Unsupported protobuf wire type ' + wt);
    }
    return out;
  },
  get: (fields, no) => { const f = fields.find(x => x.no === no); return f ? f.v : undefined; },
};

const BROADCAST = 0xffffffff;
const PORT = { TEXT: 1, POSITION: 3, PRIVATE: 256 };

// ToRadio { packet: MeshPacket { to, channel, decoded: Data { portnum, payload }, id, want_ack } }
function meshPacket(text, opts) {
  const data = Buffer.concat([PB.field(1, 0, opts.port || PORT.TEXT), PB.field(2, 2, Buffer.from(text, 'utf8'))]);
  const pkt = Buffer.concat([
    PB.field(2, 5, opts.to == null ? BROADCAST : opts.to),
    opts.channel ? PB.field(3, 0, opts.channel) : Buffer.alloc(0),
    PB.field(4, 2, data),
    PB.field(6, 5, (Math.random() * 0xffffffff) >>> 0),
    opts.to != null && opts.to !== BROADCAST ? PB.field(10, 0, 1) : Buffer.alloc(0),
  ]);
  return PB.field(1, 2, pkt);
}
const wantConfig = () => PB.field(3, 0, (Math.random() * 0xffffffff) >>> 0);
const frame = payload => Buffer.concat([Buffer.from([0x94, 0xc3, payload.length >> 8, payload.length & 255]), payload]);

// FromRadio { packet (2): MeshPacket { from (1), to (2), channel (3), decoded (4): Data { portnum (1), payload (2) } } }
function readFromRadio(payload, emit) {
  const fr = PB.decode(payload);
  const pkt = PB.get(fr, 2);
  if (!pkt) return;
  const mp = PB.decode(pkt);
  const decoded = PB.get(mp, 4);
  if (!decoded) return;
  const d = PB.decode(decoded);
  const port = PB.get(d, 1), body = PB.get(d, 2) || Buffer.alloc(0), from = PB.get(mp, 1);
  if (port === PORT.TEXT || port === PORT.PRIVATE) emit('text', { text: body.toString('utf8'), from, port, to: PB.get(mp, 2) });
  if (port === PORT.POSITION) {
    const p = PB.decode(body);
    const lat = PB.get(p, 1), lon = PB.get(p, 2);
    if (lat != null && lon != null) emit('position', { from, lat: (lat | 0) / 1e7, lon: (lon | 0) / 1e7 });
  }
}

// Reads 0x94 0xC3 frames from a byte stream, skipping the device's plain-text debug output.
function frameReader(onFrame) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const s = buf.indexOf(0x94);
      if (s < 0) { buf = Buffer.alloc(0); return; }
      if (s > 0) buf = buf.subarray(s);
      if (buf.length < 4) return;
      if (buf[1] !== 0xc3) { buf = buf.subarray(1); continue; }
      const n = (buf[2] << 8) | buf[3];
      if (n > 512) { buf = buf.subarray(1); continue; }
      if (buf.length < 4 + n) return;
      const payload = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      try { onFrame(payload); } catch (e) { /* not a frame we understand */ }
    }
  };
}

class Link extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.retry = 0; this.closed = false; this.canDirect = false; }
  status(s) { this.state = s; this.emit('status', s); }
  reconnect() {
    if (this.closed) return;
    this.retry = Math.min(this.retry + 1, 8);
    setTimeout(() => this.open(), Math.min(300e3, 2000 * Math.pow(2, this.retry))).unref();
  }
  close() { this.closed = true; }
}

class MeshtasticTcp extends Link {
  open() {
    this.canDirect = true;
    this.status('connecting');
    const s = net.connect(this.opts.port || 4403, this.opts.host || '127.0.0.1');
    s.setKeepAlive(true, 30e3);
    s.on('connect', () => { this.retry = 0; this.sock = s; s.write(frame(wantConfig())); this.status('connected'); });
    s.on('data', frameReader(p => readFromRadio(p, (ev, x) => this.emit(ev, x))));
    s.on('error', e => this.status('error: ' + e.message));
    s.on('close', () => { this.sock = null; this.status('disconnected'); this.reconnect(); });
    return this;
  }
  send(text, o) { if (!this.sock) return false; this.sock.write(frame(meshPacket(text, Object.assign({ channel: this.opts.channel }, o || {})))); return true; }
  close() { super.close(); if (this.sock) this.sock.destroy(); }
}

function openSerial(dev, baud) {
  execFileSync('stty', ['-F', dev, String(baud || 115200), 'raw', '-echo', '-hupcl'], { stdio: 'ignore' });
  const rd = fs.createReadStream(dev, { highWaterMark: 256 });
  const fd = fs.openSync(dev, 'w');
  return { rd, write: b => fs.writeSync(fd, b), close: () => { rd.destroy(); try { fs.closeSync(fd); } catch (e) { /* already closed */ } } };
}

class MeshtasticSerial extends Link {
  open() {
    this.canDirect = true;
    this.status('connecting');
    try {
      this.port = openSerial(this.opts.device || '/dev/ttyUSB0', this.opts.baud || 115200);
      this.port.write(Buffer.alloc(32, 0xc3)); // wake the radio's protobuf API
      this.port.write(frame(wantConfig()));
      this.port.rd.on('data', frameReader(p => readFromRadio(p, (ev, x) => this.emit(ev, x))));
      this.port.rd.on('error', e => { this.status('error: ' + e.message); this.port.close(); this.port = null; this.reconnect(); });
      this.retry = 0;
      this.status('connected');
    } catch (e) { this.status('error: ' + e.message); this.reconnect(); }
    return this;
  }
  send(text, o) { if (!this.port) return false; this.port.write(frame(meshPacket(text, Object.assign({ channel: this.opts.channel }, o || {})))); return true; }
  close() { super.close(); if (this.port) this.port.close(); }
}

// Transparent modules just move bytes, so messages are lines and there are no addresses or ports.
class Uart extends Link {
  open() {
    this.status('connecting');
    try {
      this.port = openSerial(this.opts.device || '/dev/ttyUSB0', this.opts.baud || 9600);
      let buf = '';
      this.port.rd.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (line) this.emit('text', { text: line, from: undefined, port: line.startsWith('SDG1|') ? PORT.PRIVATE : PORT.TEXT });
        }
        if (buf.length > 4096) buf = '';
      });
      this.port.rd.on('error', e => { this.status('error: ' + e.message); this.reconnect(); });
      this.status('connected');
    } catch (e) { this.status('error: ' + e.message); this.reconnect(); }
    return this;
  }
  send(text) { if (!this.port) return false; this.port.write(Buffer.from(text.replace(/\n/g, ' ') + '\n', 'utf8')); return true; }
  close() { super.close(); if (this.port) this.port.close(); }
}

// Stand-in for a mesh through a multicast group: by default only processes on this machine hear
// it (udpInterface 127.0.0.1); set udpInterface to a LAN address, or 0.0.0.0 for every
// interface, to reach other machines.
const GROUP = '239.255.70.78';
class Udp extends Link {
  open() {
    const port = this.opts.udpPort || 47878;
    this.group = this.opts.address || GROUP;
    const iface = this.opts.udpInterface || '127.0.0.1', any = iface === '0.0.0.0';
    this.id = this.opts.nodeNum || ((Math.random() * 0xffffffff) >>> 0);
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', e => this.status('error: ' + e.message));
    this.sock.on('message', m => {
      try {
        const o = JSON.parse(m.toString('utf8'));
        if (o.from === this.id || (o.to != null && o.to !== BROADCAST && o.to !== this.id)) return;
        if (o.lat != null) this.emit('position', { from: o.from, lat: o.lat, lon: o.lon });
        else this.emit('text', { text: o.text, from: o.from, port: o.port, to: o.to });
      } catch (e) { /* not ours */ }
    });
    // Bound to the group itself (not every address), so nothing sent straight to this port gets in.
    this.sock.bind({ port, address: any ? undefined : process.platform === 'win32' ? iface : this.group }, () => {
      try {
        this.sock.addMembership(this.group, any ? undefined : iface);
        if (!any) this.sock.setMulticastInterface(iface);
        this.sock.setMulticastLoopback(true); this.sock.setMulticastTTL(1); this.ready = true; this.status('connected');
      } catch (e) { this.status('error: ' + e.message); }
    });
    this.canDirect = true;
    return this;
  }
  send(text, o) {
    if (!this.ready) return false;
    o = o || {};
    const msg = Buffer.from(JSON.stringify({ from: this.id, to: o.to == null ? BROADCAST : o.to, port: o.port || PORT.TEXT, text }));
    this.sock.send(msg, this.opts.udpPort || 47878, this.group, e => { if (e) this.status('error: ' + e.message); });
    return true;
  }
  sendPosition(lat, lon) { if (this.ready) this.sock.send(Buffer.from(JSON.stringify({ from: this.id, lat, lon })), this.opts.udpPort || 47878, this.group); }
  close() { super.close(); if (this.sock) this.sock.close(); }
}

// In-process pair for tests: what one sends, the other hears.
function memoryPair() {
  const a = new Link({}), b = new Link({});
  [a, b].forEach((l, i) => { l.num = i + 1; l.canDirect = true; l.open = () => l; l.sent = []; });
  a.send = (text, o) => { a.sent.push({ text, o }); setImmediate(() => b.emit('text', { text, from: a.num, port: (o && o.port) || PORT.TEXT, to: o && o.to })); return true; };
  b.send = (text, o) => { b.sent.push({ text, o }); setImmediate(() => a.emit('text', { text, from: b.num, port: (o && o.port) || PORT.TEXT, to: o && o.to })); return true; };
  return [a, b];
}

function createLink(opts) {
  const kinds = { 'meshtastic-tcp': MeshtasticTcp, 'meshtastic-serial': MeshtasticSerial, uart: Uart, udp: Udp };
  const K = kinds[opts.link];
  if (!K) throw new Error(`Unknown LoRa link “${opts.link}”. Use one of: ${Object.keys(kinds).join(', ')}`);
  return new K(opts).open();
}

module.exports = { createLink, memoryPair, PB, PORT, BROADCAST, meshPacket, frame, frameReader, readFromRadio };

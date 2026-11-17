// Reads tiles from a PMTiles v3 archive (github.com/protomaps/PMTiles): a local file, or a URL that
// answers range requests, such as the maps Project NOMAD serves. Only the header, the directories
// on the way to a tile and the tile itself are read, so a 16 GB map costs a few kilobytes a tile.
const fs = require('fs');
const zlib = require('zlib');

// A map names its own offsets and lengths, and a map can come from anyone: no read, and no
// directory or tile once unpacked, may be over MAX_BYTES. The biggest in the 15.8 GB Canada map
// is a 223 KB tile, 337 KB unpacked; its biggest directory is 23 KB, 68 KB unpacked.
const MAX_BYTES = 4 << 20;
// Read directories are kept up to this many entries in all. The Canada map's hold 9,171 at
// most, so it keeps 256 of them; a map of huge directories keeps a few.
const MAX_CACHED = 2500000;

// A varint is at most 10 bytes and must end inside the buffer.
function varint(b, i) {
  let r = 0, s = 1;
  for (let n = 0; n < 10 && i < b.length; n++) {
    const c = b[i++];
    r += (c & 0x7f) * s;
    if (c < 0x80) return [r, i];
    s *= 128;
  }
  throw new Error('Broken map directory: a number runs past its end');
}

// Tiles are numbered along a Hilbert curve, zoom level after zoom level.
function tileId(z, x, y) {
  let acc = 0;
  for (let a = 0; a < z; a++) acc += 4 ** a;
  let d = 0;
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = x & s ? 1 : 0, ry = y & s ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } [x, y] = [y, x]; }
  }
  return acc + d;
}

function directory(buf) {
  let [n, i] = varint(buf, 0);
  // Every entry takes at least four bytes, so a bigger count is a lie.
  if (n * 4 > buf.length - i) throw new Error('Broken map directory: it claims more entries than it holds');
  const ids = [], runs = [], lens = [], offs = [];
  let last = 0, v;
  for (let k = 0; k < n; k++) { [v, i] = varint(buf, i); last += v; ids.push(last); }
  for (let k = 0; k < n; k++) { [v, i] = varint(buf, i); runs.push(v); }
  for (let k = 0; k < n; k++) { [v, i] = varint(buf, i); lens.push(v); }
  for (let k = 0; k < n; k++) { [v, i] = varint(buf, i); offs.push(v === 0 && k > 0 ? offs[k - 1] + lens[k - 1] : v - 1); }
  return { ids, runs, lens, offs };
}

// Unpacking stops at MAX_BYTES, so a few bytes can't unpack to gigabytes.
function decompress(buf, kind) {
  if (kind === 0 || kind === 1) return buf;
  try {
    if (kind === 2) return zlib.gunzipSync(buf, { maxOutputLength: MAX_BYTES });
    if (kind === 3) return zlib.brotliDecompressSync(buf, { maxOutputLength: MAX_BYTES });
  } catch (e) {
    throw e.code === 'ERR_BUFFER_TOO_LARGE' ? new Error(`Broken map: a tile or directory unpacks to more than ${MAX_BYTES >> 20} MB`) : e;
  }
  throw new Error('This map uses a compression Node can’t read (zstd)');
}

// A response's body, but never more than max bytes, whatever the server sends.
async function readBody(res, max) {
  const parts = [];
  let got = 0;
  if (res.body) for await (const chunk of res.body) { parts.push(chunk); got += chunk.length; if (got >= max) break; }
  return Buffer.concat(parts, Math.min(got, max));
}

function reader(where) {
  const check = (off, len) => {
    if (!(Number.isSafeInteger(off) && off >= 0 && Number.isSafeInteger(len) && len >= 0 && len <= MAX_BYTES)) throw new Error(`Broken map: ${where} asks for ${len} bytes at ${off}`);
  };
  if (/^https?:\/\//i.test(where)) {
    return async (off, len) => {
      check(off, len);
      const res = await fetch(where, { headers: { Range: `bytes=${off}-${off + len - 1}` }, signal: AbortSignal.timeout(30e3) });
      if (res.status !== 206) { res.body && res.body.cancel().catch(() => {}); throw new Error(`${where} answered ${res.status} to a range request`); }
      return readBody(res, len);
    };
  }
  let fd = null;
  const read = async (off, len) => {
    check(off, len);
    if (fd == null) fd = fs.openSync(where, 'r');
    const b = Buffer.alloc(len);
    const n = await new Promise((ok, fail) => fs.read(fd, b, 0, len, off, (e, got) => (e ? fail(e) : ok(got))));
    return b.subarray(0, n);
  };
  read.close = () => { if (fd != null) fs.closeSync(fd); fd = null; };
  return read;
}

async function openArchive(where) {
  const read = reader(where);
  const h = await read(0, 127);
  if (h.length < 127 || h.toString('latin1', 0, 7) !== 'PMTiles' || h[7] !== 3) throw new Error(`${where} is not a PMTiles v3 map`);
  const u64 = o => Number(h.readBigUInt64LE(o));
  const e7 = o => h.readInt32LE(o) / 1e7;
  const H = {
    rootOff: u64(8), rootLen: u64(16), leafOff: u64(40), dataOff: u64(56),
    internal: h[97], tileComp: h[98], type: h[99], minzoom: h[100], maxzoom: h[101],
    bounds: [e7(102), e7(106), e7(110), e7(114)], center: [e7(119), e7(123), h[118]],
  };
  if (H.type !== 1) throw new Error(`${where} holds image tiles, not vector tiles`);
  // Directories are cached, and so is a fetch in flight, so a screen of tiles reads each once:
  // up to 256 of them, oldest out first, and no more than MAX_CACHED entries in all.
  const dirs = new Map(), sizes = new Map();
  let held = 0;
  const forget = k => { held -= sizes.get(k) || 0; sizes.delete(k); dirs.delete(k); };
  const trim = () => { while (dirs.size > 1 && (dirs.size > 256 || held > MAX_CACHED)) forget(dirs.keys().next().value); };
  const dir = (off, len) => {
    const k = off + ':' + len;
    if (!dirs.has(k)) {
      const p = read(off, len).then(b => {
        const d = directory(decompress(b, H.internal));
        if (dirs.get(k) === p) { sizes.set(k, d.ids.length); held += d.ids.length; trim(); }
        return d;
      }).catch(e => { if (dirs.get(k) === p) forget(k); throw e; });
      dirs.set(k, p);
      trim();
    }
    return dirs.get(k);
  };
  async function tile(z, x, y) {
    if (z < H.minzoom || z > H.maxzoom || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
    const id = tileId(z, x, y);
    let off = H.rootOff, len = H.rootLen;
    for (let depth = 0; depth < 4; depth++) {
      const d = await dir(off, len);
      let lo = 0, hi = d.ids.length - 1, at = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (d.ids[m] <= id) { at = m; lo = m + 1; } else hi = m - 1; }
      if (at < 0) return null;
      if (d.runs[at] === 0) { off = H.leafOff + d.offs[at]; len = d.lens[at]; continue; }
      if (id >= d.ids[at] + d.runs[at]) return null;
      return decompress(await read(H.dataOff + d.offs[at], d.lens[at]), H.tileComp);
    }
    return null;
  }
  const covers = (lon, lat) => lon >= H.bounds[0] && lon <= H.bounds[2] && lat >= H.bounds[1] && lat <= H.bounds[3];
  return { where, minzoom: H.minzoom, maxzoom: H.maxzoom, bounds: H.bounds, center: H.center, tile, covers, close: () => read.close && read.close() };
}

// Slippy-map tile maths.
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(Math.sinh(n)); };

module.exports = { openArchive, tileId, directory, readBody, MAX_BYTES, lon2x, lat2y, x2lon, y2lat };

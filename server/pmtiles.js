// Reads tiles from a PMTiles v3 archive (github.com/protomaps/PMTiles): a local file, or a URL that
// answers range requests, such as the maps Project NOMAD serves. Only the header, the directories
// on the way to a tile and the tile itself are read, so a 16 GB map costs a few kilobytes a tile.
const fs = require('fs');
const zlib = require('zlib');

function varint(b, i) {
  let r = 0, s = 1, c;
  do { c = b[i++]; r += (c & 0x7f) * s; s *= 128; } while (c >= 0x80);
  return [r, i];
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
  const ids = [], runs = [], lens = [], offs = [];
  let last = 0, v;
  for (let k = 0; k < n; k++) { [v, i] = varint(buf, i); last += v; ids.push(last); }
  for (let k = 0; k < n; k++) { [v, i] = varint(buf, i); runs.push(v); }
  for (let k = 0; k < n; k++) { [v, i] = varint(buf, i); lens.push(v); }
  for (let k = 0; k < n; k++) { [v, i] = varint(buf, i); offs.push(v === 0 && k > 0 ? offs[k - 1] + lens[k - 1] : v - 1); }
  return { ids, runs, lens, offs };
}

function decompress(buf, kind) {
  if (kind === 0 || kind === 1) return buf;
  if (kind === 2) return zlib.gunzipSync(buf);
  if (kind === 3) return zlib.brotliDecompressSync(buf);
  throw new Error('This map uses a compression Node can’t read (zstd)');
}

function reader(where) {
  if (/^https?:\/\//i.test(where)) {
    return async (off, len) => {
      const res = await fetch(where, { headers: { Range: `bytes=${off}-${off + len - 1}` }, signal: AbortSignal.timeout(30e3) });
      if (res.status !== 206) { res.body && res.body.cancel().catch(() => {}); throw new Error(`${where} answered ${res.status} to a range request`); }
      return Buffer.from(await res.arrayBuffer());
    };
  }
  let fd = null;
  const read = async (off, len) => {
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
  // Directories are cached, and so is a fetch in flight, so a screen of tiles reads each once.
  const dirs = new Map();
  const dir = (off, len) => {
    const k = off + ':' + len;
    if (!dirs.has(k)) {
      if (dirs.size > 256) dirs.delete(dirs.keys().next().value);
      dirs.set(k, read(off, len).then(b => directory(decompress(b, H.internal))).catch(e => { dirs.delete(k); throw e; }));
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

module.exports = { openArchive, tileId, directory, lon2x, lat2y, x2lon, y2lat };

// The map: reading a PMTiles archive, decoding vector tiles, ranking the places on them for a
// search, and the hub's map endpoints. The archive is built here: one tile, a few features.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const SDG = require('../core');
const F = require('../lib/fsdata');
const P = require('../server/pmtiles');
const M = require('../server/mvt');
const { createMap, plan, MAX_TILES, SEARCHES, WAITING } = require('../server/map');
const config = require('../server/config');
const { createHub } = require('../server/hub');

// A minimal vector-tile and PMTiles writer, enough for tests.
const vint = n => { const o = []; while (n >= 128) { o.push((n % 128) + 128); n = Math.floor(n / 128); } o.push(n); return o; };
const key = (f, wt) => vint(f * 8 + wt);
const bytes = (f, b) => [...key(f, 2), ...vint(b.length), ...b];
const str = (f, s) => bytes(f, [...Buffer.from(s)]);
const packed = (f, a) => bytes(f, a.flatMap(vint));
const zz = n => (n << 1) ^ (n >> 31);
const cmd = (id, n) => (id & 7) | (n << 3);
const point = (x, y) => [cmd(1, 1), zz(x), zz(y)];
function ring(pts, close) {
  const g = [cmd(1, 1), zz(pts[0][0]), zz(pts[0][1]), cmd(2, pts.length - 1)];
  for (let i = 1; i < pts.length; i++) g.push(zz(pts[i][0] - pts[i - 1][0]), zz(pts[i][1] - pts[i - 1][1]));
  return close ? [...g, cmd(7, 1)] : g;
}
function layer(name, feats) {
  const keys = [], vals = [];
  const idx = (list, v) => { let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
  const fbytes = feats.map(f => {
    const tags = Object.entries(f.props).flatMap(([k, v]) => [idx(keys, k), idx(vals, v)]);
    return bytes(2, [...key(1, 0), ...vint(f.id || 0), ...packed(2, tags), ...key(3, 0), ...vint(f.type), ...packed(4, f.geom)]);
  });
  return bytes(3, [...key(15, 0), ...vint(2), ...str(1, name), ...fbytes.flat(), ...keys.flatMap(k => str(3, k)), ...vals.flatMap(v => bytes(4, str(1, v))), ...key(5, 0), ...vint(4096)]);
}
function archive(file, z, x, y, tile) {
  const data = zlib.gzipSync(Buffer.from(tile));
  const dir = Buffer.from([...vint(1), ...vint(P.tileId(z, x, y)), ...vint(1), ...vint(data.length), ...vint(1)]);
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'latin1'); h[7] = 3;
  const u64 = (o, v) => h.writeBigUInt64LE(BigInt(v), o);
  u64(8, 127); u64(16, dir.length); u64(24, 127 + dir.length); u64(32, 0); u64(40, 0); u64(48, 0);
  u64(56, 127 + dir.length); u64(64, data.length); u64(72, 1); u64(80, 1); u64(88, 1);
  h[96] = 1; h[97] = 1; h[98] = 2; h[99] = 1; h[100] = z; h[101] = z;
  const e7 = (o, v) => h.writeInt32LE(Math.round(v * 1e7), o);
  e7(102, P.x2lon(x, z)); e7(106, P.y2lat(y + 1, z)); e7(110, P.x2lon(x + 1, z)); e7(114, P.y2lat(y, z));
  h[118] = z; e7(119, P.x2lon(x + 0.5, z)); e7(123, P.y2lat(y + 0.5, z));
  fs.writeFileSync(file, Buffer.concat([h, dir, data]));
}

const Z = 15, X = Math.floor(P.lon2x(-75.5, Z)), Y = Math.floor(P.lat2y(45.3, Z));
const ll = (px, py) => ({ lat: P.y2lat(Y + py / 4096, Z), lon: P.x2lon(X + px / 4096, Z) });
function sample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-map-'));
  const file = path.join(dir, 'test.pmtiles');
  archive(file, Z, X, Y, [
    ...layer('pois', [
      { id: 11, type: 1, props: { kind: 'hardware', name: 'Corner Hardware' }, geom: point(1000, 1000) },
      { id: 12, type: 1, props: { kind: 'street_lamp' }, geom: point(2000, 2000) },
      { id: 13, type: 1, props: { kind: 'bench' }, geom: point(2100, 2000) },
    ]),
    ...layer('landuse', [{ id: 21, type: 3, props: { kind: 'industrial' }, geom: ring([[3000, 3000], [3600, 3000], [3600, 3600], [3000, 3600], [3000, 3000]], true) }]),
    ...layer('roads', [{ id: 31, type: 2, props: { kind: 'major_road' }, geom: ring([[0, 2048], [4096, 2048]]) }]),
    ...layer('water', [{ id: 41, type: 3, props: { kind: 'water' }, geom: ring([[100, 3000], [600, 3000], [600, 3500], [100, 3000]], true) }]),
  ]);
  return { dir, file };
}

test('PMTiles: header, directory and a gzipped tile, read in pieces', async () => {
  const { file } = sample();
  const a = await P.openArchive(file);
  assert.deepEqual([a.minzoom, a.maxzoom], [Z, Z]);
  assert.ok(a.covers(-75.5, 45.3));
  assert.equal(await a.tile(Z, X + 1, Y), null, 'a tile that isn’t there');
  const L = M.decode(await a.tile(Z, X, Y));
  assert.deepEqual(Object.keys(L).sort(), ['landuse', 'pois', 'roads', 'water']);
  const hw = L.pois.features.find(f => f.props.kind === 'hardware');
  assert.deepEqual([hw.id, hw.type, hw.props.name, hw.geom[0]], [11, 'point', 'Corner Hardware', [1000, 1000]]);
  assert.deepEqual(L.landuse.features[0].geom[0].slice(0, 4), [3000, 3000, 3600, 3000]);
  assert.deepEqual(Object.keys(M.decode(await a.tile(Z, X, Y), ['roads'])), ['roads'], 'only the layers asked for');
  assert.equal(P.tileId(0, 0, 0), 0);
  assert.equal(P.tileId(1, 0, 0), 1);
  assert.equal(P.tileId(1, 1, 0), 4, 'the Hilbert curve');
});

test('map: places matched to building types by OSM kind and ranked for a search', async () => {
  const { file } = sample();
  const ctx = SDG.db.open(F.plain(F.load()));
  const map = createMap({ cfg: { map: { pmtiles: [file] } } });
  const at = ll(2048, 2048);
  const all = await map.places(ctx, { lat: at.lat, lon: at.lon, km: 2 });
  const kinds = all.places.map(p => p.kind).sort();
  assert.deepEqual(kinds, ['hardware', 'industrial', 'street_lamp'], 'a bench is no building type');
  const hw = all.places.find(p => p.kind === 'hardware');
  assert.equal(hw.type.id, 'hardware');
  assert.ok(Math.abs(hw.lat - ll(1000, 1000).lat) < 1e-5, 'points keep their place');
  assert.ok(hw.dist > 0 && /^[NESW]{1,2}$/.test(hw.dir));
  const lamp = await map.places(ctx, { lat: at.lat, lon: at.lon, km: 2, query: 'led driver' });
  assert.ok(lamp.places.length && lamp.places.every(p => p.score <= 100 && p.mostlyFrom), 'a search ranks by its building types and says why');
  const none = await map.places(ctx, { lat: at.lat, lon: at.lon, km: 2, query: 'xyzzy' });
  assert.equal(none.places.length, 3, 'a search the guide can’t place shows everything near');
  assert.ok(none.note);
  const far = await map.places(ctx, { lat: 10, lon: 10, km: 1 });
  assert.equal(far.places.length, 0);
  assert.ok(far.note);
  const t = JSON.parse(await map.renderTile(Z, X, Y));
  assert.equal(t.major.length, 1);
  assert.deepEqual(t.major[0], [0, 256, 512, 256], 'drawn at 512 units a side');
  assert.equal(t.water.length, 1);
  assert.equal(t.urban.length, 1);
  assert.equal(await map.renderTile(Z, X + 5, Y), null);
});

test('hub: map info, tiles and places', async (t) => {
  const { dir, file } = sample();
  fs.cpSync(F.DATA, path.join(dir, 'data'), { recursive: true });
  const cfg = config.load([], {}, { port: 0, dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state'), map: { pmtiles: [file] } });
  const hub = await createHub(cfg);
  const addr = await hub.listen();
  t.after(() => hub.close());
  const url = `http://127.0.0.1:${addr.port}`;
  const get = async p => { const r = await fetch(url + p); return { status: r.status, body: await r.json() }; };
  const info = (await get('/api/v1/map')).body;
  assert.equal(info.available, true);
  assert.equal(info.sources[0].maxzoom, Z);
  assert.equal((await get(`/api/v1/map/tiles/${Z}/${X}/${Y}`)).body.major.length, 1);
  assert.equal((await get(`/api/v1/map/tiles/${Z}/${X + 3}/${Y}`)).status, 404);
  assert.equal((await get('/api/v1/map/tiles/99/0/0')).status, 400);
  const at = ll(2048, 2048);
  const r = (await get(`/api/v1/places?lat=${at.lat}&lon=${at.lon}&km=1`)).body;
  assert.ok(r.places.length);
  assert.equal((await get('/api/v1/places?lat=x')).status, 400);
  const list = (await get(`/api/v1/places?lat=${at.lat}&lon=${at.lon}&km=1&parts=battery_pb,no_such_part`)).body;
  assert.ok(Array.isArray(list.parts.battery_pb), 'a shopping list gets places per part type');
  assert.equal(list.parts.no_such_part, undefined);
});

// A whole-world map at zoom 0 holding one tile, stored as given (no compression unless asked),
// with header fields a hostile map could lie with.
function world(tile, o = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-map-')), 'world.pmtiles');
  const data = Buffer.from(tile);
  const dir = Buffer.from(o.dir || [...vint(1), ...vint(0), ...vint(1), ...vint(data.length), ...vint(1)]);
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'latin1'); h[7] = 3;
  const u64 = (off, v) => h.writeBigUInt64LE(BigInt(v), off);
  u64(8, 127); u64(16, o.rootLen != null ? o.rootLen : dir.length); u64(56, 127 + dir.length); u64(64, data.length);
  h[97] = o.internal || 1; h[98] = o.tileComp || 1; h[99] = 1; h[100] = 0; h[101] = 0;
  const e7 = (off, v) => h.writeInt32LE(Math.round(v * 1e7), off);
  e7(102, -180); e7(106, -85); e7(110, 180); e7(114, 85);
  fs.writeFileSync(file, Buffer.concat([h, dir, data]));
  return file;
}
const tileOf = (name, feats) => Buffer.from(bytes(3, [...str(1, name), ...feats, ...key(5, 0), ...vint(4096)]));
const feature = geom => bytes(2, [...key(3, 0), ...vint(2), ...packed(4, geom)]);
// Each of these once hung the hub or filled its memory, from a map of a few hundred bytes.
const HOSTILE = {
  'a layer that says it is 2^50 bytes long': [...key(3, 2), ...vint(2 ** 50)],
  'a shape of 2^28 points in 5 bytes': tileOf('water', bytes(2, [...key(3, 0), ...vint(1), ...packed(4, [cmd(1, 0x0fffffff)])])),
  'a packed field that says it is 2^40 bytes long': tileOf('water', bytes(2, [...key(3, 0), ...vint(1), ...key(4, 2), ...vint(2 ** 40)])),
  'a number of 11 bytes': [...key(3, 0), ...Array(10).fill(0x80), 1],
  'a number cut off at the end': [...key(3, 0), 0x80],
  'a double past the end': [...key(3, 1), 1, 2, 3],
  'a line that starts without a move': tileOf('roads', feature([cmd(2, 1), zz(5), zz(5)])),
};

test('vector tiles: a broken or hostile tile is refused at once, and the parser stays usable', { timeout: 30000 }, () => {
  const good = Buffer.from(layer('water', [{ id: 1, type: 3, props: { kind: 'water' }, geom: ring([[0, 0], [10, 0], [10, 10], [0, 0]], true) }]));
  for (const [what, tile] of Object.entries(HOSTILE)) {
    const t0 = Date.now();
    assert.throws(() => M.decode(Buffer.from(tile)), /Broken map tile/, what);
    assert.ok(Date.now() - t0 < 1000, what + ' is refused quickly');
    assert.equal(M.decode(good).water.features.length, 1, 'still decodes a good tile after ' + what);
  }
  // Too many features, or too many numbers in the layers asked for (a layer not asked for is skipped).
  const many = Buffer.from(bytes(3, [...str(1, 'pois'), ...Array(M.MAX_FEATURES + 1).fill([...key(2, 2), 0]).flat()]));
  assert.throws(() => M.decode(many), /more than 200000 features/);
  const long = tileOf('water', bytes(2, [...key(4, 2), ...vint(M.MAX_NUMBERS + 1), ...Buffer.alloc(M.MAX_NUMBERS + 1)]));
  assert.throws(() => M.decode(long), /more than 2000000 numbers/);
  assert.deepEqual(M.decode(long, ['roads']), {}, 'a layer not asked for is never read');
  // A name or key with the wrong wire type was read as the whole tile, once per field: a 1 MB
  // tile of them took hours or all the memory. Now they're skipped.
  const confused = Buffer.from(bytes(3, [...str(1, 'pois'), ...Array(250000).fill([...key(1, 0), 0, ...key(3, 0), 0]).flat()]));
  const t0 = Date.now();
  assert.deepEqual(M.decode(confused), { pois: { extent: 4096, features: [] } });
  assert.ok(Date.now() - t0 < 2000, 'fields of the wrong type are skipped quickly');
});

test('PMTiles: hostile directories, lengths and compression bombs are refused at once', { timeout: 30000 }, async () => {
  const t0 = Date.now();
  assert.throws(() => P.directory(Buffer.from(vint(2 ** 40))), /claims more entries than it holds/, '2^40 entries in 6 bytes');
  assert.throws(() => P.directory(Buffer.from([...vint(2), 1, 1, 1, 1, 1, 1, 1, 0x80])), /runs past its end/);
  assert.deepEqual(P.directory(Buffer.from([...vint(1), ...vint(0), ...vint(1), ...vint(9), ...vint(1)])), { ids: [0], runs: [1], lens: [9], offs: [0] });
  const big = Buffer.alloc(P.MAX_BYTES + 1);
  const maps = {
    'a gzip bomb tile': [world(zlib.gzipSync(big), { tileComp: 2 }), /unpacks to more than 4 MB/],
    'a brotli bomb directory': [world([0], { dir: zlib.brotliCompressSync(big), internal: 3 }), /unpacks to more than 4 MB/],
    'a directory of 2^40 entries': [world([0], { dir: vint(2 ** 40) }), /claims more entries/],
    'a root directory 1 TB long': [world([0], { rootLen: 2 ** 40 }), /asks for 1099511627776 bytes/],
  };
  for (const [what, [file, err]] of Object.entries(maps)) {
    const a = await P.openArchive(file);
    await assert.rejects(a.tile(0, 0, 0), err, what);
    await assert.rejects(a.tile(0, 0, 0), err, what + ', again');
    a.close();
  }
  assert.ok(Date.now() - t0 < 5000, 'all refused quickly');
});

test('PMTiles over HTTP: a server sending more than was asked for is cut off', { timeout: 20000 }, async (t) => {
  const real = fs.readFileSync(sample().file);
  let sent = 0;
  const srv = http.createServer((req, res) => {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(req.headers.range).map(Number);
    res.writeHead(206);
    res.write(real.subarray(from, to + 1));
    // Then junk, without end, until the reader hangs up.
    const junk = Buffer.alloc(64 * 1024, 7);
    const more = () => { while (!res.destroyed && res.write(junk)) sent += junk.length; };
    res.on('drain', more);
    more();
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const a = await P.openArchive(`http://127.0.0.1:${srv.address().port}/map.pmtiles`);
  assert.equal(a.maxzoom, Z);
  const L = M.decode(await a.tile(Z, X, Y));
  assert.equal(L.pois.features.length, 3, 'the tile, without the junk after it');
  assert.ok(sent < 64 << 20, 'the reader stopped reading');
});

test('PMTiles: directories are kept up to a number of entries, so huge ones can’t fill the memory', { timeout: 30000 }, async (t) => {
  // Three tiles far apart, each the first in a leaf directory of a million entries (4 MB
  // unpacked, 4 KB gzipped). Kept whole, the three would be over the budget of 2.5 million.
  const N = 1e6;
  const tiles = [[12, 0, 0], [12, 2000, 2000], [12, 4000, 100]].map(([z, x, y]) => ({ z, x, y, id: P.tileId(z, x, y) })).sort((p, q) => p.id - q.id);
  assert.ok(tiles[1].id - tiles[0].id > N && tiles[2].id - tiles[1].id > N);
  const leaves = tiles.map(({ id }) => zlib.gzipSync(Buffer.concat([Buffer.from([...vint(N), ...vint(id)]), Buffer.alloc(N - 1, 1), Buffer.alloc(2 * N, 1), Buffer.from([1]), Buffer.alloc(N - 1, 0)])));
  const root = zlib.gzipSync(Buffer.from([...vint(3), ...vint(tiles[0].id), ...vint(tiles[1].id - tiles[0].id), ...vint(tiles[2].id - tiles[1].id), 0, 0, 0, ...leaves.flatMap(l => vint(l.length)), 1, 0, 0]));
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'latin1'); h[7] = 3;
  const u64 = (o, v) => h.writeBigUInt64LE(BigInt(v), o);
  const leafOff = 127 + root.length, dataOff = leafOff + leaves.reduce((n, l) => n + l.length, 0);
  u64(8, 127); u64(16, root.length); u64(40, leafOff); u64(56, dataOff);
  h[97] = 2; h[98] = 1; h[99] = 1; h[100] = 0; h[101] = 15;
  const file = Buffer.concat([h, root, ...leaves, Buffer.from([1, 2, 3])]);
  const asked = [];
  const srv = http.createServer((req, res) => {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(req.headers.range).map(Number);
    asked.push(from);
    res.writeHead(206); res.end(file.subarray(from, to + 1));
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const a = await P.openArchive(`http://127.0.0.1:${srv.address().port}/map.pmtiles`);
  for (const { z, x, y } of [...tiles, tiles[0]]) assert.deepEqual([...await a.tile(z, x, y)], [1]);
  assert.equal(asked.filter(o => o === leafOff).length, 2, 'the first leaf made way for the third, and was read again');
  assert.equal(asked.filter(o => o === leafOff + leaves[0].length).length, 1, 'the second stayed');
});

test('map: a search reads at most MAX_TILES tiles, the same ones as before in the south', () => {
  const full = { minzoom: 0, maxzoom: 15 };
  const count = rings => rings.reduce((n, r) => n + r.tiles.length, 0);
  const ottawa = plan(full, 45.42, -75.69, 50);
  assert.deepEqual(ottawa.map(r => [r.z, r.inner, r.outer]), [[15, 0, 3], [14, 3, 10], [13, 10, 25], [12, 25, 50]]);
  assert.equal(count(ottawa), 650, 'Ottawa reads every ring at full detail');
  assert.equal(count(plan(full, 45.42, -75.69, 2)), 30);
  // Tiles shrink towards the poles: 50 km at 83.1° once read 18,917 tiles.
  for (const lat of [60, 70, 83.1, 85, -85]) {
    const rings = plan(full, lat, -75, 50);
    assert.ok(count(rings) <= MAX_TILES, `${count(rings)} tiles at ${lat}°`);
    assert.ok(rings.every((r, i) => r.z <= [15, 14, 13, 12][i]), 'only ever lower');
  }
  assert.deepEqual(plan(full, 70, -100, 50).map(r => r.z), [15, 13, 12, 11], 'every shop close in, less detail further out');
  // A map with no lower zoom to fall back on is cut off at MAX_TILES, nearest ring first.
  const flat = plan({ minzoom: 15, maxzoom: 15 }, 83.1, -75, 50);
  assert.equal(count(flat), MAX_TILES);
  assert.equal(flat[0].tiles.length, MAX_TILES);
});

test('map: place searches take turns across the hub, and a failed one frees its turn', { timeout: 30000 }, async () => {
  const { file } = sample();
  const ctx = SDG.db.open(F.plain(F.load()));
  const map = createMap({ cfg: { map: { pmtiles: [file] } } });
  const [a] = await map.sources();
  // Every place counts as covered and each tile read takes a moment, so searches overlap.
  a.covers = () => true;
  const tile = a.tile;
  let inFlight = 0, most = 0, reads = 0, fail = false;
  a.tile = async (...zxy) => {
    inFlight++; reads++; most = Math.max(most, inFlight);
    try { await new Promise(ok => setTimeout(ok, 5)); if (fail) throw new Error('unreadable tile'); return await tile(...zxy); } finally { inFlight--; }
  };
  const at = i => ({ lat: -60 + i * 3, lon: -170 + i * 10, km: 1 });
  const all = await Promise.allSettled(Array.from({ length: SEARCHES + WAITING + 5 }, (_, i) => map.places(ctx, at(i))));
  const busy = all.filter(r => r.status === 'rejected');
  assert.equal(busy.length, 5, 'past the line, the map is busy');
  assert.ok(busy.every(r => r.reason.status === 503 && /busy/.test(r.reason.message)));
  assert.ok(all.slice(0, SEARCHES + WAITING).every(r => r.status === 'fulfilled'));
  assert.ok(most <= SEARCHES * 8, `${most} tiles read at once`);
  // A search whose tiles can't be read fails once the reads under way are done, and starts no more.
  fail = true;
  for (let i = 0; i < SEARCHES + 1; i++) {
    reads = 0;
    await assert.rejects(map.places(ctx, Object.assign(at(30 + i), { km: 3 })), /unreadable tile/);
    assert.ok(reads <= 8, `${reads} tiles tried`);
    assert.equal(inFlight, 0);
  }
  fail = false;
  const after = await Promise.all(Array.from({ length: SEARCHES + 1 }, (_, i) => map.places(ctx, at(40 + i))));
  assert.equal(after.length, SEARCHES + 1, 'failed searches gave their turns back');
});

test('hub: a hostile map answers an error for its tiles and places, and the hub stays up', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-map-'));
  fs.cpSync(F.DATA, path.join(dir, 'data'), { recursive: true });
  const file = world(HOSTILE['a layer that says it is 2^50 bytes long']);
  const cfg = config.load([], {}, { port: 0, dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state'), map: { pmtiles: [file] } });
  const hub = await createHub(cfg);
  const addr = await hub.listen();
  t.after(() => hub.close());
  t.mock.method(console, 'error', () => {});
  const url = `http://127.0.0.1:${addr.port}`;
  const get = async p => { const r = await fetch(url + p, { signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.json() }; };
  for (let i = 0; i < 2; i++) {
    const tileRes = await get('/api/v1/map/tiles/0/0/0');
    assert.equal(tileRes.status, 500);
    assert.match(tileRes.body.error, /Broken map tile/);
    const placesRes = await get('/api/v1/places?lat=45.42&lon=-75.69&km=1');
    assert.equal(placesRes.status, 500);
    assert.match(placesRes.body.error, /Broken map tile/);
  }
  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/api/v1/map')).body.available, true);
});

test('map kinds match by layer and detail, so look-alike tags stay apart', () => {
  const { kindIndex, typesFor } = require('../server/map');
  const ctx = SDG.db.open(F.plain(F.load()));
  const idx = kindIndex(ctx);
  const one = (layer, kind, detail) => [...(typesFor(idx, layer, kind, detail) || [])];
  assert.deepEqual(one('buildings', 'industrial'), ['factory'], 'an industrial building is a factory');
  assert.deepEqual(one('landuse', 'industrial'), ['warehouse'], 'an industrial area is warehouses');
  assert.deepEqual(one('pois', 'sports_centre', 'ice_hockey;ice_skating'), ['stadium'], 'an ice arena is an arena');
  assert.deepEqual(one('pois', 'sports_centre', 'soccer'), ['gym'], 'other sports centres are gyms');
  assert.deepEqual(one('pois', 'social_facility'), [], 'a shelter or food bank is not a nursing home');
  assert.deepEqual(one('pois', 'plant'), [], 'a power plant is not a solar farm');
  assert.deepEqual(one('landuse', 'residential'), ['house'], 'a residential area still stands for houses');
  assert.deepEqual(one('buildings', 'school'), ['school'], 'outlines still match tags written for points');
});

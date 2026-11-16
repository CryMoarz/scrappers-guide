// The map: reading a PMTiles archive, decoding vector tiles, ranking the places on them for a
// search, and the hub's map endpoints. The archive is built here: one tile, a few features.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const SDG = require('../core');
const F = require('../lib/fsdata');
const P = require('../server/pmtiles');
const M = require('../server/mvt');
const { createMap } = require('../server/map');
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

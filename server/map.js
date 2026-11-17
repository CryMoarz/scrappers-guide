// The map: places from offline map tiles (Project NOMAD's maps, or PMTiles files of our own),
// matched to building types by their OpenStreetMap tags and ranked for a search, plus light
// tiles the app draws its base map from. A Protomaps map names each place's kind by its OSM tag
// value (shop=hardware is "hardware"), so a building type's `osm` tags are all the matching needs.
const P = require('./pmtiles');
const M = require('./mvt');
const { HttpError } = require('./http');
const SDG = require('../core');

const PLACE_ZOOM = 15;
const MAX_KM = 50;
// Far from you, the map's detail drops: every shop within 3 km, then rings of less detailed tiles
// that still hold the big places (schools, industrial areas, malls, hospitals, farms), so a 50 km
// search reads a few hundred tiles instead of thousands.
const RINGS = [[15, 3], [14, 10], [13, 25], [12, 50]];
// A search reads at most this many tiles (a 50 km search around Ottawa reads 650, so it's well
// under the 1500 tiles kept). Tiles shrink towards the poles: up north, the ring that would read
// the most tiles is read a zoom level lower, with bigger tiles that keep the bigger places.
const MAX_TILES = 1000;
// Place searches across the hub take turns: two at once, a few more wait, and past that the map
// is busy. However many people search, only two searches' tiles are being read at any time.
const SEARCHES = 2, WAITING = 16;
// Street furniture comes by the hundred: only the nearest few of each kind are listed.
const DENSE = new Set(['street_lamp', 'traffic_signals', 'billboard']);
// Homes are everywhere: the nearest one stands for all of them.
const HOMES = new Set(['residential', 'apartments', 'house', 'detached', 'garage', 'garages', 'shed']);
// Building types that are people's homes: a shopping-list run is planned around everything else.
const HOME_TYPES = new Set(['house', 'apartment', 'garage_res']);
const GREEN = new Set(['park', 'wood', 'forest', 'grass', 'garden', 'meadow', 'nature_reserve', 'golf_course', 'cemetery', 'recreation_ground', 'playground', 'pitch', 'scrub', 'allotments', 'village_green', 'farmland', 'orchard', 'vineyard', 'dog_park', 'protected_area', 'national_park']);
const URBAN = new Set(['industrial', 'commercial', 'retail', 'railway', 'military', 'school', 'hospital', 'university', 'college', 'construction', 'landfill', 'depot', 'brownfield', 'quarry', 'airfield', 'aerodrome']);
const ROADS = { highway: 'major', major_road: 'major', medium_road: 'minor', minor_road: 'minor', path: 'path', rail: 'rail' };
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function lru(max) {
  const m = new Map();
  return { get: k => { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; }, set: (k, v) => { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); return v; } };
}
// Runs fns with at most n at a time, so a screen of tiles doesn't hit NOMAD all at once. After a
// failure no more start, and the error comes once the ones running have finished.
async function pool(fns, n) {
  const out = new Array(fns.length);
  let next = 0, err = null;
  await Promise.all(Array.from({ length: Math.min(n, fns.length) }, async () => {
    while (next < fns.length) { const i = next++; try { out[i] = await fns[i](); } catch (e) { err = err || e; next = fns.length; } }
  }));
  if (err) throw err;
  return out;
}
function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r), y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}
const bearing = (lat1, lon1, lat2, lon2) => DIRS[Math.round(((Math.atan2((lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180), lat2 - lat1) * 180) / Math.PI + 360) % 360 / 45) % 8];
// The tiles at zoom z between two distances from a point, less those wholly inside the inner one.
function ringTiles(lat, lon, z, inner, outer) {
  const dLat = outer / 111.32, dLon = outer / (111.32 * Math.cos((lat * Math.PI) / 180));
  const x0 = Math.floor(P.lon2x(lon - dLon, z)), x1 = Math.floor(P.lon2x(lon + dLon, z));
  const y0 = Math.floor(P.lat2y(lat + dLat, z)), y1 = Math.floor(P.lat2y(lat - dLat, z));
  const lons = [], lats = [], out = [];
  for (let x = x0; x <= x1 + 1; x++) lons.push(P.x2lon(x, z));
  for (let y = y0; y <= y1 + 1; y++) lats.push(P.y2lat(y, z));
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const cx = x - x0, cy = y - y0;
    const far = Math.max(distKm(lat, lon, lats[cy], lons[cx]), distKm(lat, lon, lats[cy], lons[cx + 1]), distKm(lat, lon, lats[cy + 1], lons[cx]), distKm(lat, lon, lats[cy + 1], lons[cx + 1]));
    if (far >= inner) out.push([x, y]);
  }
  return out;
}
// The rings a search reads, each with its zoom and tiles, counted before any is read: while there
// are more than MAX_TILES, the ring with the most goes a zoom level lower (on a tie, the outer one).
function plan(a, lat, lon, km) {
  const rings = [];
  let inner = 0;
  for (const [rz, upto] of RINGS) {
    const outer = Math.min(km, upto);
    if (outer <= inner) break;
    rings.push({ z: Math.min(rz, a.maxzoom), inner, outer, tiles: null });
    inner = outer;
  }
  for (;;) {
    rings.forEach(r => { r.tiles = r.tiles || ringTiles(lat, lon, r.z, r.inner, r.outer); });
    if (rings.reduce((n, r) => n + r.tiles.length, 0) <= MAX_TILES) return rings;
    const r = rings.filter(r => r.z > a.minzoom).reduce((m, r) => (!m || r.tiles.length >= m.tiles.length ? r : m), null);
    if (!r) {
      // A map with no lower zoom: the nearest rings, cut off at MAX_TILES.
      let room = MAX_TILES;
      rings.forEach(r => { r.tiles = r.tiles.slice(0, room); room -= r.tiles.length; });
      return rings;
    }
    r.z--;
    r.tiles = null;
  }
}
function centroid(ring) {
  let x = 0, y = 0;
  const n = ring.length / 2;
  for (let i = 0; i < ring.length; i += 2) { x += ring[i]; y += ring[i + 1]; }
  return [x / n, y / n];
}

// Which building types an OSM kind can be: "hardware" → hardware stores; office=* → any office.
const indexes = new WeakMap();
function kindIndex(ctx) {
  if (indexes.has(ctx)) return indexes.get(ctx);
  const by = new Map();
  (ctx.ds.buildings || []).filter(b => !b.deprecated).forEach(b => (b.osm || []).forEach(t => {
    const [k, v] = String(t).split('=');
    const kind = v === '*' ? k : v;
    if (!kind || kind === 'yes') return;
    (by.get(kind) || by.set(kind, new Set()).get(kind)).add(b.id);
  }));
  indexes.set(ctx, by);
  return by;
}

// Scores places for the building types a search ranks (`types`, or every type when null), then
// keeps variety: a few of each type per distance band, one area each, a named place over the
// grounds around it, three of each street fixture, and on a wide search a share for each band.
function rankPlaces(ctx, found, idx, types, o) {
  const { lat, lon, km } = o;
  const scored = [];
  for (const p of found) {
    let best = null;
    for (const id of idx.get(p.kind) || []) {
      const t = types && types.get(id);
      if (types && !t) continue;
      const base = t ? t.n : 100;
      if (!best || base > best.base) best = { id, base, t };
    }
    // Half the score at 1.5 km, or a third of the way out on a wide search.
    if (best) scored.push({ p, best, score: best.base / (1 + p.dist / Math.max(1.5, km / 3)) });
  }
  scored.sort((x, y) => y.score - x.score || x.p.dist - y.p.dist);
  // Variety over repetition: a few named places of each building type, one area or outline each
  // (the nearest residential area stands for "houses all around"), three of each street fixture.
  const dense = {}, perType = {}, areas = new Set(), out = [];
  const points = {};
  scored.forEach(s => { if (s.p.layer === 'pois') (points[s.best.id] = points[s.best.id] || []).push(s.p); });
  for (const s of scored) {
    if (DENSE.has(s.p.kind)) { dense[s.p.kind] = (dense[s.p.kind] || 0) + 1; if (dense[s.p.kind] > 3) continue; }
    // A school's grounds and the school itself are one place: keep the named point.
    if (s.p.layer !== 'pois' && (points[s.best.id] || []).some(x => distKm(x.lat, x.lon, s.p.lat, s.p.lon) < 0.25)) continue;
    // Counted per distance band, so a wide search still finds the far schools and industry.
    const slot = s.best.id + '|' + RINGS.findIndex(r => s.p.dist <= r[1]);
    if (s.p.layer !== 'pois' || HOMES.has(s.p.kind)) { if (areas.has(slot)) continue; areas.add(slot); }
    perType[slot] = (perType[slot] || 0) + 1;
    if (perType[slot] > (o.perType || 4)) continue;
    const bt = ctx.get('buildings', s.best.id);
    out.push({
      name: s.p.name, kind: s.p.kind, lat: +s.p.lat.toFixed(6), lon: +s.p.lon.toFixed(6), area: s.p.layer !== 'pois' || undefined,
      dist: Math.round(s.p.dist * 1000), dir: bearing(lat, lon, s.p.lat, s.p.lon),
      type: { id: s.best.id, name: bt ? bt.name : s.best.id }, score: Math.round(s.score),
      likelyLeft: s.best.t && s.best.t.remain != null ? SDG.search.leftLabel(s.best.t.remain) : undefined,
      mostlyFrom: s.best.t ? s.best.t.devices.slice(0, 3).map(d => d.n) : undefined,
    });
  }
  // On a wide search a dense centre would fill the whole list: keep part of it for the best
  // places further out, which is what a run out of town is planned around.
  const limit = o.limit || 40, near = RINGS[0][1];
  let list = out.slice(0, limit);
  if (km > near) {
    // The far share is split across the distance bands, so 10 to 25 km gets its say too.
    const bands = RINGS.slice(1).map((r, i) => [RINGS[i][1], Math.min(r[1], km)]).filter(([lo, hi]) => hi > lo);
    const keepFar = Math.ceil(limit * 0.4), each = Math.ceil(keepFar / bands.length);
    const inBand = ([lo, hi]) => out.filter(x => x.dist > lo * 1000 && x.dist <= hi * 1000);
    let far = bands.flatMap(b => inBand(b).slice(0, each)).slice(0, keepFar);
    if (far.length < keepFar) far = [...far, ...out.filter(x => x.dist > near * 1000 && !far.includes(x)).slice(0, keepFar - far.length)];
    list = [...out.filter(x => x.dist <= near * 1000).slice(0, limit - far.length), ...far].sort((x, y) => y.score - x.score || x.dist - y.dist);
  }
  return { list, dense };
}

function createMap(hub) {
  const cfg = hub.cfg.map || {};
  const opened = new Map();
  let archives = null, found = 0, looking = null;

  // Our own files first, then whatever regions NOMAD has; checked again every ten minutes, once
  // for everyone asking at that moment. NOMAD's list of maps is short, so only its first 1 MB
  // and first 64 maps are read, whatever answers.
  async function sources() {
    if (archives && Date.now() - found < (archives.length ? 10 * 60e3 : 60e3)) return archives;
    return looking || (looking = look().finally(() => { looking = null; }));
  }
  async function look() {
    const list = [...(cfg.pmtiles || [])];
    const nomad = hub.nomadState && hub.nomadState.nomad;
    if (nomad && cfg.nomad !== false) {
      try {
        const res = await fetch(nomad.url + '/api/maps/regions', { signal: AbortSignal.timeout(10e3) });
        const r = JSON.parse(await P.readBody(res, 1 << 20));
        (r.files || []).slice(0, 64).forEach(f => { if (/\.pmtiles$/i.test(f.name || '')) list.push(`${nomad.url}/pmtiles/${encodeURIComponent(f.name)}`); });
      } catch (e) { /* NOMAD not answering: use what we have */ }
    }
    const out = [];
    for (const w of list) {
      try { if (!opened.has(w)) opened.set(w, await P.openArchive(w)); out.push(opened.get(w)); } catch (e) { console.warn('map: ' + e.message); }
    }
    archives = out.sort((a, b) => b.maxzoom - a.maxzoom);
    found = Date.now();
    return archives;
  }
  const covering = async (lon, lat) => (await sources()).find(a => a.covers(lon, lat));

  // Places in one tile that some building type matches: points as they are, areas at their
  // middle, buildings only when they say what they are. Each tile is read and decoded once, and
  // only the matching places are kept (a city tile holds thousands of trees and benches).
  const placeTiles = lru(1500);
  function tilePlaces(a, z, x, y, kinds) {
    const key = `${a.where}|${z}/${x}/${y}|${kinds.size}`;
    return placeTiles.get(key) || placeTiles.set(key, (async () => {
      const buf = await a.tile(z, x, y);
      if (!buf) return [];
      const L = M.decode(buf, ['pois', 'landuse', 'buildings']), out = [];
      for (const [layer, d] of Object.entries(L)) {
        for (const f of d.features) {
          const kind = layer === 'buildings' ? f.props.kind_detail : f.props.kind;
          if (!kinds.has(kind) || !f.geom[0]) continue;
          const pt = f.type === 'point' ? f.geom[0] : f.type === 'polygon' ? centroid(f.geom[0]) : null;
          if (!pt || pt[0] < 0 || pt[1] < 0 || pt[0] >= d.extent || pt[1] >= d.extent) continue;
          out.push({ id: f.id || null, layer, kind, name: f.props.name || '', lon: P.x2lon(x + pt[0] / d.extent, z), lat: P.y2lat(y + pt[1] / d.extent, z) });
        }
      }
      return out;
    })().catch(e => { placeTiles.set(key, undefined); throw e; }));
  }

  // Searches take turns (SEARCHES at once, WAITING in line), reading tiles and ranking what they
  // find; the next in line gets the turn.
  let running = 0;
  const line = [];
  async function inTurn(fn) {
    if (running < SEARCHES) running++;
    else if (line.length < WAITING) await new Promise(ok => line.push(ok));
    else throw new HttpError(503, 'The map is busy with other searches; try again in a moment');
    try { return await fn(); } finally { const next = line.shift(); if (next) next(); else running--; }
  }

  async function nearby(a, lat, lon, km, kinds) {
    const jobs = [];
    for (const r of plan(a, lat, lon, km)) {
      for (const [x, y] of r.tiles) jobs.push(() => tilePlaces(a, r.z, x, y, kinds).then(list => list.filter(p => { const d = distKm(lat, lon, p.lat, p.lon); return d > r.inner && d <= r.outer; })));
    }
    const seen = new Set(), out = [];
    for (const p of (await pool(jobs, 8)).flat()) {
      const d = distKm(lat, lon, p.lat, p.lon);
      const k = p.id ? p.layer + p.id : `${p.kind}|${p.name}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(Object.assign({ dist: d }, p));
    }
    return out;
  }

  // Places near a point ranked for a search: the building type's score for what was asked
  // (how likely it holds the best devices, how much is probably left), lowered with distance.
  // With no search, every place a building type matches, nearest first.
  const places = (ctx, o) => inTurn(() => findPlaces(ctx, o));
  async function findPlaces(ctx, o) {
    const lat = +o.lat, lon = +o.lon, km = Math.min(MAX_KM, Math.max(0.1, +o.km || 2));
    const a = await covering(lon, lat);
    if (!a) return { here: { lat, lon }, km, places: [], note: 'No offline map covers this place.' };
    const idx = kindIndex(ctx);
    const res = o.query && o.query.trim() ? SDG.search.search(ctx, o.query, o.opts || {}) : null;
    let types = res && res.ranked.blds.length ? new Map(res.ranked.blds.map(b => [b.bt.id, b])) : null;
    // A search that names a device ("hair dryer") looks where that device is found.
    if (res && !types && res.devices.length) {
      types = new Map();
      res.devices.slice(0, 3).forEach(d => ((ctx.resolve(d.id) || {}).buildings || []).forEach(({ b, l }) => {
        const cur = types.get(b);
        if (!cur || l * 20 > cur.n) types.set(b, { n: l * 20, devices: [{ n: d.name }] });
      }));
    }
    const near = await nearby(a, lat, lon, km, idx);
    const detail = km > RINGS[0][1] ? `Every shop within ${RINGS[0][1]} km; further out, the bigger places the map keeps at less detail.` : undefined;
    // Several part types at once (a shopping list): the best few places for each, leaving out
    // people's homes, which have a bit of everything and would be every answer.
    if (o.parts) {
      const parts = {};
      for (const fn of o.parts) {
        if (!ctx.get('parts', fn)) continue;
        const r = SDG.search.search(ctx, '', Object.assign({}, o.opts, { sel: new Map([[fn, { via: 'direct', on: true }]]) }));
        const t = new Map(r.ranked.blds.filter(b => !HOME_TYPES.has(b.bt.id)).map(b => [b.bt.id, b]));
        parts[fn] = t.size ? rankPlaces(ctx, near, idx, t, { lat, lon, km, limit: o.perPart || 5, perType: 2 }).list : [];
        // Ranking 40 part types can take a second: let other requests in between them.
        await new Promise(ok => setImmediate(ok));
      }
      return { here: { lat, lon }, km, map: a.where.split('/').pop(), parts, detail };
    }
    // A search that finds nothing in the guide still shows what is near, and says so.
    const { list, dense } = rankPlaces(ctx, near, idx, types, Object.assign({}, o, { lat, lon, km }));
    return { here: { lat, lon }, km, query: o.query || '', map: a.where.split('/').pop(), places: list, alsoNearby: Object.keys(dense).length ? dense : undefined,
      detail, note: res && !types ? `Nothing in the guide matches “${o.query}”, so this is everything nearby.` : undefined };
  }

  // A light tile for drawing: water, green and built-up areas, roads, buildings (close in) and
  // place names, at 512 units a side instead of the map's 4096. Cached, and gzipped once.
  const drawn = lru(200);
  async function renderTile(z, x, y) {
    const lon = P.x2lon(x + 0.5, z), lat = P.y2lat(y + 0.5, z);
    const a = await covering(lon, lat);
    if (!a || z > a.maxzoom) return null;
    const key = `${a.where}|${z}/${x}/${y}`;
    const hit = drawn.get(key);
    if (hit) return hit;
    const buf = await a.tile(z, x, y);
    const out = { water: [], green: [], urban: [], buildings: [], major: [], minor: [], path: [], rail: [], waterways: [], labels: [] };
    if (buf) {
      const L = M.decode(buf, ['water', 'landuse', 'roads', 'buildings', 'places']);
      const q = (geom, ext) => {
        const s = ext / 512, r = [];
        let px = null, py = null;
        for (let i = 0; i < geom.length; i += 2) { const gx = Math.round(geom[i] / s), gy = Math.round(geom[i + 1] / s); if (gx !== px || gy !== py) { r.push(gx, gy); px = gx; py = gy; } }
        return r;
      };
      const add = (list, f, ext) => f.geom.forEach(g => { const r = q(g, ext); if (r.length >= 4) list.push(r); });
      for (const [name, d] of Object.entries(L)) {
        for (const f of d.features) {
          const k = f.props.kind;
          if (name === 'water') add(f.type === 'polygon' ? out.water : out.waterways, f, d.extent);
          else if (name === 'landuse' && f.type === 'polygon') { if (GREEN.has(k)) add(out.green, f, d.extent); else if (URBAN.has(k)) add(out.urban, f, d.extent); }
          else if (name === 'roads' && f.type === 'line' && ROADS[k]) add(out[ROADS[k]], f, d.extent);
          else if (name === 'buildings' && f.type === 'polygon' && z >= 14 && k !== 'address') add(out.buildings, f, d.extent);
          else if (name === 'places' && f.type === 'point' && f.props.name && (f.props.min_zoom == null || f.props.min_zoom <= z + 1)) {
            // English where the map has it: local names can be in scripts many readers can't read.
            const [px, py] = f.geom[0];
            if (px >= 0 && py >= 0 && px < d.extent && py < d.extent) out.labels.push([Math.round(px / (d.extent / 512)), Math.round(py / (d.extent / 512)), f.props['name:en'] || f.props.name, k]);
          }
        }
      }
    }
    return drawn.set(key, Buffer.from(JSON.stringify(out)));
  }

  async function info() {
    const list = await sources();
    return { available: list.length > 0, placeZoom: PLACE_ZOOM, maxKm: MAX_KM, sources: list.map(a => ({ name: a.where.split('/').pop(), minzoom: a.minzoom, maxzoom: a.maxzoom, bounds: a.bounds, center: a.center })) };
  }

  const close = () => { opened.forEach(a => a.close()); opened.clear(); archives = null; };
  return { info, places, renderTile, sources, close };
}

module.exports = { createMap, kindIndex, distKm, plan, MAX_TILES, SEARCHES, WAITING };

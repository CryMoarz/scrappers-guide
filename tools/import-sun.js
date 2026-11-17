// Sun and cold for sizing off-grid solar anywhere, offline: NASA POWER's monthly climatology averaged
// to a 2° grid over land, written as app/src/sungrid.js. A one-time import: POWER's numbers are
// 25-year averages, so it only needs rerunning when POWER publishes a newer period.
// Usage: node tools/import-sun.js [--cache dir] [--dry]
//   --cache  where raw downloads are kept (default: a folder in the system temp dir), so a rerun
//            after a failure, or to change the averaging, fetches nothing twice
//   --dry    only count the land cells and the requests a run would make
// Sources, both read from their docs:
//   NASA POWER climatology API (power.larc.nasa.gov/docs/services/api/temporal/climatology/):
//     regional requests take one parameter each, and at most a 10° range of latitude and of
//     longitude (the API's own 422 message). POWER sets no published rate limit but watches use and
//     answers floods with 429, so requests go one at a time with a pause between them (an older
//     reported climatology limit was 30 a minute; this stays under it) and back off on 429 or 5xx.
//   Natural Earth 1:50m land polygons (public domain), from the v5.1.2 release, to keep land cells only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const CACHE = args.includes('--cache') ? path.resolve(args[args.indexOf('--cache') + 1]) : path.join(os.tmpdir(), 'scrappers-guide-sun-cache');
const OUT = path.join(ROOT, 'app', 'src', 'sungrid.js');

// The grid: 2° cells from 60°S (nobody lives further south) to 84°N (the north tip of Greenland).
const STEP = 2, LAT0 = -60, LON0 = -180, ROWS = (84 - LAT0) / STEP, COLS = 360 / STEP;
const BOX = 10; // POWER's largest regional request, in degrees each way
const API = 'https://power.larc.nasa.gov/api/temporal/climatology/regional';
// Solar is native on a 1° grid (CERES SYN1deg); temperature on 0.5° × 0.625° (MERRA-2).
// T2M_MIN in POWER's climatology is the coldest hour in 25 years and T2M_MIN_AVG the average of each
// month's coldest hour, so the mean daily minimum is worked out as T2M − T2M_RANGE / 2 (the mean
// daily range, centred on the daily mean).
const PARAMS = ['ALLSKY_SFC_SW_DWN', 'ALLSKY_SFC_SW_DIFF', 'T2M', 'T2M_RANGE'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const LAND_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_land.geojson';
const UA = { 'User-Agent': 'scrappers-guide-research/1 (+offline salvage database)' };
const PAUSE = 2000, TRIES = 6;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fetched = 0;

// One download, from the cache if it's there. Written to a .part file first, so a run stopped
// halfway never leaves a broken file that a rerun would trust.
async function cached(name, url, check) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  for (let i = 0; ; i++) {
    if (fetched) await sleep(PAUSE);
    fetched++;
    let res, text, wait;
    try {
      res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(180000) });
      text = await res.text();
      if (res.ok && check(text)) {
        fs.writeFileSync(file + '.part', text);
        fs.renameSync(file + '.part', file);
        return text;
      }
      // A refused request (other than "too many") is a mistake here, and asking again won't fix it.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(new Error(`${res.status} from ${url}: ${text.slice(0, 300)}`), { fatal: true });
      wait = Number(res.headers.get('retry-after')) * 1000;
    } catch (e) {
      if (e.fatal) throw e;
      text = e.message;
    }
    if (i + 1 >= TRIES) throw new Error(`gave up on ${url} after ${TRIES} tries: ${res ? res.status : ''} ${String(text).slice(0, 200)}`);
    wait = wait || 15000 * 2 ** i; // 15 s, 30 s, 1 min, 2 min, 4 min
    console.log(`  ${res ? res.status : 'no answer'}; trying again in ${Math.round(wait / 1000)} s`);
    await sleep(wait);
  }
}
const isJSON = t => { try { JSON.parse(t); return true; } catch (e) { return false; } };

// Is a point on land? Even-odd rule over every ring of every polygon: a ray east from the point
// crosses land edges an odd number of times only from inside land, and a lake or other hole adds
// its own crossings, so holes count without special handling. Natural Earth's land polygons don't
// overlap, so one count over all of them works. Edges are filed by 1° band of latitude, so each
// point only looks at the edges its ray could cross.
const polygons = geo => geo.features.flatMap(f => { const g = f.geometry || {}; return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; });
function landTest(geo) {
  const bands = Array.from({ length: 180 }, () => []);
  for (const poly of polygons(geo)) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[j], [x2, y2] = ring[i];
        if (y1 === y2) continue; // flat edges never cross an east-west ray
        const e = [x1, y1, x2, y2];
        for (let b = Math.max(0, Math.floor(Math.min(y1, y2) + 90)); b <= Math.min(179, Math.floor(Math.max(y1, y2) + 90)); b++) bands[b].push(e);
      }
    }
  }
  return (lon, lat) => {
    if (lon >= 180) lon -= 360; // 180°E is 180°W, where the polygons are cut
    let inside = false;
    for (const [x1, y1, x2, y2] of bands[Math.min(179, Math.max(0, Math.floor(lat + 90)))]) {
      if ((y1 > lat) !== (y2 > lat) && lon < x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
    }
    return inside;
  };
}

(async () => {
  const t0 = Date.now();
  fs.mkdirSync(CACHE, { recursive: true });
  console.log(`Cache: ${CACHE}`);
  const geo = JSON.parse(await cached('ne_50m_land-v5.1.2.geojson', LAND_URL, isJSON));
  const onLand = landTest(geo);

  // Land cells: any of 9 points (corners, edge midpoints, centre) on land, so coasts are kept even
  // when most of the cell is sea.
  const land = new Uint8Array(ROWS * COLS);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const la = LAT0 + r * STEP, lo = LON0 + c * STEP;
    land[r * COLS + c] = [0, 1, 2].some(i => [0, 1, 2].some(j => onLand(lo + (j * STEP) / 2, la + (i * STEP) / 2))) ? 1 : 0;
  }
  // An island narrower than the points' spacing can slip between them (Bermuda, most atolls), so
  // a cell holding any corner of one is land too.
  let islands = 0;
  for (const [outer] of polygons(geo)) {
    const xs = outer.map(v => v[0]), ys = outer.map(v => v[1]);
    if (Math.max(...xs) - Math.min(...xs) >= STEP / 2 && Math.max(...ys) - Math.min(...ys) >= STEP / 2) continue;
    for (const [lon, lat] of outer) {
      const r = Math.floor((lat - LAT0) / STEP), c = ((Math.floor((lon - LON0) / STEP) % COLS) + COLS) % COLS;
      if (r >= 0 && r < ROWS && !land[r * COLS + c]) { land[r * COLS + c] = 1; islands++; }
    }
  }
  const order = []; // land cell indexes in bitmap order, which is the order of the data arrays
  land.forEach((v, i) => v && order.push(i));

  // The 10° boxes with any land in them, asked for one parameter at a time.
  const boxes = [];
  const per = BOX / STEP;
  for (let r = 0; r < ROWS; r += per) for (let c = 0; c < COLS; c += per) {
    let any = false;
    for (let i = r; i < Math.min(ROWS, r + per); i++) for (let j = c; j < c + per; j++) any = any || !!land[i * COLS + j];
    if (any) boxes.push({ s: LAT0 + r * STEP, n: Math.min(LAT0 + ROWS * STEP, LAT0 + (r + per) * STEP), w: LON0 + c * STEP, e: LON0 + (c + per) * STEP });
  }
  const jobs = boxes.flatMap(b => PARAMS.map(p => ({ b, p, name: `power-${p}-${b.s}_${b.n}_${b.w}_${b.e}.json` })));
  const have = jobs.filter(j => fs.existsSync(path.join(CACHE, j.name))).length;
  console.log(`${order.length} land cells of ${ROWS} × ${COLS} (${islands} only for small islands); ${boxes.length} boxes × ${PARAMS.length} parameters = ${jobs.length} requests (${have} cached)`);
  if (args.includes('--dry')) return;

  // Every native point, by parameter and place. Boxes share their edges, so a point can come twice.
  const pts = Object.fromEntries(PARAMS.map(p => [p, new Map()]));
  const periods = new Set();
  let n = 0;
  for (const { b, p, name } of jobs) {
    const url = `${API}?parameters=${p}&community=RE&latitude-min=${b.s}&latitude-max=${b.n}&longitude-min=${b.w}&longitude-max=${b.e}&format=JSON`;
    const j = JSON.parse(await cached(name, url, t => isJSON(t) && Array.isArray(JSON.parse(t).features)));
    for (const m of j.messages || []) { const x = /period \((\w+ \d{4}) - (\w+ \d{4})\)/.exec(m); if (x) periods.add(`${x[1]} – ${x[2]}`); }
    for (const f of j.features) {
      const [lon, lat] = f.geometry.coordinates;
      const v = f.properties.parameter[p];
      if (v) pts[p].set(`${lat},${lon >= 180 ? lon - 360 : lon}`, MONTHS.map(m => (v[m] > -900 ? v[m] : null)));
    }
    if (++n % 50 === 0) console.log(`  ${n}/${jobs.length} (${fetched} fetched, ${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  if (periods.size !== 1) throw new Error(`expected one climatology period, got: ${[...periods].join('; ') || 'none'}`);

  // Native points by cell. Cells are half-open ([south, north) × [west, east)) so a point on an edge
  // counts once; points on the grid's north edge (84°N) fall outside it.
  const cellOf = key => {
    const [lat, lon] = key.split(',').map(Number);
    const r = Math.floor((lat - LAT0) / STEP), c = ((Math.floor((lon - LON0) / STEP) % COLS) + COLS) % COLS;
    return r >= 0 && r < ROWS ? r * COLS + c : -1;
  };
  const landAt = new Map();
  const isLand = key => { if (!landAt.has(key)) { const [lat, lon] = key.split(',').map(Number); landAt.set(key, onLand(lon, lat)); } return landAt.get(key); };
  const byCell = (map, fn) => {
    const out = new Map();
    for (const [key, v] of map) {
      const i = cellOf(key);
      if (i < 0 || !land[i]) continue;
      const val = fn ? fn(key, v) : v;
      if (val) (out.get(i) || out.set(i, []).get(i)).push({ land: isLand(key), v: val });
    }
    return out;
  };
  // Mean daily minimum per month at each temperature point.
  const tmin = (key, t) => { const rg = pts.T2M_RANGE.get(key); return rg && t.map((x, m) => (x == null || rg[m] == null ? null : x - rg[m] / 2)); };
  const cells = { ghi: byCell(pts.ALLSKY_SFC_SW_DWN), dif: byCell(pts.ALLSKY_SFC_SW_DIFF), tmin: byCell(pts.T2M, tmin) };
  // A cell's monthly means from its points on land, or from all of them when none is (a small
  // island): over a coast, sea points would make the nights milder than anywhere people live.
  const monthly = list => {
    const l = (list || []).filter(x => x.land), use = l.length ? l : list || [];
    return MONTHS.map((_, m) => { const v = use.map(x => x.v[m]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });
  };

  // Bytes: sun in 0.05 kWh/m²/day steps (0 to 12.7), cold as °C + 100; 255 is no data in all.
  // Diffuse is kept as its share of the total, in 250ths: in a dark month at 60°N or beyond, total
  // and diffuse are a few 0.05 steps each, and the direct part (their difference) is multiplied
  // several times over on a steep panel, so rounding both would swamp it.
  const ghi = new Uint8Array(order.length * 12), dif = new Uint8Array(order.length * 12), cold = new Uint8Array(order.length);
  const sun = v => (v == null ? 255 : Math.min(254, Math.max(0, Math.round(v / 0.05))));
  const share = (d, g) => (d == null || g == null ? 255 : g <= 0 ? 250 : Math.round(250 * Math.min(1, Math.max(0, d / g))));
  let missing = 0;
  order.forEach((i, k) => {
    const g = monthly(cells.ghi.get(i)), d = monthly(cells.dif.get(i)), t = monthly(cells.tmin.get(i)).filter(x => x != null);
    for (let m = 0; m < 12; m++) { ghi[k * 12 + m] = sun(g[m]); dif[k * 12 + m] = share(d[m], g[m]); }
    cold[k] = t.length ? Math.min(254, Math.max(0, Math.round(Math.min(...t)) + 100)) : 255;
    if (g.includes(null) || d.includes(null) || !t.length) missing++;
  });
  const bits = new Uint8Array(Math.ceil((ROWS * COLS) / 8));
  order.forEach(i => { bits[i >> 3] |= 1 << (i & 7); });

  const b64 = a => Buffer.from(a).toString('base64');
  const [period] = periods;
  const years = period.replace(/\w+ (\d{4}) – \w+ (\d{4})/, '$1–$2');
  // Local dates; "accessed" is when the newest download landed, which a rerun from the cache keeps.
  const day = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const today = day(Date.now()), accessed = day(Math.max(...jobs.map(j => fs.statSync(path.join(CACHE, j.name)).mtimeMs)));
  const api = (JSON.parse(fs.readFileSync(path.join(CACHE, jobs[0].name), 'utf8')).header || {}).api || {};
  const source = `NASA POWER climatology (${api.name || 'POWER Climatology API'} ${api.version || ''}, community RE, accessed ${accessed}): ALLSKY_SFC_SW_DWN and ALLSKY_SFC_SW_DIFF (CERES SYN1deg), T2M and T2M_RANGE (MERRA-2); land from Natural Earth 1:50m (public domain)`.replace(/ {2,}/g, ' ');
  const text = `// Generated by tools/import-sun.js on ${today}: don't edit by hand. To remake it:
//   node tools/import-sun.js [--cache dir]
// Monthly sun and cold on a ${STEP}° grid over land, ${LAT0}° to ${LAT0 + ROWS * STEP}° latitude, for sizing off-grid solar offline.
// From NASA POWER's monthly climatology (${period}): global and diffuse sun on the flat
// (ALLSKY_SFC_SW_DWN, ALLSKY_SFC_SW_DIFF, native 1°) and the coldest month's mean daily minimum
// (T2M - T2M_RANGE / 2, native 0.5° × 0.625°), each the mean of the native points in a cell that
// are on land, or of all of them when none is. A cell is land when any of 9 points in it (corners,
// edge midpoints, centre) is on Natural Earth's 1:50m land, or it holds a corner of an island too
// small for the points to catch, so coasts and small islands are kept.
//   land  bitmap, one bit per cell (bit i is byte i >> 3, bit i & 7), cell i = row × cols + col,
//         rows from lat0 northward, cols from lon0 eastward
//   ghi   12 bytes per land cell in bitmap order, JAN to DEC, in 0.05 kWh/m²/day; 255 = no data
//   dif   12 bytes per land cell likewise: diffuse's share of ghi in 250ths (diffuse = ghi × byte / 250),
//         so the direct part isn't lost to rounding in dark months; 255 = no data
//   cold  1 byte per land cell: the coldest month's mean daily minimum in °C, + 100; 255 = no data
Sun.use({
  step: ${STEP}, lat0: ${LAT0}, lon0: ${LON0}, rows: ${ROWS}, cols: ${COLS},
  source: ${JSON.stringify(source)},
  period: ${JSON.stringify(years)},
  land: '${b64(bits)}',
  ghi: '${b64(ghi)}',
  dif: '${b64(dif)}',
  cold: '${b64(cold)}',
});
`;
  fs.writeFileSync(OUT, text);
  console.log(`Wrote app/src/sungrid.js: ${Math.round(Buffer.byteLength(text) / 1024)} KB, ${order.length} land cells (${missing} with gaps), ${years}`);
  console.log(`${fetched} requests made in ${Math.round((Date.now() - t0) / 1000)} s`);
})().catch(e => { console.error(e); process.exit(1); });

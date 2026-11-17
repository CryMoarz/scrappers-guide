// The offline sun grid and the tilted-panel maths: the packed grid holds together, places come out
// close to NASA POWER's own point values, sea is sea, islands are found, and panels in both
// hemispheres and in the polar night give sensible numbers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'app', 'src', f), 'utf8');
// As the app runs them: sun.js, then the grid handed to it, in one script.
const ctx = vm.createContext({ atob });
vm.runInContext(`${src('sun.js')}\n${src('sungrid.js')}\n;globalThis.__sun = Sun;`, ctx);
const Sun = ctx.__sun;
// The grid as sungrid.js hands it over, before Sun unpacks it.
const raw = (() => { const c = vm.createContext({ Sun: { use: g => (c.grid = g) } }); vm.runInContext(src('sungrid.js'), c); return c.grid; })();
const bytes = s => Buffer.from(s, 'base64');
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

test('sun: the bitmap and the data arrays agree', () => {
  assert.strictEqual(raw.rows, (84 - raw.lat0) / raw.step);
  assert.strictEqual(raw.cols, 360 / raw.step);
  const bits = bytes(raw.land);
  assert.strictEqual(bits.length, Math.ceil((raw.rows * raw.cols) / 8));
  let cells = 0;
  for (let i = 0; i < raw.rows * raw.cols; i++) if (bits[i >> 3] & (1 << (i & 7))) cells++;
  assert.ok(cells > 3000, `${cells} land cells`);
  assert.strictEqual(bytes(raw.ghi).length, cells * 12);
  assert.strictEqual(bytes(raw.dif).length, cells * 12);
  assert.strictEqual(bytes(raw.cold).length, cells);
  assert.ok(Buffer.byteLength(src('sungrid.js')) < 300 * 1024, 'sungrid.js stays under 300 KB');
  const info = Sun.info();
  assert.strictEqual(info.step, 2);
  assert.match(info.period, /^\d{4}–\d{4}$/);
  assert.match(info.source, /NASA POWER/);
});

test('sun: Ottawa comes out close to the POWER point values', () => {
  // POWER's point API at 45.42, -75.70: December 1.05, July 5.89 kWh/m²/day. The grid averages
  // four 1° cells into one 2° cell and rounds to 0.05, so allow for that.
  const o = Sun.at(45.42, -75.7);
  assert.ok(o, 'Ottawa is on land');
  assert.strictEqual(o.lat, 45);
  assert.strictEqual(o.lon, -75);
  near(o.ghi[11], 1.05, 0.1, 'December');
  near(o.ghi[6], 5.89, 0.25, 'July');
  assert.ok(o.dif.every((d, m) => d > 0 && d <= o.ghi[m]), 'diffuse is part of the total');
  assert.ok(o.cold < -10 && o.cold > -25, `coldest month's mean daily minimum ${o.cold} °C`);
});

test('sun: the sea and off the grid are null; a small island and the dateline are found', () => {
  assert.strictEqual(Sun.at(0, -140), null, 'mid-Pacific');
  assert.strictEqual(Sun.at(-35, -20), null, 'mid-Atlantic');
  assert.strictEqual(Sun.at(-75, 0), null, 'south of the grid');
  assert.strictEqual(Sun.at(88, 0), null, 'north of the grid');
  assert.strictEqual(Sun.at(NaN, 0), null);
  const bermuda = Sun.at(32.3, -64.8);
  assert.ok(bermuda, 'Bermuda');
  assert.ok(bermuda.ghi[6] > 5 && bermuda.ghi[11] > 2, 'Bermuda is sunny');
  assert.ok(Sun.at(-17.8, 178.0), 'Fiji, near 180°');
  assert.deepStrictEqual(Object.assign({}, Sun.at(64.8, 360 - 147.7)), Object.assign({}, Sun.at(64.8, -147.7)), 'longitude wraps');
});

test('sun: a flat panel gets the total; a steep one gets more in winter', () => {
  const o = Sun.at(45.42, -75.7);
  Sun.tilted(45.42, o.ghi, o.dif, 0).forEach((t, m) => near(t, o.ghi[m], 1e-9, `month ${m + 1} at tilt 0`));
  assert.strictEqual(Sun.tiltFor(45.42), 60);
  const steep = Sun.tilted(45.42, o.ghi, o.dif, Sun.tiltFor(45.42));
  assert.ok(steep[11] > o.ghi[11] * 1.3, `December: ${steep[11]} on the panel, ${o.ghi[11]} flat`);
  assert.ok(steep[11] < o.ghi[11] * 3);
  assert.ok(steep[5] < o.ghi[5], 'a steep panel loses out in June');
});

test('sun: in the south the panel faces north, and winter is June', () => {
  const m = Sun.at(-37.8, 145.0);
  assert.ok(m, 'Melbourne');
  assert.strictEqual(Sun.tiltFor(-37.8), 53);
  const t = Sun.tilted(-37.8, m.ghi, m.dif, Sun.tiltFor(-37.8));
  assert.ok(t[5] > m.ghi[5], `June: ${t[5]} on the panel, ${m.ghi[5]} flat`);
  assert.ok(t[11] < m.ghi[11], 'a steep north-facing panel loses out in December');
});

test('sun: polar night is 0, not NaN, and polar day works', () => {
  const zero = Array(12).fill(0);
  assert.deepStrictEqual([...Sun.tilted(80, zero, zero, 90)], zero);
  const svalbard = Sun.at(78.2, 15.6);
  assert.ok(svalbard, 'Longyearbyen');
  const t = Sun.tilted(78.2, svalbard.ghi, svalbard.dif, Sun.tiltFor(78.2));
  assert.ok(t.every(Number.isFinite), t.join(' '));
  assert.ok(t[11] <= 0.1, `December: ${t[11]}`);
  assert.ok(t[5] > 1, `June: ${t[5]}`);
  // Even fed sun it can't have, the maths stays finite.
  assert.ok(Sun.tilted(89.99, Array(12).fill(1), Array(12).fill(0.5), 90).every(Number.isFinite));
  assert.strictEqual(Sun.tiltFor(80), 90);
});

// Electrical ratings (v, a, w, ah, ac) on part entries in devices, boards and models.
//   node tools/specs.js report              how many entries of each part type state ratings
//   node tools/specs.js fill [--dry]        copy ratings the spec text states unambiguously into the fields
//   node tools/specs.js apply <file.json>   add reviewed ratings: [{coll, id, key, v?, a?, w?, ah?, ac?}]
// Fill and apply never overwrite a stated rating, and apply refuses one the spec text contradicts.
const fs = require('fs');
const SDG = require('../core');
const F = require('../lib/fsdata');

const [cmd, arg] = process.argv.slice(2);
const ds = F.load();
const S = SDG.specs;
const COLLS = ['devices', 'boards', 'models'];
const entries = () => COLLS.flatMap(coll => (ds[coll] || []).flatMap(rec => (rec.comps || []).filter(c => !c.absent).map(c => ({ coll, rec, c }))));
// Puts ratings right after the spec they come from, so a data file reads "spec":"36V pack","v":36.
function place(rec, c, r) {
  const out = {};
  Object.keys(c).forEach(k => { out[k] = c[k]; if (k === 'spec') Object.assign(out, r); });
  Object.assign(out, r);
  rec.comps[rec.comps.indexOf(c)] = out;
  return out;
}
const stated = c => S.KEYS.some(k => c[k] != null);
const overlaps = (x, y) => (Array.isArray(x) ? x[1] : x) >= (Array.isArray(y) ? y[0] : y) * 0.9 && (Array.isArray(x) ? x[0] : x) <= (Array.isArray(y) ? y[1] : y) * 1.1;

// Ratings in `r` that disagree with numbers the spec text states.
function conflicts(c, r) {
  const said = S.parse(c.spec);
  return S.KEYS.filter(k => r[k] != null && said[k] != null && !overlaps(r[k], said[k])).map(k => `${k} ${JSON.stringify(r[k])} but the spec says ${JSON.stringify(said[k])}`);
}

if (cmd === 'report') {
  const by = {};
  entries().forEach(({ c }) => {
    const fn = c.fn || '(model override)';
    const b = by[fn] || (by[fn] = { n: 0, any: 0, stated: 0 });
    b.n++;
    if (Object.keys(S.ratings(c)).length) b.any++;
    if (stated(c)) b.stated++;
  });
  console.log('part type                    entries  with ratings  stated in fields');
  Object.entries(by).sort((a, b) => b[1].n - a[1].n).forEach(([fn, b]) => console.log(`${fn.padEnd(28)} ${String(b.n).padStart(7)} ${String(b.any).padStart(13)} ${String(b.stated).padStart(17)}`));
} else if (cmd === 'fill') {
  const dry = process.argv.includes('--dry');
  const touched = new Map();
  let n = 0;
  entries().forEach(({ coll, rec, c }) => {
    if (stated(c)) return;
    const r = S.parse(c.spec);
    if (!Object.keys(r).length) return;
    place(rec, c, r);
    touched.set(coll + '/' + rec.id, { coll, rec });
    n++;
  });
  if (!dry) touched.forEach(({ coll, rec }) => F.writeRecord(F.DATA, coll, rec));
  console.log(`${dry ? 'Would fill' : 'Filled'} ratings on ${n} entries in ${touched.size} records.`);
} else if (cmd === 'apply') {
  const list = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const touched = new Map();
  let n = 0, skipped = 0;
  list.forEach(p => {
    const rec = (ds[p.coll] || []).find(r => r.id === p.id);
    const c = rec && (rec.comps || []).find(x => x.key === p.key);
    // Only ratings the entry doesn't state yet: apply adds, it never overwrites.
    const r = {};
    S.KEYS.forEach(k => { if (p[k] != null && c && c[k] == null) r[k] = p[k]; });
    if (p.ac && c && !c.ac) r.ac = true;
    const why = !c ? 'no such entry' : !Object.keys(r).length ? 'nothing new' : conflicts(c, r).join('; ');
    if (why) { console.log(`skip ${p.coll}/${p.id} ${p.key}: ${why}`); skipped++; return; }
    const v = SDG.schema.validate(p.coll === 'models' ? 'compOverride' : 'comp', Object.assign({}, c, r));
    if (v.errors.length) { console.log(`skip ${p.coll}/${p.id} ${p.key}: ${v.errors.map(e => e.path + ' ' + e.msg).join('; ')}`); skipped++; return; }
    place(rec, c, r);
    touched.set(p.coll + '/' + p.id, { coll: p.coll, rec });
    n++;
  });
  touched.forEach(({ coll, rec }) => F.writeRecord(F.DATA, coll, rec));
  console.log(`Added ratings to ${n} entries in ${touched.size} records${skipped ? `, skipped ${skipped}` : ''}.`);
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 6).map(l => l.slice(3)).join('\n'));
}

module.exports = { conflicts };

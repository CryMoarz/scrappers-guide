// Checks every record in data/ against schema/sdg.schema.json and every cross-reference.
// Usage: node tools/validate.js [--warn]    (--warn also lists soft issues: unused part types, thin buildings)
const SDG = require('../core');
const F = require('../lib/fsdata');

const ds = F.load();
const problems = [...ds.loadProblems, ...SDG.schema.validateDataset(ds)];
problems.forEach(p => console.log(`✗ ${p.coll}/${p.id}  ${p.path} ${p.msg}`));

if (process.argv.includes('--warn')) {
  const ctx = SDG.db.open(F.plain(ds));
  const used = new Set();
  ds.devices.forEach(d => { const r = ctx.resolve(d.id); (r ? r.comps : []).forEach(c => used.add(c.fn)); });
  ds.parts.filter(p => !used.has(p.id) && !p.deprecated).forEach(p => console.log(`! parts/${p.id}  no device or board contains it, so searches for it find nothing`));
  const perB = {};
  ds.devices.forEach(d => (d.buildings || []).forEach(b => (perB[b.b] = (perB[b.b] || 0) + 1)));
  ds.buildings.filter(b => (perB[b.id] || 0) < 3).forEach(b => console.log(`! buildings/${b.id}  only ${perB[b.id] || 0} device types point here`));
  ['devices', 'boards', 'models'].forEach(coll => (ds[coll] || []).forEach(rec => (rec.comps || []).forEach(c => {
    const said = SDG.specs.parse(c.spec);
    SDG.specs.KEYS.forEach(k => {
      if (c[k] == null || said[k] == null) return;
      const [a, b] = [c[k], said[k]].map(x => (Array.isArray(x) ? x : [x, x]));
      if (a[1] < b[0] * 0.9 || a[0] > b[1] * 1.1) console.log(`! ${coll}/${rec.id}  ${c.key}: ${k} is ${JSON.stringify(c[k])} but the spec says ${JSON.stringify(said[k])}`);
    });
  })));
  const guided = new Set();
  ds.guides.forEach(g => (g.devices || []).forEach(d => guided.add(d)));
  console.log(`  ${ds.devices.filter(d => !d.abstract && !guided.has(d.id)).length} devices have no guide yet`);
}

const s = SDG.db.open(F.plain(ds)).stats();
console.log(problems.length ? `\n${problems.length} problem${problems.length > 1 ? 's' : ''}` :
  `OK: ${s.parts} part types, ${s.devices} devices, ${s.boards} boards, ${s.buildings} buildings, ${s.models} models, ${s.jobs} jobs, ${s.hazards} hazards, ${s.guides} guides`);
process.exit(problems.length ? 1 : 0);

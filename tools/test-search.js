// Runs the real search and ranking on data/ for quick tuning.
// Usage: node tools/test-search.js "555 timer" "keep food cold"
//        node tools/test-search.js --months 12 --tools screwdriver,pliers --subs "battery"
const SDG = require('../core');
const F = require('../lib/fsdata');

const args = process.argv.slice(2);
const opts = {};
const queries = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--months') opts.months = +args[++i];
  else if (args[i] === '--tools') opts.tools = args[++i].split(',');
  else if (args[i] === '--kg') opts.maxKg = +args[++i];
  else if (args[i] === '--subs') opts.subs = true;
  else if (args[i] === '--json') opts.json = true;
  else queries.push(args[i]);
}
if (!queries.length) queries.push('battery', '12v motor', '555 timer', 'stepdown', 'fuse');

const ctx = SDG.db.open(F.plain(F.load()));
for (const q of queries) {
  const out = SDG.search.search(ctx, q, opts);
  if (opts.json) { console.log(JSON.stringify(SDG.search.summarize(ctx, out, 6), null, 1)); continue; }
  const on = [...out.sel].filter(([, v]) => v.on).map(([k, v]) => k + (v.via !== 'direct' ? `(${v.via})` : ''));
  console.log(`\n${q} -> ${on.join(', ') || 'nothing'}${out.jobs.length ? `   [job: ${out.jobs[0].name}]` : ''}`);
  if (!out.ranked.res.length) { console.log('  no results'); continue; }
  out.ranked.res.slice(0, 6).forEach(x => console.log('  ' + String(Math.round(x.best.s)).padStart(3) + '  ' + x.cat.name + (x.best.comp.board ? '  [' + x.best.comp.board + ']' : '')));
  console.log('  where: ' + out.ranked.blds.slice(0, 4).map(a => a.bt.name + ' ' + Math.round(a.n)).join('; '));
  if (out.guides.length) console.log('  guides: ' + out.guides.slice(0, 3).map(g => g.title).join('; '));
}

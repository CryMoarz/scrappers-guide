// Exports precomputed lookups for devices too small to run a browser or Node: microcontroller
// handhelds with an SD card and a small screen, e-ink readers, or a shell script on a router.
// Everything is plain UTF-8 text, tab-separated, one lookup per file, so it can be read line
// by line with a few KB of RAM and no JSON parser.
//
//   dist/tiny/README.txt         the format
//   dist/tiny/words.tsv          search word → part type ids (sorted, for binary search)
//   dist/tiny/parts.tsv          id, name, group, demand, hazard ids
//   dist/tiny/p/<part>.tsv       best devices for that part: score, device id, device name, spec, where
//   dist/tiny/b/<part>.tsv       best building types for that part: score, building, likely left
//   dist/tiny/d/<device>.tsv     what's inside a device: part id, spec, where, difficulty, overlooked
//   dist/tiny/h/<hazard>.txt     the safety card
//   dist/tiny/j/<job>.txt        a job: approach and part types
// Usage: node tools/export-tiny.js [--months N]
const fs = require('fs');
const path = require('path');
const SDG = require('../core');
const F = require('../lib/fsdata');

const months = process.argv.includes('--months') ? +process.argv[process.argv.indexOf('--months') + 1] : undefined;
const OUT = path.join(F.ROOT, 'dist', 'tiny');
const ctx = SDG.db.open(F.plain(F.load()));
const ds = ctx.ds;
const clean = s => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
const row = a => a.map(clean).join('\t');
fs.rmSync(OUT, { recursive: true, force: true });
const write = (rel, lines) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, (Array.isArray(lines) ? lines.join('\n') : lines) + '\n'); };

const words = new Map();
const addWord = (w, id) => { w = clean(w).toLowerCase(); if (!w) return; if (!words.has(w)) words.set(w, new Set()); words.get(w).add(id); };
ds.parts.filter(p => !p.deprecated).forEach(p => { addWord(p.name, p.id); (p.keywords || []).forEach(k => addWord(k, p.id)); });
ds.jobs.forEach(j => (j.keywords || []).forEach(k => addWord(k, 'job:' + j.id)));
write('words.tsv', [...words].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([w, ids]) => row([w, [...ids].join(',')])));
write('parts.tsv', ds.parts.filter(p => !p.deprecated).map(p => row([p.id, p.name, p.group, p.demand, (p.hazards || []).join(',')])));

ds.parts.filter(p => !p.deprecated).forEach(p => {
  const r = SDG.search.rank(ctx, new Map([[p.id, { via: 'direct', on: true }]]), '', { months });
  if (!r.res.length) return;
  write(`p/${p.id}.tsv`, r.res.slice(0, 25).map(x => row([Math.round(x.best.s), x.cat.id, x.cat.name, x.best.comp.spec, x.best.comp.loc])));
  write(`b/${p.id}.tsv`, r.blds.slice(0, 12).map(a => row([Math.round(a.n), a.bt.name, SDG.search.leftLabel(a.remain)])));
});
ds.devices.filter(d => !d.abstract).forEach(d => {
  const r = ctx.resolve(d.id);
  write(`d/${d.id}.tsv`, [row(['#', r.name, `tools: ${(r.tools || []).map(ctx.toolLabel).join(', ')}`, `hazards: ${(r.hazards || []).map(h => ctx.hazard(h).label).join(', ')}`]), ...r.comps.map(c => row([c.fn, c.spec, c.loc, c.ext, c.obs]))]);
});
ds.hazards.forEach(h => write(`h/${h.id}.txt`, [`${h.label} (severity ${h.severity}/5)`, h.summary, ...['signs', 'do', 'dont', 'ppe', 'firstAid'].flatMap(k => (h[k] || []).length ? ['', k.toUpperCase(), ...h[k].map(x => '- ' + x)] : [])]));
ds.jobs.forEach(j => write(`j/${j.id}.txt`, [j.name, j.summary, '', ...j.parts.map(p => `- ${p.fn}${p.why ? ': ' + p.why : ''}`), '', ...(j.tips || []).map(t => '* ' + t)]));
write('README.txt', fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 16).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + `\nBuilt ${new Date().toISOString().slice(0, 10)}${months != null ? `, ranked for ${months} months after collapse` : ''}.`);

let files = 0, bytes = 0;
const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } });
walk(OUT);
console.log(`Wrote ${files} files to dist/tiny/ (${Math.round(bytes / 1024)} KB)`);

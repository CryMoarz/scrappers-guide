// Exports the data as readable text, for people and for machines that index documents:
//   dist/text/<collection>/<id>.md   one Markdown file per record (local AI document search, wikis, Kiwix-style readers)
//   dist/field-guide.md              everything worth printing, in one file
//   dist/field-guide.html            the same, styled for paper: the edition for when the batteries die
// Usage: node tools/export-text.js
const fs = require('fs');
const path = require('path');
const SDG = require('../core');
const F = require('../lib/fsdata');

const OUT = path.join(F.ROOT, 'dist');
const ctx = SDG.db.open(F.plain(F.load()));
const ds = ctx.ds;
const md = coll => r => SDG.text.recordMarkdown(ctx, coll, r);
const [device, part, guide, hazard, job, building, model] = ['devices', 'parts', 'guides', 'hazards', 'jobs', 'buildings', 'models'].map(md);

fs.rmSync(path.join(OUT, 'text'), { recursive: true, force: true });
const write = (rel, text) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
let n = 0;
ds.devices.filter(d => !d.abstract).forEach(d => { write(`text/devices/${d.id}.md`, device(d)); n++; });
ds.parts.forEach(f => { write(`text/parts/${f.id}.md`, part(f)); n++; });
ds.guides.forEach(g => { write(`text/guides/${g.id}.md`, guide(g)); n++; });
ds.hazards.forEach(h => { write(`text/hazards/${h.id}.md`, hazard(h)); n++; });
ds.jobs.forEach(j => { write(`text/jobs/${j.id}.md`, job(j)); n++; });
ds.buildings.forEach(b => { write(`text/buildings/${b.id}.md`, building(b)); n++; });
ds.models.forEach(m => { write(`text/models/${m.id}.md`, model(m)); n++; });

// The printable edition: safety first, then jobs, guides, part types, devices and logged models.
const by = (a, k) => a.slice().sort((x, y) => String(x[k]).localeCompare(String(y[k])));
const book = [
  `# Scrapper’s Digital Guide to the Apocalypse: field edition\n\nPrinted ${new Date().toISOString().slice(0, 10)} from data version ${(F.load().meta || {}).seq || 0}. Devices are generic: what most units of each kind contain, a best guess unless a part is marked documented or verified. Salvage can kill: read the hazards first.\n`,
  '# Part 1: Hazards', ...by(ds.hazards, 'label').sort((a, b) => b.severity - a.severity).map(hazard),
  '# Part 2: Jobs', ...by(ds.jobs, 'name').map(job),
  '# Part 3: Guides, from fire to industry',
  ...(ds.vocab.eras || []).flatMap((era, i) => {
    const inEra = by(ds.guides.filter(g => g.tree && g.tree.era === i + 1), 'title');
    return inEra.length ? [`## Era ${i + 1}: ${era}`, ...inEra.map(g => SDG.text.guideMarkdown(ctx, g, 3))] : [];
  }),
  ...by(ds.guides.filter(g => !g.tree), 'title').map(guide),
  '# Part 4: Part types', ...by(ds.parts, 'name').map(part),
  '# Part 5: Devices', ...by(ds.devices.filter(d => !d.abstract), 'name').map(device),
  ...(ds.models.length ? ['# Part 6: Logged models', ...ds.models.slice().sort((a, b) => ctx.modelName(a).localeCompare(ctx.modelName(b))).map(model)] : []),
].map(s => s.replace(/^# /gm, '## ').replace(/^## (Part \d|Scrapper)/m, '# $1')).join('\n\n');
write('field-guide.md', book);

const MD = new Function(fs.readFileSync(path.join(F.ROOT, 'app/src/md.js'), 'utf8') + ';return MD;')();
write('field-guide.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Scrapper’s Guide: field edition</title>
<style>body{font:11pt/1.45 Georgia,"Times New Roman",serif;max-width:46rem;margin:0 auto;padding:16px;color:#111;background:#fff}h1{font:700 1.6rem Arial,sans-serif;page-break-before:always;border-bottom:3px solid #111}h1:first-of-type{page-break-before:avoid}h2{font:700 1.2rem Arial,sans-serif;margin-top:1.6em;page-break-after:avoid}table{border-collapse:collapse;width:100%;font-size:9pt}th,td{border:1px solid #999;padding:3px 5px;text-align:left;vertical-align:top}strong{font-weight:700}@page{margin:16mm}</style></head><body>${MD.render(book)}</body></html>`);

console.log(`Wrote ${n} Markdown files to dist/text/, plus dist/field-guide.md and dist/field-guide.html (${Math.round(fs.statSync(path.join(OUT, 'field-guide.html')).size / 1024)} KB)`);

// Research pipeline for model-level data from public sources (FCC internal photos, service
// manuals, parts lists, teardowns). Drafts land in data/ at once as likely, so the guide fills
// fast; the fact-check then replaces each with its checked, documented version, or takes it out.
//
//   research/inbox/<id>.json      what research agents found (a models record, every claim with a link)
//   research/verified/<id>.json   what survived a fact-check against those links
//   research/rejected/<id>.json   what didn't, with reasons
//
//   node tools/research.js keys <device>     the device's part keys, for writing overrides
//   node tools/research.js check [folder|file] validate records in research/inbox (or a folder or one file)
//   node tools/research.js land [folder]     put drafts (research/inbox) that pass the checks into data/models
//                                            now, every documented claim as likely, marked not yet fact-checked
//   node tools/research.js import [--update] copy research/verified into data/models, replacing landed drafts,
//                                            and take out drafts that were rejected (--update replaces checked ones too)
//   node tools/research.js pdf <url> [5-9] [--save dir]  print a PDF as text (needs pdftotext); --save keeps
//                                            the PDF, so scanned pages can be looked at directly
//   node tools/research.js stats             claims found, kept and removed so far
const fs = require('fs');
const path = require('path');
const SDG = require('../core');
const F = require('../lib/fsdata');

const R = path.join(F.ROOT, 'research');
const dir = n => path.join(R, n);
const list = n => { try { return fs.readdirSync(dir(n)).filter(f => f.endsWith('.json')).map(f => path.join(dir(n), f)); } catch (e) { return []; } };
const [cmd, arg] = process.argv.slice(2);
const ctx = SDG.db.open(F.plain(F.load()));
const { LANDED, isLanded } = require('../lib/research');
const landed = id => isLanded(ctx.get('models', id));

// Schema, references, and the research rules: every confirmed part has a link, links appear in sources.
function checkRecord(rec, allowUpdate) {
  const problems = [];
  const v = SDG.schema.validateRecord('models', rec);
  v.errors.forEach(e => problems.push(`${e.path} ${e.msg}`));
  const dev = ctx.resolve(rec.device);
  if (!dev) { problems.push(`device “${rec.device}” doesn't exist`); return problems; }
  const keys = new Set(dev.comps.map(c => c.key));
  const urls = new Set((rec.sources || []).map(s => s.url).filter(Boolean));
  if (!urls.size) problems.push('needs at least one source with a url');
  (rec.comps || []).forEach((c, i) => {
    if (!keys.has(c.key) && !c.fn) problems.push(`comps[${i}] key “${c.key}” isn't a part of ${rec.device}; extra parts need fn, spec, qty, ext, obs`);
    if (c.conf === 'verified') problems.push(`comps[${i}] says verified: research can only be documented`);
    if (c.source && !urls.has(c.source)) problems.push(`comps[${i}] source isn't listed in sources`);
  });
  if (!allowUpdate && ctx.get('models', rec.id)) problems.push(`a model “${rec.id}” already exists (use import --update after a re-check)`);
  return problems;
}

if (cmd === 'keys') {
  const r = ctx.resolve(arg);
  if (!r) { console.log('No such device. Devices: ' + ctx.ds.devices.map(d => d.id).join(', ')); process.exit(1); }
  console.log(`${r.name} (${r.id})`);
  r.comps.forEach(c => console.log(`  ${c.key.padEnd(34)} ${c.fn.padEnd(18)} ${c.spec}`));
} else if (cmd === 'check') {
  let bad = 0;
  const files = arg && arg.endsWith('.json') ? [path.resolve(arg)] : list(arg || 'inbox');
  files.forEach(f => {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(`✗ ${path.basename(f)}: not JSON (${e.message})`); bad++; return; }
    const p = checkRecord(rec);
    if (rec.id + '.json' !== path.basename(f)) p.push('file name must be <id>.json');
    if (p.length) { bad++; console.log(`✗ ${path.basename(f)}\n    ${p.join('\n    ')}`); } else console.log(`✓ ${path.basename(f)}: ${(rec.comps || []).length} parts, ${(rec.sources || []).length} sources`);
  });
  console.log(`${files.length - bad} of ${files.length} OK`);
  process.exit(bad ? 1 : 0);
} else if (cmd === 'land') {
  // A draft goes in as it stands, but no claim in it says more than likely until it is checked.
  let n = 0;
  list(arg || 'inbox').forEach(f => {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (ctx.get('models', rec.id)) return;
    const p = checkRecord(rec);
    if (p.length) { console.log(`skip ${rec.id}: ${p.join('; ')}`); return; }
    (rec.comps || []).forEach(c => { if (c.conf === 'documented') c.conf = 'likely'; });
    const res = rec.research || {};
    delete res.checked;
    res.method = [LANDED, ...(res.method || []).filter(m => m !== LANDED)];
    rec.research = res;
    F.writeRecord(F.DATA, 'models', rec);
    n++;
  });
  console.log(`Landed ${n} drafts in data/models as likely. Run node tools/validate.js.`);
} else if (cmd === 'import') {
  let n = 0, out = 0;
  list('verified').forEach(f => {
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    const p = checkRecord(rec, process.argv.includes('--update') || landed(rec.id));
    if (p.length) { console.log(`skip ${rec.id}: ${p.join('; ')}`); return; }
    F.writeRecord(F.DATA, 'models', rec);
    n++;
  });
  // A draft that failed its fact-check comes back out.
  list('rejected').forEach(f => { const id = path.basename(f, '.json'); if (landed(id) && !fs.existsSync(path.join(dir('verified'), id + '.json'))) { F.deleteRecord(F.DATA, 'models', id); out++; } });
  console.log(`Imported ${n} documented models into data/models${out ? `, took out ${out} rejected drafts` : ''}. Run node tools/validate.js.`);
} else if (cmd === 'pdf') {
  // Service manuals and datasheets are PDFs that web fetchers can't read; this prints their text.
  // Needs pdftotext (poppler-utils). Downloads go to their own folder and are only ever read as text.
  (async () => {
    const os = require('os');
    const { execFileSync } = require('child_process');
    if (!/^https?:\/\//.test(arg || '')) throw new Error('Usage: node tools/research.js pdf <url> [page from-to, e.g. 30-35]');
    const res = await fetch(arg, { headers: { 'User-Agent': 'scrappers-guide-research/1 (+offline salvage database)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: skip this source`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Not a PDF (maybe a bot check or a login page): skip this source');
    const saveAt = process.argv.indexOf('--save');
    const d = saveAt > 0 ? path.resolve(process.argv[saveAt + 1] || '.') : fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-pdf-'));
    fs.mkdirSync(d, { recursive: true });
    const file = path.join(d, 'doc.pdf');
    fs.writeFileSync(file, buf);
    const range = (/^\d/.test(process.argv[4] || '') ? process.argv[4] : '').split('-').map(Number);
    const args = ['-q', '-layout', '-enc', 'UTF-8'];
    if (range[0]) args.push('-f', String(range[0]), '-l', String(range[1] || range[0]));
    const text = execFileSync('pdftotext', [...args, file, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    if (saveAt > 0) console.error(`Saved ${file}`); else fs.rmSync(d, { recursive: true, force: true });
    const pages = text.split('\f');
    pages.forEach((p, i) => { if (p.trim()) console.log(`\n===== page ${(range[0] || 1) + i} =====\n${p.trim()}`); });
  })().catch(e => { console.error(e.message); process.exit(1); });
} else if (cmd === 'stats') {
  const claims = n => list(n).reduce((s, f) => s + (JSON.parse(fs.readFileSync(f, 'utf8')).comps || []).length, 0);
  console.log(`inbox ${list('inbox').length} records / ${claims('inbox')} part claims; verified ${list('verified').length} / ${claims('verified')}; rejected ${list('rejected').length}`);
} else {
  const head = [];
  for (const l of fs.readFileSync(__filename, 'utf8').split('\n')) { if (!l.startsWith('//')) break; head.push(l.slice(3)); }
  console.log(head.join('\n'));
}

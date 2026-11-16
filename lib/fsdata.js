// Reads and writes the canonical data folder: one JSON file per record, laid out so that
// diffs stay small and readable (one part entry or step per line).
const fs = require('fs');
const path = require('path');
const SDG = require('../core');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function keyOrder(coll) { return Object.keys(SDG.schema.schemaFor(coll).properties || {}); }

// Own keys only: an inherited field (a polluted prototype) must never reach the disk.
function ordered(obj, order) {
  const out = {}, keys = Object.keys(obj).filter(k => !SDG.util.BAD_KEYS.includes(k) && obj[k] !== undefined);
  order.forEach(k => { if (keys.includes(k)) out[k] = obj[k]; });
  keys.forEach(k => { if (!SDG.util.has(out, k)) out[k] = obj[k]; });
  return out;
}

// Top-level keys one per line; arrays of objects one object per line; everything else inline.
function format(coll, rec) {
  const r = ordered(rec, keyOrder(coll));
  const lines = Object.keys(r).map(k => {
    const v = r[k];
    if (Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      return `  ${JSON.stringify(k)}: [\n${v.map(x => '    ' + JSON.stringify(x)).join(',\n')}\n  ]`;
    }
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return '{\n' + lines.join(',\n') + '\n}\n';
}

// Ids reach here from the network (proposals, upstream feeds), so they must never leave dir/coll.
const ID = /^[a-z0-9][a-z0-9_]*$/;
function fileFor(dir, coll, id) {
  if (!SDG.db.COLLS.includes(coll)) throw new Error(`Unknown collection: ${String(coll).slice(0, 40)}`);
  if (typeof id !== 'string' || !ID.test(id)) throw new Error(`Not a valid record id: ${String(id).slice(0, 60)}`);
  const base = path.resolve(dir || DATA, coll), file = path.resolve(base, id + '.json');
  if (path.dirname(file) !== base) throw new Error('Record path escapes the data folder');
  return file;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`${path.relative(ROOT, file)}: ${e.message}`);
  }
}

function load(dir) {
  dir = dir || DATA;
  const ds = { vocab: readJSON(path.join(dir, 'vocab.json'), { tools: {}, partGroups: [], deviceGroups: [] }) };
  const problems = [];
  SDG.db.COLLS.forEach(coll => {
    const cdir = path.join(dir, coll);
    let files = [];
    try { files = fs.readdirSync(cdir).filter(f => f.endsWith('.json')).sort(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    ds[coll] = [];
    files.forEach(f => {
      try {
        const rec = readJSON(path.join(cdir, f));
        if (rec.id !== f.slice(0, -5)) problems.push({ coll, id: rec.id, path: 'id', msg: `doesn't match its file name ${f}` });
        ds[coll].push(rec);
      } catch (e) { problems.push({ coll, id: f, path: '', msg: e.message }); }
    });
  });
  ds.meta = readJSON(path.join(dir, 'meta.json'), { seq: 0 });
  Object.defineProperty(ds, 'loadProblems', { value: problems, enumerable: false });
  return ds;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function writeRecord(dir, coll, rec) { writeAtomic(fileFor(dir || DATA, coll, rec.id), format(coll, rec)); }
function deleteRecord(dir, coll, id) { try { fs.unlinkSync(fileFor(dir || DATA, coll, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
function writeMeta(dir, meta) { writeAtomic(path.join(dir || DATA, 'meta.json'), JSON.stringify(meta, null, 2) + '\n'); }
function writeVocab(dir, vocab) { writeAtomic(path.join(dir || DATA, 'vocab.json'), JSON.stringify(vocab, null, 2) + '\n'); }

// A container ships its data inside the image (`seedDir`). Copy it in on first start, and again
// when an update brings different records, unless this copy has changed since it was last seeded
// (synced from a hub or moderated here): then it keeps its own. meta.json stays, so the hub's
// sequence carries on and it logs what changed when it starts.
function seed(seedDir, dataDir) {
  const files = dir => {
    const out = [];
    (function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r); else if (r !== 'meta.json') out.push(r);
      }
    })(dir, '');
    return out.sort();
  };
  const hash = dir => { const h = require('crypto').createHash('sha256'); for (const f of files(dir)) h.update(f + '\0').update(fs.readFileSync(path.join(dir, f))); return h.digest('hex'); };
  const mark = path.join(dataDir, '.seeded');
  const want = hash(seedDir);
  const fresh = !fs.existsSync(path.join(dataDir, 'meta.json'));
  if (!fresh) {
    const have = hash(dataDir);
    let last = null;
    try { last = fs.readFileSync(mark, 'utf8').trim(); } catch (e) { /* never seeded */ }
    if (have === want) { if (last !== want) fs.writeFileSync(mark, want + '\n'); return 'current'; }
    if (have !== last) return 'kept';
  }
  for (const e of fs.existsSync(dataDir) ? fs.readdirSync(dataDir, { withFileTypes: true }) : []) {
    if (e.isDirectory() && !e.name.startsWith('.')) fs.rmSync(path.join(dataDir, e.name), { recursive: true, force: true });
  }
  for (const f of files(seedDir)) {
    fs.mkdirSync(path.dirname(path.join(dataDir, f)), { recursive: true });
    fs.copyFileSync(path.join(seedDir, f), path.join(dataDir, f));
  }
  if (fresh) fs.copyFileSync(path.join(seedDir, 'meta.json'), path.join(dataDir, 'meta.json'));
  fs.writeFileSync(mark, want + '\n');
  return fresh ? 'copied' : 'updated';
}

// The dataset without meta, as releases and the app use it.
function plain(ds) {
  const out = { vocab: ds.vocab };
  SDG.db.COLLS.forEach(c => (out[c] = ds[c]));
  return out;
}

module.exports = { ROOT, DATA, load, seed, format, writeRecord, deleteRecord, writeMeta, writeVocab, writeAtomic, readJSON, fileFor, plain };

// Move data by hand when there's no network path: USB sticks, caravans meeting, radio links.
//   node tools/sync.js pull <hub> [out.json]     save a hub's full catch-up bundle to a file
//   node tools/sync.js push <hub> <bundle.json>  hand a bundle (proposals, comments, observations) to a hub
//   node tools/sync.js inspect <bundle.json>     what's in a bundle, and whether signatures check out
//   node tools/sync.js release <hub> [out.json]  save a hub's signed release (the full dataset)
// Bundles carry only signed items, so whoever carries them can't alter them.
const fs = require('fs');
const zlib = require('zlib');
const SDG = require('../core');

const [cmd, a, b] = process.argv.slice(2);
const read = f => { const buf = fs.readFileSync(f); return SDG.util.parse((f.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8')); };
const write = (f, obj) => { const s = JSON.stringify(obj); fs.writeFileSync(f, f.endsWith('.gz') ? zlib.gzipSync(s) : s); console.log(`Saved ${f} (${Math.round(fs.statSync(f).size / 1024)} KB)`); };
async function get(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }

(async () => {
  const hub = String(a || '').replace(/\/+$/, '');
  if (cmd === 'pull') write(b || 'sdg-bundle.json.gz', await get(hub + '/api/v1/bundle'));
  else if (cmd === 'release') write(b || 'sdg-release.json.gz', await get(hub + '/api/v1/release'));
  else if (cmd === 'push') {
    const r = await fetch(hub + '/api/v1/bundle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(read(b)) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    ['proposals', 'comments', 'observations'].forEach(k => {
      const list = out[k] || [];
      if (!list.length) return;
      console.log(`${k}: ${list.filter(x => x.ok).length} taken, ${list.filter(x => !x.ok).length} refused`);
      list.filter(x => !x.ok).forEach(x => console.log(`  ${x.id}: ${x.error}`));
    });
  } else if (cmd === 'inspect') {
    const p = SDG.changes.parseBundle(read(a));
    if (p.release) {
      const v = await SDG.changes.verifyRelease(p.release, []);
      console.log(`Release seq ${p.release.seq}, ${p.release.created}: hash ${v.hashOk ? 'ok' : 'BAD'}, signature ${v.signed ? 'valid' : 'missing or bad'}${v.key ? ' (key ' + v.key.slice(0, 12) + '…)' : ''}`);
    }
    for (const k of ['proposals', 'comments', 'observations']) {
      if (!p[k] || !p[k].length) continue;
      const v = await SDG.changes.verifyItems(p[k], k);
      console.log(`${k}: ${v.ok.length} valid, ${v.bad.length} bad`);
      v.bad.forEach(x => console.log(`  ${x.id}: ${x.why}`));
    }
    if (p.ledger && p.ledger.length) console.log(`ledger: ${p.ledger.length} accepted changes, up to seq ${p.ledger[p.ledger.length - 1].seq}`);
  } else console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 7).map(l => l.slice(3)).join('\n'));
})().catch(e => { console.error(e.message); process.exit(1); });

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
const read = f => {
  const buf = fs.readFileSync(f), text = (f.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
  // A parser's error quotes the file, which anyone could have written: escaped, on one line.
  try { return SDG.util.parse(text); } catch (e) { throw new Error(`${f} is not a JSON file: ${safe(e.message)}`); }
};
const write = (f, obj) => { const s = JSON.stringify(obj); fs.writeFileSync(f, f.endsWith('.gz') ? zlib.gzipSync(s) : s); console.log(`Saved ${f} (${Math.round(fs.statSync(f).size / 1024)} KB)`); };
async function get(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }
// What a hub or a bundle says is someone else's words: shown as text, never as terminal commands.
// Control characters (which can move the cursor, rewrite or hide lines) and bidi overrides
// (which can reorder what you read) become visible \u escapes, line breaks included.
const safe = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

(async () => {
  const hub = String(a || '').replace(/\/+$/, '');
  if (cmd === 'pull') write(b || 'sdg-bundle.json.gz', await get(hub + '/api/v1/bundle'));
  else if (cmd === 'release') write(b || 'sdg-release.json.gz', await get(hub + '/api/v1/release'));
  else if (cmd === 'push') {
    const r = await fetch(hub + '/api/v1/bundle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(read(b)) });
    const out = await r.json().catch(() => { throw new Error(`HTTP ${r.status}: the hub's answer is not JSON`); });
    if (!r.ok) throw new Error(safe(out.error) || `HTTP ${r.status}`);
    ['proposals', 'comments', 'observations'].forEach(k => {
      const list = Array.isArray(out[k]) ? out[k] : [];
      if (!list.length) return;
      console.log(`${k}: ${list.filter(x => x.ok).length} taken, ${list.filter(x => !x.ok).length} refused`);
      list.filter(x => !x.ok).forEach(x => console.log(`  ${safe(x.id)}: ${safe(x.error)}`));
    });
  } else if (cmd === 'inspect') {
    const p = SDG.changes.parseBundle(read(a));
    // The verdicts first, then what the file says about itself, escaped.
    if (p.release) {
      const v = await SDG.changes.verifyRelease(p.release, []);
      console.log(`Release: hash ${v.hashOk ? 'ok' : 'BAD'}, signature ${v.signed ? 'valid' : 'missing or bad'}${v.key ? ' (key ' + safe(String(v.key).slice(0, 12)) + '…)' : ''}; it says seq ${safe(p.release.seq)}, made ${safe(p.release.created)}`);
    }
    for (const k of ['proposals', 'comments', 'observations']) {
      if (!p[k] || !p[k].length) continue;
      const v = await SDG.changes.verifyItems(p[k], k);
      console.log(`${k}: ${v.ok.length} valid, ${v.bad.length} bad`);
      v.bad.forEach(x => console.log(`  ${safe(x.id)}: ${safe(x.why)}`));
    }
    if (Array.isArray(p.ledger) && p.ledger.length) console.log(`ledger: ${p.ledger.length} accepted changes, up to seq ${safe((p.ledger[p.ledger.length - 1] || {}).seq)}`);
  } else console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 7).map(l => l.slice(3)).join('\n'));
})().catch(e => { console.error(e.message.split('\n').map(safe).join('\n')); process.exit(1); });

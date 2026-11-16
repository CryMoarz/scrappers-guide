// Connect the guide to a Project NOMAD box on your network.
//   node tools/nomad.js check http://192.168.1.50:8080        what's reachable: Command Center, Kiwix, maps, AI knowledge base
//   node tools/nomad.js kb http://192.168.1.50:8080 [tag]     put the guide in NOMAD's AI knowledge base, replacing earlier copies (tag "scrappers-guide")
// NOMAD's AI answers from its knowledge base, so after `kb` its chat can answer from the guide.
// A hub or node does this by itself with --nomad and --nomad-kb (see docs/NOMAD.md).
const fs = require('fs');
const path = require('path');
const F = require('../lib/fsdata');
const { catalogBooks, syncKnowledge } = require('../server/nomad');
const SDG = require('../core');

const [cmd, base, tagArg] = process.argv.slice(2);
const nomad = String(base || '').replace(/\/+$/, '');

async function get(url, asText) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15e3);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return asText ? r.text() : r.json(); } finally { clearTimeout(t); }
}

(async () => {
  if (!/^https?:\/\//.test(nomad) || !['check', 'kb'].includes(cmd)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 5).map(l => l.slice(3)).join('\n'));
    process.exit(1);
  }
  const kiwix = (() => { const u = new URL(nomad); u.port = '8090'; return u.origin; })();
  if (cmd === 'check') {
    const show = async (label, fn) => { try { console.log(`✓ ${label}: ${await fn()}`); } catch (e) { console.log(`✗ ${label}: ${e.message}`); } };
    await show('Command Center', async () => { await get(nomad + '/api/health', true); return nomad; });
    await show('Kiwix library', async () => {
      const installed = catalogBooks(await get(kiwix + '/catalog/v2/entries?count=-1', true));
      const books = SDG.text.matchBooks(F.readJSON(path.join(F.DATA, 'vocab.json')).libraries, installed);
      return `${kiwix}, ${installed.length} books; linked: ${Object.entries(books).map(([k, v]) => `${k} → ${v}`).join(', ') || 'none of ours'}`;
    });
    await show('Map markers', async () => { const m = await get(nomad + '/api/maps/markers'); return `${Array.isArray(m) ? m.length : '?'} markers`; });
    await show('AI knowledge base', async () => { const c = await get(nomad + '/api/rag/collections'); return JSON.stringify(c).slice(0, 120); });
    return;
  }
  // kb: one Markdown document per collection, for NOMAD's AI to search.
  const ctx = SDG.db.open(F.plain(F.load()));
  const tag = tagArg || 'scrappers-guide';
  const done = await syncKnowledge(nomad, ctx, { collection: tag, onUpload: d => console.log(`✓ ${d.name} (${Math.round(d.text.length / 1024)} KB) queued for embedding`) });
  console.log(`\nIn NOMAD's knowledge base under "${tag}"${done.removed ? `, replacing ${done.removed} earlier file${done.removed > 1 ? 's' : ''}` : ''}. Its AI can answer from the guide once embedding finishes.`);
})().catch(e => { console.error(e.message); process.exit(1); });

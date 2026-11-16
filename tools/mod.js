// Moderate a hub from the command line (the app's Review tab does the same).
//   node tools/mod.js <hub> <key> pending
//   node tools/mod.js <hub> <key> show <proposal>
//   node tools/mod.js <hub> <key> accept <proposal> [note] [--force]
//   node tools/mod.js <hub> <key> reject <proposal> <note>
//   node tools/mod.js <hub> <key> role <public key> <banned|contributor|trusted|moderator>
//   node tools/mod.js <hub> <key> hide <comment>
const fs = require('fs');
const SDG = require('../core');

const [hubArg, keyFile, cmd, id, ...rest] = process.argv.slice(2);
const hub = String(hubArg || '').replace(/\/+$/, '');

async function api(path, body) {
  const res = await fetch(hub + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const out = await res.json();
  if (!res.ok) throw new Error(`${out.error || res.status}${out.errors ? '\n' + out.errors.map(e => `  ${e.coll}/${e.id} ${e.path} ${e.msg}`).join('\n') : ''}`);
  return out;
}

(async () => {
  if (!hub || !keyFile || !cmd) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).map(l => l.slice(3)).join('\n')); return; }
  const me = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  // Hubs take a moderation message only within minutes of `created`, and only once.
  const signed = o => SDG.sign.sign(Object.assign({ created: SDG.util.now() }, o), me);
  if (cmd === 'pending') {
    const list = await api('/api/v1/proposals?status=pending');
    if (!list.length) return console.log('Nothing waiting.');
    list.forEach(p => console.log(`${p.id}  ${p.op.padEnd(6)} ${p.coll}/${p.rid}${p.stale ? '  (stale)' : ''}${p.source === 'ai' ? '  [AI]' : ''}\n    by ${(p.author && p.author.name) || 'anonymous'}: ${p.reason || ''}`));
  } else if (cmd === 'show') {
    const d = await api('/api/v1/proposals/' + encodeURIComponent(id));
    console.log(`${d.proposal.op} ${d.proposal.coll}/${d.proposal.rid}  status ${d.proposal.status}${d.stale ? '  STALE: the record changed since' : ''}\nReason: ${d.proposal.reason || ''}`);
    d.diff.forEach(x => console.log(`  ${x.path}\n    - ${JSON.stringify(x.before)}\n    + ${JSON.stringify(x.after)}`));
    d.problems.forEach(p => console.log(`  ✗ ${p.coll}/${p.id} ${p.path} ${p.msg}`));
  } else if (cmd === 'accept' || cmd === 'reject') {
    const note = rest.filter(x => x !== '--force').join(' ');
    console.log(await api(`/api/v1/proposals/${encodeURIComponent(id)}/review`, await signed({ action: 'review', proposal: id, decision: cmd, note, force: rest.includes('--force') || undefined })));
  } else if (cmd === 'role') {
    console.log(await api('/api/v1/roles', await signed({ action: 'set-role', key: id, role: rest[0] })));
  } else if (cmd === 'hide') {
    console.log(await api(`/api/v1/comments/${encodeURIComponent(id)}/hide`, await signed({ action: 'hide-comment', comment: id, hidden: true })));
  } else throw new Error('Unknown command ' + cmd);
})().catch(e => { console.error(e.message); process.exit(1); });

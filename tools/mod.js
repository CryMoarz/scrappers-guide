// Moderate a hub from the command line (the app's Review tab does the same).
//   node tools/mod.js <hub> <key> pending
//   node tools/mod.js <hub> <key> show <proposal>
//   node tools/mod.js <hub> <key> accept <proposal> [note] [--force]
//   node tools/mod.js <hub> <key> reject <proposal> <note>
//   node tools/mod.js <hub> <key> role <public key> <banned|contributor|trusted|moderator>
//   node tools/mod.js <hub> <key> hide <comment>
const fs = require('fs');
const util = require('util');
const SDG = require('../core');

const [hubArg, keyFile, cmd, id, ...rest] = process.argv.slice(2);
const hub = String(hubArg || '').replace(/\/+$/, '');

// Everything a hub sends is someone else's words: shown as text, never as terminal commands.
// Control characters (which can move the cursor, rewrite or hide lines) and bidi overrides
// (which can reorder what you read) become visible \u escapes, line breaks included.
const safe = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const json = v => safe(String(JSON.stringify(v)));
const show = v => safe(util.inspect(v, { depth: 4, breakLength: Infinity }));

async function api(path, body) {
  const res = await fetch(hub + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const out = await res.json().catch(() => { throw new Error(`HTTP ${res.status}: the hub's answer is not JSON`); });
  if (!res.ok) throw new Error(`${safe(out.error || res.status)}${Array.isArray(out.errors) ? '\n' + out.errors.map(e => `  ${safe(e.coll)}/${safe(e.id)} ${safe(e.path)} ${safe(e.msg)}`).join('\n') : ''}`);
  return out;
}

(async () => {
  if (!hub || !keyFile || !cmd) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).map(l => l.slice(3)).join('\n')); return; }
  const me = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  // Hubs take a moderation message only within minutes of `created`, only once, and only when it
  // names that hub's key, so it can't be replayed on another hub where this key moderates.
  const signed = async o => SDG.sign.sign(Object.assign({ created: SDG.util.now(), hub: (await api('/api/v1/info')).hubKey }, o), me);
  if (cmd === 'pending') {
    const list = await api('/api/v1/proposals?status=pending');
    if (!list.length) return console.log('Nothing waiting.');
    list.forEach(p => console.log(`${safe(p.id)}  ${safe(p.op).padEnd(6)} ${safe(p.coll)}/${safe(p.rid)}${p.stale ? '  (stale)' : ''}${p.source === 'ai' ? '  [AI]' : ''}\n    by ${safe((p.author && p.author.name) || 'anonymous')}: ${safe(p.reason)}`));
  } else if (cmd === 'show') {
    // The change is worked out here from the proposal as its author signed it (checked), not taken
    // from the hub's own summary; accepting signs a hash of exactly this proposal.
    const d = await api('/api/v1/proposals/' + encodeURIComponent(id));
    const p = SDG.changes.signedProposal(d.proposal);
    const sig = !p.sig ? 'unsigned' : (await SDG.sign.verify(p)) ? 'signature checks out' : 'SIGNATURE DOES NOT CHECK OUT: changed after its author signed it, do not accept';
    console.log(`${safe(p.op)} ${safe(p.coll)}/${safe(p.rid)}  status ${safe(d.proposal.status)}  by ${safe((p.author && p.author.name) || 'anonymous')} (${sig})\nReason: ${safe(p.reason)}`);
    // The flags come after the reason, so nothing the contributor wrote can sit below them.
    if (d.proposal.source === 'ai') console.log('AI: written by an AI tool.');
    if (d.stale) console.log('STALE: the record changed after this was proposed. Accepting (with --force) replaces the newer version.');
    SDG.util.diff(d.current || {}, p.op === 'put' ? p.data : {}).forEach(x => console.log(`  ${safe(x.path)}\n    - ${json(x.before)}\n    + ${json(x.after)}`));
    (d.problems || []).forEach(p => console.log(`  ✗ ${safe(p.coll)}/${safe(p.id)} ${safe(p.path)} ${safe(p.msg)}`));
  } else if (cmd === 'accept' || cmd === 'reject') {
    const note = rest.filter(x => x !== '--force').join(' ');
    const hash = await SDG.changes.proposalHash((await api('/api/v1/proposals/' + encodeURIComponent(id))).proposal);
    console.log(show(await api(`/api/v1/proposals/${encodeURIComponent(id)}/review`, await signed({ action: 'review', proposal: id, hash, decision: cmd, note, force: rest.includes('--force') || undefined }))));
  } else if (cmd === 'role') {
    console.log(show(await api('/api/v1/roles', await signed({ action: 'set-role', key: id, role: rest[0] }))));
  } else if (cmd === 'hide') {
    console.log(show(await api(`/api/v1/comments/${encodeURIComponent(id)}/hide`, await signed({ action: 'hide-comment', comment: id, hidden: true }))));
  } else throw new Error('Unknown command ' + safe(cmd));
})().catch(e => { console.error(e.message.split('\n').map(safe).join('\n')); process.exit(1); });

// Changes, proposals, releases and sync bundles: how data moves between devices and the hub.
//
// A release is a full signed snapshot of the moderated data. A ledger entry is one accepted
// change with a sequence number, so syncing is "give me everything after N". Proposals,
// comments and observations are signed by their authors, so any device can carry them for
// anyone else (sneakernet, caravan meetups) without being able to tamper with them.
module.exports = function (SDG) {
  const { clone, canonical, sha256hex, newId, now, enc } = SDG.util;
  const COLLS = () => SDG.db.COLLS;

  function applyChange(ds, ch) {
    if (!COLLS().includes(ch.coll)) throw new Error('Unknown collection: ' + ch.coll);
    const list = ds[ch.coll] = ds[ch.coll] || [];
    const i = list.findIndex(r => r.id === ch.rid);
    if (ch.op === 'delete') { if (i >= 0) list.splice(i, 1); return ds; }
    const rec = Object.assign(clone(ch.data), { id: ch.rid });
    if (i >= 0) list[i] = rec; else list.push(rec);
    return ds;
  }
  function overlay(base, changes) {
    const ds = clone(base);
    (changes || []).forEach(c => applyChange(ds, c));
    return ds;
  }

  function checkData(coll, rid, op, data) {
    if (!COLLS().includes(coll)) throw new Error('Unknown collection: ' + coll);
    if (!/^[a-z0-9][a-z0-9_]*$/.test(rid || '')) throw new Error('The id must be lowercase letters, digits and underscores.');
    if (op === 'put') {
      const v = SDG.schema.validateRecord(coll, Object.assign(SDG.util.own(data), { id: rid }));
      if (!v.ok) { const e = new Error('The record has problems: ' + v.errors.map(x => `${x.path} ${x.msg}`).join('; ')); e.errors = v.errors; throw e; }
    } else if (op !== 'delete') throw new Error('op must be put or delete');
  }

  async function finish(obj, identity, powBits) {
    if (powBits) obj.pow = await SDG.sign.stamp(obj, powBits);
    return identity ? SDG.sign.sign(obj, identity) : obj;
  }

  async function makeProposal(f, identity, powBits) {
    checkData(f.coll, f.rid, f.op, f.data);
    const p = {
      id: newId(), coll: f.coll, rid: f.rid, op: f.op, baseRev: f.baseRev == null ? null : f.baseRev,
      reason: f.reason || '', source: f.source || 'human', created: now(),
    };
    if (f.op === 'put') p.data = Object.assign(SDG.util.own(f.data), { id: f.rid });
    return finish(p, identity, powBits);
  }

  async function makeComment(target, body, parent, identity, powBits) {
    const c = { id: newId(), target, body: String(body || '').trim(), created: now() };
    if (parent) c.parent = parent;
    const v = SDG.schema.validate('comment', c);
    if (!v.ok) throw new Error('Comment: ' + v.errors.map(x => `${x.path} ${x.msg}`).join('; '));
    return finish(c, identity, powBits);
  }

  // Location is sensitive after a collapse: coordinates are rounded unless the user says otherwise.
  async function makeObservation(f, identity, decimals, powBits) {
    const r = x => (decimals == null ? Math.round(x * 1e4) / 1e4 : Math.round(x * Math.pow(10, decimals)) / Math.pow(10, decimals));
    const o = { id: newId(), lat: r(+f.lat), lon: r(+f.lon), status: f.status, share: f.share || 'private', created: now() };
    ['building', 'osm', 'label', 'notes'].forEach(k => { if (f[k]) o[k] = f[k]; });
    const v = SDG.schema.validate('observation', o);
    if (!v.ok) throw new Error('Observation: ' + v.errors.map(x => `${x.path} ${x.msg}`).join('; '));
    return finish(o, identity, powBits);
  }

  async function datasetHash(ds) {
    const d = {};
    ['vocab', ...COLLS()].forEach(k => { if (ds[k] !== undefined) d[k] = ds[k]; });
    return sha256hex(canonical(d));
  }
  async function makeRelease(ds, seq, name) {
    const dataset = {};
    ['vocab', ...COLLS()].forEach(k => (dataset[k] = ds[k] || (k === 'vocab' ? {} : [])));
    return { format: 'sdg-release', schema: 3, name: name || 'Scrapper’s Digital Guide', seq: seq || 0, created: now(), hash: await datasetHash(dataset), dataset };
  }
  const releaseHead = r => ({ format: r.format, schema: r.schema, name: r.name, seq: r.seq, created: r.created, hash: r.hash });
  async function signRelease(rel, identity) {
    rel.sig = { key: identity.key, value: await SDG.sign.signBytes(enc.encode(canonical(releaseHead(rel))), identity) };
    return rel;
  }
  // trusted: list of base64url public keys. Returns what was checked; never throws.
  async function verifyRelease(rel, trusted) {
    const out = { hashOk: false, signed: false, trusted: false, key: null };
    try {
      out.hashOk = (await datasetHash(rel.dataset)) === rel.hash;
      if (rel.sig && rel.sig.key) {
        out.key = rel.sig.key;
        out.signed = await SDG.sign.verifyBytes(enc.encode(canonical(releaseHead(rel))), rel.sig.key, rel.sig.value);
        out.trusted = out.signed && (trusted || []).includes(rel.sig.key);
      }
    } catch (e) { out.error = e.message; }
    return out;
  }

  // ---- App builds: which app a hub offers, signed by a maintainer so apps can trust an update ----
  const appBuildHead = a => ({ version: a.version, date: a.date, id: a.id, sha256: a.sha256 });
  async function signAppBuild(info, identity) {
    info.sig = { key: identity.key, value: await SDG.sign.signBytes(enc.encode(canonical(appBuildHead(info))), identity) };
    return info;
  }
  // trusted: maintainer keys. True only for a build with a file fingerprint, signed by one of them.
  async function verifyAppBuild(info, trusted) {
    if (!info || typeof info.sha256 !== 'string' || !info.sig || !(trusted || []).includes(info.sig.key)) return false;
    return SDG.sign.verifyBytes(enc.encode(canonical(appBuildHead(info))), info.sig.key, info.sig.value);
  }

  // A checkpoint is the hub's signed statement that after applying entries up to `seq`, the
  // dataset hashes to `hash`. Clients apply entries, re-hash, and compare.
  async function signCheckpoint(seq, hash, identity) {
    const c = { seq, hash, at: now() };
    return Object.assign(c, { key: identity.key, sig: await SDG.sign.signBytes(enc.encode(canonical(c)), identity) });
  }
  async function verifyCheckpoint(cp) {
    if (!cp || !cp.sig) return false;
    return SDG.sign.verifyBytes(enc.encode(canonical({ seq: cp.seq, hash: cp.hash, at: cp.at })), cp.key, cp.sig);
  }
  function applyLedger(ds, entries) {
    (entries || []).slice().sort((a, b) => a.seq - b.seq).forEach(e => applyChange(ds, { coll: e.coll, rid: e.rid, op: e.op, data: e.data }));
    return ds;
  }

  // When a newer base arrives, local edits are replayed on top. An edit whose record moved on
  // underneath it (rev changed) is kept but flagged so the user can look again.
  function rebase(base, edits) {
    const ds = clone(base), conflicts = [];
    (edits || []).forEach(e => {
      const cur = (ds[e.coll] || []).find(r => r.id === e.rid);
      const curRev = cur ? (cur.rev || 0) : null;
      if (e.baseRev != null && curRev != null && curRev !== e.baseRev) conflicts.push({ edit: e, current: cur });
      if (e.baseRev == null && cur && e.op === 'put') conflicts.push({ edit: e, current: cur });
      applyChange(ds, e);
    });
    return { ds, conflicts };
  }

  // ---- Bundles: files or HTTP payloads that carry signed items between devices ----
  const BUNDLE_KEYS = ['proposals', 'comments', 'observations', 'votes', 'ledger'];
  function makeBundle(f) {
    const b = { format: 'sdg-bundle', v: 1, created: now(), from: f.from || '' };
    if (f.release) b.release = f.release;
    if (f.checkpoint) b.checkpoint = f.checkpoint;
    BUNDLE_KEYS.forEach(k => { if (f[k] && f[k].length) b[k] = f[k]; });
    return b;
  }
  function parseBundle(obj) {
    if (typeof obj === 'string') obj = SDG.util.parse(obj);
    if (obj && obj.format === 'sdg-release') return { release: obj };
    if (!obj || obj.format !== 'sdg-bundle') throw new Error('This is not a Scrapper’s Guide bundle or release file.');
    const out = { release: obj.release, checkpoint: obj.checkpoint, from: obj.from, created: obj.created };
    BUNDLE_KEYS.forEach(k => (out[k] = Array.isArray(obj[k]) ? obj[k] : []));
    return out;
  }
  // Union by id. For the same id the copy with the most fields wins (a reviewed one beats a raw one).
  function mergeById(a, b) {
    const m = new Map();
    [...(a || []), ...(b || [])].forEach(x => {
      if (!x || !x.id) return;
      const cur = m.get(x.id);
      if (!cur || Object.keys(x).length > Object.keys(cur).length) m.set(x.id, x);
    });
    return [...m.values()].sort((x, y) => String(x.id).localeCompare(String(y.id)));
  }
  // Checks every signed item in a bundle; returns the ones that pass plus a list of rejects.
  async function verifyItems(items, kind) {
    const ok = [], bad = [];
    for (const it of items || []) {
      const schemaName = { proposals: 'proposal', comments: 'comment', observations: 'observation', votes: 'vote' }[kind];
      const v = schemaName ? SDG.schema.validate(schemaName, it) : { ok: true, errors: [] };
      if (!v.ok) { bad.push({ id: it && it.id, why: v.errors.map(e => `${e.path} ${e.msg}`).join('; ') }); continue; }
      if (!it.sig) { bad.push({ id: it.id, why: 'not signed' }); continue; }
      if (!(await SDG.sign.verify(it))) { bad.push({ id: it.id, why: 'signature does not match' }); continue; }
      ok.push(it);
    }
    return { ok, bad };
  }

  // A proposal as its author signed it, without what a hub keeps beside it (status, received,
  // seq, notes), and a hash of exactly that. A moderator signs the hash of what they reviewed, so
  // neither a hub nor anyone between can show one change and apply another.
  function signedProposal(p) {
    const o = {};
    Object.keys(SDG.schema.schemaFor('proposal').properties).forEach(k => { if (p && SDG.util.has(p, k)) o[k] = p[k]; });
    return o;
  }
  const proposalHash = p => sha256hex(canonical(signedProposal(p)));

  SDG.changes = {
    applyChange, overlay, checkData, makeProposal, makeComment, makeObservation,
    datasetHash, makeRelease, releaseHead, signRelease, verifyRelease, signAppBuild, verifyAppBuild,
    signCheckpoint, verifyCheckpoint, applyLedger, rebase,
    makeBundle, parseBundle, mergeById, verifyItems, BUNDLE_KEYS, signedProposal, proposalHash,
  };
};

#!/usr/bin/env node
// The hub: one small Node process, no dependencies.
//   hub mode:  takes signed contributions, runs moderation, writes accepted changes to data/
//              (and git, if enabled), and publishes releases and an incremental change feed.
//   node mode: mirrors an upstream hub for a camp, a NOMAD box or a cyberdeck, serves the same
//              API and app locally, and forwards contributions upstream whenever it can reach it.
// Both modes serve the app at /, the REST API at /api/v1 and an MCP endpoint at /mcp.
//
//   node server/hub.js                         local hub on http://127.0.0.1:8787
//   node server/hub.js --public --port 80      listen on every interface
//   node server/hub.js --mode node --upstream https://hub.example.org
const http = require('http');
const fs = require('fs');
const path = require('path');
const SDG = require('../core');
const F = require('../lib/fsdata');
const H = require('./http');
const { openStore } = require('./store');
const config = require('./config');
const { createGit } = require('./git');
const { startSync } = require('./sync');
const { createMcp } = require('../mcp/protocol');
const { buildOpenApi } = require('./openapi');
const { createBridge } = require('./lora');
const { startNomad } = require('./nomad');
const { createMap } = require('./map');

const VERSION = require('../package.json').version;
const ROLE_RANK = { banned: -1, contributor: 0, trusted: 1, moderator: 2, admin: 3 };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const isoTime = s => (typeof s === 'string' && ISO.test(s) ? Date.parse(s) : NaN);

// A secret for local controls (sync now), readable only by whoever can read the state folder.
function loadToken(stateDir) {
  const file = path.join(stateDir, 'control-token');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { /* first run */ }
  const t = require('crypto').randomBytes(24).toString('base64url');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

async function loadIdentity(stateDir, name) {
  const file = path.join(stateDir, 'hub-identity.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  const id = await SDG.sign.createIdentity(name);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(id, null, 2), { mode: 0o600 });
  return id;
}

async function createHub(cfg) {
  const store = openStore(cfg.stateDir, cfg.store);
  const identity = await loadIdentity(cfg.stateDir, cfg.name);
  const hubFp = await SDG.sign.fingerprint(identity.key);
  const git = createGit(path.dirname(cfg.dataDir), cfg.git || {});
  const P = cfg.policy;

  // In a container, the records bundled with this version (see F.seed).
  if (cfg.seedDir) {
    const did = F.seed(cfg.seedDir, cfg.dataDir);
    if (did === 'copied') console.log('Installed the bundled data');
    if (did === 'updated') console.log('Updated to the data bundled with this version');
    if (did === 'kept') console.warn('Kept this hub’s own data: it has changed since it was installed, so the data bundled with this version was not applied');
  }

  let ds = F.load(cfg.dataDir);
  ds.loadProblems.forEach(p => console.warn(`data problem: ${p.coll}/${p.id} ${p.msg}`));
  let ctx = null, problemKeys = null, releaseCache = null, hashCache = null, gen = 0;
  // gen counts writes, so a hash worked out while a write landed is never cached or signed.
  const invalidate = () => { gen++; ctx = null; problemKeys = null; releaseCache = null; hashCache = null; };
  // Votes feed confidence in search; their tally is cached until a vote lands.
  let voteTally = null;
  const tallyVotes = () => voteTally || (voteTally = SDG.votes.tally(store.listVotes({ prefix: 'devices/', limit: 1e6 })));
  const getCtx = () => { if (!ctx) { ctx = SDG.db.open(F.plain(ds)); ctx.setVotes(tallyVotes()); } return ctx; };
  const getRec = (coll, id) => (ds[coll] || []).find(r => r.id === id);
  const pkey = p => `${p.coll}|${p.id}|${p.path}|${p.msg}`;
  const currentProblems = () => problemKeys || (problemKeys = new Set(SDG.schema.validateDataset(F.plain(ds)).map(pkey)));

  const hub = { cfg, store, identity, hubFp, version: VERSION, syncState: null };
  hub.seq = Math.max((ds.meta && ds.meta.seq) || 0, store.ledgerHead());
  if (store.get('baselineSeq') === undefined) store.set('baselineSeq', hub.seq);
  hub.getCtx = getCtx;
  hub.dataset = () => ds;

  // ---- record hashes: detect edits made outside the hub (git pulls, hand edits) ----
  const recHash = rec => SDG.util.sha256hex(SDG.util.canonical(rec));
  let hashes = store.get('recordHashes') || null;
  async function currentHashes() {
    const out = {};
    for (const coll of SDG.db.COLLS) for (const r of ds[coll]) out[coll + '/' + r.id] = await recHash(r);
    return out;
  }
  async function rescan() {
    const now = await currentHashes();
    if (!hashes) { hashes = now; store.set('recordHashes', hashes); return 0; }
    let n = 0;
    const at = SDG.util.now();
    for (const k of new Set([...Object.keys(hashes), ...Object.keys(now)])) {
      if (hashes[k] === now[k]) continue;
      const [coll, rid] = k.split('/');
      const rec = getRec(coll, rid);
      hub.seq += 1;
      store.appendLedger({ seq: hub.seq, coll, rid, op: rec ? 'put' : 'delete', data: rec, at, by: 'import', reason: 'Changed outside the hub' });
      n++;
    }
    hashes = now;
    store.set('recordHashes', hashes);
    if (n) { ds.meta.seq = hub.seq; F.writeMeta(cfg.dataDir, ds.meta); invalidate(); }
    return n;
  }
  if (cfg.mode === 'hub') {
    const n = await rescan();
    if (n) console.log(`Imported ${n} change${n > 1 ? 's' : ''} made outside the hub`);
  }

  // ---- people and roles ----
  // Admins and moderators are named by public key, or by at least 32 hex characters (128 bits) of
  // its SHA-256: a 16-character fingerprint is short enough to be worth forging a key for.
  const strong = x => typeof x === 'string' && (/^[A-Za-z0-9_-]{43}$/.test(x) || /^[0-9a-f]{32,64}$/i.test(x));
  ['admins', 'moderators'].forEach(k => (cfg[k] || []).filter(x => !strong(x)).forEach(x => console.warn(`Ignoring ${k} entry “${x}”: give the public key or the 32-character admin id from \`node tools/keys.js show\``)));
  const matches = (list, key, hex) => (list || []).some(x => strong(x) && (x === key || hex.startsWith(x.toLowerCase())));
  async function roleOf(key) {
    if (!key) return 'contributor';
    let fp = '';
    try { fp = await SDG.sign.fingerprint(key, 64); } catch (e) { return 'contributor'; }
    const u = store.getUser(key);
    if (u && u.role === 'banned') return 'banned';
    if (matches(cfg.admins, key, fp)) return 'admin';
    if (matches(cfg.moderators, key, fp)) return 'moderator';
    return (u && u.role) || 'contributor';
  }
  async function touchUser(author, delta) {
    if (!author || !author.key) return;
    const u = store.getUser(author.key) || { key: author.key, fp: await SDG.sign.fingerprint(author.key), role: 'contributor', first: SDG.util.now(), proposals: 0, accepted: 0, rejected: 0, comments: 0 };
    if (author.name) u.name = author.name;
    u.last = SDG.util.now();
    Object.entries(delta || {}).forEach(([k, v]) => (u[k] = (u[k] || 0) + v));
    store.putUser(u);
    return u;
  }
  async function requireRole(signed, min) {
    if (!signed || !signed.sig || !(await SDG.sign.verify(signed))) throw new H.HttpError(401, 'This needs a valid signature');
    const role = await roleOf(signed.author.key);
    if (ROLE_RANK[role] < ROLE_RANK[min]) throw new H.HttpError(403, `This needs the ${min} role`);
    return role;
  }
  // Moderation messages are signed, say what they do, to what and on which hub, are fresh, and
  // work once, so a public review or an old role change can't be replayed at another endpoint, on
  // another hub where the same key moderates, or later.
  const FRESH = 10 * 60e3, AHEAD = 5 * 60e3;
  async function moderation(body, action, field, target, min) {
    const role = await requireRole(body, min);
    if (body.action !== action || typeof body[field] !== 'string' || (target !== undefined && body[field] !== target)) throw new H.HttpError(422, `Sign this as {action: "${action}", ${field}, hub, created} for this ${field}`);
    if (body.hub !== identity.key) throw new H.HttpError(422, 'Sign this for this hub: include hub, the key /api/v1/info gives as hubKey. An app or tool that leaves it out needs updating.');
    const t = isoTime(body.created), now = Date.now();
    if (!(t >= now - FRESH && t <= now + AHEAD)) throw new H.HttpError(422, 'This signed message is too old or dated in the future: sign it again, and check the clock on this device');
    const h = await SDG.util.sha256hex(body.sig);
    const used = store.get('usedSigs') || {};
    Object.keys(used).forEach(k => { if (used[k] < now) delete used[k]; });
    if (used[h]) throw new H.HttpError(409, 'This signed message has already been used');
    used[h] = t + FRESH + 60e3;
    store.set('usedSigs', used);
    return role;
  }
  async function checkAuthor(item, kind) {
    if (!item.sig) {
      if (P.requireSignature) throw new H.HttpError(401, `Unsigned ${kind}: this hub needs contributions signed with a contributor key`);
      delete item.author; // an unsigned author is only a claim: never a name or a role to trust
    } else if (!(await SDG.sign.verify(item))) throw new H.HttpError(401, `The ${kind}'s signature doesn't match its content`);
    const key = item.author && item.author.key;
    const role = await roleOf(key);
    if (role === 'banned') throw new H.HttpError(403, 'This key is blocked on this hub');
    const u = key && store.getUser(key);
    const known = ROLE_RANK[role] >= 1 || (u && u.accepted >= P.knownAfter);
    const bits = known ? P.powBitsKnown : P.powBits;
    if (!(await SDG.sign.checkStamp(item, bits))) throw new H.HttpError(428, `This hub needs a ${bits}-bit work stamp on ${kind}s from new contributors`, { powBits: bits });
    return role;
  }

  // ---- applying accepted changes ----
  function ledgerEntry(f) {
    hub.seq += 1;
    const e = Object.assign({ seq: hub.seq, at: SDG.util.now() }, f);
    store.appendLedger(e);
    ds.meta = Object.assign({}, ds.meta, { seq: hub.seq });
    F.writeMeta(cfg.dataDir, ds.meta);
    return e;
  }
  async function writeChange(coll, rid, op, rec) {
    if (op === 'put') F.writeRecord(cfg.dataDir, coll, rec); else F.deleteRecord(cfg.dataDir, coll, rid);
    SDG.changes.applyChange(ds, { coll, rid, op, data: rec });
    hashes = hashes || {};
    if (op === 'put') hashes[coll + '/' + rid] = await recHash(rec); else delete hashes[coll + '/' + rid];
    store.set('recordHashes', hashes);
    invalidate();
  }
  async function applyAccepted(p, reviewer) {
    const cur = getRec(p.coll, p.rid);
    let rec;
    if (p.op === 'put') rec = Object.assign(SDG.util.own(p.data, SDG.util.BAD_KEYS), { id: p.rid, rev: ((cur && cur.rev) || 0) + 1, updated: SDG.util.now().slice(0, 10) });
    await writeChange(p.coll, p.rid, p.op, rec);
    const e = ledgerEntry({ coll: p.coll, rid: p.rid, op: p.op, data: rec, proposal: p.id, by: p.author && p.author.key, reviewer, reason: p.reason || undefined });
    const fp = p.author && p.author.key ? await SDG.sign.fingerprint(p.author.key) : 'anonymous';
    git.commit([path.relative(path.dirname(cfg.dataDir), F.fileFor(cfg.dataDir, p.coll, p.rid)), path.relative(path.dirname(cfg.dataDir), path.join(cfg.dataDir, 'meta.json'))],
      `${p.op === 'delete' ? 'Delete' : cur ? 'Update' : 'Add'} ${p.coll}/${p.rid}${p.reason ? ': ' + p.reason.slice(0, 120) : ''}\n\nProposal ${p.id}, seq ${e.seq}${p.source === 'ai' ? ', written by an AI tool' : ''}`,
      { name: (p.author && p.author.name) || 'contributor', fp });
    return e;
  }
  // Problems a change would introduce that aren't already in the data.
  function newProblems(p) {
    if (p.op === 'put') {
      const v = SDG.schema.validateRecord(p.coll, Object.assign(SDG.util.own(p.data), { id: p.rid }));
      if (!v.ok) return v.errors.map(e => ({ coll: p.coll, id: p.rid, path: e.path, msg: e.msg }));
    } else if (!getRec(p.coll, p.rid)) return [{ coll: p.coll, id: p.rid, path: '', msg: "doesn't exist" }];
    const before = currentProblems();
    return SDG.schema.validateDataset(SDG.changes.overlay(F.plain(ds), [p])).filter(x => !before.has(pkey(x)));
  }
  const isStale = p => { const cur = getRec(p.coll, p.rid); return !!cur && p.baseRev != null && (cur.rev || 0) !== p.baseRev; };

  async function accept(p, reviewer, force) {
    const errors = newProblems(p);
    if (errors.length) {
      Object.assign(p, { status: 'conflict', errors });
      store.putProposal(p);
      throw new H.HttpError(409, 'This change no longer fits the current data', { errors });
    }
    if (isStale(p) && !force) throw new H.HttpError(409, 'The record changed since this was proposed. Look at the current version and accept with force if it still applies.', { stale: true });
    const e = await applyAccepted(p, reviewer);
    Object.assign(p, { status: 'accepted', seq: e.seq, decided: SDG.util.now() });
    delete p.errors;
    store.putProposal(p);
    await touchUser(p.author, { accepted: 1 });
    return e;
  }

  // ---- intake ----
  // Ids are chosen by senders, so an id already taken by someone else is a conflict, never a
  // duplicate: otherwise anyone who saw an id first could silently swallow the real item.
  const signer = x => (x && x.sig && x.author && x.author.key) || null;
  // `created` is the sender's word: it must be a real time and not ahead, but only `received`
  // (this store's own, strictly increasing clock) orders and pages what others pull.
  function checkCreated(item, kind) {
    if (!(isoTime(item.created) <= Date.now() + 864e5)) throw new H.HttpError(422, `The ${kind}'s created date must be an ISO 8601 time, not in the future`);
  }
  let lastStamp = 0;
  const stamp = () => new Date((lastStamp = Math.max(Date.now(), lastStamp + 1))).toISOString();
  hub.stamp = stamp;
  function sameAuthor(known, item, kind) {
    if (signer(known) !== signer(item)) throw new H.HttpError(409, `Another contributor already sent a ${kind} with this id`, { idConflict: true });
  }
  async function takeProposal(p) {
    const v = SDG.schema.validate('proposal', p);
    if (!v.ok) throw new H.HttpError(422, 'Not a valid proposal', { errors: v.errors });
    checkCreated(p, 'proposal');
    const known = store.getProposal(p.id);
    if (known) { sameAuthor(known, p, 'proposal'); return { id: p.id, status: known.status, duplicate: true }; }
    const role = await checkAuthor(p, 'proposal');
    const errors = newProblems(p);
    if (errors.length) throw new H.HttpError(422, 'The change has problems', { errors });
    const rec = Object.assign({}, p, { received: SDG.util.now() });
    if (cfg.mode === 'node') {
      rec.status = 'queued';
      store.putProposal(rec);
      store.outboxAdd('proposals', p);
      hub.kick && hub.kick();
      return { id: p.id, status: 'queued' };
    }
    rec.status = 'pending';
    store.putProposal(rec);
    await touchUser(p.author, { proposals: 1 });
    const auto = p.source !== 'ai' && !isStale(p) && (P.autoAccept.includes(role) || (role === 'trusted' && P.trustedAutoAccept && p.op === 'put'));
    if (auto) {
      const e = await accept(rec, p.author && p.author.key);
      return { id: p.id, status: 'accepted', seq: e.seq };
    }
    return { id: p.id, status: 'pending' };
  }

  async function review(body, id) {
    const role = await moderation(body, 'review', 'proposal', id, 'moderator');
    if (!['accept', 'reject'].includes(body.decision)) throw new H.HttpError(422, 'A review needs a decision: accept or reject');
    const p = store.getProposal(body.proposal);
    if (!p) throw new H.HttpError(404, 'No such proposal');
    if (!['pending', 'conflict'].includes(p.status)) throw new H.HttpError(409, `This proposal is already ${p.status}`);
    // The moderator signed the hash of the proposal they were shown: it must be this one.
    if (body.hash !== await SDG.changes.proposalHash(p)) throw new H.HttpError(409, 'This review is for a different version of the proposal than the one here: load it again and review what it says');
    store.putReview(body);
    if (body.decision === 'reject') {
      Object.assign(p, { status: 'rejected', note: body.note || '', decided: SDG.util.now() });
      store.putProposal(p);
      await touchUser(p.author, { rejected: 1 });
      return { id: p.id, status: 'rejected' };
    }
    const approvals = store.reviewsFor(p.id).filter(r => r.decision === 'accept').length;
    if (approvals < P.approvals && role !== 'admin') return { id: p.id, status: 'pending', approvals, needed: P.approvals };
    const e = await accept(p, body.author.key, !!body.force);
    return { id: p.id, status: 'accepted', seq: e.seq };
  }

  // meta: fields kept beside a signed item, outside its signature ({via: 'lora'}).
  async function takeComment(c, meta) {
    if (P.comments !== 'on') throw new H.HttpError(403, 'Comments are turned off on this hub');
    const v = SDG.schema.validate('comment', c);
    if (!v.ok) throw new H.HttpError(422, 'Not a valid comment', { errors: v.errors });
    checkCreated(c, 'comment');
    const known = store.getComment(c.id);
    if (known) { sameAuthor(known, c, 'comment'); return { id: c.id, status: 'duplicate' }; }
    await checkAuthor(c, 'comment');
    const [coll, rid] = c.target.split('/');
    if (!getRec(coll, rid)) throw new H.HttpError(422, `Nothing to comment on: ${c.target} doesn't exist`);
    // A full record takes no more comments; existing ones are never dropped to make room.
    if (store.countComments(c.target) >= P.maxCommentsPerTarget) throw new H.HttpError(409, `${c.target} already has ${P.maxCommentsPerTarget} comments, this hub's limit. A moderator can hide old ones to make room.`, { full: true });
    store.putComment(Object.assign({}, c, meta, { received: stamp() }));
    await touchUser(c.author, { comments: 1 });
    if (cfg.mode === 'node') { store.outboxAdd('comments', c); hub.kick && hub.kick(); }
    return { id: c.id, status: 'stored' };
  }

  async function takeObservation(o, meta) {
    if (!P.observations) throw new H.HttpError(403, 'This hub does not take field observations');
    const v = SDG.schema.validate('observation', o);
    if (!v.ok) throw new H.HttpError(422, 'Not a valid observation', { errors: v.errors });
    checkCreated(o, 'observation');
    const allowed = cfg.mode === 'node' ? ['public', 'peers'] : ['public'];
    if (!allowed.includes(o.share || 'private')) throw new H.HttpError(422, `This ${cfg.mode} only stores observations shared as ${allowed.join(' or ')}`);
    // Its author may update a note; nobody else may replace it.
    const known = store.getObservation(o.id);
    if (known) sameAuthor(known, o, 'observation');
    await checkAuthor(o, 'observation');
    store.putObservation(Object.assign({}, o, meta, { received: stamp() }));
    if (cfg.mode === 'node' && o.share === 'public') { store.outboxAdd('observations', o); hub.kick && hub.kick(); }
    if (hub.lora && !(meta && meta.via === 'lora')) hub.lora.shareObservation(o);
    if (hub.pushMarkers) { clearTimeout(hub.markerTimer); hub.markerTimer = setTimeout(() => hub.pushMarkers().catch(() => {}), 3000); hub.markerTimer.unref && hub.markerTimer.unref(); }
    return { id: o.id, status: 'stored' };
  }

  // One vote per person per thing. Votes are always signed (a vote nobody can stand behind counts
  // for nothing), never on your own comment or note, and a newer vote replaces an older one.
  async function takeVote(v, meta) {
    if (!P.votes) throw new H.HttpError(403, 'This hub does not take votes');
    const val = SDG.schema.validate('vote', v);
    if (!val.ok) throw new H.HttpError(422, 'Not a valid vote', { errors: val.errors });
    checkCreated(v, 'vote');
    if (!v.sig) throw new H.HttpError(401, 'Votes must be signed with a contributor key');
    await checkAuthor(v, 'vote');
    const who = v.author.key, [kind, rest] = [v.target.slice(0, v.target.indexOf('/')), v.target.slice(v.target.indexOf('/') + 1)];
    if (kind === 'devices') {
      const [dev, key] = rest.split('#');
      const r = getCtx().resolve(dev);
      if (!r || !r.comps.some(c => c.key === key && !c.board)) throw new H.HttpError(422, `Nothing to vote on: ${dev} has no part ${key}`);
    } else {
      const item = kind === 'comments' ? store.getComment(rest) : store.getObservation(rest);
      if (!item || item.hidden || (kind === 'observations' && item.share === 'private')) throw new H.HttpError(422, `Nothing to vote on: ${v.target} isn't here`);
      if (item.author && item.author.key === who) throw new H.HttpError(422, 'You can’t vote on your own ' + (kind === 'comments' ? 'comment' : 'note'));
    }
    const known = store.getVote(v.target, who);
    if (known && String(known.created) >= String(v.created)) return { id: v.id, status: 'duplicate' };
    store.putVote(Object.assign({}, v, meta, { received: stamp() }));
    if (!known) await touchUser(v.author, { votes: 1 });
    voteTally = null;
    if (ctx && kind === 'devices') ctx.setVotes(tallyVotes());
    if (cfg.mode === 'node') { store.outboxAdd('votes', v); hub.kick && hub.kick(); }
    return { id: v.id, status: 'stored' };
  }

  // budget(n) says how many of the n items the sender may still submit; the rest get a 429.
  async function takeBundle(b, budget) {
    let parsed;
    try { parsed = SDG.changes.parseBundle(b); } catch (e) { throw new H.HttpError(422, e.message); }
    const total = parsed.proposals.length + parsed.comments.length + parsed.observations.length + parsed.votes.length;
    if (total > 2000) throw new H.HttpError(413, 'A bundle can carry at most 2000 items; split it');
    let left = budget ? budget(total) : total;
    const out = { proposals: [], comments: [], observations: [], votes: [] };
    const each = async (list, fn, into) => {
      for (const it of list) {
        if (left-- <= 0) { into.push(over(it)); continue; }
        try { into.push(Object.assign({ ok: true }, await fn(it))); } catch (e) { into.push({ id: it && it.id, ok: false, status: e.status || 500, error: e.message, extra: e.extra }); }
      }
    };
    await each(parsed.proposals, takeProposal, out.proposals);
    await each(parsed.comments, takeComment, out.comments);
    await each(parsed.observations, takeObservation, out.observations);
    await each(parsed.votes, takeVote, out.votes);
    return out;
  }

  // ---- releases and sync ----
  async function datasetHash() {
    if (hashCache) return hashCache;
    const g = gen, h = await SDG.changes.datasetHash(F.plain(ds));
    if (g === gen) hashCache = h;
    return h;
  }
  async function release() {
    if (releaseCache && releaseCache.seq === hub.seq) return releaseCache;
    const g = gen;
    const r = await SDG.changes.makeRelease(F.plain(ds), hub.seq, ds.meta && ds.meta.name);
    await SDG.changes.signRelease(r, identity);
    if (g === gen) { releaseCache = r; hashCache = r.hash; }
    return r;
  }
  // The head and its hash, taken with no write in between, so the checkpoint always matches.
  async function head() {
    for (;;) { const g = gen, seq = hub.seq, hash = await datasetHash(); if (g === gen && seq === hub.seq) return { seq, hash }; }
  }
  async function syncFeed(since, limit) {
    since = Math.max(0, Math.floor(+since) || 0);
    const baseline = store.get('baselineSeq') || 0;
    const h = await head();
    const entries = since > h.seq || since < baseline ? null : store.ledgerSince(since, limit || 2000).filter(e => e.seq <= h.seq);
    const checkpoint = await SDG.changes.signCheckpoint(h.seq, h.hash, identity);
    if (!entries) return { reset: true, head: h.seq, checkpoint };
    const more = entries.length && entries[entries.length - 1].seq < h.seq;
    return { head: h.seq, entries, more: !!more, checkpoint: more ? undefined : checkpoint };
  }

  // ---- node mode: patch or replace the local mirror from upstream ----
  // Nothing from the feed touches disk until the whole result matches a checkpoint signed by the
  // pinned upstream key, and every entry is checked as strictly as a proposal would be.
  const upstreamKey = () => store.get('upstreamKey');
  function cleanEntry(e) {
    const bad = why => { throw new Error(`The upstream feed has a bad entry${e && Number.isInteger(e.seq) ? ' at seq ' + e.seq : ''}: ${why}`); };
    if (!e || typeof e !== 'object' || !Number.isInteger(e.seq) || e.seq < 1) bad('no sequence number');
    if (!SDG.db.COLLS.includes(e.coll)) bad('unknown collection');
    if (typeof e.rid !== 'string' || !/^[a-z0-9][a-z0-9_]*$/.test(e.rid)) bad('not a valid record id');
    if (!['put', 'delete'].includes(e.op)) bad('op must be put or delete');
    const out = { seq: e.seq, coll: e.coll, rid: e.rid, op: e.op };
    if (e.op === 'put') {
      if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data) || e.data.id !== e.rid) bad('its record does not carry its id');
      const v = SDG.schema.validateRecord(e.coll, e.data);
      if (!v.ok) bad(v.errors.slice(0, 3).map(x => `${x.path} ${x.msg}`).join('; '));
      out.data = SDG.util.clone(e.data);
    }
    ['at', 'proposal', 'by', 'reviewer', 'reason'].forEach(k => { if (typeof e[k] === 'string') out[k] = e[k].slice(0, 2000); });
    return out;
  }
  async function checkUpstream(cp) {
    const key = upstreamKey();
    if (!cp || !key || cp.key !== key || !(await SDG.changes.verifyCheckpoint(cp))) throw new Error('The upstream sent changes without a valid checkpoint signed by its pinned key');
  }
  // Refuses to go back to older data unless the operator allows it (allowRollback).
  function checkRollback(seq, what) {
    if (seq >= hub.seq) return;
    const msg = `The upstream offered ${what} at seq ${seq}, older than this node's ${hub.seq}`;
    if (!cfg.allowRollback) { console.warn(msg + '; refused (set allowRollback to accept it)'); throw new Error(msg + '; refused'); }
    console.warn(msg + '; accepted because allowRollback is set');
  }
  hub.checkRollback = checkRollback;
  hub.applyUpstreamEntries = async (entries, cp) => {
    await checkUpstream(cp);
    const list = entries.map(cleanEntry).sort((a, b) => a.seq - b.seq).filter(e => e.seq > hub.seq);
    list.forEach((e, i) => { if (i && e.seq === list[i - 1].seq) throw new Error('The upstream feed repeats seq ' + e.seq); });
    const last = list.length ? list[list.length - 1].seq : hub.seq;
    if (cp.seq !== last) throw new Error(`The upstream checkpoint is for seq ${cp.seq}, but its changes end at ${last}`);
    const copy = SDG.changes.applyLedger(SDG.util.clone(F.plain(ds)), list);
    if ((await SDG.changes.datasetHash(copy)) !== cp.hash) return false;
    for (const e of list) {
      await writeChange(e.coll, e.rid, e.op, e.data);
      store.appendLedger(e);
      hub.seq = e.seq;
      if (e.proposal) { const p = store.getProposal(e.proposal); if (p) { p.status = 'accepted'; p.seq = e.seq; store.putProposal(p); } }
    }
    ds.meta = Object.assign({}, ds.meta, { seq: hub.seq });
    F.writeMeta(cfg.dataDir, ds.meta);
    return true;
  };
  hub.replaceFromRelease = async rel => {
    if (!rel || !rel.dataset || !Number.isInteger(rel.seq)) throw new Error('Not a release');
    checkRollback(rel.seq, 'a release');
    for (const coll of SDG.db.COLLS) for (const r of rel.dataset[coll] || []) F.fileFor(cfg.dataDir, coll, r && r.id);
    const want = new Set();
    for (const coll of SDG.db.COLLS) for (const r of rel.dataset[coll] || []) { want.add(coll + '/' + r.id); F.writeRecord(cfg.dataDir, coll, r); }
    for (const coll of SDG.db.COLLS) for (const r of ds[coll]) if (!want.has(coll + '/' + r.id)) { try { F.deleteRecord(cfg.dataDir, coll, r.id); } catch (e) { console.warn(e.message); } }
    F.writeVocab(cfg.dataDir, rel.dataset.vocab || {});
    F.writeMeta(cfg.dataDir, Object.assign({}, ds.meta, { seq: rel.seq }));
    ds = F.load(cfg.dataDir);
    hub.seq = rel.seq;
    store.set('baselineSeq', rel.seq);
    hashes = await currentHashes();
    store.set('recordHashes', hashes);
    invalidate();
  };
  hub.datasetHash = datasetHash;
  hub.takeProposal = takeProposal;
  hub.takeComment = takeComment;
  hub.takeVote = takeVote;
  hub.tallyVotes = tallyVotes;
  hub.votesChanged = () => { voteTally = null; if (ctx) ctx.setVotes(tallyVotes()); };
  hub.takeObservation = takeObservation;
  hub.release = release;

  // NOMAD on the hub's own machine is "localhost" or a container name to the hub, neither of which
  // a phone can use: hand each caller links on the address it reached the hub by.
  function librariesFor(headers) {
    const libs = hub.libraries ? hub.libraries() : null;
    if (!libs) return libs;
    let host = '';
    try { host = new URL('http://' + ((headers && headers.host) || '')).hostname; } catch (e) { /* no Host header */ }
    const at = L => {
      if (!L) return L;
      const { port, scheme, ...rest } = L;
      return port && host ? Object.assign(rest, { url: `${scheme || 'http'}://${host}:${port}` }) : rest;
    };
    return { kiwix: at(libs.kiwix), nomad: at(libs.nomad) };
  }

  // ---- AI tools (MCP) ----
  // Over HTTP the hub signs and stamps AI contributions itself, for whoever calls /mcp, so the
  // write tools are opt-in: on by default only for a hub that listens on this machine alone.
  const local = ['127.0.0.1', '::1', 'localhost'].includes(cfg.host) && !cfg.trustProxy;
  hub.mcpWrite = cfg.mcpWrite === 'auto' || cfg.mcpWrite == null ? local : !!cfg.mcpWrite;
  const mcp = createMcp({
    name: cfg.name, version: VERSION, getCtx,
    info: () => ({ hub: cfg.name, mode: cfg.mode, seq: hub.seq }),
    libraries: librariesFor,
    // Labelled as AI, they always wait for a moderator, and pay a newcomer's work stamp so /mcp is
    // no cheaper a spam route.
    submit: hub.mcpWrite ? async (kind, item) => {
      const take = { proposal: takeProposal, comment: takeComment, observation: takeObservation }[kind];
      if (!take) throw new Error('Unknown kind ' + kind);
      if (P.powBits) item.pow = await SDG.sign.stamp(item, P.powBits);
      return take(await SDG.sign.sign(item, identity));
    } : undefined,
  });
  // The hub's own key signs AI submissions, so it must never count as a moderator.
  const hubHex = await SDG.sign.fingerprint(identity.key, 64);
  if (matches(cfg.admins, identity.key, hubHex) || matches(cfg.moderators, identity.key, hubHex)) throw new Error('The hub identity must not be an admin or moderator');

  // ---- HTTP ----
  const r = H.router();
  const limit = H.limiter();
  const q = (url, k) => url.searchParams.get(k);
  const num = v => (v == null || v === '' ? undefined : +v);
  const listParam = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : undefined);
  // Every limit is clamped (SQLite reads LIMIT -1 as no limit) and every text query is capped.
  const lim = (url, def, max) => { const n = Math.floor(+q(url, 'limit')); return n >= 1 ? Math.min(n, max) : def; };
  const text = (url, k, max) => { const v = q(url, k) || ''; if (v.length > (max || 200)) throw new H.HttpError(400, `${k} is longer than ${max || 200} characters`); return v; };
  const problemCache = new Map();
  function problemsFor(p) {
    const c = problemCache.get(p.id);
    if (c && c.gen === gen) return c.problems;
    if (problemCache.size >= 500) problemCache.clear();
    const problems = newProblems(p);
    problemCache.set(p.id, { gen, problems });
    return problems;
  }
  // Items beyond what this caller's write budget allows come back as 429, one by one.
  const over = x => ({ id: x && x.id, ok: false, status: 429, error: 'Too many submissions from here; send this again in a few minutes' });

  r.get('/api/v1/info', async (req) => ({
    name: cfg.name, mode: cfg.mode, version: VERSION, schema: 3, seq: hub.seq, hash: await datasetHash(),
    announcement: String(cfg.announcement || '').slice(0, 500) || undefined,
    hubKey: identity.key, hubFingerprint: hubFp, upstream: cfg.mode === 'node' ? cfg.upstream : undefined, sync: hub.syncState || undefined,
    lora: hub.lora ? Object.assign({ queued: hub.lora.queueLength() }, hub.lora.state) : undefined,
    app: appBuild(),
    libraries: librariesFor(req.headers) || undefined,
    counts: getCtx().stats(), store: store.kind,
    policy: { requireSignature: P.requireSignature, powBits: P.powBits, powBitsKnown: P.powBitsKnown, approvals: P.approvals, comments: P.comments, observations: P.observations, votes: P.votes },
    endpoints: { api: '/api/v1', openapi: '/api/v1/openapi.json', mcp: '/mcp', app: '/' },
  }));
  r.get('/api/v1/search', (req, url) => {
    const query = text(url, 'q');
    if (!query.trim()) throw new H.HttpError(400, 'Add a query: ?q=12v motor');
    const opts = { subs: q(url, 'subs') === '1' || q(url, 'subs') === 'true', months: num(q(url, 'months')), tools: listParam(text(url, 'tools', 2000)), maxKg: num(q(url, 'kg')) };
    return SDG.search.summarize(getCtx(), SDG.search.search(getCtx(), query, opts), lim(url, 10, 50));
  });
  // The map: places near a point ranked for a search, and light tiles to draw. The map comes from
  // NOMAD's offline maps or from PMTiles files named in the config (map.pmtiles).
  const map = createMap(hub);
  hub.map = map;
  r.get('/api/v1/map', () => map.info());
  r.get('/api/v1/map/tiles/:z/:x/:y', async (req, url, { z, x, y }) => {
    [z, x, y] = [z, x, y].map(Number);
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 15 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new H.HttpError(400, 'Give a tile as z/x/y, zoom 0 to 15');
    const body = await map.renderTile(z, x, y);
    if (!body) throw new H.HttpError(404, 'No offline map has this tile');
    return { __headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }, __body: body };
  });
  r.get('/api/v1/places', (req, url) => {
    const lat = num(q(url, 'lat')), lon = num(q(url, 'lon'));
    if (!(lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180)) throw new H.HttpError(400, 'Give lat and lon');
    const parts = listParam(text(url, 'parts', 2000));
    if (parts && parts.length > 40) throw new H.HttpError(400, 'Ask for at most 40 part types at once');
    return map.places(getCtx(), { lat, lon, km: num(q(url, 'km')), query: text(url, 'q'), limit: lim(url, 40, 200), parts, perPart: Math.min(10, Math.max(1, num(q(url, 'per')) || 5)),
      opts: { months: num(q(url, 'months')), tools: listParam(text(url, 'tools', 2000)), maxKg: num(q(url, 'kg')) } });
  });
  // A cited web page, opened in the NOMAD library that keeps a copy of its site: the page itself
  // when the book has it, else a search of that book for the source's title. Books are snapshots,
  // so the hub asks Kiwix first rather than send the reader to a missing page.
  const offlineSeen = new Map();
  const decode = x => { try { return decodeURIComponent(x); } catch (e) { return x; } };
  async function bookHas(href) {
    if (offlineSeen.has(href)) return offlineSeen.get(href);
    let ok = false;
    try { ok = (await fetch(href, { method: 'HEAD', signal: AbortSignal.timeout(5000) })).ok; } catch (e) { return false; /* Kiwix busy or gone: ask again next time */ }
    if (offlineSeen.size > 5000) offlineSeen.clear();
    offlineSeen.set(href, ok);
    return ok;
  }
  r.get('/api/v1/offline', async (req, url) => {
    const libs = hub.libraries ? hub.libraries() : null, k = libs && libs.kiwix;
    const at = k && SDG.text.offlinePage(text(url, 'u', 2000), getCtx().ds.vocab.libraries, k.books);
    if (!at) throw new H.HttpError(404, 'No offline library here keeps this page');
    const out = librariesFor(req.headers).kiwix.url.replace(/\/+$/, ''), book = encodeURIComponent(at.book);
    const title = text(url, 't', 300).replace(/^[^:]{1,40}:\s*/, '') || decode(at.page.split('/').pop()).replace(/[_+-]+/g, ' ');
    const to = (await bookHas(`${k.url.replace(/\/+$/, '')}/content/${book}/${at.page}`)) ? `${out}/content/${book}/${at.page}` : `${out}/search?books.name=${book}&pattern=${encodeURIComponent(title)}`;
    return { __status: 302, __headers: { Location: to, 'Cache-Control': 'no-store' }, __body: '' };
  });
  r.get('/api/v1/build', (req, url) => SDG.search.buildable(getCtx(), listParam(text(url, 'have', 2000)) || [], { months: num(q(url, 'months')) }).slice(0, 20)
    .map(x => ({ id: x.guide.id, title: x.guide.title, summary: x.guide.summary, difficulty: x.guide.difficulty, coverage: Math.round(x.coverage * 100), have: x.have, missing: x.missing })));
  r.get('/api/v1/records/:coll', (req, url, { coll }) => {
    if (!SDG.db.COLLS.includes(coll)) throw new H.HttpError(404, 'Unknown collection');
    const f = text(url, 'q').toLowerCase();
    return ds[coll].filter(x => !f || JSON.stringify([x.id, x.name, x.title, x.label, x.keywords, x.aliases]).toLowerCase().includes(f))
      .map(x => ({ id: x.id, name: x.name || x.title || x.label || x.id, group: x.group || x.kind, rev: x.rev, deprecated: x.deprecated }));
  });
  r.get('/api/v1/records/:coll/:id', (req, url, { coll, id }) => {
    if (!SDG.db.COLLS.includes(coll)) throw new H.HttpError(404, 'Unknown collection');
    const rec = getRec(coll, id);
    if (!rec) throw new H.HttpError(404, `No ${coll} record “${id}”`);
    if (coll === 'devices' && q(url, 'resolved') === '1') return getCtx().resolve(id);
    return rec;
  });
  r.get('/api/v1/records/:coll/:id/history', (req, url, { coll, id }) => store.ledgerFor(coll, id).map(e => ({ seq: e.seq, op: e.op, at: e.at, proposal: e.proposal, by: e.by, reason: e.reason })));
  r.get('/api/v1/schema', () => SDG.schema.root());
  let relBody = { rel: null, buf: null };
  r.get('/api/v1/release', async (req, url, p, res) => {
    const rel = await release();
    if (req.headers['if-none-match'] === `"${rel.hash}"`) return { __status: 304, __body: '' };
    if (relBody.rel !== rel) relBody = { rel, buf: Buffer.from(JSON.stringify(rel)) };
    return { __headers: { ETag: `"${rel.hash}"`, 'Cache-Control': 'no-cache', 'Content-Type': 'application/json; charset=utf-8' }, __body: relBody.buf };
  });
  r.get('/api/v1/sync', (req, url) => syncFeed(q(url, 'since'), lim(url, 2000, 2000)));
  r.get('/api/v1/proposals', async (req, url) => {
    const list = store.listProposals({ status: q(url, 'status') || undefined, coll: q(url, 'coll') || undefined, rid: q(url, 'rid') || undefined, author: q(url, 'author') || undefined, since: q(url, 'since') || undefined, limit: lim(url, 100, 500), desc: q(url, 'order') === 'newest' });
    return list.map(p => Object.assign({}, p, { stale: isStale(p) }));
  });
  r.get('/api/v1/proposals/:id', (req, url, { id }) => {
    const p = store.getProposal(id);
    if (!p) throw new H.HttpError(404, 'No such proposal');
    const cur = getRec(p.coll, p.rid) || null;
    return { proposal: p, current: cur, stale: isStale(p), diff: SDG.util.diff(cur || {}, p.op === 'put' ? p.data : {}), reviews: store.reviewsFor(id), problems: ['pending', 'conflict'].includes(p.status) ? problemsFor(p) : [] };
  });
  r.post('/api/v1/proposals', async (req, url, p, res, body) => {
    if (!Array.isArray(body)) return takeProposal(body);
    if (body.length > 20) throw new H.HttpError(413, 'Send at most 20 proposals at a time, or use /api/v1/bundle');
    const n = 1 + (body.length > 1 ? req.charge('w', body.length - 1, true) : 0), out = [];
    for (const [i, x] of body.entries()) out.push(i >= n ? over(x) : await takeProposal(x).catch(e => ({ id: x && x.id, ok: false, status: e.status || 500, error: e.message, extra: e.extra })));
    return out;
  });
  r.post('/api/v1/proposals/:id/review', async (req, url, { id }, res, body) => {
    if (cfg.mode === 'node') throw new H.HttpError(409, 'Reviews happen on the upstream hub, not on a node');
    return review(body, id);
  }, { write: true });
  r.get('/api/v1/comments', (req, url) => {
    if (P.comments === 'off') return [];
    return store.listComments({ target: q(url, 'target') || undefined, since: q(url, 'since') || undefined, limit: lim(url, 200, 1000), desc: q(url, 'order') === 'newest' });
  });
  r.post('/api/v1/comments', (req, url, p, res, body) => takeComment(body), { write: true });
  r.post('/api/v1/comments/:id/hide', async (req, url, { id }, res, body) => {
    await moderation(body, 'hide-comment', 'comment', id, 'moderator');
    const c = store.getComment(id);
    if (!c) throw new H.HttpError(404, 'No such comment');
    c.hidden = body.hidden !== false;
    store.putComment(c);
    return { id, hidden: c.hidden };
  }, { write: true });
  r.get('/api/v1/observations', (req, url) => {
    const bbox = listParam(q(url, 'bbox'));
    return store.listObservations({ shares: sharesFor(req), bbox: bbox && bbox.length === 4 ? bbox.map(Number) : undefined, since: q(url, 'since') || undefined, limit: lim(url, 1000, 5000) });
  });
  r.post('/api/v1/observations', (req, url, p, res, body) => takeObservation(body), { write: true });
  r.get('/api/v1/votes', (req, url) => (P.votes ? store.listVotes({ target: q(url, 'target') || undefined, prefix: q(url, 'prefix') || undefined, since: q(url, 'since') || undefined, limit: lim(url, 1000, 5000) }) : []));
  // Counts per target, for a page or a tool that doesn't keep the votes themselves.
  r.get('/api/v1/votes/tally', (req, url) => {
    if (!P.votes) return {};
    const prefix = q(url, 'prefix') || '';
    if (!/^(devices|comments|observations)\//.test(prefix)) throw new H.HttpError(400, 'Give a prefix: devices/<id>, comments/ or observations/');
    return Object.fromEntries([...SDG.votes.tally(store.listVotes({ prefix, limit: 1e6 }))]);
  });
  r.post('/api/v1/votes', (req, url, p, res, body) => takeVote(body), { write: true });
  r.post('/api/v1/bundle', (req, url, p, res, body) => takeBundle(body, n => 1 + (n > 1 ? req.charge('w', n - 1, true) : 0)), { big: true });
  // A catch-up file: the changes since `since` when there are few, otherwise the whole release.
  r.get('/api/v1/bundle', async (req, url) => {
    if (!req.charge('r', 9)) throw new H.HttpError(429, 'Too many requests; slow down');
    const feed = await syncFeed(num(q(url, 'since')) || 0, 5000);
    const whole = feed.reset || feed.more;
    return SDG.changes.makeBundle({
      from: cfg.name, ledger: whole ? [] : feed.entries, checkpoint: feed.checkpoint, release: whole ? await release() : undefined,
      proposals: store.listProposals({ status: cfg.mode === 'node' ? 'queued' : 'pending', limit: 2000 }).map(p => SDG.sign.strip(p, 'status', 'received', 'errors')),
      comments: P.comments === 'off' ? [] : store.listComments({ since: q(url, 'commentsSince') || undefined, limit: 5000 }).map(c => SDG.sign.strip(c, 'received', 'hidden')),
      observations: store.listObservations({ shares: sharesFor(req), since: q(url, 'observationsSince') || undefined, limit: 5000 }).map(o => SDG.sign.strip(o, 'received', 'via')),
      votes: P.votes ? store.listVotes({ since: q(url, 'votesSince') || undefined, limit: 20000 }).map(v => SDG.sign.strip(v, 'received', 'via')) : [],
    });
  });
  r.get('/api/v1/users/:key', async (req, url, { key }) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new H.HttpError(404, 'Not a public key');
    const u = store.getUser(key) || { key, fp: await SDG.sign.fingerprint(key), proposals: 0, accepted: 0, rejected: 0, comments: 0 };
    return Object.assign({}, u, { role: await roleOf(key) });
  });
  r.post('/api/v1/roles', async (req, url, p, res, body) => {
    await moderation(body, 'set-role', 'key', undefined, 'admin');
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.key) || !SDG.util.has(ROLE_RANK, body.role) || body.role === 'admin') throw new H.HttpError(422, 'Give key and a role: banned, contributor, trusted or moderator. Admins are set in the hub config.');
    const u = (await touchUser({ key: body.key })) || {};
    u.role = body.role;
    store.putUser(u);
    return { key: body.key, role: body.role };
  }, { write: true });
  // From this machine, with the token in state/control-token: a proxy on this machine makes every
  // caller look local, so the address alone proves nothing.
  const token = loadToken(cfg.stateDir);
  r.post('/api/v1/sync/now', async (req) => {
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const ok = given.length === token.length && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !ok) throw new H.HttpError(403, 'Only from this machine, with the token in the state folder (control-token)');
    if (!hub.syncNow) throw new H.HttpError(409, 'This is not a node with an upstream');
    return hub.syncNow();
  }, { local: true });
  r.get('/api/v1/openapi.json', (req) => buildOpenApi({ name: cfg.name, version: VERSION, url: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}` }));
  // One request may carry a few JSON-RPC messages, and every tool call pays its own way.
  r.post('/mcp', async (req, url, p, res, body) => {
    const msgs = Array.isArray(body) ? body : [body];
    if (msgs.length > 10) throw new H.HttpError(413, 'Send at most 10 JSON-RPC messages in one request');
    const calls = msgs.filter(m => m && m.method === 'tools/call'), writes = calls.filter(m => mcp.WRITES.includes(m.params && m.params.name)).length;
    if ((writes && !req.charge('w', writes)) || (calls.length > writes && !req.charge('r', calls.length - writes))) throw new H.HttpError(429, 'Too many tool calls from here; slow down');
    const out = await mcp.handleHttp(body, req.headers);
    if (out === null) return { __status: 202, __body: '' };
    return { __headers: out.headers, __body: out.body };
  }, { mcp: true });
  r.get('/mcp', () => { throw new H.HttpError(405, 'This MCP endpoint answers POST requests with JSON; it has no event stream.'); });
  r.get('/health', () => ({ ok: true, seq: hub.seq }));

  // Which app build this hub serves, so apps elsewhere can offer an update (or let people ignore it).
  let buildCache = { mtime: -1, v: undefined };
  function appBuild() {
    const f = path.join(path.dirname(cfg.appFile), 'app-build.json');
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m !== buildCache.mtime) buildCache = { mtime: m, v: JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch (e) { buildCache = { mtime: -1, v: undefined }; }
    return buildCache.v;
  }
  let appCache = { mtime: 0, buf: null };
  const serveApp = () => {
    const st = fs.statSync(cfg.appFile);
    if (st.mtimeMs !== appCache.mtime) appCache = { mtime: st.mtimeMs, buf: fs.readFileSync(cfg.appFile) };
    return { __headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, __body: appCache.buf };
  };
  r.get('/', serveApp);
  r.get('/app', serveApp);

  // CORS: other origins may read public data and, since every item is signed, send contributions
  // (unless corsWrites is off). Never /mcp, which signs for its caller, nor local controls.
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding', 'Access-Control-Expose-Headers': 'ETag' };
  const corsFor = (method, m) => !!m && !m.allowed && !m.opts.local && !m.opts.mcp && (method !== 'POST' || cfg.corsWrites !== false);
  const crossOrigin = req => { const o = req.headers.origin; if (!o) return false; try { return new URL(o).host !== req.headers.host; } catch (e) { return true; } };
  // Peers-only field notes stay with the node's own people: never to a page from another origin.
  const sharesFor = req => (cfg.mode === 'node' && !crossOrigin(req) ? ['public', 'peers'] : ['public']);

  async function handle(req, res) {
    let cors = {};
    try {
      let url;
      try { url = new URL(req.url, 'http://local'); } catch (e) { throw new H.HttpError(400, 'Bad request path'); }
      if (req.method === 'OPTIONS') {
        const want = String(req.headers['access-control-request-method'] || 'GET').toUpperCase();
        return await H.send(req, res, 204, '', corsFor(want, r.match(want, url.pathname)) ? CORS : {});
      }
      const m = r.match(req.method, url.pathname);
      if (!m) throw new H.HttpError(404, 'Not found');
      if (m.allowed) throw new H.HttpError(405, 'Use ' + m.allowed.join(' or '));
      if (corsFor(req.method, m)) cors = CORS;
      // A JSON content type can't be sent cross-site without a preflight, so forms can't post here.
      if (req.method === 'POST' && !m.opts.local && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) throw new H.HttpError(415, 'Send JSON, with Content-Type: application/json');
      const ip = H.clientIp(req, cfg.trustProxy);
      const write = req.method === 'POST';
      // Writes spend from a small bucket per ten minutes, reads (and /mcp, which charges each
      // tool call itself) from a large one per minute.
      req.charge = (bucket, n, partial) => (bucket === 'w' ? limit.take('w:' + ip, P.writesPerTenMinutes, 600e3, n, partial) : limit.take('r:' + ip, 600, 60e3, n, partial));
      if (write && !m.opts.mcp && !req.charge('w', 1)) throw new H.HttpError(429, 'Too many submissions from here; try again in a few minutes');
      if ((!write || m.opts.mcp) && !req.charge('r', 1)) throw new H.HttpError(429, 'Too many requests; slow down');
      const body = write ? await H.readJSON(req, (m.opts.big ? P.maxBundleKB : P.maxBodyKB) * 1024) : undefined;
      const out = await m.handler(req, url, m.params, res, body);
      if (out && out.__body !== undefined) return await H.send(req, res, out.__status || 200, out.__body, Object.assign({}, cors, out.__headers || {}));
      await H.send(req, res, 200, out === undefined ? { ok: true } : out, cors);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      await H.send(req, res, status, Object.assign({ error: e.message }, e.extra || {}), cors);
    }
  }

  hub.handle = handle;
  hub.listen = () => new Promise(resolve => {
    // Nothing a request does may take the process down.
    hub.server = http.createServer((q, s) => handle(q, s).catch(e => { console.error(e); try { if (!s.headersSent) s.writeHead(500); s.end(); } catch (x) { s.destroy(); } }));
    hub.server.listen(cfg.port, cfg.host, () => resolve(hub.server.address()));
  });
  if (cfg.lora && cfg.lora.enabled) hub.lora = createBridge(hub, cfg.lora);
  if (cfg.nomad && cfg.nomad.url !== 'off' && (cfg.nomad.url || cfg.nomad.kiwix)) startNomad(hub);
  hub.close = () => { if (hub.stopSync) hub.stopSync(); if (hub.lora) hub.lora.close(); map.close(); return new Promise(res => (hub.server ? hub.server.close(() => { store.close(); res(); }) : (store.close(), res()))); };
  if (cfg.mode === 'node') startSync(hub);
  return hub;
}

module.exports = { createHub };

if (require.main === module) {
  (async () => {
    const cfg = config.load(process.argv.slice(2), process.env);
    const hub = await createHub(cfg);
    const addr = await hub.listen();
    const host = addr.address === '0.0.0.0' || addr.address === '::' ? 'localhost' : addr.address;
    console.log(`${cfg.name} (${cfg.mode}) on http://${host}:${addr.port}  ·  ${hub.seq} changes  ·  store: ${hub.store.kind}`);
    console.log(`  app  http://${host}:${addr.port}/   api  /api/v1   mcp  /mcp   hub key ${hub.hubFp}`);
    if (cfg.mode === 'hub' && !cfg.admins.length) console.log('  No admins set. Make a key with `node tools/keys.js new admin.key` and start with --admin <its admin id>.');
    const stop = () => hub.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })().catch(e => { console.error(e.message); process.exit(1); });
}

// Hostile input: requests, feeds and items crafted to crash, escape or fool a hub or node.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const SDG = require('../core');
const F = require('../lib/fsdata');
const config = require('../server/config');
const { createHub } = require('../server/hub');

// One snapshot of data/ for every hub here, so hubs and nodes agree even while data/ is edited.
const SNAP = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-snap-'));
fs.cpSync(F.DATA, SNAP, { recursive: true });
async function start(over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-sec-'));
  fs.cpSync(SNAP, path.join(dir, 'data'), { recursive: true });
  const cfg = config.load([], {}, Object.assign({ port: 0, dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state'), policy: { powBits: 4 } }, over));
  const hub = await createHub(cfg);
  const addr = await hub.listen();
  return { hub, url: `http://127.0.0.1:${addr.port}`, port: addr.port, dir };
}
async function call(url, p, body, headers) {
  const res = await fetch(url + p, body !== undefined ? { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: typeof body === 'string' ? body : JSON.stringify(body) } : { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, body: json, headers: res.headers };
}
// The same item, changed and signed by someone else (with a fresh work stamp), as a thief would.
async function resign(item, who, change) {
  const o = Object.assign(SDG.sign.strip(item, 'sig', 'author', 'pow'), change || {});
  o.pow = await SDG.sign.stamp(o, 4);
  return SDG.sign.sign(o, who);
}
// A raw request, for paths fetch() would normalise.
const raw = (port, p, method) => new Promise((ok, fail) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET' }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => ok({ status: res.statusCode, body: b })); });
  r.on('error', fail);
  r.end();
});

test('paths that cannot be parsed get a 400, and the hub stays up', async (t) => {
  const { hub, url, port } = await start();
  t.after(() => hub.close());
  for (const p of ['//', '///', '//[', '//x:99999']) assert.equal((await raw(port, p)).status, 400, p);
  assert.equal((await call(url, '/health')).body.ok, true);
});

test('record paths stay inside the data folder', () => {
  const dir = path.join(os.tmpdir(), 'sdg-x', 'data');
  assert.equal(F.fileFor(dir, 'parts', 'motor_dc'), path.join(dir, 'parts', 'motor_dc.json'));
  for (const id of ['../../X', '..', 'a/b', 'A', '', 'x.json', '_x', null, undefined, 7]) assert.throws(() => F.fileFor(dir, 'parts', id), String(id));
  for (const coll of ['../state', 'state', '__proto__', 'constructor']) assert.throws(() => F.fileFor(dir, coll, 'x'), coll);
});

// An upstream that says whatever a test wants, signed with its own key, as a hostile hub would.
async function fakeUpstream(id, routes) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const fn = routes[u.pathname];
    const body = fn ? await fn(u) : { error: 'nope' };
    res.writeHead(fn ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  routes['/api/v1/info'] = routes['/api/v1/info'] || (() => ({ hubKey: id.key }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('node: hostile upstream feeds are checked before anything touches disk', async (t) => {
  const up = await SDG.sign.createIdentity('Upstream');
  let feed = () => ({});
  const routes = { '/api/v1/sync': u => feed(u) };
  const fake = await fakeUpstream(up, routes);
  t.after(() => fake.server.close());
  const node = await start({ mode: 'node', upstream: fake.url, syncMinutes: 60 });
  t.after(() => node.hub.close());
  const seq = node.hub.seq;
  const idFile = path.join(node.dir, 'state', 'hub-identity.json');
  const cp = async (s, hash) => SDG.changes.signCheckpoint(s, hash, up);
  const sync = async () => { const r = await node.hub.syncNow(); return r; };
  const part = SDG.util.clone(node.hub.dataset().parts[0]);

  // Path traversal through a record id, and a delete aimed at the node's identity.
  feed = async () => ({ head: seq + 1, entries: [{ seq: seq + 1, coll: 'parts', rid: part.id, op: 'put', data: Object.assign({}, part, { id: '../../X' }) }], checkpoint: await cp(seq + 1, 'x') });
  assert.equal((await sync()).ok, false);
  assert.ok(!fs.existsSync(path.join(node.dir, 'X.json')));
  feed = async () => ({ head: seq + 1, entries: [{ seq: seq + 1, coll: 'parts', rid: '../../state/hub-identity', op: 'delete' }], checkpoint: await cp(seq + 1, 'x') });
  assert.equal((await sync()).ok, false);
  assert.ok(fs.existsSync(idFile), 'identity still there');

  // A good-looking change with no checkpoint, or one signed by another key, is not applied.
  const changed = Object.assign({}, part, { summary: 'Changed by upstream' });
  const entry = { seq: seq + 1, coll: 'parts', rid: part.id, op: 'put', data: changed };
  feed = () => ({ head: seq + 1, entries: [entry] });
  assert.match((await sync()).error, /checkpoint/);
  const other = await SDG.sign.createIdentity('Other');
  feed = async () => ({ head: seq + 1, entries: [entry], checkpoint: await SDG.changes.signCheckpoint(seq + 1, 'x', other) });
  assert.match((await sync()).error, /checkpoint/);
  // Schema problems are refused too.
  feed = async () => ({ head: seq + 1, entries: [Object.assign({}, entry, { data: Object.assign({}, changed, { demand: 'lots' }) })], checkpoint: await cp(seq + 1, 'x') });
  assert.match((await sync()).error, /bad entry/);
  assert.equal(node.hub.seq, seq);
  assert.notEqual(F.readJSON(F.fileFor(node.hub.cfg.dataDir, 'parts', part.id)).summary, 'Changed by upstream');

  // The same change with a checkpoint that matches is applied.
  const expect = await SDG.changes.datasetHash(SDG.changes.applyLedger(SDG.util.clone(F.plain(node.hub.dataset())), [entry]));
  feed = async () => ({ head: seq + 1, entries: [entry], checkpoint: await cp(seq + 1, expect) });
  const ok = await sync();
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(node.hub.seq, seq + 1);
  assert.equal(F.readJSON(F.fileFor(node.hub.cfg.dataDir, 'parts', part.id)).summary, 'Changed by upstream');

  // A checkpoint that doesn't match means a full release, never the unverified entries.
  const entry2 = { seq: seq + 2, coll: 'parts', rid: part.id, op: 'put', data: Object.assign({}, part, { summary: 'Unverified' }) };
  let release = null;
  routes['/api/v1/release'] = () => release;
  const rel = async (s, ds) => SDG.changes.signRelease(await SDG.changes.makeRelease(ds, s), up);
  const base = SDG.util.clone(F.plain(node.hub.dataset()));
  release = await rel(seq + 2, Object.assign({}, base, { parts: base.parts.map(p => (p.id === part.id ? Object.assign({}, p, { summary: 'From the release' }) : p)) }));
  feed = async () => ({ head: seq + 2, entries: [entry2], checkpoint: await cp(seq + 2, 'mismatch') });
  const r2 = await sync();
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.report.reset, true);
  assert.equal(F.readJSON(F.fileFor(node.hub.cfg.dataDir, 'parts', part.id)).summary, 'From the release');

  // A release with a hostile record id is refused whole.
  release = await rel(seq + 3, Object.assign({}, base, { parts: [...base.parts, Object.assign({}, part, { id: '../../Y' })] }));
  feed = async () => ({ head: seq + 3, entries: [Object.assign({}, entry2, { seq: seq + 3 })], checkpoint: await cp(seq + 3, 'mismatch') });
  assert.equal((await sync()).ok, false);
  assert.ok(!fs.existsSync(path.join(node.dir, 'Y.json')));

  // Rollback: an older reset or release is refused unless the operator allows it.
  release = await rel(1, base);
  feed = async () => ({ reset: true, head: 1, checkpoint: await cp(1, release.hash) });
  assert.match((await sync()).error, /older/);
  assert.equal(node.hub.seq, seq + 2);
  node.hub.cfg.allowRollback = true;
  assert.equal((await sync()).ok, true);
  assert.equal(node.hub.seq, 1);
});

test('the validator ignores nothing on the prototype, and refuses prototype keys', async () => {
  const part = SDG.util.clone(F.plain(F.load()).parts[0]);
  for (const k of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) assert.equal(SDG.schema.validateRecord('parts', Object.assign({}, part, { [k]: 'x' })).ok, false, k);
  const proto = JSON.parse(`{"id":"p1","coll":"parts","rid":"${part.id}","op":"put","created":"2026-11-12T00:00:00.000Z","data":{"name":"x","__proto__":{"summary":"polluted"}}}`);
  assert.ok(SDG.schema.validate('proposal', proto).errors.some(e => e.path === 'data.__proto__'));
  assert.equal(SDG.schema.validateRecord('parts', JSON.parse(`{"id":"x","name":"x","prototype":1}`)).ok, false);
  // Network JSON loses those keys on the way in.
  assert.deepEqual(Object.keys(SDG.util.parse('{"a":1,"__proto__":{"b":2},"c":{"constructor":3}}')), ['a', 'c']);
  // An own __proto__ key is covered by the signature, not turned into a prototype.
  const me = await SDG.sign.createIdentity('Me');
  const signed = await SDG.sign.sign({ id: 'x', body: 'hi' }, me);
  const added = JSON.parse(JSON.stringify(signed).replace('{', '{"__proto__":{"evil":1},'));
  assert.equal(await SDG.sign.verify(added), false);
  assert.equal(SDG.sign.strip(added, 'sig').evil, undefined);
  // Files never get inherited fields.
  const rec = Object.assign(Object.create({ summary: 'inherited' }), { id: 'x', name: 'X' });
  assert.ok(!F.format('parts', rec).includes('inherited'));
  // Item ids and source links have a shape.
  assert.equal(SDG.schema.validate('proposal', Object.assign({}, proto, { id: '"><img src=x onerror=alert(1)>', data: { name: 'x' } })).ok, false);
  assert.ok(SDG.schema.validate('comment', { id: 'lq8x2k3m0-4f9a2c7d', target: 'parts/x', body: 'b', created: '2026-11-12T00:00:00.000Z' }).ok);
  const model = F.plain(F.load()).models.find(m => (m.sources || []).length);
  assert.ok(SDG.schema.validateRecord('models', model).ok);
  assert.equal(SDG.schema.validateRecord('models', Object.assign({}, model, { sources: [{ title: 't', url: 'javascript:alert(1)' }] })).ok, false);
});

test('hub: prototype keys in a proposal never reach the data', async (t) => {
  const admin = await SDG.sign.createIdentity('Admin');
  const { hub, url } = await start({ admins: [admin.key] });
  t.after(() => hub.close());
  const part = SDG.util.clone(hub.dataset().parts[0]);
  const p = await SDG.changes.makeProposal({ coll: 'parts', rid: part.id, op: 'put', data: part, reason: 'x' });
  const text = JSON.stringify(Object.assign(p, { data: JSON.parse(JSON.stringify(part).replace('{', '{"__proto__":{"notes":"polluted"},')) }));
  const signed = await SDG.sign.sign(JSON.parse(text), admin);
  const r = await call(url, '/api/v1/proposals', JSON.stringify(signed).replace('"data":{', '"data":{"__proto__":{"notes":"polluted"},'));
  assert.notEqual(r.status, 200);
  assert.ok(!fs.readFileSync(F.fileFor(hub.cfg.dataDir, 'parts', part.id), 'utf8').includes('polluted'));
  // Keys like toString are unknown fields like any other, whatever is on Object.prototype.
  const bad = await SDG.sign.sign(Object.assign({}, p, { data: Object.assign({}, part, { toString: 'x' }) }), admin);
  assert.equal((await call(url, '/api/v1/proposals', bad)).status, 422);
});

test('moderation messages fit one endpoint, are fresh, and work once', async (t) => {
  const admin = await SDG.sign.createIdentity('Admin');
  const mod = await SDG.sign.createIdentity('Mod');
  const alice = await SDG.sign.createIdentity('Alice');
  const { hub, url } = await start({ admins: [admin.key], policy: { powBits: 4, approvals: 2 } });
  t.after(() => hub.close());
  const signed = (o, who) => SDG.sign.sign(Object.assign({ created: SDG.util.now(), hub: hub.identity.key }, o), who || admin);
  const ago = ms => new Date(Date.now() - ms).toISOString();

  // Every moderation message names the hub it is for.
  const other = await SDG.sign.createIdentity('Another hub');
  assert.equal((await call(url, '/api/v1/roles', await signed({ action: 'set-role', key: mod.key, role: 'moderator', hub: other.key }))).status, 422, 'signed for another hub');
  assert.equal((await call(url, '/api/v1/roles', await signed({ action: 'set-role', key: mod.key, role: 'moderator', hub: undefined }))).status, 422, 'no hub named');

  // Roles: the action and a fresh date are required, a role name must be a real role, and a
  // message works once.
  assert.equal((await call(url, '/api/v1/roles', await signed({ key: mod.key, role: 'moderator' }))).status, 422);
  assert.equal((await call(url, '/api/v1/roles', await signed({ action: 'set-role', key: mod.key, role: 'toString' }))).status, 422);
  assert.equal((await call(url, '/api/v1/roles', await signed({ action: 'set-role', key: mod.key, role: 'moderator', created: ago(11 * 60e3) }))).status, 422);
  assert.equal((await call(url, '/api/v1/roles', await signed({ action: 'set-role', key: mod.key, role: 'moderator', created: new Date(Date.now() + 6 * 60e3).toISOString() }))).status, 422);
  const promote = await signed({ action: 'set-role', key: mod.key, role: 'moderator' });
  assert.equal((await call(url, '/api/v1/roles', promote)).status, 200);
  assert.equal((await call(url, '/api/v1/roles', await signed({ action: 'set-role', key: mod.key, role: 'contributor' }))).status, 200);
  assert.equal((await call(url, '/api/v1/roles', promote)).status, 409, 'an old promotion cannot be replayed');
  assert.equal((await call(url, '/api/v1/users/' + mod.key)).body.role, 'contributor');
  assert.equal((await call(url, '/api/v1/roles', await signed({ action: 'set-role', key: mod.key, role: 'moderator' }))).status, 200);

  // A moderator's review is public; it can't hide a comment or be used twice.
  const part = hub.dataset().parts[0];
  const p = await SDG.changes.makeProposal({ coll: 'parts', rid: part.id, op: 'put', data: Object.assign({}, part, { summary: 'Better summary' }), reason: 'x' }, alice, 4);
  assert.equal((await call(url, '/api/v1/proposals', p)).body.status, 'pending');
  const c = await SDG.changes.makeComment('parts/' + part.id, 'Nice', null, alice, 4);
  assert.equal((await call(url, '/api/v1/comments', c)).body.status, 'stored');
  // A review names the hash of the proposal its moderator saw, and works only for that proposal.
  const hash = await SDG.changes.proposalHash((await call(url, '/api/v1/proposals/' + p.id)).body.proposal);
  assert.equal((await call(url, `/api/v1/proposals/${p.id}/review`, await signed({ action: 'review', proposal: p.id, decision: 'accept' }, mod))).status, 409, 'no hash');
  const swapped = await SDG.changes.proposalHash(Object.assign({}, p, { reason: 'Fix a typo' }));
  assert.equal((await call(url, `/api/v1/proposals/${p.id}/review`, await signed({ action: 'review', proposal: p.id, hash: swapped, decision: 'accept' }, mod))).status, 409, 'a different proposal than the one stored');
  const rv = await signed({ action: 'review', proposal: p.id, hash, decision: 'accept' }, mod);
  assert.equal((await call(url, `/api/v1/proposals/${p.id}/review`, rv)).body.approvals, 1);
  const pub = (await call(url, '/api/v1/proposals/' + p.id)).body.reviews[0];
  assert.equal((await call(url, `/api/v1/comments/${c.id}/hide`, pub)).status, 422);
  assert.equal((await call(url, `/api/v1/proposals/${p.id}/review`, pub)).status, 409);
  assert.equal((await call(url, `/api/v1/proposals/${p.id}/review`, await signed({ proposal: p.id, decision: 'accept' }, mod))).status, 422, 'no action');
  assert.equal((await call(url, `/api/v1/comments/${c.id}/hide`, await signed({ action: 'hide-comment', comment: 'other', hidden: true }, mod))).status, 422, 'wrong target');
  assert.equal((await call(url, `/api/v1/comments/${c.id}/hide`, await signed({ action: 'hide-comment', comment: c.id, hidden: true }, mod))).body.hidden, true);
  assert.equal((await call(url, '/api/v1/comments?target=parts/' + part.id)).body.length, 0);
});

test('unsigned items carry no author, and taken ids are conflicts', async (t) => {
  const admin = await SDG.sign.createIdentity('Admin');
  const alice = await SDG.sign.createIdentity('Alice');
  const mallory = await SDG.sign.createIdentity('Mallory');
  assert.deepEqual((await SDG.changes.verifyItems([{ id: 'x1', target: 'parts/x', body: 'b', created: '2026-11-12T00:00:00.000Z' }], 'comments')).bad.map(b => b.why), ['not signed']);

  // A hub that takes unsigned items never takes a role, or a name, from them.
  const open = await start({ admins: [admin.key], policy: { powBits: 4, requireSignature: false } });
  t.after(() => open.hub.close());
  const part = open.hub.dataset().parts[0];
  const draft = { coll: 'parts', rid: part.id, op: 'put', data: Object.assign({}, part, { summary: 'Claims to be the admin' }), reason: 'x' };
  const fake = await SDG.changes.makeProposal(draft, null, 4);
  fake.author = { key: admin.key, name: 'Admin' };
  const r = await call(open.url, '/api/v1/proposals', fake);
  assert.equal(r.body.status, 'pending', 'not auto-accepted as the admin');
  assert.equal((await call(open.url, '/api/v1/proposals/' + fake.id)).body.proposal.author, undefined);

  // Front-running: someone else's item with the same id is refused, not taken as a duplicate.
  const { hub, url } = await start({ admins: [admin.key] });
  t.after(() => hub.close());
  const mine = await SDG.changes.makeProposal(draft, alice, 4);
  const theirs = await resign(mine, mallory, { reason: 'first!' });
  assert.equal((await call(url, '/api/v1/proposals', theirs)).body.status, 'pending');
  const clash = await call(url, '/api/v1/proposals', mine);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.idConflict, true);
  assert.equal((await call(url, '/api/v1/proposals', theirs)).body.duplicate, true, 'the same author again is a duplicate');
  const c = await SDG.changes.makeComment('parts/' + part.id, 'Mine', null, alice, 4);
  const cTheirs = await resign(c, mallory, { body: 'Theirs' });
  assert.equal((await call(url, '/api/v1/comments', cTheirs)).body.status, 'stored');
  assert.equal((await call(url, '/api/v1/comments', c)).status, 409);

  // A node keeps such an item queued and reports it, instead of calling it sent.
  const node = await start({ mode: 'node', upstream: url, syncMinutes: 60 });
  t.after(() => node.hub.close());
  await node.hub.syncNow();
  const p2 = await SDG.changes.makeProposal(Object.assign({}, draft, { reason: 'second' }), alice, 4);
  assert.equal((await call(url, '/api/v1/proposals', await resign(p2, mallory))).body.status, 'pending');
  assert.equal((await call(node.url, '/api/v1/proposals', p2)).body.status, 'queued');
  const st = await node.hub.syncNow();
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.deepEqual(st.report.conflicts.map(x => x.id), [p2.id]);
  assert.equal(node.hub.store.outboxList('proposals').length, 1);
  assert.equal(node.hub.store.getProposal(p2.id).status, 'queued');
});

test('sync pages by when the hub got things, not by dates senders chose', async (t) => {
  const alice = await SDG.sign.createIdentity('Alice');
  const { hub, url } = await start({ policy: { powBits: 4, maxCommentsPerTarget: 3 } });
  t.after(() => hub.close());
  const target = 'parts/' + hub.dataset().parts[0].id;
  const comment = async (body, created) => {
    const c = { id: SDG.util.newId(), target, body, created: created || SDG.util.now() };
    c.pow = await SDG.sign.stamp(c, 4);
    return SDG.sign.sign(c, alice);
  };
  for (const bad of ['9999-12-31T00:00:00.000Z', new Date(Date.now() + 2 * 864e5).toISOString(), '~', '2026-11-12']) assert.equal((await call(url, '/api/v1/comments', await comment('x', bad))).status, 422, bad);

  // A node that has synced still gets a comment its sender backdated.
  const node = await start({ mode: 'node', upstream: url, syncMinutes: 60 });
  t.after(() => node.hub.close());
  assert.equal((await call(url, '/api/v1/comments', await comment('first'))).body.status, 'stored');
  await node.hub.syncNow();
  assert.equal((await call(node.url, '/api/v1/comments')).body.length, 1);
  assert.equal((await call(url, '/api/v1/comments', await comment('backdated', '2020-01-01T00:00:00.000Z'))).body.status, 'stored');
  await node.hub.syncNow();
  const onNode = (await call(node.url, '/api/v1/comments')).body;
  assert.deepEqual(onNode.map(c => c.body), ['first', 'backdated']);
  // An app paging the node by received sees both, in the order the node got them.
  const all = (await call(node.url, '/api/v1/comments?since=' + encodeURIComponent(onNode[0].received))).body;
  assert.deepEqual(all.map(c => c.body), ['backdated']);

  // A full record refuses new comments and keeps every old one.
  assert.equal((await call(url, '/api/v1/comments', await comment('third'))).body.status, 'stored');
  const full = await call(url, '/api/v1/comments', await comment('fourth'));
  assert.equal(full.status, 409);
  assert.match(full.body.error, /limit/);
  assert.deepEqual((await call(url, '/api/v1/comments?target=' + target)).body.map(c => c.body), ['first', 'backdated', 'third']);

  // Observations get a received time too.
  const o = await SDG.changes.makeObservation({ lat: 45.4, lon: -75.7, status: 'cleared', share: 'public' }, alice);
  assert.equal((await call(url, '/api/v1/observations', o)).status, 428, 'a newcomer needs a work stamp (and can now give one)');
});

test('limits: items per request, per-item write budget, query sizes, MCP batches and writes', async (t) => {
  const alice = await SDG.sign.createIdentity('Alice');
  const { hub, url } = await start({ policy: { powBits: 4, writesPerTenMinutes: 6 } });
  t.after(() => hub.close());
  const part = hub.dataset().parts[0];
  const prop = i => SDG.changes.makeProposal({ coll: 'parts', rid: part.id, op: 'put', data: Object.assign({}, part, { summary: 'Take ' + i }), reason: 'x' }, alice, 4);

  assert.equal((await call(url, '/api/v1/proposals', await Promise.all(Array.from({ length: 21 }, (_, i) => prop(i))))).status, 413);
  const many = await call(url, '/api/v1/proposals', await Promise.all(Array.from({ length: 8 }, (_, i) => prop(i))));
  assert.deepEqual(many.body.map(x => x.status), [...Array(5).fill('pending'), ...Array(3).fill(429)], 'the 413 spent one token, so five of eight fit');
  assert.equal((await call(url, '/api/v1/comments', await SDG.changes.makeComment('parts/' + part.id, 'x', null, alice, 4))).status, 429);
  const big = { format: 'sdg-bundle', v: 1, comments: Array.from({ length: 2001 }, (_, i) => ({ id: 'c' + i })) };
  assert.equal((await call(url, '/api/v1/bundle', big)).status, 429, 'the budget is spent before the body is read');

  // Reads: limits are clamped, and text queries are capped.
  assert.equal((await call(url, '/api/v1/search?q=' + 'motor '.repeat(40))).status, 400);
  assert.equal((await call(url, '/api/v1/records/parts?q=' + 'x'.repeat(201))).status, 400);
  assert.equal((await call(url, '/api/v1/search?q=motor&limit=-1')).body.bestDevices.length, 10);
  assert.ok((await call(url, '/api/v1/proposals?limit=-1')).body.length <= 100);
  assert.equal((await call(url, '/api/v1/proposals?limit=2')).body.length, 2);
  assert.equal((await call(url, '/api/v1/proposals/' + many.body[0].id)).body.problems.length, 0);

  // MCP: at most 10 messages per request; string arguments are short.
  const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  const fresh = await start({ policy: { powBits: 4, writesPerTenMinutes: 3 } });
  t.after(() => fresh.hub.close());
  assert.equal((await call(fresh.url, '/mcp', Array.from({ length: 11 }, (_, i) => rpc(i, 'ping')))).status, 413);
  const long = (await call(fresh.url, '/mcp', rpc(1, 'tools/call', { name: 'scrap_search', arguments: { query: 'x'.repeat(300) } }))).body.result;
  assert.equal(long.isError, true);
  // Each tool call is charged: four comments against a budget of three are refused together.
  const comments = Array.from({ length: 4 }, (_, i) => rpc(i, 'tools/call', { name: 'add_comment', arguments: { collection: 'parts', id: part.id, body: 'AI note ' + i } }));
  assert.equal((await call(fresh.url, '/mcp', comments)).status, 429);
  assert.equal((await call(fresh.url, '/mcp', comments.slice(0, 3))).body.filter(x => !x.result.isError).length, 3);

  // Writes over HTTP are opt-in: off for a public hub unless the operator turns them on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-sec-'));
  const pub = await createHub(config.load(['--public'], {}, { dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state') }));
  assert.equal(pub.mcpWrite, false);
  await pub.close();
  const ro = await start({ mcpWrite: false });
  t.after(() => ro.hub.close());
  const tools = (await call(ro.url, '/mcp', rpc(1, 'tools/list'))).body.result.tools.map(x => x.name);
  assert.ok(tools.includes('scrap_search') && !tools.includes('propose_change') && !tools.includes('add_comment'));
  assert.match((await call(ro.url, '/mcp', rpc(2, 'tools/call', { name: 'add_comment', arguments: { collection: 'parts', id: part.id, body: 'x' } }))).body.result.content[0].text, /read-only/);
});

test('client address, CORS, JSON-only writes and the local sync control', async (t) => {
  const H = require('../server/http');
  const req = (xff, remote) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote || '10.0.0.1' } });
  assert.equal(H.clientIp(req('6.6.6.6, 1.2.3.4'), true), '1.2.3.4', 'the address the proxy saw, not what the client wrote');
  assert.equal(H.clientIp(req('6.6.6.6, 1.2.3.4, 10.9.9.9'), 2), '1.2.3.4');
  assert.equal(H.clientIp(req('6.6.6.6'), false), '10.0.0.1');
  assert.equal(H.clientIp(req(''), true), '10.0.0.1');

  const alice = await SDG.sign.createIdentity('Alice');
  const { hub, url } = await start({ trustProxy: true, policy: { powBits: 4, writesPerTenMinutes: 2 } });
  t.after(() => hub.close());
  const part = hub.dataset().parts[0];
  const post = async (spoof) => call(url, '/api/v1/comments', await SDG.changes.makeComment('parts/' + part.id, 'x', null, alice, 4), { 'X-Forwarded-For': spoof + ', 9.9.9.9' });
  assert.equal((await post('1.1.1.1')).status, 200);
  assert.equal((await post('2.2.2.2')).status, 200);
  assert.equal((await post('3.3.3.3')).status, 429, 'a made-up leftmost address does not buy a new budget');

  // CORS: public reads and signed contributions, never /mcp; forms can't post at all.
  const pre = (p, method) => fetch(url + p, { method: 'OPTIONS', headers: { Origin: 'http://elsewhere.example', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal((await pre('/api/v1/bundle', 'POST')).headers.get('access-control-allow-origin'), '*');
  assert.equal((await pre('/mcp', 'POST')).headers.get('access-control-allow-origin'), null);
  assert.equal((await pre('/api/v1/sync/now', 'POST')).headers.get('access-control-allow-origin'), null);
  assert.equal((await call(url, '/api/v1/info')).headers.get('access-control-allow-origin'), '*');
  const local = await start();
  t.after(() => local.hub.close());
  assert.equal((await call(local.url, '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).headers.get('access-control-allow-origin'), null);
  const form = await fetch(local.url + '/api/v1/comments', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  assert.equal((await fetch(local.url + '/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 415);
  const closed = await start({ corsWrites: false });
  t.after(() => closed.hub.close());
  const pre2 = await fetch(closed.url + '/api/v1/bundle', { method: 'OPTIONS', headers: { Origin: 'http://elsewhere.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre2.headers.get('access-control-allow-origin'), null);

  // Sync now needs this machine and the token in the state folder.
  const node = await start({ mode: 'node', upstream: local.url, syncMinutes: 60 });
  t.after(() => node.hub.close());
  const token = fs.readFileSync(path.join(node.dir, 'state', 'control-token'), 'utf8').trim();
  assert.equal((await call(node.url, '/api/v1/sync/now', {})).status, 403);
  assert.equal((await call(node.url, '/api/v1/sync/now', {}, { Authorization: 'Bearer nope' })).status, 403);
  assert.equal((await call(node.url, '/api/v1/sync/now', {}, { Authorization: 'Bearer ' + token })).body.ok, true);

  // Peers-only notes on a node never go to a page from another origin.
  const o = await SDG.changes.makeObservation({ lat: 45.4, lon: -75.7, status: 'cleared', share: 'peers' }, alice);
  node.hub.store.putObservation(Object.assign({}, o, { received: SDG.util.now() }));
  assert.equal((await call(node.url, '/api/v1/observations')).body.length, 1);
  assert.equal((await call(node.url, '/api/v1/observations', undefined, { Origin: 'http://elsewhere.example' })).body.length, 0);
});

test('field notes from newcomers can carry the work stamp the hub asks for', async (t) => {
  const alice = await SDG.sign.createIdentity('Alice');
  const { hub, url } = await start({ policy: { powBits: 4 } });
  t.after(() => hub.close());
  const f = { lat: 45.4, lon: -75.7, status: 'partial', share: 'public', label: 'Hardware store' };
  assert.equal((await call(url, '/api/v1/observations', await SDG.changes.makeObservation(f, alice))).status, 428);
  const r = await call(url, '/api/v1/observations', await SDG.changes.makeObservation(f, alice, 4, 4));
  assert.equal(r.body.status, 'stored', JSON.stringify(r.body));
  const got = (await call(url, '/api/v1/observations')).body;
  assert.equal(got.length, 1);
  assert.ok(got[0].received);
  // So can the ones an AI logs through /mcp, which the hub stamps itself.
  const res = (await call(url, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_observation', arguments: { lat: 45.5, lon: -75.6, status: 'cleared', share: 'public' } } })).body.result;
  assert.ok(!res.isError, res.content[0].text);
  assert.equal((await call(url, '/api/v1/observations')).body.length, 2);
});

test('admins are named by their whole key or 128 bits of its hash, never a 64-bit fingerprint', async (t) => {
  const admin = await SDG.sign.createIdentity('Admin');
  const role = async admins => {
    const { hub, url } = await start({ admins });
    t.after(() => hub.close());
    return (await call(url, '/api/v1/users/' + admin.key)).body.role;
  };
  assert.equal(await role([await SDG.sign.fingerprint(admin.key)]), 'contributor');
  assert.equal(await role([await SDG.sign.fingerprint(admin.key, 32)]), 'admin');
  assert.equal(await role([admin.key]), 'admin');
});

test('DNS rebinding, note rollback, hides that travel, framing, private state and slow clients', async (t) => {
  const alice = await SDG.sign.createIdentity('Alice');
  const mod = await SDG.sign.createIdentity('Mod');
  const { hub, url, port, dir } = await start({ admins: [mod.key] });
  t.after(() => hub.close());
  // fetch() won't set Host, so these go out raw.
  const req = (p, headers, body, to) => new Promise((ok, fail) => {
    const r = http.request({ host: '127.0.0.1', port: to || port, path: p, method: body === undefined ? 'GET' : 'POST', headers: Object.assign(body === undefined ? {} : { 'Content-Type': 'application/json' }, headers) }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* not JSON */ } ok({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    r.on('error', fail);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });

  // A page that rebinds its own public name to this hub can't use the AI write tools, which sign
  // as the hub, and /mcp checks Origin; a local tool's page still can call.
  const write = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_comment', arguments: {} } };
  assert.equal((await req('/mcp', { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` }, write)).status, 403);
  assert.equal((await req('/mcp', { Host: `attacker.example:${port}` }, write)).status, 403, 'no Origin, but a public name');
  assert.equal((await req('/mcp', { Host: `127.0.0.1:${port}`, 'X-Forwarded-For': '6.6.6.6' }, write)).status, 403, 'passed on by a proxy the hub was not told about');
  assert.equal((await req('/mcp', { Origin: 'http://attacker.example' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 403);
  assert.equal((await req('/mcp', { Host: `localhost:${port}`, Origin: 'http://localhost:6274' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);

  // Peers-only notes on a node: by its address, a one-word LAN name or a configured name, never a
  // rebound public one.
  const node = await start({ mode: 'node', upstream: url, syncMinutes: 60, hostnames: ['guide.example.org'] });
  t.after(() => node.hub.close());
  const peers = await SDG.changes.makeObservation({ lat: 45.4, lon: -75.7, status: 'cleared', share: 'peers' }, alice);
  node.hub.store.putObservation(Object.assign({}, peers, { received: SDG.util.now() }));
  const notes = async host => (await req('/api/v1/observations', { Host: `${host}:${node.port}` }, undefined, node.port)).body.length;
  assert.equal(await notes('127.0.0.1'), 1);
  assert.equal(await notes('nomad_guide'), 1);
  assert.equal(await notes('pi.local'), 1);
  assert.equal(await notes('guide.example.org'), 1);
  assert.equal(await notes('attacker.example'), 0);

  // A field note only moves forward: its own old signed copy, sent again, changes nothing.
  const v1 = await SDG.changes.makeObservation({ lat: 45.4, lon: -75.7, status: 'untouched', share: 'public' }, alice, null, 4);
  assert.equal((await call(url, '/api/v1/observations', v1)).body.status, 'stored');
  const v2 = await resign(v1, alice, { status: 'dangerous', notes: 'gas leak', created: new Date(Date.parse(v1.created) + 1000).toISOString() });
  assert.equal((await call(url, '/api/v1/observations', v2)).body.status, 'stored');
  assert.equal((await call(url, '/api/v1/observations', v1)).body.duplicate, true);
  assert.equal(hub.store.getObservation(v1.id).status, 'dangerous');

  // A hidden comment leaves the public lists, and the feed tells copies elsewhere, as a tombstone.
  const part = hub.dataset().parts[0];
  const c = await SDG.changes.makeComment('parts/' + part.id, 'Test it with a wet finger', null, alice, 4);
  assert.equal((await call(url, '/api/v1/comments', c)).body.status, 'stored');
  const feed1 = (await call(url, '/api/v1/comments?since=2000-01-01T00:00:00.000Z')).body;
  assert.equal(feed1.length, 1);
  const hide = await SDG.sign.sign({ action: 'hide-comment', comment: c.id, hidden: true, hub: hub.identity.key, created: SDG.util.now() }, mod);
  assert.equal((await call(url, `/api/v1/comments/${c.id}/hide`, hide)).body.hidden, true);
  const feed2 = (await call(url, '/api/v1/comments?since=' + encodeURIComponent(feed1[0].received))).body;
  assert.deepEqual(feed2.map(x => [x.id, x.hidden, x.text]), [[c.id, true, undefined]]);
  assert.equal((await call(url, '/api/v1/comments?target=parts/' + part.id)).body.length, 0);

  // The app can't be framed by another site; the state folder is this user's alone; half-sent
  // requests time out.
  const app = await req('/');
  assert.equal(app.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(app.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(fs.statSync(path.join(dir, 'state')).mode & 0o777, 0o700);
  const db = path.join(dir, 'state', 'hub.sqlite');
  if (fs.existsSync(db)) assert.equal(fs.statSync(db).mode & 0o777, 0o600);
  assert.equal(hub.server.headersTimeout, 15e3);
  assert.equal(hub.server.requestTimeout, 120e3);
  // IPv6 callers share a budget per /64.
  const H = require('../server/http');
  assert.equal(H.bucketOf('2001:db8:1:2::9'), H.bucketOf('2001:db8:1:2:ffff:1:2:3'));
  assert.equal(H.bucketOf('::ffff:1.2.3.4'), '1.2.3.4');
});

// End-to-end: contributor → hub moderation → accepted change → sync feed → node mirror → MCP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SDG = require('../core');
const F = require('../lib/fsdata');
const config = require('../server/config');
const { createHub } = require('../server/hub');
const { syncOnce } = require('../server/sync');

function tmpCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-test-'));
  fs.cpSync(F.DATA, path.join(dir, 'data'), { recursive: true });
  return dir;
}
async function start(over) {
  const dir = tmpCopy();
  const cfg = config.load([], {}, Object.assign({ port: 0, dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state'), policy: { powBits: 4 } }, over));
  const hub = await createHub(cfg);
  const addr = await hub.listen();
  return { hub, url: `http://127.0.0.1:${addr.port}`, dir };
}
async function call(url, p, body) {
  const res = await fetch(url + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: res.status, body: await res.json() };
}

test('hub: propose, moderate, sync, mirror, MCP', async (t) => {
  const admin = await SDG.sign.createIdentity('Test admin');
  const alice = await SDG.sign.createIdentity('Alice');
  const { hub, url } = await start({ admins: [await SDG.sign.fingerprint(admin.key, 32)] });
  t.after(() => hub.close());

  const info = (await call(url, '/api/v1/info')).body;
  assert.equal(info.mode, 'hub');
  const seq0 = info.seq;

  const s = (await call(url, '/api/v1/search?q=treadmill%20motor')).body;
  assert.ok(s.bestDevices.length > 0, 'search returns devices');

  // Unsigned is refused; signed without a work stamp is refused for a newcomer.
  const draft = { coll: 'models', rid: 'treadmill_test_tm100', op: 'put', reason: 'Opened one', data: { device: 'treadmill', brand: 'Test', model: 'TM100', comps: [{ key: 'motor_dc_large', conf: 'verified', spec: '130V DC, 2.5 hp' }] } };
  const unsigned = await SDG.changes.makeProposal(draft);
  assert.equal((await call(url, '/api/v1/proposals', unsigned)).status, 401);
  const noPow = await SDG.changes.makeProposal(draft, alice);
  assert.equal((await call(url, '/api/v1/proposals', noPow)).status, 428);

  const good = await SDG.changes.makeProposal(draft, alice, 4);
  const r1 = await call(url, '/api/v1/proposals', good);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.status, 'pending');

  // Tampering breaks the signature.
  const tampered = Object.assign({}, await SDG.changes.makeProposal(draft, alice, 4), { reason: 'changed in transit' });
  assert.equal((await call(url, '/api/v1/proposals', tampered)).status, 401);

  // A broken reference is refused with errors.
  const bad = await SDG.changes.makeProposal(Object.assign({}, draft, { rid: 'bad_ref', data: Object.assign({}, draft.data, { device: 'no_such_device' }) }), alice, 4);
  const rb = await call(url, '/api/v1/proposals', bad);
  assert.equal(rb.status, 422);
  assert.ok(rb.body.errors.some(e => /no_such_device/.test(e.msg)));

  // Alice can't review; the admin can.
  const detail = (await call(url, `/api/v1/proposals/${good.id}`)).body;
  assert.ok(detail.diff.length > 0);
  const hash = await SDG.changes.proposalHash(detail.proposal);
  assert.equal(hash, await SDG.changes.proposalHash(good), 'the hash covers what the author signed, not what the hub keeps beside it');
  const aliceReview = await SDG.sign.sign({ action: 'review', proposal: good.id, hash, hub: hub.identity.key, decision: 'accept', created: SDG.util.now() }, alice);
  assert.equal((await call(url, `/api/v1/proposals/${good.id}/review`, aliceReview)).status, 403);
  const review = await SDG.sign.sign({ action: 'review', proposal: good.id, hash, hub: hub.identity.key, decision: 'accept', note: 'looks right', created: SDG.util.now() }, admin);
  const r2 = await call(url, `/api/v1/proposals/${good.id}/review`, review);
  assert.equal(r2.body.status, 'accepted', JSON.stringify(r2.body));
  assert.equal(r2.body.seq, seq0 + 1);

  // The record is on disk with a revision, and the sync feed has it.
  const onDisk = F.readJSON(path.join(hub.cfg.dataDir, 'models', 'treadmill_test_tm100.json'));
  assert.equal(onDisk.rev, 1);
  const feed = (await call(url, `/api/v1/sync?since=${seq0}`)).body;
  assert.equal(feed.entries.length, 1);
  assert.ok(await SDG.changes.verifyCheckpoint(feed.checkpoint));

  // Confidence now shows up in search.
  const dev = (await call(url, '/api/v1/records/devices/treadmill?resolved=1')).body;
  assert.ok(dev.comps.some(c => c.key === 'motor_dc_large'));

  // Comments, with the comments switch respected.
  const c = await SDG.changes.makeComment('devices/treadmill', 'Incline motor makes a decent winch.', null, alice, 4);
  assert.equal((await call(url, '/api/v1/comments', c)).body.status, 'stored');
  assert.equal((await call(url, '/api/v1/comments?target=devices/treadmill')).body.length, 1);

  // A release verifies against the hub key.
  const rel = (await call(url, '/api/v1/release')).body;
  const v = await SDG.changes.verifyRelease(rel, [info.hubKey]);
  assert.ok(v.hashOk && v.trusted);

  // A node mirrors the hub and forwards its contributions upstream.
  const node = await start({ mode: 'node', upstream: url, syncMinutes: 60 });
  t.after(() => node.hub.close());
  await node.hub.syncNow();
  assert.equal(node.hub.seq, seq0 + 1, JSON.stringify(node.hub.syncState));
  const fromNode = await SDG.changes.makeProposal(Object.assign({}, draft, { rid: 'treadmill_test_tm200', data: Object.assign({}, draft.data, { model: 'TM200' }) }), alice, 4);
  assert.equal((await call(node.url, '/api/v1/proposals', fromNode)).body.status, 'queued');
  const rep = await syncOnce(node.hub);
  assert.equal(rep.pushed.proposals, 1);
  assert.equal((await call(url, `/api/v1/proposals/${fromNode.id}`)).body.proposal.status, 'pending');

  // MCP over HTTP.
  const init = (await call(url, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).body;
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const tools = (await call(url, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools;
  assert.ok(tools.find(x => x.name === 'scrap_search'));
  const res = (await call(url, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scrap_search', arguments: { query: 'lithium battery' } } })).body.result;
  assert.ok(!res.isError && res.structuredContent.bestDevices.length > 0);
  const prop = (await call(url, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose_change', arguments: { collection: 'models', id: 'ai_test_model', reason: 'test', record: { device: 'vape', brand: 'X', model: 'Y' } } } })).body.result;
  assert.ok(!prop.isError, JSON.stringify(prop));
  assert.equal(prop.structuredContent.status, 'pending', 'AI proposals always wait for review');
});

test('hub: votes count once per person, feed confidence and travel through nodes', async (t) => {
  const [a, b, c, d] = await Promise.all(['A', 'B', 'C', 'D'].map(n => SDG.sign.createIdentity(n)));
  const { hub, url } = await start();
  t.after(() => hub.close());
  const ctx = hub.getCtx();
  const guess = id => ctx.resolve(id).comps.find(x => !x.board && ctx.confInfo(id, x.key).conf === 'assumed');
  const dev = ctx.ds.devices.find(x => !x.abstract && guess(x.id)).id, key = guess(dev).key;
  const target = SDG.votes.partTarget(dev, key);
  const post = async (v, base) => (await call(base || url, '/api/v1/votes', v)).body;
  const stamped = async (who, value, over) => { const v = Object.assign(await SDG.votes.make(over && over.target || target, value, null, 0), over || {}); v.pow = await SDG.sign.stamp(v, 4); return SDG.sign.sign(v, who); };

  for (const who of [a, b, c]) assert.equal((await post(await stamped(who, 1))).status, 'stored');
  assert.equal(hub.getCtx().confInfo(dev, key).conf, 'likely', 'three people finding a part makes a generic guess likely');

  assert.equal((await post(await stamped(a, -1, { created: '2026-01-01T00:00:00.000Z' }))).status, 'duplicate', 'an older vote never replaces a newer one');
  assert.equal((await post(await stamped(a, -1))).status, 'stored', 'a newer vote replaces the last');
  const tally = (await call(url, '/api/v1/votes/tally?prefix=devices/' + dev)).body[target];
  assert.deepEqual([tally.up, tally.down], [2, 1]);
  assert.equal(hub.getCtx().confInfo(dev, key).conf, 'assumed');

  const unsigned = await SDG.votes.make(target, 1, null, 4);
  assert.equal((await call(url, '/api/v1/votes', unsigned)).status, 401, 'votes must be signed');
  assert.equal((await call(url, '/api/v1/votes', await SDG.votes.make(target, 1, d, 0))).status, 428, 'newcomers pay the work stamp');
  assert.equal((await call(url, '/api/v1/votes', await stamped(d, 1, { target: `devices/${dev}#no_such_part` }))).status, 422);
  const cm = await SDG.changes.makeComment('devices/' + dev, 'Mine had this too.', null, a, 4);
  await call(url, '/api/v1/comments', cm);
  assert.equal((await call(url, '/api/v1/votes', await stamped(a, 1, { target: 'comments/' + cm.id }))).status, 422, 'no voting on your own comment');
  assert.equal((await post(await stamped(b, 1, { target: 'comments/' + cm.id }))).status, 'stored');

  // A node pulls the votes, takes new ones and forwards them; the hub counts them once.
  const node = await start({ mode: 'node', upstream: url, syncMinutes: 60 });
  t.after(() => node.hub.close());
  await syncOnce(node.hub);
  assert.equal((await call(node.url, '/api/v1/votes')).body.length, 4);
  assert.equal(node.hub.getCtx().confInfo(dev, key).votes.up, 2, 'pulled votes feed the node’s confidence');
  assert.equal((await post(await stamped(d, 1), node.url)).status, 'stored');
  const r = await syncOnce(node.hub);
  assert.equal(r.pushed.votes, 1);
  assert.equal(hub.getCtx().confInfo(dev, key).conf, 'likely', 'B, C and D found it; A did not');
});

test('hub: an announcement reaches apps through /api/v1/info', async (t) => {
  const { hub, url } = await start({ announcement: 'Swap meet at the depot on Saturday.' });
  t.after(() => hub.close());
  assert.equal((await call(url, '/api/v1/info')).body.announcement, 'Swap meet at the depot on Saturday.');
});

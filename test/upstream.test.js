// A node against an upstream that misbehaves: answers that inflate to gigabytes, feeds that don't
// end, replayed field notes and comments hidden upstream.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const SDG = require('../core');
const F = require('../lib/fsdata');
const config = require('../server/config');
const { createHub } = require('../server/hub');

// One snapshot of data/ for every node here, so they all start from the same data.
const SNAP = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-snap-'));
fs.cpSync(F.DATA, SNAP, { recursive: true });
async function start(over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-up-'));
  fs.cpSync(SNAP, path.join(dir, 'data'), { recursive: true });
  const cfg = config.load([], {}, Object.assign({ port: 0, dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state'), policy: { powBits: 4 } }, over));
  const hub = await createHub(cfg);
  const addr = await hub.listen();
  return { hub, url: `http://127.0.0.1:${addr.port}`, dir };
}
async function call(url, p) {
  const res = await fetch(url + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// An upstream that answers each path with what the test says: an object (sent as JSON), a Buffer
// (sent as gzip, the way a hostile one would) or a function of the URL giving either. It keeps a
// list of what was asked, path and query.
async function fakeUpstream(routes) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u.pathname + u.search);
    let body = routes[u.pathname];
    if (typeof body === 'function') body = await body(u);
    if (body === undefined) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"nope"}'); }
    if (Buffer.isBuffer(body)) { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); return res.end(body); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}
// A small gzip that inflates to `mb` megabytes: head, then `fill` over and over, then tail.
function gzipBomb(mb, head, fill, tail) {
  const one = Buffer.from(fill.repeat(Math.ceil((1 << 20) / fill.length)));
  return zlib.gzipSync(Buffer.concat([Buffer.from(head), ...Array(mb).fill(one), Buffer.from(tail)]), { level: 1 });
}
// A node with a fake upstream whose key it trusts, whose feed has nothing new for it.
async function nodeWithFake(t) {
  const up = await SDG.sign.createIdentity('Upstream');
  const routes = {};
  const fake = await fakeUpstream(routes);
  t.after(() => fake.server.close());
  const node = await start({ mode: 'node', upstream: fake.url, syncMinutes: 60 });
  t.after(() => node.hub.close());
  const quiet = async () => ({ head: node.hub.seq, entries: [], more: false, checkpoint: await SDG.changes.signCheckpoint(node.hub.seq, await node.hub.datasetHash(), up) });
  Object.assign(routes, { '/api/v1/info': { hubKey: up.key }, '/api/v1/sync': quiet });
  return { up, routes, fake, node, quiet };
}
const asked = (fake, p) => fake.seen.filter(s => s.startsWith(p)).map(s => +new URL(s, 'http://x').searchParams.get('limit'));

test('parse drops prototype keys at every depth, as the reviver did, and refuses absurd nesting', () => {
  const text = '{"a":[{"constructor":1,"b":{"\\u005f_proto__":{"x":1},"prototype":2,"c":[[{"__proto__":3}]]}}],"d":{"e":null}}';
  const v = SDG.util.parse(text);
  assert.deepEqual(v, JSON.parse(text, SDG.util.reviver));
  assert.equal(SDG.util.canonical(v), '{"a":[{"b":{"c":[[{}]]}}],"d":{"e":null}}');
  assert.equal(Object.getPrototypeOf(v.a[0].b), Object.prototype);
  for (const x of ['1', '"s"', 'null', '[]']) assert.deepEqual(SDG.util.parse(x), JSON.parse(x));
  assert.equal(SDG.util.parse('['.repeat(900) + ']'.repeat(900)).length, 1);
  assert.throws(() => SDG.util.parse('['.repeat(1e5) + ']'.repeat(1e5)), /nested too deeply/);
});

test('node: an answer that inflates past its limit is cut off, and only a real key is pinned', async (t) => {
  const { up, routes, fake, node } = await nodeWithFake(t);
  const sync = () => node.hub.syncNow();
  const info = routes['/api/v1/info'];

  // 32 MB of key at /api/v1/info, before any key is pinned.
  routes['/api/v1/info'] = gzipBomb(32, '{"hubKey":"', 'a', '"}');
  assert.match((await sync()).error, /more than 1 MB for \/api\/v1\/info/);
  for (const hubKey of [undefined, 'not a key', up.key + 'A', up.key.slice(1), up.key.slice(0, -1) + '=', 42]) {
    routes['/api/v1/info'] = { hubKey };
    assert.match((await sync()).error, /valid hub key/, String(hubKey));
  }
  assert.equal(node.hub.store.get('upstreamKey'), undefined, 'nothing was pinned');
  routes['/api/v1/info'] = info;
  assert.equal((await sync()).ok, true);
  assert.equal(node.hub.store.get('upstreamKey'), up.key);

  // With the key pinned: a page of millions of {} is refused for its objects long before 1 MB,
  // after asking for fewer changes each time; a page of one long string, at 1 MB.
  routes['/api/v1/sync'] = gzipBomb(8, '{"entries":[', '{},', '{}],"more":false}');
  assert.match((await sync()).error, /more than 65536 objects and lists for \/api\/v1\/sync/);
  assert.deepEqual(asked(fake, '/api/v1/sync').slice(-5), [200, 50, 12, 3, 1]);
  routes['/api/v1/sync'] = gzipBomb(8, '{"entries":[],"more":false,"x":"', 'a', '"}');
  assert.match((await sync()).error, /more than 1 MB for \/api\/v1\/sync/);

  // The release, reached by a reset under a checkpoint the upstream really signed, stops at 16 MB.
  routes['/api/v1/sync'] = async () => ({ reset: true, head: node.hub.seq + 1, checkpoint: await SDG.changes.signCheckpoint(node.hub.seq + 1, 'x', up) });
  routes['/api/v1/release'] = gzipBomb(32, '{"seq":1,"dataset":"', 'a', '"}');
  assert.match((await sync()).error, /more than 16 MB for \/api\/v1\/release/);
  assert.equal((await call(node.url, '/health')).body.ok, true, 'the node is still up');
});

test('node: feeds come in pages small enough to fit, and a long one ends in the signed release', async (t) => {
  const { up, routes, fake, node, quiet } = await nodeWithFake(t);
  const seq = node.hub.seq;
  const release = async s => SDG.changes.signRelease(await SDG.changes.makeRelease(SDG.util.clone(F.plain(node.hub.dataset())), s), up);
  const entry = s => ({ seq: s, coll: 'parts', rid: node.hub.dataset().parts[0].id, op: 'delete' });

  // A page longer than asked for is refused.
  routes['/api/v1/sync'] = u => ({ head: seq + 300, entries: Array.from({ length: +u.searchParams.get('limit') + 1 }, (x, i) => entry(seq + 1 + i)), more: true });
  assert.match((await node.hub.syncNow()).error, /not a page of changes/);

  // More than 2000 changes behind, by the first page's head: straight to the release.
  routes['/api/v1/sync'] = u => ({ head: seq + 5000, entries: [entry(+u.searchParams.get('since') + 1)], more: true });
  routes['/api/v1/release'] = await release(seq + 5000);
  let r = await node.hub.syncNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.report.reset, true);
  assert.equal(node.hub.seq, seq + 5000);

  // A feed that says "more" for ever, whatever its head: ten pages of 200, then the release.
  fake.seen.length = 0;
  routes['/api/v1/sync'] = u => { const s = +u.searchParams.get('since'); return { entries: Array.from({ length: 200 }, (x, i) => entry(s + 1 + i)), more: true }; };
  routes['/api/v1/release'] = await release(seq + 9000);
  r = await node.hub.syncNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(asked(fake, '/api/v1/sync'), Array(10).fill(200));
  assert.equal(node.hub.seq, seq + 9000);

  // A page of comments too big for its limit is asked for again, a quarter the size.
  routes['/api/v1/sync'] = quiet;
  routes['/api/v1/comments'] = u => (+u.searchParams.get('limit') > 100 ? gzipBomb(2, '[{"x":"', 'a', '"}]') : []);
  routes['/api/v1/votes'] = u => (+u.searchParams.get('limit') > 2000 ? gzipBomb(2, '[', '1,', '1]') : []);
  fake.seen.length = 0;
  assert.equal((await node.hub.syncNow()).ok, true);
  assert.deepEqual(asked(fake, '/api/v1/comments'), [1000, 250, 62]);
  assert.deepEqual(asked(fake, '/api/v1/votes'), [2000]);
});

// A feed of items the way a hub lists them, each with a later `received` than the last.
let tick = 0;
const listed = (...items) => items.map(x => Object.assign({}, x, { received: new Date(Date.UTC(2026, 10, 17, 0, 0, 0, ++tick)).toISOString() }));
// The same item changed and signed again by `who`, with a fresh work stamp.
async function resign(item, who, change) {
  const o = Object.assign(SDG.sign.strip(item, 'sig', 'author', 'pow'), change);
  o.pow = await SDG.sign.stamp(o, 4);
  return SDG.sign.sign(o, who);
}

test('node: an older signed copy of a field note never replaces a newer one', async (t) => {
  const { routes, node } = await nodeWithFake(t);
  const alice = await SDG.sign.createIdentity('Alice'), mallory = await SDG.sign.createIdentity('Mallory');
  const v1 = await SDG.changes.makeObservation({ lat: 45.4, lon: -75.7, status: 'untouched', share: 'public', label: 'Hardware store' }, alice, 4, 4);
  const later = ms => new Date(Date.parse(v1.created) + ms).toISOString();
  const pull = async (...items) => {
    routes['/api/v1/observations'] = listed(...items);
    const r = await node.hub.syncNow();
    assert.equal(r.ok, true, JSON.stringify(r));
    return node.hub.store.getObservation(v1.id).status;
  };
  assert.equal(await pull(v1), 'untouched');
  const v2 = await resign(v1, alice, { status: 'dangerous', notes: 'Gas leak, armed occupants', created: later(60e3) });
  assert.equal(await pull(v2), 'dangerous', 'its author may update it');

  // Whoever kept the first copy replays it: refused, and so is a copy no newer than ours, or one
  // someone else signed, however new.
  assert.equal(await pull(v1), 'dangerous');
  assert.equal(await pull(await resign(v1, alice, { status: 'cleared', created: v2.created })), 'dangerous');
  assert.equal(await pull(await resign(v2, mallory, { status: 'cleared', created: later(120e3) })), 'dangerous');
  // In one page, the order doesn't matter: the newest wins.
  const v3 = await resign(v2, alice, { status: 'cleared', created: later(180e3) });
  assert.equal(await pull(v3, v1, v2), 'cleared');
});

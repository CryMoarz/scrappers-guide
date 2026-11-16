// Both storage engines behave the same: SQLite where Node has it, JSON-lines files everywhere else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileStore, openStore } = require('../server/store');

function exercise(store) {
  store.appendLedger({ seq: 1, coll: 'parts', rid: 'a', op: 'put', at: '2026-01-01' });
  store.appendLedger({ seq: 2, coll: 'parts', rid: 'b', op: 'put', at: '2026-01-02' });
  assert.equal(store.ledgerHead(), 2);
  assert.deepEqual(store.ledgerSince(1).map(e => e.seq), [2]);
  store.putProposal({ id: 'p1', status: 'pending', coll: 'parts', rid: 'a', created: '2026-01-01', author: { key: 'k' } });
  store.putProposal({ id: 'p2', status: 'accepted', coll: 'parts', rid: 'b', created: '2026-01-02', author: { key: 'k' } });
  assert.deepEqual(store.listProposals({ status: 'pending' }).map(p => p.id), ['p1']);
  assert.deepEqual(store.listProposals({ author: 'k', desc: true }).map(p => p.id), ['p2', 'p1']);
  // Paging follows received, whatever the senders wrote in created.
  for (let i = 0; i < 5; i++) store.putComment({ id: 'c' + i, target: 'parts/a', created: i === 2 ? '9999-12-31T00:00:00Z' : '2026-01-0' + (i + 1), received: '2026-02-0' + (i + 1), body: 'x' });
  assert.equal(store.countComments('parts/a'), 5);
  assert.deepEqual(store.listComments({ since: '2026-02-02' }).map(c => c.id), ['c2', 'c3', 'c4']);
  assert.deepEqual(store.listComments({ since: '2026-02-02', limit: 1 }).map(c => c.id), ['c2']);
  store.putObservation({ id: 'o1', share: 'public', lat: 45, lon: -75, created: '2026-01-01', received: '2026-02-01' });
  store.putObservation({ id: 'o2', share: 'peers', lat: 46, lon: -75, created: '2026-01-02', received: '2026-02-02' });
  store.putObservation({ id: 'o3', share: 'public', lat: 45, lon: -75, created: '~', received: '2026-02-03' });
  assert.equal(store.getObservation('o2').lat, 46);
  assert.deepEqual(store.listObservations({}).map(o => o.id), ['o1', 'o3']);
  assert.deepEqual(store.listObservations({ desc: true, limit: 1 }).map(o => o.id), ['o3']);
  assert.deepEqual(store.listObservations({ since: '2026-02-01' }).map(o => o.id), ['o3']);
  assert.equal(store.listObservations({ shares: ['public', 'peers'], bbox: [-76, 45.5, -74, 47] }).length, 1);
  // One vote per person per target: the second from the same key replaces the first.
  store.putVote({ id: 'v1', target: 'devices/x#m', value: 1, created: '2026-01-01', received: '2026-03-01', author: { key: 'k1' } });
  store.putVote({ id: 'v2', target: 'devices/x#m', value: 1, created: '2026-01-01', received: '2026-03-02', author: { key: 'k2' } });
  store.putVote({ id: 'v3', target: 'devices/x#m', value: -1, created: '2026-01-02', received: '2026-03-03', author: { key: 'k1' } });
  store.putVote({ id: 'v4', target: 'comments/c1', value: 1, created: '2026-01-02', received: '2026-03-04', author: { key: 'k1' } });
  assert.equal(store.getVote('devices/x#m', 'k1').value, -1);
  assert.deepEqual(store.listVotes({ prefix: 'devices/' }).map(v => v.id).sort(), ['v2', 'v3']);
  assert.deepEqual(store.listVotes({ since: '2026-03-02' }).map(v => v.id), ['v3', 'v4']);
  store.outboxAdd('proposals', { id: 'p1', created: 'x' });
  store.outboxAdd('proposals', { id: 'p1', created: 'x' });
  assert.equal(store.outboxList('proposals').length, 1);
  store.outboxRemove('proposals', ['p1']);
  assert.equal(store.outboxList('proposals').length, 0);
  store.set('k', { a: 1 });
  assert.deepEqual(store.get('k'), { a: 1 });
}

test('file store, and it survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-store-'));
  exercise(new FileStore(dir));
  const again = new FileStore(dir);
  assert.equal(again.ledgerHead(), 2);
  assert.equal(again.countComments('parts/a'), 5);
});

test('sqlite store when available', (t) => {
  const s = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-store-')), 'auto');
  if (s.kind !== 'sqlite') return t.skip('this Node has no built-in SQLite');
  exercise(s);
  s.close();
});

test('sqlite: an older database gets received times that are never ahead', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-store-'));
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (e) { return t.skip('this Node has no built-in SQLite'); }
  const db = new sqlite.DatabaseSync(path.join(dir, 'hub.sqlite'));
  db.exec('CREATE TABLE comments (id TEXT PRIMARY KEY, target TEXT, created TEXT, hidden INTEGER DEFAULT 0, json TEXT); CREATE TABLE observations (id TEXT PRIMARY KEY, share TEXT, lat REAL, lon REAL, created TEXT, json TEXT);');
  db.prepare('INSERT INTO comments (id, target, created, json) VALUES (?,?,?,?)').run('a', 'parts/x', '9999-12-31T00:00:00Z', JSON.stringify({ id: 'a', target: 'parts/x', created: '9999-12-31T00:00:00Z' }));
  db.prepare('INSERT INTO comments (id, target, created, json) VALUES (?,?,?,?)').run('b', 'parts/x', '2026-01-01T00:00:00Z', JSON.stringify({ id: 'b', target: 'parts/x', created: '2026-01-01T00:00:00Z' }));
  db.close();
  const s = openStore(dir, 'sqlite');
  const got = s.listComments({});
  assert.deepEqual(got.map(c => c.id), ['b', 'a']);
  assert.ok(got[1].received <= new Date().toISOString(), 'a far-future created does not become a far-future cursor');
  s.close();
});

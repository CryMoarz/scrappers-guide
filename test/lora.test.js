// LoRa: the Meshtastic wire format, the text bot, and chunked signed items between two nodes.
const test = require('node:test');
const assert = require('node:assert');
const SDG = require('../core');
const F = require('../lib/fsdata');
const { PB, PORT, meshPacket, frame, frameReader, readFromRadio, memoryPair } = require('../server/lora-links');
const { createBridge } = require('../server/lora');

test('Meshtastic frames round-trip, and debug noise is skipped', () => {
  const toRadio = meshPacket('?scrap battery', { to: 0x1234abcd, port: PORT.TEXT });
  const pkt = PB.get(PB.decode(toRadio), 1);
  const mp = PB.decode(pkt);
  assert.equal(PB.get(mp, 2), 0x1234abcd);
  const fromRadio = PB.field(2, 2, Buffer.concat([PB.field(1, 5, 0xdeadbeef), pkt]));
  const got = [];
  const feed = frameReader(p => readFromRadio(p, (ev, x) => got.push([ev, x])));
  feed(Buffer.from('INFO | some debug line\r\n'));
  const f = frame(fromRadio);
  feed(f.subarray(0, 5));
  feed(f.subarray(5));
  assert.equal(got.length, 1);
  assert.equal(got[0][1].text, '?scrap battery');
  assert.equal(got[0][1].from, 0xdeadbeef);
  const pos = Buffer.concat([PB.field(1, 5, Math.round(45.4215 * 1e7)), PB.field(2, 5, Math.round(-75.6972 * 1e7) >>> 0)]);
  const posPkt = PB.field(2, 2, Buffer.concat([PB.field(1, 5, 7), PB.field(4, 2, Buffer.concat([PB.field(1, 0, PORT.POSITION), PB.field(2, 2, pos)]))]));
  readFromRadio(posPkt, (ev, x) => got.push([ev, x]));
  assert.equal(got[1][0], 'position');
  assert.ok(Math.abs(got[1][1].lon + 75.6972) < 1e-6);
});

function fakeHub(name, ctx, identity) {
  const obs = [], comments = [];
  return {
    obs, hubFp: 'abcdef0123456789', seq: 5, identity, getCtx: () => ctx, datasetHash: async () => 'ffff0000',
    cfg: { name, policy: { comments: 'on' } },
    store: { putObservation: o => obs.push(o), putComment: c => comments.push(c), getComment: () => null },
    takeObservation: async (o, meta) => { if (!(await SDG.sign.verify(o))) throw new Error('bad signature'); obs.push(Object.assign({}, o, meta)); },
    takeComment: async (c, meta) => { comments.push(Object.assign({}, c, meta)); },
  };
}
const until = async (fn, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('bot answers over the mesh, and signed field notes travel in chunks', async (t) => {
  const ctx = SDG.db.open(F.plain(F.load()));
  const [a, b] = memoryPair();
  const hubA = fakeHub('Camp A', ctx, await SDG.sign.createIdentity('Camp A'));
  const hubB = fakeHub('Camp B', ctx, await SDG.sign.createIdentity('Camp B'));
  const fast = { spacingMs: 20, maxPerMinute: 1000, firstAnnounceMs: 10, announceMinutes: 0 };
  const A = createBridge(hubA, Object.assign({ linkObject: a }, fast));
  const B = createBridge(hubB, Object.assign({ linkObject: b, bot: false }, fast));
  t.after(() => { A.close(); B.close(); });

  // B's user asks A's bot; A replies directly to B's radio.
  b.send('?scrap battery');
  assert.ok(await until(() => a.sent.some(s => /Look:/.test(s.text))), 'bot replied');
  const reply = a.sent.find(s => /Look:/.test(s.text));
  assert.equal(reply.o.to, b.num, 'replies go to the asker, not the whole mesh');
  assert.ok(reply.text.length <= 200);
  b.send('?step ' + ctx.ds.guides[0].id + ' 1');
  assert.ok(await until(() => a.sent.some(s => /^1\//.test(s.text))));

  // Announcements tell other nodes who has which data.
  assert.ok(await until(() => Object.keys(B.state.peers).length === 1));

  // A signed field note goes out in chunks and is verified and stored on the other side.
  const o = await SDG.changes.makeObservation({ lat: 45.4215, lon: -75.6972, status: 'untouched', share: 'peers', label: 'Pharmacy on Main', notes: 'Back room not touched. '.repeat(10) }, hubA.identity);
  assert.ok(A.shareObservation(o) >= 1);
  assert.ok(await until(() => hubB.obs.length === 1), 'note arrived');
  assert.equal(hubB.obs[0].id, o.id);
  assert.ok(await SDG.sign.verify(SDG.sign.strip(hubB.obs[0], 'via')));

  // ?seen uses the radio's last reported position.
  b.emit('position', { from: b.num, lat: 45.1, lon: -75.2 });
  a.emit('position', { from: b.num, lat: 45.1, lon: -75.2 });
  b.send('?seen cleared pharmacy');
  assert.ok(await until(() => hubA.obs.some(x => x.status === 'cleared')));
});

test('LoRa items go through the hub\'s checks, and reassembly stays bounded', async (t) => {
  const os = require('os'), fs = require('fs'), path = require('path'), zlib = require('zlib');
  const config = require('../server/config');
  const { createHub } = require('../server/hub');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-lora-'));
  fs.cpSync(F.DATA, path.join(dir, 'data'), { recursive: true });
  const hub = await createHub(config.load([], {}, { mode: 'node', dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state'), policy: { powBits: 4 } }));
  t.after(() => hub.close());
  const [, b] = memoryPair();
  const B = createBridge(hub, { linkObject: b, bot: false, spacingMs: 20, maxPerMinute: 1000, firstAnnounceMs: 1e6, announceMinutes: 0 });
  t.after(() => B.close());
  // Frames as another node would send them, straight to B.
  const send = async (kind, item) => {
    const body = zlib.deflateRawSync(Buffer.from(JSON.stringify({ k: kind, v: item }))).toString('base64url');
    const n = Math.ceil(body.length / 150), id = SDG.util.newId().slice(-8);
    for (let i = 0; i < n; i++) await B.handle({ text: `SDG1|D|${id}|${i + 1}|${n}|${body.slice(i * 150, (i + 1) * 150)}`, from: 9 });
  };
  const alice = await SDG.sign.createIdentity('Alice'), mallory = await SDG.sign.createIdentity('Mallory');
  const note = async (who, f, bits) => { const o = await SDG.changes.makeObservation(Object.assign({ lat: 45.4, lon: -75.7, status: 'untouched', share: 'peers' }, f), null); if (bits) o.pow = await SDG.sign.stamp(o, bits); return SDG.sign.sign(o, who); };

  await send('o', await SDG.changes.makeObservation({ lat: 45, lon: -75, status: 'cleared', share: 'peers' }, null));
  await send('o', await note(alice, {}, 0));
  assert.equal(hub.store.listObservations({ shares: ['peers'] }).length, 0, 'unsigned, and unstamped from a newcomer: both refused');
  const good = await note(alice, { label: 'Pharmacy' }, 4);
  await send('o', good);
  const kept = hub.store.listObservations({ shares: ['peers'] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].via, 'lora');
  assert.ok(kept[0].received);
  // Someone else's note under the same id doesn't replace it, over LoRa or over HTTP.
  const o2 = await SDG.changes.makeObservation({ lat: 1, lon: 1, status: 'dangerous', share: 'peers' }, null);
  o2.id = good.id; o2.pow = await SDG.sign.stamp(o2, 4);
  const forged = await SDG.sign.sign(o2, mallory);
  await send('o', forged);
  await assert.rejects(hub.takeObservation(forged), e => e.status === 409);
  assert.equal(hub.store.getObservation(good.id).label, 'Pharmacy');
  assert.equal(B.state.received.observations, 1);
  assert.ok(B.state.refused >= 3);

  // A compression bomb is dropped; oversized and mismatched chunks never collect.
  const bomb = zlib.deflateRawSync(Buffer.alloc(1e6, 'a')).toString('base64url');
  assert.ok(bomb.length <= 12 * 150);
  const n = Math.ceil(bomb.length / 150);
  const dropped = B.state.dropped;
  for (let i = 0; i < n; i++) await B.handle({ text: `SDG1|D|bomb1|${i + 1}|${n}|${bomb.slice(i * 150, (i + 1) * 150)}` });
  assert.equal(B.state.dropped, dropped + 1);
  await B.handle({ text: 'SDG1|D|big1|1|2|' + 'x'.repeat(5000) });
  for (let i = 0; i < 100; i++) await B.handle({ text: `SDG1|D|p${i}|1|12|abc` });
  assert.ok(B.inFlight().parts <= 32);
  for (let i = 0; i < 150; i++) await B.handle({ text: `SDG1|H|${(0x10000000 + i).toString(16)}|5|ffff0000|Camp ${i}` });
  await B.handle({ text: 'SDG1|H|not-hex|5|x|y' });
  assert.ok(Object.keys(B.state.peers).length <= 100);
  for (let i = 0; i < 700; i++) b.emit('position', { from: i, lat: 1, lon: 1 });
  assert.ok(B.inFlight().positions <= 500);
});

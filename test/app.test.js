// The built app, run headless against a stand-in DOM: what it renders from hostile data, and what
// it accepts from a hub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const SDG = require('../core');
const F = require('../lib/fsdata');
const config = require('../server/config');
const { createHub } = require('../server/hub');

const { make } = require('../tools/build');

// The app as this source builds it, in memory: the committed app is the last release's, so testing
// it would test old code until the next release. Built once, on first use.
let built;
const source = () => (built = built || make().then(({ html }) => ({ HTML: html, SCRIPT: html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')) })));
// The app committed at the last release, with the fingerprint published beside it.
const COMMITTED = fs.readFileSync(path.join(__dirname, '..', 'app', 'scrappers-guide.html'), 'utf8');

function el() {
  const on = {};
  return {
    on, addEventListener: (type, fn) => (on[type] = fn),
    innerHTML: '', textContent: '', value: '', hidden: false, checked: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    querySelector: () => el(), querySelectorAll: () => [], closest: () => null, focus() {}, appendChild() {}, remove() {}, click() {}, scrollIntoView() {}, setSelectionRange() {}, matches: () => false,
  };
}
// Loads a fresh copy of the app and hands back its state and functions.
async function loadApp() {
  const els = new Map();
  const $ = s => els.get(s) || (els.set(s, el()), els.get(s));
  const document = { querySelector: $, querySelectorAll: () => [], addEventListener() {}, createElement: el, documentElement: el(), body: el(), visibilityState: 'visible', activeElement: null };
  const ctx = vm.createContext({
    document, window: { addEventListener() {}, scrollTo() {}, scrollY: 0 }, location: { hash: '', search: '', protocol: 'file:', origin: 'null' }, navigator: {},
    crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, btoa, URL, URLSearchParams, AbortController, Blob, Response, fetch,
    setTimeout: (f, ms, ...a) => { const x = setTimeout(f, ms, ...a); x.unref(); return x; }, clearTimeout, console, CSS: { escape: s => s }, confirm: () => false, prompt: () => null,
  });
  vm.runInContext((await source()).SCRIPT + '\n;globalThis.__app = { S, Sync, Ref, Calc, Pinouts, renderReview, renderPlan, renderRef, renderGuides, Simple, guideNotes, detailHTML, rebuild, updateBanner, TRUST, RELEASE, BUILD };', ctx);
  for (let i = 0; i < 50 && !ctx.__app.S.ctx; i++) await new Promise(r => setTimeout(r, 10));
  return Object.assign(ctx.__app, { $ });
}

test('app: hostile ids, numbers and links are escaped or dropped', async () => {
  const app = await loadApp();
  const { S, Sync } = app;
  const evil = '"><img src=x onerror=alert(1)>';
  const hasTag = h => /<img|<b>bold|javascript:/i.test(h);

  // A moderator opening Review on a proposal with a hostile id.
  S.hub.online = true;
  Sync.api = async p => (p.includes('status=') ? [{ id: evil, coll: 'parts', rid: 'x', op: 'put', author: { name: evil } }] : { proposal: { id: evil, coll: 'parts', rid: evil, op: 'put', created: evil, reason: evil }, current: null, stale: false, diff: [{ path: evil, after: evil }], problems: [] });
  await app.renderReview(evil);
  const review = app.$('#v-review').innerHTML;
  assert.ok(review.includes('data-review="&quot;&gt;&lt;img'), 'the id is escaped in its attribute');
  assert.ok(!hasTag(review), review.slice(0, 300));

  // Field notes from others with hostile numbers, statuses and ids.
  S.observations = [{ id: evil, lat: '<img src=x>', lon: '<b>bold', status: '<b>bold</b>', share: 'public', created: evil, mine: true }];
  app.renderPlan('notes');
  assert.ok(!hasTag(app.$('#v-plan').innerHTML));

  // A model whose source links are not web links.
  const model = Object.assign(SDG.util.clone(S.base.dataset.models.find(m => (m.sources || []).length)), { sources: [{ title: 'x', url: 'javascript:alert(1)' }] });
  model.comps = [{ key: 'k', conf: 'documented', spec: 's', source: 'javascript:alert(2)' }];
  S.base.dataset.models.push(Object.assign(model, { id: 'evil_model' }));
  app.rebuild();
  assert.ok(!hasTag(app.detailHTML('models', 'evil_model')));
});

test('app: guides say who reviewed them, and the dangerous ones say experienced only', async () => {
  const app = await loadApp();
  const g = id => app.S.ctx.get('guides', id);
  const esc = app.guideNotes(g('teardown_escalator'));
  assert.match(esc, /Experienced only/, 'difficulty 5');
  assert.match(esc, /Not yet reviewed/);
  assert.match(app.guideNotes(g('teardown_microwave')), /Experienced only/, 'marked experienced in its record');
  assert.doesNotMatch(app.guideNotes(g('teardown_led_bulb')), /Experienced only/);
  const evil = '<img src=x onerror=alert(1)>';
  const r = app.guideNotes(Object.assign({}, g('teardown_led_bulb'), { reviewed: { by: evil, experience: evil, date: '2026-11-12' } }));
  assert.match(r, /Reviewed by &lt;img/);
  assert.ok(!r.includes('<img'), 'a reviewer’s name is escaped');
});

test('app: board pinouts draw every board and mark the pins that bite', async () => {
  const app = await loadApp(), P = app.Pinouts;
  assert.ok(P.boards.length >= 20);
  const ids = new Set();
  for (const b of P.boards) {
    assert.ok(!ids.has(b.id), 'one entry per board: ' + b.id); ids.add(b.id);
    assert.ok(b.name && b.chip && b.logic, b.id);
    assert.ok(b.same_as ? P.boards.some(x => x.id === b.same_as && !x.same_as) : ['left', 'right', 'top', 'bottom'].some(k => (b[k] || []).length), b.id);
    assert.ok((b.sources || []).length && b.sources.every(s => /^https:\/\//.test(s.url)), 'every board names its sources: ' + b.id);
  }
  const html = P.html();
  assert.ok(!/<script|\son[a-z]+=/i.test(html), 'drawings only, nothing that runs');
  assert.equal((html.match(/<svg/g) || []).length, P.boards.filter(b => !b.same_as).length, 'a drawing per board, none for a same-as clone');
  // The ESP32's boot pin and its input-only pins carry their own colours.
  const esp = P.boards.find(b => b.id === 'esp32_devkitc_v4'), pins = [...esp.left, ...esp.right];
  assert.equal(P.kindOf(pins.find(p => /^(GPIO|IO)0$/.test(p.n))), 'boot');
  assert.ok(P.html().includes('data-jump="esp32_devkitc_v4"'), 'boards are linked by id');
  assert.ok(pins.filter(p => P.kindOf(p) === 'input').length >= 4);
  app.renderRef('pinouts');
  assert.ok(app.$('#v-ref').innerHTML.includes('Board pinouts'));
});

test('app: quick reference draws the warning labels and lists the reference cards', async () => {
  const app = await loadApp();
  const html = app.Ref.labelsHTML();
  for (const name of ['Exploding bomb', 'Electricity', '8 Corrosive', 'IP rating', 'Laser classes', '3 PVC']) assert.ok(html.includes(name), name);
  assert.ok(!/<script|\son[a-z]+=/i.test(html), 'pictures only, nothing that runs');
  const ids = app.Ref.cards(app.S.ctx).map(c => c.id);
  assert.equal(ids[0], 'labels');
  assert.ok(ids.includes('reference_battery_chemistry'));
  app.renderRef('labels');
  assert.ok(app.$('#v-ref').innerHTML.includes('Warning labels and symbols'));
  assert.match(app.detailHTML('devices', 'desktop_pc'), /Made of \(typical\): Steel <b>4\.6 kg/, 'what a device is made of, heaviest first');
  assert.match(app.detailHTML('devices', 'smartphone'), /What had failed: screen 51%/, 'what usually fails, from repair records');
});

test('app: the calculator reads SI prefixes and parallel, and rejects anything else', async () => {
  const { Calc } = await loadApp();
  const close = (x, want) => Math.abs(x - want) <= 1e-9 * Math.max(1, Math.abs(want));
  for (const [x, want] of [['1k || 1k', 500], ['4k7', 4700], ['4R7', 4.7], ['100n*10k', 0.001], ['1k + 2k || 2k', 2000], ['2^3^2', 512], ['sin(30)', 0.5], ['2pi', 2 * Math.PI], ['-(2+3)*2', -10]]) assert.ok(close(Calc.evaluate(x), want), x);
  for (const x of ['constructor(1)', '__proto__(1)', 'toString(1)', 'alert(1)', '2 +', '1k ||']) assert.throws(() => Calc.evaluate(x), x);
  assert.deepEqual([Calc.num('4.7kΩ'), Calc.num('2k2'), Calc.num('10mAh'), Calc.num('x')].map(v => (Number.isNaN(v) ? 'NaN' : +v.toPrecision(6))), [4700, 2200, 0.01, 'NaN']);
  assert.equal(Calc.eng(0.0000047, 'F'), '4.7 µF');
  assert.ok(Calc.LIST.length >= 12 && Calc.LIST.every(t => Calc.get(t.id)));
  // LoRa time on air, worked by hand from Semtech's formula: Long Fast (SF11, 250 kHz, 4/5), 60 bytes,
  // 16-symbol preamble is (16 + 4.25) + 63 symbols of 8.192 ms. SF12 at 125 kHz turns on low data rate optimisation.
  assert.equal(+(Calc.airtime(11, 250e3, 1, 60, 16).s * 1000).toFixed(3), 681.984);
  assert.deepEqual([Calc.airtime(11, 250e3, 1, 60, 16).de, Calc.airtime(12, 125e3, 4, 60, 16).de], [0, 1]);
});

test('app: a fuel burner says whether it may burn indoors, escaped', async () => {
  const app = await loadApp();
  const d = app.S.ctx.get('devices', 'patio_heater');
  d.combustion = { indoor: 'outdoor_only', fuels: ['<img src=x onerror=alert(1)>'], kw: [10, 14], power_w: 0, note: '<b>bold' };
  const html = app.detailHTML('devices', 'patio_heater');
  assert.ok(html.includes('class="note danger"><b>Outdoor only.</b>'), 'outdoor-only burners get the danger box');
  assert.ok(html.includes('about <b>10–14 kW</b> of heat') && html.includes('<b>runs with no power</b>'));
  assert.ok(!/<img|<b>bold/.test(html), 'fuel names and notes are escaped');
  const vented = app.S.ctx.get('devices', 'furnace');
  vented.combustion = { indoor: 'vented', power_w: 500 };
  assert.ok(app.detailHTML('devices', 'furnace').includes('<div class="note"><b>Indoors only with a flue to outside.</b>'));
  const odd = app.S.ctx.get('devices', 'space_heater');
  odd.combustion = { indoor: 'sometimes' };
  assert.ok(!app.detailHTML('devices', 'space_heater').includes('Indoors only'), 'an unknown value shows nothing');
});

test('app: links in guide steps work in both modes, and the rest is escaped', async () => {
  const app = await loadApp();
  const g = app.S.ctx.get('guides', 'test_chimney');
  g.steps = [{ text: 'See [Sweeping](#guides/skill_chimney_sweeping) <img src=x onerror=alert(1)>', warn: 'Read [Fuel](#browse/hazards/fuel) and [bad](javascript:alert(1))' }];
  app.renderGuides('test_chimney');
  const full = app.$('#gdetail').innerHTML;
  assert.ok(full.includes('See <a href="#guides/skill_chimney_sweeping">Sweeping</a>') && full.includes('<a href="#browse/hazards/fuel">Fuel</a>'));
  assert.ok(!/<img|href="javascript/.test(full), 'tags and script links stay text');
  app.Simple.render(['simple', 'g', 'test_chimney']);
  const simple = app.$('#v-simple').innerHTML;
  assert.ok(simple.includes('<a href="#simple/g/skill_chimney_sweeping">Sweeping</a>'), 'guide links stay in simple mode');
  assert.ok(simple.includes('Read Fuel and') && !/<img|href="javascript|#browse/.test(simple), 'full-app links become plain text');
});

test('app: library links only to web addresses, inside their book', () => {
  const ctx = SDG.db.open(F.plain(F.load()));
  const libs = ctx.ds.vocab.libraries;
  const lookup = { lib: 'ifixit', q: 'microwave', path: 'Device/Microwave' };
  assert.ok(SDG.text.libraryUrl({ kiwix: { url: 'http://box:8090', books: { ifixit: 'ifixit_en' } } }, lookup, libs).startsWith('http://box:8090/content/ifixit_en/'));
  assert.equal(SDG.text.libraryUrl({ kiwix: { url: 'javascript:alert(1)//', books: { ifixit: 'ifixit_en' } } }, lookup, libs), null);
  assert.equal(SDG.text.libraryUrl({ kiwix: { url: 'http://box:8090', books: { ifixit: 'ifixit_en' } } }, Object.assign({}, lookup, { path: '../../admin' }), libs), null);
  const nomadLib = Object.keys(libs).find(k => libs[k].nomad);
  assert.equal(SDG.text.libraryUrl({ nomad: { url: 'data:text/html,x' } }, { lib: nomadLib, path: 'burns' }, libs), null);
  assert.equal(SDG.text.libraryUrl({ nomad: { url: 'http://box' } }, { lib: nomadLib, path: '..' }, libs), null);
  // Cited pages map into the offline copy of their site, and nothing else does.
  const books = { ifixit: 'ifixit_en', readygov: 'ready_en', wikipedia: 'wp_en' };
  assert.deepEqual(SDG.text.offlinePage('https://www.ifixit.com/Guide/Fix+It/12', libs, books), { lib: 'ifixit', book: 'ifixit_en', page: 'Guide/Fix+It/12' });
  assert.equal(SDG.text.offlinePage('https://ready.gov/home-fires', libs, books).page, 'www.ready.gov/home-fires', 'a site crawl keeps the host');
  assert.equal(SDG.text.offlinePage('https://en.wikipedia.org/wiki/Lead%E2%80%93acid_battery', libs, books).page, 'Lead%E2%80%93acid_battery');
  for (const u of ['https://medlineplus.gov/a.htm', 'https://www.cdc.gov/x', 'https://www.ifixit.com/', 'https://www.ifixit.com/a?b=1', 'javascript:alert(1)', 'https://en.wikipedia.org/w/index.php']) assert.equal(SDG.text.offlinePage(u, libs, books), null, u);
});

// A hub that answers whatever a test sets, with its own key, as a hostile hub would.
async function fakeHub(id, routes) {
  const server = http.createServer(async (req, res) => {
    const fn = routes[new URL(req.url, 'http://x').pathname];
    const body = fn ? await fn() : { error: 'nope' };
    res.writeHead(fn ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  routes['/api/v1/info'] = routes['/api/v1/info'] || (() => ({ hubKey: id.key, policy: { comments: 'on', powBits: 0 } }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('app: what a hub sends is checked before the app keeps it', async (t) => {
  // A real hub: the app syncs with it and pins its key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-app-'));
  fs.cpSync(F.DATA, path.join(dir, 'data'), { recursive: true });
  const real = await createHub(config.load([], {}, { port: 0, dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state') }));
  const addr = await real.listen();
  t.after(() => real.close());
  const ok = await loadApp();
  ok.S.settings.hubUrl = `http://127.0.0.1:${addr.port}`;
  await ok.Sync.run(false);
  assert.equal(ok.S.hub.error, null);
  assert.equal(ok.S.base.seq, real.seq);

  // A hostile hub: unsigned data, changes with no checkpoint, and items that aren't what they say.
  const evil = await SDG.sign.createIdentity('Evil hub');
  const alice = await SDG.sign.createIdentity('Alice');
  const routes = {};
  const fake = await fakeHub(evil, routes);
  t.after(() => fake.server.close());
  const app = await loadApp();
  app.S.settings.hubUrl = fake.url;
  const before = app.S.base.seq;
  const part = app.S.base.dataset.parts[0];
  const rel = await SDG.changes.makeRelease(Object.assign(SDG.util.clone(app.S.base.dataset), { parts: [] }), before + 5);
  routes['/api/v1/sync'] = () => ({ reset: true, head: before + 5 });
  routes['/api/v1/release'] = () => rel;
  await app.Sync.run(false);
  assert.match(app.S.hub.error, /trust/);
  assert.equal(app.S.base.seq, before);

  routes['/api/v1/sync'] = () => ({ head: before + 1, entries: [{ seq: before + 1, coll: 'parts', rid: part.id, op: 'put', data: Object.assign({}, part, { summary: 'Unverified' }) }] });
  await app.Sync.run(false);
  assert.match(app.S.hub.error, /checkpoint/);
  assert.notEqual(app.S.base.dataset.parts[0].summary, 'Unverified');

  // An older release, even one properly signed by the pinned hub, is refused without the user's say.
  await SDG.changes.signRelease(Object.assign(rel, { seq: before - 1 }), evil);
  routes['/api/v1/sync'] = () => ({ reset: true, head: before - 1 });
  await app.Sync.run(false);
  assert.match(app.S.hub.error, /older/);
  assert.equal(app.S.base.seq, before);

  // Signed is not the same as sound: a release with a record that doesn't check out is refused,
  // so it can't leave the app unable to open its own data.
  const release = async (ds, seq) => { const x = await SDG.changes.makeRelease(ds, seq); await SDG.changes.signRelease(x, evil); routes['/api/v1/sync'] = () => ({ reset: true, head: seq }); routes['/api/v1/release'] = () => x; };
  await release(Object.assign(SDG.util.clone(app.S.base.dataset), { devices: [{ oops: true }] }), before + 2);
  await app.Sync.run(false);
  assert.match(app.S.hub.error, /check out/);
  assert.equal(app.S.base.seq, before);
  // Once the device holds the pinned hub's own data, that hub may take it back to an older version:
  // that is its own word, not a rollback by someone else.
  await release(SDG.util.clone(app.S.base.dataset), before + 3);
  await app.Sync.run(false);
  assert.equal(app.S.base.seq, before + 3);
  await release(SDG.util.clone(app.S.base.dataset), before + 1);
  await app.Sync.run(false);
  assert.equal(app.S.hub.error, null);
  assert.equal(app.S.base.seq, before + 1);

  // Comments and notes: bad ones are dropped, and nothing pulled is "mine".
  const o = await SDG.changes.makeObservation({ lat: 45.4, lon: -75.7, status: 'cleared', share: 'public' }, alice);
  const c = await SDG.changes.makeComment('parts/' + part.id, 'Good one', null, alice);
  const cp = await SDG.changes.signCheckpoint(before, app.S.base.hash, evil);
  routes['/api/v1/sync'] = () => ({ head: before, entries: [], checkpoint: cp });
  routes['/api/v1/comments'] = () => [Object.assign({}, c, { received: '2026-11-12T00:00:00.000Z' }), { id: 'x1', target: '__proto__', body: 'b', created: '2026-11-12T00:00:00.000Z' }, Object.assign({}, c, { id: 'x2' })];
  routes['/api/v1/observations'] = () => [Object.assign({}, o, { mine: true, sent: false, received: '2026-11-12T00:00:00.000Z' })];
  await app.Sync.run(false);
  assert.equal(app.S.hub.error, null);
  assert.deepEqual(Object.keys(app.S.comments), ['parts/' + part.id]);
  assert.equal(app.S.comments['parts/' + part.id].length, 1);
  const pulled = app.S.observations.find(x => x.id === o.id);
  assert.ok(pulled && !pulled.mine && pulled.sent === undefined, 'a pulled note is never treated as ours');
  assert.equal(app.S.settings.commentsReceived, '2026-11-12T00:00:00.000Z');
});

test('app: the Review screen shows the proposal as signed, against its own data, and signs its hash', async (t) => {
  const hubId = await SDG.sign.createIdentity('Hub');
  const eve = await SDG.sign.createIdentity('Eve');
  const mod = await SDG.sign.createIdentity('Mod');
  const routes = {};
  const fake = await fakeHub(hubId, routes);
  t.after(() => fake.server.close());
  const app = await loadApp();
  const h = app.S.base.dataset.hazards[0];
  const p = await SDG.changes.makeProposal({ coll: 'hazards', rid: h.id, op: 'put', data: Object.assign({}, h, { summary: 'EVIL instructions' }), reason: 'Fix a typo' }, eve, 0);
  // The hub (or someone between) sends a harmless-looking diff beside the real proposal.
  routes['/api/v1/proposals'] = () => [];
  routes['/api/v1/proposals/' + p.id] = () => ({ proposal: Object.assign({}, p, { status: 'pending', received: SDG.util.now() }), current: h, diff: [{ path: 'summary', before: 'a', after: 'b' }], problems: [] });
  Object.assign(app.S.settings, { hubUrl: fake.url, hubKeys: { [fake.url]: hubId.key } });
  app.S.identity = mod; app.S.hub.online = true;
  await app.renderReview(p.id);
  let html = app.$('#v-review').innerHTML;
  assert.match(html, /EVIL instructions/, 'the change itself is shown, worked out on the device');
  assert.match(html, /signature checks out/);
  assert.ok(html.includes(`data-hash="${await SDG.changes.proposalHash(p)}"`));
  // Changed after its author signed it: said plainly, and Accept is off.
  routes['/api/v1/proposals/' + p.id] = () => ({ proposal: Object.assign({}, p, { reason: 'Something else' }), current: h, diff: [], problems: [] });
  await app.renderReview(p.id);
  html = app.$('#v-review').innerHTML;
  assert.match(html, /signature doesn’t check out/);
  assert.match(html, /data-decide="accept"[^>]*disabled/);
});

test('app: updates are offered only when a maintainer signed them, and checked when fetched', async (t) => {
  // The build publishes a fingerprint of the app it built.
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'app-build.json'), 'utf8'));
  assert.equal(info.sha256, await SDG.util.sha256hex(COMMITTED));

  const maintainer = await SDG.sign.createIdentity('Maintainer');
  const stranger = await SDG.sign.createIdentity('Stranger');
  let served = Buffer.from('<!doctype html><title>new app</title>');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(served); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const app = await loadApp();
  app.S.settings.hubUrl = `http://127.0.0.1:${server.address().port}`;
  const newer = { version: '9.9.9', date: '2099-01-01', id: 'f00dfeedbeef', sha256: await SDG.util.sha256hex(served) };
  const keys = [maintainer.key];
  const show = async (a, trusted) => { app.S.hub.info = { app: a }; app.S.hub.appOk = (await SDG.changes.verifyAppBuild(a, trusted)) ? a.id : null; app.updateBanner(); return !app.$('#updatebar').hidden; };
  assert.equal(await show(newer, keys), false, 'unsigned');
  assert.equal(await show(await SDG.changes.signAppBuild(Object.assign({}, newer), stranger), keys), false, 'signed by a key the app does not trust');
  const signed = await SDG.changes.signAppBuild(Object.assign({}, newer), maintainer);
  assert.equal(await show(Object.assign({}, signed, { sha256: '00' }), keys), false, 'changed after signing');
  assert.equal(await show(signed, keys), true);
  assert.equal(await show(signed, []), false, 'no maintainer keys, no update: the default today');
  const older = await SDG.changes.signAppBuild({ version: '0.9.0', date: '2099-01-01', id: 'aa11bb22cc33', sha256: newer.sha256 }, maintainer);
  assert.equal(await show(older, keys), false, 'an older version is never offered, even signed and dated later');

  // Fetched bytes that don't match the signed fingerprint are never saved.
  await show(signed, keys);
  served = Buffer.from('<!doctype html><script>evil()</script>');
  await app.$('#updatebar').on.click({ target: { id: 'appupdate' } });
  assert.match(app.$('#toast').textContent, /fingerprint/);
});

test('app: only the script the build wrote may run', async () => {
  const { HTML, SCRIPT } = await source();
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(HTML);
  assert.ok(csp && HTML.indexOf(csp[0]) < HTML.indexOf('<script>'), 'the policy comes before the script');
  const hash = require('crypto').createHash('sha256').update(SCRIPT, 'utf8').digest('base64');
  assert.ok(csp[1].includes(`script-src 'sha256-${hash}'`));
  assert.ok(/default-src 'none'/.test(csp[1]) && /connect-src \*/.test(csp[1]));
  // No inline handlers for the policy to break, in the page or in what the app renders.
  for (const f of ['index.html', 'app.js', 'simple.js', 'forms.js', 'md.js', 'map.js', 'runs.js', 'reference.js', 'calc.js', 'pinouts.js', 'pinboards.js']) assert.ok(!/\son[a-z]+=["']/.test(fs.readFileSync(path.join(__dirname, '..', 'app', 'src', f), 'utf8')), f);
});

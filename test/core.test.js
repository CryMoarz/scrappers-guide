// The shared core: data validity, search behaviour, signatures, releases and sync helpers.
const test = require('node:test');
const assert = require('node:assert');
const SDG = require('../core');
const F = require('../lib/fsdata');

const ds = F.plain(F.load());
const ctx = SDG.db.open(SDG.util.clone(ds));
const top = (q, opts) => SDG.search.search(ctx, q, opts || {}).ranked.res.map(x => x.cat.id);
const onParts = q => [...SDG.search.search(ctx, q).sel].filter(([, v]) => v.on).map(([k]) => k);

test('every record is valid and every reference resolves', () => {
  const problems = SDG.schema.validateDataset(ds);
  assert.deepEqual(problems.slice(0, 10).map(p => `${p.coll}/${p.id} ${p.path} ${p.msg}`), []);
});

test('the schema rejects bad records', () => {
  assert.equal(SDG.schema.validateRecord('parts', { id: 'X', name: 'x' }).ok, false);
  const v = SDG.schema.validateRecord('devices', { id: 'thing', name: 'Thing', group: 'Other', prev: 9, tools: [], mins: 1, comps: [], buildings: [] });
  assert.ok(v.errors.some(e => e.path === 'prev'));
  assert.ok(SDG.schema.validateRecord('devices', { id: 'v', name: 'V', variantOf: 'treadmill' }).ok, 'variants need only id, name and parent');
});

test('part searches find the right part types', () => {
  assert.ok(onParts('battery').includes('battery_li'));
  assert.deepEqual(onParts('lm2596'), ['dcdc_buck']);
  assert.ok(onParts('555 timer').includes('ic_555'));
  assert.ok(top('battery').length > 10);
});

test('searches as people write them: plurals, spelled-out ratings, typing slips and filler words', () => {
  assert.deepEqual(onParts('aa batteries').sort(), ['battery_nimh', 'battery_primary'], 'AA cells, not lead-acid');
  assert.deepEqual(onParts('12 volt motor'), onParts('12v motor'));
  assert.ok(onParts('batery').includes('battery_li') && !onParts('batery').includes('bms'), 'a slip reads as the word meant');
  assert.ok(onParts('transformr').includes('transformer_lv'));
  assert.deepEqual(onParts('scrap metal').sort(), ['sheet_metal', 'tube_frame'], '"scrap" is not a part word');
  assert.ok(onParts('gas can').includes('fuel_liquid'), 'gas is petrol in North America');
});

test('the words around a part say where to look: a named device, or what the spec says', () => {
  assert.equal(top('car battery')[0], 'car');
  assert.equal(top('laptop battery')[0], 'laptop');
  assert.equal(top('treadmill motor')[0], 'treadmill');
  assert.ok(['bbq_grill', 'patio_heater'].includes(top('propane tank')[0]), 'a propane tank, not a CO2 cylinder');
  assert.ok(['floor_scrubber', 'golf_cart'].includes(top('deep cycle battery')[0]));
  assert.ok(!SDG.search.search(ctx, 'deep cycle battery').devices.some(d => d.id === 'bicycle'), '"cycle" is not a bicycle');
});

test('device names, jobs and hazard cards found by how people ask', () => {
  const devs = q => SDG.search.search(ctx, q).devices.map(d => d.id);
  assert.ok(['central_ac', 'window_ac'].every(id => devs('air conditioner').includes(id)), 'a name ending names the device');
  assert.ok(devs('fridge').includes('fridge'));
  const jobs = q => SDG.search.search(ctx, q).jobs.map(j => j.id);
  assert.equal(jobs('heat my house')[0], 'heat_shelter');
  assert.ok(!onParts('heat my house').includes('heatsink'));
  assert.equal(jobs('shower')[0], 'hot_water');
  assert.equal(jobs('filter smoke')[0], 'filter_air');
  assert.equal(jobs('irrigate garden')[0], 'irrigate_crops');
  const hz = q => SDG.search.findHazards(ctx, q).map(h => h.id);
  assert.deepEqual(hz('asbestos'), ['asbestos']);
  assert.ok(hz('capacitor discharge').includes('hv_cap'));
  assert.ok(hz('lead acid').includes('lead'));
  assert.ok(!hz('magnifying glass').includes('glass'), 'a card named after an everyday thing answers only that word');
  assert.deepEqual(hz('glass'), ['glass']);
});

test('job searches switch on the job and its core parts', () => {
  for (const q of ['keep food cold', 'purify water', 'generate electricity', 'start a fire']) {
    const r = SDG.search.search(ctx, q);
    assert.ok(r.jobs.length, `${q} should match a job`);
    assert.ok([...r.sel.values()].some(v => v.via === 'job' && v.on), `${q} should switch on job parts`);
  }
  assert.equal(SDG.search.search(ctx, 'solar panel').jobs.length === 0 || onParts('solar panel').includes('solar_panel'), true);
});

test('a job can narrow a broad part type', () => {
  const sel = new Map([['compressor', { via: 'job', on: true, only: ['refrigerat', 'fridge', 'freezer'] }]]);
  const r = SDG.search.rank(ctx, sel, '', {});
  assert.ok(r.res.length > 0);
  assert.ok(r.res.every(x => x.hits.every(h => /refrigerat|fridge|freezer/i.test([h.comp.spec, x.cat.name, ...(x.cat.aliases || [])].join(' ')))));
});

test('ratings are read from spec text only when unambiguous', () => {
  const P = SDG.specs.parse;
  assert.deepEqual(P('36V pack of 18650 cells'), { v: 36 });
  assert.deepEqual(P('Magnetron, about 700–1,200 W output'), { w: [700, 1200] });
  assert.deepEqual(P('Charger: input 100-240 VAC, output 42 VDC at 1.7 A'), { v: 42, a: 1.7 }, 'the output wins');
  assert.deepEqual(P('Li-ion 5000mAh 3.7V'), { v: 3.7, ah: 5 });
  assert.deepEqual(P('-48V string of 4× 12V blocks'), {}, 'two different voltages and no output: left out');
  assert.deepEqual(P('850 VA UPS'), {}, 'VA is not volts');
  assert.deepEqual(P('RTRN-A700WRZZ transformer'), {}, 'part numbers are not ratings');
  assert.deepEqual([SDG.specs.amount('100-240'), SDG.specs.amount('12'), SDG.specs.amount('')], [[100, 240], 12, undefined]);
});

test('part numbers that look like ratings are not read as ratings', () => {
  const P = SDG.specs.parse;
  // Each of these was once read as amps, watts, volts or amp-hours from real records.
  for (const s of ['Speaker, Samsung part BN96-12859A', 'Safety sensor kit 41A5034', 'Main PWB 6871A20482A', 'Marvell Avastar 88W8797 SoC',
    'NXP 65V10 NFC controller', 'Motorola 5185963A27', 'model 11A-A2BM list', 'relay 507-2AH-F-C', 'brackets 041A5266-3',
    'fan 3612JL-04W-S49-G51', 'LED BACKLIGHT LYSB-4916W/SY', 'Door magnet, part DA61-03769A', 'loose CR123A-size cells']) assert.deepEqual(P(s), {}, s);
});

test('ratings written other ways: words, pairs, fractions and AC marks', () => {
  const P = SDG.specs.parse;
  assert.deepEqual(P('a 40 Volt brushless blower'), { v: 40 });
  assert.deepEqual(P('Controller, 50 Amp'), { a: 50 });
  assert.deepEqual(P('USB port rated 5 V DC at 1 amp'), { v: 5, a: 1 });
  assert.deepEqual(P('uses less than 18 watts'), { w: 18 });
  assert.deepEqual(P('a 2 amp-hour pack'), { ah: 2 }, 'amp-hours are not amps');
  assert.deepEqual(P('12/24V solar charge controller'), { v: [12, 24] }, 'either voltage');
  assert.deepEqual(P('input AC 100V-240V'), { v: [100, 240] }, 'a unit on both ends of a range');
  assert.deepEqual(P('1/4 W resistors'), { w: 0.25 }, 'a fraction, not a pair');
  assert.deepEqual(P('LM5108 100 V-rated half-bridge driver'), { v: 100 });
  assert.deepEqual(P('heater element, 220V~'), { v: 220, ac: true });
  assert.deepEqual(P('motor 24 V x 270 W x 4700 rpm'), { v: 24, w: 270 });
  assert.deepEqual(P('1500VA UPS with a 5 kWh bank'), {}, 'VA and kWh are neither volts nor watts');
});

test('ratings in a search: volts about right, watts at least', () => {
  const ranked = q => SDG.search.search(ctx, q).ranked.res;
  const volts = ranked('12v motor').slice(0, 5).map(x => SDG.specs.ratings(x.best.comp).v);
  assert.ok(volts.every(v => v == null || (Array.isArray(v) ? v[0] <= 13.8 && v[1] >= 10.2 : v > 10 && v < 14)), `top 12 V motors: ${JSON.stringify(volts)}`);
  assert.ok(!top('12v motor').slice(0, 10).includes('smartphone'), 'a 3 V vibration motor is not a 12 V motor');
  const panels = ranked('charge my phone').filter(x => x.best.comp.fn === 'solar_panel').map(x => x.cat.id);
  assert.ok(!panels.slice(0, 3).includes('garden_solar'), 'a garden-light cell is too small to charge a phone');
});

test('codes in a search find the logged models that contain them', () => {
  const ids = q => SDG.search.findModels(ctx, q).map(h => h.model.id);
  assert.ok(ids('BQ76930').includes('scooter_xiaomi_m365'), 'a chip on a model part');
  assert.ok(ids('r-310hk').includes('microwave_tx_sharp_r_310hk'), 'a model number, ignoring case and dashes');
  assert.deepEqual(ids('12v motor'), [], 'ratings and plain words are not codes');
  const s = SDG.search.summarize(ctx, SDG.search.search(ctx, 'BQ76930'));
  assert.equal(s.models[0].parts[0].confidence, 'Documented');
});

test('brand and product names find logged models', () => {
  const ids = q => SDG.search.findModels(ctx, q).map(h => h.model.id);
  assert.deepEqual(ids('AirSense 10'), ['cpap_resmed_airsense_10'], 'a number in the name picks the model, not a spec that mentions 10');
  assert.deepEqual(ids('air sense 10'), ['cpap_resmed_airsense_10'], 'spaces inside a name');
  assert.deepEqual(ids('resmed').sort(), ['cpap_resmed_airsense_10', 'cpap_resmed_airsense_11']);
  assert.deepEqual(ids('honda generator'), ['generator_honda_eu2200i'], 'brand plus the kind of device');
  assert.deepEqual(ids('air'), [], 'a short common word is not the MacBook Air');
  assert.deepEqual(ids('air compressor'), [], 'every word has to fit');
  assert.deepEqual(ids('bike'), [], 'a word naming the kind of device is not a brand word');
  const mb = SDG.search.findModels(ctx, 'macbook battery');
  assert.ok(mb.length && mb.every(h => h.parts.length && h.parts.every(x => /batter/i.test(x.spec + x.key + x.fn))), 'leftover words pick out parts');
});

test('a short or distinctive device name finds the device, generic words do not', () => {
  const named = q => SDG.search.findDevices(ctx, q).map(h => h.d.id);
  assert.equal(named('cpap')[0], 'cpap', 'cpap names the CPAP machine');
  assert.equal(named('microwave')[0], 'microwave', 'a word one family shares names its parent');
  assert.equal(named('espresso')[0], 'coffee_maker');
  assert.deepEqual(named('medicine'), [], 'a word from another name is not enough');
  assert.ok(!named('battery').includes('chainsaw_electric'), 'part words in a name do not name the device');
  assert.deepEqual(onParts('lead acid battery'), ['battery_pb'], 'the part type that explains more of the query wins');
  assert.deepEqual(SDG.search.findBrands(ctx, 'resmed')[0].devices.map(d => d.id), ['cpap'], 'logged models give their brand');
  assert.equal(SDG.search.findBrands(ctx, 'black and decker').length === SDG.search.findBrands(ctx, 'Black & Decker').length, true);
  assert.ok(SDG.search.findBrands(ctx, 'vevor')[0].devices.length > 10, 'a brand lists the kinds of device it makes');
  assert.deepEqual(named('dewalt drill').sort(), ['corded_tools', 'cordless_drill'], 'one word besides a brand names every device it heads');
  assert.ok(['flat_tv', 'crt_tv'].every(id => named('tv').includes(id)));
  assert.deepEqual(named('box'), [], 'vague words name nothing');
  assert.deepEqual(SDG.search.findModels(ctx, 'airsense').map(h => h.model.id).sort(), ['cpap_resmed_airsense_10', 'cpap_resmed_airsense_11'], 'a product line kept as another name still finds its models');
});

test('months since collapse: day one when unset, then looting and ageing grow', () => {
  const best = (q, m) => SDG.search.search(ctx, q, { months: m }).ranked.res[0];
  assert.equal(best('12v motor').best.s, best('12v motor', 0).best.s, 'unset is day one');
  const s = m => best('car battery', m).best.s;
  assert.ok(s(0) > s(3) && s(3) > s(12), 'wanted parts thin out over the first year');
  const place = m => SDG.search.search(ctx, 'car battery', { months: m }).ranked.blds.find(a => a.bt.id === 'house').remain;
  assert.ok(place(1) > place(6) && place(6) > place(24), 'less is left in buildings as time goes on');
  const sum = SDG.search.summarize(ctx, SDG.search.search(ctx, 'car battery', { months: 24 }), 100);
  assert.ok(sum.bestDevices.some(d => d.parts.some(p => p.oftenTaken)), 'obvious parts looters want are flagged');
  assert.ok(!sum.bestDevices[0].parts[0].oftenTaken, 'and the overlooked ones rise to the top');
});

test('time, tools and weight change the ranking', () => {
  const base = SDG.search.search(ctx, 'lead acid battery').ranked.res[0].best.s;
  const later = SDG.search.search(ctx, 'lead acid battery', { months: 24 }).ranked.res[0].best.s;
  assert.ok(later < base, 'lead-acid stock decays');
  const hands = SDG.search.search(ctx, 'battery', { tools: [] }).ranked.res;
  assert.ok(hands.some(x => x.best.missingTools.length), 'missing tools are reported');
  const motor = SDG.search.search(ctx, 'treadmill motor', { maxKg: 1 }).ranked.res;
  assert.ok(motor.length);
});

test('templates resolve: variants inherit, boards expand, absent removes', () => {
  const v = ctx.resolve('microwave_inv');
  assert.ok(v.comps.length > 3);
  assert.equal(v.parentName, ctx.get('devices', 'microwave').name);
  const withBoards = ds.devices.find(d => (d.boards || []).length);
  assert.ok(ctx.resolve(withBoards.id).comps.some(c => c.board));
});

test('logged models raise confidence; absences lower presence', () => {
  const d = SDG.util.clone(ds);
  d.models.push({ id: 'm1', device: 'treadmill', comps: [{ key: 'motor_dc_large', conf: 'verified' }, { key: 'linear_actuator', absent: true }] });
  const c = SDG.db.open(d);
  assert.equal(c.confInfo('treadmill', 'motor_dc_large').conf, 'verified');
  assert.ok(c.confInfo('treadmill', 'linear_actuator').presence < 1);
  // Documented (a cited source) sits between likely and verified, and needs its link.
  d.models.push({ id: 'm2', device: 'treadmill', comps: [{ key: 'belt_pulley', conf: 'documented', source: 'https://example.org/manual' }] });
  const c2 = SDG.db.open(d);
  assert.equal(c2.confInfo('treadmill', 'belt_pulley').conf, 'documented');
  assert.ok(SDG.db.CONF.documented.f > SDG.db.CONF.likely.f && SDG.db.CONF.documented.f < SDG.db.CONF.verified.f);
  assert.equal(SDG.schema.validateRecord('models', { id: 'm3', device: 'treadmill', comps: [{ key: 'x', conf: 'documented' }] }).ok, false);
});

test('what can I build ranks guides by coverage', () => {
  const g = ds.guides.find(x => x.kind === 'build' && (x.materials || []).some(m => m.fn && !m.optional));
  if (!g) return;
  const have = g.materials.filter(m => m.fn && !m.optional).map(m => m.fn);
  const r = SDG.search.buildable(ctx, have);
  assert.equal(r.find(x => x.guide.id === g.id).coverage, 1);
});

test('learn-first links flow forward with no loops', () => {
  const d = SDG.util.clone(ds);
  const g = d.guides.filter(x => x.tree);
  assert.ok(g.length > 50, 'most guides have an era and a branch');
  const a = g.find(x => x.tree.era === 1), b = g.find(x => x.tree.era >= 3);
  a.tree.requires = [b.id];
  assert.ok(SDG.schema.validateDataset(d).some(p => p.id === a.id && /later era/.test(p.msg)));
  const c = SDG.util.clone(ds);
  const [x, y] = c.guides.filter(q => q.tree && q.tree.era === 2).slice(0, 2);
  x.tree.requires = [y.id];
  y.tree.requires = [x.id];
  assert.ok(SDG.schema.validateDataset(c).some(p => /loop/.test(p.msg)));
});

test('a material can narrow where to scrap it', () => {
  const d = SDG.util.clone(ds);
  const guide = d.guides.find(x => x.kind === 'build' && (x.materials || []).some(m => m.fn === 'tank'));
  if (!guide) return;
  guide.materials.forEach(m => { if (m.fn === 'tank') m.only = ['drum']; });
  const c = SDG.db.open(d);
  const miss = SDG.search.buildable(c, [], { all: true }).find(x => x.guide.id === guide.id).missing.find(m => m.fn === 'tank');
  assert.ok(!miss.bestSource || /drum/i.test(JSON.stringify(c.resolve(miss.bestSource.id).comps.filter(k => k.fn === 'tank')) + miss.bestSource.name));
});

test('signatures, tampering and work stamps', async () => {
  const me = await SDG.sign.createIdentity('Tester');
  const p = await SDG.changes.makeProposal({ coll: 'models', rid: 'x_test', op: 'put', data: { device: 'vape' }, reason: 'r' }, me, 8);
  assert.ok(await SDG.sign.verify(p));
  assert.ok(await SDG.sign.checkStamp(p, 8));
  assert.equal(await SDG.sign.verify(Object.assign({}, p, { reason: 'other' })), false);
  assert.equal(await SDG.sign.checkStamp(Object.assign({}, p, { pow: '0' }), 8), false);
  await assert.rejects(() => SDG.changes.makeProposal({ coll: 'models', rid: 'Bad Id', op: 'put', data: {} }, me));
});

test('releases verify against trusted keys and detect damage', async () => {
  const key = await SDG.sign.createIdentity('Maintainer');
  const rel = await SDG.changes.signRelease(await SDG.changes.makeRelease(ds, 7), key);
  const ok = await SDG.changes.verifyRelease(rel, [key.key]);
  assert.ok(ok.hashOk && ok.signed && ok.trusted);
  assert.equal((await SDG.changes.verifyRelease(rel, [])).trusted, false);
  const bad = JSON.parse(JSON.stringify(rel));
  bad.dataset.parts[0].name = 'changed';
  assert.equal((await SDG.changes.verifyRelease(bad, [key.key])).hashOk, false);
});

test('ledger entries, checkpoints and rebase', async () => {
  const hub = await SDG.sign.createIdentity('Hub');
  const d = SDG.util.clone(ds);
  const rec = Object.assign({}, d.parts[0], { rev: 1, summary: 'changed' });
  SDG.changes.applyLedger(d, [{ seq: 1, coll: 'parts', rid: rec.id, op: 'put', data: rec }]);
  const cp = await SDG.changes.signCheckpoint(1, await SDG.changes.datasetHash(d), hub);
  assert.ok(await SDG.changes.verifyCheckpoint(cp));
  assert.equal(cp.hash, await SDG.changes.datasetHash(d));
  const edit = { coll: 'parts', rid: rec.id, op: 'put', data: Object.assign({}, ds.parts[0], { summary: 'mine' }), baseRev: 0 };
  const r = SDG.changes.rebase(d, [edit]);
  assert.equal(r.conflicts.length, 1, 'an edit made against an older revision is flagged');
  assert.equal(r.ds.parts.find(p => p.id === rec.id).summary, 'mine');
});

test('bundles round-trip and reject forged items', async () => {
  const me = await SDG.sign.createIdentity('Carrier');
  const c = await SDG.changes.makeComment('devices/treadmill', 'hello', null, me);
  const o = await SDG.changes.makeObservation({ lat: 45.123456, lon: -75.654321, status: 'untouched', share: 'peers' }, me);
  assert.equal(o.lat, 45.1235, 'coordinates are rounded');
  const b = SDG.changes.parseBundle(JSON.stringify(SDG.changes.makeBundle({ comments: [c, Object.assign({}, c, { id: 'forged', body: 'evil' })], observations: [o] })));
  const v = await SDG.changes.verifyItems(b.comments, 'comments');
  assert.equal(v.ok.length, 1);
  assert.equal(v.bad.length, 1);
  assert.equal(SDG.changes.mergeById([c], [c, o]).length, 2);
});

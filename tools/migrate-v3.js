// One-time move from the v2 single-file seed (src/seed.js) to one file per record in data/.
// Kept for reference and for anyone holding an old database export:
//   node tools/migrate-v3.js path/to/old-export.json   (adds its records to data/, skipping existing ids)
const fs = require('fs');
const path = require('path');
const SDG = require('../core');
const F = require('../lib/fsdata');

const src = process.argv[2];
if (!src) { console.log('Usage: node tools/migrate-v3.js <old seed.js or exported database.json>'); process.exit(1); }
let old;
if (src.endsWith('.js')) old = new Function(fs.readFileSync(src, 'utf8') + ';return SEED;')();
else old = JSON.parse(fs.readFileSync(src, 'utf8'));
SDG.db.migrateLegacy(old);

const HAZARDS = {
  hv_cap: ['Stored high voltage', 5, 'Capacitors in microwaves, flashes, power supplies and inverters can hold a lethal charge long after unplugging.'],
  li_fire: ['Lithium fire risk', 4, 'Damaged, swollen or shorted lithium cells can vent toxic gas and burn violently. Water does not reliably put them out.'],
  refrigerant: ['Refrigerant under pressure', 3, 'Cutting refrigerant lines releases pressurised gas that causes frostbite and can displace air in small rooms. Old units may hold ozone-depleting gases.'],
  heavy: ['Heavy', 3, 'Too heavy for one person to move safely. Crush and back injuries are the most common salvage injuries.'],
  sharp: ['Sharp edges', 2, 'Sheet metal edges, cut wires and broken plastics cause deep cuts that infect easily without medical care.'],
  glass: ['Glass', 2, 'Panels, tubes and screens shatter into sharp fragments.'],
  lead: ['Lead', 3, 'Lead in solder, CRT glass, old paint and batteries is toxic, especially to children. It builds up in the body.'],
  implosion: ['Tube implosion risk', 4, 'CRT picture tubes hold a vacuum; a cracked neck or face can implode and throw glass.'],
  spring: ['Spring under tension', 5, 'Garage door torsion springs and other large springs store enough energy to kill or maim when released.'],
  acid: ['Battery acid', 3, 'Lead-acid batteries hold sulphuric acid that burns skin and eyes and gives off explosive hydrogen when charging.'],
  hv: ['High-voltage system', 5, 'Electric vehicle packs, solar arrays and grid equipment run at voltages that kill on contact and can arc.'],
  chemical: ['Chemicals', 3, 'Toxic or corrosive liquids, oils and residues.'],
  radiation: ['Tiny radioactive source', 1, 'Ionisation smoke alarms hold a tiny americium-241 source: harmless in its housing, but do not open, eat or inhale it.'],
  fuel: ['Fuel', 4, 'Petrol, diesel and propane are flammable and their vapour is explosive in enclosed spaces.'],
};
const TOOLS = {
  hands: 'bare hands', screwdriver: 'screwdrivers', security_bits: 'security bits', socket: 'socket set', pliers: 'pliers',
  cutters: 'wire cutters', pry: 'pry bar', saw: 'saw', multimeter: 'multimeter', heavy: 'vehicle or a second person',
  desolder: 'soldering iron or desoldering tool', hex: 'hex keys', wrench: 'wrenches', drill: 'drill', grinder: 'angle grinder',
  knife: 'utility knife', bolt_cutters: 'bolt cutters', crimper: 'crimper', jack: 'jack or lifting gear', ladder: 'ladder',
  clamps: 'clamps', file: 'files', tape: 'electrical tape', tubing_cutter: 'tubing cutter', hammer: 'hammer',
};

const ds = F.load();
const have = coll => new Set((ds[coll] || []).map(r => r.id));
const vocab = ds.vocab && Object.keys(ds.vocab.tools || {}).length ? ds.vocab : { tools: {}, partGroups: [], deviceGroups: [] };
Object.entries(TOOLS).forEach(([k, v]) => { if (!vocab.tools[k]) vocab.tools[k] = v; });
old.parts.forEach(p => { if (!vocab.partGroups.includes(p.group)) vocab.partGroups.push(p.group); });
old.devices.forEach(d => { if (d.group && !vocab.deviceGroups.includes(d.group)) vocab.deviceGroups.push(d.group); });
F.writeVocab(F.DATA, vocab);

let n = 0;
const put = (coll, rec) => { if (have(coll).has(rec.id)) return; F.writeRecord(F.DATA, coll, rec); n++; };
Object.entries(HAZARDS).forEach(([id, [label, severity, summary]]) => put('hazards', { id, label, severity, summary }));
old.parts.forEach(p => put('parts', p));
old.buildings.forEach(b => put('buildings', b));
old.boards.forEach(b => put('boards', b));
old.devices.forEach(d => put('devices', d));
// The two "Example Co." samples only showed how logging works.
old.models.filter(m => !String(m.id).startsWith('m_example')).forEach(m => put('models', m));
if (!fs.existsSync(path.join(F.DATA, 'meta.json'))) F.writeMeta(F.DATA, { seq: 0, schema: 3, name: 'Scrapper’s Digital Guide to the Apocalypse' });
console.log(`Wrote ${n} records to data/`);

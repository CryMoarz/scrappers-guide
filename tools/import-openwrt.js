// Routers and access points from the OpenWrt Table of Hardware as logged models: SoC, flash, RAM,
// Wi-Fi chips, ports and power supply for each hardware version. Mainstream brands only, sold in
// North America (they have an FCC ID), with the chips known. The data is by OpenWrt wiki
// contributors under CC BY-SA 4.0, credited on every record; it lands as likely and not yet
// fact-checked, like research drafts, and models that already exist are left alone.
// Usage: node tools/import-openwrt.js [toh.json] [--dry]
//   with no file it downloads https://toh.openwrt.org/toh.json; --dry only says what it would add
const fs = require('fs');
const SDG = require('../core');
const F = require('../lib/fsdata');
const { LANDED } = require('../lib/research');

const TYPES = /router|access point|wifi|wireless/i;
const BRANDS = /^(TP-Link|Netgear|Linksys|ASUS|D-Link|Belkin|Ubiquiti|Xiaomi|ZyXEL|Buffalo|Tenda|GL\.iNet|Cisco|Arris|Motorola|Huawei|Cudy|Google)$/i;
const blank = v => v == null || /^(-|none|no|n\/a|unknown|null)?$/i.test(String(v).trim());
const one = v => (Array.isArray(v) ? v.filter(x => !blank(x)).join(', ') : blank(v) ? '' : String(v).trim());
const num = v => (/^\d+(\.\d+)?$/.test(one(v)) ? +one(v) : 0);

// An FCC ID from the links the table gives (fcc.io/TE7/ARCHERC7V2 is TE7ARCHERC7V2).
function fccId(v) {
  const first = (Array.isArray(v) ? v : [v]).map(String).find(x => /fcc/i.test(x)) || '';
  const id = first.replace(/^https?:\/\/[^/]+\//, '').split(/[?#]/)[0].replace(/\//g, '').toUpperCase();
  return /^[A-Z0-9-]{5,40}$/.test(id) ? id : '';
}

function record(r, today) {
  const version = one(r.version);
  const name = [one(r.model), version].filter(Boolean).join(' ');
  const url = 'https://openwrt.org/toh/hwdata/' + String(r.deviceid).replace(/:/g, '/');
  const src = { source: url };
  const comps = [];
  const cores = num(r.cpucores), mhz = num(r.cpumhz);
  comps.push(Object.assign({ key: 'ic_mcu_soc', fn: 'ic_mcu', spec: `SoC ${one(r.cpu)}${cores ? `, ${cores} core${cores > 1 ? 's' : ''}` : ''}${mhz ? ` at ${mhz} MHz` : ''}`, qty: 1, ext: 4, obs: 3 }, src));
  comps.push(Object.assign({ key: 'ic_memory_flash', fn: 'ic_memory', spec: `Flash, ${one(r.flashmb).replace(/(\d+)NAND/, '$1 MB NAND').replace(/^(\d+)$/, '$1 MB')}`, qty: 1, ext: 2, obs: 4 }, src));
  comps.push(Object.assign({ key: 'ic_memory_ram', fn: 'ic_memory', spec: `RAM, ${one(r.rammb)} MB`, qty: 1, ext: 3, obs: 3 }, src));
  const wifi = Array.isArray(r.wlanhardware) ? r.wlanhardware.filter(x => !blank(x)) : [];
  const bands = [one(r.wlan24ghz) && `2.4 GHz ${one(r.wlan24ghz)}`, one(r.wlan50ghz) && `5 GHz ${one(r.wlan50ghz)}`].filter(Boolean).join(', ');
  if (wifi.length) comps.push(Object.assign({ key: 'radio_rf', spec: `Wi-Fi: ${wifi.join(', ')}${bands ? ` (${bands})` : ''}`, qty: wifi.length }, src));
  const ant = num(r.detachableantennas);
  if (ant) comps.push(Object.assign({ key: 'antenna_coax', spec: 'Detachable external antennas', qty: ant }, src));
  const ps = one(r.powersupply);
  if (ps) {
    const rating = SDG.specs.parse(ps.replace(/\d[\d,.]*\s*mAh.*$/i, ''));
    comps.push(Object.assign({ key: 'psu', spec: `Power supply: ${ps}` }, ['v', 'a', 'w'].reduce((o, k) => (typeof rating[k] === 'number' ? Object.assign(o, { [k]: rating[k] }) : o), {}), src));
    const mah = /(\d[\d,]*)\s*mAh/i.exec(ps);
    if (mah) comps.push(Object.assign({ key: 'battery_li', fn: 'battery_li', spec: `Built-in lithium battery, ${mah[1]} mAh`, ah: Number(mah[1].replace(/,/g, '')) / 1000, qty: 1, ext: 2, obs: 3 }, src));
  }
  const ports = [[r.ethernet10gports, '10G'], [r.ethernet5gports, '5G'], [r.ethernet2_5gports, '2.5G'], [r.ethernet1gports, 'gigabit'], [r.ethernet100mports, '100M']].filter(([n]) => num(n)).map(([n, l]) => `${num(n)}× ${l}`);
  if (ports.length) comps.push(Object.assign({ key: 'connector', spec: `Ethernet ports: ${ports.join(', ')}`, qty: ports.reduce((s, p) => s + parseInt(p, 10), 0) }, src));
  if (one(r.usbports)) comps.push(Object.assign({ key: 'connector_usb', fn: 'connector', spec: `USB: ${one(r.usbports)}`, qty: 1, ext: 2, obs: 4 }, src));
  comps.forEach(c => { c.conf = 'likely'; });
  return {
    id: '', device: 'wifi_router', brand: one(r.brand), model: name, fcc: fccId(r.fccid) || undefined,
    notes: version ? `Chips for hardware version ${version}; other versions of the ${one(r.model)} can differ.` : `Hardware versions of the ${one(r.model)} can differ.`,
    research: { gaps: [], method: [LANDED, `Imported from the OpenWrt Table of Hardware (toh.json, ${today}): the hardware data page for this version, by OpenWrt wiki contributors under CC BY-SA 4.0.`] },
    comps,
    sources: [{ title: `OpenWrt Table of Hardware: ${one(r.brand)} ${name} (OpenWrt wiki contributors, CC BY-SA 4.0)`, url }],
  };
}

(async () => {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  const text = file ? fs.readFileSync(file, 'utf8') : await (await fetch('https://toh.openwrt.org/toh.json', { headers: { 'User-Agent': 'scrappers-guide-research/1 (+offline salvage database)' } })).text();
  const t = JSON.parse(text);
  const rows = t.entries.map(e => Object.fromEntries(t.columns.map((c, i) => [c, e[i]])));
  const ds = F.load();
  const have = new Set(ds.models.map(m => m.id));
  const today = new Date().toISOString().slice(0, 10);
  let n = 0, skipped = 0;
  for (const r of rows) {
    if (!TYPES.test(one(r.devicetype)) || !BRANDS.test(one(r.brand)) || !fccId(r.fccid) || blank(r.cpu) || blank(r.rammb) || blank(r.flashmb)) continue;
    const rec = record(r, today);
    let id = SDG.util.slug(`wifi_router_${rec.brand}_${rec.model}`).slice(0, 60);
    if (have.has(id)) { skipped++; continue; }
    rec.id = id;
    const v = SDG.schema.validateRecord('models', rec);
    if (!v.ok) { console.log(`skip ${id}: ${v.errors.slice(0, 2).map(e => e.path + ' ' + e.msg).join('; ')}`); continue; }
    have.add(id);
    if (!process.argv.includes('--dry')) F.writeRecord(F.DATA, 'models', rec);
    n++;
  }
  console.log(`${process.argv.includes('--dry') ? 'Would add' : 'Added'} ${n} router models from the OpenWrt Table of Hardware (${skipped} already in the data). Run node tools/validate.js.`);
})().catch(e => { console.error(e); process.exit(1); });

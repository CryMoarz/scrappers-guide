// Rewrites data files in the standard layout (field order from the schema, one entry per line).
// Usage: node tools/fmt.js                 (every file in data/)
//        node tools/fmt.js data/parts/x.json data/devices/y.json
const fs = require('fs');
const path = require('path');
const F = require('../lib/fsdata');
const SDG = require('../core');

let files = process.argv.slice(2);
if (!files.length) SDG.db.COLLS.forEach(c => {
  try { fs.readdirSync(path.join(F.DATA, c)).filter(f => f.endsWith('.json')).forEach(f => files.push(path.join(F.DATA, c, f))); } catch (e) { /* missing folder */ }
});
let n = 0, bad = 0;
files.forEach(file => {
  const abs = path.resolve(file);
  const coll = path.basename(path.dirname(abs));
  if (!SDG.db.COLLS.includes(coll)) { console.log(`skip ${file}: not in a data collection folder`); return; }
  try {
    const before = fs.readFileSync(abs, 'utf8');
    const after = F.format(coll, JSON.parse(before));
    if (after !== before) { fs.writeFileSync(abs, after); n++; }
  } catch (e) { console.log(`✗ ${file}: ${e.message}`); bad++; }
});
console.log(`Formatted ${n} file${n === 1 ? '' : 's'}${bad ? `, ${bad} could not be read` : ''}`);
process.exit(bad ? 1 : 0);

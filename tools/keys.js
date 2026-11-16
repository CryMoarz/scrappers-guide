// Contributor and maintainer keys. A key file is your identity: keep it private and backed up.
//   node tools/keys.js new admin.key "Your name"   make a key pair
//   node tools/keys.js show admin.key               print the public key, fingerprint and admin id (for --admin)
//   node tools/keys.js trust admin.key              add its public key to trust/keys.json (release signers)
const fs = require('fs');
const path = require('path');
const SDG = require('../core');

const [cmd, file, ...rest] = process.argv.slice(2);
const TRUST = path.join(__dirname, '..', 'trust', 'keys.json');

(async () => {
  if (cmd === 'new') {
    if (!file) throw new Error('Give a file name: node tools/keys.js new my.key "My name"');
    if (fs.existsSync(file)) throw new Error(`${file} already exists; not overwriting a key`);
    const id = await SDG.sign.createIdentity(rest.join(' '));
    fs.writeFileSync(file, JSON.stringify(id, null, 2), { mode: 0o600 });
    console.log(`Saved ${file}. Keep it private and backed up.\n  public key   ${id.key}\n  fingerprint  ${await SDG.sign.fingerprint(id.key)}\n  admin id     ${await SDG.sign.fingerprint(id.key, 32)}`);
  } else if (cmd === 'show') {
    const id = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`name         ${id.name || '(none)'}\n  public key   ${id.key}\n  fingerprint  ${await SDG.sign.fingerprint(id.key)}\n  admin id     ${await SDG.sign.fingerprint(id.key, 32)}`);
  } else if (cmd === 'trust') {
    const id = JSON.parse(fs.readFileSync(file, 'utf8'));
    let t = { keys: [] };
    try { t = JSON.parse(fs.readFileSync(TRUST, 'utf8')); } catch (e) { /* first key */ }
    if (!t.keys.some(k => k.key === id.key)) t.keys.push({ key: id.key, name: id.name || '', fingerprint: await SDG.sign.fingerprint(id.key), added: SDG.util.now().slice(0, 10) });
    fs.mkdirSync(path.dirname(TRUST), { recursive: true });
    fs.writeFileSync(TRUST, JSON.stringify(t, null, 2) + '\n');
    console.log(`Trusted ${id.name || id.key}. Rebuild the app so it carries the new key.`);
  } else {
    console.log('Usage:\n  node tools/keys.js new <file> [name]\n  node tools/keys.js show <file>\n  node tools/keys.js trust <file>');
  }
})().catch(e => { console.error(e.message); process.exit(1); });

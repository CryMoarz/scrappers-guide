// Checks that the committed app is the signed release, the one hubs serve and the image ships:
//   app/app-build.json        signed by a maintainer key in trust/keys.json
//   app/scrappers-guide.html  the file app-build.json fingerprints (SHA-256), and the build it names
//   the release inside it     whole, and signed by a maintainer key
// Usage: node tools/verify-app.js [--release] [folder]
//   --release  also check it is this version's app, built from this code: for tagging a release.
//              Between releases the committed app is the last release's, so it only has to be
//              signed. On by itself when GitHub Actions runs for a tag.
//   folder     check another copy of the project (default: this one)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SDG = require('../core');
const { codeId, embedded } = require('./build');

const ROOT = path.join(__dirname, '..');
const FIX = 'A release is built with the maintainer key (node tools/build.js --key ...). An app built without it\n' +
  'must not be committed; to put the release\'s copy back: git checkout -- app/scrappers-guide.html app/app-build.json';

// Everything wrong with the app in `root`, as sentences; none means it's the signed release.
async function verify(root = ROOT, release = false) {
  const problems = [];
  const json = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
  let keys = [], info = {}, html = '', build, rel;
  try { keys = json('trust/keys.json').keys || []; } catch (e) { problems.push(`trust/keys.json: ${e.message}`); }
  const trusted = keys.map(k => k.key);
  if (!trusted.length) problems.push('trust/keys.json has no maintainer key, so nothing can be trusted');
  try { info = json('app/app-build.json'); } catch (e) { problems.push(`app/app-build.json: ${e.message}`); }
  if (!(await SDG.changes.verifyAppBuild(info, trusted))) problems.push('app/app-build.json is not signed by a maintainer key in trust/keys.json, so apps would never offer it as an update');

  try {
    const buf = fs.readFileSync(path.join(root, 'app', 'scrappers-guide.html'));
    html = buf.toString('utf8');
    if (crypto.createHash('sha256').update(buf).digest('hex') !== info.sha256) problems.push('app/scrappers-guide.html is not the file app/app-build.json fingerprints (its SHA-256 differs)');
  } catch (e) { problems.push(`app/scrappers-guide.html: ${e.message}`); }
  try { build = embedded(html, 'BUILD'); rel = embedded(html, 'RELEASE'); } catch (e) { /* reported below */ }
  if (!build || ['version', 'date', 'id'].some(k => build[k] !== info[k])) problems.push(`the app says it is build ${JSON.stringify(build)}, but app/app-build.json describes ${info.version} ${info.date} ${info.id}`);
  if (!rel) problems.push('no release found inside the app');
  else {
    const v = await SDG.changes.verifyRelease(rel, trusted);
    if (!v.hashOk) problems.push('the release inside the app does not match its own hash');
    if (!v.trusted) problems.push(`the release inside the app is ${v.signed ? 'signed by a key not in trust/keys.json' : 'not signed'}`);
  }

  if (release) {
    let pkg = {};
    try { pkg = json('package.json'); } catch (e) { problems.push(`package.json: ${e.message}`); }
    if (info.version !== pkg.version) problems.push(`app/app-build.json is version ${info.version}, but package.json says ${pkg.version}`);
    let id = null;
    try { id = await codeId(root); } catch (e) { problems.push(`could not read the source: ${e.message}`); }
    if (id && info.id !== id) problems.push(`the app was built from other code (build ${info.id}; this source is ${id})`);
  }
  const signer = info.sig && keys.find(k => k.key === info.sig.key);
  return { problems, info, release: rel, signer: signer ? `${signer.name} (${signer.fingerprint})` : '' };
}

if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const release = args.includes('--release') || process.env.GITHUB_REF_TYPE === 'tag';
  const root = path.resolve(args.find(a => !a.startsWith('--')) || ROOT);
  const { problems, info, release: rel, signer } = await verify(root, release);
  problems.forEach(p => console.log(`✗ ${p}`));
  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length > 1 ? 's' : ''}. ${FIX}`);
    process.exit(1);
  }
  console.log(`OK: app ${info.version} (build ${info.id}, ${info.date}) with release ${rel.seq}, signed by ${signer}${release ? ', built from this version and code' : ''}`);
})().catch(e => { console.error(e); process.exit(1); });

module.exports = { verify };

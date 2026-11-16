// Builds everything people run from the canonical data and source:
//   dist/release.json(.gz)       the signed dataset release (for hubs, nodes, other tools)
//   app/scrappers-guide.html     the single-file offline app, with the release built in
// Usage: node tools/build.js [--key maintainer.key] [--force]
//   --key    sign the release, and app/app-build.json (so apps offer the update), with a maintainer key (see tools/keys.js)
//   --force  build even if validation finds problems
// require('./tools/build').make() builds both in memory and writes nothing (the tests use it, so
// they test this source rather than the app committed at the last release).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SDG = require('../core');
const F = require('../lib/fsdata');

const ROOT = F.ROOT;
const args = process.argv.slice(2);
const keyFile = args.includes('--key') ? args[args.indexOf('--key') + 1] : process.env.SDG_RELEASE_KEY;
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Inlined into a <script>: no '<' at all, so neither </script> nor <!-- can end or bend it.
const js = v => JSON.stringify(v).replace(/</g, '\\u003c');

// The release and the app from the data and source as they are now; signed if a maintainer key is given.
async function make(ds, maintainer) {
  ds = ds || F.load();
  const release = await SDG.changes.makeRelease(F.plain(ds), (ds.meta && ds.meta.seq) || 0, ds.meta && ds.meta.name);
  if (maintainer) await SDG.changes.signRelease(release, maintainer);

  let trust = [];
  try { trust = JSON.parse(read('trust/keys.json')).keys || []; } catch (e) { /* no maintainer keys yet */ }
  const pkg = JSON.parse(read('package.json'));
  // The newest release notes from CHANGELOG.md, for the app's "What's new".
  let news = [];
  try {
    news = read('CHANGELOG.md').split(/^## /m).slice(1, 7).map(sec => {
      const [head, ...lines] = sec.split('\n');
      const m = head.match(/^(\S+)(?:\s+\((.*)\))?/);
      return { version: m[1], date: m[2] || '', items: lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()) };
    });
  } catch (e) { /* no changelog */ }
  const core = SDG.MODULES.map(n => `(function(){const module={};\n${read(`core/${n}.js`)}\nmodule.exports(SDG);})();`).join('\n');
  const APP_FILES = ['store', 'md', 'forms', 'sync', 'runs', 'map', 'simple', 'calc', 'pinouts', 'pinboards', 'reference', 'app'];
  // The build id fingerprints the code, not the data: data reaches apps by sync, so only a code
  // change should tell people there's a newer app to download.
  const code = [core, ...APP_FILES.map(n => read(`app/src/${n}.js`)), read('app/src/styles.css'), read('app/src/index.html')].join('\n');
  const build = { version: pkg.version, date: new Date().toISOString().slice(0, 10), id: (await SDG.util.sha256hex(code)).slice(0, 12) };
  const buildFile = path.join(ROOT, 'app', 'app-build.json');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(buildFile, 'utf8')); } catch (e) { /* first build */ }
  const same = prev.id === build.id && prev.version === build.version;
  if (same) build.date = prev.date;
  const scripts = [
    '"use strict";',
    'const SDG = {};',
    core,
    `SDG.schema.use(${js(SDG.schema.root())});`,
    `const RELEASE = ${js(release)};`,
    `const TRUST = ${js(trust.map(k => ({ key: k.key, name: k.name })))};`,
    `const BUILD = ${js(build)};`,
    `const NEWS = ${js(news)};`,
    ...APP_FILES.map(n => `// ---- app/src/${n}.js ----\n${read(`app/src/${n}.js`)}`),
  ].join('\n');
  const tpl = read('app/src/index.html');
  if (!tpl.includes('/*STYLES*/') || !tpl.includes('/*SCRIPTS*/') || !tpl.includes('/*CSP*/')) throw new Error('app/src/index.html is missing a placeholder');
  let html = tpl.replace('/*STYLES*/', () => read('app/src/styles.css')).replace('/*SCRIPTS*/', () => scripts);
  // Only the one script this build wrote may run: injected markup can't add a script or handler.
  // ('unsafe-inline' is ignored wherever hashes are understood, and keeps very old browsers working.)
  const inline = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const csp = `default-src 'none'; script-src 'sha256-${require('crypto').createHash('sha256').update(inline, 'utf8').digest('base64')}' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src *; base-uri 'none'; form-action 'none'; object-src 'none'`;
  html = html.replace('/*CSP*/', () => csp);
  // Hubs serve this as-is so apps elsewhere can offer an update: apps compare the id (only code
  // changes count), show it only when a maintainer key signed it, and check a download's sha256.
  const info = Object.assign({}, build, { sha256: await SDG.util.sha256hex(html) });
  if (maintainer) await SDG.changes.signAppBuild(info, maintainer);
  return { release, html, info };
}

if (require.main === module) (async () => {
  const ds = F.load();
  const problems = [...ds.loadProblems, ...SDG.schema.validateDataset(ds)];
  if (problems.length) {
    problems.slice(0, 30).forEach(p => console.log(`✗ ${p.coll}/${p.id}  ${p.path} ${p.msg}`));
    if (!args.includes('--force')) { console.log(`\n${problems.length} problems. Fix them, or build anyway with --force.`); process.exit(1); }
    console.log(`\nBuilding anyway with ${problems.length} problems (--force).`);
  }
  const maintainer = keyFile ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : null;
  const { release, html, info } = await make(ds, maintainer);
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const relText = JSON.stringify(release);
  fs.writeFileSync(path.join(ROOT, 'dist', 'release.json'), relText);
  fs.writeFileSync(path.join(ROOT, 'dist', 'release.json.gz'), zlib.gzipSync(relText, { level: 9 }));
  fs.writeFileSync(path.join(ROOT, 'app', 'scrappers-guide.html'), html);
  fs.writeFileSync(path.join(ROOT, 'app', 'app-build.json'), JSON.stringify(info, null, 2) + '\n');

  const kb = n => Math.round(n / 1024) + ' KB';
  const s = SDG.db.open(F.plain(ds)).stats();
  console.log(`Built release ${release.seq}${release.sig ? ' (signed)' : ' (unsigned)'}: ${s.devices} devices, ${s.parts} part types, ${s.guides} guides, ${s.jobs} jobs`);
  console.log(`  dist/release.json        ${kb(relText.length)} (${kb(fs.statSync(path.join(ROOT, 'dist', 'release.json.gz')).size)} gzipped)`);
  console.log(`  app/scrappers-guide.html ${kb(Buffer.byteLength(html))}`);
})().catch(e => { console.error(e); process.exit(1); });

module.exports = { make };

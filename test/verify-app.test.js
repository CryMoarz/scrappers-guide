// The committed app must be the signed release: hubs serve its app-build.json so apps offer it as
// an update, and the container image ships it. tools/verify-app.js checks that in CI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SDG = require('../core');
const { make } = require('../tools/build');
const { verify } = require('../tools/verify-app');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'verify-app.js');
const run = (...args) => execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe', env: Object.assign({}, process.env, { GITHUB_REF_TYPE: 'branch' }) });

test('verify-app: the committed app is the signed release', async (t) => {
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'app-build.json'), 'utf8'));
  if (!info.sig) return t.skip('app/ holds a build made here without the maintainer key; CI checks the committed one');
  assert.deepEqual((await verify()).problems, []);
  assert.match(run(), /^OK: app /);
});

test('verify-app: a changed, unsigned or out-of-date app fails', async (t) => {
  const maintainer = await SDG.sign.createIdentity('Maintainer');
  const stranger = await SDG.sign.createIdentity('Stranger');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A copy of the project with a maintainer key of its own, and an app built and signed with it.
  for (const d of ['core', 'app/src']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.mkdirSync(path.join(dir, 'trust'));
  fs.writeFileSync(path.join(dir, 'trust', 'keys.json'), JSON.stringify({ keys: [{ key: maintainer.key, name: 'Maintainer', fingerprint: await SDG.sign.fingerprint(maintainer.key) }] }));
  const put = (html, info) => {
    fs.writeFileSync(path.join(dir, 'app', 'scrappers-guide.html'), html);
    fs.writeFileSync(path.join(dir, 'app', 'app-build.json'), JSON.stringify(info));
  };
  const problems = async release => (await verify(dir, release)).problems.join('\n');
  // Fingerprint and sign an app file as a maintainer would, whatever is inside it.
  const seal = async (html, info, who = maintainer) => SDG.changes.signAppBuild(Object.assign({}, info, { sig: undefined, sha256: await SDG.util.sha256hex(html) }), who);

  const signed = await make(undefined, maintainer);
  put(signed.html, signed.info);
  assert.equal(await problems(true), '', 'signed by a trusted key, built from this code for this version');

  put(signed.html + ' ', signed.info);
  assert.match(await problems(), /SHA-256 differs/, 'one byte of the app changed');
  put(signed.html, Object.assign({}, signed.info, { version: '9.9.9' }));
  assert.match(await problems(), /app-build\.json is not signed by a maintainer key/, 'changed after signing');
  put(signed.html, await seal(signed.html, signed.info, stranger));
  assert.match(await problems(), /app-build\.json is not signed by a maintainer key/, 'signed by a key not in trust/keys.json');
  const unsigned = await make();
  put(unsigned.html, unsigned.info);
  assert.match(await problems(), /app-build\.json is not signed/, 'what tools/build.js writes without a key');

  // A properly sealed app file whose release inside is unsigned, or was changed after signing.
  put(unsigned.html, await seal(unsigned.html, unsigned.info));
  assert.match(await problems(), /release inside the app is not signed/);
  const at = signed.html.indexOf('\nconst RELEASE = ') + 17, end = signed.html.indexOf(';\n', at);
  const rel = JSON.parse(signed.html.slice(at, end));
  rel.dataset.parts[0].name += ' (changed)';
  const forged = signed.html.slice(0, at) + JSON.stringify(rel).replace(/</g, '\\u003c') + signed.html.slice(end);
  put(forged, await seal(forged, signed.info));
  assert.match(await problems(), /release inside the app does not match its own hash/);

  // Between releases the version and code move ahead of the committed app; a tag must match both.
  put(signed.html, signed.info);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(Object.assign(pkg, { version: '99.0.0' })));
  fs.appendFileSync(path.join(dir, 'core', SDG.MODULES[0] + '.js'), '\n// changed since the release\n');
  assert.equal(await problems(), '');
  assert.match(await problems(true), /package\.json says 99\.0\.0/);
  assert.match(await problems(true), /built from other code/);

  // The command line: a list of problems and exit status 1.
  assert.match(run(dir), /^OK: /);
  assert.throws(() => run('--release', dir), e => e.status === 1 && /^✗ .*99\.0\.0/m.test(e.stdout));
});

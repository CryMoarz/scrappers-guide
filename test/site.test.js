// The website, built from the real data into a temporary folder: a page for every record, every link
// inside the site lands on a page, and no page carries a script.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../lib/fsdata');

test('website: a page per record, links that land, no scripts', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-site-'));
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'site.js'), '--out', out, '--base', 'https://example.org/sg/'], { stdio: 'pipe' });
    const data = F.load();
    const live = r => !r.deprecated && !r.abstract;
    for (const coll of ['devices', 'models', 'parts', 'guides', 'hazards', 'jobs', 'buildings']) {
      const dirs = fs.readdirSync(path.join(out, coll)).filter(f => fs.statSync(path.join(out, coll, f)).isDirectory());
      assert.strictEqual(dirs.length, data[coll].filter(live).length, `${coll}: one page per record`);
    }
    const scooter = fs.readFileSync(path.join(out, 'devices', 'scooter', 'index.html'), 'utf8');
    assert.match(scooter, /<link rel="canonical" href="https:\/\/example\.org\/sg\/devices\/scooter\/">/);
    assert.match(scooter, /href="\.\.\/\.\.\/parts\/[a-z0-9_]+\/"/, 'part names link to their pages');
    assert.match(scooter, /href="\.\.\/\.\.\/app\/#browse\/devices\/scooter"/, 'and the page opens in the app');

    const pages = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) { if (p !== path.join(out, 'app')) walk(p); } else if (f === 'index.html') pages.push(p);
      }
    })(out);
    const broken = [];
    for (const p of pages) {
      const html = fs.readFileSync(p, 'utf8');
      assert.ok(!/<script/i.test(html), `${path.relative(out, p)} has no script`);
      for (const [, u] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        if (/^(https?|mailto):/.test(u)) continue;
        let t = path.resolve(path.dirname(p), u.split('#')[0] || '.');
        if (fs.existsSync(t) && fs.statSync(t).isDirectory()) t = path.join(t, 'index.html');
        if (u.startsWith('#') || !fs.existsSync(t)) broken.push(`${path.relative(out, p)} -> ${u}`);
      }
    }
    assert.deepStrictEqual(broken.slice(0, 5), [], 'every link inside the site lands on a page');
    const sitemap = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
    assert.strictEqual((sitemap.match(/<loc>/g) || []).length, pages.length, 'the sitemap lists every page');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

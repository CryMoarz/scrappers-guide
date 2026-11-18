// The website, built from the real data into a temporary folder: a page for every record, every link
// inside the site lands on a page, and no page carries a script; with a visit counter, the only script
// is the counter, at its pinned version and allowed by each page's policy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../lib/fsdata');

const SITE_JS = path.join(__dirname, '..', 'tools', 'site.js');
// Every page's index.html, leaving out the app (the signed release, checked on its own).
function pagesIn(out) {
  const pages = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { if (p !== path.join(out, 'app')) walk(p); } else if (f === 'index.html') pages.push(p);
    }
  })(out);
  return pages;
}

test('website: a page per record, links that land, no scripts', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-site-'));
  try {
    execFileSync(process.execPath, [SITE_JS, '--out', out, '--base', 'https://example.org/sg/'], { stdio: 'pipe' });
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

    const pages = pagesIn(out);
    assert.ok(!/goatcounter/.test(fs.readFileSync(pages[0], 'utf8')), 'no counter unless given a code');
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

test('website with the visit counter: the pinned script on every page, nothing else', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-site-'));
  try {
    execFileSync(process.execPath, [SITE_JS, '--out', out, '--base', 'https://example.org/sg/', '--counter', 'example'], { stdio: 'pipe' });
    const pinned = '<script data-goatcounter="https://example.goatcounter.com/count" async src="https://gc.zgo.at/count.v5.js" crossorigin="anonymous" integrity="sha384-';
    for (const p of pagesIn(out)) {
      const html = fs.readFileSync(p, 'utf8'), at = path.relative(out, p);
      const scripts = html.match(/<script[^>]*>/gi) || [];
      assert.strictEqual(scripts.length, 1, `${at}: one script`);
      assert.ok(scripts[0].startsWith(pinned), `${at}: the pinned counter, checked by its hash`);
      const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src https:\/\/gc\.zgo\.at\/count\.v5\.js;/, `${at}: the policy allows that one script file`);
      assert.match(csp, /img-src 'self' https:\/\/example\.goatcounter\.com\/count;/);
      assert.match(csp, /connect-src https:\/\/example\.goatcounter\.com\/count;/);
    }
    const scooter = fs.readFileSync(path.join(out, 'devices', 'scooter', 'index.html'), 'utf8');
    assert.match(scooter, /<noscript><img class="count" src="https:\/\/example\.goatcounter\.com\/count\?p=%2Fsg%2Fdevices%2Fscooter%2F&amp;t=/, 'the image counts the same path as the script');
    assert.match(scooter, /Visits are counted with <a [^>]*>GoatCounter<\/a>/, 'and the footer says so');
    const missing = fs.readFileSync(path.join(out, '404.html'), 'utf8');
    assert.ok(missing.includes(pinned) && !missing.includes('<noscript>'), 'the missing page counts the address asked for, not the front page');
    assert.ok(fs.readFileSync(path.join(out, 'app', 'index.html')).equals(fs.readFileSync(path.join(__dirname, '..', 'app', 'scrappers-guide.html'))), 'the app is the signed release as it is');
    assert.throws(() => execFileSync(process.execPath, [SITE_JS, '--out', out, '--counter', 'Not a code'], { stdio: 'pipe' }), 'a code that could break out of the page is refused');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

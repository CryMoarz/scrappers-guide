#!/usr/bin/env node
// Takes the README's screenshots from a running hub with headless Firefox, through WebDriver BiDi:
// the standard remote-control protocol built into Firefox, so there is nothing to install but Firefox.
//   node tools/screenshots.js --url http://127.0.0.1:8787 [--out docs/img] [--only search,phone] [--firefox path]
// The map and library-link shots need a hub with an offline map and Kiwix libraries (a NOMAD box,
// or a hub started with --map and --kiwix); without them those pictures show the "no map" notes.
// Each shot opens a view by its address, may run a little script in the page (the app's own
// functions: setQuery, save, route), then saves a PNG. Phone shots are taken at twice the size.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const BASE = (opt('url') || 'http://127.0.0.1:8787').replace(/\/$/, '');
const OUT = path.resolve(opt('out') || path.join(__dirname, '..', 'docs', 'img'));
const ONLY = opt('only') ? opt('only').split(',') : null;
const FIREFOX = opt('firefox') || 'firefox';

// Where the map shot stands: a public place, never anyone's home (Parliament Hill, Ottawa).
const HERE = { lat: 45.4236, lon: -75.7009 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// What to show. `run` is page script, awaited. `clip` is a selector to crop to, starting from the
// top of `from` if given, with `pad` pixels of room; without it the shot is the whole viewport.
// `local` opens the built app with no hub behind it: the single file on a phone. It is served from
// a bare web server here, since Firefox's remote protocol won't open file:// pages without wider rights.
const SHOTS = [
  { name: 'search', width: 1280, height: 900, hash: 'scrap', run: `setQuery('pump water from the creek')` },
  { name: 'device', width: 414, height: 640, dpr: 2, hash: 'browse/devices/scooter' },
  { name: 'phone', width: 390, height: 844, dpr: 2, simple: true, local: true, hash: 'simple',
    run: `{ const q = document.querySelector('#v-simple input[type=search], #v-simple input'); q.value = 'car battery';
      q.dispatchEvent(new Event('input', { bubbles: true })); const f = q.closest('form'); if (f) f.requestSubmit(); }` },
  { name: 'map', width: 1280, height: 800, hash: 'map', wait: 6000,
    run: `{ await new Promise(r => { const t = setInterval(() => { if (document.querySelector('#mapform')) { clearInterval(t); r(); } }, 100); });
      document.querySelector('#mapq').value = 'car battery'; document.querySelector('#mapform').requestSubmit(); }` },
  { name: 'pinout', width: 390, height: 844, dpr: 2, hash: 'ref/pinouts/esp32_devkitc_v4' },
  { name: 'library-links', width: 414, height: 900, dpr: 2, hash: 'browse/hazards/acid', clip: '#v-browse .lookups', from: '#v-browse p:has(a[href*="when_no_help_is_coming"])', pad: 8 },
];

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
}

// Starts Firefox with an empty profile of its own and waits for its BiDi address.
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-shots-'));
  // Light colours whatever the desktop uses, and no first-run pages.
  fs.writeFileSync(path.join(profile, 'user.js'), [
    'user_pref("layout.css.prefers-color-scheme.content-override", 1);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  ].join('\n'));
  const port = await freePort();
  const ff = spawn(FIREFOX, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('Firefox did not start its remote protocol within 30 s')), 30e3);
    let buf = '';
    ff.stderr.on('data', d => { buf += d; const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); res(m[1]); } });
    ff.on('exit', c => { clearTimeout(t); rej(new Error(`Firefox exited (${c}) before it was ready. Is it installed? Try --firefox <path>.`)); });
  });
  return { ff, profile, url: ws.replace(/\/$/, '') + '/session' };
}

// The protocol: JSON commands over a WebSocket, each answered by id.
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Could not connect to Firefox at ' + url)); });
  let id = 0; const waiting = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    const w = m.id && waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.type === 'error') w.rej(new Error(`${w.method}: ${m.error}: ${m.message}`)); else w.res(m.result);
  };
  const send = (method, params) => new Promise((res, rej) => { const n = ++id; waiting.set(n, { res, rej, method }); ws.send(JSON.stringify({ id: n, method, params })); });
  return { send, close: () => ws.close() };
}

// Serves the built app and nothing else, so it finds no hub and works from its own data.
async function fileServer() {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'scrappers-guide.html'));
  const srv = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(app);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/` };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const local = await fileServer();
  const { ff, profile, url } = await launch();
  let b;
  try {
    b = await connect(url);
    await b.send('session.new', { capabilities: {} });
    const { contexts } = await b.send('browsingContext.getTree', {});
    const context = contexts[0].context;
    // Results come back as JSON text: the protocol's own encoding of objects is clumsier to read.
    const js = async expr => {
      const r = await b.send('script.evaluate', { expression: `(async () => JSON.stringify(await (async () => { ${expr} })()))()`, target: { context }, awaitPromise: true, resultOwnership: 'none' });
      if (r.type === 'exception') throw new Error('In the page: ' + r.exceptionDetails.text);
      return r.result && typeof r.result.value === 'string' ? JSON.parse(r.result.value) : undefined;
    };
    const go = async (page, hash) => {
      await b.send('browsingContext.navigate', { context, url: `${page}#${hash}`, wait: 'complete' });
      for (let i = 0; i < 100; i++) {
        if (await js('return typeof S === "object" && !!S.ctx && !!document.querySelector(".view:not([hidden])")')) {
          // The hub's info (which libraries it has) can land after the first drawing: wait, then redraw.
          return js('for (let i = 0; i < 50 && S.settings.hubUrl && !S.hub.info; i++) await new Promise(r => setTimeout(r, 200)); route(); return true;');
        }
        await sleep(200);
      }
      throw new Error('The app did not start at ' + BASE);
    };
    // Settings for every shot: no intro card, light theme, standing at HERE.
    // They are saved per page (hub or file), so each page gets them once it has opened, before the
    // shot's own address: the map, for one, centres on where you stand only when it first draws.
    const settings = async simple => js(`Object.assign(S.settings, { introSeen: true, theme: 'light', here: ${JSON.stringify(HERE)}, mapKm: 2, simple: ${!!simple} }); await save('settings'); return true;`);
    let open = null;
    for (const s of SHOTS) {
      if (ONLY && !ONLY.includes(s.name)) continue;
      // A page first: Firefox's own start page can't be resized from outside.
      const page = s.local ? local.url : BASE + '/';
      if (page !== open) { await go(page, 'scrap'); open = page; }
      await b.send('browsingContext.setViewport', { context, viewport: { width: s.width, height: s.height }, devicePixelRatio: s.dpr || 1 });
      await settings(s.simple);
      await go(page, s.hash);
      if (s.run) await js(s.run);
      await sleep(s.wait || 1500);
      let clip;
      if (s.clip) {
        // Some parts arrive after the page, such as library links once the hub says what is installed.
        const box = await js(`let e; for (let i = 0; i < 50 && !(e = document.querySelector(${JSON.stringify(s.clip)})); i++) await new Promise(r => setTimeout(r, 200));
          if (!e) return null; const f = ${s.from ? `document.querySelector(${JSON.stringify(s.from)}) || e` : 'e'}, p = ${s.pad || 0};
          e.scrollIntoView({ block: 'center' }); const a = f.getBoundingClientRect(), r = e.getBoundingClientRect(), left = Math.min(a.left, r.left);
          return { x: Math.max(0, left - p), y: Math.max(0, a.top - p) + scrollY, width: Math.max(a.right, r.right) - left + 2 * p, height: r.bottom - a.top + 2 * p };`);
        if (!box) throw new Error(`${s.name}: nothing matches ${s.clip}`);
        clip = { type: 'box', ...box };
      }
      const { data } = await b.send('browsingContext.captureScreenshot', clip ? { context, origin: 'document', clip } : { context, origin: 'viewport' });
      const file = path.join(OUT, s.name + '.png');
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`${s.name}.png  ${s.width}×${s.height}${s.dpr ? ' @' + s.dpr + 'x' : ''}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
    }
  } finally {
    if (b) b.close();
    ff.kill();
    local.srv.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });

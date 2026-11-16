// A hub next to Project NOMAD: discovers Kiwix books, reports library links, pins field notes on the map.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SDG = require('../core');
const F = require('../lib/fsdata');
const config = require('../server/config');
const { createHub } = require('../server/hub');

// /api/v1/info as a browser at `host` would get it (fetch won't let a test set the Host header).
const infoAs = (url, host) => new Promise((ok, fail) => http.get(url + '/api/v1/info', { headers: { Host: host } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => ok(JSON.parse(b))); }).on('error', fail));
const until = async fn => { for (let i = 0; i < 100; i++) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

// Stand-in for NOMAD's Command Center (app list, markers, AI knowledge base) and its Kiwix server
// (catalog), on one port. The knowledge base starts with an old copy of the guide and someone's notes.
function fakeNomad() {
  const markers = [];
  const rag = { files: ['/app/storage/kb_uploads/scrappers-guide-devices.md-0a1b2c3d4e5f.md', '/app/storage/kb_uploads/my-notes.md-9f8e7d6c5b4a.md'], deleted: [], uploads: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      if (req.url === '/api/system/services') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([
          { service_name: 'nomad_kiwix_server', installed: 1, ui_location: String(server.address().port), custom_url: null },
          { service_name: 'nomad_ollama', installed: 1, ui_location: '/chat', custom_url: null },
        ]));
      }
      if (req.url.startsWith('/catalog/v2/entries')) {
        res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
        // Like a real Kiwix: a short catalog name, and the dated name in the book's address.
        return res.end(`<feed>${['wikipedia_en_all_maxi_2026-01', 'wikipedia_en_medicine_maxi_2026-01', 'ifixit_en_all_2025-12'].map(n => `<entry><name>${n.replace(/(_maxi)?_\d{4}-\d{2}$/, '')}</name><title>${n}</title><link type="text/html" href="/content/${n}" /></entry>`).join('')}</feed>`);
      }
      // One iFixit page is in the book; any other is not, as with a guide newer than the snapshot.
      if (req.url === '/content/ifixit_en_all_2025-12/Guide/Known+Fix/1') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(req.method === 'HEAD' ? undefined : '<h1>Known fix</h1>'); }
      if (req.url === '/api/rag/files' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ files: rag.files }));
      }
      if (req.url === '/api/rag/files' && req.method === 'DELETE') {
        const { source } = JSON.parse(body);
        rag.deleted.push(source);
        rag.files = rag.files.filter(f => f !== source);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"message":"deleted"}');
      }
      if (req.url === '/api/rag/upload' && req.method === 'POST') {
        rag.uploads.push({ name: (/filename="([^"]+)"/.exec(body) || [])[1], collection: (/name="collection"\r\n\r\n([^\r]+)/.exec(body) || [])[1], size: body.length });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        return res.end('{"message":"queued"}');
      }
      if (req.url === '/api/maps/markers' && req.method === 'POST') {
        const m = Object.assign({ id: markers.length + 1 }, JSON.parse(body));
        markers.push(m);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(m));
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, markers, rag, url: `http://127.0.0.1:${server.address().port}` })));
}

test('hub with NOMAD: library links and map pins', async (t) => {
  const nomad = await fakeNomad();
  t.after(() => nomad.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-nomad-'));
  fs.cpSync(F.DATA, path.join(dir, 'data'), { recursive: true });
  const cfg = config.load([], {}, { port: 0, dataDir: path.join(dir, 'data'), stateDir: path.join(dir, 'state'), mode: 'node', policy: { powBits: 0 }, nomad: { url: nomad.url, kiwix: nomad.url, markers: true, kb: true } });
  const hub = await createHub(cfg);
  const addr = await hub.listen();
  t.after(() => hub.close());
  const url = `http://127.0.0.1:${addr.port}`;

  assert.ok(await until(async () => { const i = await (await fetch(url + '/api/v1/info')).json(); return i.libraries && i.libraries.kiwix && i.libraries.kiwix.books; }), 'kiwix books discovered');
  const info = await (await fetch(url + '/api/v1/info')).json();
  assert.equal(info.libraries.kiwix.books.ifixit, 'ifixit_en_all_2025-12');
  assert.equal(info.libraries.kiwix.books.electronics, undefined, 'books that are not installed are not linked');

  // A cited page on a site an installed book copies opens in that book, or in a search of the book
  // when its copy lacks the page. Sites no installed book copies get nothing.
  const off = async (u, t) => { const r = await fetch(`${url}/api/v1/offline?u=${encodeURIComponent(u)}${t ? '&t=' + encodeURIComponent(t) : ''}`, { redirect: 'manual' }); return [r.status, r.headers.get('location')]; };
  assert.deepEqual(await off('https://www.ifixit.com/Guide/Known+Fix/1'), [302, `${nomad.url}/content/ifixit_en_all_2025-12/Guide/Known+Fix/1`]);
  assert.deepEqual(await off('https://ifixit.com/Guide/Newer+Fix/2', 'iFixit: Newer fix'), [302, `${nomad.url}/search?books.name=ifixit_en_all_2025-12&pattern=Newer%20fix`]);
  assert.equal((await off('https://medlineplus.gov/ency/article/000039.htm'))[0], 404, 'MedlinePlus is not installed here');
  assert.equal((await off('javascript:alert(1)'))[0], 404);

  // A whole-encyclopedia Wikipedia wins over a topic subset, whatever order they're listed in.
  const libs = hub.getCtx().ds.vocab.libraries;
  assert.equal(SDG.text.matchBooks(libs, [{ name: 'wikipedia_en_medicine', book: 'wikipedia_en_medicine_maxi_2026-01' }, { name: 'wikipedia_en_100', book: 'wikipedia_en_100_mini_2026-01' }]).wikipedia, 'wikipedia_en_100_mini_2026-01');

  // Links resolve the way the app and AI tools build them.
  const ctx = hub.getCtx();
  const burn = SDG.text.lookups(ctx, 'hazards', ctx.get('hazards', 'burn')).map(l => SDG.text.libraryUrl(info.libraries, l, ctx.ds.vocab.libraries));
  assert.ok(burn.includes(nomad.url + '/conditions/burns'));
  assert.ok(burn.some(u => u && u.includes('books.name=wikipedia_en_medicine_maxi_2026-01')));

  // A phone on the network reaches the hub by its LAN address, so links to a NOMAD on the hub's
  // own machine ("localhost" to the hub) come back on that address instead.
  const lan = nomad.url.replace('127.0.0.1', '192.168.9.9');
  const viaLan = await infoAs(url, '192.168.9.9:8787');
  assert.equal(viaLan.libraries.kiwix.url, lan);
  assert.equal(viaLan.libraries.nomad.url, lan);
  assert.equal(info.libraries.kiwix.url, nomad.url, 'callers on this machine keep their own address');

  // MCP get_record carries the same links.
  const r = await (await fetch(url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_record', arguments: { collection: 'devices', id: 'microwave_tx' } } }) })).json();
  assert.ok(r.result.structuredContent.seeAlso.some(s => s.url && s.url.includes('ifixit_en_all_2025-12')));

  // A shared field note becomes a coloured pin on NOMAD's map.
  const me = await SDG.sign.createIdentity('Scout');
  const o = await SDG.changes.makeObservation({ lat: 45.42, lon: -75.69, status: 'dangerous', share: 'peers', label: 'Collapsed pharmacy', notes: 'Roof down' }, me);
  assert.equal((await (await fetch(url + '/api/v1/observations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })).json()).status, 'stored');
  assert.ok(await until(() => nomad.markers.length === 1), 'pin pushed');
  assert.equal(nomad.markers[0].color, 'red');
  assert.equal(nomad.markers[0].name, 'Collapsed pharmacy');

  // The guide goes into NOMAD's AI knowledge base, replacing its old copy and nothing else.
  assert.ok(await until(() => nomad.rag.uploads.length === 7), 'seven documents uploaded');
  assert.deepEqual(nomad.rag.deleted, ['/app/storage/kb_uploads/scrappers-guide-devices.md-0a1b2c3d4e5f.md']);
  assert.ok(nomad.rag.files.includes('/app/storage/kb_uploads/my-notes.md-9f8e7d6c5b4a.md'), 'other files are left alone');
  assert.deepEqual(nomad.rag.uploads.map(u => u.name).sort(), ['buildings', 'devices', 'guides', 'hazards', 'jobs', 'models', 'parts'].map(c => `scrappers-guide-${c}.md`));
  assert.ok(nomad.rag.uploads.every(u => u.collection === 'scrappers-guide' && u.size > 1000));
  assert.equal(hub.store.get('nomadKb'), await hub.datasetHash(), 'not uploaded again until the data changes');
});

test('installed as a NOMAD app: finds NOMAD and its library with no settings', async (t) => {
  const nomad = await fakeNomad();
  t.after(() => nomad.server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-nomad-auto-'));
  // As the container runs it: data from the image, NOMAD found by trying the places it can be.
  const cfg = config.load([], {}, { port: 0, dataDir: path.join(dir, 'data'), seedDir: F.DATA, stateDir: path.join(dir, 'state'), mode: 'node', policy: { powBits: 0 }, nomad: { url: 'auto', candidates: ['http://127.0.0.1:9', nomad.url] } });
  const hub = await createHub(cfg);
  const addr = await hub.listen();
  t.after(() => hub.close());
  const url = `http://127.0.0.1:${addr.port}`;
  const port = new URL(nomad.url).port;

  assert.ok(await until(async () => { const i = await (await fetch(url + '/api/v1/info')).json(); return i.libraries && i.libraries.kiwix && i.libraries.kiwix.books; }), 'library found through NOMAD\'s app list');
  const info = await (await fetch(url + '/api/v1/info')).json();
  assert.equal(info.counts.devices, SDG.db.open(F.plain(F.load())).ds.devices.length, 'bundled data installed');
  assert.equal(info.libraries.kiwix.books.ifixit, 'ifixit_en_all_2025-12');
  // A phone gets NOMAD and its library on the address it used for the guide, as NOMAD's own Open buttons work.
  const phone = await infoAs(url, '10.0.0.7:8787');
  assert.equal(phone.libraries.nomad.url, `http://10.0.0.7:${port}`);
  assert.equal(phone.libraries.kiwix.url, `http://10.0.0.7:${port}`);
  assert.equal(phone.libraries.kiwix.port, undefined, 'internal details stay inside');
});

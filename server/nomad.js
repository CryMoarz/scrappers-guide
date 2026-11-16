// Project NOMAD and Kiwix integration for a hub or node running next to them.
//  - Finds which Kiwix books are installed (from the catalog, server-side, so browsers don't
//    trip over cross-origin rules) and tells apps and AI tools where each library lives.
//  - Optionally puts shared field notes on NOMAD's offline map as coloured pins.
// Ports are NOMAD's defaults: the Command Center on 8080, Kiwix on 8090.
const SDG = require('../core');

const PIN = { untouched: 'green', partial: 'yellow', cleared: 'blue', dangerous: 'red', occupied: 'purple' };

async function fetchText(url, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout || 15e3);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

// Books in a Kiwix OPDS catalog (Atom XML), without an XML library. A catalog names a book
// "wikipedia_en_100", but links and searches need the name in its address,
// "wikipedia_en_100_mini_2026-01": keep both, match on the first, link with the second.
function catalogBooks(xml) {
  return [...String(xml).matchAll(/<entry>[\s\S]*?<\/entry>/g)].map(m => {
    const name = (/<name>([^<]+)<\/name>/.exec(m[0]) || [])[1];
    const book = (/href="[^"]*\/content\/([^"/]+)"/.exec(m[0]) || [])[1];
    return name || book ? { name: name || book, book: book || name } : null;
  }).filter(Boolean);
}

// Where NOMAD can be when SDG_NOMAD=auto, in order: by name from inside one of its app containers
// (custom apps join its network), from other containers, then from this machine itself.
function candidates() {
  // Outside a container the default gateway is the network's router, which is no place to look.
  const gw = require('fs').existsSync('/.dockerenv') && defaultGateway();
  return ['http://nomad_admin:8080', 'http://host.docker.internal:8080', gw && `http://${gw}:8080`, 'http://localhost:8080'].filter(Boolean);
}

// The Docker host, seen from inside a container: the default gateway in the kernel's routing table.
function defaultGateway() {
  try {
    for (const line of require('fs').readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === '00000000' && /^[0-9A-F]{8}$/i.test(f[2] || '') && f[2] !== '00000000') return f[2].match(/../g).reverse().map(h => parseInt(h, 16)).join('.');
    }
  } catch (e) { /* not Linux */ }
  return null;
}

// NOMAD's list of apps. It also proves an address is a NOMAD: its own services are named nomad_*.
async function nomadServices(url) {
  const list = JSON.parse(await fetchText(`${url}/api/system/services`, 5e3));
  if (!Array.isArray(list) || !list.some(s => /^nomad_/.test((s && s.service_name) || ''))) throw new Error('not a NOMAD Command Center');
  return list;
}

// Where browsers open a NOMAD app, the way NOMAD's own Open buttons work: its custom launch URL if
// one is set, otherwise its port on whatever address the browser reached NOMAD by.
function appLink(s) {
  if (s.custom_url) return { url: String(s.custom_url).replace(/\/+$/, '') };
  const m = /^(?:(https?):)?(\d+)$/.exec(String(s.ui_location || ''));
  return m ? { scheme: m[1] || 'http', port: +m[2] } : null;
}

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

// NOMAD's AI answers from its knowledge base, not from tools, so it gets the guide as documents:
// one per collection, under a collection tag of their own. The guide's earlier documents are
// deleted first, so an update replaces them instead of piling up next to them.
async function syncKnowledge(nomadUrl, ctx, opts) {
  const o = opts || {};
  const docs = SDG.text.knowledgeDocs(ctx);
  const listed = JSON.parse(await fetchText(`${nomadUrl}/api/rag/files`, 60e3));
  const old = (listed.files || []).map(String).filter(s => /(^|\/)scrappers-guide-[a-z]+/.test(s));
  for (const source of old) {
    const r = await fetch(`${nomadUrl}/api/rag/files`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
    if (!r.ok) throw new Error(`removing ${source}: HTTP ${r.status}`);
  }
  for (const d of docs) {
    const form = new FormData();
    form.append('file', new Blob([d.text], { type: 'text/markdown' }), d.name);
    form.append('collection', o.collection || 'scrappers-guide');
    const r = await fetch(`${nomadUrl}/api/rag/upload`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`${d.name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    if (o.onUpload) o.onUpload(d);
  }
  return { removed: old.length, uploaded: docs.length };
}

function startNomad(hub) {
  const cfg = hub.cfg.nomad || {};
  const auto = cfg.url === 'auto';
  // Each `url` is where the hub reaches an app. A `port` means the app is on the hub's own machine,
  // so browsers get it on their own address for the hub instead (librariesFor in hub.js).
  const state = { auto, nomad: null, kiwix: null, markers: { pushed: 0, error: null } };
  const strip = u => String(u || '').replace(/\/+$/, '');
  const place = u => {
    const x = new URL(u);
    if (!auto && !LOCAL.includes(x.hostname)) return { url: u };
    return { url: u, port: +(x.port || (x.protocol === 'https:' ? 443 : 80)), scheme: x.protocol.slice(0, -1) };
  };

  async function locate() {
    if (!auto) return strip(cfg.url);
    for (const u of cfg.candidates || candidates()) { try { await nomadServices(u); return u; } catch (e) { /* try the next */ } }
    return '';
  }

  // Kiwix: as configured, else where NOMAD says its Information Library is, else NOMAD's default.
  async function findKiwix() {
    if (cfg.kiwix) return place(strip(cfg.kiwix));
    if (!state.nomad) return null;
    let k = null;
    try { k = (await nomadServices(state.nomad.url)).find(s => s.service_name === 'nomad_kiwix_server'); } catch (e) { /* an older NOMAD */ }
    if (k && !k.installed) return null;
    const link = (k && appLink(k)) || { scheme: 'http', port: 8090 };
    if (link.url) return { url: link.url };
    // Inside NOMAD's network the library answers by name on its container port; elsewhere, on the host's.
    const host = new URL(state.nomad.url).hostname;
    const url = host === 'nomad_admin' ? 'http://nomad_kiwix_server:8080' : `${link.scheme}://${host}:${link.port}`;
    return state.nomad.port ? { url, port: link.port, scheme: link.scheme } : { url };
  }

  async function discover() {
    try {
      if (!state.nomad && cfg.url) { const u = await locate(); if (u) state.nomad = place(u); }
      const k = await findKiwix();
      state.kiwix = k ? Object.assign({ books: state.kiwix && state.kiwix.books }, k) : null;
    } catch (e) { state.error = e.message; }
    if (!state.kiwix) return;
    try {
      const books = catalogBooks(await fetchText(`${state.kiwix.url}/catalog/v2/entries?count=-1`, 20e3));
      state.kiwix.books = SDG.text.matchBooks(hub.getCtx().ds.vocab.libraries, books);
      state.kiwix.installed = books.length;
      state.kiwix.error = null;
    } catch (e) { state.kiwix.error = e.message; }
    state.kiwix.checked = SDG.util.now();
  }

  // Field notes become pins; a note that changes status updates its pin.
  async function pushMarkers() {
    const nomadUrl = state.nomad && state.nomad.url;
    if (!nomadUrl || !cfg.markers) return;
    const map = hub.store.get('nomadMarkers') || {};
    const notes = hub.store.listObservations({ shares: ['public', 'peers'], limit: 5000, desc: true });
    for (const o of notes) {
      const b = o.building && hub.getCtx().get('buildings', o.building);
      const body = {
        name: String(o.label || (b && b.name) || 'Field note').slice(0, 255), latitude: o.lat, longitude: o.lon,
        color: PIN[o.status] || 'orange', icon: o.status === 'dangerous' ? 'star' : 'pin',
        notes: `${o.status}${o.notes ? ': ' + o.notes : ''} (Scrapper’s Guide, ${String(o.created).slice(0, 10)})`.slice(0, 500),
      };
      const known = map[o.id];
      if (known && known.status === o.status) continue;
      try {
        const url = known ? `${nomadUrl}/api/maps/markers/${known.id}` : `${nomadUrl}/api/maps/markers`;
        const res = await fetch(url, { method: known ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const out = await res.json().catch(() => ({}));
        const id = known ? known.id : (out.id || (out.marker && out.marker.id) || (out.data && out.data.id));
        if (id != null) map[o.id] = { id, status: o.status };
        state.markers.pushed++;
        state.markers.error = null;
      } catch (e) { state.markers.error = e.message; break; }
    }
    hub.store.set('nomadMarkers', map);
  }

  // With SDG_NOMAD_KB=1, keep the guide in NOMAD's knowledge base: once per version of the data.
  async function knowledge() {
    if (!cfg.kb || !state.nomad) return;
    const version = await hub.datasetHash();
    if (hub.store.get('nomadKb') === version) return;
    try {
      state.kb = Object.assign(await syncKnowledge(state.nomad.url, hub.getCtx()), { at: SDG.util.now(), error: null });
      hub.store.set('nomadKb', version);
    } catch (e) { state.kb = { error: e.message }; }
  }

  const tick = () => discover().then(pushMarkers).then(knowledge).catch(() => {});
  setTimeout(tick, 2000).unref();
  setInterval(tick, 15 * 60e3).unref();
  // NOMAD may still be starting: until it turns up, look for it every minute.
  if (auto) setInterval(() => { if (!state.nomad) tick(); }, 60e3).unref();
  hub.libraries = () => ({
    kiwix: state.kiwix ? { url: state.kiwix.url, port: state.kiwix.port, scheme: state.kiwix.scheme, books: state.kiwix.books || undefined } : undefined,
    nomad: state.nomad ? { url: state.nomad.url, port: state.nomad.port, scheme: state.nomad.scheme } : undefined,
  });
  hub.nomadState = state;
  hub.pushMarkers = pushMarkers;
  return state;
}

module.exports = { startNomad, catalogBooks, appLink, syncKnowledge, PIN };

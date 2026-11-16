// The map: where to look for what you need, near you. The hub reads the offline map (NOMAD's, or
// its own PMTiles) and ranks the places on it for a search; this draws a plain base map from its
// light tiles, the ranked places as numbered pins, your field notes, your own markers (home base,
// stash points...) and where you are. Your location and your markers stay on this device; the
// location goes only to your own hub, to look places up.
const MapView = (() => {
  const T = 256, MIN_Z = 3, MAX_Z = 18;
  const st = { info: null, z: 15, lat: null, lon: null, places: [], also: null, sel: -1, pick: false, busy: false, error: '', note: '', key: '', mark: false, stop: false, edit: null, detail: '', centre: null, panel: 'places' };
  // Under the map, one panel at a time.
  const PANELS = { places: 'Places', run: 'Run', list: 'List', pins: 'Pins' };
  // Your own markers: kept on this device only, never synced or shared.
  const MARKS = { home: ['Home base', 'H'], stash: ['Stash point', 'S'], rally: ['Rally point', 'R'], water: ['Water', 'W'], shelter: ['Shelter', 'T'], danger: ['Danger', '!'], other: ['Marker', '•'] };
  const tiles = new Map();
  let cv = null, frame = 0, drag = null;

  const lon2x = (lon, z) => ((lon + 180) / 360) * T * 2 ** z;
  const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * T * 2 ** z; };
  const x2lon = (x, z) => (x / (T * 2 ** z)) * 360 - 180;
  const y2lat = (y, z) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / (T * 2 ** z)));
  const here = () => S.settings.here || null;
  const maxZoom = () => Math.max(...(st.info ? st.info.sources.map(s => s.maxzoom) : [15]));
  const color = n => getComputedStyle(document.documentElement).getPropertyValue('--map-' + n).trim();
  const STATUS = { untouched: 'Untouched', partial: 'Partly looted', cleared: 'Cleared', dangerous: 'Dangerous', occupied: 'Occupied' };
  const distM = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r; return Math.sqrt(x * x + y * y) * 6371e3; };

  function tile(z, x, y) {
    const k = `${z}/${x}/${y}`;
    if (tiles.has(k)) return tiles.get(k);
    if (tiles.size > 300) tiles.delete(tiles.keys().next().value);
    tiles.set(k, null);
    // A tile that failed (the hub was restarting, say) is asked for again a little later.
    Sync.api(`/api/v1/map/tiles/${k}`, { timeout: 20e3 }).then(d => { tiles.set(k, d); draw(); }).catch(() => { tiles.set(k, { failed: true }); setTimeout(() => { if ((tiles.get(k) || {}).failed) { tiles.delete(k); draw(); } }, 15e3); });
    return null;
  }

  // Each tile is drawn once into a canvas of its own (with the nonzero rule, so shapes that
  // overlap at tile edges don't cancel out), and panning only copies those canvases.
  const bitmaps = new Map();
  function bitmap(key, d, size, z) {
    const dpr = window.devicePixelRatio || 1, k = `${key}@${size}@${dpr}@${color('bg')}${color('water')}`;
    if (bitmaps.has(k)) { const b = bitmaps.get(k); bitmaps.delete(k); bitmaps.set(k, b); return b; }
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(size * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = size / 512;
    const path = (pts, close) => { g.moveTo(pts[0] * s, pts[1] * s); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] * s, pts[i + 1] * s); if (close) g.closePath(); };
    const fill = (layer, col) => { g.fillStyle = col; g.beginPath(); (d[layer] || []).forEach(p => path(p, true)); g.fill(); };
    const stroke = (layer, col, lw) => { g.strokeStyle = col; g.lineWidth = lw; g.lineCap = g.lineJoin = 'round'; g.beginPath(); (d[layer] || []).forEach(p => path(p, false)); g.stroke(); };
    fill('green', color('green')); fill('urban', color('urban')); fill('water', color('water'));
    stroke('waterways', color('water'), 1.5);
    if (z >= 14) fill('buildings', color('building'));
    stroke('rail', color('rail'), 1);
    if (z >= 14) stroke('path', color('path'), 1);
    stroke('minor', color('road'), z >= 15 ? 3 : 1.5);
    stroke('major', color('major'), z >= 14 ? 5 : 2.5);
    bitmaps.set(k, c);
    if (bitmaps.size > 80) bitmaps.delete(bitmaps.keys().next().value);
    return c;
  }

  function draw() {
    if (frame || !cv) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = color('bg'); g.fillRect(0, 0, w, h);
      const z = st.z, dz = Math.min(z, maxZoom()), size = T * 2 ** (z - dz);
      const cx = lon2x(st.lon, z), cy = lat2y(st.lat, z), ox = cx - w / 2, oy = cy - h / 2;
      const list = [];
      for (let tx = Math.floor(ox / size); tx <= Math.floor((ox + w) / size); tx++) {
        for (let ty = Math.floor(oy / size); ty <= Math.floor((oy + h) / size); ty++) {
          if (ty < 0 || ty >= 2 ** dz) continue;
          const x = ((tx % 2 ** dz) + 2 ** dz) % 2 ** dz, d = tile(dz, x, ty);
          if (!d || d.failed) continue;
          const t = { d, x: Math.round(tx * size - ox), y: Math.round(ty * size - oy), k: size / 512 };
          g.drawImage(bitmap(`${dz}/${x}/${ty}`, d, size, z), t.x, t.y, size, size);
          list.push(t);
        }
      }
      // Place names, then field notes, then the ranked places, then you.
      g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'; g.fillStyle = color('label');
      list.forEach(t => (t.d.labels || []).forEach(([lx, ly, name]) => g.fillText(name, t.x + lx * t.k, t.y + ly * t.k)));
      const at = (lat, lon) => [lon2x(lon, z) - ox, lat2y(lat, z) - oy];
      // The search's reach, faintly.
      if (st.centre) {
        const [px, py] = at(st.centre.lat, st.centre.lon), mpp = (156543.03 * Math.cos((st.centre.lat * Math.PI) / 180)) / 2 ** z;
        g.strokeStyle = color('label'); g.globalAlpha = 0.35; g.lineWidth = 1.5; g.setLineDash([2, 5]);
        g.beginPath(); g.arc(px, py, (st.centre.km * 1000) / mpp, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      }
      const shown = new Set(st.places.map(p => p.note && p.note.id).filter(Boolean));
      (S.observations || []).forEach(o => {
        if (shown.has(o.id)) return;
        const [px, py] = at(o.lat, o.lon);
        if (px < -10 || py < -10 || px > w + 10 || py > h + 10) return;
        g.fillStyle = color(o.status === 'dangerous' || o.status === 'occupied' ? 'danger' : o.status === 'cleared' ? 'cleared' : 'note');
        g.beginPath(); g.rect(px - 5, py - 5, 10, 10); g.fill();
      });
      Runs.draw(g, at, color);
      // A place's field note shows on its pin: looted is grey with an X, dangerous or occupied
      // red, partly looted ringed amber, untouched ringed green.
      st.places.forEach((p, i) => {
        const [px, py] = at(p.lat, p.lon), on = i === st.sel, r = on ? 13 : 10, s = p.note && p.note.status;
        g.fillStyle = on ? color('pick') : s === 'cleared' ? color('cleared') : s === 'dangerous' || s === 'occupied' ? color('danger') : color('pin');
        g.strokeStyle = color('bg'); g.lineWidth = 2;
        g.beginPath(); g.arc(px, py, r, 0, 2 * Math.PI); g.fill(); g.stroke();
        if (s === 'partial' || s === 'untouched') { g.strokeStyle = color(s === 'partial' ? 'note' : 'fresh'); g.lineWidth = 3; g.beginPath(); g.arc(px, py, r + 3, 0, 2 * Math.PI); g.stroke(); }
        if (s === 'cleared') {
          g.strokeStyle = color('pinText'); g.lineWidth = 2.5; g.lineCap = 'round';
          g.beginPath(); g.moveTo(px - r * 0.55, py - r * 0.55); g.lineTo(px + r * 0.55, py + r * 0.55); g.moveTo(px + r * 0.55, py - r * 0.55); g.lineTo(px - r * 0.55, py + r * 0.55); g.stroke();
        } else {
          g.fillStyle = color('pinText'); g.font = '700 11px system-ui, sans-serif'; g.textBaseline = 'middle';
          g.fillText(s === 'dangerous' || s === 'occupied' ? '!' : String(i + 1), px, py + 0.5); g.textBaseline = 'alphabetic';
        }
      });
      (S.markers || []).forEach(m => {
        const [px, py] = at(m.lat, m.lon), on = st.edit && st.edit.id === m.id, r = on ? 12 : 10;
        g.fillStyle = color(m.kind === 'danger' ? 'danger' : 'mark'); g.strokeStyle = color('bg'); g.lineWidth = 2;
        g.beginPath(); g.moveTo(px, py - r); g.lineTo(px + r, py); g.lineTo(px, py + r); g.lineTo(px - r, py); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = '#fff'; g.font = '700 11px system-ui, sans-serif'; g.textBaseline = 'middle';
        g.fillText((MARKS[m.kind] || MARKS.other)[1], px, py + 0.5); g.textBaseline = 'alphabetic';
      });
      if (st.edit && !st.edit.id) { const [px, py] = at(st.edit.lat, st.edit.lon); g.strokeStyle = color('mark'); g.lineWidth = 2; g.setLineDash([4, 3]); g.beginPath(); g.arc(px, py, 12, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]); }
      const me = here();
      if (me) { const [px, py] = at(me.lat, me.lon); g.fillStyle = color('me'); g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(px, py, 7, 0, 2 * Math.PI); g.stroke(); g.fill(); }
    });
  }

  function listHTML() {
    if (st.error) return `<p class="err">${esc(st.error)}</p>`;
    if (st.busy && !st.places.length) return '<p class="hint">Looking…</p>';
    if (!st.places.length) return `<p class="hint">${esc(st.note || (st.key ? 'Nothing that fits within this distance. Try a wider one or a plainer word.' : ''))}</p>`;
    const also = st.also ? `<p class="hint">Also nearby: ${Object.entries(st.also).map(([k, n]) => `${esc(n)} ${esc(k.replace(/_/g, ' '))}${n > 1 ? 's' : ''}`).join(', ')}.</p>` : '';
    return `${st.note ? `<p class="hint">${esc(st.note)}</p>` : ''}${st.detail ? `<p class="hint">${esc(st.detail)}</p>` : ''}<ol class="places">${st.places.map((p, i) => `<li class="${i === st.sel ? 'on' : ''}" data-place="${i}"><b>${esc(p.name || (p.area ? p.type.name + ' (area)' : p.kind.replace(/_/g, ' ')))}</b> <span class="where">${esc(p.type.name)}</span>
      <br><span class="where">${esc(p.dist >= 1000 ? (p.dist / 1000).toFixed(1) + ' km' : p.dist + ' m')} ${esc(p.dir)}${p.likelyLeft ? ' · ' + esc(p.likelyLeft) : ''}${p.mostlyFrom ? ' · mostly from ' + esc(p.mostlyFrom.join(', ')) : ''}</span>
      ${p.note ? `<br><span class="badge ${p.note.status === 'cleared' ? 'absent' : p.note.status === 'untouched' ? 'accepted' : 'rejected'}">${esc(STATUS[p.note.status] || p.note.status)}</span> <span class="where">${p.note.mine ? 'your' : 'a'} field note${p.note.notes ? ': ' + esc(p.note.notes) : ''}</span>` : ''}</li>`).join('')}</ol>${also}`;
  }
  const refreshList = () => { const l = $('#maplist'); if (l) l.innerHTML = listHTML(); const pl = $('#mapplace'); if (pl) { pl.innerHTML = placeHTML(); wirePlace(); } refreshSeg(); draw(); };

  // The place picked on the map or in the list: what it is, and one tap to say how it stands.
  function placeHTML() {
    const p = st.places[st.sel];
    if (!p) return '';
    const share = S.settings.noteShare || 'private';
    return `<div class="form mapplace"><h3 style="margin-top:0">${st.sel + 1}. ${esc(p.name || (p.area ? p.type.name + ' (area)' : p.kind.replace(/_/g, ' ')))}</h3>
      <p class="where" style="margin-top:0">${esc(p.type.name)} · ${esc(p.dist >= 1000 ? (p.dist / 1000).toFixed(1) + ' km' : p.dist + ' m')} ${esc(p.dir)}${p.likelyLeft ? ' · ' + esc(p.likelyLeft) : ''}</p>
      ${p.note ? `<p>${p.note.mine ? 'You noted' : 'Someone noted'} it <span class="badge ${p.note.status === 'cleared' ? 'absent' : p.note.status === 'untouched' ? 'accepted' : 'rejected'}">${esc(STATUS[p.note.status] || p.note.status)}</span> on ${esc(String(p.note.created).slice(0, 10))}.</p>` : ''}
      <div class="actions marks">${Object.entries({ cleared: 'Looted', partial: 'Partly looted', untouched: 'Untouched', dangerous: 'Dangerous', occupied: 'Occupied' }).map(([k, l]) => `<button class="btn small${k === 'cleared' ? '' : ' ghost'}" data-note="${k}">${l}</button>`).join('')}</div>
      <div class="mapopts"><label>Who sees it <select id="noteshare"><option value="private"${share === 'private' ? ' selected' : ''}>Only me</option><option value="peers"${share === 'peers' ? ' selected' : ''}>Peers I sync with</option><option value="public"${share === 'public' ? ' selected' : ''}>Everyone on the hub</option></select></label><button class="btn small ghost" id="placerun">Add to run</button><button class="btn small ghost" id="placex">Close</button></div></div>`;
  }
  function wirePlace() {
    const p = st.places[st.sel];
    if (!p) return;
    $('#noteshare').addEventListener('change', async e => { S.settings.noteShare = e.target.value; await save('settings'); });
    document.querySelectorAll('[data-note]').forEach(b => b.addEventListener('click', async () => {
      try {
        const o = await SDG.changes.makeObservation({ lat: p.lat, lon: p.lon, status: b.dataset.note, building: p.type.id, share: S.settings.noteShare || 'private', label: p.name || p.type.name }, null, +S.settings.coordDecimals);
        o.mine = true;
        S.observations.push(o);
        await save('observations');
        if (o.share === 'public') Sync.schedule(2500);
        p.note = o;
        toast(`Noted: ${STATUS[o.status]}`);
        refreshList();
      } catch (x) { toast(x.message.replace('Observation: ', '')); }
    }));
    $('#placerun').addEventListener('click', async () => { await Runs.addStop({ lat: p.lat, lon: p.lon, name: p.name || p.type.name, kind: p.type.name, what: (p.mostlyFrom || []).slice(0, 2).join(', ') }); refreshRuns(); });
    $('#placex').addEventListener('click', () => { st.sel = -1; refreshList(); });
  }
  const refreshRuns = () => {
    const el = $('#maprun'), nd = $('#mapneed');
    if (nd) { nd.innerHTML = Runs.needHTML(); Runs.wireNeeds(nd, refreshRuns, name => { setQuery(name); $('#mapq').value = name; st.key = ''; showPanel('places'); findPlaces(); }, async () => { if (await planList()) showPanel('run'); }); }
    if (el) { el.innerHTML = Runs.panelHTML(); Runs.wire(el, refreshRuns, x => { center(x.lat, x.lon, Math.max(st.z, 15)); cv.scrollIntoView({ block: 'nearest' }); }, () => { st.stop = true; st.mark = st.pick = false; toast('Tap the map where the stop goes'); }); }
    refreshSeg();
    navCounts();
    draw();
  };
  const segHTML = () => {
    const r = Runs.active(), n = { places: st.places.length, run: r ? r.stops.length : 0, list: (S.need || []).filter(x => !x.got).length, pins: (S.markers || []).length };
    return Object.entries(PANELS).map(([k, l]) => `<button role="tab" data-panel="${k}" aria-selected="${k === st.panel}">${l}${n[k] ? `<span class="n">${esc(n[k])}</span>` : ''}</button>`).join('');
  };
  const refreshSeg = () => { const s = $('#mapseg'); if (s) s.innerHTML = segHTML(); };
  const panelHTML = () => (st.panel === 'run' ? `<div id="maprun">${Runs.panelHTML()}</div>` : st.panel === 'list' ? `<div id="mapneed">${Runs.needHTML()}</div>` : st.panel === 'pins' ? `<div id="mapmarks">${marksHTML()}</div>` : `<div id="maplist">${listHTML()}</div>`);
  function showPanel(k) {
    st.panel = PANELS[k] ? k : 'places';
    const el = $('#mappanel');
    if (!el) return;
    el.innerHTML = panelHTML();
    refreshRuns();
  }
  // The shopping list's run: the hub ranks places for every part on it at once. True when planned.
  async function planList() {
    if (!S.settings.hubUrl) { toast('Planning a run needs a hub with a map: connect one in Sync'); return false; }
    const c = here() || (st.lat != null && st.z >= 12 ? { lat: st.lat, lon: st.lon } : null);
    if (!c) { toast('Set your location on the Map first'); return false; }
    const km = S.settings.mapKm || 2, o = opts();
    const fetchParts = async fns => {
      const params = new URLSearchParams({ lat: c.lat.toFixed(5), lon: c.lon.toFixed(5), km, parts: fns.join(','), per: 5 });
      if (o.months != null) params.set('months', o.months);
      return (await Sync.api('/api/v1/places?' + params, { timeout: 60e3 })).parts;
    };
    const before = (S.runs || []).length;
    try { await Runs.planForList(fetchParts); } catch (e) { toast('Couldn’t plan it: ' + e.message); }
    return (S.runs || []).length > before;
  }

  // Places for the search, around you (or the middle of the map). Field notes within 60 m are
  // shown with a place, and places someone has noted as cleared drop down the list.
  async function findPlaces() {
    const c = here() || (st.z >= 12 ? { lat: st.lat, lon: st.lon } : null);
    if (!c) { st.places = []; st.key = ''; st.note = 'Set your location, or zoom in on where you are, to see places near it.'; refreshList(); return; }
    const q = scrap.q.trim(), km = S.settings.mapKm || 2, o = opts();
    const key = [c.lat, c.lon, q, km, o.months, (o.tools || []).join(), o.maxKg].join('|');
    if (key === st.key && st.places.length) return;
    st.key = key; st.busy = true; st.error = ''; st.note = ''; refreshList();
    st.centre = { lat: c.lat, lon: c.lon, km };
    const params = new URLSearchParams({ lat: c.lat.toFixed(5), lon: c.lon.toFixed(5), km, q, limit: km > 5 ? 50 : 30 });
    if (o.months != null) params.set('months', o.months);
    if (o.tools) params.set('tools', o.tools.join(','));
    if (o.maxKg != null) params.set('kg', o.maxKg);
    try {
      const r = await Sync.api('/api/v1/places?' + params, { timeout: 30e3 });
      if (st.key !== key) return;
      const notes = S.observations || [];
      st.places = (r.places || []).map(p => Object.assign(p, { note: notes.filter(n => distM(n, p) < 60).sort((a, b) => distM(a, p) - distM(b, p))[0] }));
      st.places.sort((a, b) => (a.note && a.note.status === 'cleared') - (b.note && b.note.status === 'cleared'));
      st.also = r.alsoNearby || null; st.sel = -1;
      st.note = r.note || '';
      st.detail = r.detail || '';
    } catch (e) { st.error = 'Couldn’t look up places: ' + e.message; st.places = []; }
    st.busy = false; refreshList();
  }

  // Without a location set, places follow the middle of the map once it settles.
  function center(lat, lon, z) {
    st.lat = lat; st.lon = lon;
    if (z) st.z = Math.max(MIN_Z, Math.min(MAX_Z, z));
    draw();
    if (!here() && cv) { clearTimeout(st.follow); st.follow = setTimeout(findPlaces, 700); }
  }
  async function setHere(lat, lon) {
    S.settings.here = { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
    await save('settings');
    st.pick = false;
    render($('#v-map'));
  }

  async function render(v) {
    if (!S.settings.hubUrl) { v.innerHTML = '<div class="form"><h2>Map</h2><p class="hint">The map comes from a hub with an offline map: on a Project NOMAD box the guide uses NOMAD’s maps by itself. Connect to a hub in Sync.</p></div>'; return; }
    if (!st.info) { try { st.info = await Sync.api('/api/v1/map', { timeout: 15e3 }); } catch (e) { st.info = { available: false, error: e.message }; } }
    if (!st.info.available) { v.innerHTML = `<div class="form"><h2>Map</h2><p class="hint">This hub has no offline map yet. On Project NOMAD, download a region in Maps (zoom 15 shows shops and buildings); elsewhere, name a PMTiles file in the hub config (map.pmtiles).${st.info.error ? ' ' + esc(st.info.error) : ''}</p></div>`; st.info = null; return; }
    if (st.lat == null) {
      const me = here(), s = st.info.sources[0];
      if (me) center(me.lat, me.lon, 15);
      else center((s.bounds[1] + s.bounds[3]) / 2, (s.bounds[0] + s.bounds[2]) / 2, 5);
    }
    const km = S.settings.mapKm || 2;
    const tapping = st.pick ? 'Tap the map where you are' : st.mark ? 'Tap the map where the marker goes' : st.stop ? 'Tap the map where the stop goes' : '';
    v.innerHTML = `<div class="mapgrid"><div class="mapmain"><div class="mapbar"><form class="searchrow" id="mapform"><label class="sr" for="mapq">What do you need?</label><input id="mapq" type="search" autocomplete="off" placeholder="What do you need? Empty shows all" value="${esc(scrap.q)}"><button class="btn">Find</button></form>
      <div class="mapopts"><label>Within <select id="mapkm">${[0.5, 1, 2, 3, 5, 10, 25, 50].map(k => `<option value="${k}"${k === km ? ' selected' : ''}>${k} km</option>`).join('')}</select></label>
      <button class="btn small ghost" id="mapgeo">Use my location</button><button class="btn small ghost" id="mappick" aria-pressed="${st.pick}">${here() ? 'Move my location' : 'Set my location'}</button></div>
      ${tapping ? `<p class="hint"><b>${esc(tapping)}.</b></p>` : here() ? '' : '<p class="hint">Set your location for places near you: “Set my location”, then tap where you are. Until then, places are found around the middle of the map once you zoom in.</p>'}</div>
      <div class="mapwrap${tapping ? ' picking' : ''}"><canvas id="mapcv" role="img" aria-label="Map of the places in the list"></canvas>
      <div class="mapzoom"><button class="btn small" data-mz="1" aria-label="Zoom in">+</button><button class="btn small" data-mz="-1" aria-label="Zoom out">−</button></div>
      <div class="mapattr">© OpenStreetMap contributors · Protomaps</div></div></div>
      <div class="mapside"><div id="mapmark">${markHTML()}</div>
      <div id="mapplace">${placeHTML()}</div>
      <div class="seg" id="mapseg" role="tablist" aria-label="Under the map">${segHTML()}</div>
      <div class="panel" id="mappanel">${panelHTML()}</div></div></div>`;
    cv = $('#mapcv');
    wire();
    draw();
    findPlaces();
  }

  function wire() {
    $('#mapform').addEventListener('submit', e => { e.preventDefault(); setQuery($('#mapq').value); st.key = ''; findPlaces(); });
    $('#mapkm').addEventListener('change', async e => { S.settings.mapKm = +e.target.value; await save('settings'); st.key = ''; findPlaces(); });
    $('#mapgeo').addEventListener('click', () => {
      if (!navigator.geolocation || !window.isSecureContext) return toast('This browser only shares your location over https or on the device itself. Set it on the map instead.');
      navigator.geolocation.getCurrentPosition(p => setHere(p.coords.latitude, p.coords.longitude).then(() => center(p.coords.latitude, p.coords.longitude, 15)), e => toast('Couldn’t get your location: ' + e.message), { timeout: 15e3 });
    });
    $('#mappick').addEventListener('click', () => { st.pick = !st.pick; st.mark = false; render($('#v-map')); });
    document.querySelectorAll('[data-mz]').forEach(b => b.addEventListener('click', () => center(st.lat, st.lon, st.z + +b.dataset.mz)));
    // One zoom step per scroll, however many wheel events a touchpad sends.
    let wheelAt = 0;
    cv.addEventListener('wheel', e => { e.preventDefault(); if (Date.now() - wheelAt < 200) return; wheelAt = Date.now(); center(st.lat, st.lon, st.z + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, cx: lon2x(st.lon, st.z), cy: lat2y(st.lat, st.z), moved: false }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) center(y2lat(drag.cy - dy, st.z), x2lon(drag.cx - dx, st.z));
    });
    cv.addEventListener('pointerup', e => {
      const d = drag; drag = null;
      if (!d || d.moved) return;
      const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const ox = lon2x(st.lon, st.z) - cv.clientWidth / 2, oy = lat2y(st.lat, st.z) - cv.clientHeight / 2;
      const tap = { lat: y2lat(oy + py, st.z), lon: x2lon(ox + px, st.z) };
      const near = p => Math.hypot(lon2x(p.lon, st.z) - ox - px, lat2y(p.lat, st.z) - oy - py) < 14;
      if (st.pick) { setHere(tap.lat, tap.lon); return; }
      if (st.stop) { st.stop = false; Runs.addStop({ lat: tap.lat, lon: tap.lon, name: 'Stop' }).then(() => render($('#v-map'))); return; }
      if (st.mark) { st.mark = false; st.edit = { lat: tap.lat, lon: tap.lon, kind: (S.markers || []).some(m => m.kind === 'home') ? 'stash' : 'home' }; render($('#v-map')); return; }
      const m = (S.markers || []).find(near);
      if (m) { st.edit = Object.assign({}, m); showMark(); draw(); return; }
      const hit = st.places.findIndex(near);
      if (hit >= 0) select(hit, false);
    });
    cv.addEventListener('dblclick', () => center(st.lat, st.lon, st.z + 1));
    $('#mapseg').addEventListener('click', e => { const b = e.target.closest('[data-panel]'); if (b) showPanel(b.dataset.panel); });
    $('#mappanel').addEventListener('click', e => {
      const li = e.target.closest('[data-place]');
      if (li) { select(+li.dataset.place, true); return; }
      if (e.target.closest('#mapmarkbtn')) { st.mark = !st.mark; st.pick = st.stop = false; render($('#v-map')); return; }
      const mk = e.target.closest('[data-mark]'), m = mk && (S.markers || []).find(x => x.id === mk.dataset.mark);
      if (m) { st.edit = Object.assign({}, m); center(m.lat, m.lon, Math.max(st.z, 15)); showMark(); }
    });
    wireMark();
    wirePlace();
    refreshRuns();
  }

  // The marker being added or edited, under the map.
  function markHTML() {
    const m = st.edit;
    if (!m) return '';
    const [label] = MARKS[m.kind] || MARKS.other;
    return `<div class="form mapmark"><h3 style="margin-top:0">${m.id ? esc(m.name || label) : 'New marker'}</h3>
      <div class="grid2"><div class="field"><label for="mkkind">Kind</label><select id="mkkind">${Object.entries(MARKS).map(([k, [l]]) => `<option value="${k}"${k === m.kind ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="field"><label for="mkname">Name</label><input id="mkname" maxlength="60" value="${esc(m.name || '')}" placeholder="${esc(label)}"></div></div>
      <div class="field"><label for="mknotes">Notes</label><textarea id="mknotes" maxlength="1000" placeholder="What’s here, how to get in, what you left">${esc(m.notes || '')}</textarea></div>
      <p class="hint">${esc(m.lat.toFixed(5))}, ${esc(m.lon.toFixed(5))}. Markers stay on this device: they are never synced or shared. To tell others how a place stands, tap it on the map and mark it.</p>
      <div class="actions"><button class="btn" id="mksave">Save</button><button class="btn ghost" id="mkcancel">Cancel</button>${m.id ? '<button class="btn ghost" id="mkhere">Make this my location</button><button class="btn ghost" id="mkrun">Add to run</button><button class="btn danger" id="mkdel">Delete</button>' : ''}</div></div>`;
  }
  function marksHTML() {
    const list = S.markers || [];
    const me = here();
    return `${list.length ? `<ul class="places">${list.map(m => `<li data-mark="${esc(m.id)}"><b>${esc(m.name || (MARKS[m.kind] || MARKS.other)[0])}</b> <span class="where">${esc((MARKS[m.kind] || MARKS.other)[0])}${me ? ' · ' + esc(Math.round(distM(me, m)) >= 1000 ? (distM(me, m) / 1000).toFixed(1) + ' km' : Math.round(distM(me, m)) + ' m') : ''}</span>${m.notes ? `<br><span class="where">${esc(m.notes)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="hint">Your own markers: home base, stash points, rally points, water, shelter, danger. They stay on this device and are never shared.</p>'}
      <div class="actions"><button class="btn small" id="mapmarkbtn" aria-pressed="${st.mark}">${st.mark ? 'Tap the map where it goes' : 'Add a marker'}</button></div>`;
  }
  function showMark() { const el = $('#mapmark'); if (el) { el.innerHTML = markHTML(); wireMark(); el.scrollIntoView({ block: 'nearest' }); } }
  function wireMark() {
    if (!st.edit) return;
    $('#mkkind').addEventListener('change', e => { st.edit.kind = e.target.value; $('#mkname').placeholder = (MARKS[st.edit.kind] || MARKS.other)[0]; draw(); });
    $('#mksave').addEventListener('click', async () => {
      const m = Object.assign(st.edit, { name: $('#mkname').value.trim(), notes: $('#mknotes').value.trim() });
      m.lat = Math.round(m.lat * 1e5) / 1e5; m.lon = Math.round(m.lon * 1e5) / 1e5;
      if (!m.id) { m.id = SDG.util.newId(); m.created = SDG.util.now(); }
      S.markers = [...(S.markers || []).filter(x => x.id !== m.id), m];
      await save('markers');
      st.edit = null;
      toast('Marker saved on this device');
      render($('#v-map'));
    });
    $('#mkcancel').addEventListener('click', () => { st.edit = null; render($('#v-map')); });
    const del = $('#mkdel');
    if (del) del.addEventListener('click', async () => { if (!confirm('Delete this marker?')) return; S.markers = (S.markers || []).filter(x => x.id !== st.edit.id); await save('markers'); st.edit = null; render($('#v-map')); });
    const hb = $('#mkhere');
    if (hb) hb.addEventListener('click', () => setHere(st.edit.lat, st.edit.lon));
    const rb = $('#mkrun');
    if (rb) rb.addEventListener('click', async () => { const m = st.edit; await Runs.addStop({ lat: m.lat, lon: m.lon, name: m.name || (MARKS[m.kind] || MARKS.other)[0], kind: (MARKS[m.kind] || MARKS.other)[0] }); refreshRuns(); });
  }
  // A place picked in the list moves the map to it and brings the map into view; one tapped on
  // the map brings its panel into view.
  function select(i, move) {
    st.sel = i;
    const p = st.places[i];
    if (move && p) center(p.lat, p.lon, Math.max(st.z, 16));
    refreshList();
    const panel = $('#mapplace');
    if (move && cv) cv.scrollIntoView({ block: 'nearest' });
    else if (panel) panel.scrollIntoView({ block: 'nearest' });
  }
  window.addEventListener('resize', () => draw());

  // From elsewhere in the app (Plan, search results): open the map on something.
  const open = () => { if (location.hash.slice(1).split('/')[0] === 'map') render($('#v-map')); else location.hash = 'map'; };
  const show = (lat, lon, panel) => { st.lat = lat; st.lon = lon; st.z = Math.max(st.z, 16); if (panel) st.panel = panel; open(); };
  const start = mode => { st.pick = false; st.mark = mode === 'mark'; st.stop = mode === 'stop'; st.panel = mode === 'stop' ? 'run' : 'pins'; open(); toast(mode === 'stop' ? 'Tap the map where the stop goes' : 'Tap the map where the marker goes'); };
  const editMark = id => { const m = (S.markers || []).find(x => x.id === id); if (!m) return; st.edit = Object.assign({}, m); show(m.lat, m.lon, 'pins'); };
  const search = q => { setQuery(q); st.key = ''; st.panel = 'places'; open(); };
  const markLabel = k => (MARKS[k] || MARKS.other)[0];

  return { render, redraw: draw, planList, show, start, editMark, search, markLabel };
})();

// Runs: a plan for a trip to several places. Each stop says when, how (the way in, tools, who
// goes) and what you're after; the map draws the route with its distance and time and can put
// the stops in a sensible order, and stops get ticked off as you go. The shopping list says
// which parts you need, and a run can be planned to get them. Both stay on this device.
const Runs = (() => {
  // Speeds in km/h, and how much longer streets are than straight lines (no road routing yet).
  const MODES = { foot: ['On foot', 4], cart: ['On foot with a cart', 3], bike: ['Bicycle', 12], vehicle: ['Vehicle', 30] };
  const DETOUR = 1.3;
  const STATUS = { planned: 'To do', done: 'Done', skipped: 'Skipped' };
  const distKm = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r; return Math.sqrt(x * x + y * y) * 6371; };
  const active = () => (S.runs || []).find(r => r.id === S.settings.run) || null;
  // Runs start from your location, or else your home base.
  const start = () => { const h = (S.markers || []).find(m => m.kind === 'home'); return S.settings.here || (h ? { lat: h.lat, lon: h.lon } : null); };
  const fmtKm = km => (km >= 1 ? km.toFixed(1) + ' km' : Math.round(km * 1000) + ' m');
  const partName = fn => nameOf(S.ctx.get('parts', fn)) || fn;
  // The same panel can be drawn on the map and on the Plan page at once, so look up its parts only
  // inside the copy being wired.
  const onIn = root => (id, ev, fn) => { const el = root.querySelector('#' + id); if (el) el.addEventListener(ev, fn); };
  // The copy in the view that isn't showing is dropped, so each id is on the page once (it is drawn
  // again when that view opens).
  const only = (root, sel) => document.querySelectorAll(sel).forEach(x => { if (!root.contains(x)) x.remove(); });
  const fmtH = h => (h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, '0')} min`);

  async function create() {
    const r = { id: SDG.util.newId(), name: 'Run ' + ((S.runs || []).length + 1), mode: 'foot', when: '', notes: '', back: true, stops: [], created: SDG.util.now() };
    S.runs = [...(S.runs || []), r];
    S.settings.run = r.id;
    await save('runs'); await save('settings');
    return r;
  }
  async function addStop(p) {
    const r = active() || await create();
    if (r.stops.some(s => distKm(s, p) < 0.01)) return toast('Already in this run');
    r.stops.push({ id: SDG.util.newId(), lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), name: p.name || 'Stop', kind: p.kind || '', when: '', how: '', what: p.what || '', status: 'planned' });
    await save('runs');
    toast(`Added to ${r.name}`);
  }

  // The points the route passes through: start, the stops not skipped, and back if wanted.
  function route(r) {
    const s = start(), stops = r.stops.filter(x => x.status !== 'skipped');
    return [...(s ? [s] : []), ...stops, ...(r.back && s && stops.length ? [s] : [])];
  }
  function totals(r) {
    const pts = route(r);
    let km = 0;
    for (let i = 1; i < pts.length; i++) km += distKm(pts[i - 1], pts[i]);
    km *= DETOUR;
    return { km, hours: km / (MODES[r.mode] || MODES.foot)[1] };
  }
  // Nearest stop next, from where you start: quick and usually close to the shortest.
  function bestOrder(r) {
    let cur = start() || r.stops[0];
    const left = r.stops.filter(s => s.status === 'planned'), out = [];
    while (left.length) { left.sort((a, b) => distKm(cur, a) - distKm(cur, b)); cur = left.shift(); out.push(cur); }
    r.stops = [...r.stops.filter(s => s.status !== 'planned'), ...out];
  }

  function panelHTML() {
    const runs = S.runs || [], r = active();
    const pick = `<select id="runsel" aria-label="Run">${runs.map(x => `<option value="${esc(x.id)}"${r && x.id === r.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}${r ? '' : '<option value="" selected>No run chosen</option>'}</select>`;
    if (!r) return `<div class="runs"><p class="hint">A run is a trip to several places: when you'll hit each one, how (the way in, the tools, who goes) and what you're after. Add places from the map, or plan one for your shopping list; the route, its length and time show on the map. Runs stay on this device.</p>
      <div class="mapopts">${runs.length ? pick : ''}<button class="btn small" id="runnew">New run</button></div></div>`;
    const t = totals(r), [label] = MODES[r.mode] || MODES.foot, s = start();
    let prev = s;
    const stops = r.stops.map((x, i) => {
      const leg = prev && x.status !== 'skipped' ? distKm(prev, x) * DETOUR : null;
      if (x.status !== 'skipped') prev = x;
      // What the stop is for, in a line; the fields to change it fold away.
      const line = [x.when, x.what && 'Get: ' + x.what, x.how].filter(Boolean).join(' · ');
      return `<li data-stop="${esc(x.id)}" class="${esc(x.status)}"><div><b>${esc(x.name)}</b> <span class="where">${leg != null ? esc(fmtKm(leg)) + ' from the last' : ''}</span></div><div class="where">${esc(line)}</div>
        <details class="stopedit"${line ? '' : ' open'}><summary>When, how, what to get</summary><div class="grid3"><input data-f="when" value="${esc(x.when)}" placeholder="When (day 1, 06:00)" aria-label="When"><input data-f="how" value="${esc(x.how)}" placeholder="How (way in, tools, who)" aria-label="How"><input data-f="what" value="${esc(x.what)}" placeholder="What to get" aria-label="What to get"></div></details>
        <div class="stopbar"><select data-f="status" aria-label="Status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}"${k === x.status ? ' selected' : ''}>${l}</option>`).join('')}</select><button class="btn small ghost" data-mv="-1" aria-label="Earlier"${i ? '' : ' disabled'}>↑</button><button class="btn small ghost" data-mv="1" aria-label="Later"${i < r.stops.length - 1 ? '' : ' disabled'}>↓</button><button class="btn small ghost" data-go>Show</button><button class="btn small danger" data-rm aria-label="Remove this stop">✕</button></div></li>`;
    }).join('');
    // The stops first; the run's name, travel and plan fold away until wanted.
    return `<div class="runs"><div class="mapopts">${pick}<button class="btn small ghost" id="runnew">New run</button></div>
      <p class="hint">${r.stops.length ? `<b>${esc(r.stops.length)} stop${r.stops.length > 1 ? 's' : ''} · about ${esc(fmtKm(t.km))} · about ${esc(fmtH(t.hours))}</b> ${esc(label.toLowerCase())}${r.when ? ` · ${esc(r.when)}` : ''}.` : 'No stops yet: tap a place on the map and “Add to run”, or add a stop anywhere on the map.'}${s ? '' : ' Set your location or a home base marker to start the route from.'}</p>
      <ol class="stops">${stops}</ol>
      <div class="actions"><button class="btn small" id="runorder"${r.stops.length > 1 ? '' : ' disabled'}>Best order</button><button class="btn small ghost" id="runstop">Add a stop on the map</button></div>
      <details class="runset"><summary>Name, travel and plan</summary>
      <div class="grid2"><div class="field"><label for="runname">Name</label><input id="runname" maxlength="60" value="${esc(r.name)}"></div>
      <div class="field"><label for="runmode">Going</label><select id="runmode">${Object.entries(MODES).map(([k, [l]]) => `<option value="${k}"${k === r.mode ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="grid2"><div class="field"><label for="runwhen">When</label><input id="runwhen" maxlength="80" value="${esc(r.when)}" placeholder="Saturday, leave at first light"></div>
      <div class="field"><label><input type="checkbox" id="runback"${r.back ? ' checked' : ''}> Back to the start at the end</label></div></div>
      <div class="field"><label for="runnotes">Plan</label><textarea id="runnotes" maxlength="2000" placeholder="Who goes, what to carry, where to meet, what to do if it goes wrong">${esc(r.notes)}</textarea></div>
      <p class="hint">Times are for moving only. Distances are straight lines plus a third for streets; there is no road routing yet.</p>
      <div class="actions"><button class="btn small danger" id="rundel">Delete this run</button></div></details></div>`;
  }

  // `refresh` redraws the map panel; `goTo` centres the map on a stop; `tapStop` starts tap-to-add.
  function wire(root, refresh, goTo, tapStop) {
    const r = active(), on = onIn(root);
    only(root, '.runs');
    on('runsel', 'change', async e => { S.settings.run = e.target.value; await save('settings'); refresh(); });
    on('runnew', 'click', async () => { await create(); refresh(); });
    if (!r) return;
    on('rundel', 'click', async () => { if (!confirm(`Delete ${r.name}?`)) return; S.runs = S.runs.filter(x => x.id !== r.id); S.settings.run = ''; await save('runs'); await save('settings'); refresh(); });
    const field = (id, k, ev, val) => on(id, ev || 'change', async e => { r[k] = val ? val(e.target) : e.target.value; await save('runs'); if (k === 'mode' || k === 'back') refresh(); });
    field('runname', 'name'); field('runmode', 'mode'); field('runwhen', 'when'); field('runnotes', 'notes'); field('runback', 'back', 'change', el => el.checked);
    on('runorder', 'click', async () => { bestOrder(r); await save('runs'); refresh(); });
    on('runstop', 'click', () => tapStop());
    root.querySelectorAll('[data-stop]').forEach(li => {
      const x = r.stops.find(s => s.id === li.dataset.stop);
      if (!x) return;
      li.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', async () => {
        x[inp.dataset.f] = inp.value.trim();
        await save('runs');
        if (inp.dataset.f === 'status') refresh();
        else { const l = [x.when, x.what && 'Get: ' + x.what, x.how].filter(Boolean).join(' · '), el = li.querySelector(':scope > div.where'); if (el) el.textContent = l; }
      }));
      li.querySelectorAll('[data-mv]').forEach(b => b.addEventListener('click', async () => {
        const i = r.stops.indexOf(x), j = i + +b.dataset.mv;
        if (j < 0 || j >= r.stops.length) return;
        [r.stops[i], r.stops[j]] = [r.stops[j], r.stops[i]];
        await save('runs'); refresh();
      }));
      li.querySelector('[data-go]').addEventListener('click', () => goTo(x));
      li.querySelector('[data-rm]').addEventListener('click', async () => { r.stops = r.stops.filter(s => s !== x); await save('runs'); refresh(); });
    });
  }

  // The route on the map: a dashed line through the stops, and each stop's number on a square.
  function draw(g, at, color) {
    const r = active();
    if (!r || !r.stops.length) return;
    const pts = route(r).map(p => at(p.lat, p.lon));
    g.strokeStyle = color('route'); g.lineWidth = 3; g.setLineDash([8, 6]); g.lineCap = 'round';
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); g.setLineDash([]);
    g.font = '700 10px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    r.stops.forEach((x, i) => {
      const [px, py] = at(x.lat, x.lon);
      g.fillStyle = x.status === 'done' ? color('cleared') : x.status === 'skipped' ? color('path') : color('route');
      g.fillRect(px - 8, py - 22, 16, 14);
      g.fillStyle = '#fff'; g.fillText(String(i + 1), px, py - 15);
    });
    g.textBaseline = 'alphabetic';
  }

  // ---- The shopping list: part types you need, how many, and whether you've got them. ----
  async function need(fn, qty) {
    if (!S.ctx.get('parts', fn)) return false;
    const n = (S.need || []).find(x => x.fn === fn);
    if (n) { n.qty += qty || 1; n.got = false; } else S.need = [...(S.need || []), { fn, qty: qty || 1, got: false }];
    await save('need');
    return true;
  }
  function needHTML() {
    const list = S.need || [], left = list.filter(n => !n.got);
    const add = S.ctx.ds.parts.filter(f => !f.deprecated && !list.some(n => n.fn === f.id)).sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="needs">
      ${list.length ? `<ul class="needlist">${list.map(n => `<li class="${n.got ? 'got' : ''}" data-need="${esc(n.fn)}"><label><input type="checkbox" data-got${n.got ? ' checked' : ''}> <b>${esc(partName(n.fn))}</b></label>
        <label class="where">× <input type="number" data-qty min="1" max="999" value="${esc(n.qty)}" aria-label="How many"></label><button class="btn small ghost" data-where>Where?</button><button class="btn small danger" data-needrm aria-label="Remove ${esc(partName(n.fn))}">✕</button></li>`).join('')}</ul>`
        : '<p class="hint">The parts you need. Add them here, from a part type’s page, from search results, or what a guide needs that you don’t have; then plan a run to get them. Ticking one off puts it in your stash.</p>'}
      <div class="mapopts"><select id="needadd" aria-label="Add a part type"><option value="">Add a part type…</option>${add.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select>
      ${left.length ? '<button class="btn small" id="needrun">Plan a run for my list</button>' : ''}${list.some(n => n.got) ? '<button class="btn small ghost" id="needclear">Clear what I’ve got</button>' : ''}</div></div>`;
  }
  // `where` searches the map for one part; `plan` plans a run for the list.
  function wireNeeds(root, refresh, where, plan) {
    const on = onIn(root);
    only(root, '.needs');
    on('needadd', 'change', async e => { if (e.target.value && await need(e.target.value, 1)) refresh(); });
    on('needrun', 'click', plan);
    on('needclear', 'click', async () => { S.need = S.need.filter(n => !n.got); await save('need'); refresh(); });
    root.querySelectorAll('[data-need]').forEach(li => {
      const n = (S.need || []).find(x => x.fn === li.dataset.need);
      if (!n) return;
      li.querySelector('[data-got]').addEventListener('change', async e => {
        n.got = e.target.checked;
        S.inventory[n.fn] = Math.max(0, (S.inventory[n.fn] || 0) + (n.got ? n.qty : -n.qty));
        if (!S.inventory[n.fn]) delete S.inventory[n.fn];
        await save('need'); await save('inventory');
        refresh();
      });
      li.querySelector('[data-qty]').addEventListener('change', async e => { n.qty = Math.max(1, Math.min(999, Math.round(+e.target.value) || 1)); await save('need'); });
      li.querySelector('[data-where]').addEventListener('click', () => where(partName(n.fn)));
      li.querySelector('[data-needrm]').addEventListener('click', async () => { S.need = S.need.filter(x => x !== n); await save('need'); refresh(); });
    });
  }
  // A run for the list: the best few places for each part still needed, then the fewest stops
  // that cover them, each next stop the one covering the most parts left.
  async function planForList(fetchParts) {
    const left = (S.need || []).filter(n => !n.got).map(n => n.fn);
    if (!left.length) return;
    const byPart = await fetchParts(left);
    const key = p => p.lat.toFixed(5) + ',' + p.lon.toFixed(5), cand = new Map();
    // A place covers a part only if it is nearly as good a source as the best one for it, so a
    // place with a bit of everything doesn't stand in for the places that have it properly.
    Object.entries(byPart || {}).forEach(([fn, list]) => {
      const top = Math.max(0, ...list.map(p => p.score));
      list.filter(p => p.score >= top * 0.8).forEach(p => {
        const c = cand.get(key(p)) || cand.set(key(p), { p, fns: new Set(), score: 0 }).get(key(p));
        c.fns.add(fn); c.score += p.score;
      });
    });
    const todo = new Set(left), picked = [];
    while (todo.size) {
      let best = null, most = 0;
      cand.forEach(c => { const n = [...c.fns].filter(f => todo.has(f)).length; if (n > most || (n && n === most && c.score > best.score)) { best = c; most = n; } });
      if (!best) break;
      const fns = [...best.fns].filter(f => todo.has(f));
      fns.forEach(f => todo.delete(f));
      picked.push({ p: best.p, fns });
      cand.delete(key(best.p));
    }
    if (!picked.length) return toast('Nothing on the map within reach has those parts. Try a wider distance.');
    const r = await create();
    r.name = 'For my shopping list';
    r.stops = picked.map(({ p, fns }) => ({ id: SDG.util.newId(), lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), name: p.name || p.type.name, kind: p.type.name, when: '', how: '', what: fns.map(partName).join(', '), status: 'planned' }));
    bestOrder(r);
    await save('runs');
    toast(todo.size ? `Planned ${picked.length} stops; nothing within reach for ${[...todo].map(partName).join(', ')}` : `Planned ${picked.length} stop${picked.length > 1 ? 's' : ''} for your list`);
  }

  return { panelHTML, wire, draw, addStop, active, need, needHTML, wireNeeds, planForList };
})();

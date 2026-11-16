// Simple mode: the whole app reduced to the bare minimum. Ask for a part or a need, see what to
// strip, where to look and what can hurt you, and read guides as plain steps. It reads the same
// data through the same core as the full app, so data updates reach it automatically and new
// features in the full app never need porting here.
const Simple = (() => {
  let q = '', timer;
  const ctx = () => S.ctx;
  const hz = ids => (ids && ids.length ? `<span class="s-haz">⚠ ${ids.map(h => esc(ctx().hazard(h).label)).join(', ')}</span>` : '');
  const back = () => `<p><a href="#simple">← Find something else</a></p>`;

  function results() {
    const box = $('#sres');
    if (!box) return;
    if (!q.trim()) { box.innerHTML = '<p class="s-hint">Type a part, a part number or what you need to do.</p>'; return; }
    const out = SDG.search.search(ctx(), q, { months: S.settings.months });
    const s = SDG.search.summarize(ctx(), out, 8);
    const job = s.jobs[0] && s.partTypes.some(p => p.via === 'job' && p.on) ? s.jobs[0] : null;
    const named = s.devicesNamed[0];
    const models = s.models.length ? `<h2>In real models</h2><ul class="s-list">${s.models.map(m => `<li>${esc(m.name)}${m.parts.length ? `: ${esc(m.parts[0].spec)}` : ''}</li>`).join('')}</ul>` : '';
    const brands = s.brands.length && !named ? s.brands.map(b => `<h2>${esc(b.name)} makes</h2><p>${b.devices.map(d => `<a href="#simple/d/${u(d.id)}">${esc(d.name)}</a>`).join(', ')}</p>`).join('') : '';
    if (!s.bestDevices.length && !named && (models || brands)) { box.innerHTML = brands + models; return; }
    if (!s.bestDevices.length && !named) { box.innerHTML = '<p class="s-hint">Nothing found. Try a simpler word: motor, battery, pump, magnet.</p>'; return; }
    const src = d => `<a href="#simple/d/${u(d.id)}">${esc(d.name)}</a>${d.hazards.length ? ` <span class="s-haz">⚠ ${esc(d.hazards.slice(0, 2).join(', '))}</span>` : ''}`;
    box.innerHTML = `${job ? `<p class="s-job"><b>${esc(job.name)}:</b> ${esc(job.summary)}</p>` : ''}
      ${named && !s.bestDevices.length ? `<p><a href="#simple/d/${u(named.id)}">What’s inside: ${esc(named.name)}</a></p>` : ''}
      ${job && s.perPart.length ? `<h2>You need</h2><ul class="s-list">${s.perPart.map(p => `<li><b>${esc(p.name)}</b>${p.why ? ` <span class="s-dim">(${esc(p.why)})</span>` : ''}: ${p.sources.length ? p.sources.map(src).join('; ') : '<span class="s-dim">no source in the data yet</span>'}</li>`).join('')}</ul>` : ''}
      ${s.bestDevices.length && !job ? `<h2>Strip these</h2><ol class="s-list">${s.bestDevices.map(d => `<li><a href="#simple/d/${u(d.id)}">${esc(d.name)}</a>: ${esc(d.parts[0].spec)}${d.parts[0].where ? ` <span class="s-dim">(${esc(d.parts[0].where)})</span>` : ''}${d.hazards.length ? ` <span class="s-haz">⚠ ${esc(d.hazards.join(', '))}</span>` : ''}</li>`).join('')}</ol>
      ` : ''}${s.whereToLook.length ? `<h2>Look in</h2><p>${s.whereToLook.slice(0, 5).map(b => `${esc(b.name)} <span class="s-dim">(${esc(b.likelyLeft.toLowerCase())})</span>`).join(', ')}</p>` : ''}
      ${s.guides.length ? `<h2>Guides</h2><p>${s.guides.slice(0, 4).map(g => `<a href="#simple/g/${u(g.id)}">${esc(g.title)}</a>`).join('<br>')}</p>` : ''}`;
  }

  function find(v) {
    v.innerHTML = `<form class="s-find"><label class="sr" for="sq">What do you need?</label><input id="sq" type="search" autocomplete="off" placeholder="What do you need?" value="${esc(q)}"><button class="btn" id="sgo">Find</button></form>
      <div id="sres"></div>
      <p class="s-foot"><a href="#simple/guides">All guides</a></p>`;
    results();
    v.querySelector('.s-find').addEventListener('submit', e => e.preventDefault());
    const input = $('#sq');
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = input.value; results(); }, 200); });
    $('#sgo').addEventListener('click', () => { q = input.value; results(); });
  }

  function device(v, id) {
    const r = ctx().resolve(id);
    const guides = ctx().ds.guides.filter(g => (g.devices || []).includes(id) && ['teardown', 'safety'].includes(g.kind));
    v.innerHTML = `${back()}<h1 class="s-title">${esc(r.name)}</h1><p class="s-dim">Generic: what most of these contain. Real ones vary.</p>${hz(r.hazards)}${lookupsHTML('devices', r)}
      <p class="s-dim">About ${esc(r.mins)} min. Tools: ${esc((r.tools || []).map(ctx().toolLabel).join(', '))}.</p>
      <ul class="s-list">${r.comps.filter(x => !x.board).map(x => `<li><b>${esc((ctx().get('parts', x.fn) || {}).name || x.fn)}</b>: ${esc(x.spec)}${x.loc ? ` <span class="s-dim">(${esc(x.loc)})</span>` : ''}</li>`).join('')}</ul>
      ${guides.length ? `<p>${guides.map(g => `<a href="#simple/g/${u(g.id)}">${esc(g.title)}</a>`).join('<br>')}</p>` : ''}`;
  }

  function guide(v, id) {
    const g = ctx().get('guides', id);
    const mats = (g.materials || []).filter(m => !m.optional).map(m => m.item);
    v.innerHTML = `${back()}<h1 class="s-title">${esc(g.title)}</h1>${hz(g.hazards)}${guideNotes(g)}${lookupsHTML('guides', g)}
      ${mats.length ? `<p><b>You need:</b> ${esc(mats.join('; '))}</p>` : ''}
      <ol class="s-steps">${g.steps.map(s => `<li>${esc(s.text)}${s.warn ? `<br><span class="s-haz">⚠ ${esc(s.warn)}</span>` : ''}</li>`).join('')}</ol>`;
  }

  function list(v) {
    const all = ctx().ds.guides.filter(g => !g.deprecated).sort((a, b) => a.title.localeCompare(b.title));
    v.innerHTML = `${back()}<h1 class="s-title">Guides</h1><input id="sgf" type="search" placeholder="Filter" class="s-filter"><ul class="s-list" id="sgl">${all.map(g => `<li data-t="${esc((g.title + ' ' + (g.keywords || []).join(' ')).toLowerCase())}"><a href="#simple/g/${u(g.id)}">${esc(g.title)}</a></li>`).join('')}</ul>`;
    $('#sgf').addEventListener('input', e => { const t = e.target.value.toLowerCase(); document.querySelectorAll('#sgl li').forEach(li => (li.hidden = !!t && !li.dataset.t.includes(t))); });
  }

  function render(parts) {
    const v = $('#v-simple');
    const [, kind, id] = parts;
    if (kind === 'd' && ctx().get('devices', id)) device(v, id);
    else if (kind === 'g' && ctx().get('guides', id)) guide(v, id);
    else if (kind === 'guides') list(v);
    else find(v);
  }

  return { render };
})();

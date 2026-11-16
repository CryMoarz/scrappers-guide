// The app: works fully offline from the data built into this file, keeps your own edits and
// notes on this device, and syncs with a hub whenever one is reachable.
const esc = MD.esc;
const $ = sel => document.querySelector(sel);
const S = {
  base: null, edits: [], outbox: { comments: [], votes: [] }, carry: { proposals: [], comments: [], observations: [], votes: [] },
  comments: Object.create(null), observations: [], votes: [], tally: new Map(), markers: [], runs: [], need: [], inventory: {}, identity: null,
  settings: { hubUrl: '', autoSync: true, comments: true, subs: false, months: null, maxKg: null, tools: null, coordDecimals: 4, theme: 'auto', hubKeys: {} },
  hub: { online: false, info: null, lastSync: null, error: null, syncing: false, me: null },
  ctx: null, view: 'scrap',
};
const scrap = { q: '', sel: new Map() };
const CONF = SDG.db.CONF;
// Confidence as rising bars beside its label: one for a generic guess, four for verified.
const confMeter = (conf, count) => {
  const c = CONF[conf] || CONF.likely;
  return `<span class="conf c${c.level}" title="${esc(c.label)}: ${esc(c.about)}"><span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${count == null ? esc(c.label) : `${esc(count)} ${esc(c.label.toLowerCase())}`}</span>`;
};
// How much of a device has been confirmed in real models: one bar split by confidence, most sure first.
function confSummary(r) {
  const n = { verified: 0, documented: 0, likely: 0, assumed: 0 };
  r.comps.forEach(x => { n[S.ctx.confInfo(r.id, x.key).conf]++; });
  const total = r.comps.length, sure = total - n.assumed;
  if (!total) return '';
  const parts = Object.entries(n).filter(([, v]) => v);
  const seg = ([k, v]) => `<span class="c${CONF[k].level}" style="flex:${v}" title="${esc(CONF[k].label)}: ${v} of ${total} parts"></span>`;
  return `<div class="confsum"><div class="confbar" role="img" aria-label="${esc(parts.map(([k, v]) => `${v} ${CONF[k].label}`).join(', '))}">${parts.map(seg).join('')}</div>
    <p class="where">${sure ? `${sure} of ${total} parts confirmed in real models` : `All ${total} parts are generic guesses so far`}</p><p class="where">${parts.map(([k, v]) => confMeter(k, v)).join(' ')}</p></div>`;
}
const COLL_LABEL = { devices: 'Devices', boards: 'Shared boards', parts: 'Part types', buildings: 'Building types', jobs: 'Jobs', hazards: 'Hazards', guides: 'Guides', models: 'Logged models' };
const ONE = { devices: 'device', boards: 'board', parts: 'part type', buildings: 'building type', jobs: 'job', hazards: 'hazard', guides: 'guide', models: 'model' };
const KIND = SDG.text.KIND;
const STATUS = { local: 'Only on this device', queued: 'Waiting to send', sent: 'Sent', pending: 'Waiting for review', accepted: 'Accepted', rejected: 'Rejected', conflict: 'Needs another look', refused: 'Refused by hub' };

function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); }
const nameOf = r => (r ? r.name || r.title || r.label || r.id : '');
const pct = x => Math.round(x * 100);
const ago = iso => { if (!iso) return 'never'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
// Everything put into HTML goes through esc(), ids in links through u() as well.
const u = s => esc(encodeURIComponent(s));
const link = (coll, id, text) => `<a href="#browse/${u(coll)}/${u(id)}">${esc(text || nameOf(S.ctx.get(coll, id)) || id)}</a>`;
const guideLink = (id, text) => `<a href="#guides/${u(id)}">${esc(text || nameOf(S.ctx.get('guides', id)) || id)}</a>`;
// Only plain web links may become an href; anything else (javascript:, data:) is dropped.
const webUrl = x => (typeof x === 'string' && /^https?:\/\//i.test(x) ? x : null);

// ---------- persistence ----------
const KEYS = { base: 'base', edits: 'edits', outbox: 'outbox', carry: 'carry', comments: 'comments', observations: 'observations', votes: 'votes', markers: 'markers', runs: 'runs', need: 'need', inventory: 'inventory', settings: 'settings', identity: 'identity', hub: 'hub' };
async function save(k) { return Store.set(KEYS[k], k === 'hub' ? { lastSync: S.hub.lastSync, error: S.hub.error } : S[k]); }
async function saveAll() { for (const k of Object.keys(KEYS)) await save(k); }

async function load() {
  await Store.init();
  const [base, edits, outbox, carry, comments, observations, votes, markers, runs, need, inventory, settings, identity, hub] = await Promise.all(Object.values(KEYS).map(k => Store.get(k)));
  // Use whichever is newer: the data built into this file, or the data last synced.
  S.base = base && base.seq > RELEASE.seq ? base : { seq: RELEASE.seq, hash: RELEASE.hash, created: RELEASE.created, name: RELEASE.name, source: 'built in', signed: !!RELEASE.sig, trusted: !!RELEASE.sig && TRUST.some(k => k.key === RELEASE.sig.key), dataset: RELEASE.dataset };
  S.edits = edits || [];
  S.outbox = Object.assign({ comments: [], votes: [] }, outbox);
  S.carry = Object.assign({ proposals: [], comments: [], observations: [], votes: [] }, carry);
  S.votes = votes || [];
  S.markers = markers || [];
  S.runs = runs || [];
  S.need = need || [];
  retally();
  S.comments = Object.assign(Object.create(null), comments); // keyed by target: no prototype to trip on
  S.observations = observations || [];
  S.inventory = inventory || {};
  S.settings = Object.assign(S.settings, settings || {});
  S.identity = identity || null;
  if (hub) Object.assign(S.hub, hub);
  if (!settings) migrateV2();
  applyTheme();
}

// Templates and models made in version 2 of the app become local edits.
function migrateV2() {
  const old = Store.legacy();
  if (!old) return;
  SDG.db.migrateLegacy(old);
  const base = SDG.db.open(SDG.util.clone(S.base.dataset));
  let n = 0;
  const add = (coll, rec) => { S.edits.push({ id: SDG.util.newId(), coll, rid: rec.id, op: 'put', data: rec, baseRev: null, reason: 'Made in an earlier version of the app', created: SDG.util.now(), share: false, status: 'local' }); n++; };
  old.devices.forEach(d => { const cur = base.get('devices', d.id); if (!cur || SDG.util.canonical(SDG.sign.strip(cur, 'rev', 'updated')) !== SDG.util.canonical(d)) { if (SDG.schema.validateRecord('devices', d).ok) add('devices', d); } });
  old.boards.forEach(b => { const cur = base.get('boards', b.id); if (!cur || SDG.util.canonical(SDG.sign.strip(cur, 'rev', 'updated')) !== SDG.util.canonical(b)) { if (SDG.schema.validateRecord('boards', b).ok) add('boards', b); } });
  old.models.filter(m => !String(m.id).startsWith('m_example')).forEach(m => { m.id = SDG.util.slug(m.id); if (SDG.schema.validateRecord('models', m).ok) add('models', m); });
  if (n) setTimeout(() => toast(`Kept ${n} template${n > 1 ? 's' : ''} and model${n > 1 ? 's' : ''} from the earlier version as local edits`), 600);
}

function rebuild() {
  const ds = SDG.changes.overlay(S.base.dataset, S.edits.filter(e => e.status !== 'accepted' || !e.seq || e.seq > S.base.seq));
  S.ctx = SDG.db.open(ds);
  S.ctx.setVotes(S.tally);
  S.localIds = new Set(S.edits.filter(e => e.status !== 'accepted').map(e => e.coll + '/' + e.rid));
}
function applyTheme() { if (S.settings.theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', S.settings.theme); }

function badge() {
  const b = $('#netbadge');
  b.className = 'netbadge';
  if (!S.settings.hubUrl) { b.textContent = 'Offline only'; return; }
  if (S.hub.syncing) { b.textContent = 'Syncing…'; return; }
  const waiting = S.edits.filter(e => e.share && e.status === 'queued').length + S.outbox.comments.filter(c => c.status === 'queued').length;
  if (S.hub.online) { b.classList.add('ok'); b.textContent = `Synced ${ago(S.hub.lastSync)}${waiting ? ` · ${waiting} to send` : ''}`; }
  else { b.classList.add('warn'); b.textContent = `Offline${waiting ? ` · ${waiting} waiting` : ''}`; }
  const rv = document.querySelector('[data-tab="review"]');
  rv.hidden = !(S.hub.me && ['moderator', 'admin'].includes(S.hub.me.role));
  updateBanner();
}

function modal(html) { $('#modal-body').innerHTML = html; $('#modal').hidden = false; const f = $('#modal-body').querySelector('input,select,textarea,button'); if (f) f.focus(); }
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }
$('#modal-x').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

function hazardCard(id) {
  const h = S.ctx.hazard(id);
  const list = (t, a) => (a && a.length ? `<h3>${esc(t)}</h3><ul>${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const guides = S.ctx.ds.guides.filter(g => g.kind === 'safety' && (g.hazards || []).includes(id));
  return `<h2 id="modal-title">${esc(h.label)}</h2><p class="sub-h">Severity ${esc(h.severity)}/5</p><p>${esc(h.summary)}</p>${list('How to spot it', h.signs)}${list('Do', h.do)}${list('Don’t', h.dont)}${list('Protection', h.ppe)}${list('If it goes wrong', h.firstAid)}${(h.firstAid || []).length ? '<p class="hint">If help can still be reached, call emergency services first, or poison control for anything swallowed, breathed in or splashed. If not, see <a href="#ref/reference_first_aid/when_no_help_is_coming">First aid › When no help is coming</a>.</p>' : ''}${guides.length ? `<h3>Safety guides</h3><p>${guides.map(g => guideLink(g.id)).join(' · ')}</p>` : ''}${lookupsHTML('hazards', h)}`;
}
// Links into the offline libraries next to this app (Kiwix on a NOMAD box, NOMAD's own pages).
// Your own addresses in Sync win; otherwise whatever the hub reports.
function libEnv() {
  const hubLibs = (S.hub.info && S.hub.info.libraries) || {};
  const kiwix = S.settings.kiwixUrl ? { url: S.settings.kiwixUrl } : hubLibs.kiwix;
  const nomad = S.settings.nomadUrl ? { url: S.settings.nomadUrl } : hubLibs.nomad;
  return kiwix || nomad ? { kiwix, nomad } : null;
}
function lookupsHTML(coll, rec) {
  const env = libEnv();
  if (!env) return '';
  const links = SDG.text.lookups(S.ctx, coll, rec).map(l => ({ l, url: webUrl(SDG.text.libraryUrl(env, l, S.ctx.ds.vocab.libraries)) })).filter(x => x.url);
  return links.length ? `<p class="hint lookups">Read more offline: ${links.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.l.note || x.l.q)}">${esc(x.l.label)}${x.l.q && x.l.q !== nameOf(rec) ? `: ${esc(x.l.q)}` : ''}</a>`).join(' · ')}</p>` : '';
}
// A source on a site a NOMAD library keeps offline gets a second link, through the hub, which opens
// the library's copy of the page (or searches the library when its copy lacks the page).
function offlineHTML(url, title) {
  const k = S.hub.info && S.hub.info.libraries && S.hub.info.libraries.kiwix;
  if (!k || !S.settings.hubUrl || !SDG.text.offlinePage(url, S.ctx.ds.vocab.libraries, k.books)) return '';
  const href = `${S.settings.hubUrl.replace(/\/+$/, '')}/api/v1/offline?u=${encodeURIComponent(url)}${title ? '&t=' + encodeURIComponent(title) : ''}`;
  return ` <a class="offline" href="${esc(href)}" target="_blank" rel="noopener" title="The copy in your offline library">offline</a>`;
}
const sourceHTML = s => `${webUrl(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>${offlineHTML(s.url, s.title)}` : esc(s.title)}`;
const hazButtons = ids => (ids && ids.length ? `<div class="haz">${ids.map(h => { const c = S.ctx.hazard(h); return `<button data-haz="${esc(h)}" class="sev${esc(c.severity)}" title="${esc(c.summary)}">${esc(c.label)}</button>`; }).join('')}</div>` : '');
document.addEventListener('click', e => { const h = e.target.closest('[data-haz]'); if (h) { e.preventDefault(); modal(hazardCard(h.dataset.haz)); } });

// ---------- Scrap ----------
function opts() { return { months: S.settings.months, tools: S.settings.tools, maxKg: S.settings.maxKg }; }
function setQuery(q) {
  scrap.q = q; $('#q').value = q;
  scrap.sel = SDG.search.select(S.ctx, q, { subs: S.settings.subs }).sel;
  renderScrap();
}
function chipsHTML() {
  return [...scrap.sel].map(([id, v]) => `<button class="chip ${v.via === 'sub' ? 'sub' : v.via === 'job' ? 'job' : ''}" data-fn="${esc(id)}" aria-pressed="${!!v.on}" title="${esc(v.why || '')}">${esc(nameOf(S.ctx.get('parts', id)) || id)}${v.via === 'sub' ? ' (substitute)' : ''}</button>`).join('');
}
function devCard(r) {
  const c = r.cat, b = r.best;
  const shown = r.hits.slice(0, 4), more = r.hits.length - shown.length;
  const parts = shown.map(h => {
    const f = S.ctx.get('parts', h.comp.fn), ci = h.ci;
    const warn = [h.decay < 1 ? `About ${pct(h.decay)}% still usable by now` : '', h.left < 0.6 ? 'Often taken by now: look in less obvious places' : '', h.missingTools.length ? `Needs ${h.missingTools.map(S.ctx.toolLabel).join(', ')}` : '', h.tooHeavy ? `About ${h.comp.kg} kg each: over your carry limit` : ''].filter(Boolean);
    return `<li class="${esc(h.via === 'sub' ? 'via' : h.via)}"><span class="fn">${esc(f ? f.name : h.comp.fn)}</span>${h.via === 'sub' ? '<span class="badge">substitute</span>' : ''}${confMeter(ci.conf)}<br>${esc(h.comp.spec)}${h.comp.qty > 1 ? ` <span class="where">×${esc(h.comp.qty)}</span>` : ''}${h.comp.board ? `<div class="where">On the ${esc(h.comp.board.toLowerCase())}${h.comp.p < 0.8 ? ', in some models' : ''}</div>` : ''}<div class="where">${esc(h.comp.loc || '')}</div>${ci.confirmed.length ? `<div class="confirm">Confirmed in ${esc(ci.confirmed.join(', '))}</div>` : ''}${ci.absentIn.length ? `<div class="where">Missing in ${esc(ci.absentIn.join(', '))}</div>` : ''}${warn.map(w => `<div class="warnline">${esc(w)}</div>`).join('')}</li>`;
  }).join('') + (more > 0 ? `<li class="where" style="border-left-color:transparent">Plus ${esc(more)} more matching part${more > 1 ? 's' : ''} on this device</li>` : '');
  const needsSolder = r.hits.some(h => h.comp.board);
  const tools = [...(c.tools || []), ...(needsSolder ? ['desolder'] : [])].map(S.ctx.toolLabel).join(', ');
  const td = S.ctx.ds.guides.filter(g => g.kind === 'teardown' && (g.devices || []).some(d => d === c.id || d === c.variantOf));
  return `<article class="dev"><div class="dev-head"><div><h3><a href="#browse/devices/${u(c.id)}">${esc(c.name)}</a>${S.localIds.has('devices/' + c.id) ? '<span class="badge local">your edit</span>' : ''}</h3>${c.era ? `<div class="era">${esc(c.era)}</div>` : ''}</div><span class="score" title="Hidden-fruit score">${esc(Math.round(b.s))}</span></div>
  <div class="meter" aria-hidden="true"><span style="width:${esc(Math.round(b.s))}%"></span></div>
  <ul class="parts">${parts}</ul>
  <div class="facts"><span>Ease <b>${esc(pct(b.ease))}</b></span><span>Common <b>${esc(pct(Math.min(1, b.prev)))}</b></span><span>Overlooked <b>${esc(pct(b.obs))}</b></span><span>About <b>${esc(c.mins)} min</b></span>${c.kg ? `<span>Whole thing <b>${esc(c.kg)} kg</b></span>` : ''}<span>Tools: <b>${esc(tools)}</b></span></div>${hazButtons(c.hazards)}
  ${td.length ? `<div class="linklist">${td.map(g => `<a class="btn small ghost" href="#guides/${u(g.id)}">Teardown guide</a>`).join('')}</div>` : ''}</article>`;
}
function bldCard(a) {
  const near = nearbyObs(a.bt.id);
  return `<article class="bld"><div class="dev-head"><h3><a href="#browse/buildings/${u(a.bt.id)}">${esc(a.bt.name)}</a></h3><span class="score">${esc(Math.round(a.n))}</span></div>
  <div class="meter" aria-hidden="true"><span style="width:${esc(Math.round(a.n))}%"></span></div>
  <div class="left"><b>${esc(SDG.search.leftLabel(a.remain))}</b></div>
  <div class="from">Mostly from ${esc(a.devices.slice(0, 3).map(d => d.n).join(', '))}</div>
  ${a.bt.access ? `<div class="where">Getting in: ${esc(a.bt.access)}</div>` : ''}${hazButtons(a.bt.hazards)}
  ${near ? `<div class="where">${esc(near)}</div>` : ''}
  <div class="tags">${a.bt.osm.map(t => `<code>${esc(t)}</code>`).join('')}</div></article>`;
}
function nearbyObs(bid) {
  const list = S.observations.filter(o => o.building === bid);
  if (!list.length) return '';
  const by = {};
  list.forEach(o => (by[o.status] = (by[o.status] || 0) + 1));
  return 'Field notes: ' + Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ');
}
// What's new: the latest release notes, folded, and a line from the hub if it has one. Low-key.
function newsHTML() {
  const news = typeof NEWS === 'undefined' ? [] : NEWS;
  const ann = S.hub.info && typeof S.hub.info.announcement === 'string' ? S.hub.info.announcement.trim() : '';
  const fresh = news[0] && S.settings.newsSeen !== news[0].version;
  return `${ann ? `<p class="announce"><b>${esc(S.hub.info.name || 'Hub')}:</b> ${esc(ann)}</p>` : ''}${news.length ? `<details class="news" data-news="${esc(news[0].version)}"><summary>What’s new${fresh ? ' <span class="badge likely">new</span>' : ''} <span class="where">version ${esc(news[0].version)}</span></summary>${news.map(n => `<h4>${esc(n.version)}${n.date ? ` <span class="where">${esc(n.date)}</span>` : ''}</h4><ul>${n.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`).join('')}</details>` : ''}`;
}
document.addEventListener('toggle', async e => {
  const d = e.target;
  if (!d.matches || !d.matches('details[data-news]') || !d.open || S.settings.newsSeen === d.dataset.news) return;
  S.settings.newsSeen = d.dataset.news;
  await save('settings');
  const tag = d.querySelector('summary .badge');
  if (tag) tag.remove();
}, true);
// The first time: what the guide does and how to use it, in four lines, until it's dismissed.
function introHTML() {
  if (S.settings.introSeen) return '';
  return `<article class="card intro"><h3>How it works</h3><ol>
    <li><b>Say what you need:</b> a part (battery, 12V motor), a part number (LM2596), a job (pump water) or a device (microwave).</li>
    <li><b>Pick what to strip:</b> the devices that hide it, ranked by how easy, common and overlooked they are, and the places they’re found in.</li>
    <li><b>Check the hazards:</b> tap a red tag before you open anything.</li>
    <li><b>Plan the trip:</b> Map shows the places near you; Plan keeps your shopping list, runs and stash.</li></ol>
    <p class="where">A personal open-source project developed with AI assistance, not reviewed by qualified professionals. For educational and emergency-preparedness use only, on property you own or have permission to work on, within the law. Provided without warranty; you assume all risk.</p>
    <button class="btn small" data-introdone>Got it</button></article>`;
}
// The first few, and the rest folded under one tap.
function firstFew(items, n, fn, what) {
  const rest = items.slice(n);
  return `<div class="list">${items.slice(0, n).map(fn).join('')}</div>${rest.length ? `<details class="morelist"><summary>Show ${esc(rest.length)} more ${esc(what)}</summary><div class="list">${rest.map(fn).join('')}</div></details>` : ''}`;
}
function renderScrap() {
  $('#chips').innerHTML = chipsHTML();
  const out = $('#out');
  if (!scrap.q.trim()) {
    const st = S.ctx.stats();
    out.innerHTML = `<div class="empty">${introHTML()}<p class="hint" style="margin-top:16px">Try one of these:</p>
    <div class="quick">${['battery', '12V motor', 'keep food cold', 'purify water', 'pump water', 'generate electricity', 'LM2596', 'neodymium magnet', 'gps', 'start a fire', 'rope', 'propane'].map(s => `<button class="btn small ghost" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <p class="hint">Or open the <a href="#ref">quick reference</a>: warning labels, codes, pinouts and numbers.</p>
    ${newsHTML()}
    <div class="stats small"><div><strong>${esc(st.searchableDevices)}</strong>devices</div><div><strong>${esc(st.parts)}</strong>part types</div><div><strong>${esc(st.jobs)}</strong>jobs</div><div><strong>${esc(st.guides)}</strong>guides</div><div><strong>${esc(st.buildings)}</strong>building types</div><div><strong>${esc(st.models)}</strong>logged models</div></div>
    ${allPartsHTML()}</div>`;
    return;
  }
  const res = SDG.search.search(S.ctx, scrap.q, Object.assign({ sel: scrap.sel }, opts()));
  const job = res.jobs.find(j => [...scrap.sel.values()].some(v => v.job === j.id));
  const perPart = (res.perPart || []).length ? `<h4 style="margin:12px 0 4px">Best source for each part</h4><ul class="parts">${res.perPart.map(p => `<li class="job"><span class="fn">${esc(nameOf(S.ctx.get('parts', p.fn)))}</span>${p.why ? ` <span class="where">${esc(p.why)}</span>` : ''}<br>${p.res.length ? p.res.map(x => `${link('devices', x.cat.id)} <span class="where">${esc(Math.round(x.best.s))}</span>`).join(' · ') : '<span class="where">no source in the data yet</span>'}</li>`).join('')}</ul>` : '';
  const jobHTML = job ? `<article class="card job"><h3>${esc(job.name)}</h3><p>${esc(job.summary)}</p>${perPart}${(job.tips || []).length ? `<ul>${job.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${(job.guides || []).length ? `<div class="linklist">${job.guides.filter(g => S.ctx.get('guides', g)).map(g => `<a class="btn small ghost" href="#guides/${u(g)}">${esc(nameOf(S.ctx.get('guides', g)))}</a>`).join('')}</div>` : ''}</article>` : '';
  const named = res.devices.slice(0, 3).map(d => link('devices', d.id, `What’s inside: ${d.name}`)).join(' · ');
  const guides = res.guides.filter(g => !job || !(job.guides || []).includes(g.id)).slice(0, 5);
  const models = res.models.length ? `<article class="card" style="margin-top:16px"><h3>In logged models</h3><ul class="parts">${res.models.slice(0, 6).map(h => `<li class="direct">${link('models', h.model.id, S.ctx.modelName(h.model))} <span class="where">${esc(nameOf(S.ctx.get('devices', h.model.device) || { id: h.model.device }))}</span>${h.parts.slice(0, 3).map(x => `<br>${esc(x.spec)} ${confMeter(x.conf || 'likely')}`).join('')}</li>`).join('')}</ul></article>` : '';
  const brands = res.brands.length && !res.devices.length && !scrap.sel.size ? `<article class="card" style="margin-top:16px">${res.brands.slice(0, 3).map(b => `<h3>${esc(b.brand)}</h3><p class="where">Kinds of things ${esc(b.brand)} makes that the guide covers. They are generic devices: log a model when you open one to add its exact parts.</p><div class="linklist">${b.devices.map(d => link('devices', d.id)).join(' · ')}</div>`).join('')}</article>` : '';
  const extra = brands + models + (named ? `<p class="hint">${named}</p>` : '') + (guides.length ? `<p class="hint">Guides: ${guides.map(g => guideLink(g.id, `${KIND[g.kind] || g.kind}: ${g.title}`)).join(' · ')}</p>` : '');
  if (!scrap.sel.size && res.devices.length) { out.innerHTML = `${jobHTML}${models}${res.devices.slice(0, 2).map(insideCard).join('')}${res.devices.length > 2 ? `<p class="hint">Also: ${res.devices.slice(2, 10).map(d => link('devices', d.id)).join(' · ')}</p>` : ''}`; return; }
  if (!scrap.sel.size && (models || brands)) { out.innerHTML = `${jobHTML}${extra}`; return; }
  if (!scrap.sel.size) { out.innerHTML = `${jobHTML}${extra}<div class="empty"><p class="hint" style="margin-top:20px">No part type matches “${esc(scrap.q)}”. Try a plain word like motor, battery, pump or magnet, or pick one below.</p>${allPartsHTML(true)}</div>`; return; }
  const r = res.ranked;
  if (!r.res.length) { out.innerHTML = `${jobHTML}${extra}<p class="hint" style="margin-top:20px">Nothing in the database contains the selected part types yet. Add one in Contribute, or turn on substitutes.</p>`; return; }
  const onMap = S.settings.hubUrl ? '<a href="#map">Show on the map</a>' : '';
  const strip = `<div class="wherestrip"><b>Where to look</b> ${onMap ? `<span class="where">· ${onMap}</span>` : ''}<div class="chips">${r.blds.slice(0, 4).map(a => `<a class="chip" href="#browse/buildings/${u(a.bt.id)}">${esc(a.bt.name)}</a>`).join('')}</div></div>`;
  const n = [...scrap.sel.values()].filter(v => v.on).length;
  out.innerHTML = `${jobHTML}${extra}${strip}<div class="results"><div><div class="reshead"><h2>Best devices to strip</h2><a href="#" data-needsel>Add ${n > 1 ? 'these parts' : 'this part'} to my shopping list</a></div><p class="sub-h">${esc(r.res.length)} devices, ranked by how useful, easy and overlooked the part is. Devices are generic: what most units of each kind contain.</p>${firstFew(r.res.slice(0, 30), 6, devCard, 'devices')}</div>
  <div><div class="reshead"><h2>Where to look</h2>${onMap}</div><p class="sub-h">Building types ranked by likely stock left.</p>${firstFew(r.blds.slice(0, 12), 5, bldCard, 'building types')}
  <div class="note">${S.settings.months == null ? 'Results assume day one. Set months since collapse in Filters to age batteries and fuel and to allow for what looters have probably taken.' : `Adjusted for ${esc(S.settings.months)} month${S.settings.months == 1 ? '' : 's'} since collapse: aged parts and what looters have probably taken.`}</div></div></div>`;
}
// "What's inside" for a query that names a device.
function insideCard(d) {
  const r = S.ctx.resolve(d.id);
  const own = r.comps.filter(x => !x.board).sort((a, b) => b.obs - a.obs || a.ext - b.ext);
  const guides = S.ctx.ds.guides.filter(g => (g.devices || []).includes(r.id));
  return `<article class="card" style="margin-top:20px"><h3>${link('devices', r.id, `What’s inside: ${r.name}`)} <span class="badge assumed">Generic</span></h3><p class="where">What most units of this kind contain; real ones vary.</p><p class="where">${esc(r.era || '')} About ${esc(r.mins)} min with ${esc((r.tools || []).map(S.ctx.toolLabel).join(', '))}.</p>${hazButtons(r.hazards)}
  <ul class="parts" style="margin-top:12px">${own.slice(0, 10).map(x => `<li class="direct"><a class="fn" href="#" data-pick="${esc(x.fn)}">${esc(nameOf(S.ctx.get('parts', x.fn)) || x.fn)}</a><br>${esc(x.spec)}${x.qty > 1 ? ` <span class="where">×${esc(x.qty)}</span>` : ''}<div class="where">${esc(x.loc || '')}</div></li>`).join('')}</ul>
  ${guides.length ? `<div class="linklist">${guides.map(g => `<a class="btn small ghost" href="#guides/${u(g.id)}">${esc(KIND[g.kind] || g.kind)}: ${esc(g.title)}</a>`).join('')}</div>` : ''}</article>`;
}
function allPartsHTML(open) {
  const groups = {};
  S.ctx.ds.parts.filter(f => !f.deprecated).forEach(f => (groups[f.group] = groups[f.group] || []).push(f));
  const order = S.ctx.ds.vocab.partGroups || [];
  const keys = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return `<details class="all" ${open ? 'open' : ''}><summary>All part types</summary>${keys.map(g => `<h4 style="margin:12px 0 4px;font-size:.88rem;color:var(--muted)">${esc(g)}</h4><div class="chips" style="margin-top:4px">${groups[g].sort((a, b) => a.name.localeCompare(b.name)).map(f => `<button class="chip" data-pick="${esc(f.id)}">${esc(f.name)}</button>`).join('')}</div>`).join('')}</details>`;
}
function filterSummary() {
  const s = S.settings;
  $('#filtsum').textContent = [s.months == null ? 'day one' : `${s.months} month${s.months == 1 ? '' : 's'} in`, s.tools ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : 'any tools', s.maxKg != null ? `carry ${s.maxKg} kg` : '', s.subs ? 'substitutes' : ''].filter(Boolean).join(' · ');
}
function renderToolPick() {
  const tools = S.ctx.ds.vocab.tools || {};
  const have = S.settings.tools;
  filterSummary();
  $('#toolpick').innerHTML = `<button class="chip" data-tools="any" aria-pressed="${!have}">Don’t filter</button>` + Object.entries(tools).filter(([k]) => k !== 'hands').map(([k, l]) => `<button class="chip" data-tool="${esc(k)}" aria-pressed="${!!have && have.includes(k)}">${esc(l)}</button>`).join('');
}

// ---------- Guides ----------
const gstate = { filter: '', kind: '', build: false };
// Every guide says whether someone who does the work has reviewed it, and the dangerous ones
// (difficulty 4 or 5, or marked so) say they are for people who have done it before.
const isHard = g => !!(g.experienced || g.difficulty >= 4);
function guideNotes(g) {
  const r = g.reviewed;
  return `${isHard(g) ? '<div class="note danger"><b>Experienced only.</b> Done wrong, this can kill or maim. If you haven’t done this kind of work, leave it, or do it alongside someone who has.</div>' : ''}<p class="hint">${r ? `Reviewed by ${esc(r.by)}, ${esc(r.experience)}${r.date ? ` (${esc(r.date)})` : ''}.` : 'Not yet reviewed by someone who does this work. Treat it as a starting point, and if you know the work, suggest an edit.'}</p>`;
}
// What to learn or build before a guide, and what it leads to.
function learnHTML(g) {
  const first = ((g.tree && g.tree.requires) || []).filter(r => S.ctx.get('guides', r));
  const next = S.ctx.ds.guides.filter(x => !x.deprecated && x.tree && (x.tree.requires || []).includes(g.id));
  return (first.length ? `<p class="hint">Learn first: ${first.map(r => guideLink(r)).join(' · ')}</p>` : '') +
    (next.length ? `<p class="hint">Leads to: ${next.map(x => guideLink(x.id)).join(' · ')}</p>` : '');
}
function renderGuides(id) {
  const v = $('#v-guides');
  const all = S.ctx.ds.guides.filter(g => !g.deprecated);
  let list = all;
  if (gstate.filter) { const hits = SDG.search.findGuides(S.ctx, gstate.filter, gstate.kind || undefined).map(h => h.g.id); list = hits.map(h => S.ctx.get('guides', h)); }
  else if (gstate.kind) list = all.filter(g => g.kind === gstate.kind);
  const groups = {};
  list.forEach(g => (groups[g.kind] = groups[g.kind] || []).push(g));
  const left = `<div class="catlist"><label class="sr" for="gf">Filter guides</label><input id="gf" type="search" placeholder="Find a guide" value="${esc(gstate.filter)}">
    <select id="gk" style="margin-top:8px"><option value="">Every kind</option>${Object.entries(KIND).map(([k, l]) => `<option value="${esc(k)}"${gstate.kind === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn small ghost" id="buildmode">What can I build?</button><button class="btn small ghost" data-new="guides">New guide</button></div>
    ${Object.keys(KIND).filter(k => groups[k]).map(k => `<h4>${esc(KIND[k])}</h4>${groups[k].sort((a, b) => gstate.filter ? 0 : a.title.localeCompare(b.title)).map(g => `<button class="cat" data-guide="${esc(g.id)}" aria-current="${g.id === id}">${esc(g.title)}${S.localIds.has('guides/' + g.id) ? '<span class="mark">edit</span>' : ''}</button>`).join('')}`).join('') || '<p class="hint">No guides match.</p>'}</div>`;
  v.innerHTML = `${guideSwitch('guides')}<div class="browse${id || gstate.build ? ' has-detail' : ''}">${left}<div class="detail" id="gdetail"></div></div>`;
  const d = $('#gdetail');
  if (gstate.build && !id) { d.innerHTML = buildModeHTML(); return; }
  const g = id && S.ctx.get('guides', id);
  if (!g) { d.innerHTML = `<h2>Guides</h2><p class="sub-h">${esc(all.length)} guides: teardowns, builds and blueprints, repairs, field tests, safety and skills. Pick one, or find out what you can build from what you have.</p>`; return; }
  const have = new Set(Object.keys(S.inventory).filter(k => S.inventory[k] > 0));
  d.innerHTML = `<p class="sub-h" style="margin:0">${esc(KIND[g.kind] || g.kind)} · difficulty ${esc(g.difficulty)}/5${g.mins ? ` · about ${esc(g.mins)} min` : ''}</p><h2>${esc(g.title)}</h2><p>${esc(g.summary)}</p>
    ${(g.tools || []).length ? `<div class="facts" style="margin-top:0"><span>Tools: <b>${esc(g.tools.map(S.ctx.toolLabel).join(', '))}</b></span></div>` : ''}${hazButtons(g.hazards)}${guideNotes(g)}
    ${(g.materials || []).length ? `<h3>Materials</h3><ul class="mats">${g.materials.map(m => `<li class="${m.fn ? (have.has(m.fn) ? 'have' : 'miss') : ''}">${esc(m.item)}${m.qty ? ` <span class="where">(${esc(m.qty)})</span>` : ''}${m.optional ? ' <span class="where">optional</span>' : ''}${m.fn ? ` · <a href="#" data-scrapfor="${esc(m.fn)}">where to scrap it</a>${have.has(m.fn) ? ' ✓ you have this' : ''}` : ''}</li>`).join('')}</ul>` : ''}${(g.materials || []).some(m => m.fn && !m.optional && !have.has(m.fn)) ? `<p class="hint"><a href="#" data-needmiss="${esc(g.id)}">Add what I’m missing to my shopping list</a></p>` : ''}
    <h3>Steps</h3><ol class="steps">${g.steps.map(s => `<li>${esc(s.text)}${s.warn ? `<span class="warn">⚠ ${esc(s.warn)}</span>` : ''}</li>`).join('')}</ol>
    ${g.notes ? MD.render(g.notes) : ''}
    ${(g.devices || []).length ? `<p class="hint">Devices: ${g.devices.filter(x => S.ctx.get('devices', x)).map(x => link('devices', x)).join(' · ')}</p>` : ''}
    ${(g.parts || []).length ? `<p class="hint">Part types: ${g.parts.filter(x => S.ctx.get('parts', x)).map(x => link('parts', x)).join(' · ')}</p>` : ''}
    <p class="hint">License ${esc(g.license || 'CC-BY-SA-4.0')}${(g.credits || []).length ? ' · Credits: ' + esc(g.credits.join(', ')) : ''}${(g.sources || []).length ? ' · Sources: ' + g.sources.map(sourceHTML).join('; ') : ''}</p>
    ${learnHTML(g)}${lookupsHTML('guides', g)}<div class="actions"><button class="btn ghost" data-edit="guides/${esc(g.id)}">Suggest an edit</button><button class="btn ghost" data-print>Print</button></div>${commentsHTML('guides/' + g.id)}`;
}
function buildModeHTML() {
  const have = Object.keys(S.inventory).filter(k => S.inventory[k] > 0);
  const list = SDG.search.buildable(S.ctx, have, Object.assign({ all: !have.length }, opts())).slice(0, 25);
  return `<h2>What can I build?</h2><p class="sub-h">From the ${esc(have.length)} part type${have.length === 1 ? '' : 's'} in your stash (Plan › Stash). Missing parts show the best thing to scrap for them.</p>
  ${!have.length ? '<p class="hint">Your stash is empty, so this lists every build. Add what you have in <a href="#plan/stash">Plan › Stash</a>.</p>' : ''}
  <div class="list">${list.map(x => `<article class="card"><div class="dev-head"><h3>${guideLink(x.guide.id)}</h3><span class="score">${esc(pct(x.coverage))}%</span></div><p class="where">${esc(x.guide.summary)}</p>
  ${x.missing.length ? `<div class="where">Missing: ${x.missing.map(m => `${esc(nameOf(S.ctx.get('parts', m.fn)) || m.item)}${m.bestSource ? ` (try ${link('devices', m.bestSource.id, m.bestSource.name)})` : ''}`).join('; ')}</div>` : '<div class="confirm">You have every part type it needs.</div>'}</article>`).join('') || '<p class="hint">No build guides yet.</p>'}</div>`;
}

// ---------- Quick reference ----------
// Warning labels (drawn in reference.js) and the reference guides, as cards to open and print.
const guideSwitch = on => `<div class="seg two" role="tablist" aria-label="Guides or quick reference"><a href="#guides" role="tab" aria-selected="${on === 'guides'}">Guides</a><a href="#ref" role="tab" aria-selected="${on === 'ref'}">Quick reference</a></div>`;
function renderRef(id) {
  const v = $('#v-ref');
  const card = c => `<a class="plancard" href="#ref/${u(c.id)}"><b>${esc(c.title)}</b><span class="where">${esc(c.summary)}</span></a>`;
  if (!id) {
    v.innerHTML = `${guideSwitch('ref')}<h2 class="section">Quick reference</h2><p class="sub-h">Calculators, warning labels, codes, pinouts and the numbers you need when there’s no internet. Print the cheat sheets you’ll carry.</p>
      <h3 class="section">Calculators</h3><div class="refgrid">${Calc.LIST.map(card).join('')}</div>
      ${Ref.groups(S.ctx).map(([title, list]) => `<h3 class="section">${esc(title)}</h3><div class="refgrid">${list.map(card).join('')}</div>`).join('')}`;
    return;
  }
  const tool = Calc.get(id);
  if (tool) {
    v.innerHTML = `${guideSwitch('ref')}<div class="detail refdetail"><a class="back" href="#ref">‹ Quick reference</a><h2>${esc(tool.title)}</h2><p class="sub-h">${esc(tool.summary)}</p><div id="calcbox">${Calc.toolHTML(id)}</div></div>`;
    Calc.wire(id, $('#calcbox'));
    return;
  }
  // Cards drawn by code rather than written as guides.
  const DRAWN = { labels: [Ref.LABELS, Ref.labelsHTML], pinouts: [Pinouts.META, Pinouts.html] };
  const drawn = Object.prototype.hasOwnProperty.call(DRAWN, id) ? DRAWN[id] : null;
  const g = drawn ? null : S.ctx.get('guides', id);
  if (!drawn && !g) { v.innerHTML = `${guideSwitch('ref')}<p class="hint">No such card. <a href="#ref">All quick reference</a></p>`; return; }
  const body = g ? `${guideNotes(g)}${g.notes ? MD.render(g.notes) : ''}${(g.steps || []).length ? `<h3>Using it</h3><ol class="steps">${g.steps.map(s => `<li>${esc(s.text)}${s.warn ? `<span class="warn">⚠ ${esc(s.warn)}</span>` : ''}</li>`).join('')}</ol>` : ''}${(g.sources || []).length ? `<h3>Sources</h3><ul>${g.sources.map(s => `<li>${sourceHTML(s)}</li>`).join('')}</ul>` : ''}` : drawn[1]();
  v.innerHTML = `${guideSwitch('ref')}<div class="detail refdetail"><a class="back" href="#ref">‹ Quick reference</a><h2>${esc(g ? g.title : drawn[0].title)}</h2>${g ? `<p class="sub-h">${esc(g.summary)}</p>` : ''}${body}
    <div class="actions">${g ? `<button class="btn ghost" data-edit="guides/${esc(g.id)}">Suggest an edit</button>` : ''}<button class="btn ghost" data-print>Print</button></div>${g ? commentsHTML('guides/' + g.id) : ''}</div>`;
}

// ---------- Browse ----------
const bstate = { coll: 'devices', filter: '' };
function renderBrowse(coll, id) {
  if (coll) bstate.coll = coll;
  coll = bstate.coll;
  const v = $('#v-browse');
  const f = bstate.filter.toLowerCase();
  const recs = (coll === 'devices' ? S.ctx.ds.devices.map(d => S.ctx.resolve(d.id)) : S.ctx.ds[coll]).filter(r => r && (!f || JSON.stringify([r.id, nameOf(r), r.group, r.keywords, r.aliases, r.brand, r.model]).toLowerCase().includes(f)));
  const groups = {};
  recs.forEach(r => { const g = r.group || r.kind || (coll === 'models' ? nameOf(S.ctx.get('devices', r.device)) : coll === 'hazards' ? `Severity ${r.severity}` : ''); (groups[g] = groups[g] || []).push(r); });
  const left = `<div class="catlist"><select id="bc">${Object.entries(COLL_LABEL).filter(([k]) => k !== 'guides').map(([k, l]) => `<option value="${esc(k)}"${k === coll ? ' selected' : ''}>${esc(l)} (${esc(S.ctx.ds[k].length)})</option>`).join('')}</select>
    <input id="bf" type="search" placeholder="Filter" value="${esc(bstate.filter)}" style="margin-top:8px">
    <div style="margin-top:10px"><button class="btn small ghost" data-new="${esc(coll)}">New ${esc(ONE[coll])}</button></div>
    ${Object.keys(groups).sort().map(g => `${g ? `<h4>${esc(g)}</h4>` : ''}${groups[g].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map(r => `<button class="cat ${r.variantOf ? 'variant' : ''}" data-open="${esc(coll)}/${esc(r.id)}" aria-current="${r.id === id}">${esc(nameOf(r))}${S.localIds.has(coll + '/' + r.id) ? '<span class="mark">edit</span>' : ''}${r.deprecated ? ' <span class="where">(old)</span>' : ''}</button>`).join('')}`).join('') || '<p class="hint">Nothing matches.</p>'}</div>`;
  v.innerHTML = `<div class="browse${id ? ' has-detail' : ''}">${left}<div class="detail" id="bdetail"></div></div>`;
  $('#bdetail').innerHTML = id && S.ctx.get(coll, id) ? (coll === 'hazards' ? detailHTML(coll, id) : detailHTML(coll, id).replace('<div class="actions">', lookupsHTML(coll, coll === 'devices' ? S.ctx.resolve(id) : S.ctx.get(coll, id)) + '<div class="actions">')) : `<h2>${esc(COLL_LABEL[coll])}</h2><p class="sub-h">Pick one on the left. Everything here can be corrected: use “Suggest an edit” and it goes to the hub for review when you’re next online.</p>`;
}
// What a device is made of, heaviest first: where the copper, aluminium and circuit boards are.
const MATERIALS = { copper: 'Copper', aluminium: 'Aluminium', steel: 'Steel', other_metal: 'Other metals', plastic: 'Plastic', glass: 'Glass', boards: 'Circuit boards', battery: 'Battery', other: 'Other' };
function madeOfHTML(m) {
  const list = Object.entries(m || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return list.length ? `<p class="where madeof">Made of (typical): ${list.map(([k, v]) => `${esc(MATERIALS[k] || k)} <b>${esc(v >= 1 ? v + ' kg' : Math.round(v * 1000) + ' g')}</b>`).join(' · ')}</p>` : '';
}
// What community repair events found: how often one was saved, and what had usually failed, which
// in a dead one is the part to suspect; the rest is probably still good.
function repairsHTML(rp) {
  if (!rp || !rp.records) return '';
  const faults = (rp.faults || []).map(f => `${esc(f.what)} ${esc(pct(f.share))}%`).join(' · ');
  return `<p class="where">At repair events (${esc(rp.records.toLocaleString('en'))} recorded): <b>${esc(pct(rp.fixed || 0))}%</b> fixed, <b>${esc(pct(rp.end_of_life || 0))}%</b> beyond repair.${faults ? ` What had failed: ${faults}. In a dead one, suspect those first; the rest is probably still good.` : ''}</p>`;
}
// Each cell carries its column's name, so on a phone a row can show as a small card.
const table = (head, rows) => `<div class="tbl stack"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => { let i = 0; return r.replace(/<td>/g, () => `<td data-l="${esc(head[i++] || '')}">`); }).join('')}</tbody></table></div>`;
function localNote(coll, id) {
  const e = S.edits.find(x => x.coll === coll && x.rid === id && x.status !== 'accepted');
  return e ? `<div class="note">You changed this: <span class="badge ${esc(e.status)}">${esc(STATUS[e.status] || e.status)}</span>${e.note ? ` ${esc(e.note)}` : ''} <a href="#contribute">See your changes</a></div>` : '';
}
function detailHTML(coll, id) {
  const ctx = S.ctx;
  const actions = extra => `<div class="actions">${extra || ''}<button class="btn ghost" data-edit="${esc(coll)}/${esc(id)}">Suggest an edit</button><button class="btn ghost" data-json="${esc(coll)}/${esc(id)}">Edit JSON</button></div>`;
  const common = localNote(coll, id);
  const rec = ctx.get(coll, id);
  if (coll === 'devices') {
    const r = ctx.resolve(id);
    const models = ctx.ds.models.filter(m => m.device === id), variants = ctx.ds.devices.filter(c => c.variantOf === id);
    const own = r.comps.filter(x => !x.board), onb = r.comps.filter(x => x.board);
    const row = (x, canVote) => { const f = ctx.get('parts', x.fn); const ci = ctx.confInfo(r.id, x.key); return `<tr><td>${f ? link('parts', x.fn) : esc(x.fn)}</td><td>${esc(x.spec)}</td><td>${esc(x.qty)}</td><td>${esc(x.loc || '')}${x.board && x.p < 0.8 ? ' <span class="where">(some models)</span>' : ''}</td><td>${esc(x.ext)}</td><td>${esc(x.obs)}</td><td>${confMeter(ci.conf)}${ci.votes && ci.votes.disputed ? ' <span class="badge absent">Disputed</span>' : ''}${canVote ? voteButtons(SDG.votes.partTarget(r.id, x.key), VOTE.part) : ''}</td></tr>`; };
    const head = ['Part type', 'Spec', 'Qty', 'Where', 'Difficulty', 'Overlooked', 'Confidence'];
    const guides = ctx.ds.guides.filter(g => (g.devices || []).includes(id) || (r.variantOf && (g.devices || []).includes(r.variantOf)));
    const td = guides.filter(g => g.kind === 'teardown'), other = guides.filter(g => g.kind !== 'teardown');
    return `${common}<h2>${esc(r.name)} <span class="badge assumed" title="${esc(SDG.db.GENERIC_NOTE)}">Generic</span></h2><p class="sub-h">${r.parentName ? `Variant of ${link('devices', r.variantOf)}. ` : ''}${r.era ? esc(r.era) + '. ' : ''}${r.abstract ? 'Parent template: search uses its variants.' : ''}</p>
    <div class="facts" style="margin-top:0"><span>Common <b>${esc(r.prev)}/5</b></span><span>About <b>${esc(r.mins)} min</b></span>${r.kg ? `<span>Weight <b>${esc(r.kg)} kg</b></span>` : ''}<span>Tools: <b>${esc((r.tools || []).map(ctx.toolLabel).join(', '))}</b></span></div>${madeOfHTML(r.materials)}${repairsHTML(r.repairs)}${hazButtons(r.hazards)}
    <div class="actions primary">${td.map(g => `<a class="btn" href="#guides/${u(g.id)}">Teardown guide</a>`).join('')}${r.abstract ? '' : `<button class="btn ok" data-strip="${esc(id)}" title="Adds its major parts to your stash">Stripped one</button><button class="btn ghost" data-logmodel="${esc(id)}">Log a model of this</button>`}</div>
    ${r.notes ? `<p>${esc(r.notes)}</p>` : ''}${confSummary(r)}
    <p class="hint">${(r.aliases || []).length ? 'Also called ' + esc(r.aliases.join(', ')) + '. ' : ''}${(r.brands || []).length ? 'Common brands: ' + esc(r.brands.join(', ')) + '. ' : ''}${esc(SDG.db.GENERIC_NOTE)}</p>
    ${other.length ? `<p class="hint">Guides: ${other.map(g => guideLink(g.id, `${KIND[g.kind] || g.kind}: ${g.title}`)).join(' · ')}</p>` : ''}
    <h3 class="section">Major parts</h3>${table(head, own.map(x => row(x, !r.abstract)))}
    ${onb.length ? `<h3 class="section">Boards inside</h3><div class="linklist">${(r.boards || []).filter(b => ctx.get('boards', b.id)).map(b => link('boards', b.id) + (b.p < 0.8 ? ' <span class="where">(some models)</span>' : '')).join(' · ')}</div><details style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">Components on those boards (${esc(onb.length)})</summary>${table(head, onb.map(row))}</details>` : ''}
    <h3 class="section">Found in</h3><div class="tags">${(r.buildings || []).map(b => `<a class="chip" href="#browse/buildings/${u(b.b)}">${esc(nameOf(ctx.get('buildings', b.b)) || b.b)} ${esc(b.l)}/5</a>`).join('')}</div>
    ${variants.length ? `<h3 class="section">Variants</h3><div class="linklist">${variants.map(x => link('devices', x.id)).join(' · ')}</div>` : ''}
    <h3 class="section">Logged models</h3>${models.length ? models.map(m => `<div class="mrow"><span>${link('models', m.id, ctx.modelName(m))}${m.years ? ` (${esc(m.years)})` : ''}</span><span class="where">${esc((m.comps || []).length)} parts checked</span></div>`).join('') : '<p class="hint" style="margin:0">None yet. Opened one? Log it.</p>'}
    ${actions(`<button class="btn ghost" data-variant="${esc(id)}">Add a variant</button>`)}${commentsHTML('devices/' + id)}`;
  }
  if (coll === 'boards') {
    const users = ctx.ds.devices.filter(c => (c.boards || []).some(x => x.id === id));
    return `${common}<h2>${esc(rec.name)}</h2><p class="sub-h">Shared board. ${esc(rec.notes || '')}</p>${table(['Part type', 'Spec', 'Qty', 'Where', 'Difficulty', 'Overlooked'], rec.comps.map(x => `<tr><td>${link('parts', x.fn)}</td><td>${esc(x.spec)}</td><td>${esc(x.qty)}</td><td>${esc(x.loc || '')}</td><td>${esc(x.ext)}</td><td>${esc(x.obs)}</td></tr>`))}
    <h3 class="section">Used in</h3><div class="linklist">${users.map(u => link('devices', u.id)).join(' · ') || '<span class="hint">No devices yet.</span>'}</div>${actions()}${commentsHTML('boards/' + id)}`;
  }
  if (coll === 'parts') {
    const ranked = SDG.search.rank(ctx, new Map([[id, { via: 'direct', on: true }]]), '', opts());
    const jobs = ctx.ds.jobs.filter(j => j.parts.some(p => p.fn === id));
    const guides = ctx.ds.guides.filter(g => (g.parts || []).includes(id) || (g.materials || []).some(m => m.fn === id));
    const d = rec.decay;
    return `${common}<p class="sub-h" style="margin:0">${esc(rec.group)} · demand ${esc(rec.demand)}/5</p><h2>${esc(rec.name)}</h2>${rec.summary ? `<p>${esc(rec.summary)}</p>` : ''}
    ${(rec.uses || []).length ? `<h3>Good for</h3><ul>${rec.uses.map(u => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
    ${rec.identify ? `<h3>How to recognise it</h3><p>${esc(rec.identify)}</p>` : ''}${rec.test ? `<h3>How to test it</h3><p>${esc(rec.test)}</p>` : ''}
    ${d ? `<h3>Shelf life</h3><p>${d.halfLifeMonths ? `About half is unusable after ${esc(d.halfLifeMonths)} months without care.` : 'Lasts indefinitely if kept dry.'} ${esc(d.note || '')}</p>` : ''}${hazButtons(rec.hazards)}
    ${(rec.substitutes || []).length ? `<p class="hint">Substitutes: ${rec.substitutes.filter(s => ctx.get('parts', s)).map(s => link('parts', s)).join(' · ')}</p>` : ''}
    <p class="hint">Search words: ${esc((rec.keywords || []).join(', '))}</p>
    ${jobs.length ? `<p class="hint">Jobs: ${jobs.map(j => link('jobs', j.id)).join(' · ')}</p>` : ''}${guides.length ? `<p class="hint">Guides: ${guides.map(g => guideLink(g.id)).join(' · ')}</p>` : ''}
    <h3 class="section">Best sources (${esc(ranked.res.length)})</h3>${ranked.res.slice(0, 15).map(x => `<div class="mrow"><span>${link('devices', x.cat.id)} <span class="where">${esc(x.best.comp.spec)}</span></span><span class="score" style="font-size:1.1rem">${esc(Math.round(x.best.s))}</span></div>`).join('') || '<p class="hint">No device contains it yet.</p>'}
    ${actions(`<button class="btn" data-q="${esc(rec.name)}" data-goscrap>Scrap for this</button><button class="btn ghost" data-needadd="${esc(id)}">Add to shopping list</button>`)}${commentsHTML('parts/' + id)}`;
  }
  if (coll === 'buildings') {
    const devs = ctx.ds.devices.filter(dv => !dv.abstract).map(dv => ctx.resolve(dv.id)).map(r => ({ r, l: ((r.buildings || []).find(b => b.b === id) || {}).l })).filter(x => x.l).sort((a, b) => b.l - a.l || b.r.prev - a.r.prev);
    return `${common}<h2>${esc(rec.name)}</h2><p class="sub-h">Looting pressure ${esc(rec.exposure)}/5. ${esc(rec.notes || '')}</p>${rec.access ? `<p>Getting in: ${esc(rec.access)}</p>` : ''}${hazButtons(rec.hazards)}
    <div class="tags">${rec.osm.map(t => `<code>${esc(t)}</code>`).join('')}</div><p class="hint">${esc(nearbyObs(id))}</p>
    <h3 class="section">What’s inside (${esc(devs.length)})</h3>${devs.map(x => `<div class="mrow"><span>${link('devices', x.r.id)}</span><span class="where">likelihood ${esc(x.l)}/5</span></div>`).join('')}${actions()}${commentsHTML('buildings/' + id)}`;
  }
  if (coll === 'jobs') {
    return `${common}<h2>${esc(rec.name)}</h2><p>${esc(rec.summary)}</p><h3>Part types</h3><ul>${rec.parts.map(p => `<li>${link('parts', p.fn)}${p.core ? ' <span class="badge">core</span>' : ''}${p.why ? ` <span class="where">${esc(p.why)}</span>` : ''}</li>`).join('')}</ul>
    ${(rec.tips || []).length ? `<h3>Tips</h3><ul>${rec.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${(rec.guides || []).length ? `<p class="hint">Guides: ${rec.guides.filter(g => ctx.get('guides', g)).map(g => guideLink(g)).join(' · ')}</p>` : ''}
    <p class="hint">Search phrases: ${esc((rec.keywords || []).join(', '))}</p>${actions(`<button class="btn" data-q="${esc(rec.keywords[0] || rec.name)}" data-goscrap>Search this job</button>`)}${commentsHTML('jobs/' + id)}`;
  }
  if (coll === 'hazards') return `${common}${hazardCard(id).replace('id="modal-title"', '')}${actions()}${commentsHTML('hazards/' + id)}`;
  if (coll === 'models') {
    const r = ctx.resolve(rec.device);
    const src = x => (webUrl(x) ? ` <a href="${esc(x)}" target="_blank" rel="noopener noreferrer">source</a>${offlineHTML(x)}` : '');
    const rows = (rec.comps || []).map(o => { const base = r && r.comps.find(c => c.key === o.key); return `<tr><td>${esc(base ? nameOf(ctx.get('parts', base.fn)) : nameOf(ctx.get('parts', o.fn)) || o.key)}</td><td>${o.absent ? '<span class="badge absent" style="margin:0">Not present</span>' : `${confMeter(o.conf || 'likely')}`}</td><td>${esc(o.spec || (base && base.spec) || '')}${src(o.source)}</td></tr>`; });
    return `${common}<h2>${esc(ctx.modelName(rec))}</h2><p class="sub-h">${link('devices', rec.device)}${rec.years ? ` · ${esc(rec.years)}` : ''}${rec.fcc ? ` · FCC/ISED ${esc(rec.fcc)}` : ''}</p>${rec.notes ? `<p>${esc(rec.notes)}</p>` : ''}${table(['Part', 'Status', 'Spec'], rows)}
    ${(rec.sources || []).length ? `<h3 class="section">Sources</h3><ul>${rec.sources.map(s => `<li>${sourceHTML(s)}${s.note ? ` <span class="where">${esc(s.note)}</span>` : ''}</li>`).join('')}</ul><p class="hint">Documented means a public source shows it; verified means someone opened one. Brand names identify products only.</p>` : ''}${researchHTML(rec.research)}${actions()}${commentsHTML('models/' + id)}`;
  }
  return '';
}

// A model's research log, folded away: what was left out or unclear, and how the sources were read.
function researchHTML(res) {
  res = res || {};
  const list = (title, items) => ((items || []).length ? `<h4>${esc(title)}</h4><ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  if (!res.checked && !(res.gaps || []).length && !(res.method || []).length) return '';
  return `<details class="research"><summary>How this was researched${res.checked ? ` <span class="where">checked ${esc(res.checked)}</span>` : ''}</summary>${list('Left out or unclear', res.gaps)}${list('How the sources were read', res.method)}<p class="hint">Difficulty and overlooked ratings are editorial.</p></details>`;
}

// ---------- Votes ----------
// Everyone's votes we hold plus our own queued ones, counted once per person; parts feed confidence.
function retally() {
  S.tally = SDG.votes.tally([...S.votes, ...S.outbox.votes.map(v => v.item)]);
  if (S.ctx) S.ctx.setVotes(S.tally);
}
// Keeps the newest vote from each person on each thing.
function mergeVotes(list) {
  const key = v => v.target + '\n' + (v.author && v.author.key);
  const m = new Map(S.votes.map(v => [key(v), v]));
  list.forEach(v => { const cur = m.get(key(v)); if (!cur || String(v.created) > String(cur.created)) m.set(key(v), v); });
  S.votes = [...m.values()];
}
const VOTE = {
  part: [['Found it', 'I opened one and this was in it'], ['Not in mine', 'I opened one and this wasn’t there']],
  comment: [['Helpful', 'This helped me']],
  note: [['Still true', 'I was there and this still holds'], ['Not anymore', 'I was there and it has changed']],
};
// Small buttons with counts; the one you chose is pressed, and choosing it again takes it back.
function voteButtons(target, labels) {
  const t = S.tally.get(target) || { up: 0, down: 0 };
  const me = S.identity ? SDG.votes.mine([...S.votes, ...S.outbox.votes.map(v => v.item)], S.identity.key, target) : 0;
  const b = (v, [text, title], n) => `<button class="vote" data-vote="${esc(target)}" data-v="${v}" aria-pressed="${me === v}" title="${esc(title)}">${esc(text)}${n ? ` <b>${esc(n)}</b>` : ''}</button>`;
  return `<span class="votes">${b(1, labels[0], t.up)}${labels[1] ? b(-1, labels[1], t.down) : ''}</span>`;
}
async function castVote(target, value) {
  if (!S.identity) return toast('Make a contributor key in Sync to vote: votes are signed so nobody can stuff them');
  const v = SDG.votes.mine([...S.votes, ...S.outbox.votes.map(x => x.item)], S.identity.key, target) === value ? 0 : value;
  const item = Object.assign(await SDG.votes.make(target, v), { author: { key: S.identity.key, name: S.identity.name } });
  S.outbox.votes = S.outbox.votes.filter(x => x.item.target !== target || x.status !== 'queued').concat([{ item, status: 'queued' }]);
  await save('outbox');
  retally();
  if (S.settings.hubUrl) Sync.schedule(2500);
  const labels = VOTE[SDG.votes.kindOf(target)];
  document.querySelectorAll('.votes').forEach(el => { if (el.querySelector(`[data-vote="${CSS.escape(target)}"]`)) el.outerHTML = voteButtons(target, labels); });
}

// ---------- Comments ----------
function addComment(c) {
  const list = S.comments[c.target] = S.comments[c.target] || [];
  if (list.some(x => x.id === c.id)) return;
  list.push(c);
  list.sort((a, b) => a.created.localeCompare(b.created));
  if (list.length > 100) list.splice(0, list.length - 100);
}
function commentsHTML(target) {
  if (!S.settings.comments) return '';
  const list = (S.comments[target] || []).filter(c => !c.hidden);
  const mine = S.outbox.comments.filter(c => c.item.target === target);
  const own = c => !!(S.identity && c.author && c.author.key === S.identity.key);
  const one = (c, status) => `<div class="comment${c.parent ? ' reply' : ''}"><div class="who">${esc((c.author && c.author.name) || (status ? 'You' : 'Someone'))} · ${esc(String(c.created).slice(0, 10))}${status ? ` · <span class="badge ${esc(status)}">${esc(STATUS[status] || status)}</span>` : ''}</div>${esc(c.body)}${status || own(c) ? '' : `<div>${voteButtons('comments/' + c.id, VOTE.comment)}</div>`}</div>`;
  // Most helpful first; replies stay under what they answer.
  const up = c => (S.tally.get('comments/' + c.id) || { up: 0 }).up;
  const tops = list.filter(c => !c.parent || !list.some(p => p.id === c.parent)).sort((a, b) => up(b) - up(a) || String(a.created).localeCompare(String(b.created)));
  const ordered = tops.flatMap(t => [t, ...list.filter(c => c.parent === t.id)]);
  return `<div class="comments"><h3 style="margin:0 0 6px">Comments (${esc(list.length + mine.length)})</h3>${ordered.map(c => one(c)).join('')}${mine.map(c => one(c.item, c.status)).join('')}
  <label class="sr" for="cbody">Add a comment</label><textarea id="cbody" placeholder="A tip, a correction, a question…" maxlength="4000"></textarea><div class="actions" style="margin-top:6px"><button class="btn small" data-comment="${esc(target)}">Add comment</button></div></div>`;
}

// ---------- Editing ----------
// Problems a change would add to the current data (schema and references).
function newProblems(coll, rid, op, data) {
  if (op === 'put') { const v = SDG.schema.validateRecord(coll, Object.assign({}, data, { id: rid })); if (!v.ok) return v.errors; }
  const key = p => `${p.coll}|${p.id}|${p.path}|${p.msg}`;
  const before = new Set(SDG.schema.validateDataset(S.ctx.ds).map(key));
  const ds = SDG.changes.overlay(S.ctx.ds, [{ coll, rid, op, data }]);
  return SDG.schema.validateDataset(ds).filter(p => !before.has(key(p))).map(p => ({ path: p.coll === coll && p.id === rid ? p.path : `(elsewhere) ${p.coll}/${p.id} ${p.path}`, msg: p.msg }));
}
async function commitEdit(coll, rid, op, data, reason, share) {
  const cur = S.base.dataset[coll].find(r => r.id === rid);
  const prev = S.edits.findIndex(e => e.coll === coll && e.rid === rid && ['local', 'queued', 'refused', 'rejected'].includes(e.status));
  const e = { id: SDG.util.newId(), coll, rid, op, data: op === 'put' ? SDG.sign.strip(data, 'rev', 'updated', 'id') : undefined, baseRev: cur ? (cur.rev || 0) : null, reason: reason || '', created: SDG.util.now(), share: !!share, status: share ? 'queued' : 'local' };
  if (prev >= 0) S.edits.splice(prev, 1, e); else S.edits.push(e);
  await save('edits');
  rebuild();
  badge();
  if (share) { if (!S.identity) toast('Saved. Make a contributor key in Sync to send it.'); else Sync.schedule(2500); }
  return e;
}
function openEditor(coll, rec, opt) {
  opt = opt || {};
  const isNew = !rec || opt.isNew;
  modal(`<h2 id="modal-title">${isNew ? 'New ' + esc(ONE[coll]) : 'Edit ' + esc(nameOf(rec))}</h2>
    <p class="sub-h">${isNew ? 'Fill in what you know. Fields marked * are required.' : 'Change what’s wrong. Your edit applies on this device at once.'} Read the data guide rules: be honest, give units, never invent model numbers.</p>
    <div class="actions" style="margin:0 0 8px"><button class="btn small ghost" id="ed-mode">Edit as JSON</button></div>
    <div id="ed-form"></div><textarea class="json" id="ed-json" spellcheck="false" hidden></textarea>
    <div class="field"><label for="ed-reason">Why (shown to reviewers)</label><input id="ed-reason" placeholder="What you saw, where, and how sure you are" maxlength="2000"></div>
    <label class="toggle" style="margin-top:10px"><input type="checkbox" id="ed-share" checked> Send to the hub for review</label>
    <div class="err" id="ed-err"></div>
    <div class="actions"><button class="btn" id="ed-save">Save</button>${!isNew ? '<button class="btn danger" id="ed-del">Delete</button>' : ''}<button class="btn ghost" id="ed-cancel">Cancel</button></div>`);
  const form = Forms.mount($('#ed-form'), coll, rec || {}, S.ctx, { isNew });
  let jsonMode = false;
  $('#ed-mode').onclick = () => {
    jsonMode = !jsonMode;
    if (jsonMode) $('#ed-json').value = JSON.stringify(Object.assign({}, form.read(), rec && !isNew ? { id: rec.id } : {}), null, 1);
    else { try { const v = JSON.parse($('#ed-json').value); openEditor(coll, v, Object.assign({}, opt, { json: false })); return; } catch (e) { $('#ed-err').textContent = 'That JSON doesn’t parse: ' + e.message; jsonMode = true; return; } }
    $('#ed-form').hidden = jsonMode; $('#ed-json').hidden = !jsonMode;
    $('#ed-mode').textContent = jsonMode ? 'Back to the form' : 'Edit as JSON';
  };
  if (opt.json) $('#ed-mode').click();
  $('#ed-cancel').onclick = closeModal;
  $('#ed-save').onclick = async () => {
    let data;
    try { data = jsonMode ? JSON.parse($('#ed-json').value) : form.read(); } catch (e) { $('#ed-err').textContent = 'That JSON doesn’t parse: ' + e.message; return; }
    const rid = isNew ? data.id : rec.id;
    if (!rid) { $('#ed-err').textContent = 'Give it an id: lowercase letters, digits and underscores.'; return; }
    if (isNew && S.ctx.get(coll, rid)) { $('#ed-err').textContent = `There’s already a ${ONE[coll]} with the id “${rid}”.`; return; }
    if (!isNew && data.id && data.id !== rid) { $('#ed-err').textContent = 'Ids can’t change once made. Make a new record instead.'; return; }
    const errs = newProblems(coll, rid, 'put', data);
    if (errs.length) { if (!jsonMode) form.showErrors(errs); $('#ed-err').textContent = errs.slice(0, 8).map(e => `${e.path} ${e.msg}`).join('\n'); return; }
    await commitEdit(coll, rid, 'put', data, $('#ed-reason').value, $('#ed-share').checked);
    closeModal();
    toast('Saved');
    location.hash = coll === 'guides' ? `#guides/${rid}` : `#browse/${coll}/${rid}`;
    rerender();
  };
  if ($('#ed-del')) $('#ed-del').onclick = async () => {
    const errs = newProblems(coll, rec.id, 'delete');
    if (errs.length) { $('#ed-err').textContent = 'Other records still point at this:\n' + errs.slice(0, 8).map(e => `${e.path} ${e.msg}`).join('\n'); return; }
    if (!confirm(`Delete ${nameOf(rec)}? On this device it goes at once; on the hub it waits for review.`)) return;
    await commitEdit(coll, rec.id, 'delete', null, $('#ed-reason').value || 'Delete', $('#ed-share').checked);
    closeModal(); toast('Deleted'); location.hash = coll === 'guides' ? '#guides' : `#browse/${coll}`; rerender();
  };
}

// ---------- Contribute ----------
function renderContribute() {
  const v = $('#v-contribute');
  const ctx = S.ctx;
  const groups = {};
  ctx.ds.devices.filter(d => !d.abstract).map(d => ctx.resolve(d.id)).forEach(r => (groups[r.group || 'Other'] = groups[r.group || 'Other'] || []).push(r));
  const edits = [...S.edits].reverse();
  v.innerHTML = `<div class="form"><h2>Log a model you opened</h2><p class="sub-h">Start from a template and mark what you actually found. This is the most valuable thing you can contribute: every logged model turns guesses into verified data.</p>
    <div class="grid2"><div class="field"><label for="lcat">Device</label><select id="lcat">${Object.keys(groups).sort().map(k => `<optgroup label="${esc(k)}">${groups[k].sort((a, b) => a.name.localeCompare(b.name)).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>
    <div class="field"><label for="lbrand">Brand</label><input id="lbrand"></div><div class="field"><label for="lmodel">Model</label><input id="lmodel"></div><div class="field"><label for="lyears">Years (optional)</label><input id="lyears" placeholder="2012–2016"></div><div class="field"><label for="lfcc">FCC or ISED id (optional)</label><input id="lfcc"></div></div>
    <div class="field"><label for="lnotes">Notes</label><input id="lnotes" placeholder="Board markings, quirks, teardown tips"></div>
    <h3 style="margin:20px 0 4px">Parts from the template</h3><div id="lparts"></div>
    <h3 style="margin:20px 0 4px">Parts not in the template</h3><div id="lextra"></div><button class="btn small ghost" id="addx" style="margin-top:8px">Add a part</button>
    <label class="toggle" style="margin-top:14px;display:flex"><input type="checkbox" id="lshare" checked> Send to the hub for review</label>
    <div class="actions"><button class="btn" id="savem">Save model</button></div><div class="err" id="lerr"></div></div>
    <div class="form section"><h2>Add something new</h2><p class="sub-h">Every kind of record has a form.</p><div class="actions">${Object.keys(COLL_LABEL).map(c => `<button class="btn ghost small" data-new="${esc(c)}">New ${esc(ONE[c])}</button>`).join('')}</div></div>
    <div class="form section"><h2>Your changes (${esc(edits.length)})</h2><p class="sub-h">Edits apply on this device straight away. Shared ones go to the hub for review when you’re online${S.identity ? '' : ' and have a contributor key (Sync tab)'}.</p>
    ${edits.map(e => `<div class="mrow"><span><b>${e.op === 'delete' ? 'Delete' : (S.base.dataset[e.coll] || []).some(r => r.id === e.rid) ? 'Edit' : 'New'} ${esc(ONE[e.coll])}</b> ${e.op === 'delete' ? esc(e.rid) : e.coll === 'guides' ? guideLink(e.rid) : link(e.coll, e.rid)} <span class="badge ${esc(e.status)}">${esc(STATUS[e.status] || e.status)}</span>${e.share ? '' : ' <span class="where">(private)</span>'}<br><span class="where">${esc(String(e.created).slice(0, 16).replace('T', ' '))}${e.reason ? ' · ' + esc(e.reason) : ''}${e.note ? ' · ' + esc(e.note) : ''}</span></span>
      <span class="actions" style="margin:0">${['local', 'refused', 'rejected', 'conflict'].includes(e.status) ? `<button class="btn small ghost" data-share="${esc(e.id)}">${e.status === 'local' ? 'Share' : 'Send again'}</button>` : ''}${e.status !== 'accepted' ? `<button class="btn small danger" data-discard="${esc(e.id)}">Discard</button>` : ''}</span></div>`).join('') || '<p class="hint" style="margin:0">Nothing yet.</p>'}</div>`;
  renderLogParts();
}
function renderLogParts() {
  const r = S.ctx.resolve($('#lcat').value);
  $('#lparts').innerHTML = r ? r.comps.map(x => `<div class="prow" data-row="${esc(x.key)}"><div class="nm">${esc(nameOf(S.ctx.get('parts', x.fn)) || x.fn)}<small>${x.board ? esc(x.board) + '. ' : ''}${esc(x.loc || '')}</small></div>
   <input class="rowin" data-k="spec" value="${esc(x.spec)}" data-orig="${esc(x.spec)}" aria-label="Spec">
   <select class="rowin" data-k="conf" aria-label="Status"><option value="">Not checked</option><option value="likely">Likely</option><option value="verified">Verified</option><option value="absent">Not present</option></select></div>`).join('') : '';
}
function partOptions() {
  const groups = {};
  S.ctx.ds.parts.forEach(f => (groups[f.group] = groups[f.group] || []).push(f));
  return Object.entries(groups).map(([g, fs]) => `<optgroup label="${esc(g)}">${fs.sort((a, b) => a.name.localeCompare(b.name)).map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</optgroup>`).join('');
}
function addExtraRow() {
  const d = document.createElement('div'); d.className = 'xrow'; d.dataset.extra = '1';
  const opt = n => [1, 2, 3, 4, 5].map(i => `<option ${i === n ? 'selected' : ''}>${esc(i)}</option>`).join('');
  d.innerHTML = `<select class="rowin" data-k="fn" aria-label="Part type">${partOptions()}</select><input class="rowin" data-k="spec" placeholder="Spec" aria-label="Spec"><input class="rowin" data-k="qty" type="number" min="1" value="1" aria-label="Quantity"><select class="rowin" data-k="ext" aria-label="Difficulty 1 to 5" title="Difficulty">${opt(2)}</select><select class="rowin" data-k="obs" aria-label="Overlooked 1 to 5" title="Overlooked">${opt(4)}</select><input class="rowin" data-k="loc" placeholder="Where inside" aria-label="Where inside"><button class="btn small danger" aria-label="Remove part" data-rmx>×</button>`;
  $('#lextra').appendChild(d);
}
async function saveModel() {
  const err = $('#lerr'); err.textContent = '';
  const dev = $('#lcat').value, brand = $('#lbrand').value.trim(), model = $('#lmodel').value.trim();
  if (!brand && !model) { err.textContent = 'Add a brand or model name so it can be found later.'; return; }
  const comps = [];
  document.querySelectorAll('#lparts [data-row]').forEach(row => {
    const key = row.dataset.row, spec = row.querySelector('[data-k=spec]'), st = row.querySelector('[data-k=conf]').value;
    if (st === 'absent') { comps.push({ key, absent: true }); return; }
    const changed = spec.value.trim() !== spec.dataset.orig;
    if (!st && !changed) return;
    const o = { key, conf: st || 'likely' }; if (changed) o.spec = spec.value.trim(); comps.push(o);
  });
  let n = 0;
  document.querySelectorAll('#lextra [data-extra]').forEach(row => {
    const g = k => row.querySelector(`[data-k=${k}]`).value, spec = g('spec').trim();
    if (!spec) return;
    comps.push({ key: `${g('fn')}_x${n++}`, fn: g('fn'), spec, qty: +g('qty') || 1, ext: +g('ext'), obs: +g('obs'), loc: g('loc').trim() || undefined, conf: 'verified' });
  });
  let id = SDG.util.slug(`${dev}_${brand}_${model}`).slice(0, 60);
  for (let i = 2; S.ctx.get('models', id); i++) id = SDG.util.slug(`${dev}_${brand}_${model}`).slice(0, 56) + '_' + i;
  const rec = { device: dev, brand: brand || undefined, model: model || undefined, years: $('#lyears').value.trim() || undefined, fcc: $('#lfcc').value.trim() || undefined, notes: $('#lnotes').value.trim() || undefined, comps };
  const errs = newProblems('models', id, 'put', rec);
  if (errs.length) { err.textContent = errs.map(e => `${e.path} ${e.msg}`).join('\n'); return; }
  await commitEdit('models', id, 'put', rec, `Opened a ${brand} ${model}`.trim(), $('#lshare').checked);
  toast('Model saved');
  renderContribute();
}

// ---------- Field ----------
// Others' shared notes can be confirmed or called out of date; your own show what others said.
function noteVotes(o) {
  const t = S.tally.get('observations/' + o.id) || { up: 0, down: 0 };
  const stale = t.down > t.up ? ' <span class="badge absent">Probably out of date</span>' : '';
  if (o.mine) return (t.up || t.down ? ` <span class="where">${esc(t.up)} still true · ${esc(t.down)} not anymore</span>` : '') + stale;
  return o.share === 'private' ? '' : stale + ' ' + voteButtons('observations/' + o.id, VOTE.note);
}
// ---------- Plan ----------
// Your own things: what you need, the runs to get it, what you have, what you've seen, your
// markers. A card for each; on a phone one at a time, with a way back.
const PLAN = {
  list: ['Shopping list', () => { const left = (S.need || []).filter(n => !n.got).length; return (S.need || []).length ? `${left} part type${left === 1 ? '' : 's'} to find` : 'The parts you need'; }],
  runs: ['Runs', () => { const r = Runs.active(); return r ? `${r.name} · ${r.stops.length} stop${r.stops.length === 1 ? '' : 's'}` : (S.runs || []).length ? `${S.runs.length} run${S.runs.length === 1 ? '' : 's'}` : 'Trips to several places'; }],
  stash: ['Stash', () => { const n = Object.values(S.inventory).filter(x => x > 0).length; return n ? `${n} part type${n === 1 ? '' : 's'} on hand` : 'What you have on hand'; }],
  notes: ['Field notes', () => { const n = S.observations.filter(o => o.mine).length, o = S.observations.length - n; return n || o ? `${n} yours${o ? `, ${o} from others` : ''}` : 'How places stand'; }],
  markers: ['Markers', () => { const n = (S.markers || []).length; return n ? `${n} on the map` : 'Home base, stash points, water'; }],
};
function renderPlan(sec) {
  const v = $('#v-plan');
  const cur = PLAN[sec] ? sec : 'list';
  const nav = `<nav class="plannav" aria-label="Plan"><div><h2>Plan</h2><p class="sub-h" style="margin:0">Your own things. They stay on this device and go in your backup.</p></div>${Object.entries(PLAN).map(([k, [title, sub]]) => `<a class="plancard" href="#plan/${k}" aria-current="${k === cur}"><b>${esc(title)}</b><span class="where">${esc(sub())}</span></a>`).join('')}</nav>`;
  v.innerHTML = `<div class="plan${PLAN[sec] ? ' has-detail' : ''}">${nav}<div class="detail plandetail"><a class="back" href="#plan">‹ Plan</a><h2>${esc(PLAN[cur][0])}</h2><div id="plansec">${planSection(cur)}</div></div></div>`;
  wirePlan(cur);
  navCounts();
}
const noHub = what => (S.settings.hubUrl ? '' : `<p class="hint">${esc(what)} needs a hub with an offline map: connect one in Sync.</p>`);
function planSection(k) {
  if (k === 'list') return `${Runs.needHTML()}${noHub('Planning a run for the list')}`;
  if (k === 'runs') return `${Runs.panelHTML()}${noHub('The route on the map')}`;
  const inv = Object.entries(S.inventory).filter(([, n]) => n > 0).sort((a, b) => nameOf(S.ctx.get('parts', a[0])).localeCompare(nameOf(S.ctx.get('parts', b[0]))));
  if (k === 'stash') return `<p class="sub-h">What you have on hand. Powers “What can I build?” in Guides.</p>
    ${inv.map(([fn, n]) => `<div class="mrow"><span>${link('parts', fn)} × ${esc(n)}</span><button class="btn small danger" data-invrm="${esc(fn)}">Remove</button></div>`).join('') || '<p class="hint">Empty. Add parts below, or tap “Stripped one” on a device.</p>'}
    <div class="section"><div class="grid2"><div class="field"><label for="invfn">Part type</label><select id="invfn">${partOptions()}</select></div><div class="field"><label for="invn">How many</label><input id="invn" type="number" min="1" value="1"></div></div>
    <div class="actions"><button class="btn small" id="invadd">Add to stash</button><a class="btn small ghost" href="#guides" id="tobuild">What can I build?</a></div>
    <div class="grid2"><div class="field"><label for="invdev">Or strip a whole device</label><select id="invdev">${S.ctx.ds.devices.filter(d => !d.abstract).map(d => S.ctx.resolve(d.id)).sort((a, b) => a.name.localeCompare(b.name)).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></div></div>
    <div class="actions" style="margin-top:6px"><button class="btn small ok" id="invstrip">Add its parts</button>${inv.length ? '<button class="btn small danger" id="invclear">Empty stash</button>' : ''}</div>
    </div>`;
  if (k === 'notes') {
    const pos = S.pos;
    const dist = o => (pos ? Math.hypot((o.lat - pos.lat) * 111, (o.lon - pos.lon) * 111 * Math.cos(pos.lat * Math.PI / 180)) : null);
    const obs = [...S.observations].sort((a, b) => (pos ? dist(a) - dist(b) : b.created.localeCompare(a.created)));
    return `<p class="sub-h">How places stand: untouched, partly looted, cleared, dangerous or occupied. The quickest way is to tap a place on the Map. Private notes never leave this device; “peers” travel only in bundles you hand over or to a node you sync with; “public” goes to the hub. Locations are rounded to about ${S.settings.coordDecimals >= 4 ? '10 m' : S.settings.coordDecimals === 3 ? '100 m' : '1 km'}.</p>
    ${obs.slice(0, 200).map(o => `<div class="mrow"><span><b>${esc(o.label || nameOf(S.ctx.get('buildings', o.building)) || 'Place')}</b> <span class="badge ${o.status === 'untouched' ? 'accepted' : o.status === 'dangerous' || o.status === 'occupied' ? 'rejected' : 'pending'}">${esc(o.status)}</span>${o.mine ? ` <span class="where">${esc(o.share)}</span>` : ' <span class="where">from others</span>'}${noteVotes(o)}<br><span class="where">${esc(o.lat)}, ${esc(o.lon)}${pos ? ` · ${esc(dist(o).toFixed(1))} km` : ''} · ${esc(String(o.created).slice(0, 10))}${o.notes ? ' · ' + esc(o.notes) : ''}</span></span>${o.mine ? `<button class="btn small danger" data-obsrm="${esc(o.id)}">Delete</button>` : ''}</div>`).join('') || '<p class="hint">No notes yet.</p>'}
    <details class="research"><summary>Add a note by coordinates</summary><div class="grid2"><div class="field"><label for="olat">Latitude</label><input id="olat" type="number" step="any" value="${pos ? esc(pos.lat.toFixed(5)) : ''}"></div><div class="field"><label for="olon">Longitude</label><input id="olon" type="number" step="any" value="${pos ? esc(pos.lon.toFixed(5)) : ''}"></div>
    <div class="field"><label for="ostatus">Status</label><select id="ostatus"><option value="untouched">Untouched</option><option value="partial">Partly looted</option><option value="cleared">Cleared</option><option value="dangerous">Dangerous</option><option value="occupied">Occupied</option></select></div>
    <div class="field"><label for="obld">Building type</label><select id="obld"><option value="">—</option>${S.ctx.ds.buildings.slice().sort((a, b) => a.name.localeCompare(b.name)).map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="oshare">Who can see it</label><select id="oshare"><option value="private">Only me</option><option value="peers">Peers I sync with</option><option value="public">Public (hub)</option></select></div></div>
    <div class="field"><label for="olabel">Name or description</label><input id="olabel" maxlength="300"></div><div class="field"><label for="onotes">Notes</label><textarea id="onotes" maxlength="2000"></textarea></div>
    <div class="actions"><button class="btn small ghost" id="ogeo">Use my location</button><button class="btn small" id="oadd">Save note</button><button class="btn small ghost" id="ogeojson">Export as GeoJSON</button></div><div class="err" id="oerr"></div>
</details>`;
  }
  if (k === 'markers') {
    const list = S.markers || [];
    return `<p class="sub-h">Your own map markers. They stay on this device: never synced or shared, only in your backup.</p>
    ${list.map(m => `<div class="mrow"><span><b>${esc(m.name || MapView.markLabel(m.kind))}</b> <span class="where">${esc(MapView.markLabel(m.kind))}</span>${m.notes ? `<br><span class="where">${esc(m.notes)}</span>` : ''}</span><button class="btn small ghost" data-markgo="${esc(m.id)}">Show</button></div>`).join('') || '<p class="hint">None yet.</p>'}
    <div class="actions"><button class="btn small" id="markadd">Add a marker on the map</button></div>`;
  }
  return '';
}
function wirePlan(k) {
  const again = () => keepPlace(() => renderPlan(k));
  if (k === 'list') Runs.wireNeeds($('#v-plan'), again, name => MapView.search(name), async () => { if (await MapView.planList()) location.hash = 'plan/runs'; else again(); });
  if (k === 'runs') Runs.wire($('#v-plan'), again, x => MapView.show(x.lat, x.lon, 'run'), () => MapView.start('stop'));
}
// The Plan tab shows how many parts are still to find.
function navCounts() {
  const el = $('#plancount'), n = (S.need || []).filter(x => !x.got).length;
  el.hidden = !n; el.textContent = n;
}

// ---------- More ----------
// On a phone, the sections that don't fit along the bottom, what's new, and about.
// What each mark in the app means, with counts from the data rather than claims that go stale.
function legendHTML() {
  const guides = S.ctx.ds.guides.filter(g => !g.deprecated), reviewed = guides.filter(g => g.reviewed).length;
  const row = (mark, text) => `<dt>${mark}</dt><dd>${text}</dd>`;
  return `<h3 class="section">What the marks mean</h3><dl class="legend">
    ${Object.keys(CONF).map(k => row(confMeter(k), esc(CONF[k].about[0].toUpperCase() + CONF[k].about.slice(1)) + '.')).join('')}
    ${row('<span class="badge assumed" style="margin:0">Generic</span>', 'A device template: what most units of a kind contain, not one model.')}
    ${row('<span class="haz" style="margin:0"><span class="sev5">Hazard</span></span>', 'Tap one for what it does, how to spot it and what to do. Filled red are the most dangerous.')}
    ${row('<b class="exp">Experienced only</b>', 'Guides of difficulty 4 or 5, or marked so: only for people who have done this kind of work.')}
    ${row('<b>Reviewed by</b>', `A guide someone who does the work has read and found sound: ${esc(reviewed)} of ${esc(guides.length)} so far.`)}</dl>`;
}
function renderMore() {
  const st = S.ctx.stats();
  const mod = S.hub.me && ['moderator', 'admin'].includes(S.hub.me.role);
  const rows = [['ref', 'Quick reference', 'Warning labels, codes, pinouts and numbers to have without the internet'], ['browse', 'Browse the database', 'Every device, part type, building type, job, hazard and logged model'], ['contribute', 'Contribute', 'Log a model you opened, add something new, see your changes'], ['sync', 'Sync and settings', $('#netbadge').textContent + ' · hub, contributor key, files, theme'], ...(mod ? [['review', 'Review', 'Proposals waiting for a moderator']] : [])];
  $('#v-more').innerHTML = `<div class="morelist">${rows.map(([k, t, sub]) => `<a class="plancard" href="#${k}"><b>${esc(t)}</b><span class="where">${esc(sub)}</span></a>`).join('')}
    <button class="plancard" id="moresimple"><b>Simple mode</b><span class="where">Big text: just search, results and steps</span></button></div>
    <div class="form section"><h2>About</h2><p class="sub-h">An offline guide to salvage: which devices hide the part you need, how to get it out safely, and where to look.</p>
    <p>A personal open-source project made to be as useful as possible for salvage and finding the components you need: a tool that enables me to build a fortress caravan, dodging zombies, demons and asteroids, and becoming a benevolent warlord or well-respected raider. Code, research and writing are AI-assisted.</p>
    ${legendHTML()}
    <div class="note danger"><b>Disclaimer.</b> For educational and emergency-preparedness purposes only. Use it only on property you own or have permission to work on, in compliance with all applicable laws. Provided “as is”, without warranty of any kind; general information, not professional advice. Salvage involves serious risk of injury and death, and you assume all risk arising from your use of this information.</div>
    <div class="stats small"><div><strong>${esc(st.searchableDevices)}</strong>devices</div><div><strong>${esc(st.parts)}</strong>part types</div><div><strong>${esc(st.guides)}</strong>guides</div><div><strong>${esc(st.models)}</strong>logged models</div></div>
    ${newsHTML()}<p class="hint">Build ${esc(BUILD.version)}, ${esc(BUILD.date)}. Code MIT, data CC BY-SA 4.0.</p></div>`;
}

// ---------- Sync ----------
async function renderSync() {
  const v = $('#v-sync');
  const st = S.ctx.stats();
  const fp = S.identity ? await SDG.sign.fingerprint(S.identity.key) : null;
  const signOk = await SDG.sign.supported();
  const usage = await Store.usage();
  const waiting = S.edits.filter(e => e.share && e.status === 'queued').length;
  const info = S.hub.info;
  v.innerHTML = `<div class="form"><h2>Your data</h2><div class="stats" style="margin-top:0"><div><strong>${esc(st.searchableDevices)}</strong>devices</div><div><strong>${esc(st.parts)}</strong>part types</div><div><strong>${esc(st.guides)}</strong>guides</div><div><strong>${esc(S.edits.length)}</strong>your edits</div><div><strong>${esc(S.observations.filter(o => o.mine).length)}</strong>your field notes</div></div>
    <p class="hint">Data version ${esc(S.base.seq)} from ${esc(S.base.source)}, made ${esc(String(S.base.created).slice(0, 10))}. ${S.base.trusted ? 'Signed by a trusted key.' : S.base.signed ? 'Signed, by a key this app doesn’t know.' : 'Not signed.'} Saved in ${esc(Store.mode())}${usage && usage.usage ? `, using about ${esc(Math.round(usage.usage / 1048576))} MB` : ''}.</p></div>
  <div class="form section"><h2>Hub</h2><p class="sub-h">A hub (or a node at your camp, NOMAD box or cyberdeck) sends you accepted changes and takes your contributions. Everything here works without one.</p>
    <div class="grid2"><div class="field"><label for="hurl">Hub address</label><input id="hurl" placeholder="http://192.168.1.20:8787" value="${esc(S.settings.hubUrl)}"></div></div>
    <div class="actions"><button class="btn" id="hconnect">${S.settings.hubUrl ? 'Sync now' : 'Connect'}</button>${S.settings.hubUrl ? '<button class="btn ghost" id="hforget">Forget this hub</button>' : ''}</div>
    <p class="hint">${S.settings.hubUrl ? `${S.hub.online ? 'Reachable' : 'Not reachable right now'}. Last sync ${esc(ago(S.hub.lastSync))}.${S.hub.error ? ' Last problem: ' + esc(S.hub.error) : ''} ${esc(waiting)} change${waiting === 1 ? '' : 's'} waiting to send.${info ? ` ${esc(info.name)} (${esc(info.mode)}), version ${esc(info.seq)}. Comments ${esc(info.policy && info.policy.comments)}.` : ''}${S.hub.me ? ` Your role: ${esc(S.hub.me.role)}, ${esc(S.hub.me.accepted || 0)} accepted.` : ''}` : 'No hub set.'}</p>
    <label class="toggle"><input type="checkbox" id="sauto"${S.settings.autoSync ? ' checked' : ''}> Sync automatically when the hub is reachable</label></div>
  <div class="form section"><h2>Contributor key</h2><p class="sub-h">Your key signs what you send so nobody can forge or alter it. No account, no email. Back it up: lose it and you start again with a new name.</p>
    ${!signOk ? '<p class="err">This browser can’t make signing keys (it needs Ed25519). You can still use everything else, and export bundles from another device.</p>' : S.identity ? `<p>Name <b>${esc(S.identity.name || '(none)')}</b>, fingerprint <code>${esc(fp)}</code></p><div class="actions"><button class="btn ghost small" id="idexport">Back up my key</button><button class="btn ghost small" id="idrename">Change name</button><button class="btn danger small" id="iddel">Remove key from this device</button></div>`
    : `<div class="grid2"><div class="field"><label for="idname">Name others will see</label><input id="idname" maxlength="60" placeholder="A handle is fine"></div></div><div class="actions"><button class="btn" id="idnew">Make my key</button><label class="btn ghost small">Restore a key file<input type="file" id="idimport" accept=".json,.key,application/json" hidden></label></div>`}</div>
  <div class="form section"><h2>Files</h2><p class="sub-h">For when there’s no network: carry these on a USB stick, a phone or a radio link. Bundles only hold signed items, so whoever carries them can’t change them.</p>
    <div class="actions"><button class="btn small" id="fexport">Export my contributions</button><button class="btn small ghost" id="frelease">Export the whole database</button><label class="btn small ghost">Import a file<input type="file" id="fimport" accept=".json,.gz,application/json" hidden></label><button class="btn small ghost" id="fbackup">Back up everything on this device</button></div>
    <p class="hint">${S.carry.proposals.length + S.carry.comments.length + S.carry.observations.length + S.carry.votes.length ? `Carrying ${esc(S.carry.proposals.length)} proposals, ${esc(S.carry.comments.length)} comments, ${esc(S.carry.observations.length)} notes and ${esc(S.carry.votes.length)} votes for others; they go to the next hub you reach.` : ''}</p></div>
  <div class="form section"><h2>Settings</h2>
    <label class="toggle" style="display:flex"><input type="checkbox" id="ssimple"${S.settings.simple ? ' checked' : ''}> Simple mode: just search, results and steps (also the button at the top)</label>
    <div class="grid2"><div class="field"><label for="skiwix">Offline library (Kiwix) address</label><input id="skiwix" placeholder="http://192.168.1.50:8090" value="${esc(S.settings.kiwixUrl || '')}"></div><div class="field"><label for="snomad">Project NOMAD address</label><input id="snomad" placeholder="http://192.168.1.50:8080" value="${esc(S.settings.nomadUrl || '')}"></div></div>
    <p class="hint" style="margin-top:4px">Links every record to Wikipedia, iFixit, the medical encyclopedia and NOMAD’s first-aid pages on the same box. Leave empty to use what your hub reports${(S.hub.info && S.hub.info.libraries && S.hub.info.libraries.kiwix) ? ` (now ${esc(S.hub.info.libraries.kiwix.url)})` : ''}.</p>
    <div class="actions" style="margin-top:4px"><button class="btn small ghost" id="slibs">Save addresses</button></div>
    <label class="toggle"><input type="checkbox" id="scomments"${S.settings.comments ? ' checked' : ''}> Show and store comments (turn off to save space)</label>
    <div class="grid2"><div class="field"><label for="sprec">Round field note locations to</label><select id="sprec"><option value="4"${S.settings.coordDecimals == 4 ? ' selected' : ''}>about 10 m</option><option value="3"${S.settings.coordDecimals == 3 ? ' selected' : ''}>about 100 m</option><option value="2"${S.settings.coordDecimals == 2 ? ' selected' : ''}>about 1 km</option></select></div>
    <div class="field"><label for="stheme">Theme</label><select id="stheme">${['auto', 'light', 'dark'].map(t => `<option${S.settings.theme === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div></div>
    <div class="actions"><button class="btn danger small" id="sreset">Reset this device</button></div>
    <div class="note">How the score works: each part gets a hidden-fruit score from how easy it is to extract, how common the device is, how overlooked it is and how many you get. Building scores multiply that by how likely each place holds the device and how much is probably left after looting, which is more for things people don’t recognise as valuable. Months since collapse ages batteries and fuel. Build ${esc(BUILD.version)}, ${esc(BUILD.date)}.</div></div>`;
}
function download(name, obj, type) {
  const blob = new Blob([typeof obj === 'string' || obj instanceof Uint8Array ? obj : JSON.stringify(obj)], { type: type || 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function readFile(file) {
  if (/\.gz$/i.test(file.name) && 'DecompressionStream' in window) return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return file.text();
}
async function importFile(file) {
  let parsed;
  try { parsed = SDG.changes.parseBundle(await readFile(file)); } catch (e) {
    try { const ident = JSON.parse(await readFile(file)); if (ident.jwk && ident.key) return toast('That’s a key file: restore it under Contributor key.'); } catch (x) { /* not JSON */ }
    return toast(e.message);
  }
  const msgs = [];
  if (parsed.release) {
    if (parsed.release.seq > S.base.seq || confirm(`This file holds data version ${parsed.release.seq}; you have ${S.base.seq}. Use it anyway?`)) {
      const keys = Object.values(S.settings.hubKeys || {});
      const v = await SDG.changes.verifyRelease(parsed.release, [...TRUST.map(k => k.key), ...keys]);
      if (!v.hashOk) msgs.push('The database in the file is damaged; not used.');
      else if (!v.trusted && !confirm('The database in this file isn’t signed by a key you trust. Use it anyway?')) msgs.push('Database not used.');
      else { await Sync.applyRelease(parsed.release, 'file: ' + file.name, { keys, untrustedOk: true, olderOk: true }); msgs.push(`Database updated to version ${parsed.release.seq}`); }
    }
  }
  if (parsed.ledger && parsed.ledger.length && parsed.ledger[0].seq <= S.base.seq + 1 && parsed.ledger[parsed.ledger.length - 1].seq > S.base.seq) {
    const cp = parsed.checkpoint;
    const trusted = cp && [...TRUST.map(k => k.key), ...Object.values(S.settings.hubKeys || {})].includes(cp.key) && await SDG.changes.verifyCheckpoint(cp);
    const ds = SDG.util.clone(S.base.dataset);
    let fits = !!trusted;
    try { const list = parsed.ledger.filter(e => e && e.seq > S.base.seq); list.forEach(Sync.checkEntry); SDG.changes.applyLedger(ds, list); } catch (e) { fits = false; }
    if (fits && cp.hash === await SDG.changes.datasetHash(ds)) { S.base = Object.assign({}, S.base, { dataset: ds, seq: cp.seq, hash: cp.hash, source: 'file: ' + file.name }); msgs.push(`${parsed.ledger.length} accepted changes applied`); }
    else msgs.push('The changes in the file couldn’t be verified, so they weren’t applied');
  }
  for (const k of ['proposals', 'comments', 'observations', 'votes']) {
    const v = await SDG.changes.verifyItems(parsed[k], k);
    if (k === 'comments') v.ok.forEach(addComment);
    if (k === 'votes') { mergeVotes(v.ok); retally(); }
    if (k === 'observations') v.ok.forEach(o => { if (!S.observations.some(x => x.id === o.id)) S.observations.push(o); });
    // Others' signed items ride along to the next hub; ours are already in our queue.
    const theirs = v.ok.filter(x => !S.identity || !x.author || x.author.key !== S.identity.key);
    S.carry[k] = SDG.changes.mergeById(S.carry[k], k === 'comments' ? theirs : k === 'observations' ? theirs.filter(o => o.share === 'public') : theirs);
    if (v.ok.length) msgs.push(`${v.ok.length} ${k}`);
    if (v.bad.length) msgs.push(`${v.bad.length} ${k} failed their signature check`);
  }
  await saveAll(); rebuild(); rerender();
  toast(msgs.join(', ') || 'Nothing new in that file');
}

// ---------- Review (moderators) ----------
async function renderReview(id) {
  const v = $('#v-review');
  if (!S.hub.online) { v.innerHTML = '<div class="form"><h2>Review</h2><p class="hint">Connect to the hub to review.</p></div>'; return; }
  v.innerHTML = '<div class="form"><p class="hint">Loading…</p></div>';
  try {
    const list = await Sync.api('/api/v1/proposals?status=pending&limit=300');
    const conflicts = await Sync.api('/api/v1/proposals?status=conflict&limit=100');
    const all = [...list, ...conflicts];
    const left = `<div class="catlist"><h4>Waiting (${esc(all.length)})</h4>${all.map(p => `<button class="cat" data-review="${esc(p.id)}" aria-current="${p.id === id}">${esc(p.op === 'delete' ? 'Delete ' : '')}${esc(p.coll)}/${esc(p.rid)}${p.source === 'ai' ? ' <span class="mark">AI</span>' : ''}${p.stale ? ' <span class="mark">stale</span>' : ''}<br><span class="where">${esc((p.author && p.author.name) || 'anonymous')}</span></button>`).join('') || '<p class="hint">Nothing waiting.</p>'}</div>`;
    let right = '<h2>Review</h2><p class="sub-h">Pick a proposal. Check it against the data guide: honest, specific, safe, original words.</p>';
    if (id) {
      const d = await Sync.api('/api/v1/proposals/' + encodeURIComponent(id));
      const p = d.proposal;
      right = `<h2>${esc(p.op === 'delete' ? 'Delete' : d.current ? 'Change' : 'New')} ${esc(p.coll)}/${esc(p.rid)}</h2><p class="sub-h">By ${esc((p.author && p.author.name) || 'anonymous')}${p.source === 'ai' ? ' · <b>written by an AI tool</b>' : ''} · ${esc(String(p.created).slice(0, 16).replace('T', ' '))}</p>
      <p><b>Why:</b> ${esc(p.reason || '(no reason given)')}</p>${d.stale ? '<p class="err">The record changed after this was proposed. Accepting replaces the newer version.</p>' : ''}${(d.problems || []).length ? `<p class="err">${d.problems.map(x => `${esc(x.coll)}/${esc(x.id)} ${esc(x.path)} ${esc(x.msg)}`).join('<br>')}</p>` : ''}
      <div class="diff">${(d.diff || []).map(x => `<div class="p">${esc(x.path)}</div>${x.before !== undefined ? `<div class="m">- ${esc(JSON.stringify(x.before))}</div>` : ''}${x.after !== undefined ? `<div class="a">+ ${esc(JSON.stringify(x.after))}</div>` : ''}`).join('') || '<p class="hint">No field changes.</p>'}</div>
      <div class="field"><label for="rnote">Note to the contributor</label><input id="rnote" maxlength="2000"></div>
      <div class="actions"><button class="btn ok" data-decide="accept" data-pid="${esc(p.id)}"${(d.problems || []).length ? ' disabled' : ''}>Accept</button><button class="btn danger" data-decide="reject" data-pid="${esc(p.id)}">Reject</button></div>`;
    }
    v.innerHTML = `<div class="browse${id ? ' has-detail' : ''}">${left}<div class="detail">${right}</div></div>`;
  } catch (e) { v.innerHTML = `<div class="form"><p class="err">${esc(e.message)}</p></div>`; }
}

// ---------- Routing and events ----------
const VIEWS = ['scrap', 'map', 'plan', 'guides', 'ref', 'browse', 'contribute', 'sync', 'review', 'more', 'simple'];
// On a phone these sit under More; its button shows as current while one is open.
const UNDER_MORE = ['browse', 'contribute', 'sync', 'review', 'more'];
function route() {
  const parts = (location.hash || '').slice(1).split('/').map(decodeURIComponent);
  let v = parts[0];
  document.body.classList.toggle('simple', !!S.settings.simple);
  $('#modebtn').textContent = S.settings.simple ? 'Full app' : 'Simple';
  if (S.settings.simple) {
    S.view = 'simple';
    VIEWS.forEach(x => { $('#v-' + x).hidden = x !== 'simple'; });
    Simple.render(v === 'simple' ? parts : ['simple']);
    return;
  }
  // Old addresses: the tech tree became guides, and Field (stash and notes) is part of Plan.
  if (v === 'tree') v = 'guides';
  if (v === 'field') { v = 'plan'; parts[1] = 'notes'; }
  if (!VIEWS.includes(v) || v === 'simple') v = 'scrap';
  S.view = v;
  VIEWS.forEach(x => { $('#v-' + x).hidden = x !== v; });
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === v || (b.dataset.tab === 'more' && UNDER_MORE.includes(v)) ? 'page' : 'false'));
  // On a phone, quick reference sits under Guides (its tab only shows on wide screens).
  document.querySelector('.tabs [data-tab="guides"]').classList.toggle('alsocur', v === 'ref');
  if (v === 'scrap') renderScrap();
  if (v === 'map') MapView.render($('#v-map'));
  if (v === 'guides') { if (parts[1]) gstate.build = false; renderGuides(parts[1]); }
  if (v === 'ref') renderRef(parts[1]);
  if (v === 'browse') renderBrowse(parts[1], parts[2]);
  if (v === 'contribute') renderContribute();
  if (v === 'plan') renderPlan(parts[1]);
  if (v === 'more') renderMore();
  if (v === 'sync') renderSync();
  if (v === 'review') renderReview(parts[1]);
}
// Redraws the current view without losing the reader's place. A redraw replaces the view, which
// otherwise jumps back to the top and resets the scrolled lists inside it.
function keepPlace(fn) {
  const y = window.scrollY, panes = [...document.querySelectorAll('.view:not([hidden]) .catlist')].map(p => p.scrollTop);
  fn();
  document.querySelectorAll('.view:not([hidden]) .catlist').forEach((p, i) => { if (panes[i]) p.scrollTop = panes[i]; });
  window.scrollTo(0, y);
}
// `changed === false` (a background sync that brought nothing new) only updates the badge.
function rerender(changed) {
  badge();
  if (changed === false && S.view !== 'sync') return;
  if (S.view !== 'review' && !document.activeElement?.matches('input,textarea,select')) keepPlace(route);
}
// What a sync can change on screen, to tell whether a redraw is needed.
function viewState() {
  return [S.base.seq, S.base.hash, S.edits.map(e => e.status).join(), S.outbox.comments.map(c => c.status).join(), S.outbox.votes.map(v => v.status).join(),
    Object.values(S.comments).reduce((n, l) => n + l.length, 0), S.observations.length, S.votes.length].join('|');
}
// A third part on a quick reference address names a heading on the card: #ref/<card>/<heading>, by
// the heading's slug or its data-jump name.
function jumpTo(slug) {
  const h = slug && [...$('#v-ref').querySelectorAll('h3,h4')].find(x => (x.dataset.jump || SDG.util.slug(x.textContent)) === slug);
  if (h) h.scrollIntoView();
  return !!h;
}
const hashPart = n => decodeURIComponent((location.hash || '').slice(1).split('/')[n] || '');
// Following a link closes any open card, such as a hazard card with links to guides.
window.addEventListener('hashchange', () => { closeModal(); route(); if (!(S.view === 'ref' && jumpTo(hashPart(2)))) window.scrollTo({ top: 0 }); });
document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) location.hash = b.dataset.tab; });
$('#netbadge').addEventListener('click', () => { if (S.settings.simple) setSimple(false); location.hash = 'sync'; });
async function setSimple(on) {
  S.settings.simple = !!on;
  await save('settings');
  if (location.hash.slice(1).split('/')[0] === (on ? 'simple' : 'scrap')) route(); else location.hash = on ? 'simple' : 'scrap';
}
$('#modebtn').addEventListener('click', () => setSimple(!S.settings.simple));

// A newer app on the hub: one tap to update, one tap to ignore that version for good. Offered only
// when a maintainer key (TRUST) signed that build (Sync checks, S.hub.appOk), and the download
// must match the signed sha256 before it is saved or loaded.
function updateBanner() {
  const bar = $('#updatebar');
  const a = S.hub.info && S.hub.info.app;
  const show = !!(a && a.id && S.hub.appOk === a.id && a.id !== BUILD.id && a.date >= BUILD.date && S.settings.skipApp !== a.id && !S.hideApp);
  bar.hidden = !show;
  if (show) bar.innerHTML = `<span>A newer version of the app (${esc(a.version)}, ${esc(a.date)}) is on the hub.</span><button class="btn small ok" id="appupdate">Update</button><button class="btn small ghost" id="appskip">Ignore this version</button><button class="btn small ghost" id="apphide">Not now</button>`;
}
$('#updatebar').addEventListener('click', async e => {
  const a = S.hub.info && S.hub.info.app;
  if (e.target.id === 'apphide') { S.hideApp = true; updateBanner(); }
  if (e.target.id === 'appskip') { S.settings.skipApp = a.id; await save('settings'); updateBanner(); toast('Ignoring that version. Newer ones will still show.'); }
  if (e.target.id === 'appupdate' && a && S.hub.appOk === a.id) {
    const hub = new URL(S.settings.hubUrl);
    try {
      const res = await fetch(S.settings.hubUrl.replace(/\/+$/, '') + '/', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await SDG.util.sha256hex(bytes)) !== a.sha256) throw new Error('it doesn’t match the signed fingerprint, so it wasn’t used');
      if (location.origin === hub.origin) { location.reload(); return; }
      download('scrappers-guide.html', bytes, 'text/html');
      toast('Saved the new app. Put it where the old file was; your edits and notes stay in this browser.');
    } catch (x) { toast('Couldn’t get the new app: ' + x.message); }
  }
});

let qt;
$('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => setQuery(e.target.value), 180); });
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter') setQuery(e.target.value); });
$('#go').addEventListener('click', () => setQuery($('#q').value));
$('#subs').addEventListener('change', async e => { S.settings.subs = e.target.checked; filterSummary(); SDG.search.applySubs(S.ctx, scrap.sel); if (!e.target.checked) [...scrap.sel].forEach(([k, v]) => { if (v.via === 'sub') scrap.sel.delete(k); }); await save('settings'); renderScrap(); });
$('#months').addEventListener('change', async e => { S.settings.months = e.target.value === '' ? null : Math.max(0, +e.target.value); filterSummary(); await save('settings'); renderScrap(); });
$('#maxkg').addEventListener('change', async e => { S.settings.maxKg = e.target.value === '' ? null : Math.max(0, +e.target.value); filterSummary(); await save('settings'); renderScrap(); });
$('#toolpick').addEventListener('click', async e => {
  const b = e.target.closest('[data-tool],[data-tools]');
  if (!b) return;
  if (b.dataset.tools) S.settings.tools = null;
  else { const t = new Set(S.settings.tools || []); t.has(b.dataset.tool) ? t.delete(b.dataset.tool) : t.add(b.dataset.tool); S.settings.tools = [...t]; }
  await save('settings'); renderToolPick(); renderScrap();
});
$('#chips').addEventListener('click', e => { const c = e.target.closest('[data-fn]'); if (!c) return; const v = scrap.sel.get(c.dataset.fn); if (v) { v.on = !v.on; if (v.via !== 'sub' && S.settings.subs) SDG.search.applySubs(S.ctx, scrap.sel); renderScrap(); } });

document.addEventListener('click', async e => {
  const t = e.target;
  const q = t.closest('[data-q]');
  if (q) { e.preventDefault(); if (q.hasAttribute('data-goscrap')) location.hash = 'scrap'; setTimeout(() => setQuery(q.dataset.q), 0); return; }
  const pick = t.closest('[data-pick]');
  if (pick) { const f = S.ctx.get('parts', pick.dataset.pick); scrap.q = f.name; $('#q').value = f.name; scrap.sel = new Map([[f.id, { via: 'direct', on: true }]]); if (S.settings.subs) SDG.search.applySubs(S.ctx, scrap.sel); renderScrap(); window.scrollTo({ top: 0 }); return; }
  const sf = t.closest('[data-scrapfor]');
  if (sf) { e.preventDefault(); const f = S.ctx.get('parts', sf.dataset.scrapfor); location.hash = 'scrap'; setTimeout(() => { scrap.q = f.name; $('#q').value = f.name; scrap.sel = new Map([[f.id, { via: 'direct', on: true }]]); renderScrap(); }, 0); return; }
  const open = t.closest('[data-open]');
  if (open) { location.hash = 'browse/' + open.dataset.open; return; }
  const g = t.closest('[data-guide]');
  if (g) { location.hash = 'guides/' + g.dataset.guide; return; }
  if (t.id === 'buildmode') { gstate.build = true; location.hash = 'guides'; renderGuides(); return; }
  if (t.closest('[data-print]')) { print(); return; }
  const ed = t.closest('[data-edit],[data-json]');
  if (ed) { const [coll, id] = (ed.dataset.edit || ed.dataset.json).split('/'); const raw = (S.ctx.ds[coll] || []).find(r => r.id === id); openEditor(coll, SDG.util.clone(raw), { json: !!ed.dataset.json }); return; }
  const nw = t.closest('[data-new]');
  if (nw) { openEditor(nw.dataset.new, null, { isNew: true }); return; }
  const va = t.closest('[data-variant]');
  if (va) { const p = S.ctx.get('devices', va.dataset.variant); openEditor('devices', { id: p.id + '_variant', name: p.name + ', new variant', variantOf: p.id, comps: [] }, { isNew: true }); return; }
  const lm = t.closest('[data-logmodel]');
  if (lm) { location.hash = 'contribute'; setTimeout(() => { $('#lcat').value = lm.dataset.logmodel; renderLogParts(); }, 0); return; }
  // The shopping list, from a part type, the parts a search switched on, or what a guide needs.
  const na = t.closest('[data-needadd]');
  if (na) { e.preventDefault(); await Runs.need(na.dataset.needadd, 1); navCounts(); toast('Added to your shopping list (Plan)'); return; }
  if (t.closest('[data-needsel]')) { e.preventDefault(); let n = 0; for (const [fn, v] of scrap.sel) if (v.on && await Runs.need(fn, 1)) n++; navCounts(); toast(`${n} part type${n === 1 ? '' : 's'} added to your shopping list (Plan)`); return; }
  const nm = t.closest('[data-needmiss]');
  if (nm) {
    e.preventDefault();
    const g = S.ctx.get('guides', nm.dataset.needmiss);
    const miss = (g.materials || []).filter(m => m.fn && !m.optional && !(S.inventory[m.fn] > 0));
    for (const m of miss) await Runs.need(m.fn, 1);
    navCounts();
    toast(`${miss.length} part type${miss.length === 1 ? '' : 's'} added to your shopping list (Plan)`);
    return;
  }
  const vb = t.closest('[data-vote]');
  if (vb) { await castVote(vb.dataset.vote, +vb.dataset.v); return; }
  const cm = t.closest('[data-comment]');
  if (cm) {
    const body = $('#cbody').value.trim();
    if (!body) return;
    try { const c = await SDG.changes.makeComment(cm.dataset.comment, body); S.outbox.comments.push({ item: c, status: 'queued' }); await save('outbox'); toast(S.settings.hubUrl ? 'Comment saved; it goes out with the next sync' : 'Comment saved on this device'); Sync.schedule(2500); keepPlace(route); } catch (x) { toast(x.message); }
    return;
  }
  if (t.id === 'lcat') return;
  if (t.id === 'addx') { addExtraRow(); return; }
  if (t.closest('[data-rmx]')) { t.closest('[data-extra]').remove(); return; }
  if (t.id === 'savem') { saveModel(); return; }
  const sh = t.closest('[data-share]');
  if (sh) { const x = S.edits.find(e2 => e2.id === sh.dataset.share); x.share = true; x.status = 'queued'; x.id = SDG.util.newId(); delete x.note; await save('edits'); renderContribute(); badge(); Sync.schedule(1500); return; }
  const di = t.closest('[data-discard]');
  if (di) { if (!confirm('Discard this change on this device?')) return; S.edits = S.edits.filter(x => x.id !== di.dataset.discard); await save('edits'); rebuild(); renderContribute(); badge(); return; }
  const strip = t.closest('[data-strip]') || (t.id === 'invstrip' ? { dataset: { strip: $('#invdev').value } } : null);
  if (strip) {
    const r = S.ctx.resolve(strip.dataset.strip);
    const got = {};
    r.comps.filter(x => !x.board).forEach(x => (got[x.fn] = (got[x.fn] || 0) + Math.max(1, Math.round(x.qty || 1))));
    Object.entries(got).forEach(([fn, n]) => (S.inventory[fn] = (S.inventory[fn] || 0) + n));
    await save('inventory');
    const ready = SDG.search.buildable(S.ctx, Object.keys(S.inventory)).filter(x => x.coverage === 1).length;
    toast(`Stripped ${r.name}: ${Object.keys(got).length} part types into your stash${ready ? ` · ${ready} build${ready > 1 ? 's' : ''} fully stocked` : ''}`);
    if (S.view === 'plan') keepPlace(route);
    navCounts();
    return;
  }
  if (t.id === 'invadd') { const fn = $('#invfn').value; S.inventory[fn] = (S.inventory[fn] || 0) + Math.max(1, +$('#invn').value || 1); await save('inventory'); keepPlace(route); return; }
  if (t.id === 'invclear') { if (!confirm('Empty your whole stash?')) return; S.inventory = {}; await save('inventory'); keepPlace(route); return; }
  const ir = t.closest('[data-invrm]');
  if (ir) { delete S.inventory[ir.dataset.invrm]; await save('inventory'); keepPlace(route); return; }
  if (t.id === 'tobuild') { gstate.build = true; return; }
  const mg = t.closest('[data-markgo]');
  if (mg) { MapView.editMark(mg.dataset.markgo); return; }
  if (t.id === 'markadd') { MapView.start('mark'); return; }
  if (t.closest('[data-introdone]')) { S.settings.introSeen = true; await save('settings'); renderScrap(); return; }
  if (t.closest('#moresimple')) { setSimple(true); return; }
  if (t.id === 'ogeo') {
    if (!navigator.geolocation) return toast('No location on this device');
    navigator.geolocation.getCurrentPosition(p => { S.pos = { lat: p.coords.latitude, lon: p.coords.longitude }; keepPlace(route); }, err => toast('Location: ' + err.message), { enableHighAccuracy: true, timeout: 20000 });
    return;
  }
  if (t.id === 'oadd') {
    try {
      const o = await SDG.changes.makeObservation({ lat: $('#olat').value, lon: $('#olon').value, status: $('#ostatus').value, building: $('#obld').value, share: $('#oshare').value, label: $('#olabel').value.trim(), notes: $('#onotes').value.trim() }, null, +S.settings.coordDecimals);
      o.mine = true;
      S.observations.push(o); await save('observations'); toast('Noted'); keepPlace(route); if (o.share === 'public') Sync.schedule(2500);
    } catch (x) { $('#oerr').textContent = x.message.replace('Observation: ', ''); }
    return;
  }
  const orm = t.closest('[data-obsrm]');
  if (orm) { S.observations = S.observations.filter(o => o.id !== orm.dataset.obsrm); await save('observations'); keepPlace(route); return; }
  if (t.id === 'ogeojson') { download('field-notes.geojson', { type: 'FeatureCollection', features: S.observations.map(o => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lon, o.lat] }, properties: { status: o.status, label: o.label, building: o.building, notes: o.notes, created: o.created, share: o.share } })) }, 'application/geo+json'); return; }
  if (t.id === 'hconnect') { const u = $('#hurl').value.trim().replace(/\/+$/, ''); if (!/^https?:\/\//.test(u)) return toast('The address starts with http:// or https://'); S.settings.hubUrl = u; await save('settings'); await Sync.run(true); renderSync(); return; }
  if (t.id === 'hforget') { if (!confirm('Forget this hub? Your data and edits stay on this device.')) return; const keys = Object.assign({}, S.settings.hubKeys); delete keys[S.settings.hubUrl]; S.settings.hubKeys = keys; S.settings.hubUrl = ''; S.hub.online = false; S.hub.me = null; await save('settings'); badge(); renderSync(); return; }
  if (t.id === 'idnew') { try { S.identity = await SDG.sign.createIdentity($('#idname').value.trim()); await save('identity'); toast('Key made. Back it up.'); renderSync(); Sync.schedule(1500); } catch (x) { toast(x.message); } return; }
  if (t.id === 'idexport') { download(`scrappers-guide-key-${(await SDG.sign.fingerprint(S.identity.key)).slice(0, 8)}.json`, S.identity); toast('Keep this file private'); return; }
  if (t.id === 'idrename') { const n = prompt('Name others will see', S.identity.name || ''); if (n != null) { S.identity.name = n.trim().slice(0, 60); await save('identity'); renderSync(); } return; }
  if (t.id === 'iddel') { if (!confirm('Remove your key from this device? Without a backup you can’t get it back.')) return; S.identity = null; await save('identity'); renderSync(); return; }
  if (t.id === 'fexport') {
    const bits = Sync.stampBits(S.hub.info, S.hub.me);
    const edits = S.edits.filter(e => e.share && ['queued', 'refused'].includes(e.status));
    if (!S.identity && (edits.length || S.outbox.comments.length)) toast('Without a contributor key these go unsigned; most hubs refuse unsigned items');
    const b = SDG.changes.makeBundle({
      from: (S.identity && S.identity.name) || 'app',
      proposals: [...await Promise.all(edits.map(e => Sync.finalize({ id: e.id, coll: e.coll, rid: e.rid, op: e.op, data: e.op === 'put' ? Object.assign({}, e.data, { id: e.rid }) : undefined, baseRev: e.baseRev, reason: e.reason, source: 'human', created: e.created }, bits))), ...S.carry.proposals],
      comments: [...await Promise.all(S.outbox.comments.filter(c => c.status === 'queued').map(c => Sync.finalize(c.item, bits))), ...S.carry.comments],
      observations: [...await Promise.all(S.observations.filter(o => o.mine && o.share !== 'private').map(o => Sync.finalize(SDG.sign.strip(o, 'mine', 'sent'), bits))), ...S.carry.observations],
      votes: [...await Promise.all(S.outbox.votes.filter(v => v.status === 'queued').map(v => Sync.finalize(v.item, bits))), ...S.carry.votes],
    });
    download(`scrappers-guide-bundle-${new Date().toISOString().slice(0, 10)}.json`, b); return;
  }
  if (t.id === 'frelease') { download(`scrappers-guide-data-v${S.base.seq}.json`, { format: 'sdg-release', schema: 3, name: S.base.name, seq: S.base.seq, created: S.base.created, hash: S.base.hash, sig: S.base.source === 'built in' ? RELEASE.sig : undefined, dataset: S.base.dataset }); toast('Share it with anyone: it’s verified against its hash on import'); return; }
  if (t.id === 'fbackup') { download(`scrappers-guide-backup-${new Date().toISOString().slice(0, 10)}.json`, { format: 'sdg-backup', created: SDG.util.now(), edits: S.edits, outbox: S.outbox, carry: S.carry, observations: S.observations, markers: S.markers, runs: S.runs, need: S.need, inventory: S.inventory, settings: S.settings }); return; }
  if (t.id === 'slibs') { const clean = v => v.trim().replace(/\/+$/, ''); S.settings.kiwixUrl = clean($('#skiwix').value); S.settings.nomadUrl = clean($('#snomad').value); await save('settings'); toast('Saved'); return; }
  if (t.id === 'sreset') { if (!confirm('Erase everything this app stored on this device (edits, notes, comments, key, synced data)? Export a backup first if you need it.')) return; for (const k of Object.values(KEYS)) await Store.del(k); location.reload(); return; }
  const dec = t.closest('[data-decide]');
  if (dec) {
    if (!S.identity) return toast('Make or restore your key first');
    try {
      const r = await Sync.api(`/api/v1/proposals/${encodeURIComponent(dec.dataset.pid)}/review`, { body: await SDG.sign.sign({ action: 'review', proposal: dec.dataset.pid, decision: dec.dataset.decide, note: $('#rnote').value.trim(), created: SDG.util.now() }, S.identity) });
      toast(`${r.status}${r.seq ? ' as change ' + r.seq : ''}`);
      await Sync.run(false);
      location.hash = 'review';
      renderReview();
    } catch (x) { toast(x.message); }
  }
  const rv = t.closest('[data-review]');
  if (rv) location.hash = 'review/' + rv.dataset.review;
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'lcat') renderLogParts();
  if (t.id === 'bc') { bstate.filter = ''; location.hash = 'browse/' + t.value; }
  if (t.id === 'gk') { gstate.kind = t.value; renderGuides(); }
  if (t.id === 'sauto') { S.settings.autoSync = t.checked; await save('settings'); Sync.schedule(); }
  if (t.id === 'ssimple') setSimple(t.checked);
  if (t.id === 'scomments') { S.settings.comments = t.checked; if (!t.checked) { S.comments = Object.create(null); await save('comments'); } await save('settings'); }
  if (t.id === 'sprec') { S.settings.coordDecimals = +t.value; await save('settings'); }
  if (t.id === 'stheme') { S.settings.theme = t.value; applyTheme(); await save('settings'); }
  if (t.id === 'fimport' && t.files[0]) importFile(t.files[0]);
  if (t.id === 'idimport' && t.files[0]) {
    try { const id = JSON.parse(await readFile(t.files[0])); if (!id.jwk || !id.key) throw new Error('Not a key file'); S.identity = id; await save('identity'); toast('Key restored'); renderSync(); } catch (x) { toast(x.message); }
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'bf') { bstate.filter = e.target.value; const pos = e.target.selectionStart; const parts = (location.hash || '').slice(1).split('/'); renderBrowse(bstate.coll, parts[2]); const f = $('#bf'); f.focus(); f.setSelectionRange(pos, pos); }
  if (e.target.id === 'gf') { gstate.filter = e.target.value; const pos = e.target.selectionStart; renderGuides(); const f = $('#gf'); f.focus(); f.setSelectionRange(pos, pos); }
});

(async () => {
  await load();
  // ?simple=1 or ?simple=0 in the address sets the mode, e.g. for a kiosk or a shared link.
  const sp = new URLSearchParams(location.search).get('simple');
  if (sp != null) { S.settings.simple = sp !== '0'; await save('settings'); }
  rebuild();
  $('#subs').checked = !!S.settings.subs;
  $('#months').value = S.settings.months == null ? '' : S.settings.months;
  $('#maxkg').value = S.settings.maxKg == null ? '' : S.settings.maxKg;
  renderToolPick();
  badge();
  navCounts();
  route();
  if (S.view === 'ref') jumpTo(hashPart(2));
  Store.persist();
  if (await Sync.detect()) badge();
  if (S.settings.hubUrl && S.settings.autoSync) Sync.schedule(800);
})();

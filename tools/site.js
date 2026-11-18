#!/usr/bin/env node
// Builds the website: a page for every device, logged model, part type, guide, hazard, job,
// building type and board pinout, made from the data, plus the app itself and the printable field
// guide. Plain HTML and one stylesheet: no scripts and nothing loaded from elsewhere, so pages open
// fast on a bad connection, can be saved whole, and search engines read them as they are. The pages
// are how people find the guide: someone asking what is inside a microwave lands on the microwave.
// The one exception is the visit counter, added only when given a GoatCounter code (see COUNTER).
//   node tools/site.js [--out dist/site] [--base https://crymoarz.github.io/scrappers-guide/] [--counter code]
// Run tools/export-text.js first to include the field guide. The Website workflow
// (.github/workflows/pages.yml) runs both on every push to main and publishes with GitHub Pages.
'use strict';
const fs = require('fs');
const path = require('path');
const SDG = require('../core');
const F = require('../lib/fsdata');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const OUT = path.resolve(opt('out') || path.join(F.ROOT, 'dist', 'site'));
const BASE = (opt('base') || 'https://crymoarz.github.io/scrappers-guide/').replace(/\/?$/, '/');
const REPO = 'https://github.com/CryMoarz/scrappers-guide';
const SITE = 'Scrapper’s Guide';
// Visit counting, only on the project's own site: the Website workflow passes the code, so a fork's
// copy counts nothing. GoatCounter keeps no cookies and nothing that identifies a visitor. Its script
// is a fixed version checked against its hash, so a changed copy never runs; the async load doesn't
// hold up the page. Visitors without scripts are counted by its image instead. The app copy at app/
// is the signed release, byte for byte, and never counts anything.
const COUNTER = opt('counter') || '';
if (COUNTER && !/^[a-z0-9-]+$/.test(COUNTER)) { console.error('--counter takes a GoatCounter code: lowercase letters, digits and dashes'); process.exit(1); }
const COUNT_URL = `https://${COUNTER}.goatcounter.com/count`;
const COUNT_JS = 'https://gc.zgo.at/count.v5.js';
const COUNT_SRI = 'sha384-atnOLvQb9t+jTSipvd75X2yginT4PjVbqDdlJAmxMm+wYElFmeR6EmLP5bYeoRVQ';
const CSP = COUNTER
  ? `default-src 'none'; img-src 'self' ${COUNT_URL}; style-src 'self' 'unsafe-inline'; script-src ${COUNT_JS}; connect-src ${COUNT_URL}; base-uri 'none'; form-action 'none'`
  : `default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
// The script counts the canonical address; the image is given the same path and the title.
const counter = (at, title) => (COUNTER ? `<script data-goatcounter="${COUNT_URL}" async src="${COUNT_JS}" crossorigin="anonymous" integrity="${COUNT_SRI}"></script>
<noscript><img class="count" src="${COUNT_URL}?p=${encodeURIComponent(new URL(BASE).pathname + at)}&amp;t=${esc(encodeURIComponent(title))}" alt="" width="1" height="1"></noscript>
` : '');

const data = F.load();
const ctx = SDG.db.open(F.plain(data));
const ds = ctx.ds;
const VERSION = require('../package.json').version;
const BUILT = new Date().toISOString().slice(0, 10);
// The app's own Markdown renderer (it escapes everything first) and pinout drawings, so a page says
// exactly what the app says.
const src = f => fs.readFileSync(path.join(F.ROOT, 'app', 'src', f), 'utf8');
const { MD, Pinouts } = new Function(`${src('md.js')}\n${src('pinouts.js')}\n${src('pinboards.js')}\nreturn { MD, Pinouts };`)();
const esc = MD.esc;
const KIND = SDG.text.KIND;
// The printable field guide, made by tools/export-text.js: copied in and linked when it has been made.
const BOOK = path.join(F.ROOT, 'dist', 'field-guide.html');
const HAS_BOOK = fs.existsSync(BOOK);

// ---- What gets a page ----
const live = r => !r.deprecated && !r.abstract;
const COLLS = {
  devices: { title: 'Devices', recs: ds.devices.filter(live), name: r => r.name },
  models: { title: 'Logged models', recs: ds.models.filter(live), name: r => ctx.modelName(r) },
  parts: { title: 'Part types', recs: ds.parts.filter(live), name: r => r.name },
  guides: { title: 'Guides and cards', recs: ds.guides.filter(live), name: r => r.title },
  hazards: { title: 'Hazards', recs: ds.hazards.filter(live), name: r => r.label },
  jobs: { title: 'Jobs', recs: ds.jobs.filter(live), name: r => r.name },
  buildings: { title: 'Building types', recs: ds.buildings.filter(live), name: r => r.name },
  pinouts: { title: 'Board pinouts', recs: Pinouts.boards, name: r => r.name },
};
const IDS = new Map(Object.entries(COLLS).map(([c, C]) => [c, new Set(C.recs.map(r => r.id))]));
const has = (coll, id) => !!(IDS.get(coll) && IDS.get(coll).has(id));
// Where each record opens in the app, which has the search, map, calculators and offline use.
const appHash = (coll, r) => (coll === 'pinouts' ? `ref/pinouts/${r.id}` : coll === 'guides' ? (r.kind === 'reference' ? `ref/${r.id}` : `guides/${r.id}`) : `browse/${coll}/${r.id}`);

// ---- Links ----
// Record Markdown names other records through a link hook. The app's renderer only links web
// addresses and in-app #routes, so site links go out on a placeholder host and are made relative
// once rendered; links written into guide notes as app routes are pointed at the matching page.
const HOLD = 'https://site.invalid/';
const link = (coll, id, text) => (has(coll, id) ? `[${String(text).replace(/[[\]]/g, '')}](${HOLD}${coll}/${id}/)` : text);
function routeToPage(hash) {
  const [a, b, c] = hash.split('/');
  if (a === 'guides' && has('guides', b)) return `guides/${b}/`;
  if (a === 'ref' && b === 'pinouts') return has('pinouts', c) ? `pinouts/${c}/` : 'pinouts/';
  if (a === 'ref' && has('guides', b)) return `guides/${b}/`;
  if (a === 'browse' && has(b, c)) return `${b}/${c}/`;
  return `app/#${hash}`;
}
const HOLD_RE = new RegExp(`href="${HOLD.replace(/[.]/g, '\\.')}([^"]*)" target="_blank" rel="noopener noreferrer"`, 'g');
// Bare web addresses in text (a model's sources) become links; text already inside a link is left be.
function autolink(html) {
  let inA = 0;
  return html.split(/(<[^>]+>)/).map(part => {
    if (part.startsWith('<')) { if (/^<a[\s>]/i.test(part)) inA++; else if (/^<\/a>/i.test(part)) inA = Math.max(0, inA - 1); return part; }
    return inA ? part : part.replace(/\bhttps?:\/\/[^\s<"]*[^\s<".,;:)]/g, u => `<a href="${u}" rel="noopener nofollow">${u}</a>`);
  }).join('');
}
const fixLinks = (html, rel) => autolink(html.replace(HOLD_RE, (m, p) => `href="${rel}${p}"`).replace(/href="#([^"]*)"/g, (m, h) => `href="${rel}${routeToPage(h)}"`));

// ---- Page shell ----
const clip = (s, n = 158) => { s = SDG.text.plain(s); return s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n - 1)).replace(/[,;:.\s]+$/, '') + '…'; };
const files = [];
function write(rel, text) { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); files.push(rel); }
const nav = rel => `<header class="top"><div class="wrap"><a class="brand" href="${rel || './'}"><img src="${rel}icon.svg" alt="" width="28" height="28">${SITE}</a>
<nav aria-label="Sections"><a href="${rel}devices/">Devices</a><a href="${rel}parts/">Parts</a><a href="${rel}guides/">Guides</a><a href="${rel}pinouts/">Pinouts</a><a href="${rel}hazards/">Hazards</a><a class="btn" href="${rel}app/">Open the app</a></nav></div></header>`;
const footer = rel => `<footer class="wrap"><p><b>Salvage can kill.</b> Read the <a href="${rel}hazards/">hazards</a> before you open anything, and treat guides as a starting point, not a procedure: see <a href="${rel || './'}#trust">how much to trust it</a>.</p>
<p>Data and guides <a href="${REPO}/blob/main/DATA-LICENSE.md">CC BY-SA 4.0</a> · code <a href="${REPO}/blob/main/LICENSE">MIT</a> · version ${esc(VERSION)}, data ${esc(data.meta.seq)}, built ${BUILT} · <a href="${REPO}">Source on GitHub</a> · <a href="${REPO}/issues/new/choose">Report a mistake</a>${HAS_BOOK ? ` · <a href="${rel}field-guide.html">Printable field guide</a>` : ''}${COUNTER ? ' · Visits are counted with <a href="https://www.goatcounter.com/help/privacy" rel="noopener nofollow">GoatCounter</a>: no cookies, and nothing that identifies you is kept' : ''}</p></footer>`;
function page({ at, title, desc, body, crumbs, type }) {
  const rel = '../'.repeat(at.split('/').filter(Boolean).length);
  const url = BASE + at;
  const trail = crumbs ? `<nav class="crumbs" aria-label="Breadcrumb"><a href="${rel || './'}">Home</a>${crumbs.map(([t, p]) => ` › <a href="${rel}${p}">${esc(t)}</a>`).join('')}</nav>` : '';
  write(at + 'index.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${type || 'article'}">
<meta property="og:site_name" content="${SITE}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${BASE}img/social.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#1B2A35">
<link rel="icon" href="${rel}icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${rel}site.css">
</head>
<body>
${nav(rel)}
<main class="wrap">${trail}
${fixLinks(body, rel)}
</main>
${footer(rel)}
${counter(at, title)}</body>
</html>
`);
}
const openIn = (coll, r) => `<a class="btn" href="app/#${esc(appHash(coll, r))}">Open in the app</a>`;
const ul = (items, cls = 'list') => (items.length ? `<ul class="${cls}">${items.join('')}</ul>` : '');
const li = (coll, r, extra) => `<li><a href="${coll}/${r.id}/">${esc(COLLS[coll].name(r))}</a>${extra ? ` <span class="muted">${esc(extra)}</span>` : ''}</li>`;
const groupBy = (recs, key) => { const m = new Map(); recs.forEach(r => { const k = key(r) || 'Other'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return [...m].sort((a, b) => a[0].localeCompare(b[0])); };
const byName = coll => (a, b) => COLLS[coll].name(a).localeCompare(COLLS[coll].name(b));
// A record page links back up with "../../", so links built for the site root get that in front.
const up = html => html.replace(/href="(?!https?:|#|\.\.\/|mailto:)([^"]*)"/g, 'href="../../$1"');

// ---- Record pages ----
function recordMd(coll, r) { return MD.render(SDG.text.recordMarkdown(ctx, coll, r, link).replace(/^# .*\n+/, '')); }
const TITLES = {
  devices: r => [`${r.name}: what’s inside and what to salvage`, `${r.name} teardown: the parts worth stripping (${ctx.resolve(r.id).comps.slice(0, 6).map(c => (ctx.get('parts', c.fn) || { name: c.fn }).name.toLowerCase()).join(', ')}), where to find one, how long it takes and what can hurt you.`],
  models: r => [`${ctx.modelName(r)}: teardown parts and sources`, `What was documented inside the ${ctx.modelName(r)}${r.years ? ` (${r.years})` : ''}: ${(r.comps || []).filter(c => !c.absent).slice(0, 5).map(c => SDG.text.plain(c.spec || '').split(/[,;(]/)[0]).filter(Boolean).join(', ')}, from service manuals, parts lists and teardowns.`],
  parts: r => [`${r.name}: where to find and salvage one`, r.summary || 'Which devices hide one and where to look for them.'],
  guides: r => [r.title, r.summary],
  hazards: r => [`${r.label}: hazard, protection and first aid`, r.summary],
  jobs: r => [r.name, r.summary],
  buildings: r => [`${r.name}: what to salvage inside`, r.notes || 'What this kind of building holds that is worth salvaging.'],
  pinouts: r => [`${r.name} pinout`, `${r.name} pinout: ${r.chip}, ${r.logic} logic. Every pin drawn as the board is held, with the boot, strapping and power pins that can stop it working marked.`],
};
function extras(coll, r) {
  if (coll === 'guides') {
    const devs = (r.devices || []).filter(id => has('devices', id)).map(id => li('devices', ctx.get('devices', id)));
    const parts = (r.parts || []).filter(id => has('parts', id)).map(id => li('parts', ctx.get('parts', id)));
    const srcs = (r.sources || []).filter(s => s && s.url).map(s => `<li>${esc(s.title || s.url)}: ${esc(s.url)}</li>`);
    return `${devs.length ? `<h2>Devices it covers</h2>${ul(devs)}` : ''}${parts.length ? `<h2>Parts it uses or yields</h2>${ul(parts)}` : ''}${srcs.length ? `<h2>Sources</h2><ul>${srcs.join('')}</ul>` : ''}`;
  }
  if (coll === 'devices') {
    const inGuides = ds.guides.filter(live).filter(g => (g.notes || '').includes(r.id) && !(g.devices || []).includes(r.id));
    return inGuides.length ? `<h2>Also mentioned in</h2>${ul(inGuides.map(g => li('guides', g)))}` : '';
  }
  return '';
}
function recordPage(coll, r) {
  const [title, desc] = TITLES[coll](r);
  const name = COLLS[coll].name(r);
  let body, sub = '';
  if (coll === 'pinouts') {
    body = `${Pinouts.legend()}${Pinouts.boardHTML(r).replace(/<h3[^>]*>.*?<\/h3>/, '').replace('<details>', '<details open>')}`;
    sub = `<p class="lede">Check against the printing on your own board: clones vary. Pins marked ⚠ can stop the board booting or damage it if wired wrong.</p>`;
  } else {
    body = recordMd(coll, r) + up(extras(coll, r));
    if (coll === 'devices') sub = `<p class="lede">${esc(ctx.resolve(r.id).group || '')}${r.aliases && r.aliases.length ? ` · also called ${esc(r.aliases.join(', '))}` : ''}</p>`;
    if (coll === 'guides') sub = `<p class="lede">${esc(KIND[r.kind] || r.kind)}${r.tree && ds.vocab.eras ? ` · era ${r.tree.era}: ${esc(ds.vocab.eras[r.tree.era - 1] || '')}` : ''}</p>`;
  }
  page({
    at: `${coll}/${r.id}/`, title: `${title} · ${SITE}`, desc: clip(desc || name),
    crumbs: [[COLLS[coll].title, `${coll}/`]],
    body: `<h1>${esc(name)}</h1>${sub}<div class="actions">${up(openIn(coll, r))}</div>${body}`,
  });
}

// ---- Index pages ----
const INTRO = {
  devices: 'Everyday devices and appliances, and what most units of each kind contain. Each is a template: an informed guess of what is usually inside, checked against the logged models of real products.',
  models: 'Real products whose insides were documented from service manuals, parts lists, FCC filings and teardowns, each claim with its source. Router and access point models imported from the OpenWrt hardware table are listed as likely until checked.',
  parts: 'The kinds of parts worth salvaging, what they are good for, how to recognise and test them, and which devices hide the best ones.',
  guides: 'Teardowns, builds, repairs, skills and safety, plus the quick-reference cards. Careful and conservative, but not reviewed by people who do this work for a living: a starting point, not a procedure.',
  hazards: 'What can hurt you in salvage work: how to spot it, what to wear, what to do and not do, and first aid if it goes wrong. Most dangerous first.',
  jobs: 'Things you may need to get done, the part types each needs, and the guides that show how.',
  buildings: 'Kinds of buildings, what they are likely to hold, and how picked over they will be.',
  pinouts: 'Pin maps of microcontroller boards you are likely to find or carry, drawn from the makers’ datasheets, with the pins that bite marked.',
};
function indexPage(coll, body) {
  const C = COLLS[coll];
  page({ at: `${coll}/`, title: `${C.title} · ${SITE}`, desc: clip(INTRO[coll]), crumbs: [], type: 'website', body: `<h1>${esc(C.title)}</h1><p class="lede">${esc(INTRO[coll])}</p>${body}` });
}
const rel1 = html => html.replace(/href="(?!https?:|#|\.\.\/|mailto:)([^"]*)"/g, 'href="../$1"');
function indexes() {
  indexPage('devices', groupBy(COLLS.devices.recs, r => ctx.resolve(r.id).group).map(([g, recs]) => `<h2>${esc(g)}</h2>${rel1(ul(recs.sort(byName('devices')).map(r => li('devices', r, (ctx.modelsByDevice.get(r.id) || []).length ? `${ctx.modelsByDevice.get(r.id).length} logged` : ''))))}`).join(''));
  indexPage('models', groupBy(COLLS.models.recs, r => (ctx.get('devices', r.device) || { name: r.device }).name).map(([g, recs]) => `<h2>${esc(g)}</h2>${rel1(ul(recs.sort(byName('models')).map(r => li('models', r, r.years || ''))))}`).join(''));
  indexPage('parts', groupBy(COLLS.parts.recs, r => r.group).map(([g, recs]) => `<h2>${esc(g)}</h2>${rel1(ul(recs.sort(byName('parts')).map(r => li('parts', r))))}`).join(''));
  const order = ['teardown', 'build', 'repair', 'skill', 'test', 'safety', 'reference'];
  indexPage('guides', order.map(k => [k, COLLS.guides.recs.filter(g => g.kind === k)]).filter(([, l]) => l.length).map(([k, recs]) => `<h2>${esc(k === 'reference' ? 'Quick-reference cards' : (KIND[k] || k) + 's')}</h2>${rel1(ul(recs.sort(byName('guides')).map(r => li('guides', r))))}`).join(''));
  indexPage('hazards', rel1(ul(COLLS.hazards.recs.slice().sort((a, b) => b.severity - a.severity || a.label.localeCompare(b.label)).map(r => li('hazards', r, `severity ${r.severity}/5`)))));
  indexPage('jobs', rel1(ul(COLLS.jobs.recs.slice().sort(byName('jobs')).map(r => li('jobs', r)))));
  indexPage('buildings', rel1(ul(COLLS.buildings.recs.slice().sort(byName('buildings')).map(r => li('buildings', r, `looting pressure ${r.exposure}/5`)))));
  indexPage('pinouts', `${Pinouts.legend()}${[['Boards', b => !b.clone], ['Clones and knock-offs', b => b.clone]].map(([t, f]) => [t, COLLS.pinouts.recs.filter(f)]).filter(([, l]) => l.length).map(([t, l]) => `<h2>${t}</h2>${rel1(ul(l.slice().sort(byName('pinouts')).map(r => li('pinouts', r, r.chip.split(' (')[0]))))}`).join('')}`);
}

// ---- Front page ----
function home() {
  const n = c => COLLS[c].recs.length;
  const documented = COLLS.models.recs.filter(m => m.research && m.research.checked).length;
  const card = (p, t, s) => `<li><a href="${p}"><b>${t}</b><span>${s}</span></a></li>`;
  const shot = (f, alt, cap) => `<figure><img src="img/${f}" alt="${esc(alt)}" loading="lazy"><figcaption>${cap}</figcaption></figure>`;
  page({
    at: '', type: 'website',
    title: `${SITE}: what to salvage from everyday devices, offline`,
    desc: 'A free, offline salvage and survival guide: what is inside everyday devices, which parts are worth stripping, where to find them and how to get them out safely. One HTML file for any phone.',
    body: `<div class="hero"><img src="img/banner.svg" alt="Scrapper’s Digital Guide to the Apocalypse: I need this part. What should I strip, and where should I look?" width="1200" height="300"></div>
<p class="lede big">A free salvage and survival guide that works with no internet: what is inside everyday devices and appliances, which parts are worth stripping, where to find them, and how to get them out safely.</p>
<div class="actions"><a class="btn" href="app/">Open the app</a><a class="btn ghost" href="scrappers-guide.html" download>Download it (one file)</a><a class="btn ghost" href="${REPO}#built-for-project-nomad">Run it on a Project NOMAD box</a></div>
<p>Type a part (“12V motor”), a chip number (“LM2596”), a need (“keep food cold”) or a device (“microwave”). The guide ranks the devices that hide it by how useful, easy to get and overlooked they are, tells you which kinds of buildings probably still have them, warns you what can hurt you, and shows you how to get the part out and what to build with it.</p>
<p>The app is a single HTML file. Open it once, save it to your phone or a USB stick, and it keeps working when the network doesn’t. Everything on this site is in it.</p>
<h2>Browse the guide</h2>
<ul class="cards">
${card('devices/', `${n('devices')} devices`, 'What is inside them and what to strip')}
${card('parts/', `${n('parts')} part types`, 'What they are for and where the good ones hide')}
${card('models/', `${n('models')} logged models`, `Real products, ${documented} documented from sources`)}
${card('guides/', `${n('guides')} guides and cards`, 'Teardowns, builds, repairs, skills, safety')}
${card('pinouts/', `${n('pinouts')} board pinouts`, 'ESP32, Arduino, Raspberry Pi and more')}
${card('hazards/', `${n('hazards')} hazards`, 'What can hurt you, and first aid')}
${card('jobs/', `${n('jobs')} jobs`, 'Pump water, keep food cold, make light')}
${card('buildings/', `${n('buildings')} building types`, 'Where to look, and how picked over')}
</ul>
<h2>What it looks like</h2>
<div class="shots">
${shot('search.png', 'Search results for pumping water from a creek', 'Ask for what you need; it ranks the devices that hide it.')}
${shot('device.png', 'A device page for an e-scooter on a phone', 'Every device: the parts inside, where they sit, how hard to get out.')}
${shot('pinout.png', 'An ESP32 board pinout', 'Board pinouts with the pins that bite marked.')}
${shot('map.png', 'An offline map of places to look', 'With a hub or Project NOMAD: an offline map of where to look.')}
</div>
<h2>Runs anywhere, offline</h2>
<ul>
<li><b>On a phone or laptop:</b> the one-file app, with nothing to install. It keeps your notes on the device.</li>
<li><b>On a Project NOMAD box:</b> an add-on that uses NOMAD’s offline maps and libraries, for a household or a neighbourhood.</li>
<li><b>As a hub:</b> a small Node server (no dependencies) that shares the guide and people’s finds over a local network, and syncs with other hubs when it can.</li>
<li><b>Over LoRa:</b> a bridge that answers questions over a Meshtastic radio mesh, for when there is no network at all.</li>
</ul>
<h2 id="trust">How much to trust it</h2>
<div class="note"><p>This is a personal, open-source project, built by one person together with Claude, an AI model. Device templates are informed guesses of what most units contain. Logged models are documented from public sources, claim by claim, with each claim checked against its source by a second AI pass; nobody has yet confirmed them by hand. Guides are careful and conservative but have not been reviewed by people who do this work: treat high-voltage, pressure, heavy-machinery and vehicle guides as a starting point, not a procedure.</p>
<p>Salvage, disassembly and the builds described here involve serious risks, including electric shock, fire, explosion, toxic exposure, injury and death. Use it only on property you own or have permission to work on, and within the law. It is provided as is, without warranty: see the <a href="${REPO}#disclaimer">full disclaimer</a>.</p></div>
<h2>Help make it better</h2>
<p>If you have opened one of these devices, done the work a guide describes, or spotted a mistake, please say so: <a href="${REPO}/issues/new/choose">report a mistake or suggest something</a>, or log a model you opened from the app’s Contribute tab. The data is CC BY-SA 4.0 and the code is MIT, on <a href="${REPO}">GitHub</a>.</p>`,
  });
}

// ---- Everything else ----
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1B2A35"/><path d="M32 9 57 53H7Z" fill="#E5AE17"/><path d="M32 21v15" stroke="#231C05" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="45" r="3.5" fill="#231C05"/></svg>\n`;
const CSS = `:root{color-scheme:light;--bg:#ECEEE9;--surface:#F7F8F5;--surface2:#E3E6E0;--ink:#1B2A35;--muted:#55626A;--line:#B6BDB5;--hazard:#E5AE17;--hazard-ink:#231C05;--link:#1F5FA8;--head:#1B2A35;--head-ink:#E9EDE7}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#162027;--surface:#1E2A32;--surface2:#24323B;--ink:#E1E6E0;--muted:#97A3AA;--line:#33434D;--link:#7FB2EE;--head:#0F171D}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}
a{color:var(--link)}
img{max-width:100%;height:auto}
.wrap{max-width:62rem;margin:0 auto;padding-left:16px;padding-right:16px}
.top{background:var(--head);color:var(--head-ink);border-bottom:4px solid var(--hazard)}
.top .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;padding-top:10px;padding-bottom:10px}
.brand{display:flex;align-items:center;gap:8px;color:var(--hazard);font-weight:800;font-size:1.1rem;text-decoration:none}
.top nav{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-left:auto}
.top nav a{color:var(--head-ink);font-weight:600;font-size:.95rem;text-decoration:none}
.top nav a:hover{text-decoration:underline}
.top nav .btn{padding:5px 12px;color:var(--hazard-ink)}
main{padding-top:18px;padding-bottom:36px}
h1{font-size:2rem;line-height:1.2;margin:.25em 0 .2em}
h2{font-size:1.35rem;line-height:1.3;margin:1.6em 0 .45em}
h3{font-size:1.1rem;margin:1.3em 0 .3em}
h4{font-size:1rem;margin:1.1em 0 .3em}
.crumbs{font-size:.9rem;color:var(--muted)}
.crumbs a{color:var(--muted)}
.lede{color:var(--muted);font-size:1.05rem;margin:.2em 0 .6em}
.lede.big{font-size:1.2rem;color:var(--ink)}
.muted{color:var(--muted);font-size:.92rem}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 18px}
.btn{display:inline-block;padding:9px 16px;border-radius:8px;background:var(--hazard);color:var(--hazard-ink);font-weight:700;text-decoration:none;border:2px solid var(--hazard)}
.btn:hover{filter:brightness(1.06)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.tbl{overflow-x:auto;margin:.6em 0}
table{border-collapse:collapse;width:100%;font-size:.92rem;background:var(--surface)}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
th{background:var(--surface2)}
pre{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px}
code{font-size:.92em}
blockquote{margin:1em 0;padding:8px 14px;border-left:4px solid var(--line);background:var(--surface)}
.note{background:var(--surface);border-left:4px solid var(--hazard);border-radius:4px;padding:4px 16px}
.list{columns:2 17rem;column-gap:28px;padding-left:1.2em}
.list li{break-inside:avoid;margin:3px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(13.5rem,1fr));gap:10px;list-style:none;padding:0}
.cards a{display:block;height:100%;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:var(--ink);text-decoration:none}
.cards a:hover{border-color:var(--hazard)}
.cards b{display:block;font-size:1.08rem;color:var(--link)}
.cards span{color:var(--muted);font-size:.92rem}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:12px}
.shots figure{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px}
.shots img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;object-position:top;border-radius:6px;background:var(--surface2)}
.shots figcaption{color:var(--muted);font-size:.9rem;padding:6px 2px 0}
.hero img{display:block;width:100%;border-radius:10px}
details summary{cursor:pointer;font-weight:600;margin:.8em 0}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:.88rem;padding-top:6px;padding-bottom:28px}
footer a{color:var(--muted)}
.pinout{width:100%;max-width:440px;display:block;margin:8px auto;font:600 10.5px/1 system-ui,sans-serif}
.pinout .pin-body{fill:var(--surface2);stroke:var(--line);stroke-width:1.5}
.pinout .pin-lead{stroke:var(--muted);stroke-width:1}
.pinout .pin-pad{fill:#C9A227;stroke:#8D6E16;stroke-width:.8}
.pinout .pin-top,.pinout .pin-chip{fill:var(--muted);font-weight:700;letter-spacing:.04em}
.pin-legend{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
.pin-legend span{font-size:.75rem;font-weight:600;padding:1px 8px;border-radius:999px}
.pintable td:first-child{font-weight:600;white-space:nowrap}
.pinboard h4{margin-top:.6em}
@media (max-width:640px){h1{font-size:1.6rem}.top nav{margin-left:0}}
img.count{position:absolute}
`;

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  write('site.css', CSS);
  write('icon.svg', ICON);
  for (const f of ['banner.svg', 'search.png', 'device.png', 'pinout.png', 'map.png', 'social.png']) { fs.mkdirSync(path.join(OUT, 'img'), { recursive: true }); fs.copyFileSync(path.join(F.ROOT, 'docs', 'img', f), path.join(OUT, 'img', f)); }
  // The app as released (the signed build in the repo): to open here, and as a file to keep.
  const app = fs.readFileSync(path.join(F.ROOT, 'app', 'scrappers-guide.html'));
  write('app/index.html', app);
  write('scrappers-guide.html', app);
  if (HAS_BOOK) write('field-guide.html', fs.readFileSync(BOOK));
  else console.warn('No dist/field-guide.html: run tools/export-text.js first to include the printable field guide.');
  home();
  for (const [coll, C] of Object.entries(COLLS)) C.recs.forEach(r => recordPage(coll, r));
  indexes();
  // A missing page: links from the site root, since this one answers for any address. The counter's
  // script counts the address asked for; its image would count the front page, so that goes.
  const root = new URL(BASE).pathname;
  write('404.html', fs.readFileSync(path.join(OUT, 'index.html'), 'utf8').replace(/<noscript>[\s\S]*?<\/noscript>\n/, '')
    .replace(/<main class="wrap">[\s\S]*<\/main>/, `<main class="wrap"><h1>No such page</h1><p class="lede">It may have been renamed. Try the <a href="./">front page</a>, or search everything in <a href="app/">the app</a>.</p></main>`)
    .replace(/<title>[^<]*<\/title>/, `<title>No such page · ${SITE}</title>`).replace(/<link rel="canonical"[^>]*>\n/, '').replace(/(href|src)="(?!https?:|#|\/)([^"]*)"/g, (m, a, p) => `${a}="${root}${p}"`));
  const pages = files.filter(f => f.endsWith('index.html') && !f.startsWith('app/')).map(f => BASE + f.replace(/index\.html$/, ''));
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(u => `<url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`);
  const size = files.reduce((t, f) => t + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(`Wrote ${pages.length} pages to ${path.relative(process.cwd(), OUT) || '.'} (${(size / 1048576).toFixed(1)} MB with the app and images), for ${BASE}`);
}
main();

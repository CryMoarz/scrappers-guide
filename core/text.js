// Guides as plain text: Markdown for exports, AI tools and printing, and a flat list of steps
// for linear readers (the LoRa bot, tiny screens).
module.exports = function (SDG) {
  const KIND = { skill: 'Skill', build: 'Build', teardown: 'Teardown', repair: 'Repair', test: 'Field test', safety: 'Safety', reference: 'Reference' };
  const plain = md => String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s*\|.*\|\s*$/gm, ' ').replace(/[#*_`>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  const list = (title, a) => (a && a.length ? `\n**${title}**\n\n${a.map(x => `- ${x}`).join('\n')}\n` : '');

  // `link(coll, id, text)` turns a mention of another record into a Markdown link: the website
  // passes one. Without it names stay plain text, as exports and AI tools want them.
  const plainName = (coll, id, text) => text;
  function guideMarkdown(ctx, g, level, link = plainName) {
    const h = '#'.repeat(level || 1);
    const hz = (g.hazards || []).map(x => { const c = ctx.hazard(x); return `${link('hazards', x, c.label)} (${c.severity}/5)`; }).join(', ');
    const mats = (g.materials || []).map(m => `${m.item}${m.qty ? ` (${m.qty})` : ''}${m.optional ? ', optional' : ''}`);
    const body = `\n**Steps**\n\n${(g.steps || []).map((s, i) => `${i + 1}. ${s.text}${s.warn ? `\n   **⚠ ${s.warn}**` : ''}`).join('\n')}\n`;
    return `${h} ${g.title}\n\n*${KIND[g.kind] || g.kind} · difficulty ${g.difficulty}/5${g.mins ? ` · about ${g.mins >= 120 ? Math.round(g.mins / 60) + ' hours' : g.mins + ' min'}` : ''}*\n\n${g.summary}\n${(g.tools || []).length ? `\n**Tools:** ${g.tools.map(ctx.toolLabel).join(', ')}\n` : ''}${hz ? `\n**Hazards:** ${hz}\n` : ''}${list('Materials', mats)}${body}\n${g.notes || ''}\n\n*License: ${g.license || 'CC-BY-SA-4.0'}*\n`;
  }

  const guideSteps = g => g.steps || [];

  // Any record as Markdown: for exports, printing, and AI knowledge bases (NOMAD's among them).
  const nameOf = r => r.name || r.title || r.label || r.id;
  function recordMarkdown(ctx, coll, r, link = plainName) {
    const ds = ctx.ds;
    const pname = id => link('parts', id, nameOf(ctx.get('parts', id) || { id }));
    const hz = ids => (ids || []).map(h => `${link('hazards', h, ctx.hazard(h).label)} (${ctx.hazard(h).severity}/5)`).join(', ');
    if (coll === 'devices') {
      const d = ctx.resolve(r.id);
      const rows = d.comps.map(c => `| ${pname(c.fn)} | ${c.spec}${c.qty > 1 ? ` ×${c.qty}` : ''} | ${c.loc || ''}${c.board ? ` (on ${c.board})` : ''} | ${c.ext} | ${c.obs} | ${SDG.db.CONF[ctx.confInfo(r.id, c.key).conf].label} |`);
      const places = (d.buildings || []).map(b => `${link('buildings', b.b, nameOf(ctx.get('buildings', b.b) || { id: b.b }))} ${b.l}/5`).join(', ');
      const guides = ds.guides.filter(g => (g.devices || []).includes(r.id)).map(g => `${KIND[g.kind]}: ${link('guides', g.id, g.title)}`);
      const models = (ctx.modelsByDevice.get(r.id) || []).map(m => `${link('models', m.id, ctx.modelName(m))}${m.years ? ` (${m.years})` : ''}`);
      return `# ${d.name} (generic)\n\n${SDG.db.GENERIC_NOTE}\n\n${[d.parentName && `Variant of ${d.parentName}.`, d.era, (d.aliases || []).length && `Also called ${d.aliases.join(', ')}.`, (d.brands || []).length && `Common brands: ${d.brands.join(', ')}.`, d.notes].filter(Boolean).join(' ')}\n\nHow common ${d.prev}/5 · about ${d.mins} min · tools: ${(d.tools || []).map(ctx.toolLabel).join(', ')}${d.kg ? ` · about ${d.kg} kg` : ''}${(d.hazards || []).length ? `\n\n**Hazards:** ${hz(d.hazards)}` : ''}\n\n| Part | Spec | Where | Difficulty | Overlooked | Confidence |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n**Found in:** ${places}\n${list('Guides', guides)}${list('Logged models', models)}`;
    }
    if (coll === 'models') {
      const research = res => (res && (res.checked || (res.gaps || []).length || (res.method || []).length) ? `\n## How this was researched\n\n${res.checked ? `Fact-checked against its sources on ${res.checked}. ` : ''}Difficulty and overlooked ratings are editorial.\n${list('Left out or unclear', res.gaps || [])}${list('How the sources were read', res.method || [])}` : '');
      const d = ctx.resolve(r.device);
      const tpl = key => (d ? d.comps.find(c => c.key === key) : null) || {};
      const cell = s => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ');
      const rows = (r.comps || []).map(c => `| ${cell(pname(c.fn || tpl(c.key).fn || c.key))} | ${cell(c.absent ? 'Not present in this model' : c.spec || tpl(c.key).spec)}${c.qty > 1 ? ` ×${c.qty}` : ''} | ${cell(c.loc || '')} | ${c.absent ? 'Absent' : SDG.db.CONF[c.conf] ? SDG.db.CONF[c.conf].label : 'Likely'} |`);
      const srcs = (r.sources || []).map(s => `${s.title}${s.url ? `: ${s.url}` : ''}`);
      return `# ${ctx.modelName(r)}\n\nLogged model of ${d ? link('devices', r.device, d.name) : r.device}.${r.years ? ` Years: ${r.years}.` : ''}${r.fcc ? ` FCC/ISED id: ${r.fcc}.` : ''} ${r.notes || ''}\n\n| Part | What was found | Where | Confidence |\n|---|---|---|---|\n${rows.join('\n')}\n${list('Sources', srcs)}${research(r.research)}`;
    }
    if (coll === 'parts') {
      const ranked = SDG.search.rank(ctx, new Map([[r.id, { via: 'direct', on: true }]]), '', {});
      return `# ${r.name}\n\n${r.summary || ''}\n\nGroup: ${r.group} · demand ${r.demand}/5 · search words: ${(r.keywords || []).join(', ')}\n${list('Good for', r.uses)}${r.identify ? `\n**How to recognise it:** ${r.identify}\n` : ''}${r.test ? `\n**How to test it:** ${r.test}\n` : ''}${r.decay ? `\n**Shelf life:** ${r.decay.halfLifeMonths ? `about half unusable after ${r.decay.halfLifeMonths} months` : 'lasts indefinitely'}. ${r.decay.note || ''}\n` : ''}${(r.protects || []).length ? `\n**Protects against:** ${hz(r.protects)}\n` : ''}${r.improvise ? `\n**Without one:** ${r.improvise}\n` : ''}${list('Where it’s kept', (r.buildings || []).slice().sort((x, y) => y.l - x.l).filter(x => ctx.get('buildings', x.b)).map(x => `${link('buildings', x.b, ctx.get('buildings', x.b).name)}${x.loc ? `: ${x.loc}` : ''} (${x.l}/5)`))}${(r.hazards || []).length ? `\n**Hazards:** ${hz(r.hazards)}\n` : ''}${(r.substitutes || []).length ? `\n**Substitutes:** ${r.substitutes.map(pname).join(', ')}\n` : ''}${list('Best sources (score)', ranked.res.slice(0, 12).map(x => `${link('devices', x.cat.id, x.cat.name)}: ${x.best.comp.spec} (${Math.round(x.best.s)})`))}${list('Where to look', ranked.blds.slice(0, 6).map(a => `${link('buildings', a.bt.id, a.bt.name)}: ${SDG.search.leftLabel(a.remain).toLowerCase()}`))}`;
    }
    if (coll === 'guides') return guideMarkdown(ctx, r, 1, link);
    if (coll === 'hazards') return `# ${r.label}\n\nSeverity ${r.severity}/5. ${r.summary}\n${list('How to spot it', r.signs)}${list('Do', r.do)}${list('Don’t', r.dont)}${list('Protection', r.ppe)}${list('Gear', ds.parts.filter(p => !p.deprecated && (p.protects || []).includes(r.id)).map(p => link('parts', p.id, p.name)))}${list('If it goes wrong', r.firstAid)}`;
    if (coll === 'jobs') return `# ${r.name}\n\n${r.summary}\n${list('Part types', r.parts.map(p => `${pname(p.fn)}${p.why ? `: ${p.why}` : ''}`))}${list('Tips', r.tips)}${list('Guides', (r.guides || []).map(g => link('guides', g, nameOf(ctx.get('guides', g) || { id: g }))))}`;
    if (coll === 'buildings') {
      const devs = ds.devices.filter(d => !d.abstract).map(d => ctx.resolve(d.id)).map(d => ({ d, l: ((d.buildings || []).find(x => x.b === r.id) || {}).l })).filter(x => x.l).sort((a, c) => c.l - a.l);
      return `# ${r.name}\n\nLooting pressure ${r.exposure}/5. ${r.notes || ''}${r.access ? `\n\nGetting in: ${r.access}` : ''}${(r.hazards || []).length ? `\n\n**Hazards:** ${hz(r.hazards)}` : ''}\n\nMap tags: ${r.osm.join(', ')}\n${list('What’s inside', devs.map(x => `${link('devices', x.d.id, x.d.name)} (${x.l}/5)`))}${list('Supplies kept here', ds.parts.filter(p => !p.deprecated).map(p => ({ p, s: (p.buildings || []).find(x => x.b === r.id) })).filter(x => x.s).sort((x, y) => y.s.l - x.s.l).map(x => `${link('parts', x.p.id, x.p.name)}${x.s.loc ? `: ${x.s.loc}` : ''} (${x.s.l}/5)`))}`;
    }
    return `# ${nameOf(r)}\n`;
  }

  // The whole guide as one document per collection, the shape AI knowledge bases take best.
  const KB_TITLES = { devices: 'Devices and what is inside them', parts: 'Part types and where to find them', guides: 'Guides: teardowns, builds, repairs and skills', hazards: 'Hazards and first aid', jobs: 'Jobs: how to get things done', buildings: 'Building types and what they hold', models: 'Real models and what was documented inside them' };
  function knowledgeDocs(ctx) {
    return Object.entries(KB_TITLES).map(([coll, title]) => {
      const recs = (coll === 'devices' ? ctx.ds.devices.filter(d => !d.abstract) : ctx.ds[coll] || []).slice().sort((a, b) => a.id.localeCompare(b.id));
      return recs.length && { coll, name: `scrappers-guide-${coll}.md`, text: `# Scrapper’s Digital Guide: ${title}\n\nFrom the Scrapper’s Digital Guide to the Apocalypse (data CC BY-SA 4.0). Template data is a best guess unless marked documented or verified.\n\n` + recs.map(r => recordMarkdown(ctx, coll, r)).join('\n\n---\n\n') };
    }).filter(Boolean);
  }

  // ---- Cross-references into offline libraries (Kiwix: Wikipedia, iFixit, medical, Q&A...) ----
  // Curated `refs` on a record come first; every record also gets sensible links by its name.
  const DEFAULT_LIBS = { devices: ['ifixit', 'wikipedia'], models: ['ifixit'], parts: ['wikipedia'], boards: ['electronics'], hazards: ['wikimed', 'milmed', 'wikipedia'], guides: ['wikihow', 'diy', 'wikipedia'], jobs: ['wikihow', 'diy', 'wikipedia'], buildings: [] };
  const ELECTRONIC = ['Electronic components', 'Signal and control', 'Power conversion'];
  const BRANCH_LIBS = {
    fire: ['food_lib', 'appropedia'], water: ['water_lib', 'appropedia', 'post_disaster', 'cd3wd'], shelter: ['outdoors', 'appropedia', 'post_disaster'],
    salvage: ['ifixit'], power: ['energypedia', 'electronics', 'cd3wd', 'lowtech'], signal: ['ham', 'electronics'],
    machines: ['mechanics', 'survivorlibrary', 'cd3wd'], fabrication: ['survivorlibrary', 'woodworking', 'cd3wd'],
  };
  function lookups(ctx, coll, rec) {
    const libs = (ctx.ds.vocab && ctx.ds.vocab.libraries) || {};
    const name = coll === 'models' ? [rec.brand, rec.model].filter(Boolean).join(' ') : String(rec.name || rec.title || rec.label || rec.id).replace(/\s*\(.*?\)\s*/g, ' ').split(/,|:|\s+or\s+/)[0].trim();
    const out = [], seen = new Set();
    const add = (lib, q, path, note) => { if (!libs[lib] || seen.has(lib + '|' + (path || q))) return; seen.add(lib + '|' + (path || q)); out.push({ lib, label: libs[lib].name, q: q || name, path, note }); };
    (rec.refs || []).forEach(r => add(r.lib, r.q, r.path, r.note));
    const defaults = (DEFAULT_LIBS[coll] || []).slice();
    if (coll === 'parts' && ELECTRONIC.includes(rec.group)) defaults.push('electronics');
    // Guides also point at the libraries that cover their branch.
    if (coll === 'guides' && rec.tree && BRANCH_LIBS[rec.tree.branch]) defaults.push(...BRANCH_LIBS[rec.tree.branch]);
    if (coll === 'guides' && rec.kind === 'safety') defaults.push('readygov');
    if (coll === 'jobs') defaults.push('appropedia');
    // A model is looked up, by its own name, in the libraries its device points to.
    if (coll === 'models') { const d = ctx.get('devices', rec.device); ((d && d.refs) || []).forEach(r => defaults.push(r.lib)); }
    defaults.forEach(lib => { if (!out.some(o => o.lib === lib)) add(lib, name); });
    return out;
  }
  // A link for a lookup. `env` says where the libraries are: { kiwix: {url, books}, nomad: {url} }.
  // Without the hub's matched `books`, a Kiwix link searches every installed book of the right
  // category; NOMAD pages need an exact `path`. Addresses come from hubs and settings, so only
  // plain web bases are used, and a page path may not climb out of its book (. or .. segments).
  const web = u => (typeof u === 'string' && /^https?:\/\/[^/\s]/i.test(u) ? u.replace(/\/+$/, '') : null);
  const pagePath = p => { const segs = String(p).split('/'); return segs.some(x => !x || x === '.' || x === '..') ? null : segs.map(encodeURIComponent).join('/'); };
  function libraryUrl(env, lookup, libs) {
    const L = (libs && Object.prototype.hasOwnProperty.call(libs, lookup.lib) && libs[lookup.lib]) || {};
    const enc = encodeURIComponent;
    if (L.nomad) {
      const base = env && env.nomad && web(env.nomad.url), page = lookup.path && pagePath(lookup.path);
      return base && page && /^\/[^/]/.test(L.nomad) ? base + L.nomad.replace('{path}', page) : null;
    }
    const kiwix = env && env.kiwix;
    const base = kiwix && web(kiwix.url);
    if (!base) return null;
    const book = kiwix.books && Object.prototype.hasOwnProperty.call(kiwix.books, lookup.lib) && kiwix.books[lookup.lib];
    if (book && lookup.path) { const page = pagePath(lookup.path); return page ? `${base}/content/${enc(book)}/${page}` : null; }
    if (book) return `${base}/search?books.name=${enc(book)}&pattern=${enc(lookup.q)}`;
    if (kiwix.books) return null; // the hub checked, and this library isn't installed
    if (!L.category) return null; // only findable once the hub has seen the book in the catalog
    return `${base}/search?books.filter.category=${enc(L.category)}&books.filter.lang=eng&pattern=${enc(lookup.q)}`;
  }
  // Where a cited web page sits in an installed offline library: the library, its book, and the
  // page's path in the book. A library's `web` names the sites it copies, what its copy puts before
  // the page path (a site crawl keeps the host) and what it drops (a wiki's "/wiki/"). Whether the
  // book really has the page is for the hub to check, since books are snapshots.
  function offlinePage(url, libs, books) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol) || u.search || !books) return null;
    const host = u.hostname.toLowerCase(), own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    for (const [lib, L] of Object.entries(libs || {})) {
      const w = L.web;
      if (!w || !(w.hosts || []).includes(host) || !own(books, lib)) continue;
      let p = u.pathname;
      if (w.strip) { if (!p.startsWith(w.strip)) continue; p = p.slice(w.strip.length); } else p = p.slice(1);
      if (!p || p.split('/').some(x => x === '.' || x === '..')) continue;
      return { lib, book: books[lib], page: (w.prefix || '') + p };
    }
    return null;
  }
  // Which installed book serves each library. `installed` is a Kiwix catalog as {name, book}:
  // patterns match the catalog name, links use the book's own (plain strings serve as both).
  function matchBooks(libs, installed) {
    const list = (installed || []).map(b => (typeof b === 'string' ? { name: b, book: b } : b));
    const books = {};
    Object.entries(libs || {}).forEach(([id, L]) => {
      for (const m of L.match || []) { const hit = list.filter(b => b.name.toLowerCase().includes(m.toLowerCase())).sort((a, b) => b.book.localeCompare(a.book))[0]; if (hit) { books[id] = hit.book; break; } }
    });
    return books;
  }

  SDG.text = { guideMarkdown, guideSteps, recordMarkdown, knowledgeDocs, plain, KIND, lookups, libraryUrl, offlinePage, matchBooks };
};

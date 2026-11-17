// Scrap search and hidden-fruit ranking. Deterministic: the same data and query always give
// the same answer, so an AI front end can translate requests but never invent results.
module.exports = function (SDG) {
  const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lc = s => String(s || '').toLowerCase();

  // Ratings written out ("12 volt", "100-watt") read as "12v" and "100w", and plurals as one
  // ("batteries" as "battery"), so they meet the keywords the way people also write them.
  const UNIT = { volt: 'v', volts: 'v', watt: 'w', watts: 'w', amp: 'a', amps: 'a', ampere: 'a', amperes: 'a' };
  function prep(q) {
    q = lc(q).trim().replace(/(\d+(?:\.\d+)?)[\s-]*(volts?|watts?|amps?|amperes?)\b/g, (m, n, u) => n + UNIT[u]);
    const q2 = q.split(/\s+/).map(w => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/s$/, '') : w)).join(' ');
    return { q, q2 };
  }
  // Length of the longest whole-phrase term found in the query, 0 if none.
  function phraseScore(p, termList) {
    let best = 0;
    termList.forEach(t => {
      if (!t) return;
      const re = new RegExp('(^|[^a-z0-9])' + reEsc(t) + '([^a-z0-9]|$)');
      if (re.test(p.q) || re.test(p.q2)) best = Math.max(best, t.length);
    });
    return best;
  }
  // How many words of the query the terms explain together ("lead acid" + "battery" beats
  // "battery" alone), so a part type that matches more of what was asked wins. Words, not letters:
  // "aa batteries" is two words, and the plural mustn't make "batteries" outweigh "aa battery".
  function coverScore(p, termList) {
    const hit = new Set();
    [p.q, p.q2].forEach(q => {
      const spans = [];
      for (const m of q.matchAll(/\S+/g)) spans.push([m.index, m.index + m[0].length]);
      termList.forEach(t => {
        if (!t) return;
        const m = new RegExp('(^|[^a-z0-9])' + reEsc(t) + '(?=[^a-z0-9]|$)').exec(q);
        if (!m) return;
        const a = m.index + m[1].length, b = a + t.length;
        spans.forEach(([s, e], i) => { if (s >= a && e <= b) hit.add(i); });
      });
    });
    return hit.size;
  }
  const live = list => list.filter(r => !r.deprecated);
  const partTerms = f => [lc(f.name), ...(f.keywords || []).map(lc)];
  const jobTerms = j => [lc(j.name), ...(j.keywords || []).map(lc)];

  // Part types matched by a query. Longer, more specific matches are switched on; weaker ones
  // come back off so the user can turn them on. Falls back to prefixes, then single words.
  function findParts(ctx, query, retry) {
    const p = prep(query);
    if (!p.q) return [];
    const parts = live(ctx.ds.parts);
    let hits = parts.map(f => ({ f, score: phraseScore(p, partTerms(f)), cover: coverScore(p, partTerms(f)) })).filter(h => h.score > 0);
    let fallback = false;
    if (!hits.length && p.q.length >= 3) {
      hits = parts.map(f => ({ f, score: partTerms(f).some(t => t.startsWith(p.q) || t.split(/\s+/).some(w => w.startsWith(p.q))) ? 1 : 0 })).filter(h => h.score);
      fallback = !!hits.length;
    }
    // Then single words, leaving out the ones every search here could say ("scrap", "salvage").
    if (!hits.length) {
      const toks = p.q.split(/[\s,]+/).filter(t => t.length >= 4 && !FILLER.has(t));
      hits = parts.map(f => ({ f, score: partTerms(f).some(t => toks.some(k => t.split(/\s+/).includes(k))) ? 1 : 0 })).filter(h => h.score);
      fallback = !!hits.length;
    }
    // Last, a typing slip: one letter wrong, missing, extra or swapped in a word of five or more
    // ("batery", "magents"), against the words of part names and keywords.
    // The corrected words are searched as if typed, so "batery" works like "battery".
    if (!hits.length && !retry) {
      const vocab = [...new Set(parts.flatMap(f => partTerms(f).flatMap(t => t.split(/\s+/))).filter(w => w.length >= 5))];
      let fixed = false;
      const q = p.q.split(/\s+/).map(t => { const w = t.length >= 5 && !FILLER.has(t) && !vocab.includes(t) && vocab.find(v => oneSlip(t, v)); if (w) fixed = true; return w || t; }).join(' ');
      if (fixed) return findParts(ctx, q, true).map(h => Object.assign(h, { fallback: true }));
    }
    const max = Math.max(0, ...hits.map(h => h.cover || h.score));
    return hits.map(h => ({ f: h.f, score: h.score, on: (h.cover || h.score) >= max * 0.75, fallback })).sort((a, b) => b.on - a.on || b.score - a.score);
  }

  const FILLER = new Set('scrap scraps scrapping salvage salvaged salvaging spare spares used old stuff thing things where find need want get'.split(' '));
  // True when a and b differ by one edit: a letter changed, added or dropped, or two neighbours swapped.
  function oneSlip(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }

  // Hazard cards a query names: by label, by id, or by words people use for them. Shown with the
  // results, since "asbestos" or "capacitor discharge" is a question about staying safe.
  const HAZARD_WORDS = {
    hv_cap: ['capacitor discharge', 'discharge capacitor', 'discharge a capacitor', 'charged capacitor', 'stored charge'],
    co_gas: ['carbon monoxide', 'co poisoning', 'generator indoors', 'exhaust fumes'],
    li_fire: ['lithium fire', 'battery fire', 'thermal runaway', 'swollen battery', 'puffy battery'],
    fiberglass: ['fiberglass', 'fibreglass', 'glass wool'],
    mold: ['mold', 'mould', 'damp'],
    pcb: ['pcb oil', 'pcbs', 'transformer oil'],
    radiation: ['radioactive', 'americium', 'radiation'],
    biohazard: ['sharps', 'needles', 'medical waste', 'biohazard'],
    hv: ['high voltage'],
    mains: ['electric shock', 'electrocution'],
    spring: ['garage door spring', 'spring under tension'],
    structural: ['collapse', 'unstable building', 'unsafe building'],
    acid: ['battery acid', 'sulphuric acid', 'sulfuric acid'],
    refrigerant: ['refrigerant', 'freon', 'r134a', 'r410a', 'r600a'],
    compressed_gas: ['compressed gas', 'gas cylinder explode'],
    implosion: ['crt implosion', 'picture tube'],
    lead: ['lead', 'lead poisoning', 'solder fumes'],
    mercury: ['mercury', 'broken cfl', 'broken fluorescent'],
  };
  // Cards named after everyday things ("Glass", "Spring") answer only a search for that thing
  // alone or with a safety word, not "magnifying glass" or "gas spring".
  const EVERYDAY = new Set(['glass', 'spring', 'heavy', 'fuel']);
  const SAFETY = /\b(danger|dangerous|hazard|hazards|safe|safety|toxic|poison|injury|hurt)\b/;
  function findHazards(ctx, query) {
    const p = prep(query);
    if (!p.q) return [];
    const alone = words(p.q).filter(w => !STOP.has(w)).length === 1 || SAFETY.test(p.q);
    return live(ctx.ds.hazards || []).filter(h => alone || !EVERYDAY.has(h.id)).map(h => ({ h, score: phraseScore(p, [lc(h.label), h.id.replace(/_/g, ' '), ...(HAZARD_WORDS[h.id] || [])]) }))
      .filter(x => x.score >= 4).sort((a, b) => b.score - a.score || b.h.severity - a.h.severity).map(x => x.h);
  }

  function findJobs(ctx, query) {
    const p = prep(query);
    if (!p.q) return [];
    return live(ctx.ds.jobs || []).map(j => ({ job: j, score: phraseScore(p, jobTerms(j)) })).filter(h => h.score > 0).sort((a, b) => b.score - a.score);
  }

  const squash = s => lc(s).replace(/[^a-z0-9]/g, '');
  const words = s => lc(s).split(/[^a-z0-9]+/).filter(Boolean);
  const stem = w => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/s$/, '') : w);
  // Every run of up to four neighbouring words, squashed, so "air sense 10", "AirSense10" and
  // "Black & Decker" / "black and decker" compare equal to how a brand or model writes itself.
  function runs(text, dropAnd) {
    const w = words(text).filter(x => !dropAnd || x !== 'and');
    const out = new Set();
    for (let i = 0; i < w.length; i++) for (let k = 1; k <= 4 && i + k <= w.length; k++) out.add(w.slice(i, i + k).join(''));
    w.forEach(x => out.add(stem(x)));
    return out;
  }
  const brandKey = b => squash(lc(b).replace(/\band\b/g, ' '));
  const STOP = new Set('a an and the of or in inside is what whats s for my from with to on model models part parts'.split(' '));

  // Words in device names too general to name a device on their own, however few devices use them.
  const GENERIC = new Set(('adjustable automated automatic behind board cover digital direct driven driver exit fast flat forced ' +
    'hand hard hybrid installation jump large lid lift lighting mains maker paper player range reader receiver register reverse ' +
    'riding self semi side sign signal sink sodium space stand standing system terminal travel trailer under underground unit ' +
    'vehicle walkway well window security sale fish motion clothe farm floor hood chair desk small home house machine equipment ' +
    'electric portable commercial power battery light with from other older modern type style part device tool kid cash point ' +
    'level display external central centre control controller moving road box mini wall filter').split(' ').map(stem));

  // Words in a device's name that no other kind of device uses in its names ("cpap" in "CPAP
  // machine", "microwave" for the microwave family), so a query with that word names the device, or
  // the family's parent. Words that also name a part type or a job don't count.
  // One-word names and keywords of part types and jobs ("tank", "petrol", "magnet").
  function partWords(ctx) {
    const vocab = new Set();
    [...live(ctx.ds.parts), ...live(ctx.ds.jobs || [])].forEach(r => [r.name, ...(r.keywords || [])].forEach(t => { const w = words(t); if (w.length === 1) vocab.add(stem(w[0])); }));
    return vocab;
  }
  function distinctWords(ctx) {
    const vocab = partWords(ctx);
    const by = new Map(), inName = new Set();
    live(ctx.ds.devices).forEach(d => [d.name, ...(d.aliases || [])].forEach((t, i) => words(t).map(stem).forEach(w => {
      if (w.length < 4 || /^\d+$/.test(w) || GENERIC.has(w) || vocab.has(w)) return;
      (by.get(w) || by.set(w, new Set()).get(w)).add(d.variantOf || d.id);
      if (!i) inName.add(w);
    })));
    return new Map([...by].filter(([w, ids]) => ids.size === 1 && inName.has(w)).map(([w, ids]) => [w, [...ids][0]]));
  }

  // The main noun of each part of a device's names: "drill" in "Cordless drill", "tv" in
  // "Flat-screen TV". A one-word search for it names every device it heads.
  function headWords(ctx) {
    const vocab = partWords(ctx), by = new Map();
    live(ctx.ds.devices).forEach(d => [...lc(d.name).split(/,|\(|\)|\/|\bor\b|\band\b/), ...(d.aliases || []).map(lc)].forEach(t => {
      const w = words(t).pop();
      if (!w || w.length < 2 || /^\d+$/.test(w) || STOP.has(w) || GENERIC.has(stem(w)) || vocab.has(stem(w))) return;
      (by.get(stem(w)) || by.set(stem(w), new Set()).get(stem(w))).add(d.id);
    }));
    return by;
  }

  // Brands named in the query and the kinds of device they make, from each device's `brands` and
  // from logged models ("ResMed" finds CPAP machines).
  function findBrands(ctx, query) {
    const q = new Set([...runs(query), ...runs(query, true)]);
    const found = new Map();
    const add = (b, id) => {
      const k = brandKey(b), d = ctx.get('devices', id);
      if (k.length < 2 || !q.has(k) || !d || d.deprecated) return;
      const e = found.get(k) || found.set(k, { brand: b, devices: new Set() }).get(k);
      e.devices.add(d);
    };
    live(ctx.ds.devices).forEach(d => (d.brands || []).forEach(b => add(b, d.id)));
    (ctx.ds.models || []).forEach(m => m.brand && add(m.brand, m.device));
    return [...found.values()].map(e => ({ brand: e.brand, devices: [...e.devices].sort((a, b) => (b.prev || 3) - (a.prev || 3) || a.name.localeCompare(b.name)) }))
      .sort((a, b) => b.brand.length - a.brand.length);
  }

  // Devices named in the query ("what's in a treadmill", "cpap", "honda generator").
  function findDevices(ctx, query) {
    const p = prep(query);
    if (!p.q) return [];
    const distinct = distinctWords(ctx), vocab = partWords(ctx);
    const qw = words(p.q).map(stem);
    const brands = findBrands(ctx, query);
    const branded = new Set(brands.flatMap(b => b.devices.map(d => d.id)));
    // One word besides any brand ("tv", "dewalt drill"): every device that word heads.
    const brandWords = new Set(brands.flatMap(b => words(b.brand).map(stem)));
    const core = qw.filter(w => !STOP.has(w) && !brandWords.has(w));
    const heads = core.length === 1 ? headWords(ctx).get(core[0]) : null;
    // Two words or more that end a device's name name it too: "air conditioner" is the window,
    // central and rooftop kinds alike.
    const tail = core.length >= 2 ? core.join(' ') : null;
    return live(ctx.ds.devices).map(d => {
      // "String trimmer or brush cutter (petrol)" also answers to "string trimmer" and "brush cutter".
      const pieces = lc(d.name).split(/,|\(|\)|\/|\bor\b|\band\b/).map(s => s.trim()).filter(s => s.length >= 4 && !(/^[a-z]+$/.test(s) && (GENERIC.has(stem(s)) || vocab.has(stem(s)))));
      const names = [lc(d.name), ...(d.aliases || []).map(lc), ...pieces, ...pieces.map(s => s.replace(/s$/, ''))];
      let score = phraseScore(p, names);
      qw.forEach(w => { if (distinct.get(w) === d.id) score = Math.max(score, w.length); });
      if (heads && heads.has(d.id)) score = Math.max(score, 4);
      if (tail && names.some(n => n === tail || n.endsWith(' ' + tail))) score = Math.max(score, tail.length);
      // A brand alone lists its devices separately; with a device name it ranks that brand's kind first.
      if (score && branded.has(d.id)) score += 2;
      return { d, score };
    }).filter(h => h.score >= 4).sort((a, b) => b.score - a.score || (ctx.resolve(b.d.id) || b.d).prev - (ctx.resolve(a.d.id) || a.d).prev);
  }

  // Logged models matching the query. Two ways in:
  // - a code: a chip ("BQ76930", "STM32F103"), a model number ("R-310HK") or an FCC id, in the
  //   model's name or its parts. Only words with both letters and digits count, so "12v motor" doesn't.
  // - names: every word is part of the brand, model name or the device's name ("AirSense 10",
  //   "resmed", "honda generator"), with the brand or a distinctive model word among them (so "air"
  //   alone isn't the MacBook Air); any word left over must pick out some of its parts ("macbook battery").
  // What a search needs from each model, worked out once per opened dataset rather than on every
  // query: a search looks at every model, and rebuilding these made long queries slow on a small hub.
  const MODEL_BITS = new WeakMap();
  function modelBits(ctx, m) {
    let all = MODEL_BITS.get(ctx);
    if (!all) MODEL_BITS.set(ctx, (all = new WeakMap()));
    let b = all.get(m);
    if (!b) {
      const dev = ctx.get('devices', m.device) || {};
      b = {
        brand: runs(m.brand || ''), own: runs([m.model, m.fcc].join(' ')),
        kind: runs([dev.name, ...(dev.aliases || [])].join(' ')), kindName: runs(dev.name || ''),
        name: squash([m.brand, m.model, m.fcc].join(' ')), specs: (m.comps || []).map(x => squash(x.spec)),
      };
      all.set(m, b);
    }
    return b;
  }
  function nameHit(ctx, m, qt, vocab) {
    const { brand, own, kind, kindName } = modelBits(ctx, m);
    const left = [];
    let mine = 0, sure = false;
    for (let i = 0; i < qt.length;) {
      let k = Math.min(4, qt.length - i);
      for (; k >= 1; k--) {
        const run = qt.slice(i, i + k).join('');
        const st = k === 1 ? stem(run) : run;
        // A word in the device's own name ("bike", "generator") never vouches for a model; a product
        // line kept as another name ("airsense" for CPAP machines) still can.
        const generic = kindName.has(run) || kindName.has(st) || GENERIC.has(st);
        if (brand.has(run) || brand.has(st)) { mine += k; sure = sure || !generic; break; }
        if (own.has(run) || own.has(st)) { mine += k; sure = sure || (!generic && (/\d/.test(run) || (run.length >= 5 && !vocab.has(st)))); break; }
        if (kind.has(run) || kind.has(st)) break;
      }
      if (k < 1) { left.push(qt[i]); i++; } else i += k;
    }
    if (!sure) return null;
    const comps = (m.comps || []).filter(x => !x.absent);
    const text = x => lc([x.spec, x.key, x.fn, (ctx.get('parts', x.fn) || {}).name].join(' '));
    if (left.some(w => w.length < 3 || /^\d+$/.test(w) || !comps.some(x => text(x).includes(stem(w))))) return null;
    return { mine, parts: left.length ? comps.filter(x => left.some(w => text(x).includes(stem(w)))) : [] };
  }
  function findModels(ctx, query) {
    // A dozen words and a handful of codes say all a person searches for; more is only cost.
    const codes = lc(query).split(/[\s,]+/).map(squash).filter(t => t.length >= 4 && /[a-z]/.test(t) && /\d/.test(t) && !Object.keys(SDG.specs.parse(t)).length).slice(0, 8);
    const qt = words(query).filter(w => !STOP.has(w)).slice(0, 12);
    if (!codes.length && !qt.length) return [];
    const vocab = partWords(ctx);
    return (ctx.ds.models || []).map(m => {
      const bits = modelBits(ctx, m);
      const named = codes.some(c => bits.name.includes(c));
      const parts = (m.comps || []).filter((x, i) => !x.absent && codes.some(c => bits.specs[i].includes(c)));
      const byName = qt.length ? nameHit(ctx, m, qt, vocab) : null;
      if (byName) byName.parts.forEach(x => { if (!parts.includes(x)) parts.push(x); });
      return named || parts.length || byName ? { model: m, parts, named: named || !!byName, mine: byName ? byName.mine : 0 } : null;
    }).filter(Boolean).sort((a, b) => b.parts.length - a.parts.length || b.mine - a.mine || ctx.modelName(a.model).localeCompare(ctx.modelName(b.model)));
  }

  function findGuides(ctx, query, kind) {
    const p = prep(query);
    if (!p.q) return [];
    const toks = p.q2.split(/[\s,]+/).filter(t => t.length >= 3);
    return live(ctx.ds.guides || []).filter(g => !kind || g.kind === kind).map(g => {
      const hay = lc([g.title, ...(g.keywords || []), g.summary].join(' ')).replace(/[^a-z0-9]+/g, ' ');
      const phrase = phraseScore(p, [lc(g.title), ...(g.keywords || []).map(lc)]);
      const words = toks.filter(t => (' ' + hay + ' ').includes(' ' + t) ).length;
      const score = phrase ? 10 + phrase : toks.length ? (words / toks.length >= 0.5 ? words / toks.length : 0) : 0;
      return { g, score };
    }).filter(h => h.score > 0).sort((a, b) => b.score - a.score);
  }

  // Which part types a query switches on, and why: direct match, a job, or a substitute.
  function select(ctx, query, opts) {
    opts = opts || {};
    const sel = new Map();
    const jobs = findJobs(ctx, query);
    let parts = findParts(ctx, query);
    // A query that names a device ("string trimmer") is about that device, not about loose word matches.
    if (parts.length && parts.every(h => h.fallback) && findDevices(ctx, query).length) parts = [];
    const bestJob = jobs[0];
    const bestPart = Math.max(0, ...parts.filter(h => !h.fallback).map(h => h.score));
    if (bestJob && bestJob.score >= bestPart) {
      parts = parts.filter(h => !h.fallback);
      parts.forEach(h => sel.set(h.f.id, { via: 'direct', on: h.on && h.score >= bestJob.score }));
      const j = bestJob.job;
      const anyCore = j.parts.some(x => x.core);
      j.parts.forEach(x => {
        if (!ctx.get('parts', x.fn)) return;
        const on = anyCore ? !!x.core : true;
        const prev = sel.get(x.fn);
        sel.set(x.fn, { via: 'job', on: on || (prev && prev.on) || false, job: j.id, why: x.why, only: x.only && x.only.length ? x.only.map(lc) : undefined, need: x.need });
      });
    } else {
      parts.forEach(h => sel.set(h.f.id, { via: 'direct', on: h.on }));
    }
    if (opts.subs) applySubs(ctx, sel);
    return { sel, jobs, parts };
  }

  function applySubs(ctx, sel) {
    [...sel].forEach(([id, v]) => { if (v.via === 'sub') sel.delete(id); });
    [...sel].filter(([, v]) => v.via !== 'sub' && v.on).forEach(([id]) => {
      const f = ctx.get('parts', id);
      (f && f.substitutes || []).forEach(s => { if (!sel.has(s) && ctx.get('parts', s)) sel.set(s, { via: 'sub', on: true, of: id }); });
    });
    return sel;
  }

  // Words with digits that aren't ratings ("18650", "lm2596"): a spec mentioning one ranks a little higher.
  // Ratings ("12v", "100w") are compared as numbers instead, through SDG.specs.
  const specTokens = q => lc(q).split(/[\s,]+/).filter(t => /\d/.test(t) && t.length > 1 && !Object.keys(SDG.specs.parse(t)).length);
  // The other words of a query, for what they say about the part: "water" in "water tank",
  // "propane" in "propane tank", "deep cycle" in "deep cycle battery". A source whose spec says
  // them ranks higher. Words of the part type's own name ("tank") say nothing new, so they don't count.
  const specWords = q => [...new Set(words(prep(q).q2).filter(w => w.length >= 2 && !/\d/.test(w) && !STOP.has(w) && !FILLER.has(w)).map(stem))];
  const nameWords = new WeakMap();
  const ownWords = f => { if (!nameWords.has(f)) nameWords.set(f, new Set(words(String(f.name).split('(')[0]).map(stem))); return nameWords.get(f); };
  // A device the query names ("car battery", "treadmill motor", "laptop fan") is where the person
  // means to look, so its own part ranks first.
  // It's named when the rest of the query is its whole name ("car" in "car battery"), when its
  // name holds every word asked ("inverter for car"), or by a word few devices use ("fridge"):
  // a word in the names of six or more ("car", "air", "pump") doesn't pick one out by itself.
  const devWords = new WeakMap(), common = new WeakMap();
  const nameStems = t => words(t).map(stem).filter(w => !STOP.has(w));
  function deviceWords(ctx, d) {
    if (!common.has(ctx)) {
      const n = new Map();
      live(ctx.ds.devices).forEach(x => new Set([x.name, ...(x.aliases || [])].flatMap(nameStems)).forEach(w => n.set(w, (n.get(w) || 0) + 1)));
      common.set(ctx, new Set([...n].filter(([, k]) => k >= 6).map(([w]) => w)));
    }
    if (!devWords.has(d)) {
      const all = new Set([d.name, ...(d.aliases || [])].flatMap(nameStems));
      devWords.set(d, { all, rare: new Set([...all].filter(w => w.length >= 3 && !GENERIC.has(w) && !common.get(ctx).has(w))), whole: new Set([...lc(d.name).split(/,|\(|\)|\/|\bor\b|\band\b/), ...(d.aliases || [])].map(t => nameStems(t).join(' ')).filter(Boolean)) });
    }
    return devWords.get(d);
  }
  function namesDevice(ctx, dev, part, qwords) {
    if (!qwords || !qwords.length) return false;
    const dw = deviceWords(ctx, dev), rest = qwords.filter(w => !(part && ownWords(part).has(w)));
    return (rest.length && dw.whole.has(rest.join(' '))) || (qwords.length >= 2 && qwords.every(w => dw.all.has(w))) || rest.some(w => dw.rare.has(w));
  }

  // How hard looters have worked an area `months` after the grid went down: none on day one (or
  // when no time is set), about half by three months, nearly all of it after a year.
  const lootRamp = months => (months == null ? 0 : 1 - Math.exp(-months / 4));
  // Share of a part looters have probably taken: wanted parts that people recognise go first,
  // overlooked ones stay (the hidden fruit).
  const takenShare = (ramp, fn, comp) => ramp * ((fn ? fn.demand || 1 : 1) / 5) * (1 - 0.75 * ((comp.obs || 3) - 1) / 4);

  // How much of a part type is still usable `months` after the grid went down.
  function decayFactor(ctx, fnId, months) {
    if (months == null) return 1;
    const f = ctx.get('parts', fnId);
    const h = f && f.decay && f.decay.halfLifeMonths;
    if (!h) return 1;
    return Math.max(0.1, Math.pow(0.5, months / h));
  }

  // The hidden-fruit score for one part in one device, 0-100. Multiplicative on purpose: a part
  // has to be decent on every axis to rank high.
  // `want` holds the ratings asked for ("12v" in the query, or a job's needs).
  function scoreComp(ctx, dev, comp, via, toks, opts, want, qwords) {
    opts = opts || {};
    const tools = dev.tools || [];
    const ease = Math.max(0.05, ((6 - comp.ext) / 5) * Math.max(0.45, 1 - (dev.mins || 0) / 300) *
      (tools.includes('heavy') ? 0.8 : 1) * (tools.includes('security_bits') ? 0.92 : 1) * (comp.board ? 0.85 : 1));
    const ci = ctx.confInfo(dev.id, comp.key);
    const prev = ((dev.prev || 3) / 5) * (comp.p == null ? 1 : comp.p) * ci.presence;
    const obs = (comp.obs || 3) / 5, qty = Math.min(1, 0.6 + 0.1 * (comp.qty || 1));
    const spec = lc(comp.spec), part = ctx.get('parts', comp.fn);
    const said = (qwords || []).filter(w => !(part && ownWords(part).has(w)) && new RegExp('\\b' + reEsc(w)).test(spec)).length;
    const named = namesDevice(ctx, dev, part, qwords);
    const boost = (toks.length && toks.some(t => spec.includes(t)) ? 1.15 : 1) * Math.min(1.3, Math.pow(1.15, said)) * (named ? 1.35 : 1);
    const fit = SDG.specs.fit(SDG.specs.ratings(comp), want);
    const decay = decayFactor(ctx, comp.fn, opts.months);
    const left = 1 - 0.9 * takenShare(lootRamp(opts.months), ctx.get('parts', comp.fn), comp);
    let missingTools = [];
    if (Array.isArray(opts.tools)) {
      const have = new Set(['hands', ...opts.tools]);
      missingTools = [...tools, ...(comp.board ? ['desolder'] : [])].filter(t => !have.has(t));
    }
    const toolF = Math.pow(0.6, missingTools.filter(t => t !== 'heavy').length) * (missingTools.includes('heavy') ? 0.5 : 1);
    const tooHeavy = opts.maxKg != null && comp.kg != null && comp.kg > opts.maxKg;
    const s = Math.min(100, 100 * Math.pow(ease, 0.35) * Math.pow(prev, 0.25) * Math.pow(obs, 0.25) * Math.pow(qty, 0.15) *
      SDG.db.CONF[ci.conf].f * (via === 'sub' ? 0.75 : 1) * boost * fit * decay * left * toolF * (tooHeavy ? 0.3 : 1));
    return { s, ease, prev, obs, ci, comp, via, fit, decay, left, missingTools, tooHeavy };
  }

  // Ranks devices for the switched-on part types, then building types by how much is likely left.
  function rank(ctx, sel, query, opts) {
    opts = opts || {};
    const on = new Map([...sel].filter(([, v]) => v.on));
    if (!on.size) return { res: [], blds: [] };
    const toks = specTokens(query || ''), qwords = specWords(query || '');
    const asked = SDG.specs.wanted(query || '');
    const wantFor = fn => { const need = on.get(fn).need; return need ? Object.assign({}, need, asked) : asked; };
    const res = [];
    ctx.ds.devices.forEach(c => {
      if (c.abstract || c.deprecated) return;
      const r = ctx.resolve(c.id);
      if (!r) return;
      // A job can narrow a broad part type to the entries that actually do the job.
      const fits = x => {
        const only = on.get(x.fn).only;
        if (!only) return true;
        const hay = lc([x.spec, x.notes, r.name, ...(r.aliases || [])].join(' '));
        return only.some(w => hay.includes(w));
      };
      const hits = r.comps.filter(x => on.has(x.fn) && fits(x)).map(x => scoreComp(ctx, r, x, on.get(x.fn).via, toks, opts, wantFor(x.fn), qwords)).sort((a, b) => b.s - a.s);
      if (hits.length) res.push({ cat: r, hits, best: hits[0] });
    });
    res.sort((a, b) => b.best.s - a.best.s || a.cat.name.localeCompare(b.cat.name));
    const ramp = lootRamp(opts.months);
    const agg = {};
    res.forEach(r => (r.cat.buildings || []).forEach(({ b, l }) => {
      const bt = ctx.get('buildings', b);
      if (!bt || bt.deprecated) return;
      const h = r.best, fn = ctx.get('parts', h.comp.fn);
      const pressure = (bt.exposure / 5) * takenShare(ramp, fn, h.comp);
      const remain = 1 - 0.9 * pressure;
      const v = (h.s / 100) * (l / 5) * remain;
      const a = agg[b] || (agg[b] = { bt, v: 0, rs: 0, devices: [] });
      a.v += v; a.rs += remain * v; a.devices.push({ id: r.cat.id, n: r.cat.name, v });
    }));
    const blds = Object.values(agg).sort((a, b) => b.v - a.v);
    const max = blds.length ? blds[0].v : 1;
    blds.forEach(a => { a.n = 100 * a.v / max; a.remain = a.v ? a.rs / a.v : 0; a.devices.sort((x, y) => y.v - x.v); });
    return { res, blds };
  }

  const leftLabel = remain => (remain > 0.8 ? 'Plenty likely left' : remain > 0.55 ? 'Some likely left' : 'Probably picked over');

  // One call for everything a search screen, API or AI tool needs.
  function search(ctx, query, opts) {
    opts = opts || {};
    const s = opts.sel ? { sel: opts.sel, jobs: findJobs(ctx, query), parts: [] } : select(ctx, query, opts);
    if (opts.sel && opts.subs) applySubs(ctx, s.sel);
    const ranked = rank(ctx, s.sel, query, opts);
    // A job needs one of each of its parts, so also rank sources for each part on its own.
    const jobParts = [...s.sel].filter(([, v]) => v.on && v.via === 'job');
    const perPart = jobParts.map(([fn, v]) => ({ fn, why: v.why, res: rank(ctx, new Map([[fn, v]]), query, opts).res.slice(0, opts.perPart || 3) }));
    return {
      query, sel: s.sel, jobs: s.jobs.map(h => h.job), ranked, perPart,
      devices: findDevices(ctx, query).map(h => h.d),
      guides: findGuides(ctx, query).map(h => h.g),
      models: findModels(ctx, query),
      brands: findBrands(ctx, query),
      hazards: findHazards(ctx, query),
    };
  }

  // Plain JSON version of a search, for the API and AI tools.
  function summarize(ctx, out, limit) {
    limit = limit || 10;
    const r = out.ranked;
    return {
      query: out.query,
      partTypes: [...out.sel].map(([id, v]) => ({ id, name: (ctx.get('parts', id) || {}).name || id, on: v.on, via: v.via, job: v.job, why: v.why, substituteFor: v.of })),
      jobs: out.jobs.map(j => ({ id: j.id, name: j.name, summary: j.summary, guides: j.guides || [] })),
      perPart: (out.perPart || []).map(p => ({
        partType: p.fn, name: (ctx.get('parts', p.fn) || {}).name || p.fn, why: p.why,
        sources: p.res.map(x => ({ id: x.cat.id, name: x.cat.name, score: Math.round(x.best.s), spec: x.best.comp.spec, where: x.best.comp.loc, hazards: (x.cat.hazards || []).map(h => ctx.hazard(h).label) })),
      })),
      devicesNamed: out.devices.slice(0, 5).map(d => ({ id: d.id, name: d.name })),
      hazards: (out.hazards || []).slice(0, 3).map(h => ({ id: h.id, label: h.label, severity: h.severity, summary: h.summary })),
      brands: (out.brands || []).slice(0, 3).map(b => ({ name: b.brand, devices: b.devices.map(d => ({ id: d.id, name: d.name })) })),
      guides: out.guides.slice(0, 8).map(g => ({ id: g.id, kind: g.kind, title: g.title, summary: g.summary })),
      models: (out.models || []).slice(0, limit).map(h => ({ id: h.model.id, name: ctx.modelName(h.model), device: h.model.device, parts: h.parts.map(x => ({ key: x.key, spec: x.spec, confidence: SDG.db.CONF[x.conf] ? SDG.db.CONF[x.conf].label : 'Likely', source: x.source })) })),
      bestDevices: r.res.slice(0, limit).map(x => ({
        id: x.cat.id, name: x.cat.name, era: x.cat.era, score: Math.round(x.best.s), minutes: x.cat.mins, kg: x.cat.kg,
        tools: (x.cat.tools || []).map(ctx.toolLabel), needsDesoldering: x.hits.some(h => h.comp.board),
        hazards: (x.cat.hazards || []).map(h => ctx.hazard(h).label),
        parts: x.hits.slice(0, 4).map(h => ({
          partType: h.comp.fn, spec: h.comp.spec, qty: h.comp.qty, where: h.comp.loc, board: h.comp.board,
          confidence: SDG.db.CONF[h.ci.conf].label, confirmedIn: h.ci.confirmed, score: Math.round(h.s),
          via: h.via, missingTools: h.missingTools.length ? h.missingTools.map(ctx.toolLabel) : undefined,
          stillUsable: h.decay < 1 ? Math.round(h.decay * 100) + '%' : undefined, oftenTaken: h.left < 0.6 || undefined, tooHeavy: h.tooHeavy || undefined,
        })),
      })),
      whereToLook: r.blds.slice(0, limit).map(a => ({
        id: a.bt.id, name: a.bt.name, score: Math.round(a.n), likelyLeft: leftLabel(a.remain),
        mostlyFrom: a.devices.slice(0, 3).map(d => d.n), osmTags: a.bt.osm,
      })),
      totalDevices: r.res.length,
    };
  }

  // "Here's what I have, what can I make?" Build and repair guides ranked by how much of their
  // materials list the user already has, with the best place to scrap each missing part.
  // The best place to scrap each part, remembered per opened dataset and set of options: what you
  // have changes from call to call, where a part is best found doesn't.
  const BEST = new WeakMap();
  function bestSource(ctx, m, opts) {
    let memo = BEST.get(ctx);
    if (!memo) BEST.set(ctx, (memo = new Map()));
    const key = SDG.util.canonical([ctx.votesGen ? ctx.votesGen() : 0, m.fn, m.only || [], opts]);
    if (!memo.has(key)) {
      if (memo.size >= 2000) memo.delete(memo.keys().next().value);
      const top = rank(ctx, new Map([[m.fn, { via: 'direct', on: true, only: m.only && m.only.length ? m.only.map(lc) : undefined }]]), '', opts).res[0];
      memo.set(key, top ? { id: top.cat.id, name: top.cat.name, score: Math.round(top.best.s) } : null);
    }
    return memo.get(key);
  }
  function buildable(ctx, have, opts) {
    opts = opts || {};
    have = new Set(have || []);
    return live(ctx.ds.guides || []).filter(g => ['build', 'repair'].includes(g.kind)).map(g => {
      const need = (g.materials || []).filter(m => m.fn && !m.optional);
      const got = need.filter(m => have.has(m.fn));
      const missing = need.filter(m => !have.has(m.fn)).map(m => ({ fn: m.fn, item: m.item, bestSource: bestSource(ctx, m, opts) }));
      return { guide: g, coverage: need.length ? got.length / need.length : 0, have: got.map(m => m.fn), missing };
    }).filter(x => x.coverage > 0 || opts.all).sort((a, b) => b.coverage - a.coverage || a.guide.difficulty - b.guide.difficulty);
  }

  SDG.search = { findParts, findJobs, findDevices, findModels, findBrands, findGuides, findHazards, select, applySubs, specTokens, scoreComp, rank, search, summarize, buildable, decayFactor, leftLabel };
};

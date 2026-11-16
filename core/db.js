// Opens a dataset for reading: indexes, template resolution and confidence from logged models.
module.exports = function (SDG) {
  const COLLS = ['parts', 'boards', 'devices', 'models', 'buildings', 'jobs', 'hazards', 'guides'];
  // `level` orders them for display (1 to 4); `f` weights the ranking.
  const CONF = {
    assumed: { label: 'Generic guess', f: 0.85, level: 1, about: 'what most units of this kind contain, not checked in a real one' },
    likely: { label: 'Likely', f: 0.95, level: 2, about: 'reported for a real unit (by someone who opened one, or in a seller’s listing), not yet confirmed' },
    documented: { label: 'Documented', f: 0.97, level: 3, about: 'shown in a manual, parts list, filing or teardown of a real model' },
    verified: { label: 'Verified', f: 1, level: 4, about: 'seen by someone who opened a real one' },
  };

  // Shown with every device: devices are generic templates, not one product.
  const GENERIC_NOTE = 'Generic: what most units of this kind contain, not one specific model. Real units vary. Parts marked Documented or Verified were confirmed in real models; open one and log it to add its exact parts.';

  function empty() {
    const ds = { vocab: { tools: {}, partGroups: [], deviceGroups: [] } };
    COLLS.forEach(c => (ds[c] = []));
    return ds;
  }

  // Datasets saved by versions 1 and 2 of the app used different names. Converts in place.
  function migrateLegacy(d) {
    if (!d || typeof d !== 'object') return d;
    if (d.functions && !d.parts) { d.parts = d.functions; delete d.functions; }
    if (d.categories && !d.devices) { d.devices = d.categories; delete d.categories; }
    (d.models || []).forEach(m => { if (m.cat && !m.device) { m.device = m.cat; delete m.cat; } });
    COLLS.forEach(c => (d[c] = d[c] || []));
    d.vocab = d.vocab || { tools: {}, partGroups: [], deviceGroups: [] };
    return d;
  }

  function open(ds) {
    migrateLegacy(ds);
    const by = {};
    COLLS.forEach(c => { by[c] = new Map(); (ds[c] || []).forEach(r => by[c].set(r.id, r)); });
    const kids = new Map();
    ds.devices.forEach(d => { if (d.variantOf) { if (!kids.has(d.variantOf)) kids.set(d.variantOf, []); kids.get(d.variantOf).push(d.id); } });
    const modelsByDevice = new Map();
    ds.models.forEach(m => { if (!modelsByDevice.has(m.device)) modelsByDevice.set(m.device, []); modelsByDevice.get(m.device).push(m); });
    const cache = new Map();

    const get = (coll, id) => by[coll] && by[coll].get(id);
    const hazard = id => get('hazards', id) || { id, label: id, severity: 3, summary: '' };
    const toolLabel = id => (ds.vocab.tools && ds.vocab.tools[id]) || id;

    function boardComps(c) {
      const out = [];
      (c.boards || []).forEach(ref => {
        const bd = get('boards', ref.id);
        if (!bd) return;
        (bd.comps || []).forEach(x => out.push(Object.assign({}, x, {
          key: 'b:' + ref.id + ':' + x.key, qty: (x.qty || 1) * (ref.qty || 1),
          loc: (ref.loc ? ref.loc + ': ' : '') + (x.loc || ''), board: bd.name, boardId: ref.id, p: ref.p == null ? 1 : ref.p,
        })));
      });
      return out;
    }

    // Full part list for a device: parent's parts, then its boards' parts, then its own parts,
    // which override by key or remove with `absent`. Tools and buildings inherit unless set; hazards merge.
    function resolve(id, depth) {
      depth = depth || 0;
      if (!depth && cache.has(id)) return cache.get(id);
      const c = get('devices', id);
      if (!c) return null;
      const p = c.variantOf && depth <= 6 && get('devices', c.variantOf) ? resolve(c.variantOf, depth + 1) : null;
      const map = new Map((p ? p.comps : []).map(x => [x.key, Object.assign({}, x)]));
      boardComps(c).forEach(x => map.set(x.key, x));
      (c.comps || []).forEach(x => { if (x.absent) map.delete(x.key); else map.set(x.key, Object.assign({}, map.get(x.key) || {}, x)); });
      let r;
      if (!p) r = Object.assign({}, c, { abstract: !!c.abstract, tools: c.tools || [], hazards: c.hazards || [], buildings: c.buildings || [], boards: c.boards || [], comps: [...map.values()] });
      else r = Object.assign({}, p, c, {
        abstract: !!c.abstract, group: c.group || p.group, tools: (c.tools && c.tools.length) ? c.tools : p.tools,
        mins: c.mins != null ? c.mins : p.mins, kg: c.kg != null ? c.kg : p.kg,
        hazards: [...new Set([...(p.hazards || []), ...(c.hazards || [])])],
        buildings: (c.buildings && c.buildings.length) ? c.buildings : p.buildings,
        aliases: [...new Set([...(p.aliases || []), ...(c.aliases || [])])],
        brands: [...new Set([...(c.brands || []), ...(p.brands || [])])],
        comps: [...map.values()], parentName: p.name, notes: c.notes || p.notes, boards: [...(p.boards || []), ...(c.boards || [])],
      });
      if (!depth) cache.set(id, r);
      return r;
    }

    // Ancestors and descendants, so a model logged on a variant also informs its relatives.
    function lineage(id) {
      const up = [], down = [];
      let cur = get('devices', id), n = 0;
      while (cur && cur.variantOf && n++ < 8) { up.push(cur.variantOf); cur = get('devices', cur.variantOf); }
      const walk = (x, d) => (kids.get(x) || []).forEach(k => { if (d < 8) { down.push(k); walk(k, d + 1); } });
      walk(id, 0);
      return { up, down };
    }

    const modelName = m => [m.brand, m.model].filter(Boolean).join(' ') || 'Unnamed model';

    // Confidence for one part of one device. Models of this exact device can make it verified;
    // models of parents or variants can only make it likely. Absences lower `presence`.
    // Tallied votes (SDG.votes.tally), set by whoever holds them: the app or a hub.
    let votes = null;
    const setVotes = t => { votes = t || null; };
    function confInfo(deviceId, key) {
      let best = 'assumed';
      const confirmed = [], absentIn = [];
      let yes = 0, no = 0;
      const rank = { assumed: 0, likely: 1, documented: 2, verified: 3 };
      const visit = (devId, direct) => (modelsByDevice.get(devId) || []).forEach(m => {
        const o = (m.comps || []).find(x => x.key === key);
        if (!o) return;
        if (o.absent) { if (direct) { absentIn.push(modelName(m)); no++; } return; }
        let c = rank[o.conf] ? o.conf : 'likely';
        if (!direct) c = 'likely';
        if (rank[c] > rank[best]) best = c;
        if (direct) yes++;
        confirmed.push(modelName(m) + (direct ? '' : ' (related model)'));
      });
      visit(deviceId, true);
      const lin = lineage(deviceId);
      [...lin.up, ...lin.down].forEach(id => visit(id, false));
      const v = votes && SDG.votes.partStatus(votes.get(SDG.votes.partTarget(deviceId, key)));
      if (v) { yes += v.up; no += v.down; if (best === 'assumed' && v.confirmed) best = 'likely'; }
      // Present unless someone found it missing: one sighting each way leaves it at 3 in 4.
      const presence = (yes + 2) / (yes + no + 2);
      return { conf: best, confirmed, absentIn, presence, votes: v };
    }

    function stats() {
      const out = {};
      COLLS.forEach(c => (out[c] = (ds[c] || []).length));
      out.searchableDevices = ds.devices.filter(d => !d.abstract && !d.deprecated).length;
      out.verifiedParts = ds.models.reduce((s, m) => s + (m.comps || []).filter(c => c.conf === 'verified').length, 0);
      return out;
    }

    return { ds, by, get, resolve, confInfo, setVotes, lineage, boardComps, modelName, hazard, toolLabel, stats, kids, modelsByDevice };
  }

  SDG.db = { COLLS, CONF, GENERIC_NOTE, empty, open, migrateLegacy };
};

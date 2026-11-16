// A small JSON Schema validator covering the subset sdg.schema.json uses, plus `x-ref`
// cross-reference checks. No dependencies, so it runs offline in the browser and in Node.
module.exports = function (SDG) {
  let ROOT = null;

  function use(schema) { ROOT = schema; }
  function root() { if (!ROOT) throw new Error('Schema not loaded: call SDG.schema.use(schema) first.'); return ROOT; }

  function pointer(ref) {
    if (!ref.startsWith('#/')) throw new Error('Only local $ref values are supported: ' + ref);
    return ref.slice(2).split('/').reduce((o, k) => (o ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root());
  }
  // A schema with $ref plus sibling keywords (title, x-ref...) merges the target under the siblings.
  function deref(s) {
    let guard = 0;
    while (s && s.$ref && guard++ < 20) {
      const { $ref, ...rest } = s;
      s = Object.assign({}, pointer($ref), rest);
    }
    return s;
  }

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  function typeOk(v, t) {
    const actual = typeOf(v);
    return [].concat(t).some(x => x === actual || (x === 'number' && actual === 'integer'));
  }

  // Returns errors as [{path, msg}]; refs collects [{path, coll, value}] for later cross-checks.
  function check(v, s, path, errs, refs) {
    s = deref(s);
    if (!s || s === true) return;
    const err = msg => errs.push({ path: path || '(record)', msg });
    if (s.type && !typeOk(v, s.type)) { err(`should be ${[].concat(s.type).join(' or ')}`); return; }
    if ('const' in s && !SDG.util.deepEqual(v, s.const)) err(`should be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some(e => SDG.util.deepEqual(e, v))) err(`should be one of: ${s.enum.join(', ')}`);
    if (typeof v === 'number') {
      if (s.minimum != null && v < s.minimum) err(`should be at least ${s.minimum}`);
      if (s.maximum != null && v > s.maximum) err(`should be at most ${s.maximum}`);
      if (s.exclusiveMinimum != null && v <= s.exclusiveMinimum) err(`should be more than ${s.exclusiveMinimum}`);
    }
    if (typeof v === 'string') {
      if (s.minLength != null && v.length < s.minLength) err(s.minLength === 1 ? 'should not be empty' : `should be at least ${s.minLength} characters`);
      if (s.maxLength != null && v.length > s.maxLength) err(`should be at most ${s.maxLength} characters`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) err(`has the wrong format (${s.pattern})`);
      if (s['x-ref']) refs.push({ path, coll: s['x-ref'], value: v });
    }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) err(`needs at least ${s.minItems} item${s.minItems > 1 ? 's' : ''}`);
      if (s.maxItems != null && v.length > s.maxItems) err(`allows at most ${s.maxItems} items`);
      if (s.items) v.forEach((x, i) => check(x, s.items, `${path}[${i}]`, errs, refs));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      (s.required || []).forEach(k => { if (!has(v, k) || v[k] === undefined) errs.push({ path: path ? `${path}.${k}` : k, msg: 'is required' }); });
      const props = s.properties || {};
      Object.keys(v).forEach(k => {
        const p = path ? `${path}.${k}` : k;
        if (has(props, k)) check(v[k], props[k], p, errs, refs);
        else if (s.additionalProperties === false) errs.push({ path: p, msg: 'is not a known field' });
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(v[k], s.additionalProperties, p, errs, refs);
      });
    }
    if (s.allOf) s.allOf.forEach(x => check(v, x, path, errs, refs));
    if (s.anyOf && !s.anyOf.some(x => { const e = []; check(v, x, path, e, []); return !e.length; })) err('does not match any allowed shape');
    if (s.if) {
      const e = []; check(v, s.if, path, e, []);
      if (!e.length) { if (s.then) check(v, s.then, path, errs, refs); } else if (s.else) check(v, s.else, path, errs, refs);
    }
  }

  function typeFor(coll) {
    const t = has(root()['x-collections'], coll) && root()['x-collections'][coll];
    if (!t) throw new Error('Unknown collection: ' + coll);
    return t;
  }
  function schemaFor(nameOrColl) {
    const r = root();
    const t = (has(r['x-collections'], nameOrColl) && r['x-collections'][nameOrColl]) || nameOrColl;
    if (!has(r.$defs, t)) throw new Error('No schema for ' + nameOrColl);
    return deref({ $ref: '#/$defs/' + t });
  }

  // Prototype keys are refused anywhere in a record or item, even under free-form fields.
  function badKeys(v, path, errs, depth) {
    if (!v || typeof v !== 'object' || depth > 64) return;
    if (Array.isArray(v)) { v.forEach((x, i) => badKeys(x, `${path}[${i}]`, errs, depth + 1)); return; }
    Object.keys(v).forEach(k => {
      const p = path ? `${path}.${k}` : k;
      if (SDG.util.BAD_KEYS.includes(k)) errs.push({ path: p, msg: 'is not an allowed field name' });
      else badKeys(v[k], p, errs, depth + 1);
    });
  }

  function validate(typeName, value) {
    const errs = [], refs = [];
    badKeys(value, '', errs, 0);
    check(value, { $ref: '#/$defs/' + typeName }, '', errs, refs);
    return { ok: !errs.length, errors: errs, refs };
  }
  const validateRecord = (coll, rec) => validate(typeFor(coll), rec);

  // Resolves an x-ref name against a dataset: a collection, or a vocab list like "vocab.tools".
  function refExists(ds, coll, value) {
    if (coll.startsWith('vocab.')) {
      const v = ds.vocab && ds.vocab[coll.slice(6)];
      if (!v) return true;
      return Array.isArray(v) ? v.includes(value) : Object.prototype.hasOwnProperty.call(v, value);
    }
    return !!(ds[coll] || []).some(r => r.id === value);
  }

  // Full check of a dataset: every record against its schema, every reference, and the
  // structural rules a schema can't express (unique ids and keys, variant cycles).
  function validateDataset(ds) {
    const problems = [];
    const add = (coll, id, path, msg) => problems.push({ coll, id, path, msg });
    const ids = {};
    Object.keys(root()['x-collections']).forEach(coll => {
      const seen = new Set();
      ids[coll] = seen;
      (ds[coll] || []).forEach(rec => {
        const r = validateRecord(coll, rec);
        r.errors.forEach(e => add(coll, rec && rec.id, e.path, e.msg));
        r.refs.forEach(ref => { if (!refExists(ds, ref.coll, ref.value)) add(coll, rec.id, ref.path, `points at ${ref.coll.replace('vocab.', '')} “${ref.value}”, which doesn't exist`); });
        if (rec && rec.id) { if (seen.has(rec.id)) add(coll, rec.id, 'id', 'is used twice'); seen.add(rec.id); }
        ['comps'].forEach(k => {
          if (!Array.isArray(rec && rec[k])) return;
          const keys = rec[k].map(x => x.key);
          keys.forEach((key, i) => { if (keys.indexOf(key) !== i) add(coll, rec.id, `${k}[${i}].key`, `“${key}” is used twice`); });
        });
      });
    });
    const dev = new Map((ds.devices || []).map(d => [d.id, d]));
    dev.forEach(d => {
      let cur = d, n = 0;
      while (cur && cur.variantOf && n++ < 10) cur = dev.get(cur.variantOf);
      if (n >= 10) add('devices', d.id, 'variantOf', 'forms a loop of variants');
    });
    (ds.parts || []).forEach(p => (p.substitutes || []).forEach(s => { if (s === p.id) add('parts', p.id, 'substitutes', 'lists itself'); }));
    // Learn-first links must flow forward: no prerequisite from a later era, and no loops.
    const guides = new Map((ds.guides || []).map(g => [g.id, g]));
    guides.forEach(g => {
      if (!g.tree) return;
      (g.tree.requires || []).forEach((r, i) => {
        const pre = guides.get(r);
        if (r === g.id) add('guides', g.id, `tree.requires[${i}]`, 'requires itself');
        else if (pre && pre.tree && pre.tree.era > g.tree.era) add('guides', g.id, `tree.requires[${i}]`, `“${r}” is in a later era (${pre.tree.era})`);
        else if (pre && !pre.tree) add('guides', g.id, `tree.requires[${i}]`, `“${r}” has no era or branch`);
      });
      const seen = new Set();
      const walk = (id, depth) => {
        if (depth > 60 || seen.has(id)) return;
        seen.add(id);
        const x = guides.get(id);
        ((x && x.tree && x.tree.requires) || []).forEach(r => { if (r === g.id) add('guides', g.id, 'tree.requires', `forms a loop through “${id}”`); else walk(r, depth + 1); });
      };
      walk(g.id, 0);
    });
    return problems;
  }

  SDG.schema = { use, root, deref, schemaFor, typeFor, validate, validateRecord, validateDataset, refExists };
};

// Small helpers shared by every part of the project. Runs in browsers and Node.
module.exports = function (SDG) {
  const enc = new TextEncoder();

  // JSON with sorted keys and no whitespace, so the same data always hashes and signs the same.
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(x => (x === undefined ? 'null' : canonical(x))).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }

  function subtle() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new Error('Web Crypto is not available here. Open the app from a file or https, or use Node 20+.');
    return c.subtle;
  }

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  async function sha256(data) { return new Uint8Array(await subtle().digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data)); }
  async function sha256hex(data) { return hex(await sha256(data)); }

  function b64u(bytes) {
    let s = '';
    bytes = new Uint8Array(bytes);
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // Time-sortable ids: base36 milliseconds then random, e.g. "lq8x2k3m0-4f9a2c7d".
  function newId() {
    const r = new Uint8Array(5);
    globalThis.crypto.getRandomValues(r);
    return Date.now().toString(36).padStart(9, '0') + '-' + [...r].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
  }

  const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  // Keys that reach object prototypes. Records never need them; untrusted JSON loses them on parse.
  const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];
  const reviver = (k, v) => (BAD_KEYS.includes(k) ? undefined : v);
  // Same result as JSON.parse(text, reviver), but a reviver makes JSON.parse keep the source of
  // every value while it runs (several times the memory, far more for hostile input), so this
  // parses plainly and then drops those keys, depth first, holding one frame per open level.
  // Nesting deeper than any real data is refused, as the reviver's own recursion did.
  const MAX_DEPTH = 1000;
  function parse(text) {
    const root = JSON.parse(text), open = [];
    const enter = o => {
      if (open.length >= MAX_DEPTH) throw new SyntaxError('JSON nested too deeply');
      open.push({ o, keys: Array.isArray(o) ? null : Object.keys(o), i: 0 });
    };
    if (root && typeof root === 'object') enter(root);
    while (open.length) {
      const f = open[open.length - 1];
      if (f.i >= (f.keys ? f.keys.length : f.o.length)) { open.pop(); continue; }
      const k = f.keys ? f.keys[f.i++] : f.i++;
      if (f.keys && BAD_KEYS.includes(k)) delete f.o[k];
      else if (f.o[k] && typeof f.o[k] === 'object') enter(f.o[k]);
    }
    return root;
  }
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // A shallow copy of own keys only, minus `skip`. Unlike Object.assign it never sets a prototype:
  // an own "__proto__" stays a plain key, so signatures and validation still see it.
  function own(o, skip) {
    const c = {};
    Object.keys(o || {}).forEach(k => { if (skip && skip.includes(k)) return; if (k === '__proto__') Object.defineProperty(c, k, { value: o[k], enumerable: true, writable: true, configurable: true }); else c[k] = o[k]; });
    return c;
  }
  const deepEqual = (a, b) => canonical(a) === canonical(b);
  const now = () => new Date().toISOString();

  // Flat list of what changed between two records, for review screens.
  function diff(a, b, path, out) {
    path = path || ''; out = out || [];
    if (deepEqual(a, b)) return out;
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (isObj(a) && isObj(b)) {
      new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k => diff(a[k], b[k], path ? path + '.' + k : k, out));
    } else if (Array.isArray(a) && Array.isArray(b) && a.every(isObj) && b.every(isObj) && [...a, ...b].every(x => x.key || x.id || x.b || x.fn)) {
      const k = x => x.key || x.id || x.b || x.fn;
      const am = new Map(a.map(x => [k(x), x])), bm = new Map(b.map(x => [k(x), x]));
      new Set([...am.keys(), ...bm.keys()]).forEach(id => diff(am.get(id), bm.get(id), `${path}[${id}]`, out));
    } else {
      out.push({ path, before: a, after: b });
    }
    return out;
  }

  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'item';
  }

  SDG.util = { canonical, sha256, sha256hex, hex, b64u, unb64u, newId, clone, deepEqual, now, diff, slug, enc, BAD_KEYS, reviver, parse, has, own };
};

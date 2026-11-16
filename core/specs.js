// Electrical ratings on part entries: volts (v), amps (a), watts (w) and amp-hours (ah), each a
// number or a [min, max] range, plus ac for mains-type parts. Entries can state them; otherwise
// they are read from the spec text when it is unambiguous. Search uses them so "12V motor" ranks
// 12 V motors above 3 V ones, and jobs can ask for "at least 5 W".
module.exports = function (SDG) {
  const KEYS = ['v', 'a', 'w', 'ah'];
  const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)';
  const RANGE = `${NUM}(?:\\s*(?:–|-|to)\\s*${NUM})?`;
  // A number in a spec: never one with a leading zero (041A5250 is a part number, not 41 A).
  const QTY = '((?!0\\d)(?:\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?))';
  // Each unit's spellings (case matters for amps, where "a" is also a word). A quantity is a
  // number, its unit, or a range or pair of them: 100-240 V, 12V-24V, 12/24 V, 3.3 to 5 V.
  // After the unit comes no letter or digit (88W8797 and 6871A20482A are part numbers), and
  // mentions() drops one followed by a dash and a capital (11A-A2BM is a model number, while
  // 100 V-rated is a rating).
  const SPELL = {
    v: ['kV|mV|V|volts?', 'gi'],
    w: ['kW|W|watts?', 'gi'],
    a: ['mA|µA|uA|A|[Aa]mps?(?!\\s*-?\\s*[Hh]ours?)|AMPS?|[Aa]mperes?', 'g'],
    ah: ['mAh|Ah|amp[- ]?hours?', 'gi'],
  };
  const UNITS = {};
  Object.entries(SPELL).forEach(([k, [alts, flags]]) => {
    UNITS[k] = new RegExp(`(^|[^A-Za-z0-9.,])${QTY}(?:\\s*(?:${alts}))?(?:\\s*(–|-|/|to)\\s*${QTY})?\\s*(${alts})${k === 'v' ? '(\\s*(?:AC|DC|~))?' : '()'}(?![A-Za-z0-9])`, flags);
  });
  const SCALE = { kv: 1000, mv: 0.001, v: 1, volt: 1, kw: 1000, w: 1, watt: 1, ma: 0.001, 'µa': 1e-6, ua: 1e-6, a: 1, amp: 1, ampere: 1, mah: 0.001, ah: 1, 'amp-hour': 1, 'amp hour': 1, amphour: 1 };
  const scale = u => SCALE[u.toLowerCase().replace(/s$/, '')];
  // Bigger than any part the guide covers: a number that reads this big is a part number.
  const MOST = { v: 1e6, a: 2000, w: 1e7, ah: 10000 };
  // A dash glued to a code before it starts a part number, not a quantity: BN96-12859A, DA61-,
  // LYSB-4916W, 3612JL-04W. (Checked by hand: older browsers can't look behind in a pattern.)
  const CODE = /(?:[A-Z]{2,}|[A-Za-z]+\d+|\d+[A-Za-z]{2,})-$/;
  const num = s => Number(String(s).replace(/,/g, ''));
  const round = x => Math.round(x * 1000) / 1000;
  const lo = r => (Array.isArray(r) ? r[0] : r);
  const hi = r => (Array.isArray(r) ? r[1] : r);

  // Every mention of one quantity in a text, as {at, value, ac}.
  function mentions(text, key) {
    const out = [];
    const re = UNITS[key];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const at = m.index + m[1].length;
      const end = m.index + m[0].length;
      if (CODE.test(text.slice(Math.max(0, at - 24), at)) || /^-[A-Z]/.test(text.slice(end, end + 2))) continue;
      const k = scale(m[5]);
      let a = num(m[2]), b = m[4] ? num(m[4]) : null;
      // 1/4 W is a quarter of a watt; 12/24 V is either.
      if (m[3] === '/' && b != null && a < b && a <= 3 && [2, 3, 4, 8, 16, 32].includes(b)) { a /= b; b = null; }
      a = round(a * k); b = b == null ? null : round(b * k);
      const value = b == null || a === b ? a : [Math.min(a, b), Math.max(a, b)];
      if (hi(value) > MOST[key]) continue;
      out.push({ at, value, ac: key === 'v' && /ac|~/i.test(m[6] || '') });
    }
    return out;
  }

  // Ratings stated in plain text. A quantity mentioned with different values is left out unless
  // the text says which one is the output ("input 100-240 V, output 42 V" gives 42 V).
  function parse(text) {
    text = String(text || '');
    const out = {};
    const outputAt = text.search(/\boutput\b/i);
    KEYS.forEach(key => {
      let ms = mentions(text, key);
      if (!ms.length) return;
      const same = list => list.every(x => JSON.stringify(x.value) === JSON.stringify(list[0].value));
      if (!same(ms) && outputAt >= 0) ms = ms.filter(x => x.at > outputAt);
      if (!ms.length || !same(ms)) return;
      out[key] = ms[0].value;
      if (key === 'v' && (ms[0].ac || (/\bmains\b/i.test(text) && lo(ms[0].value) >= 100))) out.ac = true;
    });
    return out;
  }

  // An entry's ratings: what it states, or what its spec text says.
  const cache = new WeakMap();
  function ratings(comp) {
    if (!comp || typeof comp !== 'object') return {};
    if (cache.has(comp)) return cache.get(comp);
    const stated = KEYS.some(k => comp[k] != null);
    const r = stated ? KEYS.reduce((o, k) => (comp[k] != null ? Object.assign(o, { [k]: comp[k] }) : o), comp.ac ? { ac: true } : {}) : parse(comp.spec);
    cache.set(comp, r);
    return r;
  }

  // What a search asks for: "12v motor" wants about 12 V, "100w panel" at least 100 W.
  function wanted(query) {
    const r = parse(query);
    if (/\bac\b/i.test(query || '')) r.ac = true;
    else if (/\bdc\b/i.test(query || '')) r.ac = false;
    return r;
  }

  // How well ratings fit what is wanted: above 1 is a match, below 1 a mismatch or unknown.
  // Volts should be about right; amps, watts and amp-hours are "at least".
  function fit(r, want) {
    let f = 1;
    if (!want) return f;
    if (want.v != null) {
      const ok = r.v != null && hi(want.v) >= lo(r.v) * 0.85 && lo(want.v) <= hi(r.v) * 1.15;
      f *= r.v == null ? 0.85 : ok ? 1.25 : 0.4;
    }
    if (want.ac != null && r.v != null) f *= !!r.ac === want.ac ? 1 : 0.6;
    ['a', 'w', 'ah'].forEach(k => {
      if (want[k] == null) return;
      if (r[k] == null) { f *= 0.9; return; }
      const ratio = hi(r[k]) / lo(want[k]);
      f *= ratio >= 0.8 ? 1.15 : ratio >= 0.5 ? 0.75 : 0.4;
    });
    return Math.max(0.15, Math.min(1.6, f));
  }

  // A typed amount: "12" is 12, "100-240" is [100, 240], empty is nothing. Anything else comes
  // back as typed so the validator can say what's wrong with it.
  function amount(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return undefined;
    const m = new RegExp(`^${RANGE}$`).exec(t);
    if (!m) return t;
    const a = num(m[1]), b = m[2] ? num(m[2]) : null;
    return b == null || a === b ? a : [Math.min(a, b), Math.max(a, b)];
  }

  // Short label for a range or number with its unit: 100–240 V, 12 V, 5 Ah.
  const label = (r, unit) => (r == null ? '' : Array.isArray(r) ? `${r[0]}–${r[1]} ${unit}` : `${r} ${unit}`);

  SDG.specs = { KEYS, parse, ratings, wanted, fit, amount, label, mentions };
};

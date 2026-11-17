// Calculators for the quick reference: an engineering calculator that reads SI prefixes (4k7,
// 100n, 2.2M) and a parallel operator (1k || 2k2), and small tools that work out the rest from
// what you know. The page's security policy forbids eval, so expressions are parsed here by hand.
const Calc = (() => {
  const esc = MD.esc; // this file runs before app.js defines its own

  // ---- Numbers ----
  const PREFIX = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  // A typed value: 4.7k, 4k7, 4R7, 100n, 2.2M, 1e-6, with or without a unit (4.7kΩ, 100nF, 10mAh).
  function num(s) {
    let t = String(s == null ? '' : s).trim().replace(/[\s,]/g, '').replace(/(ohms?|Ω|Hz|Wh|Ah|V|A|W|F|H|s)$/i, '');
    if (!t) return NaN;
    const rkm = /^(\d+)([pnuµmkKMGTR])(\d+)$/.exec(t);
    if (rkm) return Number(`${rkm[1]}.${rkm[3]}`) * (rkm[2] === 'R' ? 1 : PREFIX[rkm[2]]);
    const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([pnuµmkKMGT])?$/.exec(t);
    return m ? Number(m[1]) * (m[2] ? PREFIX[m[2]] : 1) : NaN;
  }
  // 4700 as 4.7 k, 0.0000001 as 100 n; four significant figures.
  function eng(x, unit) {
    unit = unit || '';
    if (!Number.isFinite(x)) return '—';
    if (x === 0) return `0${unit ? ' ' + unit : ''}`;
    const P = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
    const a = Math.abs(x), [f, p] = P.find(([v]) => a >= v * 0.99995) || P[P.length - 1];
    return `${+(x / f).toPrecision(4)} ${p}${unit}`.trim();
  }
  const fix = (x, d) => (Number.isFinite(x) ? (+x.toFixed(d == null ? 2 : d)).toLocaleString('en', { maximumFractionDigits: d == null ? 2 : d }) : '—');

  // ---- The expression parser: + − × ÷ ^ ( ), || (parallel), functions, pi, e, ans ----
  // Names are looked up only as own properties of these tables, never on their prototypes, so
  // typing constructor( or __proto__ can't reach anything built in (the flaw behind expr-eval's
  // CVE-2025-13204).
  const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const FN = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, exp: Math.exp,
    ln: Math.log, log: Math.log10, log2: Math.log2, hypot: Math.hypot, min: Math.min, max: Math.max,
  };
  const TRIG = { sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan };
  function evaluate(src, opts) {
    opts = opts || {};
    const deg = opts.deg !== false;
    const s = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/π/g, 'pi').replace(/√/g, 'sqrt');
    let i = 0;
    const peek = () => s[i], ws = () => { while (/\s/.test(s[i] || '')) i++; };
    const fail = m => { throw new Error(m); };
    function number() {
      const start = i;
      while (/[0-9.]/.test(s[i] || '')) i++;
      if (/[eE]/.test(s[i] || '') && /[-+0-9]/.test(s[i + 1] || '') && (/[0-9]/.test(s[i + 1]) || /[0-9]/.test(s[i + 2] || ''))) { i++; if (/[-+]/.test(s[i])) i++; while (/[0-9]/.test(s[i] || '')) i++; }
      let text = s.slice(start, i);
      // A prefix letter straight after the digits (not the start of a name like pi), or 4k7 style.
      const c = s[i];
      if (c && (own(PREFIX, c) || c === 'R') && (/[0-9]/.test(s[i + 1] || '') || !/[a-zA-Zµ]/.test(s[i + 1] || ''))) { text += c; i++; while (/[0-9]/.test(s[i] || '')) text += s[i++]; }
      const v = num(text);
      if (Number.isNaN(v)) fail(`Can’t read “${text}”`);
      return v;
    }
    function primary() {
      ws();
      const c = peek();
      if (c === '(') { i++; const v = sum(); ws(); if (s[i] !== ')') fail('Missing )'); i++; return v; }
      if (/[0-9.]/.test(c || '')) return number();
      const name = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(s.slice(i));
      if (name) {
        i += name[0].length;
        const id = name[0];
        if (id === 'pi') return Math.PI;
        if (id === 'e') return Math.E;
        if (id === 'ans') return opts.ans == null ? fail('No answer yet') : opts.ans;
        const f = own(FN, id) || own(TRIG, id);
        if (!f) fail(`Unknown name “${id}”`);
        ws();
        if (s[i] !== '(') fail(`${id} needs ( )`);
        i++;
        const args = [];
        ws();
        if (s[i] !== ')') { args.push(sum()); ws(); while (s[i] === ',') { i++; args.push(sum()); ws(); } }
        if (s[i] !== ')') fail('Missing )');
        i++;
        if (own(TRIG, id)) {
          const k = deg ? Math.PI / 180 : 1;
          return /^a/.test(id) ? f(args[0]) / k : f(args[0] * k);
        }
        return f(...args);
      }
      return fail(c ? `Unexpected “${c}”` : 'Unfinished expression');
    }
    function unary() { ws(); if (s[i] === '-') { i++; return -unary(); } if (s[i] === '+') { i++; return unary(); } return primary(); }
    function power() { const b = unary(); ws(); if (s[i] === '^') { i++; return b ** power(); } return b; }
    // Parallel binds tighter than × and +, so 1k + 2k || 2k is 1k + 1k.
    function parallel() { let v = power(); ws(); while (s[i] === '|' && s[i + 1] === '|') { i += 2; const w = power(); v = (v * w) / (v + w); ws(); } return v; }
    function product() {
      let v = parallel();
      for (;;) {
        ws();
        if (s[i] === '*') { i++; v *= parallel(); } else if (s[i] === '/') { i++; v /= parallel(); }
        else if (s[i] === '(' || /[a-zA-Z]/.test(s[i] || '')) v *= parallel(); // 2pi, 3(4+1)
        else return v;
      }
    }
    function sum() { let v = product(); for (;;) { ws(); if (s[i] === '+') { i++; v += product(); } else if (s[i] === '-') { i++; v -= product(); } else return v; } }
    const v = sum();
    ws();
    if (i < s.length) fail(`Unexpected “${s[i]}”`);
    return v;
  }

  // ---- The engineering calculator ----
  const calc = { ans: null, deg: true, hist: [] };
  function calcHTML() {
    const keys = ['(', ')', '^', '√', 'π', '||', 'k', 'M', 'm', 'µ', 'n', 'p', 'ans'];
    return `<div class="calc"><label class="sr" for="calcx">Expression</label><input id="calcx" class="calcin" autocomplete="off" spellcheck="false" placeholder="12 / 4k7   1k || 2k2   sqrt(2)*230">
      <div class="calcout" id="calcout" aria-live="polite">&nbsp;</div>
      <div class="calckeys">${keys.map(k => `<button type="button" class="btn small ghost" data-ins="${esc(k === '√' ? 'sqrt(' : k === '||' ? ' || ' : k)}">${esc(k)}</button>`).join('')}<button type="button" class="btn small ghost" id="calcdeg">${calc.deg ? 'DEG' : 'RAD'}</button><button type="button" class="btn small ghost" id="calcclr">C</button><button type="button" class="btn small" id="calceq">=</button></div>
      <ol class="calchist" id="calchist">${histHTML()}</ol>
      <p class="hint">Numbers take SI prefixes: p n µ (or u) m k M G T, so 4.7k, 4k7, 100n, 2.2M. <code>||</code> is parallel (1k || 1k is 500); it binds tighter than + and ×. Functions: sqrt, cbrt, sin, cos, tan, asin, acos, atan (in ${calc.deg ? 'degrees' : 'radians'}), log (base 10), ln, log2, exp, abs, round, floor, ceil, min, max, hypot. Constants pi and e; <code>ans</code> is the last answer. Press Enter or = to keep a result.</p></div>`;
  }
  const histHTML = () => calc.hist.map(h => `<li><button type="button" class="linkish" data-ins="${esc(String(h.v))}">${esc(h.x)} = <b>${esc(show(h.v))}</b></button></li>`).join('');
  const show = v => (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e6 ? String(+v.toPrecision(10)) : v.toExponential(6)) + (Math.abs(v) >= 1e3 || (Math.abs(v) < 1 && v !== 0) ? `  (${eng(v)})` : '');
  function wireCalc(root) {
    const x = root.querySelector('#calcx'), out = root.querySelector('#calcout');
    const run = () => {
      if (!x.value.trim()) { out.innerHTML = '&nbsp;'; return null; }
      try { const v = evaluate(x.value, { deg: calc.deg, ans: calc.ans }); out.textContent = Number.isFinite(v) ? '= ' + show(v) : '= not a number'; return Number.isFinite(v) ? v : null; } catch (e) { out.textContent = e.message; return null; }
    };
    const keep = () => { const v = run(); if (v == null) return; calc.ans = v; calc.hist = [{ x: x.value.trim(), v }, ...calc.hist].slice(0, 12); root.querySelector('#calchist').innerHTML = histHTML(); x.select(); };
    x.addEventListener('input', run);
    x.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); keep(); } });
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-ins]');
      if (b) { const t = b.dataset.ins, p = x.selectionStart ?? x.value.length; x.value = x.value.slice(0, p) + t + x.value.slice(x.selectionEnd ?? p); x.focus(); x.setSelectionRange(p + t.length, p + t.length); run(); return; }
      if (e.target.id === 'calceq') keep();
      if (e.target.id === 'calcclr') { x.value = ''; run(); x.focus(); }
      if (e.target.id === 'calcdeg') { calc.deg = !calc.deg; e.target.textContent = calc.deg ? 'DEG' : 'RAD'; run(); }
    });
    x.focus();
  }

  // ---- Tools: fields in, results out, worked out as you type ----
  const E12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
  const e12up = r => { if (!(r > 0)) return NaN; const d = 10 ** Math.floor(Math.log10(r)); const v = E12.find(x => x * d >= r * 0.9999); return (v || 10) * d; };
  const WATTS = [0.125, 0.25, 0.5, 1, 2, 5, 10];
  const AWG = [['4/0', 107.2], ['3/0', 85], ['2/0', 67.4], ['1/0', 53.5], ['1', 42.4], ['2', 33.6], ['4', 21.2], ['6', 13.3], ['8', 8.37], ['10', 5.26], ['12', 3.31], ['14', 2.08], ['16', 1.31], ['18', 0.823], ['20', 0.518], ['22', 0.326], ['24', 0.205]];
  const MM2 = [0.5, 0.75, 1, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95];
  const SIZES = [...AWG.map(([g, a]) => [`${g} AWG (${a} mm²)`, a]), ...MM2.map(a => [`${a} mm²`, a])];
  const CHEM = { pb: ['Lead-acid or AGM (use half)', 0.5], lfp: ['Lithium iron phosphate (use 80%)', 0.8], li: ['Lithium-ion (use 80%)', 0.8] };
  const COL = [['black', '#000'], ['brown', '#7B3F00'], ['red', '#D32F2F'], ['orange', '#F57C00'], ['yellow', '#FBC02D'], ['green', '#388E3C'], ['blue', '#1976D2'], ['violet', '#7B1FA2'], ['grey', '#9E9E9E'], ['white', '#FFF'], ['gold', '#C9A227'], ['silver', '#B0B0B0']];
  const MULT = { black: 1, brown: 10, red: 100, orange: 1e3, yellow: 1e4, green: 1e5, blue: 1e6, violet: 1e7, grey: 1e8, white: 1e9, gold: 0.1, silver: 0.01 };
  const TOL = { brown: 1, red: 2, green: 0.5, blue: 0.25, violet: 0.1, grey: 0.05, gold: 5, silver: 10 };
  const swatch = c => `<span class="swatch" style="background:${(COL.find(x => x[0] === c) || [, '#ccc'])[1]}" aria-hidden="true"></span>${esc(c)}`;
  const UNITS = {
    length: [['mm', 1e-3], ['cm', 1e-2], ['m', 1], ['km', 1e3], ['in', 0.0254], ['ft', 0.3048], ['yd', 0.9144], ['mile', 1609.344]],
    mass: [['g', 1e-3], ['kg', 1], ['tonne', 1e3], ['oz', 0.028349523125], ['lb', 0.45359237], ['short ton', 907.18474]],
    volume: [['mL', 1e-6], ['L', 1e-3], ['m³', 1], ['US fl oz', 2.95735295625e-5], ['US gal', 0.003785411784], ['imp gal', 0.00454609], ['ft³', 0.028316846592]],
    pressure: [['Pa', 1], ['kPa', 1e3], ['bar', 1e5], ['psi', 6894.757293], ['atm', 101325], ['inHg', 3386.389], ['mmHg', 133.322387]],
    power: [['W', 1], ['kW', 1e3], ['hp', 745.699872], ['BTU/h', 0.29307107]],
    energy: [['J', 1], ['kJ', 1e3], ['Wh', 3600], ['kWh', 3.6e6], ['BTU', 1055.05585], ['kcal', 4184]],
    torque: [['N·m', 1], ['lbf·ft', 1.3558179], ['lbf·in', 0.11298483], ['kgf·m', 9.80665]],
    speed: [['m/s', 1], ['km/h', 1 / 3.6], ['mph', 0.44704], ['knot', 1852 / 3600]],
    temperature: [['°C'], ['°F'], ['K']],
  };
  const toC = (v, u) => (u === '°F' ? (v - 32) * 5 / 9 : u === 'K' ? v - 273.15 : v);
  const fromC = (c, u) => (u === '°F' ? c * 9 / 5 + 32 : u === 'K' ? c + 273.15 : c);

  // LoRa: Meshtastic's modem presets as spreading factor, bandwidth (kHz) and coding rate 4/(4+cr),
  // and the lowest signal-to-noise ratio each spreading factor still decodes (Semtech datasheets).
  const LORA = [['LONG_FAST', 'Long Fast (default)', 11, 250, 1], ['LONG_MODERATE', 'Long Moderate', 11, 125, 4], ['LONG_SLOW', 'Long Slow', 12, 125, 4],
    ['MEDIUM_SLOW', 'Medium Slow', 10, 250, 1], ['MEDIUM_FAST', 'Medium Fast', 9, 250, 1], ['SHORT_SLOW', 'Short Slow', 8, 250, 1], ['SHORT_FAST', 'Short Fast', 7, 250, 1], ['SHORT_TURBO', 'Short Turbo', 7, 500, 1]];
  const LORA_SNR = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };
  // Time on air in seconds by Semtech's formula: explicit header, CRC on, and low data rate
  // optimisation on when a symbol lasts longer than 16 ms.
  function airtime(sf, bwHz, cr, bytes, preamble) {
    const ts = 2 ** sf / bwHz, de = ts > 0.016 ? 1 : 0;
    const n = 8 + Math.max(Math.ceil((8 * bytes - 4 * sf + 28 + 16) / (4 * (sf - 2 * de))) * (cr + 4), 0);
    return { ts, de, s: (preamble + 4.25) * ts + n * ts };
  }

  // Each tool: fields (number fields read SI prefixes), and what it works out from them.
  const TOOLS = {
    ohm: {
      title: 'Ohm’s law and power', summary: 'Fill in any two of volts, amps, ohms and watts.',
      fields: [['V', 'Volts (V)'], ['I', 'Amps (A)'], ['R', 'Ohms (Ω)'], ['P', 'Watts (W)']],
      run(v) {
        const k = ['V', 'I', 'R', 'P'].filter(x => Number.isFinite(v[x]));
        if (k.length < 2) return 'Fill in any two.';
        let { V, I, R, P } = v;
        const two = k.slice(0, 2).join('');
        if (two === 'VI') { R = V / I; P = V * I; } else if (two === 'VR') { I = V / R; P = V * V / R; } else if (two === 'VP') { I = P / V; R = V * V / P; }
        else if (two === 'IR') { V = I * R; P = I * I * R; } else if (two === 'IP') { V = P / I; R = P / (I * I); } else { V = Math.sqrt(P * R); I = Math.sqrt(P / R); }
        return [['Volts', eng(V, 'V')], ['Amps', eng(I, 'A')], ['Ohms', eng(R, 'Ω')], ['Watts', eng(P, 'W')], ...(k.length > 2 ? [['Note', `Worked from ${k[0]} and ${k[1]}; clear the rest to use others.`]] : [])];
      },
    },
    led: {
      title: 'LED resistor', summary: 'The series resistor for one or more LEDs on a DC supply.',
      fields: [['Vs', 'Supply (V)', '12'], ['Vf', 'LED forward voltage (V)', '2', 'Red about 2 V; white and blue about 3 V'], ['ImA', 'LED current (mA)', '20'], ['n', 'LEDs in series', '1']],
      run(v) {
        const I = v.ImA / 1000, n = Math.max(1, Math.round(v.n || 1)), left = v.Vs - n * v.Vf;
        if (![v.Vs, v.Vf, I].every(Number.isFinite)) return 'Fill in the supply, forward voltage and current.';
        if (left <= 0) return 'The supply is too low for that many LEDs in series.';
        const R = left / I, std = e12up(R), Ia = left / std, P = Ia * Ia * std, Wr = WATTS.find(w => w >= P * 2) || 'over 10';
        return [['Exact resistor', eng(R, 'Ω')], ['Next standard (E12) up', eng(std, 'Ω')], ['Current with it', eng(Ia, 'A')], ['Heat in the resistor', eng(P, 'W')], ['Resistor rating', `${Wr} W or more`]];
      },
    },
    divider: {
      title: 'Voltage divider', summary: 'What two resistors in series give at their middle.',
      fields: [['Vin', 'Input (V)', '12'], ['R1', 'Top resistor R1 (Ω)', '10k'], ['R2', 'Bottom resistor R2 (Ω)', '4k7']],
      run(v) {
        if (![v.Vin, v.R1, v.R2].every(Number.isFinite)) return 'Fill in all three.';
        const I = v.Vin / (v.R1 + v.R2);
        return [['Output', eng(v.Vin * v.R2 / (v.R1 + v.R2), 'V')], ['Current through it', eng(I, 'A')], ['Heat in R1 and R2', `${eng(I * I * v.R1, 'W')}, ${eng(I * I * v.R2, 'W')}`], ['Note', 'Only for signals and sensing: a load on the output pulls the voltage down.']];
      },
    },
    seriespar: {
      title: 'Series and parallel', summary: 'Resistors (or capacitors) combined in series and in parallel.',
      fields: [['list', 'Values, separated by spaces or commas', '1k 2k2 4k7', '', 'text']],
      run(v, raw) {
        const xs = String(raw.list || '').split(/[\s,;]+/).filter(Boolean).map(num);
        if (!xs.length || xs.some(x => !Number.isFinite(x) || x <= 0)) return 'Type two or more values, such as 1k 2k2 4k7.';
        const series = xs.reduce((a, b) => a + b, 0), par = 1 / xs.reduce((a, b) => a + 1 / b, 0);
        return [['Resistors in series', eng(series, 'Ω')], ['Resistors in parallel', eng(par, 'Ω')], ['Capacitors in parallel', eng(series, 'F')], ['Capacitors in series', eng(par, 'F')]];
      },
    },
    rc: {
      title: 'RC time and capacitor discharge', summary: 'Time constant, filter cut-off, stored energy, and how long a resistor takes to drain a capacitor to a safe voltage.',
      fields: [['R', 'Resistance (Ω)', '10k'], ['C', 'Capacitance (F)', '470u'], ['V0', 'Charged to (V)', '400'], ['Vs', 'Safe voltage (V)', '1']],
      run(v) {
        if (![v.R, v.C].every(Number.isFinite)) return 'Fill in R and C.';
        const t = v.R * v.C, rows = [['Time constant (RC)', eng(t, 's')], ['Nearly empty (5 RC)', eng(5 * t, 's')], ['Filter cut-off 1/(2πRC)', eng(1 / (2 * Math.PI * t), 'Hz')]];
        if (Number.isFinite(v.V0)) {
          rows.push(['Stored energy ½CV²', eng(0.5 * v.C * v.V0 * v.V0, 'J')], ['Peak current V/R', eng(v.V0 / v.R, 'A')], ['Peak heat V²/R', eng(v.V0 * v.V0 / v.R, 'W')]);
          if (Number.isFinite(v.Vs) && v.Vs > 0 && v.Vs < v.V0) rows.push([`Time to ${v.Vs} V`, eng(t * Math.log(v.V0 / v.Vs), 's')]);
          rows.push(['Note', 'Measure with a meter before touching: a time is no proof.']);
        }
        return rows;
      },
    },
    t555: {
      title: '555 timer (astable)', summary: 'Frequency and on/off times of a 555 blinking or oscillating.',
      fields: [['R1', 'R1 (Ω)', '10k'], ['R2', 'R2 (Ω)', '100k'], ['C', 'C (F)', '10u']],
      run(v) {
        if (![v.R1, v.R2, v.C].every(Number.isFinite)) return 'Fill in R1, R2 and C.';
        const hi = 0.693 * (v.R1 + v.R2) * v.C, lo = 0.693 * v.R2 * v.C;
        return [['Frequency', eng(1 / (hi + lo), 'Hz')], ['On time', eng(hi, 's')], ['Off time', eng(lo, 's')], ['Duty (on share)', `${fix((hi / (hi + lo)) * 100, 1)}%`]];
      },
    },
    battery: {
      title: 'Battery runtime', summary: 'How long a battery runs a load, allowing for the usable share and an inverter.',
      fields: [['V', 'Battery (V)', '12'], ['Ah', 'Capacity (Ah)', '100'], ['chem', 'Chemistry', 'pb', '', 'select', Object.entries(CHEM).map(([k, [l]]) => [k, l])], ['W', 'Load (W)', '60'], ['inv', 'Through an inverter (AC load)', 'yes', '', 'select', [['yes', 'Yes, about 85% efficient'], ['no', 'No, a DC load']]]],
      run(v, raw) {
        if (![v.V, v.Ah, v.W].every(Number.isFinite)) return 'Fill in volts, amp-hours and the load.';
        const Wh = v.V * v.Ah, use = Wh * (CHEM[raw.chem] || CHEM.pb)[1], eff = raw.inv === 'no' ? 1 : 0.85, h = use * eff / v.W;
        return [['Stored', `${fix(Wh, 0)} Wh`], ['Usable', `${fix(use, 0)} Wh`], ['Runtime', `${fix(h, 1)} h (${fix(h / 24, 1)} days)`], ['Battery current', eng(v.W / eff / v.V, 'A')], ['Note', 'Less in the cold, with old batteries, and for lead-acid under heavy loads.']];
      },
    },
    solar: {
      title: 'Solar and battery sizing', summary: 'Panels and battery for a daily energy use, by sun hours and days without sun.',
      fields: [['Wh', 'Daily use (Wh)', '1000', 'Add up watts × hours for each load'], ['sun', 'Peak sun hours a day', '4', 'Southern Canada: about 1–2 in December, 5–6 in June'], ['V', 'System voltage (V)', '12'], ['days', 'Days of backup', '2'], ['chem', 'Battery', 'lfp', '', 'select', Object.entries(CHEM).map(([k, [l]]) => [k, l])]],
      run(v, raw) {
        if (![v.Wh, v.sun, v.V, v.days].every(Number.isFinite)) return 'Fill in all the numbers.';
        const panel = v.Wh / (v.sun * 0.75), dod = (CHEM[raw.chem] || CHEM.lfp)[1], Ah = (v.Wh * v.days) / (v.V * dod);
        return [['Panels', `${fix(panel, 0)} W or more (allowing about 25% for losses)`], ['Battery', `${fix(Ah, 0)} Ah at ${v.V} V (${fix(Ah * v.V / 1000, 1)} kWh)`], ['Charge controller', `about ${fix(panel / v.V * 1.25, 0)} A`]];
      },
    },
    vdrop: {
      title: 'Wire voltage drop', summary: 'How much voltage a copper wire run loses, and the smallest size that keeps it under 3%.',
      fields: [['A', 'Current (A)', '10'], ['L', 'One-way length (m)', '5'], ['size', 'Wire size', '13.3', '', 'select', SIZES.map(([l, a]) => [String(a), l])], ['V', 'System voltage (V)', '12']],
      run(v, raw) {
        const a = Number(raw.size);
        if (![v.A, v.L, v.V].every(Number.isFinite)) return 'Fill in current, length and voltage.';
        const drop = v.A * 0.0172 * 2 * v.L / a, need = 0.0172 * 2 * v.L * v.A / (0.03 * v.V), ok = SIZES.slice().sort((x, y) => x[1] - y[1]).find(([, s]) => s >= need);
        return [['Drop', `${fix(drop, 2)} V (${fix(drop / v.V * 100, 1)}%)`], ['Heat in the wire', eng(v.A * drop, 'W')], ['Smallest for 3% or less', ok ? ok[0] : 'bigger than 4/0 AWG: use a higher voltage'], ['Note', 'Copper at 20 °C, out and back. Also check the wire is rated for the current.']];
      },
    },
    lora_airtime: {
      title: 'LoRa airtime and range', summary: 'How long a message takes on air, how many the channel can carry, and the link budget and radio horizon for your radios.',
      fields: [['preset', 'Meshtastic preset', 'LONG_FAST', '', 'select', [...LORA.map(([k, l]) => [k, l]), ['custom', 'Custom: the next three fields']]],
        ['sf', 'Spreading factor (custom)', '11', '7 to 12'], ['bw', 'Bandwidth in kHz (custom)', '250'], ['cr', 'Coding rate 4/x (custom)', '5', '5 to 8'],
        ['bytes', 'Packet size (bytes)', '60', 'At most 255, headers included'], ['pre', 'Preamble (symbols)', '16', 'Meshtastic uses 16; LoRaWAN 8'],
        ['relays', 'Nodes that rebroadcast each message', '3'],
        ['tx', 'Transmit power (dBm)', '22'], ['gain', 'Antenna gains, both ends added (dBi)', '4'], ['loss', 'Cable and connector losses, both ends (dB)', '1'],
        ['mhz', 'Frequency (MHz)', '915'], ['h1', 'Antenna height here (m)', '2'], ['h2', 'Antenna height at the other end (m)', '10'],
        ['duty', 'Duty-cycle limit (%)', '100', '100 where there is none (Canada, the US); 1 or 10 in parts of Europe: see the LoRa bands card']],
      run(v, raw) {
        const p = LORA.find(x => x[0] === raw.preset);
        const [sf, bw, cr] = p ? p.slice(2) : [Math.round(v.sf), v.bw, Math.round(v.cr) - 4];
        if (!(sf >= 7 && sf <= 12) || !(bw > 0) || !(cr >= 1 && cr <= 4)) return 'Spreading factor 7 to 12, a bandwidth in kHz, and a coding rate of 5 to 8.';
        const bytes = Math.round(v.bytes);
        if (!(bytes >= 1 && bytes <= 255)) return 'A LoRa packet holds 1 to 255 bytes.';
        const { ts, de, s } = airtime(sf, bw * 1e3, cr, bytes, Number.isFinite(v.pre) ? v.pre : 16);
        const each = s * (1 + Math.max(0, Math.round(v.relays || 0)));
        const rows = [['Time on air', `${fix(s * 1000, 0)} ms (a symbol lasts ${fix(ts * 1000, 2)} ms${de ? '; low data rate optimisation on' : ''})`],
          ['Data rate', `${fix(sf * (bw * 1e3 / 2 ** sf) * (4 / (4 + cr)), 0)} bit/s`],
          ['Airtime with the rebroadcasts', `${fix(each, 2)} s per message`],
          ['Messages a minute', `${fix(60 / each, 1)} fill the channel; ${fix(15 / each, 1)} keep it 25 % busy`]];
        if (Number.isFinite(v.duty) && v.duty > 0 && v.duty < 100) rows.push(['Duty-cycle limit', `${fix(v.duty / 100 * 3600 / s, 0)} sends an hour from one radio`]);
        // Sensitivity from the noise floor: −174 dBm/Hz + bandwidth + a 6 dB noise figure + the SNR floor.
        const sens = -174 + 10 * Math.log10(bw * 1e3) + 6 + LORA_SNR[sf], budget = v.tx + (v.gain || 0) - (v.loss || 0) - sens;
        if (Number.isFinite(budget)) {
          rows.push(['Receiver sensitivity', `about ${fix(sens, 1)} dBm (calculated)`], ['Link budget', `${fix(budget, 1)} dB`]);
          // Free-space path loss in dB = 20 log d(km) + 20 log f(MHz) + 32.44, keeping 10 dB in hand.
          if (v.mhz > 0) { const km = 10 ** ((budget - 10 - 20 * Math.log10(v.mhz) - 32.44) / 20); rows.push(['Free-space limit', `${fix(km, km < 10 ? 1 : 0)} km with 10 dB to spare: only over clear, open line of sight`]); }
        }
        if (v.h1 >= 0 && v.h2 >= 0) rows.push(['Radio horizon', `${fix(4.12 * (Math.sqrt(v.h1) + Math.sqrt(v.h2)), 1)} km at these heights`]);
        rows.push(['Note', 'Expect the smaller of the two, cut further by hills, buildings and trees. Range-test every link.']);
        return rows;
      },
    },
    convert: {
      title: 'Unit converter', summary: 'Length, weight, volume, pressure, power, energy, torque, speed and temperature.',
      fields: [['x', 'Value', '1'], ['cat', 'What', 'pressure', '', 'select', Object.keys(UNITS).map(k => [k, k[0].toUpperCase() + k.slice(1)])], ['from', 'From', 'bar', '', 'select', null]],
      run(v, raw) {
        const list = UNITS[raw.cat] || UNITS.length, from = list.find(u => u[0] === raw.from) || list[0];
        if (!Number.isFinite(v.x)) return 'Type a value.';
        if (raw.cat === 'temperature') { const c = toC(v.x, from[0]); return list.map(([u]) => [u, fix(fromC(c, u), 2)]); }
        const base = v.x * from[1];
        return list.map(([u, f]) => [u, (Math.abs(base / f) >= 1e6 || Math.abs(base / f) < 1e-3) && base !== 0 ? (base / f).toExponential(4) : fix(base / f, 4)]);
      },
    },
    gear: {
      title: 'Pulleys and gears', summary: 'Output speed and torque from two pulley diameters or gear tooth counts.',
      fields: [['a', 'Driving pulley or gear (size or teeth)', '20'], ['b', 'Driven pulley or gear (size or teeth)', '60'], ['rpm', 'Input speed (rpm)', '1750']],
      run(v) {
        if (![v.a, v.b].every(Number.isFinite)) return 'Fill in both sizes.';
        const r = v.b / v.a;
        return [['Ratio', `${fix(r, 3)} : 1`], ['Output speed', Number.isFinite(v.rpm) ? `${fix(v.rpm / r, 1)} rpm` : '—'], ['Torque', `${fix(r, 2)} × the input (less friction)`]];
      },
    },
  };

  // The resistor colour code, both ways.
  function resistorHTML() {
    const sel = (id, list, def) => `<select id="${id}" class="rowin">${list.map(c => `<option value="${esc(c)}"${c === def ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
    const digits = COL.slice(0, 10).map(c => c[0]);
    return `<h3>Bands to value</h3><div class="calcform">
      <div class="field"><label for="rbn">Bands</label><select id="rbn" class="rowin"><option value="4">4 bands</option><option value="5">5 bands</option></select></div>
      <div class="field"><label for="rb1">1st</label>${sel('rb1', digits, 'brown')}</div><div class="field"><label for="rb2">2nd</label>${sel('rb2', digits, 'black')}</div>
      <div class="field" id="rb3f" hidden><label for="rb3">3rd</label>${sel('rb3', digits, 'black')}</div>
      <div class="field"><label for="rbm">Multiplier</label>${sel('rbm', Object.keys(MULT), 'red')}</div><div class="field"><label for="rbt">Tolerance</label>${sel('rbt', [...Object.keys(TOL), 'none'], 'gold')}</div></div>
      <dl class="calcres" id="rbout"></dl>
      <h3>Value to bands</h3><div class="calcform"><div class="field"><label for="rval">Value (Ω)</label><input id="rval" class="rowin" value="4k7" autocomplete="off"></div></div><dl class="calcres" id="rvout"></dl>`;
  }
  function wireResistor(root) {
    const g = id => root.querySelector('#' + id);
    const digits = COL.slice(0, 10).map(c => c[0]);
    const bands = () => {
      const five = g('rbn').value === '5';
      g('rb3f').hidden = !five;
      const ds = [g('rb1').value, g('rb2').value, ...(five ? [g('rb3').value] : [])].map(c => digits.indexOf(c)).join('');
      const val = Number(ds) * MULT[g('rbm').value], tol = TOL[g('rbt').value] || 20;
      g('rbout').innerHTML = `<dt>Value</dt><dd>${esc(eng(val, 'Ω'))} ±${esc(tol)}%</dd><dt>Range</dt><dd>${esc(eng(val * (1 - tol / 100), 'Ω'))} to ${esc(eng(val * (1 + tol / 100), 'Ω'))}</dd>`;
    };
    const reverse = () => {
      const v = num(g('rval').value);
      if (!(v > 0)) { g('rvout').innerHTML = '<dt>Value</dt><dd>Type a value such as 4k7 or 220.</dd>'; return; }
      const enc = sig => {
        const e = Math.floor(Math.log10(v)) - (sig - 1), d = Math.round(v / 10 ** e);
        let exp = e, ds = String(d);
        if (ds.length > sig) { ds = ds.slice(0, sig); exp += 1; }
        const multName = Object.keys(MULT).find(k => Math.abs(MULT[k] - 10 ** exp) < 10 ** exp * 1e-6);
        return multName ? [...ds].map(c => digits[+c]).concat(multName) : null;
      };
      const b4 = enc(2), b5 = enc(3);
      const line = b => (b ? b.map(swatch).join(' · ') : 'out of range');
      g('rvout').innerHTML = `<dt>4 bands (2 digits)</dt><dd>${line(b4)} · then tolerance (gold ±5%)</dd><dt>5 bands (3 digits)</dt><dd>${line(b5)} · then tolerance (brown ±1%)</dd>`;
    };
    root.addEventListener('change', bands);
    g('rval').addEventListener('input', reverse);
    bands(); reverse();
  }

  // ---- Rendering a tool ----
  function fieldHTML(t, [k, label, def, help, type, opts]) {
    const id = 'cf_' + k;
    if (type === 'select') {
      const list = opts || (UNITS[(t._cat || 'pressure')] || []).map(([u]) => [u, u]);
      return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" class="rowin" data-k="${esc(k)}">${list.map(([vv, l]) => `<option value="${esc(vv)}"${vv === def ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${help ? `<span class="help">${esc(help)}</span>` : ''}</div>`;
    }
    return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" class="rowin" data-k="${esc(k)}" value="${esc(def || '')}" autocomplete="off" inputmode="${type === 'text' ? 'text' : 'decimal'}">${help ? `<span class="help">${esc(help)}</span>` : ''}</div>`;
  }
  function toolHTML(id) {
    if (id === 'calc') return calcHTML();
    if (id === 'resistor') return resistorHTML();
    const t = TOOLS[id];
    return `<div class="calcform">${t.fields.map(f => fieldHTML(t, f)).join('')}</div><dl class="calcres" id="calcres"></dl><p class="hint">Numbers take SI prefixes: 4k7, 100n, 2.2M, 470u.</p>`;
  }
  function wire(id, root) {
    if (id === 'calc') return wireCalc(root);
    if (id === 'resistor') return wireResistor(root);
    const t = TOOLS[id];
    const run = () => {
      const raw = {}, v = {};
      root.querySelectorAll('[data-k]').forEach(el => { raw[el.dataset.k] = el.value; v[el.dataset.k] = num(el.value); });
      const r = t.run(v, raw);
      root.querySelector('#calcres').innerHTML = typeof r === 'string' ? `<dt>&nbsp;</dt><dd class="where">${esc(r)}</dd>` : r.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('');
    };
    // The converter's unit list follows the chosen kind of quantity.
    if (id === 'convert') {
      const cat = root.querySelector('[data-k="cat"]'), from = root.querySelector('[data-k="from"]');
      const fill = () => { from.innerHTML = UNITS[cat.value].map(([u]) => `<option value="${esc(u)}">${esc(u)}</option>`).join(''); };
      fill();
      from.value = 'bar';
      cat.addEventListener('change', () => { fill(); run(); });
    }
    root.addEventListener('input', run);
    root.addEventListener('change', run);
    run();
  }

  const LIST = [
    { id: 'calc', title: 'Engineering calculator', summary: 'Type an expression with SI prefixes (4k7, 100n) and parallel (1k || 2k2); trig, logs and a history.' },
    { id: 'resistor', title: 'Resistor colour code', summary: 'Bands to value, and a value to its bands.' },
    ...Object.entries(TOOLS).map(([id, t]) => ({ id, title: t.title, summary: t.summary })),
  ];
  const get = id => LIST.find(x => x.id === id);
  return { LIST, get, toolHTML, wire, evaluate, num, eng, airtime };
})();

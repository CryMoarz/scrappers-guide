// Fill-in forms generated from the record schema, so every record type (and any field added to
// the schema later) gets a form without new code. Raw JSON editing stays available as an option.
const Forms = (() => {
  const esc = MD.esc;
  let uid = 0;
  const nid = () => 'f' + (++uid);
  const D = s => SDG.schema.deref(s);
  const isRating = s => s['x-widget'] === 'rating' || (s.type === 'integer' && s.minimum === 1 && s.maximum === 5);

  function refOptions(ref, ctx) {
    if (ref.startsWith('vocab.')) {
      const v = ctx.ds.vocab[ref.slice(6)] || [];
      return Array.isArray(v) ? v.map(x => ({ v: x, t: x })) : Object.entries(v).map(([k, t]) => ({ v: k, t: `${t} (${k})` }));
    }
    const list = (ctx.ds[ref] || []).filter(r => !r.deprecated);
    return list.map(r => ({ v: r.id, t: (r.name || r.title || r.label || r.id) + (r.name || r.title || r.label ? ` (${r.id})` : ''), g: r.group || r.kind }))
      .sort((a, b) => String(a.g || '').localeCompare(String(b.g || '')) || a.t.localeCompare(b.t));
  }
  function optionsHTML(opts, value, blank) {
    const groups = {};
    opts.forEach(o => (groups[o.g || ''] = groups[o.g || ''] || []).push(o));
    const one = o => `<option value="${esc(o.v)}"${String(o.v) === String(value) ? ' selected' : ''}>${esc(o.t)}</option>`;
    const known = opts.some(o => String(o.v) === String(value));
    return (blank ? '<option value="">—</option>' : '') + (!known && value != null && value !== '' ? `<option value="${esc(value)}" selected>${esc(value)} (unknown)</option>` : '') +
      Object.entries(groups).map(([g, os]) => (g ? `<optgroup label="${esc(g)}">${os.map(one).join('')}</optgroup>` : os.map(one).join(''))).join('');
  }
  function wrapField(path, s, key, inner, required) {
    const label = s.title || key;
    return `<div class="field" data-path="${esc(path)}"><label>${esc(label)}${required ? ' *' : ''}${s.description ? `<span class="help">${esc(s.description)}</span>` : ''}</label>${inner}<div class="ferr"></div></div>`;
  }

  // Builds one node. Returns {html, read(root)}; read pulls the value back out of the DOM.
  function build(raw, value, path, key, ctx, required) {
    const s = D(raw);
    if (!s || s['x-readonly']) return null;
    const id = nid();
    const types = [].concat(s.type || (s.enum ? 'string' : 'object'));
    const t = types.find(x => x !== 'null');
    const nullable = types.includes('null');
    const q = root => root.querySelector('#' + id);

    if (s['x-widget'] === 'range') {
      const shown = Array.isArray(value) ? value.join('-') : value == null ? '' : value;
      const inner = `<input id="${id}" inputmode="decimal" value="${esc(shown)}" placeholder="12 or 100-240">`;
      return { html: wrapField(path, s, key, inner, required), read: r => SDG.specs.amount(q(r).value) };
    }
    if (s.enum && !s.type || (t === 'string' && s.enum)) {
      const html = wrapField(path, s, key, `<select id="${id}">${optionsHTML(s.enum.map(v => ({ v, t: v })), value, true)}</select>`, required);
      return { html, read: r => q(r).value || undefined };
    }
    if (t === 'string') {
      let inner;
      if (s['x-ref']) inner = `<select id="${id}">${optionsHTML(refOptions(s['x-ref'], ctx), value, true)}</select>`;
      else if (s['x-widget'] === 'textarea') inner = `<textarea id="${id}" maxlength="${esc(s.maxLength || '')}">${esc(value || '')}</textarea>`;
      else inner = `<input id="${id}" value="${esc(value == null ? '' : value)}" maxlength="${esc(s.maxLength || '')}">`;
      return { html: wrapField(path, s, key, inner, required), read: r => { const v = q(r).value.trim(); return v === '' ? undefined : v; } };
    }
    if (t === 'number' || t === 'integer') {
      const inner = isRating(s)
        ? `<select id="${id}">${optionsHTML([1, 2, 3, 4, 5].map(v => ({ v, t: String(v) })), value, true)}</select>`
        : `<input id="${id}" type="number" step="${t === 'integer' ? 1 : 'any'}" ${s.minimum != null ? `min="${esc(s.minimum)}"` : ''} ${s.maximum != null ? `max="${esc(s.maximum)}"` : ''} value="${value == null ? '' : esc(value)}" placeholder="${nullable ? 'empty = none' : ''}">`;
      return { html: wrapField(path, s, key, inner, required), read: r => { const v = q(r).value; return v === '' ? (nullable ? null : undefined) : Number(v); } };
    }
    if (t === 'boolean') {
      const html = `<div class="field" data-path="${esc(path)}"><label class="toggle"><input id="${id}" type="checkbox"${value ? ' checked' : ''}> ${esc(s.title || key)}</label>${s.description ? `<span class="help hint" style="margin:0">${esc(s.description)}</span>` : ''}<div class="ferr"></div></div>`;
      return { html, read: r => (q(r).checked ? true : undefined) };
    }
    if (t === 'array') {
      const it = D(s.items || {});
      const arr = Array.isArray(value) ? value : [];
      if (it.type === 'string' && it['x-ref']) {
        const opts = refOptions(it['x-ref'], ctx);
        const sel = new Set(arr);
        const filter = opts.length > 12 ? `<input type="search" placeholder="Filter" data-filter="${id}">` : '';
        const inner = `<div class="multi" id="${id}">${filter}${opts.map(o => `<label data-t="${esc(String(o.t).toLowerCase())}"><input type="checkbox" value="${esc(o.v)}"${sel.has(o.v) ? ' checked' : ''}> ${esc(o.t)}</label>`).join('')}</div>`;
        return { html: wrapField(path, s, key, inner, required), read: r => { const v = [...q(r).querySelectorAll('input[type=checkbox]:checked')].map(x => x.value); const keep = arr.filter(x => v.includes(x)); return [...keep, ...v.filter(x => !keep.includes(x))]; } };
      }
      if (it.type === 'string' || !it.type && !it.properties) {
        const inner = `<textarea id="${id}" placeholder="One per line">${esc(arr.join('\n'))}</textarea>`;
        return { html: wrapField(path, s, key, inner, required), read: r => q(r).value.split('\n').map(x => x.trim()).filter(Boolean) };
      }
      // Array of objects: repeating rows.
      const rows = arr.map((v, i) => build(s.items, v, `${path}[${i}]`, String(i + 1), ctx, false));
      const html = `<fieldset class="sf" data-path="${esc(path)}" id="${id}"><legend>${esc(s.title || key)}${required ? ' *' : ''}</legend>${s.description ? `<div class="help hint" style="margin:0 0 6px">${esc(s.description)}</div>` : ''}
        <div class="rows">${rows.map((r, i) => `<div class="rowbox" data-row="${i}">${r.html}<div class="rowbar"><button type="button" class="btn small ghost" data-act="up" data-arr="${id}" data-i="${i}" aria-label="Move up">↑</button><button type="button" class="btn small ghost" data-act="down" data-arr="${id}" data-i="${i}" aria-label="Move down">↓</button><button type="button" class="btn small danger" data-act="rm" data-arr="${id}" data-i="${i}">Remove</button></div></div>`).join('')}</div>
        <button type="button" class="btn small ghost" data-act="add" data-arr="${id}" style="margin-top:8px">Add</button><div class="ferr"></div></fieldset>`;
      const node = { html, rows, read: r => rows.map(x => x.read(r)).filter(v => v && Object.keys(v).length) };
      ARRAYS.set(id, { s, path, key, ctx, required, node });
      return node;
    }
    // Object
    const props = s.properties || {};
    const req = new Set(s.required || []);
    const kids = Object.keys(props).map(k => [k, build(props[k], value ? value[k] : undefined, path ? `${path}.${k}` : k, k, ctx, req.has(k))]).filter(([, n]) => n);
    const inner = kids.map(([, n]) => n.html).join('');
    const html = path && !/\]$/.test(path) ? `<fieldset class="sf" data-path="${esc(path)}"><legend>${esc(s.title || key)}</legend>${inner}</fieldset>` : /\]$/.test(path) ? `<div class="rowgrid">${inner}</div>` : inner;
    return {
      html,
      read: r => {
        const o = {};
        kids.forEach(([k, n]) => { const v = n.read(r); if (v !== undefined && !(Array.isArray(v) && !v.length && !req.has(k))) o[k] = v; });
        // An optional group left blank (a job part's ratings) is left out, not saved as {}.
        return path && !/\]$/.test(path) && !Object.keys(o).length ? undefined : o;
      },
    };
  }
  const ARRAYS = new Map();

  // Mounts a form for a record into `el`. Returns {read(), showErrors(errors)}.
  function mount(el, coll, record, ctx, opts) {
    opts = opts || {};
    let value = SDG.util.clone(record || {});
    const schema = SDG.schema.schemaFor(coll);
    let root;
    function render() {
      const s = Object.assign({}, schema, { properties: Object.assign({}, schema.properties) });
      if (!opts.isNew) delete s.properties.id;
      root = build(s, value, '', '', ctx, false);
      el.innerHTML = `<div class="formbody">${root.html}</div><div class="err" data-summary></div>`;
      el.querySelectorAll('[data-filter]').forEach(f => f.addEventListener('input', () => {
        const box = el.querySelector('#' + f.dataset.filter);
        const term = f.value.toLowerCase();
        box.querySelectorAll('label[data-t]').forEach(l => (l.style.display = !term || l.dataset.t.includes(term) ? '' : 'none'));
      }));
    }
    const read = () => { const v = root.read(el); if (!opts.isNew && value.id) v.id = value.id; ['rev', 'updated'].forEach(k => { if (value[k] !== undefined) v[k] = value[k]; }); return v; };
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-act][data-arr]');
      if (!b) return;
      const arrInfo = ARRAYS.get(b.dataset.arr);
      if (!arrInfo) return;
      value = read();
      const getAt = (o, p) => p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce((a, k) => (a == null ? a : a[k]), o);
      const parentPath = arrInfo.path;
      let arr = getAt(value, parentPath);
      if (!Array.isArray(arr)) {
        arr = [];
        const parts = parentPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
        let o = value;
        parts.slice(0, -1).forEach(k => (o = o[k] = o[k] || {}));
        o[parts[parts.length - 1]] = arr;
      }
      const i = +b.dataset.i;
      if (b.dataset.act === 'add') arr.push({});
      if (b.dataset.act === 'rm') arr.splice(i, 1);
      if (b.dataset.act === 'up' && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      if (b.dataset.act === 'down' && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    });
    function showErrors(errors) {
      el.querySelectorAll('.field.bad,.sf.bad').forEach(f => f.classList.remove('bad'));
      el.querySelectorAll('.ferr').forEach(f => (f.textContent = ''));
      const loose = [];
      (errors || []).forEach(e => {
        let p = e.path === '(record)' ? '' : e.path;
        let f = null;
        while (p && !(f = el.querySelector(`[data-path="${CSS.escape(p)}"]`))) p = p.replace(/(\.[^.[\]]+|\[\d+\])$/, '');
        if (f) { f.classList.add('bad'); const fe = f.querySelector(':scope > .ferr'); if (fe) fe.textContent += (fe.textContent ? '; ' : '') + (p === e.path ? '' : e.path.slice(p.length).replace(/^\./, '') + ' ') + e.msg; }
        else loose.push(`${e.path} ${e.msg}`);
      });
      el.querySelector('[data-summary]').textContent = (errors && errors.length ? `${errors.length} thing${errors.length > 1 ? 's' : ''} to fix.` : '') + (loose.length ? '\n' + loose.join('\n') : '');
      const first = el.querySelector('.bad');
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    render();
    return { read, showErrors };
  }

  return { mount };
})();

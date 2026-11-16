// Board pinouts, drawn from pin tables rather than pasted in as pictures: a few kilobytes each, sharp
// when printed, and the same colours on every board for the pins that bite (boot and strapping
// pins, input-only pins, power). Pin facts come from the makers' datasheets and docs, listed per board.
const Pinouts = (() => {
  const esc = MD.esc; // this file runs before app.js defines its own
  const META = { id: 'pinouts', title: 'Board pinouts', summary: 'Pin maps of common microcontroller boards and the Raspberry Pi header, with the boot, strapping and power pins marked.' };
  // What each colour means, in the order a pin takes its colour from: a boot pin that is also a
  // GPIO shows as boot, and a GPIO that can also be serial shows as a GPIO (its other jobs are in
  // the pin table), so only dedicated pins such as SDA or TX get the bus colours. Fixed colours,
  // like warning labels, so they read the same in both themes.
  const KINDS = [
    ['gnd', 'Ground', '#222', '#fff'], ['power', 'Power', '#C62828', '#fff'], ['flash', 'Used by flash: leave alone', '#9E9E9E', '#111'],
    ['nc', 'Not connected', '#BDBDBD', '#111'], ['reset', 'Reset or enable', '#6D4C41', '#fff'], ['boot', 'Boot or strapping: careful', '#F9A825', '#111'],
    ['input', 'Input only', '#7B1FA2', '#fff'], ['adc', 'Analog in', '#2E7D32', '#fff'], ['gpio', 'Digital in/out', '#ECEFF1', '#111'],
    ['i2c', 'I2C', '#1565C0', '#fff'], ['spi', 'SPI', '#00838F', '#fff'], ['uart', 'Serial', '#3949AB', '#fff'],
    ['pwm', 'PWM', '#AD1457', '#fff'], ['other', 'Other', '#CFD8DC', '#111'],
  ];
  const ORDER = KINDS.map(k => k[0]);
  const kindOf = p => ORDER.find(k => (p.k || []).includes(k)) || 'other';
  const colours = k => KINDS.find(x => x[0] === k) || KINDS[KINDS.length - 1];
  let BOARDS = [];

  const W = 360, H = 21, LABEL = 118, BODY = 84, PAD = 10, GAP = 26;
  // One pin: the lead from its label to its pad on the board's edge, the pad, then the label drawn
  // over the lead's end. Labels are cut to fit, keeping room for the warning mark.
  function pin(p, cx, cy, w, px, py) {
    const [, , bg, fg] = colours(kindOf(p)), room = Math.max(3, Math.floor(w / 6.6) - (p.warn ? 2 : 0));
    const text = String(p.n).slice(0, room) + (p.warn ? ' ⚠' : '');
    return `<line x1="${cx}" y1="${cy}" x2="${px}" y2="${py}" class="pin-lead"/><rect x="${px - 4}" y="${py - 4}" width="8" height="8" rx="1.5" class="pin-pad"/>`
      + `<rect x="${cx - w / 2}" y="${cy - 8}" width="${w}" height="16" rx="8" fill="${bg}"${bg === '#ECEFF1' ? ' stroke="#90A4AE"' : ''}/>`
      + `<text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${fg}">${esc(text)}</text>`;
  }
  // The board as held in its `view`: pins down the left and right edges, and on some boards a few
  // along the top or bottom edge, drawn as a row of labels above or below it.
  function svg(b) {
    const L = b.left || [], R = b.right || [], T = b.top || [], B = b.bottom || [];
    const rows = Math.max(L.length, R.length, 1), bx = (W - BODY) / 2;
    const bodyTop = T.length ? 12 + 8 + GAP : 10, sides = bodyTop + 12, bodyBottom = sides + rows * H + 6;
    const h = B.length ? bodyBottom + GAP + 18 : bodyBottom + 10;
    const side = (pins, left) => pins.map((p, i) => (p ? pin(p, left ? PAD + LABEL / 2 : W - PAD - LABEL / 2, sides + i * H + H / 2, LABEL, left ? bx : bx + BODY, sides + i * H + H / 2) : '')).join('');
    const edge = (pins, y, py) => { const w = Math.min(LABEL, (W - 2 * PAD) / pins.length - 4); return pins.map((p, j) => (p ? pin(p, PAD + ((j + 0.5) * (W - 2 * PAD)) / pins.length, y, w, bx + ((j + 0.5) * BODY) / pins.length, py) : '')).join(''); };
    const mid = (bodyTop + bodyBottom) / 2;
    return `<svg viewBox="0 0 ${W} ${h}" class="pinout" role="img" aria-label="${esc(b.name)} pinout, ${esc(b.view)}">
      <rect x="${bx}" y="${bodyTop}" width="${BODY}" height="${bodyBottom - bodyTop}" rx="6" class="pin-body"/>
      <text x="${W / 2}" y="${mid}" text-anchor="middle" class="pin-chip" transform="rotate(-90 ${W / 2} ${mid})">${esc(String(b.chip).split(' (')[0].slice(0, Math.floor((bodyBottom - bodyTop - 12) / 6.6)))}</text>
      ${side(L, true)}${side(R, false)}${T.length ? edge(T, 20, bodyTop) : ''}${B.length ? edge(B, bodyBottom + GAP, bodyBottom) : ''}</svg>`;
  }
  const legend = () => `<div class="pin-legend">${KINDS.map(([k, label, bg, fg]) => `<span style="background:${bg};color:${fg}${k === 'gpio' ? ';border:1px solid #90A4AE' : ''}">${esc(label)}</span>`).join('')}</div>`;
  // Boards are linked by id (#ref/pinouts/esp32_devkitc_v4), which stays put when a name is reworded.
  const anchor = b => `#ref/pinouts/${esc(b.id)}`;
  const SIDES = [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']];
  const sourcesHTML = b => `${b.header_order_source ? `<p class="hint">Header order from: ${esc(b.header_order_source)}</p>` : ''}${(b.sources || []).length ? `<p class="hint">Sources: ${b.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`).join('; ')}</p>` : ''}`;
  const notesHTML = b => ((b.notes || []).length ? `<ul class="pin-notes">${b.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '');
  function boardHTML(b) {
    const head = `<section class="pinboard"><h3 data-jump="${esc(b.id)}">${esc(b.name)}</h3><p class="where">${esc(b.chip)} · ${esc(b.logic)} logic${b.view ? ` · ${esc(b.view)}` : ''}</p>`;
    // A clone with the same pins as another board points to it rather than repeating the drawing.
    const same = b.same_as && BOARDS.find(x => x.id === b.same_as);
    if (same) return `${head}<p>Same pins as <a href="${anchor(same)}">${esc(same.name)}</a>.</p>${notesHTML(b)}${sourcesHTML(b)}</section>`;
    const all = SIDES.flatMap(([k, label]) => (b[k] || []).map((p, i) => p && Object.assign({ at: `${label} ${i + 1}` }, p))).filter(Boolean);
    const warn = all.filter(p => p.warn);
    return `${head}${svg(b)}
      ${warn.length ? `<h4>Watch out</h4><ul>${warn.map(p => `<li><b>${esc(p.n)}</b> (${esc(p.at)}): ${esc(p.warn)}</li>`).join('')}</ul>` : ''}${notesHTML(b)}
      <details><summary>Every pin</summary><table class="pintable"><thead><tr><th>Pin</th><th>Where</th><th>Kind</th><th>Also</th></tr></thead><tbody>${all.map(p => `<tr><td>${esc(p.n)}</td><td>${esc(p.at)}</td><td>${esc(colours(kindOf(p))[1])}</td><td>${esc(p.alt || '')}${p.warn ? ` <b>${esc(p.warn)}</b>` : ''}</td></tr>`).join('')}</tbody></table>
      ${sourcesHTML(b)}</details></section>`;
  }
  function html() {
    return `<p>Pin maps of boards you are likely to find or carry. Each is drawn the way it says under its name. Pins marked ⚠ can stop a board booting or damage it if wired wrong. Check against the printing on your own board: clones vary.</p>
      ${legend()}${[['Boards', BOARDS.filter(b => !b.clone)], ['Clones and knock-offs', BOARDS.filter(b => b.clone)]].filter(([, l]) => l.length).map(([t, l]) => `<p class="hint">${t}: ${l.map(b => `<a href="${anchor(b)}">${esc(b.name)}</a>`).join(' · ')}</p>`).join('')}
      ${BOARDS.map(boardHTML).join('')}`;
  }
  // Pin tables live in their own file so they can be checked and corrected on their own.
  const use = boards => { BOARDS = boards; };
  return { META, html, use, svg, kindOf, get boards() { return BOARDS; } };
})();

// Quick reference: the warning labels card, drawn here because it is pictures (standard symbols,
// simplified), and the list of reference cards around it. The other cards are ordinary guides of
// kind "reference" in the data, so anyone can correct them.
const Ref = (() => {
  const esc = MD.esc; // this file runs before app.js defines its own
  const RED = '#E2231A', YELLOW = '#F9D71C', INK = '#111';
  const svg = (inner, label, cls) => `<svg viewBox="0 0 100 100" class="picto${cls ? ' ' + cls : ''}" role="img" aria-label="${esc(label)}">${inner}</svg>`;
  const ring = (cx, cy, r, w) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="${w}"/>`;
  const at = (a, r, cx = 50, cy = 50) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)].map(n => n.toFixed(1)).join(' ');
  const star = (cx, cy, r1, r2, n, fill) => `<polygon fill="${fill}" points="${Array.from({ length: n * 2 }, (_, i) => at((i * 180) / n - 90, i % 2 ? r2 : r1, cx, cy)).join(' ')}"/>`;
  const FLAME = 'M50 20 C59 33 69 40 67 55 C66 65 59 71 50 71 C40 71 33 65 33 55 C33 47 39 42 42 34 C45 41 46 46 50 48 C50 39 47 31 50 20 Z';
  // Glyphs drawn in a 100-unit box around the middle; frames put them in a diamond or triangle.
  const G = {
    excl: '<rect x="44" y="24" width="12" height="36" rx="3"/><circle cx="50" cy="72" r="6.5"/>',
    flame: `<path d="${FLAME}"/><rect x="30" y="73" width="40" height="5" rx="2"/>`,
    oxidiser: `<g transform="translate(17 -8) scale(0.66)"><path d="${FLAME}"/></g><circle cx="50" cy="64" r="11" fill="none" stroke="${INK}" stroke-width="6"/><rect x="30" y="78" width="40" height="4" rx="2"/>`,
    bomb: `<circle cx="46" cy="58" r="12"/>${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<line x1="${at(a, 16, 46, 58).split(' ')[0]}" y1="${at(a, 16, 46, 58).split(' ')[1]}" x2="${at(a, 27, 46, 58).split(' ')[0]}" y2="${at(a, 27, 46, 58).split(' ')[1]}" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`).join('')}<rect x="66" y="28" width="6" height="6" transform="rotate(30 69 31)"/><rect x="24" y="30" width="5" height="5" transform="rotate(-20 26 32)"/>`,
    cylinder: '<rect x="24" y="43" width="42" height="20" rx="10"/><rect x="65" y="48" width="8" height="10"/><rect x="73" y="45" width="5" height="16" rx="1"/>',
    corrosion: `<rect x="24" y="22" width="9" height="22" rx="2" transform="rotate(-35 28 33)"/><rect x="58" y="22" width="9" height="22" rx="2" transform="rotate(35 62 33)"/><ellipse cx="36" cy="52" rx="2.5" ry="4"/><ellipse cx="64" cy="52" rx="2.5" ry="4"/><polygon points="22,72 26,66 30,72 34,66 38,72 42,66 46,72 46,80 22,80"/><path d="M54 80 V68 c0-3 4-3 4 0 v-6 c0-3 4-3 4 0 v4 c0-3 4-3 4 0 v4 c0-3 4-3 4 0 v10 Z"/>`,
    skull: `<g transform="rotate(28 50 70)"><rect x="22" y="66" width="56" height="7" rx="3.5"/><circle cx="23" cy="66" r="4"/><circle cx="23" cy="73" r="4"/><circle cx="77" cy="66" r="4"/><circle cx="77" cy="73" r="4"/></g><g transform="rotate(-28 50 70)"><rect x="22" y="66" width="56" height="7" rx="3.5"/><circle cx="23" cy="66" r="4"/><circle cx="23" cy="73" r="4"/><circle cx="77" cy="66" r="4"/><circle cx="77" cy="73" r="4"/></g><circle cx="50" cy="40" r="15"/><rect x="41" y="47" width="18" height="11" rx="3"/><circle cx="44" cy="39" r="4" fill="#fff"/><circle cx="56" cy="39" r="4" fill="#fff"/>`,
    health: `<circle cx="50" cy="27" r="8"/><path d="M28 78 C28 56 38 45 50 45 C62 45 72 56 72 78 Z"/>${star(50, 61, 11, 5, 8, '#fff')}`,
    environment: `<g stroke="${INK}" stroke-width="3.5" stroke-linecap="round" fill="none"><path d="M32 74 V34 M32 50 L22 40 M32 44 L42 32 M32 60 L42 52"/><path d="M14 76 H86"/></g><ellipse cx="64" cy="66" rx="13" ry="6"/><polygon points="76,66 86,59 86,73"/><circle cx="58" cy="65" r="1.6" fill="#fff"/>`,
    bio: `${[270, 30, 150].map(a => ring(...at(a, 12).split(' ').map(Number), 13, 5)).join('')}<circle cx="50" cy="50" r="5"/>`,
    bolt: '<polygon points="56,18 32,56 47,56 40,84 68,42 53,42 62,18"/>',
    laser: `${star(50, 50, 30, 8, 12, INK)}<circle cx="50" cy="50" r="7"/><rect x="6" y="47" width="36" height="6"/>`,
    radiation: `<circle cx="50" cy="50" r="6"/>${[-90, 30, 150].map(a => `<path d="M${at(a - 30, 10)} L${at(a - 30, 30)} A30 30 0 0 1 ${at(a + 30, 30)} L${at(a + 30, 10)} A10 10 0 0 0 ${at(a - 30, 10)} Z"/>`).join('')}`,
    magnet: `<path d="M34 28 V50 A16 16 0 0 0 66 50 V28" fill="none" stroke="${INK}" stroke-width="10"/><g fill="none" stroke="${INK}" stroke-width="2.5"><path d="M24 30 C14 50 20 72 40 80"/><path d="M76 30 C86 50 80 72 60 80"/></g>`,
    hot: `<g fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"><path d="M36 64 C30 56 42 50 36 42 C30 34 42 28 36 22"/><path d="M50 64 C44 56 56 50 50 42 C44 34 56 28 50 22"/><path d="M64 64 C58 56 70 50 64 42 C58 34 70 28 64 22"/></g><rect x="24" y="70" width="52" height="8" rx="2"/>`,
    crush: `<circle cx="37" cy="58" r="13"/><circle cx="63" cy="58" r="13"/><path d="M50 18 V36" stroke="${INK}" stroke-width="5"/><polygon points="42,34 58,34 50,44"/>`,
  };
  const ghs = (g, label) => svg(`<polygon points="50,4 96,50 50,96 4,50" fill="#fff" stroke="${RED}" stroke-width="7" stroke-linejoin="round"/><g fill="${INK}" transform="translate(50 50) scale(0.74) translate(-50 -50)">${G[g]}</g>`, label);
  const iso = (g, label) => svg(`<polygon points="50,7 95,87 5,87" fill="${YELLOW}" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/><g fill="${INK}" transform="translate(50 62) scale(0.5) translate(-50 -50)">${G[g]}</g>`, label);
  const whmisBio = label => svg(`<circle cx="50" cy="50" r="45" fill="#fff" stroke="${INK}" stroke-width="5"/><g fill="${INK}" color="${INK}" transform="translate(50 50) scale(0.8) translate(-50 -50)">${G.bio}</g>`, label);
  // A transport placard: the class colour (or the top and bottom colours), and its number.
  let uid = 0;
  const placard = (cls, top, bottom, stripes, label) => {
    const id = 'stripe' + uid++;
    const fill = c => (c === 'stripes' ? `url(#${id})` : c);
    const defs = stripes ? `<defs><pattern id="${id}" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#fff"/><rect width="5" height="10" fill="${stripes}"/></pattern></defs>` : '';
    const dark = /^#(111|1F5FA8|E2231A|2E8540)$/i.test(bottom);
    return svg(`${defs}<polygon points="50,4 96,50 4,50" fill="${fill(top)}"/><polygon points="4,50 96,50 50,96" fill="${fill(bottom)}"/><polygon points="50,4 96,50 50,96 4,50" fill="none" stroke="${INK}" stroke-width="2"/><text x="50" y="86" text-anchor="middle" font-size="15" font-weight="700" fill="${dark ? '#fff' : INK}">${esc(cls)}</text>`, label);
  };
  const nfpa = svg(`<polygon points="50,4 73,27 50,50 27,27" fill="#E2231A"/><polygon points="27,27 50,50 27,73 4,50" fill="#1F5FA8"/><polygon points="73,27 96,50 73,73 50,50" fill="${YELLOW}"/><polygon points="50,50 73,73 50,96 27,73" fill="#fff"/><polygon points="50,4 96,50 50,96 4,50" fill="none" stroke="${INK}" stroke-width="2"/><g font-size="16" font-weight="700" text-anchor="middle"><text x="50" y="33" fill="#fff">4</text><text x="27" y="56" fill="#fff">3</text><text x="73" y="56" fill="${INK}">1</text><text x="50" y="79" fill="${INK}">W̶</text></g>`, 'NFPA 704 diamond');
  // Plain markings, in the page's own ink.
  const P = {
    class2: '<rect x="18" y="18" width="64" height="64" fill="none" stroke="currentColor" stroke-width="6"/><rect x="33" y="33" width="34" height="34" fill="none" stroke="currentColor" stroke-width="6"/>',
    earth: '<g stroke="currentColor" stroke-width="6" stroke-linecap="round"><path d="M50 14 V50 M26 50 H74 M34 62 H66 M42 74 H58"/></g>',
    ac: '<path d="M12 50 C24 20 38 20 50 50 S76 80 88 50" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>',
    dc: '<g stroke="currentColor" stroke-width="6" stroke-linecap="round"><path d="M14 40 H86"/><path d="M14 60 H30 M42 60 H58 M70 60 H86"/></g>',
    polarity: '<g fill="none" stroke="currentColor" stroke-width="4"><path d="M58 38 A14 14 0 1 0 58 62"/><path d="M50 50 H78 M28 50 H36"/></g><circle cx="50" cy="50" r="5" fill="currentColor"/><g fill="currentColor" font-size="18" font-weight="700" text-anchor="middle"><text x="88" y="56">+</text><text x="16" y="56">−</text></g>',
    bin: '<g fill="none" stroke="currentColor" stroke-width="4"><path d="M30 34 L35 76 H65 L70 34 Z"/><path d="M26 30 H74"/><path d="M44 30 V24 H56 V30"/></g><circle cx="38" cy="81" r="4" fill="currentColor"/><g stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M20 18 L80 86 M80 18 L20 86"/></g>',
    resin: n => `<path d="M50 14 L86 76 H14 Z" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/><text x="50" y="66" text-anchor="middle" font-size="30" font-weight="700" fill="currentColor">${n}</text>`,
  };
  const plain = (g, label) => svg(P[g], label, 'plain');

  const item = (icon, name, what) => `<div class="picto-item">${icon}<div><b>${esc(name)}</b><span>${esc(what)}</span></div></div>`;
  const section = (title, intro, items) => `<h3>${esc(title)}</h3>${intro ? `<p class="where">${esc(intro)}</p>` : ''}<div class="picto-grid">${items.join('')}</div>`;
  const table = (head, rows) => `<div class="tbl"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  function labelsHTML() {
    return `<p>The symbols on containers, machines, vehicles and devices, and what they mean for someone salvaging. Shapes and colours are standard; the drawings here are simplified.</p>
    ${section('Chemical hazard pictograms (GHS, WHMIS in Canada)', 'A red diamond on a container or safety data sheet. One container can carry several.', [
      item(ghs('bomb', 'Exploding bomb'), 'Exploding bomb', 'Explosive, self-reactive or organic peroxide: can blow up from heat, shock or friction.'),
      item(ghs('flame', 'Flame'), 'Flame', 'Flammable gas, liquid or solid, or something that heats itself or gives off flammable gas in water.'),
      item(ghs('oxidiser', 'Flame over circle'), 'Flame over circle', 'Oxidiser: makes a fire burn hotter and faster. Keep away from fuel, oil and wood.'),
      item(ghs('cylinder', 'Gas cylinder'), 'Gas cylinder', 'Gas under pressure: can burst if heated; liquefied gases freeze skin.'),
      item(ghs('corrosion', 'Corrosion'), 'Corrosion', 'Burns skin and eyes and eats metal: acids, lye, battery electrolyte.'),
      item(ghs('skull', 'Skull and crossbones'), 'Skull and crossbones', 'Acutely toxic: small amounts swallowed, breathed or on skin can kill.'),
      item(ghs('excl', 'Exclamation mark'), 'Exclamation mark', 'Irritant, skin sensitiser, drowsiness, or harmful in larger amounts.'),
      item(ghs('health', 'Health hazard'), 'Health hazard', 'Long-term harm: cancer, organ damage, breathing sensitiser, or deadly if it gets into the lungs (oils, solvents).'),
      item(ghs('environment', 'Environment'), 'Environment', 'Toxic to fish and water life. Don’t pour it out near water. (GHS only: WHMIS doesn’t use it.)'),
      item(whmisBio('Biohazard (WHMIS)'), 'Biohazard (WHMIS, round)', 'Infectious material: medical waste, cultures, sharps.'),
    ])}
    ${section('Warning triangles (ISO 7010)', 'Yellow triangle with a black border, on machines, panels and doors.', [
      item(iso('excl', 'General warning'), 'General warning', 'Read the label next to it.'),
      item(iso('bolt', 'Electricity'), 'Electricity', 'Shock hazard: live parts, high voltage or charged capacitors inside.'),
      item(iso('laser', 'Laser beam'), 'Laser beam', 'Eye hazard; see the laser class below.'),
      item(iso('radiation', 'Radioactive material'), 'Radioactive material', 'Ionising radiation: smoke-alarm sources, medical and industrial gauges. Leave sealed sources sealed.'),
      item(iso('magnet', 'Magnetic field'), 'Magnetic field', 'Strong magnet: pinches fingers, wipes cards, harms pacemakers.'),
      item(iso('hot', 'Hot surface'), 'Hot surface', 'Burns: heaters, fusers, exhausts, heat sinks.'),
      item(iso('crush', 'Crushing'), 'Crushing or drawing-in', 'Rollers, gears and belts that pull in fingers, hair and clothes.'),
      item(iso('flame', 'Flammable material'), 'Flammable material', 'Fire risk: fuel, solvents, flammable refrigerant (R-600a, R-290).'),
      item(iso('skull', 'Toxic material'), 'Toxic material', 'Poisonous contents.'),
      item(iso('corrosion', 'Corrosive substance'), 'Corrosive substance', 'Acid or alkali: batteries, cleaners.'),
    ])}
    <h3>Words on labels</h3>
    ${table(['Word or shape', 'Means'], [
      ['DANGER', 'The worst level: can kill or seriously injure.'],
      ['WARNING', 'Can seriously injure.'],
      ['CAUTION', 'Can injure; take care.'],
      ['Canadian household products: frame', 'An octagon means the contents are dangerous; an upside-down triangle means the container is (it can burst).'],
      ['Canadian household products: symbol', 'Skull: poison. Flame: flammable. Bursting container: explosive. Hand being eaten away: corrosive.'],
      ['Canadian household products: words', 'CAUTION: temporary injury. DANGER: temporary or permanent injury, or death. EXTREME DANGER: a very small amount can kill or seriously injure.'],
    ])}
    ${section('Transport placards (UN classes)', 'Diamonds on trucks, railcars, tanks and drums. A 4-digit UN number on or under the placard names the exact substance: the free Emergency Response Guidebook (ERG) says how far to stay back.', [
      item(placard('1', '#F58220', '#F58220', null, 'Class 1'), '1 Explosives', 'Orange.'),
      item(placard('2', '#E2231A', '#E2231A', null, 'Class 2.1'), '2.1 Flammable gas', 'Red: propane, butane, hydrogen.'),
      item(placard('2', '#2E8540', '#2E8540', null, 'Class 2.2'), '2.2 Non-flammable gas', 'Green: compressed air, nitrogen, CO2, most refrigerants.'),
      item(placard('2', '#fff', '#fff', null, 'Class 2.3'), '2.3 Toxic gas', 'White with a skull: chlorine; anhydrous ammonia (2.2 in the US).'),
      item(placard('3', '#E2231A', '#E2231A', null, 'Class 3'), '3 Flammable liquid', 'Red: gasoline, diesel, solvents.'),
      item(placard('4', 'stripes', 'stripes', '#E2231A', 'Class 4.1'), '4.1 Flammable solid', 'Red and white stripes: matches, sulphur, magnesium.'),
      item(placard('4', '#fff', '#E2231A', null, 'Class 4.2'), '4.2 Spontaneously combustible', 'White top, red bottom: oily rags, some metal powders.'),
      item(placard('4', '#1F5FA8', '#1F5FA8', null, 'Class 4.3'), '4.3 Dangerous when wet', 'Blue: gives off flammable gas with water (sodium, calcium carbide).'),
      item(placard('5.1', YELLOW, YELLOW, null, 'Class 5.1'), '5.1 Oxidiser', 'Yellow: pool chlorine, fertiliser (ammonium nitrate), peroxide.'),
      item(placard('5.2', '#E2231A', YELLOW, null, 'Class 5.2'), '5.2 Organic peroxide', 'Red top, yellow bottom.'),
      item(placard('6', '#fff', '#fff', null, 'Class 6'), '6 Toxic or infectious', 'White: poisons (6.1), medical and infectious waste (6.2).'),
      item(placard('7', YELLOW, '#fff', null, 'Class 7'), '7 Radioactive', 'Yellow top, white bottom.'),
      item(placard('8', '#fff', '#111', null, 'Class 8'), '8 Corrosive', 'White top, black bottom: acids, lye, battery acid.'),
      item(placard('9', 'stripes', '#fff', '#111', 'Class 9'), '9 Miscellaneous', 'Black stripes on top: lithium batteries, dry ice, asbestos.'),
    ])}
    ${section('Fire diamond (NFPA 704)', 'On buildings, tanks and storage rooms in North America. Each quarter is rated 0 (none) to 4 (severe).', [
      item(nfpa, 'Blue, red, yellow, white', 'Blue: health hazard. Red: how easily it burns. Yellow: instability, can explode or react. White: special notes: W̶ reacts with water, OX oxidiser, SA asphyxiant gas.'),
    ])}
    ${section('Electrical and device markings', '', [
      item(plain('class2', 'Double square'), 'Double square (Class II)', 'Double insulated: safe with a two-prong plug, no earth needed.'),
      item(plain('earth', 'Earth'), 'Earth or ground', 'The protective earth connection.'),
      item(plain('ac', 'Alternating current'), '~ AC', 'Alternating current, usually mains.'),
      item(plain('dc', 'Direct current'), '⎓ DC', 'Direct current: batteries, adapters.'),
      item(plain('polarity', 'Centre positive'), 'Centre positive', 'The barrel plug’s centre pin is +. If the C is on the other side, centre is −.'),
      item(plain('bin', 'Crossed-out bin'), 'Crossed-out bin', 'Don’t bin it: e-waste or batteries. Pb, Cd or Hg under it means lead, cadmium or mercury inside.'),
    ])}
    <h3>IP rating: dust and water</h3>
    <p class="where">IP67 means dust-tight (6) and survives being dunked to 1 m (7). An X means not tested for that one.</p>
    ${table(['First digit: solids', 'Second digit: water'], [
      ['4: wires and screws (1 mm)', '4: splashing from any direction'],
      ['5: dust-protected', '5: water jets'],
      ['6: dust-tight', '6: powerful jets'],
      ['', '7: dunked to 1 m for 30 minutes'],
      ['', '8: submerged beyond 1 m (as the maker states)'],
    ])}
    <h3>Laser classes</h3>
    ${table(['Class', 'Means'], [
      ['1', 'Safe as used: the beam is enclosed (printers, CD and DVD drives). Opened up, the diode inside may be higher.'],
      ['2, 2M', 'Visible, under 1 mW: the blink reflex protects you. Don’t stare into it.'],
      ['3R', 'Up to 5 mW: risky to look into directly. Most red pointers.'],
      ['3B', 'Up to 0.5 W: a direct beam or mirror reflection injures eyes instantly. Bare DVD-burner diodes.'],
      ['4', 'Over 0.5 W: burns skin, starts fires, and even scattered reflections injure eyes. Laser cutter and engraver diodes (watts) and CO2 tubes. Never run one open.'],
    ])}
    <h3>Plastic resin codes</h3>
    <p class="where">The number in the triangle on plastic parts, for melting, gluing or burning decisions.</p>
    <div class="picto-grid">${[
      ['1', 'PET', 'Bottles. Doesn’t remelt well at home.'],
      ['2', 'HDPE', 'Jugs, pipe, tanks. Melts and moulds easily; food-safe; doesn’t glue.'],
      ['3', 'PVC', 'Pipe, cable jackets. Never burn or melt it: gives off hydrochloric acid and dioxins.'],
      ['4', 'LDPE', 'Bags, film. Melts easily; weatherproofing.'],
      ['5', 'PP', 'Tubs, appliance housings. Tough, melts easily, living hinges.'],
      ['6', 'PS', 'Foam, CD cases. Brittle; burns with black smoke.'],
      ['7', 'Other', 'ABS, nylon, polycarbonate and mixes. Electronics housings are mostly ABS or ABS/PC.'],
    ].map(([n, name, what]) => item(svg(P.resin(n), 'Resin code ' + n, 'plain'), `${n} ${name}`, what)).join('')}</div>`;
  }

  // Cheat sheets in groups, the built-in labels card first; a reference guide not named here goes
  // under More, so new ones from contributors still show.
  const GROUPS = [
    ['Safety and survival', ['labels', 'reference_first_aid', 'reference_water_filters', 'reference_sanitation', 'reference_food_safety', 'reference_fire_heat']],
    ['Electrical and electronics', ['reference_electronics_codes', 'reference_wiring_colours', 'reference_connectors', 'pinouts', 'reference_microcontrollers', 'reference_mcu_code', 'reference_battery_chemistry', 'reference_power_budget', 'reference_power_draw', 'reference_wire_gauge', 'reference_date_codes']],
    ['Workshop and vehicles', ['reference_what_fits', 'reference_fasteners_threads', 'reference_building_materials', 'reference_chemicals', 'reference_welding_cutting', 'reference_knots_lifting', 'reference_vehicles', 'reference_shop_math', 'reference_units']],
    ['Outdoors and signals', ['reference_radio_signals', 'reference_lora_bands', 'reference_navigation', 'reference_weather']],
  ];
  const LABELS = { id: 'labels', title: 'Warning labels and symbols', summary: 'Hazard pictograms, warning triangles, transport placards, the fire diamond, electrical markings, IP ratings, laser classes and plastic codes.' };
  function groups(ctx) {
    const guides = ctx.ds.guides.filter(g => g.kind === 'reference' && !g.deprecated);
    const byId = new Map([[LABELS.id, LABELS], [Pinouts.META.id, Pinouts.META], ...guides.map(g => [g.id, g])]);
    const named = new Set(GROUPS.flatMap(([, ids]) => ids));
    const out = GROUPS.map(([title, ids]) => [title, ids.map(id => byId.get(id)).filter(Boolean)]);
    const rest = guides.filter(g => !named.has(g.id)).sort((a, b) => a.title.localeCompare(b.title));
    if (rest.length) out.push(['More', rest]);
    return out.filter(([, list]) => list.length);
  }
  const cards = ctx => groups(ctx).flatMap(([, list]) => list);
  return { labelsHTML, cards, groups, LABELS };
})();

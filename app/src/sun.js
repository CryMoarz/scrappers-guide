// Sun for sizing off-grid solar anywhere, offline: how much sun each month brings, on the flat and
// on a tilted panel, from a world grid of NASA POWER's monthly averages (sungrid.js). A stand-alone
// system has to be sized for its worst month on the panel, not for the yearly average.
const Sun = (() => {
  let RAW = null, G = null;
  const RAD = Math.PI / 180;

  // The grid unpacked on first use, not at startup: most visits never look at the sun.
  function grid() {
    if (G || !RAW) return G;
    const bytes = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
    const bits = bytes(RAW.land), n = RAW.rows * RAW.cols, idx = new Int32Array(n).fill(-1);
    // Each land cell's place in the data arrays, which run in bitmap order.
    for (let i = 0, k = 0; i < n; i++) if (bits[i >> 3] & (1 << (i & 7))) idx[i] = k++;
    G = Object.assign({}, RAW, { idx, ghi: bytes(RAW.ghi), dif: bytes(RAW.dif), cold: bytes(RAW.cold) });
    return G;
  }
  const use = data => { RAW = data; G = null; };

  // The grid cell for a place: { lat, lon (the cell's centre), ghi: [12], dif: [12], cold }, in
  // kWh/m²/day (the same number as peak sun hours) and °C, or null over the sea or off the grid.
  function at(lat, lon) {
    const g = grid();
    if (!g || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < g.lat0 || lat > g.lat0 + g.rows * g.step) return null;
    lon = ((((lon - g.lon0) % 360) + 360) % 360) + g.lon0;
    const r0 = Math.min(g.rows - 1, Math.floor((lat - g.lat0) / g.step)), c0 = Math.floor((lon - g.lon0) / g.step) % g.cols;
    // Its own cell, or else the nearest of the eight around it that has land: a coastal town can sit
    // in a cell that is mostly sea and so wasn't kept. Nearest means to the cell's edge or corner,
    // with longitude shrunk towards the poles.
    const k = Math.cos(lat * RAD);
    let best = null;
    for (const [dr, dc] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const r = r0 + dr, c = (c0 + dc + g.cols) % g.cols;
      if (r < 0 || r >= g.rows || g.idx[r * g.cols + c] < 0) continue;
      const s = g.lat0 + r * g.step, w = g.lon0 + (c0 + dc) * g.step; // west edge not wrapped, so distances across 180° work
      const dy = Math.max(0, s - lat, lat - s - g.step), dx = Math.max(0, w - lon, lon - w - g.step) * k;
      const d = dx * dx + dy * dy;
      if (!best || d < best.d) best = { r, c, d, i: g.idx[r * g.cols + c] };
    }
    if (!best) return null;
    // Sun is stored in 0.05 kWh/m²/day steps, diffuse as its share of that in 250ths; 255 is no data.
    const ghi = [], dif = [];
    for (let m = 0, j = best.i * 12; m < 12; m++, j++) {
      ghi.push(g.ghi[j] === 255 ? null : g.ghi[j] / 20);
      dif.push(g.ghi[j] === 255 || g.dif[j] === 255 ? null : ((g.ghi[j] / 20) * g.dif[j]) / 250);
    }
    return { lat: g.lat0 + (best.r + 0.5) * g.step, lon: g.lon0 + (best.c + 0.5) * g.step, ghi, dif, cold: g.cold[best.i] === 255 ? null : g.cold[best.i] - 100 };
  }

  const LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const clamp = x => Math.max(-1, Math.min(1, x));
  // R̄b for each month: the sun above the atmosphere on the panel over that on the flat (Klein
  // 1977). Klein works it out for one average day per month (Duffie and Beckman, Solar Engineering
  // of Thermal Processes, Table 1.6.1). That day is a shortcut for the month's total, good to about
  // 1% at mid-latitudes and a few % at 60°, but a month in which polar night begins or ends isn't
  // like any one of its days: for a vertical panel at 80°N, October's average day gives 212 and its
  // days summed give 21. So every day is summed. `s` is -1 in the south, where the panel faces
  // north: that is the northern case mirrored, with the declination's sign flipped so the seasons swap.
  function ratios(phi, b, s) {
    let n = 0;
    return LEN.map(len => {
      let flat = 0, panel = 0;
      for (let i = 0; i < len; i++) {
        n++;
        const d = s * 23.45 * Math.sin((2 * Math.PI * (284 + n)) / 365) * RAD; // declination, Cooper (1969)
        const e = 1 + 0.033 * Math.cos((2 * Math.PI * n) / 365); // nearer the sun in January
        // Sunset hour angles on the flat and on the panel, which loses the sun first once it goes
        // behind it. Past ±1 the sun never sets (π) or never rises (0), so clamping is polar day and night.
        const ws = Math.acos(clamp(-Math.tan(phi) * Math.tan(d)));
        const wt = Math.min(ws, Math.acos(clamp(-Math.tan(phi - b) * Math.tan(d))));
        flat += e * (Math.cos(phi) * Math.cos(d) * Math.sin(ws) + ws * Math.sin(phi) * Math.sin(d));
        panel += e * Math.max(0, Math.cos(phi - b) * Math.cos(d) * Math.sin(wt) + wt * Math.sin(phi - b) * Math.sin(d));
      }
      return flat > 1e-9 ? panel / flat : 0; // a month of polar night has no direct sun
    });
  }
  // Monthly average daily sun on a fixed panel facing the equator at `tilt` degrees, in kWh/m²/day
  // (the same number as peak sun hours), from the month's sun on the flat (ghi) and its diffuse part
  // (dif). The isotropic-sky model (Liu and Jordan; Duffie and Beckman, on average sun on sloped
  // surfaces): the direct part scaled by R̄b, the diffuse part by how much sky the panel sees, plus
  // sun reflected off the ground in front of it (albedo 0.2 for grass or soil, about 0.7 for snow).
  function tilted(lat, ghi, dif, tilt, albedo = 0.2) {
    const b = Math.max(0, Math.min(90, Number(tilt) || 0)) * RAD;
    const rb = ratios(Math.min(89.9, Math.abs(lat)) * RAD, b, lat < 0 ? -1 : 1);
    return rb.map((r, m) => {
      const H = ghi[m], D = dif[m];
      if (H == null || D == null || !Number.isFinite(H) || !Number.isFinite(D)) return null;
      if (H <= 0) return 0;
      const diffuse = Math.min(H, Math.max(0, D));
      return (H - diffuse) * r + (diffuse * (1 + Math.cos(b))) / 2 + (H * albedo * (1 - Math.cos(b))) / 2;
    });
  }

  // A fixed tilt for a system that has to get through winter: latitude + 15°, the tilt long used for
  // stand-alone systems with steady loads, where winter is the limiting season (Jones and Kurtz,
  // "Optimizing the Configuration of Photovoltaic Plants to Minimize the Need for Storage", IEEE
  // Journal of Photovoltaics 12(3), 2022; it is one of the tilts tabulated for that reason in NREL's
  // Solar Radiation Data Manual for Flat-Plate and Concentrating Collectors, 1994). Capped at vertical.
  const tiltFor = lat => Math.min(90, Math.round(Math.abs(lat) + 15));

  const info = () => (RAW ? { source: RAW.source, period: RAW.period, step: RAW.step } : null);

  return { use, at, tilted, tiltFor, info };
})();

// LoRa bridge: puts a hub or node on a LoRa mesh (Meshtastic, or plain LoRa modules).
//
// LoRa carries a couple of hundred bytes per message and every message costs shared airtime,
// so this does the things that fit:
//   1. A text bot. Anyone with a radio sends "?scrap 12v motor" and gets a short answer from
//      this node's data, even with no internet anywhere. "?help" lists the commands.
//   2. Announcements. Nodes say who they are and how fresh their data is, so people know
//      which box to sync with when they get close.
//   3. Small signed items: field notes (and short comments) travel between nodes in a few
//      chunks, compressed, and are verified on arrival like anything else.
// Full data syncs never go over LoRa; they wait for Wi-Fi, a cable or a USB stick.
const zlib = require('zlib');
const SDG = require('../core');
const { createLink, PORT } = require('./lora-links');

const MAGIC = 'SDG1';
const CHUNK = 150;          // characters of payload per frame; Meshtastic texts top out around 228 bytes
const MAX_CHUNKS = 12;      // larger items wait for a real connection
const MAX_TEXT = 200;
const MAX_FRAME = 600;      // longer frames are not from a radio; UDP could otherwise carry 64 KB
const MAX_PARTS = 32;       // messages being reassembled at once
const MAX_KNOWN = 500;      // radios remembered (positions, fair-share counters) and peers
const MAX_REPLIES = 20;     // bot replies waiting to go out
const MAX_QUEUED = 40;      // other frames waiting: announcements and chunks of signed items
const PART_TTL = 10 * 60e3;
const HOUR = 3600e3;
const BUSY_EVERY = 5 * 60e3; // once ?seen's budget is spent, say so at most this often
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// A ?seen report is someone's words from a radio, signed by the node that heard it and checked by
// nobody. That node stores it with via 'radio-report' (beside the note, outside its signature, like
// via 'lora'), and its signed notes say so, which marks it wherever it goes, even where via is
// dropped. Such reports are never sent on over LoRa and stay off NOMAD's map (nomad.js); someone
// who checks the place adds a note of their own, and that one travels. The second wording is the
// one older versions of ?seen wrote.
const RADIO_REPORT = 'radio-report';
const radioNote = from => `Unverified radio report from !${(from >>> 0).toString(16)} over LoRa; nobody has checked it.`;
const isRadioReport = o => !!o && (o.via === RADIO_REPORT || /^(Unverified radio report from|Reported over LoRa by radio) !/.test(o.notes || ''));

function createBridge(hub, opts) {
  opts = Object.assign({ link: 'meshtastic-tcp', bot: true, announceMinutes: 60, shareObservations: true, maxPerMinute: 6, seenPerHour: 30, seenPerArea: 5, months: undefined }, opts || {});
  const link = opts.linkObject || createLink(opts);
  const state = { link: opts.link, status: 'starting', peers: {}, heard: 0, sent: 0, botReplies: 0, received: { observations: 0, comments: 0 }, reports: { logged: 0, refused: 0 }, refused: 0, dropped: 0 };
  const positions = new Map();     // radio node number → last position heard
  const asked = new Map();         // radio node number → recent command times, to share airtime fairly
  const parts = new Map();         // sending radio and message id → { n, got: [], at }
  const seen = new Set();          // sending radio and message id of items taken
  const reports = [];              // when ?seen reports were logged in the last hour, from any radio
  const areas = new Map();         // area → when ?seen reports there were logged in the last hour
  let toldBusy = 0;
  const queue = [], replies = [];
  let sentTimes = [], turn = 0;

  // Everything kept per radio or per message is bounded: a busy or hostile mesh can't grow it.
  const remember = (map, k, v, max) => { map.delete(k); if (map.size >= max) map.delete(map.keys().next().value); map.set(k, v); };
  link.on('status', s => { state.status = s; });
  link.on('position', p => { if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) remember(positions, p.from, { lat: p.lat, lon: p.lon, at: Date.now() }, MAX_KNOWN); });
  link.on('text', m => { state.heard++; handle(m).catch(e => console.warn('LoRa:', e.message)); });

  // ---- airtime-limited sending: bot replies first, then everything else ----
  // Replies and other frames wait in separate lines, each with its own limit, so a flood of
  // questions can't crowd out the node's announcements and notes.
  function enqueue(text, o, priority) {
    const q = priority ? replies : queue;
    if (q.length >= (priority ? MAX_REPLIES : MAX_QUEUED)) { state.dropped++; return; }
    q.push({ text, o: o || {} });
  }
  const pump = setInterval(() => {
    const now = Date.now();
    sentTimes = sentTimes.filter(t => now - t < 60e3);
    if (sentTimes.length >= opts.maxPerMinute) return;
    // Replies go first, but every third send goes to the other line when something waits there.
    const q = !queue.length || (replies.length && ++turn % 3) ? replies : queue;
    if (!q.length) return;
    const { text, o } = q.shift();
    if (link.send(text, o)) { sentTimes.push(now); state.sent++; }
  }, opts.spacingMs || 3000);
  pump.unref && pump.unref();

  // ---- machine frames ----
  function packItem(kind, item) {
    const body = zlib.deflateRawSync(Buffer.from(JSON.stringify({ k: kind, v: item }))).toString('base64url');
    const n = Math.ceil(body.length / CHUNK);
    if (n > MAX_CHUNKS) return 0;
    // All of an item's chunks or none: half an item is only airtime spent.
    if (queue.length + n > MAX_QUEUED) { state.dropped++; return 0; }
    const id = SDG.util.newId().slice(-8);
    for (let i = 0; i < n; i++) enqueue(`${MAGIC}|D|${id}|${i + 1}|${n}|${body.slice(i * CHUNK, (i + 1) * CHUNK)}`, { port: PORT.PRIVATE });
    return n;
  }
  async function announce() {
    enqueue(`${MAGIC}|H|${hub.hubFp.slice(0, 8)}|${hub.seq}|${String(await hub.datasetHash()).slice(0, 8)}|${clip(hub.cfg.name, 40)}`, { port: PORT.PRIVATE });
  }
  async function onFrame(text, from) {
    const f = text.split('|');
    if (f[1] === 'H') {
      if (!/^[0-9a-f]{8}$/.test(f[2] || '') || !/^\d{1,12}$/.test(f[3] || '')) return;
      if (!state.peers[f[2]] && Object.keys(state.peers).length >= 100) delete state.peers[Object.entries(state.peers).sort((a, b) => a[1].heard.localeCompare(b[1].heard))[0][0]];
      state.peers[f[2]] = { seq: +f[3], hash: String(f[4] || '').slice(0, 8), name: clip(f.slice(5).join('|'), 40), heard: SDG.util.now(), newer: +f[3] > hub.seq };
      return;
    }
    if (f[1] !== 'D' || f.length < 6) return;
    const [, , id, iS, nS] = f;
    const i = +iS, n = +nS, piece = f.slice(5).join('|');
    // Chunks are kept per sending radio and id, and a chunk already in is never replaced, so
    // another radio can't spoil someone's item by answering its first chunk with junk.
    const key = `${from == null ? 'anon' : from}|${id}`;
    if (!/^[0-9a-z]{1,16}$/.test(id) || !(n >= 1 && n <= MAX_CHUNKS && i >= 1 && i <= n) || piece.length > CHUNK || seen.has(key)) return;
    const p = parts.get(key) || { n, got: [], at: Date.now() };
    if (p.n !== n || p.got[i - 1] != null) return;
    p.got[i - 1] = piece;
    if (!parts.has(key)) remember(parts, key, p, MAX_PARTS);
    if (p.got.filter(x => x != null).length < n) return;
    parts.delete(key);
    let msg;
    try { msg = SDG.util.parse(zlib.inflateRawSync(Buffer.from(p.got.join(''), 'base64url'), { maxOutputLength: 16384 }).toString('utf8')); } catch (e) { state.dropped++; return; }
    // The same checks as any contribution: signature, schema, bans, work stamps, targets, ids.
    const take = msg && { o: hub.takeObservation, c: hub.takeComment }[msg.k];
    if (!take || !msg.v || typeof msg.v !== 'object') return;
    // Only an item that checks out closes its id; junk leaves it open for the real one.
    try { await take(msg.v, { via: 'lora' }); seen.add(key); state.received[msg.k === 'o' ? 'observations' : 'comments']++; } catch (e) { state.refused = (state.refused || 0) + 1; }
  }
  const sweep = setInterval(() => {
    const t = Date.now();
    parts.forEach((p, k) => { if (t - p.at > PART_TTL) parts.delete(k); });
    asked.forEach((v, k) => { if (!v.some(x => t - x < 600e3)) asked.delete(k); });
    areas.forEach((v, k) => { if (!v.some(x => t - x < HOUR)) areas.delete(k); });
    positions.forEach((v, k) => { if (t - v.at > 6 * 3600e3) positions.delete(k); });
    if (seen.size > 2000) seen.clear();
  }, 60e3);
  sweep.unref && sweep.unref();

  // ---- the text bot ----
  const ctx = () => hub.getCtx();
  function findDevice(words) {
    const c = ctx();
    const id = words.trim().toLowerCase().replace(/\s+/g, '_');
    if (c.get('devices', id)) return c.resolve(id);
    const hit = SDG.search.findDevices(c, words)[0];
    if (hit) return c.resolve(hit.d.id);
    const loose = c.ds.devices.find(d => d.name.toLowerCase().includes(words.trim().toLowerCase()));
    return loose ? c.resolve(loose.id) : null;
  }
  const COMMANDS = {
    help: () => '?scrap <need> · ?inside <device> · ?safe <device> · ?job <need> · ?guide <words> · ?step <guide> <n> · ?seen <untouched|partial|cleared|dangerous> [place] · ?status',
    scrap: q => {
      if (!q) return 'Send ?scrap and what you need, e.g. ?scrap 12v motor';
      const c = ctx();
      const s = SDG.search.summarize(c, SDG.search.search(c, q, { months: opts.months }), 3);
      if (!s.bestDevices.length) return `Nothing found for "${clip(q, 40)}". Try a plainer word.`;
      if (s.jobs[0] && s.perPart.length) {
        return `${s.jobs[0].name}: ${s.perPart.map(p => `${clip(p.name.replace(/ \(.*?\)/, ''), 24)} → ${p.sources[0] ? clip(p.sources[0].name.split(/[(,]/)[0].trim(), 26) : 'none known'}`).join('; ')}. ?job for the approach`;
      }
      const devs = s.bestDevices.map(d => `${d.name} ${d.score}`).join('; ');
      const where = s.whereToLook.slice(0, 2).map(b => b.name).join(', ');
      const haz = s.bestDevices[0].hazards.length ? ` ⚠${s.bestDevices[0].hazards[0]}` : '';
      return `${s.jobs[0] ? s.jobs[0].name + ': ' : ''}${devs}. Look: ${where}.${haz} ?inside for parts`;
    },
    inside: q => {
      const r = findDevice(q || '');
      if (!r) return `No device like "${clip(q || '', 40)}".`;
      const names = r.comps.filter(x => !x.board).slice(0, 8).map(x => (ctx().get('parts', x.fn) || {}).name || x.fn);
      return `${r.name}: ${names.join(', ')}. ${r.mins} min, ${(r.tools || []).map(ctx().toolLabel).join(', ')}${r.hazards.length ? '. ⚠' + r.hazards.map(h => ctx().hazard(h).label).join(', ') : ''}`;
    },
    safe: q => {
      const c = ctx();
      const h = c.get('hazards', (q || '').trim().toLowerCase());
      const ids = h ? [h.id] : (findDevice(q || '') || { hazards: [] }).hazards;
      if (!ids.length) return `No hazards recorded for "${clip(q || '', 40)}". That is not the same as safe.`;
      const cards = ids.map(x => c.hazard(x)).sort((a, b) => b.severity - a.severity);
      const top = cards[0];
      return `⚠ ${cards.map(x => x.label).join(', ')}. ${top.label}: ${(top.do || [])[0] || top.summary}`;
    },
    job: q => {
      const j = SDG.search.findJobs(ctx(), q || '')[0];
      return j ? `${j.job.name}: ${j.job.summary}` : 'No job like that. Try ?scrap instead.';
    },
    guide: q => {
      const hits = SDG.search.findGuides(ctx(), q || '').slice(0, 3);
      return hits.length ? hits.map(h => `${h.g.title} [${h.g.id}, ${SDG.text.guideSteps(h.g).length} steps]`).join(' · ') + ' — send ?step <id> 1' : 'No guide found.';
    },
    step: q => {
      const [id, nS] = (q || '').trim().split(/\s+/);
      const g = ctx().get('guides', id);
      if (!g) return 'Send ?step <guide id> <number>. Find ids with ?guide';
      const steps = SDG.text.guideSteps(g);
      if (!steps.length) return 'That guide has no steps.';
      const n = Math.max(1, Math.min(steps.length, +nS || 1));
      const s = steps[n - 1];
      return `${n}/${steps.length}: ${s.text}${s.warn ? ' ⚠ ' + s.warn : ''}`;
    },
    seen: async (q, from) => {
      const [status, ...rest] = (q || '').trim().split(/\s+/);
      const st = { untouched: 'untouched', partial: 'partial', looted: 'partial', cleared: 'cleared', empty: 'cleared', dangerous: 'dangerous', danger: 'dangerous', occupied: 'occupied' }[(status || '').toLowerCase()];
      if (!st) return 'Send ?seen untouched|partial|cleared|dangerous|occupied, then the place, e.g. ?seen cleared pharmacy';
      const pos = positions.get(from);
      if (!pos || Date.now() - pos.at > 6 * 3600e3) return 'I have no recent position from your radio. Turn on position sharing, then try again.';
      // Node numbers and positions are whatever a sender says, so reports also share a budget:
      // so many an hour from all radios together, and fewer from any one area (0.01°, about 1 km).
      const t = Date.now(), area = `${Math.round(pos.lat * 100)},${Math.round(pos.lon * 100)}`;
      while (reports.length && t - reports[0] >= HOUR) reports.shift();
      const here = (areas.get(area) || []).filter(x => t - x < HOUR);
      const full = reports.length >= opts.seenPerHour;
      if (full || here.length >= opts.seenPerArea) {
        state.reports.refused++;
        // Said now and then, not to every radio, so a flood doesn't fill the air with refusals.
        if (t - toldBusy < BUSY_EVERY) return '';
        toldBusy = t;
        return `Too many reports ${full ? '' : 'from around there '}this hour, so yours was not logged. Try again later.`;
      }
      reports.push(t);
      remember(areas, area, [...here, t], MAX_KNOWN);
      const words = rest.join(' ');
      const b = ctx().ds.buildings.find(x => words && (x.name.toLowerCase().includes(words.toLowerCase()) || x.id === words.toLowerCase()));
      // Signed by this node with a work stamp, so apps and nodes that sync here take it like any
      // newcomer's note, and marked as a radio report (see isRadioReport).
      const o = await SDG.changes.makeObservation({ lat: pos.lat, lon: pos.lon, status: st, building: b && b.id, label: words ? clip(words, 200) : undefined, notes: radioNote(from), share: 'peers' }, hub.identity, 4, (hub.cfg.policy || {}).powBits);
      hub.store.putObservation(Object.assign({}, o, { via: RADIO_REPORT, received: hub.stamp ? hub.stamp() : SDG.util.now() }));
      state.reports.logged++;
      return `Noted: ${st}${b ? ' ' + b.name : ''} at ${o.lat.toFixed(3)}, ${o.lon.toFixed(3)}. Thanks.`;
    },
    status: () => {
      const peers = Object.values(state.peers);
      const newer = peers.filter(p => p.newer).map(p => p.name);
      return `${clip(hub.cfg.name, 40)}: data v${hub.seq}, ${ctx().stats().searchableDevices} devices. ${peers.length} other node${peers.length === 1 ? '' : 's'} heard${newer.length ? `; newer data at ${newer.join(', ')}` : ''}.`;
    },
  };

  async function handle(m) {
    const text = String(m.text || '').trim();
    if (text.length > MAX_FRAME) { state.dropped++; return; }
    if (text.startsWith(MAGIC + '|')) return onFrame(text, m.from);
    if (!opts.bot || !text.startsWith('?')) return;
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const fn = COMMANDS[(cmd || 'help').toLowerCase()];
    if (!fn) return;
    const who = m.from == null ? 'anon' : m.from;
    const times = (asked.get(who) || []).filter(t => Date.now() - t < 600e3);
    if (times.length >= 6) return;
    remember(asked, who, [...times, Date.now()], MAX_KNOWN);
    const reply = String((await fn(rest.join(' '), m.from)) || '').replace(/\s+/g, ' ').trim();
    if (!reply) return; // a command may stay quiet, as ?seen does under a flood
    const to = link.canDirect && m.from != null ? m.from : undefined;
    const prefix = to === undefined && m.from != null ? `@${(m.from >>> 0).toString(16)} ` : '';
    const pieces = [];
    for (let s = prefix + reply; s.length; s = s.slice(MAX_TEXT - 6)) pieces.push(s.slice(0, MAX_TEXT - 6));
    pieces.slice(0, 3).forEach((p, i) => enqueue(pieces.length > 1 ? `${p} ${i + 1}/${Math.min(3, pieces.length)}` : p, { to, port: PORT.TEXT }, true));
    state.botReplies++;
  }

  const timer = opts.announceMinutes > 0 ? setInterval(() => announce().catch(() => {}), opts.announceMinutes * 60e3) : null;
  if (timer && timer.unref) timer.unref();
  setTimeout(() => announce().catch(() => {}), opts.firstAnnounceMs != null ? opts.firstAnnounceMs : 15e3).unref();

  return {
    state,
    shareObservation: o => (opts.shareObservations && ['peers', 'public'].includes(o.share) && !isRadioReport(o) ? packItem('o', SDG.sign.strip(o, 'mine', 'sent', 'received', 'via')) : 0),
    shareComment: c => packItem('c', SDG.sign.strip(c, 'received', 'hidden', 'via')),
    announce, handle, COMMANDS,
    queueLength: () => queue.length + replies.length,
    inFlight: () => ({ parts: parts.size, asked: asked.size, positions: positions.size }),
    close: () => { clearInterval(pump); clearInterval(sweep); if (timer) clearInterval(timer); link.close(); },
  };
}

module.exports = { createBridge, isRadioReport, MAGIC };

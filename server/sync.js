// Node mode: keep a local mirror in step with an upstream hub, whenever it can be reached.
// Pushes queued contributions, pulls accepted changes, and backs off quietly while offline.
const SDG = require('../core');

// The most one response may hold once unzipped. Whoever answers for the upstream's address can
// send a small gzip that inflates to gigabytes, so bodies are counted as they arrive and cut off
// here. Pages ask for few enough items to fit in `page`; the reply to a push lists up to 2000
// results; the whole release (4 MB in November 2026) has four times its size to grow into, and
// the worst a hostile one that size can do still fits a node running in a 512 MB heap.
const MAX = { page: 1 << 20, reply: 4 << 20, release: 16 << 20 };
// One sync reads at most `pages` pages of `size` changes, so at most 2000 changes. A node further
// behind than that takes the signed release instead, which is about the same download.
const FEED = { size: 200, pages: 10 };

async function fetchJSON(url, opts) {
  opts = opts || {};
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 30e3);
  try {
    const res = await fetch(url, { method: opts.method, body: opts.body, signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' } });
    const text = await readText(res, opts.max || MAX.page, ctl, url);
    const body = text ? SDG.util.parse(text) : {};
    if (!res.ok) { const e = new Error((body && body.error) || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return body;
  } finally { clearTimeout(t); }
}
// Reads a body as it arrives, unzipped, and gives up as soon as it passes `max` bytes. Objects and
// lists cost far more memory than their bytes ({} is 3 bytes and about 60 in memory), so it also
// counts them, outside strings, and allows one per 16 bytes of `max`: real data has one per 150.
async function readText(res, max, ctl, url) {
  const parts = [];
  let size = 0, nest = 0, inStr = false, esc = false;
  const tooBig = what => {
    ctl.abort();
    const e = new Error(`The upstream sent more than ${what} for ${new URL(url).pathname}`);
    e.tooBig = true;
    return e;
  };
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > max) throw tooBig(`${max >> 20} MB`);
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (inStr) { if (esc) esc = false; else if (b === 92) esc = true; else if (b === 34) inStr = false; } // \ and "
        else if (b === 34) inStr = true;
        else if (b === 123 || b === 91) nest++; // { and [
      }
      if (nest > max >> 4) throw tooBig(`${max >> 4} objects and lists`);
      parts.push(chunk);
    }
  }
  return Buffer.concat(parts).toString('utf8');
}
// One page of a feed: asks for `n` items, and for a quarter as many each time the page comes back
// too big, so a run of long items still gets through without any response passing the limit.
async function fetchPage(url, n) {
  for (;;) {
    try { return await fetchJSON(`${url}&limit=${n}`); } catch (e) { if (!e.tooBig || n === 1) throw e; n = Math.max(1, n >> 2); }
  }
}

async function syncOnce(hub) {
  const { store, cfg } = hub;
  const up = String(cfg.upstream || '').replace(/\/+$/, '');
  if (!up) throw new Error('No upstream hub configured');
  const report = { pushed: { proposals: 0, comments: 0, observations: 0, votes: 0 }, pulled: 0, reset: false, conflicts: [] };

  // Pin the upstream's key the first time we see it, like SSH. A changed key stops sync, so only
  // something that is a key gets pinned.
  const info = await fetchJSON(up + '/api/v1/info');
  const key = info && info.hubKey;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('The upstream did not give a valid hub key');
  const pinned = store.get('upstreamKey');
  if (!pinned) store.set('upstreamKey', key);
  else if (pinned !== key) throw new Error('The upstream hub key changed. If that is expected, delete upstreamKey from the node state to trust the new key.');

  // Push what's queued here.
  const bundle = { format: 'sdg-bundle', v: 1, from: cfg.name, created: SDG.util.now() };
  ['proposals', 'comments', 'observations', 'votes'].forEach(k => (bundle[k] = store.outboxList(k)));
  if (bundle.proposals.length + bundle.comments.length + bundle.observations.length + bundle.votes.length) {
    const res = await fetchJSON(up + '/api/v1/bundle', { method: 'POST', body: JSON.stringify(bundle), max: MAX.reply });
    for (const kind of ['proposals', 'comments', 'observations', 'votes']) {
      const done = [];
      (res[kind] || []).forEach(x => {
        // Someone else took this id upstream: keep ours queued and say so, never call it sent.
        const taken = !x.ok && x.status === 409 && x.extra && x.extra.idConflict;
        if (taken) report.conflicts.push({ kind, id: x.id, error: x.error });
        else if (x.ok || (x.status && x.status < 500 && x.status !== 429)) done.push(x.id);
        if (kind === 'proposals') {
          const p = store.getProposal(x.id);
          if (p && taken) { p.note = x.error; store.putProposal(p); }
          else if (p) { p.status = x.ok ? (x.status === 'accepted' ? 'accepted' : 'sent') : 'refused-upstream'; if (!x.ok) p.note = x.error; store.putProposal(p); }
        }
      });
      store.outboxRemove(kind, done);
      report.pushed[kind] = done.length;
    }
  }

  // Pull accepted changes: gather every page, then apply them only if the result matches the
  // signed checkpoint. A mismatch means our copy drifted, so take the full release instead.
  const verified = async cp => cp && cp.key === key && (await SDG.changes.verifyCheckpoint(cp));
  const fullRelease = async cp => {
    const rel = await fetchJSON(up + '/api/v1/release', { timeout: 120e3, max: MAX.release });
    const v = await SDG.changes.verifyRelease(rel, [key]);
    if (!v.hashOk || !v.trusted) throw new Error('The upstream release failed its signature or hash check');
    if (cp && rel.seq < cp.seq) throw new Error('The upstream release is older than its own checkpoint');
    await hub.replaceFromRelease(rel);
    report.reset = true;
  };
  const entries = [];
  for (let n = 0; ; n++) {
    // Too far behind for the feed, or a feed that doesn't end: the signed release is checked as
    // strictly, and never older than what we hold.
    if (n === FEED.pages) { await fullRelease(); break; }
    const feed = await fetchPage(`${up}/api/v1/sync?since=${entries.length ? entries[entries.length - 1].seq : hub.seq}`, FEED.size);
    if (!feed || typeof feed !== 'object') throw new Error('The upstream feed is not a list of changes');
    if (feed.reset) {
      if (!(await verified(feed.checkpoint))) throw new Error('The upstream reset has no valid checkpoint signed by its pinned key');
      hub.checkRollback(feed.checkpoint.seq, 'a reset');
      await fullRelease(feed.checkpoint);
      break;
    }
    if (!Array.isArray(feed.entries) || feed.entries.length > FEED.size) throw new Error('The upstream feed is not a page of changes');
    if (!n && feed.more && feed.head - hub.seq > FEED.size * FEED.pages) { await fullRelease(); break; }
    entries.push(...feed.entries);
    if (feed.more && feed.entries.length) continue;
    if (!(await verified(feed.checkpoint))) throw new Error('The upstream feed has no valid checkpoint signed by its pinned key');
    if (await hub.applyUpstreamEntries(entries, feed.checkpoint)) report.pulled += entries.length;
    else await fullRelease(feed.checkpoint);
    break;
  }

  // Comments and shared observations from everyone else, paged by when the upstream got them
  // (its `received`). Each is checked like any carried item and gets this node's own received
  // time, so apps paging this node never skip one. Nobody else's item replaces one we hold, and
  // a field note's author replaces theirs only with a newer one: an old signed copy, replayed by
  // whoever kept it, never rolls a note back.
  const signer = x => (x && x.sig && x.author && x.author.key) || null;
  const newer = (a, b) => Date.parse(a.created) > Date.parse(b.created);
  // Hiding or showing a comment again gives it a fresh received time, as the hub's hide does, so
  // apps paging this node see the change.
  const setHidden = (c, hidden) => {
    if (!c || !!c.hidden === hidden) return;
    c.hidden = hidden;
    c.received = hub.stamp();
    store.putComment(c);
  };
  for (const [kind, getOne, put] of [['comments', id => store.getComment(id), x => store.putComment(x)], ['observations', id => store.getObservation(id), x => store.putObservation(x)]]) {
    const cursor = kind + 'Received', since = store.get(cursor) || '';
    const list = await fetchPage(`${up}/api/v1/${kind}?since=${encodeURIComponent(since)}`, 1000).catch(() => null);
    if (!Array.isArray(list) || list.length > 1000) continue;
    let last = since;
    for (const x of list) {
      if (x && typeof x.received === 'string' && x.received > last) last = x.received;
      // A comment a moderator hid upstream is listed as {id, target, hidden: true}, unsigned: hide
      // our copy too. That gives whoever answers for the upstream nothing new, since they could
      // already keep any comment from us; one we don't hold stays unknown.
      if (kind === 'comments' && x && x.hidden === true) {
        if (typeof x.id === 'string') setHidden(store.getComment(x.id), true);
        continue;
      }
      const item = x && typeof x === 'object' ? SDG.sign.strip(x, 'received', 'hidden', 'via') : x;
      if (!(await SDG.changes.verifyItems([item], kind)).ok.length) continue;
      const known = getOne(item.id);
      // Un-hidden upstream, a comment comes back whole and signed: show our copy again.
      if (kind === 'comments' && known && known.hidden && signer(known) === signer(item)) { setHidden(known, false); continue; }
      if (known && (kind === 'comments' || signer(known) !== signer(item) || !newer(item, known))) continue;
      put(Object.assign(item, { received: hub.stamp() }));
    }
    store.set(cursor, last);
  }

  // Votes: the newest from each person on each thing wins, whoever carried it.
  const vSince = store.get('votesReceived') || '';
  const votes = await fetchPage(`${up}/api/v1/votes?since=${encodeURIComponent(vSince)}`, 2000).catch(() => null);
  if (Array.isArray(votes) && votes.length <= 2000) {
    let last = vSince, changed = false;
    for (const x of votes) {
      if (x && typeof x.received === 'string' && x.received > last) last = x.received;
      const v = x && typeof x === 'object' ? SDG.sign.strip(x, 'received', 'via') : x;
      if (!(await SDG.changes.verifyItems([v], 'votes')).ok.length) continue;
      const known = store.getVote(v.target, v.author.key);
      if (known && String(known.created) >= String(v.created)) continue;
      store.putVote(Object.assign(v, { received: hub.stamp() }));
      changed = true;
    }
    store.set('votesReceived', last);
    if (changed && hub.votesChanged) hub.votesChanged();
  }
  return report;
}

function startSync(hub) {
  const every = Math.max(1, hub.cfg.syncMinutes) * 60e3;
  let timer = null, delay = 0, running = null, again = null;
  const run = async () => {
    // Asked while a sync is under way (an automatic one, say): run once more after it, so whatever
    // was queued since it started goes too, instead of handing back a run that missed it.
    if (running) return (again = again || running.then(() => { again = null; return run(); }));
    running = (async () => {
      try {
        const report = await syncOnce(hub);
        hub.syncState = { ok: true, at: SDG.util.now(), report };
        delay = every;
      } catch (e) {
        hub.syncState = { ok: false, at: SDG.util.now(), error: e.message };
        delay = Math.min(every * 2, Math.max(60e3, delay * 2 || 60e3));
      }
      running = null;
      clearTimeout(timer);
      timer = setTimeout(run, delay);
      timer.unref && timer.unref();
      return hub.syncState;
    })();
    return running;
  };
  hub.syncNow = run;
  hub.kick = () => { clearTimeout(timer); timer = setTimeout(run, 2000); timer.unref && timer.unref(); };
  hub.stopSync = () => clearTimeout(timer);
  if (hub.cfg.upstream) { timer = setTimeout(run, 1000); timer.unref && timer.unref(); }
}

module.exports = { startSync, syncOnce, fetchJSON };

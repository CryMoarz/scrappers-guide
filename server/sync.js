// Node mode: keep a local mirror in step with an upstream hub, whenever it can be reached.
// Pushes queued contributions, pulls accepted changes, and backs off quietly while offline.
const SDG = require('../core');

async function fetchJSON(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 30e3);
  try {
    const res = await fetch(url, Object.assign({ signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' } }, opts || {}));
    const text = await res.text();
    const body = text ? SDG.util.parse(text) : {};
    if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return body;
  } finally { clearTimeout(t); }
}

async function syncOnce(hub) {
  const { store, cfg } = hub;
  const up = String(cfg.upstream || '').replace(/\/+$/, '');
  if (!up) throw new Error('No upstream hub configured');
  const report = { pushed: { proposals: 0, comments: 0, observations: 0, votes: 0 }, pulled: 0, reset: false, conflicts: [] };

  // Pin the upstream's key the first time we see it, like SSH. A changed key stops sync.
  const info = await fetchJSON(up + '/api/v1/info');
  const pinned = store.get('upstreamKey');
  if (!pinned) store.set('upstreamKey', info.hubKey);
  else if (pinned !== info.hubKey) throw new Error('The upstream hub key changed. If that is expected, delete upstreamKey from the node state to trust the new key.');
  const key = info.hubKey;

  // Push what's queued here.
  const bundle = { format: 'sdg-bundle', v: 1, from: cfg.name, created: SDG.util.now() };
  ['proposals', 'comments', 'observations', 'votes'].forEach(k => (bundle[k] = store.outboxList(k)));
  if (bundle.proposals.length + bundle.comments.length + bundle.observations.length + bundle.votes.length) {
    const res = await fetchJSON(up + '/api/v1/bundle', { method: 'POST', body: JSON.stringify(bundle) });
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
    const rel = await fetchJSON(up + '/api/v1/release', { timeout: 120e3 });
    const v = await SDG.changes.verifyRelease(rel, [key]);
    if (!v.hashOk || !v.trusted) throw new Error('The upstream release failed its signature or hash check');
    if (cp && rel.seq < cp.seq) throw new Error('The upstream release is older than its own checkpoint');
    await hub.replaceFromRelease(rel);
    report.reset = true;
  };
  const entries = [];
  for (let guard = 0; ; guard++) {
    if (guard >= 50) throw new Error('The upstream feed did not end; try again later');
    const feed = await fetchJSON(`${up}/api/v1/sync?since=${entries.length ? entries[entries.length - 1].seq : hub.seq}`);
    if (feed.reset) {
      if (!(await verified(feed.checkpoint))) throw new Error('The upstream reset has no valid checkpoint signed by its pinned key');
      hub.checkRollback(feed.checkpoint.seq, 'a reset');
      await fullRelease(feed.checkpoint);
      break;
    }
    if (!Array.isArray(feed.entries)) throw new Error('The upstream feed is not a list of changes');
    entries.push(...feed.entries);
    if (feed.more && feed.entries.length) continue;
    if (!(await verified(feed.checkpoint))) throw new Error('The upstream feed has no valid checkpoint signed by its pinned key');
    if (await hub.applyUpstreamEntries(entries, feed.checkpoint)) report.pulled += entries.length;
    else await fullRelease(feed.checkpoint);
    break;
  }

  // Comments and shared observations from everyone else, paged by when the upstream got them
  // (its `received`). Each is checked like any carried item and gets this node's own received
  // time, so apps paging this node never skip one. Nobody else's item replaces one we hold.
  const signer = x => (x && x.sig && x.author && x.author.key) || null;
  for (const [kind, getOne, put] of [['comments', id => store.getComment(id), x => store.putComment(x)], ['observations', id => store.getObservation(id), x => store.putObservation(x)]]) {
    const cursor = kind + 'Received', since = store.get(cursor) || '';
    const list = await fetchJSON(`${up}/api/v1/${kind}?since=${encodeURIComponent(since)}&limit=1000`).catch(() => null);
    if (!Array.isArray(list)) continue;
    let last = since;
    for (const x of list) {
      if (x && typeof x.received === 'string' && x.received > last) last = x.received;
      const item = x && typeof x === 'object' ? SDG.sign.strip(x, 'received', 'hidden', 'via') : x;
      if (!(await SDG.changes.verifyItems([item], kind)).ok.length) continue;
      const known = getOne(item.id);
      if (known && (kind === 'comments' || signer(known) !== signer(item))) continue;
      put(Object.assign(item, { received: hub.stamp() }));
    }
    store.set(cursor, last);
  }

  // Votes: the newest from each person on each thing wins, whoever carried it.
  const vSince = store.get('votesReceived') || '';
  const votes = await fetchJSON(`${up}/api/v1/votes?since=${encodeURIComponent(vSince)}&limit=5000`).catch(() => null);
  if (Array.isArray(votes)) {
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

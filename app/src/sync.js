// Talking to a hub or node when there is one. Everything works without it; this only moves
// contributions out and accepted changes in, whenever a connection happens to exist.
const Sync = (() => {
  let timer = null, backoff = 0, running = null;
  const MIN = 60e3;

  async function api(path, opts) {
    const base = S.settings.hubUrl.replace(/\/+$/, '');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 20e3);
    try {
      const init = { signal: ctl.signal, headers: {} };
      if (opts && opts.body !== undefined) { init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
      if (opts && opts.etag) init.headers['If-None-Match'] = opts.etag;
      const res = await fetch(base + path, init);
      if (res.status === 304) return { notModified: true };
      const body = await res.text().then(SDG.util.parse).catch(() => ({}));
      if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; e.body = body; throw e; }
      return body;
    } finally { clearTimeout(t); }
  }

  // Signs one draft with the right work stamp for this hub and this contributor.
  async function finalize(item, bits) {
    const o = SDG.sign.strip(item, 'sig', 'author', 'pow');
    if (bits) o.pow = await SDG.sign.stamp(o, bits);
    return S.identity ? SDG.sign.sign(o, S.identity) : o;
  }
  function stampBits(info, me) {
    const p = (info && info.policy) || { powBits: 12, powBitsKnown: 0 };
    return me && (me.accepted >= 3 || ['trusted', 'moderator', 'admin'].includes(me.role)) ? p.powBitsKnown : p.powBits;
  }
  // Cursors follow the hub's own `received` times, never the dates senders chose.
  const lastReceived = (list, since) => (Array.isArray(list) ? list : []).reduce((m, x) => (x && typeof x.received === 'string' && x.received > m ? x.received : m), since);
  const draftOf = e => ({ id: e.id, coll: e.coll, rid: e.rid, op: e.op, data: e.op === 'put' ? Object.assign({}, e.data, { id: e.rid }) : undefined, baseRev: e.baseRev, reason: e.reason || '', source: 'human', created: e.created });

  // A release is used only when it matches its hash and is signed by a maintainer key (TRUST) or
  // the pinned key of the hub it came from, unless the person said to (o.untrustedOk, from a file);
  // and never to go back to older data unless they confirmed it (o.olderOk).
  async function applyRelease(rel, sourceLabel, o) {
    o = o || {};
    const v = await SDG.changes.verifyRelease(rel, [...TRUST.map(k => k.key), ...(o.keys || [])]);
    if (!v.hashOk || !Number.isInteger(rel.seq)) throw new Error('The data failed its integrity check; not using it');
    if (!v.trusted && !o.untrustedOk) throw new Error('The data isn’t signed by a key this app trusts; not using it');
    if (rel.seq < S.base.seq && !o.olderOk) throw new Error(`That data (version ${rel.seq}) is older than yours (${S.base.seq}); not using it`);
    // Signed is not the same as sound: every record is checked as strictly as a ledger entry, so
    // one bad release can't leave the app unable to open its own data.
    const ds = rel.dataset;
    const sound = ds && typeof ds === 'object' && !Array.isArray(ds) && (!ds.vocab || (typeof ds.vocab === 'object' && !Array.isArray(ds.vocab))) &&
      SDG.db.COLLS.every(c => !SDG.util.has(ds, c) || (Array.isArray(ds[c]) && ds[c].every(r => r && SDG.schema.validateRecord(c, r).ok)));
    if (!sound) throw new Error('The data has records that don’t check out; not using it');
    S.base = { seq: rel.seq, hash: rel.hash, created: rel.created, name: rel.name, source: sourceLabel, signed: v.signed, trusted: v.trusted, key: v.key, dataset: rel.dataset };
    return v;
  }
  // Ledger entries are checked as strictly as the hub checks a proposal before they touch anything.
  function checkEntry(e) {
    const ok = e && Number.isInteger(e.seq) && SDG.db.COLLS.includes(e.coll) && /^[a-z0-9][a-z0-9_]*$/.test(e.rid || '') &&
      (e.op === 'delete' || (e.op === 'put' && e.data && e.data.id === e.rid && SDG.schema.validateRecord(e.coll, e.data).ok));
    if (!ok) throw new Error('The hub sent a change that doesn’t check out; not using it');
  }
  // Pulled comments and notes are validated and signature-checked like anything carried, and
  // lose any local-only fields (mine, sent), so nothing pulled is ever re-signed as ours.
  async function pulled(list, kind) {
    const items = (Array.isArray(list) ? list : []).map(x => SDG.sign.strip(x, 'received', 'hidden', 'via', 'mine', 'sent'));
    return (await SDG.changes.verifyItems(items, kind)).ok;
  }

  async function run(manual) {
    if (running) return running;
    if (!S.settings.hubUrl) { if (manual) toast('Set a hub address first'); return null; }
    running = (async () => {
      const before = viewState();
      S.hub.syncing = true; badge();
      const report = { sent: 0, refused: 0, pulled: 0, reset: false };
      try {
        const info = await api('/api/v1/info', { timeout: 8000 });
        const url = S.settings.hubUrl;
        const pinned = (S.settings.hubKeys || {})[url];
        if (pinned && pinned !== info.hubKey) throw new Error('This hub’s key has changed. If you expected that, forget the hub in Sync and connect again.');
        if (!pinned) { S.settings.hubKeys = Object.assign({}, S.settings.hubKeys, { [url]: info.hubKey }); await save('settings'); }
        S.hub.info = info;
        S.hub.appOk = (await SDG.changes.verifyAppBuild(info.app, TRUST.map(k => k.key))) ? info.app.id : null;
        S.hub.me = S.identity ? await api('/api/v1/users/' + encodeURIComponent(S.identity.key)).catch(() => null) : null;

        // 1. Send what's queued, plus anything carried for others.
        if (S.identity) {
          const bits = stampBits(info, S.hub.me);
          const edits = S.edits.filter(e => e.share && e.status === 'queued');
          const comments = S.outbox.comments.filter(c => c.status === 'queued');
          const obs = S.observations.filter(o => o.mine && o.share === 'public' && !o.sent);
          const votes = S.outbox.votes.filter(v => v.status === 'queued');
          const bundle = SDG.changes.makeBundle({ from: S.identity.name || 'app' });
          bundle.proposals = [...await Promise.all(edits.map(e => finalize(draftOf(e), bits))), ...S.carry.proposals];
          bundle.comments = [...await Promise.all(comments.map(c => finalize(c.item, bits))), ...S.carry.comments];
          bundle.observations = [...await Promise.all(obs.map(o => finalize(SDG.sign.strip(o, 'mine', 'sent'), bits))), ...S.carry.observations];
          bundle.votes = [...await Promise.all(votes.map(v => finalize(v.item, bits))), ...S.carry.votes];
          if (bundle.proposals.length + bundle.comments.length + bundle.observations.length + bundle.votes.length) {
            const res = await api('/api/v1/bundle', { body: bundle, timeout: 60e3 });
            (res.proposals || []).forEach(r => {
              const e = S.edits.find(x => x.id === r.id);
              if (!e) return;
              if (r.ok) { e.status = r.status === 'accepted' ? 'accepted' : 'pending'; if (r.seq) e.seq = r.seq; report.sent++; }
              else if (r.status >= 500 || r.status === 429) { /* try again later */ }
              else { e.status = 'refused'; e.note = r.error + (r.extra && r.extra.errors ? ': ' + r.extra.errors.map(x => `${x.path} ${x.msg}`).join('; ') : ''); report.refused++; }
            });
            (res.comments || []).forEach(r => { const c = S.outbox.comments.find(x => x.item.id === r.id); if (c) { c.status = r.ok ? 'sent' : 'refused'; c.note = r.error; } });
            (res.observations || []).forEach(r => { const o = S.observations.find(x => x.id === r.id); if (o && r.ok) o.sent = true; });
            (res.votes || []).forEach(r => { const v = S.outbox.votes.find(x => x.item.id === r.id); if (v && !(r.status >= 500 || r.status === 429)) { v.status = r.ok ? 'sent' : 'refused'; v.note = r.error; } });
            S.carry = { proposals: [], comments: [], observations: [], votes: [] };
          }
        }

        // 2. Pull accepted changes into a copy, every page, and keep them only when the result
        // matches a checkpoint signed by this hub's pinned key. Otherwise take its signed release.
        const fullRelease = async () => {
          const rel = await api('/api/v1/release', { timeout: 120e3, etag: `"${S.base.hash}"` });
          if (rel.notModified) return;
          const older = rel.seq < S.base.seq;
          // Older data signed by the same hub key that signed what this device holds is that hub's
          // own word (a restore from backup, or undoing a mistake), not a rollback by someone else.
          const sameHub = !!S.base.key && S.base.key === info.hubKey;
          if (older && !sameHub && !(manual && confirm(`The hub has older data (version ${rel.seq}) than this device (${S.base.seq}). Use the hub’s anyway?`))) throw new Error(`The hub offered older data (version ${rel.seq}) than yours (${S.base.seq}); kept yours`);
          await applyRelease(rel, url, { keys: [info.hubKey], olderOk: older });
          report.reset = true;
        };
        let ds = null, seq = S.base.seq;
        const got = [];
        for (let guard = 0; ; guard++) {
          if (guard >= 40) throw new Error('The hub’s list of changes didn’t end; try again later');
          const feed = await api('/api/v1/sync?since=' + seq);
          if (feed.reset) { await fullRelease(); break; }
          const entries = (Array.isArray(feed.entries) ? feed.entries : []).filter(e => e && e.seq > seq).sort((a, b) => a.seq - b.seq);
          entries.forEach(checkEntry);
          if (entries.length) {
            ds = ds || SDG.util.clone(S.base.dataset);
            SDG.changes.applyLedger(ds, entries);
            seq = entries[entries.length - 1].seq;
            got.push(...entries);
          }
          if (feed.more && entries.length) continue;
          const cp = feed.checkpoint;
          if (!cp || cp.key !== info.hubKey || !(await SDG.changes.verifyCheckpoint(cp))) throw new Error('The hub’s changes came without a valid signed checkpoint; not using them');
          if (cp.seq === seq && cp.hash === (await SDG.changes.datasetHash(ds || S.base.dataset))) {
            S.base = Object.assign({}, S.base, { dataset: ds || S.base.dataset, seq, hash: cp.hash, source: ds ? url : S.base.source });
            report.pulled += got.length;
            got.forEach(en => { const e = S.edits.find(x => x.id === en.proposal); if (e) { e.status = 'accepted'; e.seq = en.seq; e.confirmed = true; } });
          } else await fullRelease();
          break;
        }

        // 3. What happened to my proposals.
        if (S.identity) {
          const mine = await api(`/api/v1/proposals?author=${encodeURIComponent(S.identity.key)}&order=newest&limit=300`).catch(() => []);
          mine.forEach(p => { const e = S.edits.find(x => x.id === p.id); if (e && p.status !== 'queued') { e.status = p.status; if (p.seq) e.seq = p.seq; if (p.note) e.note = p.note; } });
        }
        // Accepted edits that the base now contains are no longer local.
        S.edits = S.edits.filter(e => !editDone(e));

        // 4. Comments and shared observations.
        if (S.settings.comments && (info.policy || {}).comments !== 'off') {
          const since = S.settings.commentsReceived || '';
          const list = await api('/api/v1/comments?since=' + encodeURIComponent(since) + '&limit=1000').catch(() => []);
          if (Array.isArray(list)) list.forEach(dropComment);
          (await pulled(list, 'comments')).forEach(c => addComment(c));
          S.settings.commentsReceived = lastReceived(list, since);
          S.outbox.comments = S.outbox.comments.filter(c => c.status !== 'sent');
        }
        const oSince = S.settings.observationsReceived || '';
        const obsList = await api('/api/v1/observations?since=' + encodeURIComponent(oSince)).catch(() => []);
        (await pulled(obsList, 'observations')).forEach(o => { if (!S.observations.some(x => x.id === o.id)) S.observations.push(o); });
        S.settings.observationsReceived = lastReceived(obsList, oSince);
        // 5. Votes: the newest from each person on each thing.
        if ((info.policy || {}).votes) {
          const vSince = S.settings.votesReceived || '';
          const vList = await api('/api/v1/votes?since=' + encodeURIComponent(vSince) + '&limit=5000').catch(() => []);
          mergeVotes(await pulled(vList, 'votes'));
          S.settings.votesReceived = lastReceived(vList, vSince);
          S.outbox.votes = S.outbox.votes.filter(v => v.status !== 'sent');
          retally();
        }
        if (S.observations.length > 5000) S.observations = S.observations.filter(o => o.mine).concat(S.observations.filter(o => !o.mine).slice(-4000));

        S.hub.online = true; S.hub.error = null; S.hub.lastSync = new Date().toISOString(); S.hub.report = report;
        backoff = 0;
        await saveAll();
        rebuild();
        if (manual) toast(`Synced: ${report.sent} sent, ${report.pulled} changes in${report.reset ? ', full update' : ''}${report.refused ? `, ${report.refused} refused` : ''}`);
      } catch (e) {
        S.hub.online = false;
        S.hub.error = e.name === 'AbortError' ? 'Hub not reachable' : /fetch|network|Failed/i.test(e.message) ? 'Hub not reachable' : e.message;
        backoff = Math.min(30 * MIN, backoff ? backoff * 2 : MIN);
        await save('edits');
        if (manual) toast('Sync failed: ' + S.hub.error);
      } finally {
        S.hub.syncing = false;
        await save('hub');
        badge();
        rerender(manual || before !== viewState());
        schedule();
        running = null;
      }
      return report;
    })();
    return running;
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (!S.settings.hubUrl || !S.settings.autoSync) return;
    timer = setTimeout(() => { if (document.visibilityState !== 'hidden' || delay) run(false); else schedule(); }, delay != null ? delay : backoff || 15 * MIN);
  }
  window.addEventListener('online', () => schedule(1500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.hub.lastSync && Date.now() - Date.parse(S.hub.lastSync) > 15 * MIN) schedule(1000); });

  // Same-origin hub: when the app is served by a hub or node, connect to it automatically.
  async function detect() {
    if (S.settings.hubUrl || !/^https?:$/.test(location.protocol)) return false;
    try {
      const res = await fetch(location.origin + '/api/v1/info', { cache: 'no-store' });
      if (!res.ok) return false;
      const info = await res.json();
      if (info && info.hubKey) { S.settings.hubUrl = location.origin; await save('settings'); return true; }
    } catch (e) { /* not served by a hub */ }
    return false;
  }

  return { api, run, schedule, detect, finalize, applyRelease, stampBits, checkEntry };
})();

// Community state for a hub or node: the ledger of accepted changes, proposals and reviews,
// comments, observations, votes, users and the outbox of things waiting to go upstream.
// Uses Node's built-in SQLite when it exists (Node 22.13+), otherwise plain JSON-lines files,
// so it still runs on small boards with an older Node.
const fs = require('fs');
const path = require('path');

const TABLES = ['ledger', 'proposals', 'reviews', 'comments', 'observations', 'votes', 'users', 'outbox', 'kv'];

function loadSqlite() {
  try {
    const orig = process.emitWarning;
    process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : orig.call(process, w, ...a));
    const m = require('node:sqlite');
    process.emitWarning = orig;
    return m;
  } catch (e) { return null; }
}

class SqliteStore {
  constructor(file, sqlite) {
    this.kind = 'sqlite';
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, coll TEXT, rid TEXT, op TEXT, at TEXT, json TEXT);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, status TEXT, coll TEXT, rid TEXT, author TEXT, created TEXT, json TEXT);
      CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status, created);
      CREATE INDEX IF NOT EXISTS proposals_rec ON proposals(coll, rid);
      CREATE TABLE IF NOT EXISTS reviews (proposal TEXT, reviewer TEXT, json TEXT, PRIMARY KEY (proposal, reviewer));
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, target TEXT, created TEXT, hidden INTEGER DEFAULT 0, json TEXT);
      CREATE INDEX IF NOT EXISTS comments_target ON comments(target, created);
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, share TEXT, lat REAL, lon REAL, created TEXT, json TEXT);
      CREATE TABLE IF NOT EXISTS votes (target TEXT, voter TEXT, value INTEGER, created TEXT, received TEXT, json TEXT, PRIMARY KEY (target, voter));
      CREATE INDEX IF NOT EXISTS votes_received ON votes(received);
      CREATE TABLE IF NOT EXISTS users (key TEXT PRIMARY KEY, json TEXT);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT, created TEXT, json TEXT);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    `);
    // Comments and observations page by when this store got them (`received`), never by the
    // sender's own date. Older databases get the column, filled from a date that isn't ahead.
    const now = new Date().toISOString();
    for (const t of ['comments', 'observations']) {
      if (this.db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'received')) continue;
      this.db.exec(`ALTER TABLE ${t} ADD COLUMN received TEXT`);
      this.db.prepare(`UPDATE ${t} SET received = CASE WHEN created IS NULL OR created > ? THEN ? ELSE created END`).run(now, now);
      this.db.exec(`UPDATE ${t} SET json = json_set(json, '$.received', received) WHERE json_extract(json, '$.received') IS NULL`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS comments_received ON comments(received); CREATE INDEX IF NOT EXISTS observations_received ON observations(received);');
    this.q = {};
  }
  prep(sql) { return this.q[sql] || (this.q[sql] = this.db.prepare(sql)); }
  all(sql, ...a) { return this.prep(sql).all(...a).map(r => JSON.parse(r.json)); }
  one(sql, ...a) { const r = this.prep(sql).get(...a); return r ? JSON.parse(r.json) : null; }

  appendLedger(e) { this.prep('INSERT INTO ledger (seq, coll, rid, op, at, json) VALUES (?,?,?,?,?,?)').run(e.seq, e.coll, e.rid, e.op, e.at ?? null, JSON.stringify(e)); }
  ledgerSince(seq, limit) { return this.all('SELECT json FROM ledger WHERE seq > ? ORDER BY seq LIMIT ?', seq, limit || 5000); }
  ledgerHead() { const r = this.prep('SELECT MAX(seq) AS s FROM ledger').get(); return (r && r.s) || 0; }
  ledgerMin() { const r = this.prep('SELECT MIN(seq) AS s FROM ledger').get(); return (r && r.s) || 0; }
  ledgerFor(coll, rid) { return this.all('SELECT json FROM ledger WHERE coll = ? AND rid = ? ORDER BY seq', coll, rid); }

  putProposal(p) { this.prep('INSERT OR REPLACE INTO proposals (id, status, coll, rid, author, created, json) VALUES (?,?,?,?,?,?,?)').run(p.id, p.status, p.coll, p.rid, (p.author && p.author.key) || '', p.created ?? null, JSON.stringify(p)); }
  getProposal(id) { return this.one('SELECT json FROM proposals WHERE id = ?', id); }
  listProposals(f) {
    f = f || {};
    const where = [], args = [];
    if (f.status) { where.push('status = ?'); args.push(f.status); }
    if (f.coll) { where.push('coll = ?'); args.push(f.coll); }
    if (f.rid) { where.push('rid = ?'); args.push(f.rid); }
    if (f.author) { where.push('author = ?'); args.push(f.author); }
    if (f.since) { where.push('created > ?'); args.push(f.since); }
    args.push(f.limit || 200);
    return this.all(`SELECT json FROM proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created ${f.desc ? 'DESC' : 'ASC'} LIMIT ?`, ...args);
  }
  putReview(r) { this.prep('INSERT OR REPLACE INTO reviews (proposal, reviewer, json) VALUES (?,?,?)').run(r.proposal, r.author.key, JSON.stringify(r)); }
  reviewsFor(pid) { return this.all('SELECT json FROM reviews WHERE proposal = ?', pid); }

  putComment(c) { this.prep('INSERT OR REPLACE INTO comments (id, target, created, received, hidden, json) VALUES (?,?,?,?,?,?)').run(c.id, c.target, c.created ?? null, c.received || c.created || null, c.hidden ? 1 : 0, JSON.stringify(c)); }
  getComment(id) { return this.one('SELECT json FROM comments WHERE id = ?', id); }
  listComments(f) {
    f = f || {};
    const where = [], args = [];
    if (f.target) { where.push('target = ?'); args.push(f.target); }
    if (!f.includeHidden) where.push('hidden = 0');
    if (f.since) { where.push('received > ?'); args.push(f.since); }
    args.push(f.limit || 200);
    return this.all(`SELECT json FROM comments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY received ${f.desc ? 'DESC' : 'ASC'} LIMIT ?`, ...args);
  }
  countComments(target) { return this.prep('SELECT COUNT(*) AS n FROM comments WHERE target = ? AND hidden = 0').get(target).n; }

  putObservation(o) { this.prep('INSERT OR REPLACE INTO observations (id, share, lat, lon, created, received, json) VALUES (?,?,?,?,?,?,?)').run(o.id, o.share, o.lat ?? null, o.lon ?? null, o.created ?? null, o.received || o.created || null, JSON.stringify(o)); }
  getObservation(id) { return this.one('SELECT json FROM observations WHERE id = ?', id); }
  listObservations(f) {
    f = f || {};
    const where = ['share IN (' + (f.shares || ['public']).map(() => '?').join(',') + ')'], args = [...(f.shares || ['public'])];
    if (f.bbox) { where.push('lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?'); args.push(f.bbox[1], f.bbox[3], f.bbox[0], f.bbox[2]); }
    if (f.since) { where.push('received > ?'); args.push(f.since); }
    args.push(f.limit || 1000);
    return this.all(`SELECT json FROM observations WHERE ${where.join(' AND ')} ORDER BY received ${f.desc ? 'DESC' : 'ASC'} LIMIT ?`, ...args);
  }

  // One vote per person per target: the newest replaces the last.
  putVote(v) { this.prep('INSERT OR REPLACE INTO votes (target, voter, value, created, received, json) VALUES (?,?,?,?,?,?)').run(v.target, v.author.key, v.value, v.created ?? null, v.received || v.created || null, JSON.stringify(v)); }
  getVote(target, voter) { return this.one('SELECT json FROM votes WHERE target = ? AND voter = ?', target, voter); }
  listVotes(f) {
    f = f || {};
    const where = [], args = [];
    if (f.target) { where.push('target = ?'); args.push(f.target); }
    if (f.prefix) { where.push('substr(target, 1, ?) = ?'); args.push(f.prefix.length, f.prefix); }
    if (f.since) { where.push('received > ?'); args.push(f.since); }
    args.push(f.limit || 1000);
    return this.all(`SELECT json FROM votes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY received ${f.desc ? 'DESC' : 'ASC'} LIMIT ?`, ...args);
  }

  getUser(key) { return this.one('SELECT json FROM users WHERE key = ?', key); }
  putUser(u) { this.prep('INSERT OR REPLACE INTO users (key, json) VALUES (?,?)').run(u.key, JSON.stringify(u)); }
  listUsers() { return this.all('SELECT json FROM users'); }

  outboxAdd(kind, item) { this.prep('INSERT OR IGNORE INTO outbox (id, kind, created, json) VALUES (?,?,?,?)').run(kind + ':' + item.id, kind, item.created || new Date().toISOString(), JSON.stringify(item)); }
  outboxList(kind) { return this.prep('SELECT id, json FROM outbox WHERE kind = ? ORDER BY created').all(kind).map(r => JSON.parse(r.json)); }
  outboxRemove(kind, ids) { const st = this.prep('DELETE FROM outbox WHERE id = ?'); ids.forEach(id => st.run(kind + ':' + id)); }

  get(k) { const r = this.prep('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : undefined; }
  set(k, v) { this.prep('INSERT OR REPLACE INTO kv (k, v) VALUES (?,?)').run(k, JSON.stringify(v)); }
  close() { this.db.close(); }
}

// Same interface, kept in memory and persisted as append-only JSON lines (last line per id wins).
class FileStore {
  constructor(dir) {
    this.kind = 'files';
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.t = {};
    TABLES.forEach(name => {
      const m = new Map();
      const file = path.join(dir, name + '.jsonl');
      if (fs.existsSync(file)) fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
        if (!line) return;
        try { const { k, v } = JSON.parse(line); if (v === null) m.delete(k); else m.set(k, v); } catch (e) { /* torn last line */ }
      });
      this.t[name] = m;
    });
    const now = new Date().toISOString();
    ['comments', 'observations'].forEach(name => this.t[name].forEach(x => { if (!x.received) x.received = !x.created || x.created > now ? now : x.created; }));
    this.compact();
  }
  write(name, k, v) {
    if (v === null) this.t[name].delete(k); else this.t[name].set(k, v);
    fs.appendFileSync(path.join(this.dir, name + '.jsonl'), JSON.stringify({ k, v }) + '\n');
  }
  compact() {
    TABLES.forEach(name => {
      const file = path.join(this.dir, name + '.jsonl');
      const text = [...this.t[name]].map(([k, v]) => JSON.stringify({ k, v })).join('\n');
      fs.writeFileSync(file + '.tmp', text ? text + '\n' : '');
      fs.renameSync(file + '.tmp', file);
    });
  }
  vals(name) { return [...this.t[name].values()]; }
  page(list, f, key) { list.sort((a, b) => String(a[key]).localeCompare(String(b[key]))); if (f && f.desc) list.reverse(); return list.slice(0, (f && f.limit) || 200); }

  appendLedger(e) { this.write('ledger', String(e.seq).padStart(12, '0'), e); }
  ledgerSince(seq, limit) { return this.vals('ledger').filter(e => e.seq > seq).sort((a, b) => a.seq - b.seq).slice(0, limit || 5000); }
  ledgerHead() { return this.vals('ledger').reduce((m, e) => Math.max(m, e.seq), 0); }
  ledgerMin() { const v = this.vals('ledger'); return v.length ? v.reduce((m, e) => Math.min(m, e.seq), Infinity) : 0; }
  ledgerFor(coll, rid) { return this.vals('ledger').filter(e => e.coll === coll && e.rid === rid).sort((a, b) => a.seq - b.seq); }

  putProposal(p) { this.write('proposals', p.id, p); }
  getProposal(id) { return this.t.proposals.get(id) || null; }
  listProposals(f) {
    f = f || {};
    return this.page(this.vals('proposals').filter(p => (!f.status || p.status === f.status) && (!f.coll || p.coll === f.coll) && (!f.rid || p.rid === f.rid) &&
      (!f.author || (p.author && p.author.key) === f.author) && (!f.since || p.created > f.since)), f, 'created');
  }
  putReview(r) { this.write('reviews', r.proposal + '|' + r.author.key, r); }
  reviewsFor(pid) { return this.vals('reviews').filter(r => r.proposal === pid); }

  putComment(c) { this.write('comments', c.id, Object.assign({}, c, { received: c.received || c.created })); }
  getComment(id) { return this.t.comments.get(id) || null; }
  listComments(f) {
    f = f || {};
    return this.page(this.vals('comments').filter(c => (!f.target || c.target === f.target) && (f.includeHidden || !c.hidden) && (!f.since || c.received > f.since)), f, 'received');
  }
  countComments(target) { return this.vals('comments').filter(c => c.target === target && !c.hidden).length; }

  putObservation(o) { this.write('observations', o.id, Object.assign({}, o, { received: o.received || o.created })); }
  getObservation(id) { return this.t.observations.get(id) || null; }
  listObservations(f) {
    f = f || {};
    const shares = f.shares || ['public'];
    return this.page(this.vals('observations').filter(o => shares.includes(o.share) && (!f.since || o.received > f.since) &&
      (!f.bbox || (o.lon >= f.bbox[0] && o.lat >= f.bbox[1] && o.lon <= f.bbox[2] && o.lat <= f.bbox[3]))), f, 'received');
  }

  putVote(v) { this.write('votes', v.target + '|' + v.author.key, Object.assign({}, v, { received: v.received || v.created })); }
  getVote(target, voter) { return this.t.votes.get(target + '|' + voter) || null; }
  listVotes(f) {
    f = f || {};
    return this.page(this.vals('votes').filter(v => (!f.target || v.target === f.target) && (!f.prefix || v.target.startsWith(f.prefix)) && (!f.since || v.received > f.since)), Object.assign({ limit: 1000 }, f), 'received');
  }

  getUser(key) { return this.t.users.get(key) || null; }
  putUser(u) { this.write('users', u.key, u); }
  listUsers() { return this.vals('users'); }

  outboxAdd(kind, item) { if (!this.t.outbox.has(kind + ':' + item.id)) this.write('outbox', kind + ':' + item.id, { kind, item }); }
  outboxList(kind) { return this.vals('outbox').filter(o => o.kind === kind).map(o => o.item); }
  outboxRemove(kind, ids) { ids.forEach(id => this.write('outbox', kind + ':' + id, null)); }

  get(k) { return this.t.kv.get(k); }
  set(k, v) { this.write('kv', k, v); }
  close() {}
}

function openStore(dir, prefer) {
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = prefer === 'files' ? null : loadSqlite();
  if (sqlite) return new SqliteStore(path.join(dir, 'hub.sqlite'), sqlite);
  return new FileStore(path.join(dir, 'store'));
}

module.exports = { openStore, SqliteStore, FileStore, TABLES };

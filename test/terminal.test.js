// tools/mod.js and tools/sync.js print what hubs and bundles say, which anyone can write. Escape
// codes in it must reach the terminal as visible text, never as commands that rewrite lines, hide
// the stale and AI flags, or draw a fake diff.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const SDG = require('../core');

const TOOLS = path.join(__dirname, '..', 'tools');
const ESC = '\x1b';
// A reason that moves up a line, clears it, prints a harmless-looking proposal, then hides the rest.
const EVIL = `${ESC}[1A${ESC}[2K\rabc123  put    devices/microwave_tx\n    by Helper: fix typo${ESC}[8m`;
// Anything a terminal acts on, apart from the line breaks the tools print themselves.
const RAW = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

// A hub that answers every path from a table: [status, body].
async function fakeHub(t, routes) {
  const server = http.createServer((req, res) => {
    const [status, body] = routes[req.method + ' ' + req.url] || [404, { error: 'no route' }];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const tool = async (name, ...args) => {
  try { const r = await execFile(process.execPath, [path.join(TOOLS, name), ...args], { encoding: 'utf8' }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { return { code: e.code, out: e.stdout + e.stderr }; }
};

test('mod.js: contributor text is escaped, and the AI and stale flags come after it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-term-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'mod.key');
  fs.writeFileSync(key, JSON.stringify(await SDG.sign.createIdentity('Moderator')));
  const proposal = { id: 'abc123', op: 'delete', coll: 'hazards', rid: 'lithium', status: 'pending', stale: true, source: 'ai', author: { name: `x\u202eevil` }, reason: EVIL };
  const hub = await fakeHub(t, {
    'GET /api/v1/proposals?status=pending': [200, [proposal]],
    'GET /api/v1/info': [200, { hubKey: 'hub-key' }],
    // The change shown is worked out from the proposal and the current record, so hostile text can
    // sit in either.
    'GET /api/v1/proposals/abc123': [200, { proposal: Object.assign({}, proposal, { op: 'put', data: { [`name${ESC}[31m`]: 'new\u2066' } }), current: { [`name${ESC}[31m`]: 'old\u009b2J' }, stale: true, problems: [{ coll: 'hazards', id: 'lithium', path: 'name', msg: `bad${ESC}]0;title\x07` }] }],
    'GET /api/v1/proposals/nope': [400, { error: `No such proposal${ESC}[2J`, errors: [{ coll: 'parts', id: `x${ESC}[1A`, path: 'name', msg: 'm\u202e' }] }],
    'POST /api/v1/proposals/abc123/review': [200, { ok: true, status: 'rejected', note: `${ESC}[2J\u202e` }],
  });

  const pending = await tool('mod.js', hub, key, 'pending');
  assert.equal(pending.code, 0, pending.out);
  assert.doesNotMatch(pending.out, RAW);
  assert.match(pending.out, /^abc123  delete hazards\/lithium  \(stale\)  \[AI\]\n {4}by x\\u202eevil: \\u001b\[1A\\u001b\[2K\\u000dabc123 .*\\u000a {4}by Helper: fix typo\\u001b\[8m\n$/);

  const show = await tool('mod.js', hub, key, 'show', 'abc123');
  assert.equal(show.code, 0, show.out);
  assert.doesNotMatch(show.out, RAW);
  const lines = show.out.split('\n');
  const at = lines.findIndex(l => l.startsWith('Reason: '));
  assert.ok(at > 0 && lines[at].includes('\\u001b[8m'), 'the whole reason is on one line');
  assert.match(lines[at + 1], /^AI: /);
  assert.match(lines[at + 2], /^STALE: /);
  assert.match(show.out, /name\\u001b\[31m\n {4}- "old\\u009b2J"\n {4}\+ "new\\u2066"/);
  assert.match(show.out, /bad\\u001b\]0;title\\u0007/);

  const missing = await tool('mod.js', hub, key, 'show', 'nope');
  assert.equal(missing.code, 1);
  assert.doesNotMatch(missing.out, RAW);
  assert.match(missing.out, /^No such proposal\\u001b\[2J\n {2}parts\/x\\u001b\[1A name m\\u202e\n$/);

  const reject = await tool('mod.js', hub, key, 'reject', 'abc123', 'no');
  assert.equal(reject.code, 0, reject.out);
  assert.doesNotMatch(reject.out, RAW);
  assert.match(reject.out, /status: 'rejected'/);
});

test('sync.js: the signature verdict comes first, and bundle and hub text is escaped', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-term-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bundle.json');
  fs.writeFileSync(file, JSON.stringify({
    format: 'sdg-bundle', v: 1, created: '2026-11-17T00:00:00Z', from: `x${ESC}[2J`,
    release: { format: 'sdg-release', schema: 3, name: 'n', seq: `7${ESC}[1A`, created: `${ESC}[2K\rRelease: hash ok, signature valid\u202e`, hash: 'x', dataset: {} },
    proposals: [{ id: `p${ESC}[2K\u202e`, coll: 'parts' }],
    ledger: [{ seq: `9${ESC}[8m` }],
  }));
  const inspect = await tool('sync.js', 'inspect', file);
  assert.equal(inspect.code, 0, inspect.out);
  assert.doesNotMatch(inspect.out, RAW);
  const lines = inspect.out.split('\n');
  assert.match(lines[0], /^Release: hash BAD, signature missing or bad; it says seq 7\\u001b\[1A, made \\u001b\[2K\\u000dRelease: hash ok, signature valid\\u202e$/);
  assert.match(lines[1], /^proposals: 0 valid, 1 bad$/);
  assert.match(lines[2], /^ {2}p\\u001b\[2K\\u202e: /);
  assert.match(inspect.out, /up to seq 9\\u001b\[8m/);
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, `{"a": x${ESC}[2J\nRelease: hash ok, signature valid\u202e}`);
  const parse = await tool('sync.js', 'inspect', broken);
  assert.equal(parse.code, 1);
  assert.doesNotMatch(parse.out, RAW);
  assert.equal(parse.out.trim().split('\n').length, 1, 'a parser error that quotes the file stays on one line');

  const refused = await fakeHub(t, { 'POST /api/v1/bundle': [200, { proposals: [{ id: `q${ESC}[1A`, ok: false, error: `nope\u202e${ESC}[8m` }] }] });
  const push = await tool('sync.js', 'push', refused, file);
  assert.equal(push.code, 0, push.out);
  assert.doesNotMatch(push.out, RAW);
  assert.match(push.out, /^proposals: 0 taken, 1 refused\n {2}q\\u001b\[1A: nope\\u202e\\u001b\[8m\n$/);

  const failed = await fakeHub(t, { 'POST /api/v1/bundle': [400, { error: `Bad bundle${ESC}[2J\nfake line` }] });
  const bad = await tool('sync.js', 'push', failed, file);
  assert.equal(bad.code, 1);
  assert.doesNotMatch(bad.out, RAW);
  assert.match(bad.out, /^Bad bundle\\u001b\[2J\\u000afake line\n$/);
});

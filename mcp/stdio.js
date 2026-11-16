#!/usr/bin/env node
// MCP over stdio: run the guide as a local tool server for an AI assistant, fully offline.
//
//   node mcp/stdio.js                       read the data folder next to this file
//   node mcp/stdio.js --hub http://box:8787 also send contributions to that hub
//   node mcp/stdio.js --data /path/to/data  use another data folder
//
// Without --hub, contributions are saved to state/mcp-outbox.json and can be carried to a hub
// later with `node tools/sync.js push <hub> state/mcp-outbox.json`.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const SDG = require('../core');
const F = require('../lib/fsdata');
const { createMcp } = require('./protocol');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = opt('--data') ? path.resolve(opt('--data')) : F.DATA;
const hubUrl = (opt('--hub') || process.env.SDG_HUB || '').replace(/\/+$/, '');
const stateDir = path.resolve(opt('--state') || path.join(F.ROOT, 'state'));
const log = (...a) => process.stderr.write(a.join(' ') + '\n'); // stdout is the protocol channel

let ctx = null, mtime = 0;
function getCtx() {
  // Reload when the data folder changes, so a running assistant sees fresh syncs.
  let m = 0;
  try { m = fs.statSync(path.join(dataDir, 'meta.json')).mtimeMs; } catch (e) { /* no meta yet */ }
  if (!ctx || m !== mtime) { ctx = SDG.db.open(F.plain(F.load(dataDir))); mtime = m; }
  return ctx;
}

async function identity() {
  const file = path.join(stateDir, 'mcp-identity.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first use */ }
  const id = await SDG.sign.createIdentity('AI assistant (local MCP)');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(id, null, 2), { mode: 0o600 });
  return id;
}

async function submit(kind, item) {
  const signed = await SDG.sign.sign(item, await identity());
  if (hubUrl) {
    try {
      const path_ = { proposal: 'proposals', comment: 'comments', observation: 'observations' }[kind];
      const res = await fetch(`${hubUrl}/api/v1/${path_}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
      const body = await res.json();
      if (res.ok) return body;
      if (res.status < 500 && res.status !== 428) throw new Error(body.error || `HTTP ${res.status}`);
    } catch (e) { if (!/fetch failed|ECONNREFUSED|ENOTFOUND|abort/i.test(e.message)) throw e; }
  }
  const file = path.join(stateDir, 'mcp-outbox.json');
  let b = { format: 'sdg-bundle', v: 1, from: 'local MCP', created: SDG.util.now(), proposals: [], comments: [], observations: [] };
  try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* new outbox */ }
  b[kind + 's'].push(signed);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(b, null, 1));
  return { id: item.id, status: 'saved offline', outbox: path.relative(F.ROOT, file) };
}

const server = createMcp({
  name: 'Scrapper’s Digital Guide', version: require('../package.json').version, getCtx, submit,
  info: () => ({ data: dataDir, hub: hubUrl || 'none (offline outbox)' }),
});

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
  const msgs = Array.isArray(msg) ? msg : [msg];
  const out = (await Promise.all(msgs.map(server.handle))).filter(Boolean);
  if (out.length) process.stdout.write(JSON.stringify(Array.isArray(msg) ? out : out[0]) + '\n');
});
log(`Scrapper’s Guide MCP server ready (data: ${dataDir}${hubUrl ? `, hub: ${hubUrl}` : ''})`);

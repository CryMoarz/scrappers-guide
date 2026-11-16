// The stdio MCP server, as an AI client would use it: offline, with contributions saved to an outbox.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('MCP over stdio: handshake, tools, search, offline proposal', async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-mcp-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'stdio.js'), '--state', state], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => proc.kill());
  const waiting = new Map();
  let buf = '';
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(res => { const n = ++id; waiting.set(n, res); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'scrappers-guide');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await rpc('tools/list')).result.tools.map(x => x.name);
  for (const n of ['scrap_search', 'get_record', 'what_can_i_build', 'safety_brief', 'propose_change']) assert.ok(tools.includes(n), n);

  const s = (await rpc('tools/call', { name: 'scrap_search', arguments: { query: 'keep food cold', months_since_collapse: 6 } })).result;
  assert.ok(!s.isError);
  assert.ok(s.structuredContent.jobs.length > 0);

  const dev = (await rpc('tools/call', { name: 'get_record', arguments: { collection: 'devices', id: 'microwave_tx' } })).result;
  assert.ok(dev.structuredContent.hazardCards.length > 0);

  const safety = (await rpc('tools/call', { name: 'safety_brief', arguments: { devices: ['microwave_tx'] } })).result;
  assert.ok(safety.structuredContent.hazards.some(h => h.id === 'hv_cap'));

  const bad = (await rpc('tools/call', { name: 'propose_change', arguments: { collection: 'models', id: 'x', reason: 'r', record: { device: 'nope' } } })).result;
  assert.ok(bad.isError === undefined || bad.isError === false || /Not submitted|saved/.test(bad.content[0].text));

  const good = (await rpc('tools/call', { name: 'propose_change', arguments: { collection: 'models', id: 'mcp_test_model', reason: 'Opened one', record: { device: 'vape', brand: 'Test', model: 'V1' } } })).result;
  assert.ok(!good.isError, good.content[0].text);
  const outbox = JSON.parse(fs.readFileSync(path.join(state, 'mcp-outbox.json'), 'utf8'));
  assert.equal(outbox.proposals[0].source, 'ai');
  assert.ok(outbox.proposals[0].sig, 'offline proposals are signed so they can be carried to a hub later');

  const res = (await rpc('resources/list')).result.resources;
  assert.ok(res.some(r => r.uri === 'sdg://summary'));
  const prompts = (await rpc('prompts/list')).result.prompts;
  assert.ok(prompts.some(p => p.name === 'plan_scavenging_run'));
  const unknown = await rpc('no/such/method');
  assert.equal(unknown.error.code, -32601);
});

// Hub configuration from defaults, an optional JSON file, environment variables and flags,
// in that order. Every setting has a safe default, so `node server/hub.js` just works.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  name: 'Scrapper’s Guide hub',
  // hub: moderates contributions and publishes releases (the master, or a regional hub).
  // node: mirrors an upstream hub and forwards contributions to it when it can reach it
  //       (a NOMAD box, a cyberdeck, a camp server).
  mode: 'hub',
  host: '127.0.0.1',
  port: 8787,
  dataDir: path.join(ROOT, 'data'),
  seedDir: '', // a container's bundled data, copied into dataDir on first start and on updates
  stateDir: path.join(ROOT, 'state'),
  appFile: path.join(ROOT, 'app', 'scrappers-guide.html'),
  store: 'auto', // auto | sqlite | files
  upstream: '',
  syncMinutes: 15,
  allowRollback: false, // node: accept an upstream release or reset older than this node's data
  admins: [],
  moderators: [],
  trustProxy: false, // behind a reverse proxy: true (one) or the number of proxies in front
  // Let pages from other origins send signed contributions (the app opened from a file, or from
  // another hub, syncs this way). Reads are always open; /mcp and local controls never are.
  corsWrites: true,
  // MCP write tools over HTTP (/mcp): the hub signs and stamps them for whoever calls. 'auto' turns
  // them on only for a hub listening on this machine alone; true or false to choose.
  mcpWrite: 'auto',
  git: { commit: false, push: false },
  // Project NOMAD next door (see docs/NOMAD.md): its Command Center URL, or "auto" to find it (the
  // container does), or "off"; Kiwix (by default, wherever NOMAD says its library is); and whether
  // to put shared field notes on its map and the guide in its AI's knowledge base.
  nomad: { url: '', kiwix: '', markers: false, kb: false },
  // Offline maps (PMTiles files or URLs). NOMAD's own maps are used too unless nomad is false.
  map: { pmtiles: [], nomad: true },
  // LoRa mesh bridge (see docs/LORA.md). link: meshtastic-tcp | meshtastic-serial | uart | udp
  lora: { enabled: false, link: 'meshtastic-tcp', host: '127.0.0.1', port: 4403, device: '/dev/ttyUSB0', baud: 115200, channel: 0, bot: true, announceMinutes: 60, shareObservations: true, maxPerMinute: 6 },
  policy: {
    requireSignature: true,
    powBits: 12,          // work stamp for newcomers; about a second on a phone
    powBitsKnown: 0,      // for contributors with accepted changes
    knownAfter: 3,        // accepted changes before someone counts as known
    approvals: 1,         // moderator approvals needed to accept
    autoAccept: ['admin', 'moderator'], // roles whose own proposals are accepted at once
    trustedAutoAccept: true, // "trusted" contributors' edits (not deletes) are accepted at once
    comments: 'on',       // on | readonly | off
    maxCommentsPerTarget: 300,
    observations: true,
    votes: true,          // found it / not in mine on parts, helpful comments, still-true field notes
    maxBodyKB: 512,
    maxBundleKB: 8192,
    writesPerTenMinutes: 120,
  },
};

function merge(a, b) {
  const out = Object.assign({}, a);
  Object.keys(b || {}).forEach(k => {
    out[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k];
  });
  return out;
}

function fromEnv(env) {
  const c = {};
  const list = v => String(v).split(',').map(s => s.trim()).filter(Boolean);
  if (env.SDG_NAME) c.name = env.SDG_NAME;
  if (env.SDG_ANNOUNCEMENT) c.announcement = env.SDG_ANNOUNCEMENT;
  if (env.SDG_MAP_PMTILES) c.map = { pmtiles: env.SDG_MAP_PMTILES.split(',').map(s => s.trim()).filter(Boolean) };
  if (env.SDG_MODE) c.mode = env.SDG_MODE;
  if (env.SDG_HOST) c.host = env.SDG_HOST;
  if (env.SDG_PORT) c.port = +env.SDG_PORT;
  if (env.SDG_DATA) c.dataDir = env.SDG_DATA;
  if (env.SDG_SEED) c.seedDir = env.SDG_SEED;
  if (env.SDG_STATE) c.stateDir = env.SDG_STATE;
  if (env.SDG_APP) c.appFile = env.SDG_APP;
  if (env.SDG_STORE) c.store = env.SDG_STORE;
  if (env.SDG_UPSTREAM) c.upstream = env.SDG_UPSTREAM;
  if (env.SDG_ALLOW_ROLLBACK) c.allowRollback = env.SDG_ALLOW_ROLLBACK === '1';
  if (env.SDG_ADMINS) c.admins = list(env.SDG_ADMINS);
  if (env.SDG_MODERATORS) c.moderators = list(env.SDG_MODERATORS);
  if (env.SDG_TRUST_PROXY) c.trustProxy = +env.SDG_TRUST_PROXY > 0 ? +env.SDG_TRUST_PROXY : false;
  if (env.SDG_CORS_WRITES) c.corsWrites = env.SDG_CORS_WRITES === '1';
  if (env.SDG_MCP_WRITE) c.mcpWrite = env.SDG_MCP_WRITE === '1';
  if (env.SDG_GIT_COMMIT) c.git = { commit: env.SDG_GIT_COMMIT === '1', push: env.SDG_GIT_PUSH === '1' };
  if (env.SDG_COMMENTS) c.policy = { comments: env.SDG_COMMENTS };
  if (env.SDG_NOMAD || env.SDG_KIWIX) c.nomad = { url: env.SDG_NOMAD || '', kiwix: env.SDG_KIWIX || '', markers: env.SDG_NOMAD_MARKERS === '1', kb: env.SDG_NOMAD_KB === '1' };
  if (env.SDG_LORA) {
    c.lora = { enabled: true, link: env.SDG_LORA };
    if (env.SDG_LORA_HOST) c.lora.host = env.SDG_LORA_HOST;
    if (env.SDG_LORA_PORT) c.lora.port = +env.SDG_LORA_PORT;
    if (env.SDG_LORA_DEVICE) c.lora.device = env.SDG_LORA_DEVICE;
    if (env.SDG_LORA_BAUD) c.lora.baud = +env.SDG_LORA_BAUD;
  }
  return c;
}

function fromArgs(argv) {
  const c = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--config') { c.__file = v; i++; }
    else if (a === '--port') { c.port = +v; i++; }
    else if (a === '--host') { c.host = v; i++; }
    else if (a === '--mode') { c.mode = v; i++; }
    else if (a === '--upstream') { c.upstream = v; i++; }
    else if (a === '--allow-rollback') c.allowRollback = true;
    else if (a === '--data') { c.dataDir = path.resolve(v); i++; }
    else if (a === '--state') { c.stateDir = path.resolve(v); i++; }
    else if (a === '--store') { c.store = v; i++; }
    else if (a === '--admin') { (c.admins = c.admins || []).push(v); i++; }
    else if (a === '--no-comments') c.policy = Object.assign(c.policy || {}, { comments: 'off' });
    else if (a === '--nomad') { c.nomad = Object.assign(c.nomad || {}, { url: v }); i++; }
    else if (a === '--kiwix') { c.nomad = Object.assign(c.nomad || {}, { kiwix: v }); i++; }
    else if (a === '--nomad-markers') c.nomad = Object.assign(c.nomad || {}, { markers: true });
    else if (a === '--nomad-kb') c.nomad = Object.assign(c.nomad || {}, { kb: true });
    else if (a === '--map') { c.map = c.map || { pmtiles: [] }; c.map.pmtiles.push(/^https?:/i.test(v) ? v : path.resolve(v)); i++; }
    else if (a === '--lora') { c.lora = Object.assign(c.lora || {}, { enabled: true, link: v }); i++; }
    else if (a === '--lora-host') { c.lora = Object.assign(c.lora || {}, { host: v }); i++; }
    else if (a === '--lora-device') { c.lora = Object.assign(c.lora || {}, { device: v }); i++; }
    else if (a === '--public') c.host = '0.0.0.0';
    else if (a === '--mcp-write') c.mcpWrite = true;
    else if (a === '--no-mcp-write') c.mcpWrite = false;
  }
  return c;
}

function load(argv, env, overrides) {
  const args = fromArgs(argv || []);
  const fileName = args.__file || (env || {}).SDG_CONFIG;
  delete args.__file;
  const file = fileName ? JSON.parse(fs.readFileSync(fileName, 'utf8')) : {};
  const cfg = [file, fromEnv(env || {}), args, overrides || {}].reduce(merge, DEFAULTS);
  if (!['hub', 'node'].includes(cfg.mode)) throw new Error('mode must be hub or node');
  if (cfg.mode === 'node' && !cfg.upstream) console.warn('Node mode with no upstream: contributions will queue until one is set.');
  return cfg;
}

module.exports = { DEFAULTS, load, ROOT };

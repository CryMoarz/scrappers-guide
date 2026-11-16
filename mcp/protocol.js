// Model Context Protocol server: lets AI assistants (NOMAD's local model, Claude, anything that
// speaks MCP) search the guide, read records, plan builds, and propose changes for moderation.
// Transport-agnostic: mcp/stdio.js wraps it for local use, the hub mounts it at /mcp over HTTP.
//
// The AI translates fuzzy requests into these calls; ranking and data stay deterministic, so
// nothing about parts or places is ever invented. Anything an AI submits is labelled as AI and
// waits for a human moderator.
const SDG = require('../core');

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const COLLS = ['parts', 'devices', 'boards', 'buildings', 'jobs', 'hazards', 'guides', 'models'];

const str = (description, extra) => Object.assign({ type: 'string', description }, extra || {});
const TOOLS = [
  {
    name: 'scrap_search',
    title: 'Find what to scrap',
    description: 'The main tool. Given a part, spec, part number or job ("12V motor", "LM2596", "keep food cold", "pump water from the creek"), returns the part types it matched, any matching job with its approach, the best devices to strip ranked by the hidden-fruit score (useful, easy, overlooked), and the building types most likely to still have them. Use part ids from the results with get_record for detail.',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: {
        query: str('What the person needs, in their words or as a part number.'),
        include_substitutes: { type: 'boolean', description: 'Also rank part types that can do the same job.' },
        months_since_collapse: { type: 'number', minimum: 0, description: 'Months since the grid went down. Ages batteries and fuel and raises looting pressure. Leave out if unknown.' },
        tools_available: { type: 'array', items: { type: 'string' }, description: 'Tool ids the person has (see list_vocab). Devices needing other tools rank lower.' },
        max_carry_kg: { type: 'number', minimum: 0, description: 'Heaviest single part they can carry.' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'How many devices and buildings to return (default 8).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_record',
    title: 'Read a record',
    description: 'Full record by collection and id. For devices, returns the resolved template (inherited parts, boards expanded) with confidence for each part. For hazards, the full safety card.',
    inputSchema: { type: 'object', required: ['collection', 'id'], properties: { collection: { enum: COLLS }, id: str('Record id') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_records',
    title: 'List records',
    description: 'Ids and names in a collection, optionally filtered by a word. Use to discover ids before get_record or propose_change.',
    inputSchema: { type: 'object', required: ['collection'], properties: { collection: { enum: COLLS }, filter: str('Optional word to filter by') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'find_guides',
    title: 'Find guides',
    description: 'Search teardowns, build guides and blueprints, repairs, field tests, safety procedures and skills.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: str('What to find'), kind: { enum: ['teardown', 'build', 'repair', 'test', 'safety', 'skill', 'reference'] } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'what_can_i_build',
    title: 'What can I build',
    description: 'Given part type ids the person already has, returns build and repair guides ranked by how much of the materials list they cover, with the best device to scrap for each missing part.',
    inputSchema: { type: 'object', required: ['have'], properties: { have: { type: 'array', items: { type: 'string' }, description: 'Part type ids (use scrap_search or list_records parts to find them)' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'safety_brief',
    title: 'Safety brief',
    description: 'Every hazard for the given devices or hazard ids, with how to spot it, what to do and not do, protection and first aid. Call this before telling anyone to open a device.',
    inputSchema: { type: 'object', properties: { devices: { type: 'array', items: { type: 'string' } }, hazards: { type: 'array', items: { type: 'string' } } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_vocab',
    title: 'Vocabulary',
    description: 'Tool ids, part groups and device groups, plus collection sizes.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_schema',
    title: 'Record schema',
    description: 'JSON Schema for one record type, so a proposed record can be built correctly. Read the resource sdg://docs/data-guide for the rules on honesty, scales and style.',
    inputSchema: { type: 'object', required: ['collection'], properties: { collection: { enum: COLLS } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'propose_change',
    title: 'Propose a change',
    description: 'Submit a new or corrected record for human moderation. It is labelled as AI-written and never applied without review. Give the complete record (not a patch), and a reason a moderator can check. Only propose what the person told you or what you can justify; never invent model numbers or measurements.',
    inputSchema: {
      type: 'object', required: ['collection', 'id', 'reason'],
      properties: {
        collection: { enum: COLLS }, id: str('Record id (lowercase, digits, underscores)'),
        record: { type: 'object', description: 'The complete record. Omit when delete is true.' },
        delete: { type: 'boolean', description: 'Propose removing the record instead.' },
        reason: str('Why: what was seen, by whom, and any source.'),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'add_comment',
    title: 'Comment on a record',
    description: 'Attach a short note to a record (a tip, a correction to check, a question). Labelled as AI-written.',
    inputSchema: { type: 'object', required: ['collection', 'id', 'body'], properties: { collection: { enum: COLLS }, id: str('Record id'), body: str('The comment') } },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'log_observation',
    title: 'Log a site observation',
    description: 'Record what someone found at a place: untouched, partly looted, cleared, dangerous or occupied. Coordinates are rounded to about 10 m. Only share publicly when the person asked to.',
    inputSchema: {
      type: 'object', required: ['lat', 'lon', 'status'],
      properties: {
        lat: { type: 'number' }, lon: { type: 'number' }, status: { enum: ['untouched', 'partial', 'cleared', 'dangerous', 'occupied'] },
        building: str('Building type id'), label: str('Name or description'), notes: str('What was there'),
        share: { enum: ['peers', 'public'], description: 'peers: only people this node syncs with directly. public: the hub.' },
      },
    },
    annotations: { readOnlyHint: false },
  },
];

const WRITES = TOOLS.filter(t => !t.annotations.readOnlyHint).map(t => t.name);
// Search-like arguments are short; free text that is stored (bodies, reasons, notes) is checked
// against the schema instead.
const LONG = ['body', 'reason', 'notes', 'label', 'record'];
const tooBig = v => (typeof v === 'string' ? v.length > 200 : Array.isArray(v) ? v.length > 100 || v.some(tooBig) : false);

const PROMPTS = [
  { name: 'plan_scavenging_run', title: 'Plan a scavenging run', description: 'Work out what to look for, where, and how to get it out safely.', arguments: [{ name: 'need', description: 'What you need', required: true }, { name: 'tools', description: 'Tools you have' }, { name: 'months', description: 'Months since the collapse' }] },
  { name: 'teardown_assistant', title: 'Teardown assistant', description: 'Step-by-step help taking a specific device apart for its useful parts.', arguments: [{ name: 'device', description: 'The device in front of you', required: true }] },
  { name: 'log_what_i_found', title: 'Log a device I opened', description: 'Turn what you found inside a real unit into a logged model for moderation.', arguments: [{ name: 'description', description: 'Brand, model and what you found inside', required: true }] },
];

function text(obj) { return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1); }
function ok(result, summary) { return { content: [{ type: 'text', text: summary ? summary + '\n\n' + text(result) : text(result) }], structuredContent: Array.isArray(result) ? { items: result } : result }; }
function fail(message) { return { content: [{ type: 'text', text: message }], isError: true }; }

function createMcp(opts) {
  const getCtx = opts.getCtx;
  const name = (r) => r.name || r.title || r.label || r.id;

  async function callTool(tool, a, headers) {
    const ctx = getCtx();
    a = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
    if (Object.keys(a).some(k => !LONG.includes(k) && tooBig(a[k]))) return fail('Arguments are limited to 200 characters, and lists to 100 items.');
    switch (tool) {
      case 'scrap_search': {
        if (!a.query || !String(a.query).trim()) return fail('Give a query.');
        const out = SDG.search.search(ctx, a.query, { subs: !!a.include_substitutes, months: a.months_since_collapse, tools: a.tools_available, maxKg: a.max_carry_kg });
        const s = SDG.search.summarize(ctx, out, Math.min(30, a.limit || 8));
        const on = s.partTypes.filter(p => p.on).map(p => p.name);
        const head = s.bestDevices.length
          ? `Matched ${on.join(', ')}${s.jobs[0] ? ` (job: ${s.jobs[0].name})` : ''}. Best source: ${s.bestDevices[0].name} (score ${s.bestDevices[0].score}). Best place: ${s.whereToLook[0] ? s.whereToLook[0].name : 'unknown'}. Devices are generic templates: their parts are guesses unless marked documented or verified.`
          : on.length ? `Matched ${on.join(', ')}, but no device in the data contains it yet.`
            : s.models.length || s.brands.length || s.devicesNamed.length ? `Matched ${[...s.devicesNamed.map(d => d.name), ...s.brands.map(b => `brand ${b.name}`), ...s.models.map(m => m.name)].slice(0, 6).join(', ')}. Use get_record for what is inside.`
            : `Nothing matched “${a.query}”. Try a plainer word or list_records parts.`;
        return ok(s, head);
      }
      case 'get_record': {
        if (!COLLS.includes(a.collection)) return fail('Unknown collection.');
        const found = a.collection === 'devices' ? ctx.resolve(a.id) : ctx.get(a.collection, a.id);
        if (!found) return fail(`No ${a.collection} record “${a.id}”. Use list_records to find ids.`);
        // Where to read more in the offline libraries next to this server (Kiwix, NOMAD).
        const env = opts.libraries ? opts.libraries(headers) : null;
        const seeAlso = SDG.text.lookups(ctx, a.collection, found).map(l => ({ library: l.label, search: l.q, url: (env && SDG.text.libraryUrl(env, l, ctx.ds.vocab.libraries)) || undefined, note: l.note }));
        const rec = Object.assign({}, found, { seeAlso });
        if (a.collection === 'devices') {
          const comps = rec.comps.map(c => Object.assign({}, c, { confidence: SDG.db.CONF[ctx.confInfo(rec.id, c.key).conf].label }));
          return ok(Object.assign({}, rec, { comps, hazardCards: rec.hazards.map(h => ctx.hazard(h)), guides: (ctx.ds.guides || []).filter(g => (g.devices || []).includes(rec.id)).map(g => ({ id: g.id, kind: g.kind, title: g.title })) }));
        }
        return ok(rec);
      }
      case 'list_records': {
        if (!COLLS.includes(a.collection)) return fail('Unknown collection.');
        const f = String(a.filter || '').toLowerCase();
        return ok(ctx.ds[a.collection].filter(r => !r.deprecated && (!f || JSON.stringify([r.id, name(r), r.keywords, r.aliases]).toLowerCase().includes(f))).map(r => ({ id: r.id, name: name(r), group: r.group || r.kind })));
      }
      case 'find_guides': {
        const g = SDG.search.findGuides(ctx, a.query || '', a.kind).slice(0, 12).map(h => ({ id: h.g.id, kind: h.g.kind, title: h.g.title, summary: h.g.summary, difficulty: h.g.difficulty }));
        return ok(g, g.length ? '' : 'No guides matched. Try other words, or list_records guides.');
      }
      case 'what_can_i_build': {
        const list = SDG.search.buildable(ctx, a.have || []).slice(0, 10).map(x => ({ id: x.guide.id, title: x.guide.title, coverage: Math.round(x.coverage * 100) + '%', difficulty: x.guide.difficulty, have: x.have, missing: x.missing }));
        return ok(list, list.length ? '' : 'None of the build guides use those part types yet.');
      }
      case 'safety_brief': {
        const ids = new Set(a.hazards || []);
        (a.devices || []).forEach(d => { const r = ctx.resolve(d); if (r) r.hazards.forEach(h => ids.add(h)); });
        const cards = [...ids].map(h => ctx.hazard(h)).sort((x, y) => (y.severity || 0) - (x.severity || 0));
        const guides = (ctx.ds.guides || []).filter(g => g.kind === 'safety' && (g.hazards || []).some(h => ids.has(h))).map(g => ({ id: g.id, title: g.title }));
        return ok({ hazards: cards, safetyGuides: guides }, cards.length ? `${cards.length} hazard${cards.length > 1 ? 's' : ''}. Most severe: ${cards[0].label}.` : 'No hazards are recorded for those. That is not the same as safe.');
      }
      case 'list_vocab': return ok({ tools: ctx.ds.vocab.tools, partGroups: ctx.ds.vocab.partGroups, deviceGroups: ctx.ds.vocab.deviceGroups, counts: ctx.stats() });
      case 'get_schema': {
        if (!COLLS.includes(a.collection)) return fail('Unknown collection.');
        return ok({ schema: SDG.schema.schemaFor(a.collection), definitions: SDG.schema.root().$defs });
      }
      case 'propose_change': {
        if (!opts.submit) return fail('This server is read-only.');
        const op = a.delete ? 'delete' : 'put';
        const cur = ctx.get(a.collection, a.id);
        try {
          const p = await SDG.changes.makeProposal({ coll: a.collection, rid: a.id, op, data: a.record, baseRev: cur ? (cur.rev || 0) : null, reason: a.reason, source: 'ai' });
          const r = await opts.submit('proposal', p);
          return ok(r, `Proposal ${r.id} is ${r.status}. A human moderator will review it before it changes anything.`);
        } catch (e) { return fail('Not submitted: ' + e.message + (e.extra && e.extra.errors ? '\n' + text(e.extra.errors) : '')); }
      }
      case 'add_comment': {
        if (!opts.submit) return fail('This server is read-only.');
        try {
          const c = await SDG.changes.makeComment(`${a.collection}/${a.id}`, `[AI] ${a.body}`);
          return ok(await opts.submit('comment', c));
        } catch (e) { return fail('Not submitted: ' + e.message); }
      }
      case 'log_observation': {
        if (!opts.submit) return fail('This server is read-only.');
        try {
          const o = await SDG.changes.makeObservation(Object.assign({}, a, { share: a.share || 'peers' }));
          return ok(await opts.submit('observation', o));
        } catch (e) { return fail('Not stored: ' + e.message); }
      }
      default: return fail('Unknown tool: ' + tool);
    }
  }

  function getPrompt(nm, args) {
    args = args || {};
    const msg = t => ({ messages: [{ role: 'user', content: { type: 'text', text: t } }] });
    if (nm === 'plan_scavenging_run') return msg(`I need: ${args.need}.${args.tools ? ` Tools I have: ${args.tools}.` : ''}${args.months ? ` It has been ${args.months} months since the grid went down.` : ''}
Use scrap_search (with my tools and months if given) to find the best devices and places. Call safety_brief for the top devices before suggesting I open anything. Suggest a short route of building types to check in order, what to take, and what to leave. Say clearly which results are template guesses.`);
    if (nm === 'teardown_assistant') return msg(`I have a ${args.device} in front of me. Find it with list_records devices, read it with get_record, check find_guides for a teardown, and call safety_brief first. Then walk me through it one step at a time, telling me what is worth keeping.`);
    if (nm === 'log_what_i_found') return msg(`I opened this and want to log it: ${args.description}
Find the device template with list_records devices and get_record. Build a models record (get_schema models) that marks what I saw as verified, what was missing as absent, and adds anything extra. Show it to me before calling propose_change.`);
    throw Object.assign(new Error('Unknown prompt'), { code: -32602 });
  }

  const RESOURCES = () => [
    { uri: 'sdg://summary', name: 'summary', title: 'Dataset summary', mimeType: 'application/json', description: 'What the guide holds and how fresh it is.' },
    { uri: 'sdg://docs/data-guide', name: 'data-guide', title: 'Data guide', mimeType: 'text/markdown', description: 'Rules for writing records: honesty, scales, style.' },
    ...((getCtx().ds.guides || []).map(g => ({ uri: `sdg://guides/${g.id}`, name: g.id, title: g.title, mimeType: 'text/markdown', description: g.summary }))),
  ];
  const guideMarkdown = (g, ctx) => SDG.text.guideMarkdown(ctx, g);
  function readResource(uri) {
    const ctx = getCtx();
    if (uri === 'sdg://summary') return { uri, mimeType: 'application/json', text: text(Object.assign({ stats: ctx.stats() }, opts.info ? opts.info() : {})) };
    if (uri === 'sdg://docs/data-guide') {
      let t = 'See docs/DATA-GUIDE.md in the project.';
      try { t = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'DATA-GUIDE.md'), 'utf8'); } catch (e) { /* bundled without docs */ }
      return { uri, mimeType: 'text/markdown', text: t };
    }
    const m = /^sdg:\/\/guides\/([a-z0-9_]+)$/.exec(uri);
    if (m && ctx.get('guides', m[1])) return { uri, mimeType: 'text/markdown', text: guideMarkdown(ctx.get('guides', m[1]), ctx) };
    throw Object.assign(new Error('Unknown resource ' + uri), { code: -32002 });
  }

  // One JSON-RPC message in, one response (or null for notifications) out.
  async function handle(msg, headers) {
    const isReq = msg && msg.id !== undefined && msg.id !== null;
    const reply = result => (isReq ? { jsonrpc: '2.0', id: msg.id, result } : null);
    const error = (code, message) => (isReq ? { jsonrpc: '2.0', id: msg.id, error: { code, message } } : null);
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isReq ? error(-32600, 'Invalid request') : null;
    const p = msg.params || {};
    try {
      switch (msg.method) {
        case 'initialize': {
          const v = PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0];
          return reply({
            protocolVersion: v,
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: 'scrappers-guide', title: opts.name || 'Scrapper’s Digital Guide', version: opts.version || '0' },
            instructions: 'Offline field guide for salvage after a collapse. Use scrap_search for any need (part, spec, part number or job). Results are deterministic and come from the database: never add devices, parts or places that the tools did not return, and say when data is a template guess. Always call safety_brief before telling someone to open a device. Contributions go to human moderators.',
          });
        }
        case 'notifications/initialized': case 'notifications/cancelled': return null;
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: opts.submit ? TOOLS : TOOLS.filter(t => t.annotations.readOnlyHint) });
        case 'tools/call': return reply(await callTool(p.name, p.arguments, headers));
        case 'prompts/list': return reply({ prompts: PROMPTS });
        case 'prompts/get': return reply(getPrompt(p.name, p.arguments));
        case 'resources/list': return reply({ resources: RESOURCES() });
        case 'resources/read': return reply({ contents: [readResource(p.uri)] });
        case 'resources/templates/list': return reply({ resourceTemplates: [{ uriTemplate: 'sdg://guides/{id}', name: 'guide', title: 'Guide as Markdown', mimeType: 'text/markdown' }] });
        default: return error(-32601, 'Method not found: ' + msg.method);
      }
    } catch (e) {
      return error(e.code || -32603, e.message);
    }
  }

  // Streamable HTTP transport, JSON responses only (no event stream needed for these tools).
  async function handleHttp(body, headers) {
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    const out = (await Promise.all(msgs.map(m => handle(m, headers)))).filter(Boolean);
    if (!out.length) return null;
    const h = { 'Content-Type': 'application/json' };
    if (msgs.some(m => m && m.method === 'initialize')) h['Mcp-Session-Id'] = SDG.util.newId();
    return { headers: h, body: batch ? out : out[0] };
  }

  return { handle, handleHttp, TOOLS, PROMPTS, callTool, WRITES };
}

module.exports = { createMcp, TOOLS, WRITES, PROTOCOL_VERSIONS };

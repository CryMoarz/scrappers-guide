// OpenAPI 3.1 description of the hub API, generated from the record schema. Tool runners that
// read OpenAPI (Open WebUI tool servers and others) can call the hub directly from this.
const SDG = require('../core');

function buildOpenApi({ name, version, url }) {
  const root = SDG.schema.root();
  const schemas = {};
  Object.entries(root.$defs).forEach(([k, v]) => (schemas[k] = JSON.parse(JSON.stringify(v).replace(/"#\/\$defs\//g, '"#/components/schemas/'))));
  const ref = n => ({ $ref: '#/components/schemas/' + n });
  const qp = (n, description, schema, required) => ({ name: n, in: 'query', required: !!required, description, schema: schema || { type: 'string' } });
  const pp = (n, description, schema) => ({ name: n, in: 'path', required: true, description, schema: schema || { type: 'string' } });
  const json = (schema, description) => ({ description: description || 'OK', content: { 'application/json': { schema: schema || { type: 'object' } } } });
  const errors = { 400: json({ type: 'object' }, 'Bad request'), 401: json({ type: 'object' }, 'Missing or bad signature'), 403: json({ type: 'object' }, 'Not allowed'), 404: json({ type: 'object' }, 'Not found'), 422: json({ type: 'object' }, 'Invalid data, with errors'), 428: json({ type: 'object' }, 'Work stamp needed (powBits)'), 429: json({ type: 'object' }, 'Too many requests') };
  const coll = { type: 'string', enum: SDG.db.COLLS };
  const body = (schema, description) => ({ required: true, description, content: { 'application/json': { schema } } });

  return {
    openapi: '3.1.0',
    info: {
      title: name || 'Scrapper’s Digital Guide hub',
      version: version || '0',
      description: 'Offline-first salvage database: which devices hide the part you need, how to get it out safely, and where to look. Reads are open. Writes are signed (Ed25519) contributions that go through human moderation.',
      license: { name: 'Code MIT, data CC BY-SA 4.0' },
    },
    servers: url ? [{ url }] : undefined,
    paths: {
      '/api/v1/search': { get: { operationId: 'scrapSearch', summary: 'Find the best devices to strip and places to look for a part, spec, part number or job', parameters: [qp('q', 'What you need: "12V motor", "LM2596", "keep food cold"', null, true), qp('subs', 'Include substitutes (1 or 0)'), qp('months', 'Months since the grid went down', { type: 'number' }), qp('tools', 'Comma-separated tool ids you have'), qp('kg', 'Heaviest part you can carry, kg', { type: 'number' }), qp('limit', 'Results to return (max 50)', { type: 'integer' })], responses: { 200: json(), ...errors } } },
      '/api/v1/offline': { get: { operationId: 'offlineCopy', summary: 'Open a cited web page in the NOMAD library that keeps a copy of its site, or search that library when the copy lacks the page', parameters: [qp('u', 'The page address, as cited', null, true), qp('t', 'The source title, searched for when the page is missing')], responses: { 302: { description: 'To the offline page or a search of its library' }, 404: { description: 'No installed library keeps this site' } } } },
      '/api/v1/build': { get: { operationId: 'whatCanIBuild', summary: 'Build and repair guides ranked by how many of their materials you already have', parameters: [qp('have', 'Comma-separated part type ids you have', null, true)], responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
      '/api/v1/records/{collection}': { get: { operationId: 'listRecords', summary: 'List ids and names in a collection', parameters: [pp('collection', 'Collection', coll), qp('q', 'Filter word')], responses: { 200: json({ type: 'array', items: { type: 'object' } }), ...errors } } },
      '/api/v1/records/{collection}/{id}': { get: { operationId: 'getRecord', summary: 'One record. For devices, add resolved=1 for the full inherited part list', parameters: [pp('collection', 'Collection', coll), pp('id', 'Record id'), qp('resolved', '1 to resolve a device template')], responses: { 200: json(), ...errors } } },
      '/api/v1/records/{collection}/{id}/history': { get: { operationId: 'recordHistory', summary: 'Accepted changes to one record', parameters: [pp('collection', 'Collection', coll), pp('id', 'Record id')], responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
      '/api/v1/info': { get: { operationId: 'hubInfo', summary: 'Hub name, mode, version, sequence number, policy and counts', responses: { 200: json() } } },
      '/api/v1/schema': { get: { operationId: 'getSchema', summary: 'The JSON Schema for every record type', responses: { 200: json() } } },
      '/api/v1/release': { get: { operationId: 'getRelease', summary: 'Full signed snapshot of the moderated data (supports ETag)', responses: { 200: json(), 304: { description: 'Not modified' } } } },
      '/api/v1/sync': { get: { operationId: 'syncFeed', summary: 'Accepted changes after a sequence number, with a signed checkpoint', parameters: [qp('since', 'Last sequence number you have', { type: 'integer' }), qp('limit', 'Max entries', { type: 'integer' })], responses: { 200: json() } } },
      '/api/v1/proposals': {
        get: { operationId: 'listProposals', summary: 'Proposed changes', parameters: [qp('status', 'pending, accepted, rejected, conflict, queued'), qp('coll', 'Collection'), qp('rid', 'Record id'), qp('author', 'Author public key'), qp('order', 'newest for newest first')], responses: { 200: json({ type: 'array', items: ref('proposal') }) } },
        post: { operationId: 'submitProposal', summary: 'Submit a signed proposal (or an array of them)', requestBody: body({ oneOf: [ref('proposal'), { type: 'array', items: ref('proposal') }] }), responses: { 200: json(), ...errors } },
      },
      '/api/v1/proposals/{id}': { get: { operationId: 'getProposal', summary: 'A proposal with the current record, a field diff, reviews and any problems', parameters: [pp('id', 'Proposal id')], responses: { 200: json(), ...errors } } },
      '/api/v1/proposals/{id}/review': { post: { operationId: 'reviewProposal', summary: 'Moderator decision, signed: {proposal, decision: accept|reject, note, force, created, author, sig}', parameters: [pp('id', 'Proposal id')], requestBody: body({ type: 'object' }), responses: { 200: json(), 409: json({ type: 'object' }, 'Conflict or stale'), ...errors } } },
      '/api/v1/comments': {
        get: { operationId: 'listComments', summary: 'Comments, optionally for one record', parameters: [qp('target', 'collection/id'), qp('since', 'received time of the last comment you got'), qp('order', 'newest for newest first')], responses: { 200: json({ type: 'array', items: ref('comment') }) } },
        post: { operationId: 'addComment', summary: 'Add a signed comment', requestBody: body(ref('comment')), responses: { 200: json(), ...errors } },
      },
      '/api/v1/comments/{id}/hide': { post: { operationId: 'hideComment', summary: 'Moderator: hide or show a comment (signed)', parameters: [pp('id', 'Comment id')], requestBody: body({ type: 'object' }), responses: { 200: json(), ...errors } } },
      '/api/v1/observations': {
        get: { operationId: 'listObservations', summary: 'Shared field observations', parameters: [qp('bbox', 'minLon,minLat,maxLon,maxLat'), qp('since', 'received time of the last note you got')], responses: { 200: json({ type: 'array', items: ref('observation') }) } },
        post: { operationId: 'addObservation', summary: 'Share a signed field observation', requestBody: body(ref('observation')), responses: { 200: json(), ...errors } },
      },
      '/api/v1/votes': {
        get: { operationId: 'listVotes', summary: 'Votes: found it / not in mine on parts (devices/<id>#<part key>), helpful on comments, still true / not anymore on field notes', parameters: [qp('target', 'One target'), qp('prefix', 'Targets starting with this'), qp('since', 'received time of the last vote you got')], responses: { 200: json({ type: 'array', items: ref('vote') }) } },
        post: { operationId: 'addVote', summary: 'Cast a signed vote: 1, -1, or 0 to take it back. The newest from each person counts.', requestBody: body(ref('vote')), responses: { 200: json(), ...errors } },
      },
      '/api/v1/votes/tally': { get: { operationId: 'tallyVotes', summary: 'Vote counts per target: {up, down, last}', parameters: [qp('prefix', 'devices/<id>, comments/ or observations/')], responses: { 200: json() } } },
      '/api/v1/bundle': {
        get: { operationId: 'exportBundle', summary: 'Everything a peer needs to catch up: changes, pending proposals, comments, observations, votes', parameters: [qp('since', 'Sequence number', { type: 'integer' }), qp('commentsSince', 'ISO time'), qp('observationsSince', 'ISO time'), qp('votesSince', 'ISO time')], responses: { 200: json() } },
        post: { operationId: 'importBundle', summary: 'Hand over a bundle of signed proposals, comments, observations and votes', requestBody: body({ type: 'object' }), responses: { 200: json() } },
      },
      '/api/v1/users/{key}': { get: { operationId: 'getUser', summary: 'A contributor’s role and counts', parameters: [pp('key', 'Public key')], responses: { 200: json() } } },
      '/api/v1/roles': { post: { operationId: 'setRole', summary: 'Admin: set a contributor’s role (signed)', requestBody: body({ type: 'object' }), responses: { 200: json(), ...errors } } },
      '/mcp': { post: { operationId: 'mcp', summary: 'Model Context Protocol endpoint (JSON-RPC over HTTP)', requestBody: body({ type: 'object' }), responses: { 200: json(), 202: { description: 'Notification accepted' } } } },
    },
    components: { schemas },
  };
}

module.exports = { buildOpenApi };

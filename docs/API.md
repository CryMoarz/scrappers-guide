# Hub API

Every hub and node serves the same API at `/api/v1`. Reads are open. Writes are signed contributions (see [ARCHITECTURE.md](../ARCHITECTURE.md#identity-and-signatures)) sent as JSON with `Content-Type: application/json`; anything else is a 415. The full machine-readable description is at `/api/v1/openapi.json`.

Browsers on other origins may read (CORS `*`) and, unless the hub sets `corsWrites` off, send signed contributions. `/mcp` and `/api/v1/sync/now` are never available cross-origin, and a node's peers-only field notes are left out of answers to pages from another origin.

## Reading

| Request | Returns |
|---|---|
| `GET /api/v1/info` | Name, mode, version, data sequence number and hash, hub key, policy, counts |
| `GET /api/v1/search?q=12v motor` | Ranked devices and buildings for a need. Options: `subs=1`, `months=6`, `tools=screwdriver,pliers`, `kg=10`, `limit=20` |
| `GET /api/v1/build?have=motor_dc_large,battery_pb` | Build guides ranked by how many materials you have |
| `GET /api/v1/records/devices` | Ids and names in a collection (`?q=` filters) |
| `GET /api/v1/records/devices/treadmill?resolved=1` | One record; `resolved=1` expands a device template |
| `GET /api/v1/records/parts/battery_li/history` | Accepted changes to a record |
| `GET /api/v1/schema` | The record schema |
| `GET /api/v1/release` | The whole signed dataset (supports `If-None-Match`) |
| `GET /api/v1/sync?since=42` | Accepted changes after 42, with a signed checkpoint |
| `GET /api/v1/proposals?status=pending` | Proposals (`coll`, `rid`, `author`, `order=newest`) |
| `GET /api/v1/proposals/<id>` | A proposal with the current record, a diff and any problems |
| `GET /api/v1/comments?target=devices/treadmill` | Comments, oldest first by `received`; `since=<received>` pages on from the last one you got |
| `GET /api/v1/places?lat=45.42&lon=-75.70&km=2&q=car%20battery` | Places near a point on the offline map, ranked for a search (see [MAP.md](MAP.md)); `GET /api/v1/map` lists the maps and `GET /api/v1/map/tiles/z/x/y` gives light tiles to draw |
| `GET /api/v1/votes?prefix=devices/treadmill` | Votes, oldest first by `received`, the newest per person per target; `target`, `prefix` and `since` narrow it |
| `GET /api/v1/votes/tally?prefix=comments/` | Counts per target, `{up, down, last}`; the prefix is `devices/<id>`, `comments/` or `observations/` |
| `GET /api/v1/observations?bbox=-76,45,-75,46` | Shared field notes, paged the same way |
| `GET /api/v1/bundle?since=42` | Everything a peer needs to catch up |
| `GET /api/v1/users/<key>` | A contributor’s role and counts |

```bash
curl 'http://localhost:8787/api/v1/search?q=keep%20food%20cold&months=6'
```

## Writing

All writes are JSON bodies signed with `core/sign.js` (`author: {key, name}` plus `sig`), and from newcomers a work stamp (`pow`). The easiest way to make them is with the core library:

```js
const SDG = require('./core');
const me = await SDG.sign.createIdentity('My name');            // keep me.jwk secret
const p = await SDG.changes.makeProposal({ coll: 'models', rid: 'treadmill_acme_t100', op: 'put',
  data: { device: 'treadmill', brand: 'Acme', model: 'T100', comps: [{ key: 'motor_dc_large', conf: 'verified', spec: '130V DC, 2.5 hp' }] },
  reason: 'Opened one in my garage' }, me, 12);
await fetch('http://localhost:8787/api/v1/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
```

| Request | Body |
|---|---|
| `POST /api/v1/proposals` | A signed proposal, or an array of up to 20 |
| `POST /api/v1/proposals/<id>/review` | Moderator: signed `{action: "review", proposal, decision: "accept" or "reject", note, force, created}` |
| `POST /api/v1/comments` | A signed comment `{id, target, body, parent, created}` |
| `POST /api/v1/votes` | A signed vote `{id, target, value, created}`: `target` is `devices/<id>#<part key>`, `comments/<id>` or `observations/<id>`; `value` is 1, -1 or 0 to take it back. Unsigned votes, votes on your own comment or note, and older votes than the one held are refused |
| `POST /api/v1/comments/<id>/hide` | Moderator: signed `{action: "hide-comment", comment, hidden, created}` |
| `POST /api/v1/observations` | A signed field note |
| `POST /api/v1/bundle` | A bundle of up to 2000 signed proposals, comments, field notes and votes; returns a result per item |
| `POST /api/v1/roles` | Admin: signed `{action: "set-role", key, role, created}` |
| `POST /api/v1/sync/now` | Node only, from the same machine, with `Authorization: Bearer <state/control-token>`: sync with upstream now |

Each item costs one from the sender’s write budget (`writesPerTenMinutes` per address); items past it come back with status 429 and can be sent again later. Text queries (`q`) are limited to 200 characters and `limit` is clamped to each endpoint’s maximum.

Moderation messages (reviews, hiding comments, roles) must name their `action` and the target of the endpoint they are sent to (`proposal`, `comment` or `key`), be dated (`created`, ISO 8601) within the last 10 minutes and no more than 5 minutes ahead, and are taken once: sending the same signed message again is a 409. `tools/mod.js` and the app's Review tab make them this way.

## Errors

JSON `{error, ...}` with these statuses: 400 bad request, 401 missing or bad signature, 403 not allowed, 404 not found, 409 conflict or stale (`idConflict: true` when someone else already sent an item with that id; send it again under a new id), 413 too big, 422 invalid data (with `errors`), 428 work stamp needed (with `powBits`), 429 slow down.

## MCP

`POST /mcp` speaks the Model Context Protocol. See [AI-TOOLS.md](AI-TOOLS.md).

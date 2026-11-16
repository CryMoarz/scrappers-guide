# Architecture

How the Scrapper’s Digital Guide stores knowledge, moves it between devices, and lets a community grow it without ever needing the internet to work. Read [VISION.md](VISION.md) for why; this is how.

## Constraints that shaped everything

1. **Offline first, always.** Every feature works with no network. Sync is opportunistic: it happens when a connection exists and quietly waits when it doesn’t.
2. **Small devices.** It must run on cyberdecks, Raspberry Pi–class boards, old phones and custom handhelds. So: zero dependencies, no build toolchain beyond Node, plain files, and a text export for devices that can’t run a browser.
3. **No trust in the carrier.** Data travels over USB sticks, between caravans, through relays. Everything that moves is signed, so whoever carries it can’t forge or alter it.
4. **No accounts.** Identity is a key pair made on the device. No email, no password, nothing to phish or lose to a dead server.
5. **Deterministic answers.** Search and ranking are plain code over plain data. AI can translate a fuzzy need into a query, but it never invents parts or places.
6. **Honest confidence.** Everything says whether it’s a generic guess, documented from a source, likely, or verified by someone who opened the thing. Devices are labelled Generic: what most units of a kind contain.

## The pieces

```
schema/sdg.schema.json     one schema: validation, forms, API docs and AI tool definitions all read it
data/<collection>/<id>.json   the canonical knowledge: one small file per record
core/                      shared logic, runs in browsers and Node (search, ranking, validation, signing, sync)
app/                       the single-file offline app (app/scrappers-guide.html is built from app/src/)
server/                    the hub: API, moderation, sync, storage; also runs as a "node" mirror
mcp/                       the AI tool server (Model Context Protocol), stdio or over the hub
tools/                     build, validate, format, keys, moderation CLI, file sync, exports
dist/                      build outputs: signed release, text export, printable field guide, tiny export
```

```
           ┌──────────── data/ (git) ────────────┐
           │  one JSON file per record            │
           └──────┬───────────────▲───────────────┘
        build.js  │               │ accepted changes (and optional git commits)
                  ▼               │
  dist/release.json (signed) ── HUB (moderation, ledger, releases, /mcp, /api)
                  │                 ▲    │
     built into   │      proposals, │    │ change feed + signed checkpoints
                  ▼      comments,  │    ▼
      app/scrappers-guide.html    NODES (camp box, NOMAD, cyberdeck: mirror + outbox)
       (works with no hub)          ▲    │
                  ▲                 │    ▼
                  └──── apps, AI tools, USB bundles, other nodes ────┘
```

## Data model

Eight collections, each with a schema in `schema/sdg.schema.json`:

| Collection | Holds |
|---|---|
| `parts` | Part types, defined by function, with search words, substitutes, how to recognise and test them, shelf life and hazards |
| `devices` | Device templates: major parts, shared boards, where they’re found, tools, time, weight, hazards. Variants inherit from a parent |
| `boards` | Shared sub-assemblies, described once, inherited by every device that lists them |
| `models` | Real units someone opened: confirms, corrects or removes template parts |
| `buildings` | Building types with OpenStreetMap tags, looting pressure, access and hazards |
| `jobs` | Needs (“keep food cold”) mapped to part types, guides and tips |
| `hazards` | Safety cards: how to spot it, do, don’t, protection, first aid |
| `guides` | Teardowns, builds and blueprints, repairs, field tests, safety procedures, skills, references |

Plus `data/vocab.json` (tools and group names) and `data/meta.json` (the release sequence number).

The schema uses standard JSON Schema with two additions: `x-ref` marks a field that must name an existing record (`"x-ref": "parts"`), and `x-widget` hints at the form control. Because one file drives everything, adding a field to the schema automatically adds it to validation, the app’s forms, the API documentation and the AI tools.

See [docs/DATA-GUIDE.md](docs/DATA-GUIDE.md) for how to write good records.

## Search and ranking

`core/search.js`. A query is matched against part types (names, keywords, part numbers) and jobs (phrasings of a need). If a job matches at least as specifically as any part, the job wins and switches on its core part types; a job can narrow a broad part type with `only` words (refrigeration compressors, not aquarium air pumps).

Each matching part in each device gets a hidden-fruit score (0–100), multiplying ease of extraction, how common the device is, how overlooked the part is, quantity and confidence. The multiplication is deliberate: a part has to be decent on every axis to rank high. Optional factors:

- **Months since collapse:** parts decay by their half-life (lead-acid in months, magnets never), and looting pressure ramps up.
- **Tools you have:** devices needing tools you lack rank lower and say what’s missing.
- **Carry limit:** parts heavier than you can carry rank lower.
- **Logged models:** verified parts score higher; parts that models report missing score lower.

Guides also carry an era (fire to industry), a branch and the guides to learn first (`tree` in the schema). The app shows them as “Learn first” and “Leads to” links, the printed guide is ordered by era, and the branch picks a guide’s offline libraries. The validator keeps prerequisites flowing forward with no loops.

Building types are then ranked by how likely they hold the best devices and how much is probably left after looting, which is more for things people don’t recognise as valuable.

## Layers on a device

What any device (app or node) holds:

1. **Base**: the newest signed release it has, plus accepted changes applied on top. Identified by a sequence number and a hash.
2. **Local edits**: your own changes, applied immediately on your device. Each is also a draft proposal if you choose to share it.
3. **Outbox**: shared edits, comments and public field notes waiting for a hub.
4. **Carried items**: other people’s signed proposals, comments and notes you picked up from a bundle, waiting to be handed to the next hub you reach.
5. **Private things**: your stash (inventory), private field notes and your key. These never leave the device unless you export them.

When a newer base arrives, local edits are replayed on top. An edit whose record changed underneath it (its revision moved on) is kept and flagged for you to look at again.

## Identity and signatures

`core/sign.js`. Each person makes an Ed25519 key pair on their own device (Web Crypto in browsers, built-in crypto in Node). Every proposal, comment, review and field note is signed over its canonical JSON (sorted keys, no whitespace), with the author’s public key attached. Anyone can verify it; nobody can change it without breaking the signature.

A **fingerprint** (first 16 hex characters of the SHA-256 of the public key) names a key in logs and screens. Configs that grant a role use the **admin id** (the first 32 hex characters, 128 bits) or the whole public key, so nobody can make a key that matches by brute force.

**Work stamps** (hashcash-style proof of work) make spam expensive without accounts: a newcomer’s submission must carry a stamp whose hash has a set number of leading zero bits (12 by default, about a second on a phone). Contributors with accepted changes skip it.

## Releases, the ledger and sync

`core/changes.js`, `server/hub.js`, `server/sync.js`, `app/src/sync.js`.

- A **release** is the whole moderated dataset with a sequence number, a SHA-256 hash of its canonical JSON, and a signature. The app has one built in; hubs serve the current one at `/api/v1/release` (with ETag, so an unchanged release costs nothing to check).
- The **ledger** is the list of accepted changes, numbered 1, 2, 3… Syncing is “give me everything after N” (`/api/v1/sync?since=N`). Every response ends with a **checkpoint**: the hub’s signed statement that after change N the dataset hashes to H. The client applies the entries, hashes its own copy, and compares. Any mismatch falls back to downloading the full release.
- Clients **pin** a hub’s key the first time they connect (like SSH). A changed key stops sync until the user confirms. Apps and nodes keep pulled changes only when the result matches a checkpoint signed by that key, use a release only when it is signed by a maintainer key or the pinned hub key, never go back to an older release without the user (or a node’s operator) saying so, and check every pulled comment and field note (schema and signature) like anything carried by hand.
- **Bundles** are files (or HTTP payloads) carrying signed proposals, comments and observations, and optionally ledger entries and a release. They move data where there’s no network path: USB sticks, caravans meeting, radio links. `tools/sync.js` and the app’s Sync tab make and read them.

**Updates, and ignoring them.** Data updates arrive with sync; turning off automatic sync (Sync tab) freezes your copy until you choose to sync. App updates are separate: each build gets an id that fingerprints the code (not the data, which syncs on its own), written to `app/app-build.json`. Hubs report the build they serve in `/api/v1/info`, and an app that sees a newer one, signed by a maintainer key it trusts (`node tools/build.js --key`), shows a banner with **Update** (reload, or download the new file for a copy kept on disk) and **Ignore this version**, which hides that version for good. The download must match the SHA-256 in the signed build info before it is used, so a hub can't push an app of its own; with no maintainer key, no update is offered. Simple mode is a view over the same core and data, so it updates with everything else and never needs its own maintenance.

Sync order, every time a connection exists: send the outbox, pull accepted changes, update the status of your proposals, pull comments and shared field notes. Comments and field notes are paged by `received`, the time the hub (or node) stored them on its own clock, never by the `created` date their sender chose; hubs refuse a `created` that isn't an ISO time or is more than a day ahead. On failure it backs off (1 minute, doubling, up to 30) and retries when the device comes back online.

## The hub and nodes

One program, `server/hub.js`, two modes:

- **hub** takes signed contributions, validates them (schema, references, no new problems introduced), runs moderation, writes accepted changes to `data/` (and optionally commits them to git), and publishes releases and the change feed. The master is a hub; a region can run its own.
- **node** mirrors an upstream hub for a camp, a NOMAD box or a cyberdeck. It serves the same app and API locally, holds contributions in an outbox, and pushes and pulls whenever the upstream is reachable. A node never moderates.

Storage is SQLite when Node has it built in (22.13+), and plain append-only JSON-lines files otherwise, so a hub runs on old or minimal Node installs too.

### Moderation

- Roles: `contributor` (default), `trusted`, `moderator`, `admin` (admins are set in the hub config by admin id or public key), and `banned`.
- Every proposal is checked automatically. Anything that breaks the schema or a reference is refused with a list of problems.
- Moderators review a field-by-field diff against the current record and accept or reject with a note. A proposal made against an older revision is flagged as stale.
- Moderators’ and admins’ own edits are accepted at once; trusted contributors’ edits (not deletions) too.
- **AI-written proposals are always labelled and always wait for a human**, whatever the role of the key that sent them.
- Comments can be turned off per hub (`policy.comments`) and per device (Sync tab), and are capped per record: a record at the cap (`maxCommentsPerTarget`) takes no new comments until a moderator hides some. Existing comments are never dropped to make room.

### Votes

`core/votes.js`. A vote says “found it” or “not in mine” about one of a device’s parts (`devices/<id>#<part key>`), “helpful” about a comment, or “still true” / “not anymore” about a shared field note. Votes are signed like comments, so they travel in bundles and through nodes, and count once per person: the newest vote from a key replaces its older one, and a 0 takes it back. Hubs refuse unsigned votes, votes on your own comment or note, and targets that don’t exist, and charge newcomers the usual work stamp (`policy.votes` turns them off).

Votes feed confidence: when three people have found a part (and at least twice as many found it as didn’t), a generic guess counts as likely, and every report either way moves how likely the part is to be there, which the ranking uses. Comments sort by helpful votes, and field notes more people call out of date than still true are marked so. Logging a model is still the only way to document or verify a part.

### Git

`data/` is designed for git: one small file per record, stable formatting, one entry per line. The hub can commit each accepted change (`git.commit: true`) and push it (`git.push: true`), so the full history lives in an ordinary repository anyone can mirror, fork or audit. Edits made directly in git (pull requests merged on GitHub, for example) are picked up when the hub restarts: it compares every record with what it last knew and adds the differences to the ledger.

Git is optional: nothing breaks without it. See [docs/GIT-BASICS.md](docs/GIT-BASICS.md).

## AI access

- **MCP** (`mcp/protocol.js`): tools `scrap_search`, `get_record`, `list_records`, `find_guides`, `what_can_i_build`, `safety_brief`, `list_vocab`, `get_schema`, `propose_change`, `add_comment`, `log_observation`; prompts for planning a run, walking through a teardown and logging a model; every guide as a Markdown resource. Runs over stdio (`mcp/stdio.js`, fully offline) or HTTP (`/mcp` on any hub or node).
- **OpenAPI** (`/api/v1/openapi.json`): for tool runners that read OpenAPI instead of MCP.
- **Text export** (`tools/export-text.js`): one Markdown file per record, for local AI document search.

See [docs/AI-TOOLS.md](docs/AI-TOOLS.md).

## The map

`server/pmtiles.js`, `server/mvt.js`, `server/map.js`, `app/src/map.js`. The hub reads PMTiles vector maps (Project NOMAD's, found by itself, or files named in the config) a few kilobytes at a time, matches each place on them to building types by the OSM tag value the map gives as its kind, and ranks the places near a point for a search: the building type's score from “where to look”, lowered with distance. The app draws a plain base map from light tiles the hub makes and puts the ranked places, field notes and the user on it. The user's location stays on the device and goes only to their hub. See [docs/MAP.md](docs/MAP.md).

## Small and offline-only devices

- The app is one HTML file with the data built in. Copy it anywhere and open it.
- `tools/export-text.js` makes `dist/field-guide.html`, a printable edition.
- `tools/export-tiny.js` makes `dist/tiny/`: precomputed, tab-separated lookups (search word → part types, part type → best devices and places, device → parts, hazard cards) that a microcontroller can read line by line from an SD card.

## Decisions and why

| Decision | Why |
|---|---|
| One file per record, not one big file | Small diffs, few merge conflicts, easy review, works with git and with the hub |
| Signed items, not authenticated connections | Data can travel any path, including people’s pockets, and still be trusted |
| Keys, not accounts | Nothing to lose when servers die; no personal data held |
| A ledger with checkpoints | Cheap incremental sync over slow links, with integrity checks |
| Hub writes files, git optional | Works for people who don’t know git; full history for those who do |
| Node mode | A camp or NOMAD box serves its people locally and syncs upstream when it can |
| SQLite or plain files | Runs on whatever Node a device has |
| Schema-driven forms | Every record type and every new field gets a form for free |
| AI never auto-accepted | Keeps the verified core human-checked |
| Zero dependencies | Nothing to download, nothing to break, nothing to audit but our own code |

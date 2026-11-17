# Running a hub or a node

One program, two jobs:

- A **hub** takes contributions, runs moderation, and publishes the data. The master hub is one; regions or groups can run their own.
- A **node** mirrors a hub for the people around it (a camp, a NOMAD box, a cyberdeck, a Raspberry Pi in a go-bag). It serves the app and the API locally, works with no connection at all, and syncs with its hub whenever it can reach it.

Requires Node 20 or newer (22.13+ for the SQLite store; older versions use plain files automatically). No `npm install`: there are no dependencies.

## Quick start

```bash
node server/hub.js
```

Open http://127.0.0.1:8787. The app, the API (`/api/v1`) and the AI endpoint (`/mcp`) are all there. Add `--public` to listen on every network interface, so phones on the same Wi-Fi can use it.

## A hub with moderators

1. Make an admin key and keep the file safe:
   ```bash
   node tools/keys.js new admin.key "Your name"
   ```
2. Start the hub with that key’s admin id (32 hex characters, printed by `node tools/keys.js show admin.key`) or its whole public key as admin:
   ```bash
   node server/hub.js --public --admin <admin id>
   ```
   The 16-character fingerprint is not accepted here: it is short enough that someone could make a key to match it.
3. In the app on any device, restore `admin.key` in Sync → Contributor key. The Review tab appears.
4. Make other people moderators (their fingerprint is in their app’s Sync tab):
   ```bash
   node tools/mod.js http://localhost:8787 admin.key role <their public key> moderator
   ```

Moderate in the app’s Review tab or from a terminal:

```bash
node tools/mod.js http://localhost:8787 admin.key pending
```

```bash
node tools/mod.js http://localhost:8787 admin.key show <proposal id>
```

```bash
node tools/mod.js http://localhost:8787 admin.key accept <proposal id> "Thanks, matches mine"
```

## A node

```bash
node server/hub.js --mode node --upstream https://hub.example.org --public
```

It pins the hub’s key on first contact, pulls accepted changes every 15 minutes (`syncMinutes`), pushes queued contributions, and backs off quietly while offline. Pulled changes are checked (known collection, valid id, schema) and applied only when the result matches a checkpoint signed by the pinned key; anything else falls back to the full signed release, or stops sync with an error. A node never goes back to older data than it has: if the upstream offers an older release (say it was restored from a backup), sync stops and logs why. Start with `--allow-rollback` (`allowRollback`, `SDG_ALLOW_ROLLBACK=1`) to accept it. If the upstream already has an item with the same id from a different author, the node keeps its own copy queued and lists it under `sync.report.conflicts` in `/api/v1/info`. To sync right now, from the same machine, with the token the node keeps in its state folder:

```bash
curl -X POST -H "Authorization: Bearer $(cat state/control-token)" http://127.0.0.1:8787/api/v1/sync/now
```

## Settings

From defaults, then a JSON file (`--config hub.json` or `SDG_CONFIG`), then environment variables, then flags.

| Setting | Env | Flag | Default |
|---|---|---|---|
| `name` | `SDG_NAME` | | Scrapper’s Guide hub |
| `announcement` | `SDG_ANNOUNCEMENT` | | A line shown quietly on the front page of every app that syncs here (up to 500 characters) |
| `mode` | `SDG_MODE` | `--mode` | `hub` |
| `host`, `port` | `SDG_HOST`, `SDG_PORT` | `--host`, `--port`, `--public` | 127.0.0.1, 8787 |
| `dataDir` | `SDG_DATA` | `--data` | `data/` |
| `seedDir` | `SDG_SEED` | | none (the container sets it: bundled data copied in on first start and on updates) |
| `stateDir` | `SDG_STATE` | `--state` | `state/` |
| `store` | `SDG_STORE` | `--store` | `auto` (`sqlite` or `files`) |
| `upstream` | `SDG_UPSTREAM` | `--upstream` | none |
| `allowRollback` | `SDG_ALLOW_ROLLBACK=1` | `--allow-rollback` | off (a node refuses upstream data older than its own) |
| `admins`, `moderators` | `SDG_ADMINS`, `SDG_MODERATORS` | `--admin` | none |
| `git.commit`, `git.push` | `SDG_GIT_COMMIT=1`, `SDG_GIT_PUSH=1` | | off |
| `policy.comments` | `SDG_COMMENTS` | `--no-comments` | `on` |
| `trustProxy` | `SDG_TRUST_PROXY=1` (or the number of proxies in front) | | off. Set behind a reverse proxy: the client address is then read from the right of `X-Forwarded-For`, one entry per trusted proxy |
| `corsWrites` | `SDG_CORS_WRITES=0` | | on: pages from other origins (the app opened from a file, or served by another hub) may send signed contributions. Off: only the app this hub serves, and non-browser tools, can |
| `mcpWrite` | `SDG_MCP_WRITE=1` or `0` | `--mcp-write`, `--no-mcp-write` | `auto`: MCP write tools over HTTP only when listening on this machine alone (see [AI-TOOLS.md](AI-TOOLS.md)) |
| `nomad.url`, `nomad.kiwix`, `nomad.markers`, `nomad.kb` | `SDG_NOMAD` (an address, `auto` or `off`), `SDG_KIWIX`, `SDG_NOMAD_MARKERS=1`, `SDG_NOMAD_KB=1` | `--nomad`, `--kiwix`, `--nomad-markers`, `--nomad-kb` | off; the container uses `auto` with markers on (see [NOMAD.md](NOMAD.md)) |
| `map.pmtiles`, `map.nomad` | `SDG_MAP_PMTILES` (comma-separated) | `--map` (repeat for more) | none; NOMAD's maps are used when the hub finds NOMAD (see [MAP.md](MAP.md)) |
| `lora.*` | `SDG_LORA`, `SDG_LORA_HOST`, `SDG_LORA_DEVICE` | `--lora`, `--lora-host`, `--lora-device` | off (see [LORA.md](LORA.md)) |

Policy (JSON file only): `requireSignature`, `powBits` (newcomers’ work stamp, default 12), `powBitsKnown` (0), `knownAfter` (3 accepted changes), `approvals` (1), `autoAccept` roles, `trustedAutoAccept`, `maxCommentsPerTarget` (300; a full record refuses new comments, old ones are kept), `observations`, `votes` (true: found it / not in mine on parts, helpful on comments, still true on field notes), `maxBodyKB`, `maxBundleKB`, `writesPerTenMinutes` (120 per address; counted per item, so an array of proposals or a bundle spends one per item, and items past the budget come back as 429 to send again later).

Other limits are fixed: at most 20 proposals per request to `/api/v1/proposals` and 2000 items per bundle, text queries up to 200 characters, and every `limit` clamped to its endpoint’s maximum. A node pushing a big outbox sends what its budget allows each sync and the rest next time; raise `writesPerTenMinutes` on the upstream hub if your nodes carry a lot.

```json
{
  "name": "Ottawa Valley hub",
  "admins": ["3f9a1c2b4d5e6f7081a2b3c4d5e6f708"],
  "policy": { "approvals": 2, "comments": "on", "powBits": 14 }
}
```

## What’s in the state folder

`state/` holds the hub’s identity (`hub-identity.json`: its signing key), the database (`hub.sqlite`, or `store/` with plain files), and `control-token` (the secret for `/api/v1/sync/now`). Back it up. Never commit it. If you lose the identity, apps and nodes that pinned the old key will stop syncing until their users confirm the new one.

## Releases

```bash
node tools/build.js --key maintainer.key
```

signs `dist/release.json` and builds the app with the release inside. Add the maintainer’s public key to `trust/keys.json` (`node tools/keys.js trust maintainer.key`) so apps treat it as trusted.

The same key signs `app/app-build.json` (version, date, build id and the SHA-256 of `app/scrappers-guide.html`), which hubs serve as-is in `/api/v1/info`. Apps offer an update only when that signature checks out against a key in their built-in `trust/keys.json`, and they compare the downloaded file with the signed SHA-256 before saving or loading it. With no maintainer key in `trust/keys.json`, or a build not signed by one, no update is ever offered: that is the safe default, not a fault. A hub can’t make apps install anything by editing its own files.

`node tools/verify-app.js` checks that the committed app is the signed release (CI runs it on every push); add `--release` before tagging to check it was built for this version from this code. The release image ships the committed app as it is, so a build without the key must not be committed.

## Docker, NOMAD and small boards

- Docker: `deploy/Dockerfile` and `deploy/docker-compose.yml`. Everything that changes lives in one volume, `/guide`; the bundled data goes in on first start and again when a new image brings newer data, unless this copy has changed on its own.
- systemd (Raspberry Pi, cyberdecks): `deploy/scrappers-guide.service`.
- NOMAD: install the container as a custom app and point it at the box with `SDG_NOMAD`, or on the same machine without Docker use `deploy/scrappers-guide-user.service`; see [NOMAD.md](NOMAD.md).
- Very small boards: `--store files`, `SDG_COMMENTS=off`, and a longer `syncMinutes`. Devices that can’t run Node at all can use `node tools/export-tiny.js` output from an SD card.
- LoRa: see [LORA.md](LORA.md).

## Moving data with no network

```bash
node tools/sync.js pull http://hub:8787 catch-up.json.gz
```

```bash
node tools/sync.js push http://other-hub:8787 contributions.json
```

```bash
node tools/sync.js inspect some-bundle.json
```

The app’s Sync tab does the same with files: export your contributions, import anything someone hands you, and it carries other people’s signed contributions on to the next hub you reach.

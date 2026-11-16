# AI tools: MCP and OpenAPI

The guide can be used by AI assistants: a local model on a NOMAD box, Claude, or anything that speaks the Model Context Protocol (MCP) or reads an OpenAPI description. The assistant handles the fuzzy part (“I need to get water out of the creek”); the guide’s search and ranking stay deterministic, so nothing about parts or places is invented.

## What an assistant can do

| Tool | Does |
|---|---|
| `scrap_search` | The main one. Need, part, spec or part number in; matched job and part types, best devices to strip, and best places to look out. Takes months since collapse, tools on hand and a carry limit. |
| `get_record` | Any record. Devices come back fully resolved, with confidence per part, hazard cards and guides. |
| `list_records` | Ids and names in a collection, with a filter. |
| `find_guides` | Teardowns, builds, repairs, tests, safety, skills. |
| `what_can_i_build` | Builds ranked by how many of their materials you already have, with the best source for what’s missing. |
| `safety_brief` | Every hazard card for a set of devices. Assistants are told to call this before suggesting anyone open anything. |
| `list_vocab`, `get_schema` | Tools, groups and the record schemas, so a proposed record can be built correctly. |
| `propose_change` | Send a new or corrected record for review. Always labelled AI-written; never applied without a human moderator. |
| `add_comment`, `log_observation` | Notes on records; field notes on places (rounded to about 10 m, shared with peers by default). |

Prompts: `plan_scavenging_run`, `teardown_assistant`, `log_what_i_found`. Resources: a dataset summary, the data guide, and every guide as Markdown (`sdg://guides/<id>`).

## Fully offline, on the same machine (stdio)

```bash
node mcp/stdio.js
```

Reads `data/` directly. Contributions are signed with a local key (`state/mcp-identity.json`) and saved to `state/mcp-outbox.json` until you hand them to a hub:

```bash
node tools/sync.js push http://your-hub:8787 state/mcp-outbox.json
```

Add `--hub http://your-hub:8787` to send them straight away when the hub is reachable.

### Claude Code

```bash
claude mcp add scrappers-guide -- node /path/to/scrappers-guide/mcp/stdio.js
```

### Claude Desktop and other clients that use a JSON config

```json
{
  "mcpServers": {
    "scrappers-guide": { "command": "node", "args": ["/path/to/scrappers-guide/mcp/stdio.js"] }
  }
}
```

## Over the network (any hub or node)

Every hub and node serves MCP at `http://<host>:8787/mcp` (JSON-RPC over HTTP POST, the streamable HTTP transport without an event stream). Point any MCP client that supports remote servers at that URL.

Contributions made this way are signed by the hub’s own key, labelled AI-written, carry the same work stamp as any newcomer’s, and wait for review. Because the hub signs and stamps them for whoever calls, the write tools (`propose_change`, `add_comment`, `log_observation`) are opt-in over HTTP: on by default only for a hub that listens on this machine alone (the default `127.0.0.1`, no `trustProxy`), and off for one started with `--public` or behind a proxy, where `tools/list` shows only the read tools. Turn them on with `--mcp-write` or `SDG_MCP_WRITE=1` (or off with `--no-mcp-write`, `SDG_MCP_WRITE=0`). Over stdio they are always on, since the assistant runs on your own machine.

Limits over HTTP: at most 10 JSON-RPC messages per request, every tool call counts against the caller’s rate limit (write tools against the small write budget), and search-like arguments are capped at 200 characters.

## OpenAPI tool runners

`http://<host>:8787/api/v1/openapi.json` describes the whole API. Tool runners that import OpenAPI (Open WebUI’s tool servers, for example) can call `scrapSearch`, `getRecord`, `whatCanIBuild` and the rest directly.

## Local document search

If your assistant works from a folder of documents instead of tools:

```bash
node tools/export-text.js
```

and add `dist/text/` (one Markdown file per record) to its library.

## Project NOMAD

NOMAD’s built-in AI answers from its knowledge base and doesn’t call external tools, so give it the guide as documents: `node tools/nomad.js kb http://<box>:8080`. MCP is for other AI clients. See [NOMAD.md](NOMAD.md) for the rest of the integration (library links, map pins, installing on the box).

## Rules for assistants

The MCP server tells clients this, and it bears repeating: answer from the tools, never add devices, parts or places the tools didn’t return, say when data is a template guess, and check safety before anyone opens anything.

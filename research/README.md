# Research staging

Model-level data gathered from public sources is drafted here, lands in `data/` straight away as likely, and is then fact-checked.

1. **Research** (any person or AI agent) writes one `models` record per real product to `inbox/<id>.json`. Every part it confirms is marked `"conf": "documented"` with a `source` link, and every link appears in the record’s `sources`.
2. **Land**: `node tools/research.js land` puts each draft that passes the checks into `data/models` at once, with every claim shown as likely and the record marked not yet fact-checked. The guide fills fast without claiming more than it knows.
3. **Fact-check** (a different person or a stronger model) opens each link and keeps only claims the source actually shows or states. Survivors go to `verified/`, failures to `rejected/` with reasons.
4. **Import**: `node tools/research.js import` replaces each landed draft with its checked version (claims documented) and takes out drafts that were rejected. Then everything goes through the normal checks and review.

The working folders (`inbox/`, `verified/`, `rejected/`, `logs/`) and the fact-check log stay on the researcher's machine and are not published: what survives checking is published in `data/models`, each claim with its source link, and each model's `research` section says how it was read and what was left out.

`node tools/research.js keys <device>` lists a device’s part keys; `check` validates a folder; `pdf <url>` prints a PDF manual or datasheet as text (web fetchers can’t read them); `stats` shows how many claims survived.

## AI agents

In Claude Code, the maintainer uses two agent types kept locally in `.claude/agents/`: `salvage-researcher` (Haiku, cheap enough for the searching and reading) for step 1, and `salvage-fact-checker` (Sonnet, careful enough for the step that catches wrong claims) for step 2. Neither has browser control, so neither can touch anyone’s browser tabs; both skip sources behind bot checks or logins. Run at most five at a time.

## Rules

- **Documented is not verified.** Only someone who opened the unit can mark a part verified. Research marks parts documented, with a link; a part whose only source is a seller's listing is likely, with the listing linked (see [SOURCES.md](SOURCES.md#marketplaces-seed-items-and-rough-specs)).
- **Every claim has a link** where it is shown or stated. No link, no claim. If unsure, leave it out.
- **Good sources**: FCC and ISED filings (internal photos, block diagrams), manufacturer manuals and parts lists, replacement-part listings that name the original part, published teardowns (the Chinese teardown sites in SOURCES.md name every chip in chargers, power banks and earbuds), datasheets.
- **Facts and links only.** Part numbers, ratings and what’s inside are facts. Don’t copy manual text, schematics, diagrams or photos into the data; link to them. What we want from a manual is its component list (the parts list or bill of materials), not its wiring diagrams.
- **Ratings**: put volts, amps, watts and amp-hours a source states in `v`, `a`, `w` and `ah` on the part, as well as in its spec (see the data guide).
- **Notes and research**: `notes` is one or two sentences for someone salvaging the product: which variants or years the parts cover, and caveats. Everything about how the research was done goes in `research`, which the app folds away: `checked` (the date the fact-check ran, YYYY-MM-DD), `gaps` (conflicts between sources, unreadable markings, claims left out; one per line) and `method` (documents, filings, mirrors and pages used, sites that refused; one per line). Don't write that ext and obs are editorial; the app says so.
- **Scanned manuals**: `node tools/research.js pdf <url> --save <folder>` keeps the PDF so its pages can be looked at directly when the text layer is missing or scrambled.
- **Before searching the web**, check [SOURCES.md](SOURCES.md) for a source that already has the answer, and for which sources can and can’t be used.
- **Trademarks**: brand and model names are used only to identify products, as a parts catalogue or repair manual would. No logos, no endorsement implied, nothing that suggests affiliation.
- **Ids**: `<device>_<brand>_<model>`, lowercase with underscores.

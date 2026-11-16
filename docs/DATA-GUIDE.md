# Data guide

How to write records for the Scrapper’s Digital Guide. Read this before adding or changing data, whether by hand, in the app’s forms, through the hub, or as an AI tool. The schema in `schema/sdg.schema.json` is the source of truth for every field; this guide explains how to fill them well.

## Where data lives

One JSON file per record in `data/<collection>/<id>.json`. The file name must match the `id`.

| Collection | What it is |
|---|---|
| `parts` | Part types: what people search for, defined by what they do (lithium cells, small DC motors, water filters) |
| `devices` | Device templates: what a kind of device usually contains, and where it’s found |
| `boards` | Shared sub-assemblies (a mains power supply board) described once and inherited by every device that lists them |
| `models` | Real units someone opened, confirming or correcting a template |
| `buildings` | Building types, with the OpenStreetMap tags the map layer will search for |
| `jobs` | Things people need to get done (“keep food cold”) mapped to part types and guides |
| `hazards` | What can hurt you, how to spot it, and what to do |
| `guides` | Instructions: teardowns, builds and blueprints, repairs, field tests, safety procedures, skills |

`data/vocab.json` holds the tool list and the group names. `data/meta.json` holds the release sequence number; the hub maintains it.

Run `node tools/validate.js --warn` after any change. It checks every field and every reference.

## Ground rules

1. **Honesty over completeness.** A template is a guess and says so. Never invent a model number, brand, part number or measurement to make a record look verified. If you’re unsure of a spec, give a range (“12–24V”) or describe it (“small brushed motor”).
2. **Function over part number.** Part types describe what a thing does. Common part numbers go in `keywords` so searches find them.
3. **Safety is data.** If a part can hurt someone, say so in its `spec` and list the hazard on the device. Every guide lists its hazards.
4. **Write for someone tired, scared and in the field.** Short sentences. Plain words. Units always.
5. **Original words only.** Don’t paste text from manuals, websites or books. Summarise in your own words and add the source to `sources`.
6. **Nothing for hurting people.** No weapons, explosives, traps meant to injure, drug synthesis, or instructions for taking things from people. This is a guide to the abandoned and overlooked.
7. **Ids are forever.** Lowercase letters, digits and underscores. Once something points at an id, it never changes. To retire a record, set `deprecated: true` (and `replacedBy` where it applies).

## Scales

All ratings are 1–5.

| Field | Meaning | 1 | 5 |
|---|---|---|---|
| `ext` (on a part entry) | Extraction difficulty | Pull it out by hand | Specialist work, hours |
| `obs` (on a part entry) | How overlooked | Everyone grabs it | Nobody knows it’s there |
| `prev` (on a device) | How common the device is | Rare | In nearly every home |
| `demand` (on a part type) | How hard the public hoards it | Nobody wants it | Batteries, fuel, power gear |
| `exposure` (on a building) | Looting pressure | Ignored | Stripped in the first days |
| `l` (building likelihood) | How likely this building type holds this device | Unusual | Almost always |
| `severity` (hazard) | How bad | Minor | Can kill |
| `difficulty` (guide) | Skill and effort | Anyone | Experienced only |

## Part types (`parts`)

```json
{
  "id": "filter_water",
  "name": "Water filters and membranes",
  "group": "Water and air treatment",
  "demand": 4,
  "keywords": ["water filter", "filter cartridge", "reverse osmosis", "ro membrane", "carbon block"],
  "substitutes": ["carbon"],
  "summary": "Cartridges and membranes that strip sediment, chemicals or germs from water.",
  "uses": ["Drinking water from rain or streams", "Pre-filter before boiling or UV"],
  "identify": "Cylindrical cartridges in housings under sinks, in fridges, RO systems and pitchers. Labels often state micron rating.",
  "test": "Run clean water through: it should flow, not leak around the seals, and not shed black fines after the first flush.",
  "decay": { "halfLifeMonths": null, "note": "Sealed spares last years; used cartridges grow bacteria." },
  "hazards": []
}
```

- `keywords`: include the words people actually type, plurals left out (the search strips simple plurals), and common part numbers (LM2596, 18650, NE555).
- `substitutes`: other part types that can do the same job. Keep it to genuine substitutes.
- `decay.halfLifeMonths`: months after the grid goes down until about half the stock still in the wild is no longer usable. Lead-acid batteries left discharged: about 6. Untreated petrol: about 6. Lithium cells in storage: about 36. Motors, magnets and wire: `null` (they last).

## Devices (`devices`)

```json
{
  "id": "treadmill",
  "name": "Treadmill",
  "group": "Leisure and fitness",
  "aliases": ["running machine"],
  "prev": 4, "tools": ["screwdriver", "socket"], "mins": 40, "kg": 80,
  "hazards": ["heavy"],
  "comps": [
    {"key":"motor_dc_large","fn":"motor_dc_large","spec":"90–180V permanent-magnet DC motor, 1.5–3 hp — excellent wind or water generator","qty":1,"ext":2,"obs":4,"loc":"Under the front hood","kg":12}
  ],
  "boards": [{"id":"power_motor_controller","qty":1,"loc":"Under the hood","p":1}],
  "buildings": [{"b":"gym","l":5},{"b":"house","l":3}]
}
```

- `comps` are the major parts. Each `key` is unique within the device; use the part type id, or `<parttype>_<something>` when there are two entries of the same type (`motor_dc_small_wiper`).
- Put shared electronics on `boards` instead of listing every component. A board reference’s `p` is the share of models that have that board (0–1).
- `buildings` lists where the device is found. Be generous but realistic: a treadmill is in gyms (5), hotels (4) and houses (3), not in pharmacies.
- `kg` is optional but helps people on foot. Use it for the whole device and for heavy parts.
- **Variants** (`variantOf`) hold only what differs from the parent: an era, a different motor, a missing part (`{"key": "relay", "absent": true}`). Mark a parent `abstract: true` if every real unit is one of its variants.
- `mins` is a rough teardown time to the useful parts with the listed tools, for someone who has done it before.
- **Ratings**: `v` (volts), `a` (amps), `w` (watts) and `ah` (amp-hours) hold the numbers search compares, each a number or a range (`[100, 240]`); `ac: true` marks mains-type parts. Write them in the spec as well (“36V pack”), because people read the spec. `node tools/specs.js fill` copies numbers the spec states into the fields, and `node tools/validate.js --warn` flags a field that disagrees with its spec. A search for “12v motor” ranks 12 V motors first and pushes down entries whose voltage is unknown or wrong.

## Jobs (`jobs`)

```json
{
  "id": "keep_food_cold",
  "name": "Keep food cold",
  "keywords": ["keep food cold", "refrigeration", "fridge", "cool food", "cold storage"],
  "summary": "Run a small efficient fridge or freezer on solar, or build a Peltier cooler for small loads. Insulation does half the work.",
  "parts": [
    {"fn": "compressor", "why": "The heart of any real fridge", "core": true},
    {"fn": "thermoelectric", "why": "Peltier modules for small coolers", "core": true},
    {"fn": "insulation", "why": "Cuts the power you need"}
  ],
  "guides": ["build_peltier_cooler"],
  "tips": ["A chest freezer run as a fridge uses a fraction of the power of an upright fridge."]
}
```

`core: true` parts are switched on when someone searches the job; the rest appear as options. A part can say what the job needs from it with `need`: `{"fn": "solar_panel", "need": {"w": 5}}` ranks panels of at least 5 W above garden-light cells; volts in `need` mean “about this”, the others “at least this”.

## Hazards (`hazards`)

`label` is the short chip shown on cards (“Stored high voltage”). Fill `signs`, `do`, `dont`, `ppe` and `firstAid` as short imperative lines. Be accurate and conservative: if a step needs training, say so.

## Guides (`guides`)

`kind` is one of: `teardown` (getting parts out of a device), `build` (making something, including blueprints), `repair`, `test` (field-testing a part), `safety`, `skill`, `reference`.

- Steps are short and in order. Put the danger in `warn` on the step where it happens.
- `materials` items with an `fn` (part type id) power the “what can I build with what I have” feature. Mark nice-to-haves `optional`.
- `devices` and `parts` link the guide from those records.
- Longer explanations, diagrams in text, tables and theory go in `notes` as Markdown.
- License is CC BY-SA 4.0 unless you set another compatible open license.
- A material’s `only` words narrow where the app suggests scrapping it: `"only": ["food", "drum", "barrel"]` keeps a drinking-water build from suggesting a fire extinguisher as its tank.

Keep guides short and practical. Teaching a whole subject is what NOMAD’s libraries are for (Khan Academy, Wikibooks, wikiHow and the rest), so point at deeper material with `refs` instead of writing it here.

### Era, branch and what comes first

Every guide can say where it sits among the others: its era, its branch, and what to learn or build first. The app shows the prerequisites as “Learn first” and “Leads to” links on each guide, the printed guide orders guides by era, and the branch picks which offline libraries a guide links to:

```json
"tree": { "era": 4, "branch": "power", "requires": ["build_battery_bank_lead_acid", "test_solar_panel"] }
```

- `era`: 1 Fire, 2 Salvage, 3 Low voltage, 4 Power, 5 Machines, 6 Industry (names in `data/vocab.json`).
- `branch`: one of `vocab.branches` (fire, water, shelter, salvage, power, signal, machines, fabrication).
- `requires`: what someone should have learned or built first. Keep it to the real prerequisites, usually one to three. A requirement can be in the same era or an earlier one, never a later one, and there can’t be loops; the validator checks both.

## Ids for new records

| Collection | Pattern | Example |
|---|---|---|
| parts | what it is | `filter_water`, `gas_spring` |
| devices | the thing | `mobility_scooter`, `central_ac` |
| boards | the board | `hvac_control_board` |
| jobs | the job, verb first | `purify_water`, `keep_food_cold` |
| hazards | the hazard | `asbestos`, `co_gas` |
| guides | kind prefix + subject | `teardown_microwave`, `build_treadmill_wind_generator`, `test_lithium_cell`, `safety_discharge_capacitor`, `skill_soldering` |
| models | device + brand + model | `microwave_tx_brandname_mw1000` |

## Confidence

Device templates are generic: what most units of a kind contain, shown as “Generic guess” (`assumed`) and labelled Generic in the app. Confidence comes from logged models: research documents a real product from its sources (`documented`), or someone opens a real unit and marks each part `likely` or `verified`, or `absent`.

List the brands that commonly make a kind of device in `brands`, so a search for the brand finds it; brand and model names stay in models. Verified data gradually corrects the templates. Never mark something verified that you haven’t seen with your own eyes.

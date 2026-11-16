# Known limitations

What the guide can't do yet, or does only roughly. Read this before you rely on it.

## The data

- **Nothing is verified by hand yet.** Logged models are documented from public sources (service manuals, parts lists, FCC filings, teardowns), each claim checked against its source by a second AI pass. Nobody has opened one of them and confirmed its parts: zero parts are marked verified. People opening real devices and logging them is still the first priority.
- **Device templates are informed guesses** of what most units of a kind contain. The ratings that drive the ranking (how easy to extract, how overlooked, how likely in which building) are editorial estimates on a 1–5 scale, not measurements.
- **Guides have not been reviewed by people who do the work.** They were written with an AI model from general knowledge and checked for consistency with the hazard cards. Each guide says so in the app until someone with the experience reviews it.
- **Electrical ratings are partly filled.** Part entries carry volts, amps, watts and amp-hours, and search compares them, but only about 420 of 3,500 template entries state any; the rest are read from spec text when it gives numbers, and rank slightly lower when a search asks for a rating they don't state. `node tools/specs.js report` shows coverage by part type.
- **"Share of models" on part entries** (`p`) was set from wording like "some models" by a script: 0.25, 0.5 or 0.75. Treat those as rough.
- **Some rankings are odd.** Easy and overlooked can outweigh useful: "pump water" puts coffee makers (for their tubing) near the top, "solar panel" puts holiday lights first.

## The map

- It ranks places by building type and straight-line distance. There is no road routing, population snapshot or per-site looting estimate yet, and a zoom-13 map finds few shops. See [MAP.md](MAP.md).
- Building types match places only by the OpenStreetMap tags they list; the common kinds are covered, rarer ones may not be.

## The rest

- **The LoRa bridge** is tested in simulation and over UDP, not yet on a real Meshtastic radio.
- **One maintainer key** signs releases (fingerprint `95b3451c79dcd1ec`, in `trust/keys.json`). If it were lost, apps already out there couldn't be offered signed updates and everyone would fetch a new app by hand once; if it leaked, a new key would replace it and the change would be announced.
- **A lost contributor key can't be recovered.** Back yours up (Sync).
- **Admins are named by full key or admin id** in hub configs; old 16-character fingerprints are ignored with a warning.
- **Search** runs across every device on each keystroke: fine at a few hundred, will need an index at a few thousand.

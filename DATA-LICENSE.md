# Data license

Everything in `data/` (part types, devices, boards, models, buildings, jobs, hazards and guides), the exports made from it (`dist/`), and the data built into the app is licensed under the **Creative Commons Attribution-ShareAlike 4.0 International License** (CC BY-SA 4.0): https://creativecommons.org/licenses/by-sa/4.0/legalcode

In short: you may copy, share, adapt and build on it, including commercially, as long as you credit “CryMoarz and the Scrapper’s Digital Guide contributors” and share your adaptations under the same license.

A guide may name a different compatible open license in its `license` field; that guide is then under that license.

The code (everything else) is under the MIT License in [LICENSE](LICENSE).

## Trademarks and sources

Brand and model names are trademarks of their owners. They appear only to identify products, the way a parts catalogue or repair manual names them, and imply no affiliation or endorsement. The data records facts about products (what’s inside, ratings, part numbers) and links to public sources; it does not copy manuals, schematics, diagrams or photos.

## Data from other open projects

Some records are built from open datasets, under licences compatible with ours. Each such record names its source in `sources`.

- **Router and access point models** (`data/models/wifi_router_*`, imported by `tools/import-openwrt.js`): hardware data from the [OpenWrt Table of Hardware](https://toh.openwrt.org/) by OpenWrt wiki contributors, licensed CC BY-SA 4.0.
- **Device weights and materials** (`kg` and `materials` on ten electronics devices): averages from Babbitt and others, [Disassembly-based bill of materials data for consumer electronic products](https://doi.org/10.6084/m9.figshare.11306792) (2020), dedicated to the public domain under CC0.
- **Repair records** (`repairs` on 27 devices: how often repairs succeeded and what had failed): from [Open Repair Data](https://github.com/openrepair/data) by the Open Repair Alliance, licensed CC BY-SA 4.0.

## No warranty, and safety

The data is given as is, without warranty of any kind. Most of it is a generic guess about what most units of a kind contain, not verified fact, and is marked that way. Salvage work can injure or kill. You are responsible for your own safety: read the hazards, and when in doubt, leave it.

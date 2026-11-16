# Where research data comes from

Before anyone spends time searching the web by hand, check whether one of these sources already has the answer. Surveyed November 2026; check a source's terms again before relying on it.

## The rule: facts yes, documents no

What is inside a product is a fact: which chip, its part number, its voltage, where it sits, how many there are. Facts can't be owned, so the guide records them in its own words with a link to where they're shown. The documents that show them (datasheets, service manuals, schematics, teardown photos) are copyrighted: link to them, never copy their text, tables, drawings or images into the data.

Two limits on that:

- **Whole databases.** In the EU a database can be protected as a whole, separately from the facts in it. Looking up one part and citing it is fine; bulk-copying a commercial catalogue isn't, and many sites' terms forbid it anyway.
- **Site terms.** Some sources allow reading but not storing (most distributor APIs). Respect bot checks, logins and paywalls: if a page asks you to prove you're human, skip it.

## Tiers

Most sources are worth something now and then, so a source is rated by how it may be used, not thrown out:

- **Import**: an open licence that fits ours (CC BY-SA, CC BY, CC0). Bulk use is allowed, with credit.
- **Cite**: look up a model, take the facts in our own words, link the page. Most sources are here.
- **By hand**: the terms forbid scraping, automated access or storing what you read. Look things up manually now and then and cite the page or datasheet; research agents don't fetch these in bulk.
- **Avoid**: only what is truly unusable (no per-product facts at all, or pirated documents), and each says why.

## Sources

| Source | What it gives us | Terms | Tier | How to use it |
|---|---|---|---|---|
| [Open Repair Alliance data](https://github.com/openrepair/data) | 416,000 repair records of electrical goods: product category, brand, year, fault, fixed or not | CC BY-SA 4.0, the same as ours | Import | Which brands and devices are common and how they fail: picks which models to research and informs how common each device is. Credit the Open Repair Alliance. |
| [KiCad libraries](https://www.kicad.org/libraries/license/) | Thousands of common components with descriptions and datasheet links | CC BY-SA 4.0 with an exception for designs | Import | Datasheet links and one-line descriptions for chips found in models. Keep the attribution. |
| [Internet Archive Manuals](https://archive.org/details/manuals) | Over a million manuals, including service manuals and schematics, with searchable OCR text and a search API | Per document; mostly manufacturer copyright | Cite | Find the service manual or parts list for a model, read the facts, link the item page. |
| [FCC equipment authorisation](https://www.fcc.gov/oet/ea/fccid) | Internal photos, block diagrams and manuals of every radio-transmitting product sold in the US, by FCC ID | US government records; exhibits belong to the filer, some are confidential | Cite | Read what's inside, cite the exhibit. The FCC ID goes in a model's `fcc` field. |
| [jlcparts](https://github.com/yaqwsx/jlcparts) (the LCSC/JLCPCB catalogue as one database) | Part numbers with ratings and datasheet links | Code MIT; the catalogue data has no stated licence | Cite | Look up a part number to confirm its ratings and find its datasheet; cite the datasheet. Don't import the catalogue. |
| [ENERGY STAR data](https://www.energystar.gov/products/spec/energy_star_api_user_essentials_pd) | Model numbers of certified fridges, freezers, room air conditioners, dehumidifiers, fans and more, with power and capacity | US EPA data; no licence stated on the pages read | Cite | Real model numbers and ratings for appliance categories; cite the dataset. Don't use the ENERGY STAR mark. |
| [ManualsLib](https://www.manualslib.com/) | User and service manuals as readable pages | Manufacturer copyright | Cite | Read and cite; the extracted text separates table columns, so align rows carefully. |
| [iFixit](https://www.ifixit.com/) | Teardowns and repair guides with part numbers | CC BY-NC-SA: non-commercial, so not compatible with our licence | Cite | Facts and links only. Its API (`/api/2.0/guides/<id>`) is easier to read than the pages. |
| [BOMwiki](https://bomwiki.com/) | Generic bills of materials as nested assemblies (an air conditioner as 117 parts), partly machine-drafted, mostly without part numbers or per-line sources | Content licence "being finalized" (November 2026), so all rights reserved for now; engine code AGPL-3.0 | Cite | Read it for parts a device template may be missing and add them in our own words. If it publishes an open licence and its planned data dumps, it may move to Import. |
| Octopart, Digi-Key, Mouser | Part search with ratings, datasheets and stock | Their APIs' terms forbid storing results | By hand | Look a part up on the website now and then to confirm ratings or find its datasheet; cite the datasheet, not the listing. |
| [EPREL](https://eprel.ec.europa.eu/) (EU energy label register) | Model-level energy data for appliances sold in the EU | No reuse licence found; bulk access needs an API key | By hand | Look up a model on the public site; revisit bulk use if a key and a licence come through. |
| EU Urban Mine Platform (ProSUM) | National totals of materials in e-waste | | Avoid | No per-product facts: it says how much copper a country's e-waste holds, not what is in a given product. |
| Manual file-sharing sites (Elektrotanya and similar) | Service manuals, uploaded without clear permission | Redistribute copyrighted manuals | Avoid | Don't link them. If one shows you which manual a model needs, find that manual on the maker's site, ManualsLib or the Internet Archive and cite that instead. |

## Open datasets (surveyed November 2026)

| Source | What it gives us | Terms | Tier | How to use it |
|---|---|---|---|---|
| [DeviWiki](https://deviwiki.com/) (and the [WikiDevi mirror](https://wikidevi.wi-cat.ru/)) | About 15,000 routers, Wi-Fi adapters and embedded boards: CPU, flash, RAM, Wi-Fi chips, FCC ID, power supply rating | CC BY-SA "unless otherwise noted" (DeviWiki 4.0, the mirror 3.0) | Import | Seed router and Wi-Fi models in bulk, with credit. Prefer DeviWiki, and check each page for a notice that overrides the licence. |
| [OpenWrt Table of Hardware](https://toh.openwrt.org/) | Routers, access points and switches: SoC, flash, RAM, Wi-Fi chips, FCC ID; a nightly `toh.json` export | Wiki content CC BY-SA 4.0 "except where otherwise noted" | Import | The same, from the export. Confirm the licence on one data page first (the wiki sits behind a bot check). |
| [Disassembly-based BOM data for consumer electronics](https://doi.org/10.6084/m9.figshare.11306792) (Babbitt et al.) | 95 products in 25 categories (phones, laptops, TVs, consoles, drones, thermostats): mass and materials per assembly | Dataset CC0, paper CC BY 4.0 | Import | Device and part weights (`kg`) and what the bulk of each is made of. No chips. |
| [crifan: smart speaker teardowns](https://book.crifan.com/books/smart_speaker_disassemble_summary/website/) | Tmall Genie speakers (X1, C1, M1, CC): chips per model (2019) | CC BY 4.0 | Import | Small and narrow; keep its own citations. |
| [OSHWHub](https://oshwhub.com/) (立创开源硬件平台) | User-published hardware projects with schematics, PCBs and BOMs | Per project, chosen by its author | Import or Cite | Builds, not teardowns. Import only projects whose licence field says CC0, public domain, CC BY or CC BY-SA. |

## Teardown sites

Chinese teardown sites are the richest per-model source for chargers, power banks, earbuds and power electronics: most name every chip with its part number. None states an open licence, so take facts one model at a time and cite the page.

| Source | What it gives us | Terms | Tier | How to use it |
|---|---|---|---|---|
| [充电头网](https://www.chongdiantou.com/) (ChargerHead), English edition [ChargerLAB](https://www.chargerlab.com/) | Chargers, power banks, car chargers, PSUs, cables, batteries: controller, GaN, rectifier and protocol chips with part numbers | Copyright line only; ChargerLAB's robots.txt asks AI crawlers to stay out | Cite | Agents open the 充电头网 teardown for the model being researched, never crawl the archive; ChargerLAB is for people. Reposts (SMZDM, eefocus) cite the original instead. |
| [我爱音频网](https://www.52audio.com/) (52audio) | Earbuds, headphones, smart and Bluetooth speakers: SoC, fuel gauge, charging chips, cell models and capacity | Copyright line only | Cite | One model at a time. |
| [EDN China](https://www.ednchina.com/) and [EET-China](https://www.eet-china.com/) | Numbered teardown reports: chargers, TV boards, PLCs, server PSUs, motor controllers | Not read (pages timed out) | Cite | Chip-level in search snippets; by hand if agents can't reach a page. |
| [电源网](https://www.dianyuan.com/) (Dianyuan) | Power electronics: PV inverters, solar charge controllers, PSUs | No reposting without permission | Cite | Uneven depth; good for solar gear. |
| 电子发烧友 (elecfans), 数码之家 (mydigit.cn), Zhihu, Bilibili | Community teardowns of all sorts | They refuse automated fetches | By hand | A person looks up a model now and then and cites the post. |
| [ITmedia](https://www.itmedia.co.jp/keywords/dismantle.html) (EE Times Japan, MONOist) 分解 series | Japanese teardowns, including a long-running series with chip lists | All rights reserved | Cite | Chip part numbers per model. |
| Nikkei xTECH, Fomalhaut Techno Solutions, TechInsights | Full BOMs, chip-level | Mostly paid | Cite (free pages) | Free articles and sample reports can be cited; the databases are behind paywalls. |
| [EEVblog forum](https://www.eevblog.com/forum/) | Teardowns and repairs, often with photos | No licence stated | Cite | Anecdotal, thread by thread. |
| [fccid.io](https://fccid.io/), fcc.report | Mirrors of FCC filings, easier to search than the FCC's own site | No terms found | Cite | Cite the FCC exhibit itself where possible. |
| [Tasmota templates](https://templates.blakadder.com/), [ESPHome devices](https://devices.esphome.io/) | About 3,600 smart plugs, bulbs and switches with their chip or module | EPL-2.0, GPL-3.0 (code licences, not data licences) | Cite | Which Wi-Fi chip a smart device uses. |
| [Panelook](https://www.panelook.com/) | LCD panel part numbers and specs | No terms seen | Cite | Identify a screen from the part number on its back. |
| PartSelect, RepairClinic, AppliancePartsPros, Sears PartsDirect | Per-model appliance parts lists and exploded diagrams with the maker's part numbers | They refuse automated fetches | By hand | One of the best ways to confirm an appliance's motor, pump, valve or board by part number: look it up and cite the page. |
| [Radiomuseum](https://www.radiomuseum.org/) | Vintage radios and the valves in each | Contributed material stays the contributor's | By hand | Valve and part lists for old sets. |
| [Cybenetics](https://www.cybenetics.com/) | About 2,400 PC power supplies with certifications | Bulk downloading, scraping or automated collection (AI agents included) needs written permission | By hand | Look up a PSU model's ratings. |

No systematic Korean teardown site turned up, and no chip maker or design house was found publishing full reference BOMs openly; their datasheets' application circuits are citable.

## Marketplaces: seed items and rough specs

AliExpress, Amazon, Taobao and Tmall, 1688 and JD are **By hand**: their terms forbid collecting listings with robots, scrapers or systematic retrieval, so agents don't crawl them. A person browsing them is still one of the best ways to see which models exist and sell, to pick what to research next and to round out a device template.

- **A part or rating taken from a listing goes in at `likely`**, with the listing as its source, never `documented`. A manual, filing or teardown moves it up.
- Brand flagship listings are usually right about headline specs. **No-name listings often overstate capacity and power**: say so in the part's spec ("labelled 20,000 mAh; no-name packs often hold much less"), because that is worth knowing when salvaging one.

## Open hardware, for builds

[Kitspace](https://kitspace.org/), [CERN's Open Hardware Repository](https://ohwr.org/) and other open-licensed KiCad project collections hold complete designs under open licences. They're a source for build guides (a charge controller, a motor driver), not for what's inside commercial devices. Check each project's licence before adapting it.

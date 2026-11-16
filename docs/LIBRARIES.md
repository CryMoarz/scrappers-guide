# Recommended offline libraries

The guide tells you what to strip and where to look. Offline libraries tell you everything around that: how to repair the thing, what a part does, how to build with it, how to treat the burn. Install some of these next to the guide and every device, part, guide and hazard card gets “Read more offline” links straight into them.

They are ZIM files, read by [Kiwix](https://kiwix.org). Project NOMAD installs and serves them for you (its content library), and the guide finds them by itself on a NOMAD box. Without NOMAD, run `kiwix-serve` and give the guide its address in Sync → Settings. Names below are as they appear in Kiwix’s library; sizes are approximate (November 2026) and change with each edition.

## How much to carry

The guide itself is under 2 MB. What takes the space is maps and libraries, so think in two kits:

- **Deck or base** (a cyberdeck, a NOMAD box or a laptop with a terabyte or more): take everything on this page, about 400 GB with Wikipedia with pictures and the Survivor Library, plus your country's map at zoom 15 (Canada is 15.8 GB). A couple of terabytes holds all of it with room to spare. This is where the hub runs, so the map works here and for every phone on its network.
- **Pocket kit** (a phone, an SD card or a USB stick, about 10 GB): the guide app, WikiMed, iFixit, a small Wikipedia (mini or no pictures) and the Post Disaster Resource Library, read with the Kiwix app. The guide's map needs a hub, so away from your deck or base carry your area in an offline map app as well. Your city or county at zoom 15 is far smaller than a whole country; NOMAD shows the size before it downloads.

Everything works without a network: the deck serves the pocket kits when they're near it, and each kit stands on its own when they're not.

## Core: start here (about 13 GB)

These feed the links the guide makes everywhere. Install them first.

| Library | Kiwix name | Size | The guide links it from |
|---|---|---|---|
| iFixit repair guides | `ifixit_en_all` | 3.6 GB | every device and logged model |
| Electronics Q&A | `electronics.stackexchange.com_en_all` | 4.3 GB | shared boards, electronic parts, power and signal guides |
| Home Improvement Q&A | `diy.stackexchange.com_en_all` | 2.1 GB | guides and jobs |
| WikiMed Medical Encyclopedia | `wikipedia_en_medicine` | 0.2–1.9 GB | every hazard card |
| Military Medicine | `irp.fas.org_en_military-medicine` | 0.1 GB | every hazard card |
| Wikipedia, a small edition | `wikipedia_en_all` (mini or no-pictures) or `wikipedia_en_100` | 0.1–14 GB | part types, devices, guides, jobs, hazards |
| Post Disaster Resource Library | `zimgit-post-disaster_en` | 0.6 GB | water and shelter guides |
| CD3WD appropriate technology | `cd3wdproject.org_en_all` | 0.6 GB | water, power, machine and fabrication guides |
| Water Treatment Library | `zimgit-water_en` | small | water guides |
| Food for Preppers | `zimgit-food-preparation_en` | 0.1 GB | fire and food guides |

## For building with what you strip (about 5 GB)

| Library | Kiwix name | Size | The guide links it from |
|---|---|---|---|
| Appropedia | `appropedia_en_all` | 0.6 GB | jobs; fire, water and shelter guides |
| energypedia | `energypedia_en_all` | 0.7 GB | power guides |
| Low-tech Magazine (solar edition) | `solar.lowtechmagazine.com_mul_all` | 0.7 GB | power guides |
| Motor Vehicle Mechanics Q&A | `mechanics.stackexchange.com_en_all` | 0.3 GB | machine guides |
| Amateur Radio Q&A | `ham.stackexchange.com_en_all` | 0.1 GB | signal guides |
| Woodworking Q&A | `woodworking.stackexchange.com_en_all` | 0.1 GB | fabrication guides |
| The Great Outdoors Q&A | `outdoors.stackexchange.com_en_all` | 0.1 GB | shelter guides |
| A Library of Knots | `zimgit-knots_en` | small | the knot guides |
| Engineering LibreTexts | `libretexts.org_en_eng` | 0.7 GB | (searchable; no automatic links yet) |
| Learning Self-Reliance | `lrnselfreliance_en_all` | 4.0 GB | (searchable; no automatic links yet) |

Useful alongside, though the guide doesn’t link them automatically yet: Bicycles Q&A (`bicycles.stackexchange.com_en_all`, 0.5 GB), Gardening Q&A (`gardening.stackexchange.com_en_all`, 0.9 GB), the USDA Guide to Home Canning (`usda-2015_en`, small), the Medical Library (`zimgit-medicine_en`, 0.1 GB) and MedlinePlus.

## For microcontrollers, code and routers (about 1.4 GB)

| Library | Kiwix name | Size | The guide links it from |
|---|---|---|---|
| Arduino Q&A | `arduino.stackexchange.com_en_all` | 0.3 GB | microcontrollers and MCU boards |
| Raspberry Pi Q&A | `raspberrypi.stackexchange.com_en_all` | 0.3 GB | MCU boards |
| Robotics Q&A | `robotics.stackexchange.com_en_all` | 0.2 GB | (searchable; no automatic links yet) |
| OpenWrt wiki | `openwrt.org_en_all` | 0.5 GB | Wi-Fi routers, every router model, and OpenWrt pages cited as sources |
| C++ reference (DevDocs) | `devdocs_en_cpp` | 8 MB | (searchable; for Arduino code) |
| Python reference (DevDocs) | `devdocs_en_python` | 5 MB | (searchable; for MicroPython code) |

## If you have the space

| Library | Kiwix name | Size |
|---|---|---|
| Wikipedia with pictures | `wikipedia_en_all` (maxi) | about 127 GB |
| Survivor Library | `survivorlibrary.com_en_all` | about 220 GB |

The guide links Survivor Library from machine and fabrication guides when it is installed.

## Not available

- **wikiHow** is no longer in Kiwix’s library. The guide still links to it if you have an old copy.
- **Instructables** has no ZIM in Kiwix’s library.

## How the links work

The guide (or the hub serving it) reads which books are installed and only shows links to those. A record’s name is searched in the right book, or a record can name an exact page in its `refs`. Which libraries feed which records is set in `core/text.js` (`DEFAULT_LIBS`, `BRANCH_LIBS`), and how each library’s books are recognised is in `data/vocab.json` under `libraries`. See [NOMAD.md](NOMAD.md) for how a NOMAD box shares them with every phone and laptop on its network.

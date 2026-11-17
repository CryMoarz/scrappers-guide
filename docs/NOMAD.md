# Running next to Project NOMAD

[Project NOMAD](https://github.com/Crosstalk-Solutions/project-nomad) is an offline knowledge server: a Command Center that runs Kiwix (Wikipedia, medical references, iFixit and more), offline maps, a local AI with a knowledge base, Kolibri and other tools as Docker containers. The guide installs on it as an app and plugs into it in four ways. All of it was built against NOMAD’s own source (version 1.35) and tested against a real NOMAD; check its documentation if a newer NOMAD changes things.

| NOMAD piece | Default address | What the guide does with it |
|---|---|---|
| Command Center | `http://<box>:8080` | Runs the guide as a Supply Depot app; links hazard cards to its first-aid pages |
| Information Library (Kiwix) | `http://<box>:8090` | Every device, part, hazard and guide links to the matching Wikipedia, medical, iFixit and Q&A articles |
| Offline maps | Command Center `/api/maps/markers` | Shared field notes appear as coloured pins |
| AI Assistant | Command Center `/api/rag/upload` | The whole guide goes into its knowledge base, so its chat can answer from it |

## 1. Install the guide on your NOMAD

Three steps in the Command Center, with nothing to type in a terminal:

1. Open **Supply Depot** and click **Add a custom app**.
2. Fill in:
   - **Name:** `Scrapper's Guide`
   - **Image:** `ghcr.io/crymoarz/scrappers-guide:4.0.1` (use the newest version number from the project page)
   - **Port:** container `8787`, host `8787` (or the free port NOMAD suggests)
   - **Volume:** host `/opt/project-nomad/storage/scrappers-guide`, container `/guide`
   - Optional: category **Education**, icon **Tool**
3. Click **Install**, then **Open** once the card says it’s running.

That’s all. The guide finds NOMAD by itself, with no addresses to enter: it links every record into your Information Library, links hazard cards to NOMAD’s first-aid pages, and puts shared field notes on NOMAD’s map. Links work from any device on your network, the same way NOMAD’s own Open buttons do.

**Updates:** when a new version is published, the card shows **Update available**. Updating keeps your key, your contributions and your notes, and brings the newer records. The one exception: if records were changed on this box itself (by a moderator here, say), it keeps those rather than overwrite them, and says so in its log.

**Your data** lives in `storage/scrappers-guide` on the NOMAD, next to the other apps’ folders. Backing up that folder backs up the guide. Without the volume it still works, but forgets its key and notes whenever NOMAD rebuilds it.

**Optional settings**, under **Manage › Edit › Environment Variables**:

| Variable | Default | What it does |
|---|---|---|
| `SDG_NOMAD_KB` | off | `1` puts the guide in NOMAD’s AI knowledge base, so its chat can answer from it. It replaces its own documents when the data changes. Embedding them keeps NOMAD busy for a while, which is why it’s off until you ask. |
| `SDG_NOMAD_MARKERS` | `1` | `0` keeps field notes off NOMAD’s map |
| `SDG_NOMAD` | `auto` | `off` to leave NOMAD alone, or the Command Center’s address if NOMAD is on another machine |
| `SDG_COMMENTS` | `on` | `off` saves space |
| `SDG_MODE`, `SDG_UPSTREAM` | `hub` | `node` and a hub’s address, to mirror that hub and pass contributions on to it |

### Without the Supply Depot

The same image runs on any machine with Docker, next to NOMAD or not:

```bash
docker run -d --name scrappers-guide --restart unless-stopped -p 8787:8787 -v /srv/scrappers-guide:/guide ghcr.io/crymoarz/scrappers-guide:4.0.1
```

To build the image yourself from the project folder:

```bash
docker build -f deploy/Dockerfile -t scrappers-guide .
```

Or with no Docker at all, using Node:

```bash
node server/hub.js --public --nomad auto --nomad-markers
```

### Keep it running on the NOMAD machine, without Docker

A systemd user service needs no sudo, starts when you log in, and restarts the guide if it crashes. Copy `deploy/scrappers-guide-user.service` to `~/.config/systemd/user/scrappers-guide.service`, set the folder and the path to node in it, then:

```bash
systemctl --user daemon-reload && systemctl --user enable --now scrappers-guide
```

After updating the data or the code (a hub picks up changed records when it starts):

```bash
systemctl --user restart scrappers-guide
```

```bash
systemctl --user stop scrappers-guide
```

```bash
journalctl --user -u scrappers-guide -f
```

To start it at boot, before anyone logs in, also run `loginctl enable-linger`. In the Command Center, add it as a link to `http://<box-ip>:8787`.

## 2. Links into the offline library

The hub reads Kiwix’s catalog every 15 minutes, works out which books are installed (Wikipedia, the medical encyclopedia, Military Medicine, iFixit, wikiHow, the water, food and knots libraries, the electronics and home-improvement Q&A sites, Wikibooks, Gutenberg), and tells every app and AI tool. Each record then shows **Read more offline** links:

- devices → iFixit and Wikipedia
- parts → Wikipedia, and the electronics Q&A for electronic parts
- hazards → the medical encyclopedia, Military Medicine, Wikipedia, and NOMAD’s own condition pages (burns, cuts, eye irritation, skin rashes, allergic reactions)
- guides and jobs → Home Improvement Q&A and Wikipedia (and wikiHow, if you have an old copy), plus the libraries for their branch (power, water, machines and so on)

Sources work the same way. A source on a site one of your books copies (iFixit, Ready.gov, MedlinePlus, CDC travel health, Wikipedia, Wikibooks, wikiHow, the Stack Exchange Q&A sites) gets an **offline** link beside it. The hub asks Kiwix whether the book has that page, since books are snapshots: if it does, the link opens it; if not, it searches the book for the source’s title.

Which libraries to install, with their exact names and sizes: [LIBRARIES.md](LIBRARIES.md).

When NOMAD runs on the same machine as the hub, the hub sees it as `localhost`. A phone reaching the hub at `192.168.1.50:8787` gets its library links on `192.168.1.50` too, so they work from any device on the network.

A Kiwix catalog lists a book by a short name (`wikipedia_en_100`), but links need the dated name in its address (`wikipedia_en_100_mini_2026-01`). The hub matches libraries on the first and links with the second. Whole-encyclopedia Wikipedia books are preferred over topic sets like `wikipedia_en_medicine`, which the medical encyclopedia link uses instead.

Records can carry exact links in `refs` (see the data guide); without them, the record’s name is searched in the right book. The libraries and how to recognise their books are in `data/vocab.json` under `libraries`. Apps not served by a hub can set the Kiwix and NOMAD addresses in Sync → Settings.

## 3. The guide's map

The guide's Map tab reads NOMAD's own offline maps: download your region in NOMAD's Maps at zoom 15 and it finds shops, amenities and buildings near you for whatever you search. Nothing to set up. See [MAP.md](MAP.md), including a workaround for NOMAD 1.35.1's size-estimate timeout on big regions.

## 4. Field notes on NOMAD’s map

With markers on, every field note shared with peers or the public becomes a pin. The colour comes from its status: untouched green, partly looted yellow, cleared blue, dangerous red, occupied purple. A note whose status changes moves its pin to the new colour. Private notes never leave the device they were made on.

## 4. The guide in NOMAD’s AI

NOMAD’s AI Assistant answers from its knowledge base; it doesn’t call external tools, so MCP doesn’t apply to it (MCP is for other AI clients, see [AI-TOOLS.md](AI-TOOLS.md)). Installed on NOMAD, the guide adds itself with `SDG_NOMAD_KB=1` (see above). From a computer with the project on it:

```bash
node tools/nomad.js kb http://192.168.1.50:8080
```

Either way, the guide goes in as seven Markdown documents (devices, part types, guides, hazards, jobs, buildings, logged models) under its own “scrappers-guide” collection, which NOMAD’s Knowledge Base screen can switch on and off as a set. Its earlier documents are removed first, so running it again after an update replaces them.

Check what’s reachable at any time:

```bash
node tools/nomad.js check http://192.168.1.50:8080
```

## LoRa

NOMAD offers the Meshtastic web client in its Supply Depot; it no longer runs a Meshtastic daemon. The guide’s LoRa bridge talks to a radio directly (see [LORA.md](LORA.md)). If the Meshtastic web client is using a USB radio, give the bridge its own radio, or connect both to a Wi-Fi radio’s network API.

## Ideas not built yet

- **The guide as a ZIM file.** Kiwix and NOMAD’s knowledge base both read ZIM, so packaging the guide as one would put it in NOMAD’s library next to Wikipedia, searchable and readable with no app at all.
- **A one-click Supply Depot entry.** NOMAD’s curated apps are defined in its source (`admin/database/seeders/service_seeder.ts`, with a section in `admin/docs/supply-depot-apps.md`). Once the image is published and has a few releases behind it, propose an entry there. Until then, ask to be listed on NOMAD’s [Community Add-Ons](https://github.com/Crosstalk-Solutions/project-nomad/blob/main/admin/docs/community-add-ons.md) page by opening an issue on the NOMAD repository.

## Publishing a release (maintainers)

The image is built and published by GitHub Actions (`.github/workflows/release-image.yml`) for x86 and ARM, to GitHub’s container registry, which NOMAD trusts. Set `version` in `package.json`, then tag it:

```bash
git tag v3.0.1 && git push --tags
```

NOMAD spots updates by version number (`3.0.1` or `v3.0.1`), and it warns against installing `latest`, so the install steps always name a version.

To try a build on your own NOMAD before publishing it: NOMAD uses an image that’s already on the machine instead of downloading it, so build it there with the next version number (`sudo docker build -f deploy/Dockerfile -t scrappers-guide:3.0.1 .`), then in the Supply Depot use **Manage › Edit** to change the image to that version and **Save**. NOMAD replaces the container and keeps the `/guide` folder. The first time, make the package public: on GitHub, your profile → **Packages** → **scrappers-guide** → **Package settings** → **Change visibility**.

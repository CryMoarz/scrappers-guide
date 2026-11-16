# The map

The Map tab shows where to look for what you need, near you: the places on an offline map that hold the devices you'd strip, ranked by how likely they hold the best ones, how much is probably left and how far away they are. It draws a plain base map, puts the ranked places on it as numbered pins, and shows your field notes and where you are.

## Where the map comes from

The hub reads [PMTiles](https://github.com/protomaps/PMTiles) vector maps built from OpenStreetMap, the kind [Protomaps](https://protomaps.com) makes and Project NOMAD downloads. It reads a few kilobytes at a time (the header, the directories on the way to a tile, the tile), so a 16 GB map costs nothing to open.

- **On Project NOMAD** nothing needs setting up: the guide finds NOMAD's maps by itself (`/api/maps/regions`) and reads them over NOMAD's network. Download your region in NOMAD's Maps at **zoom 15**: a zoom-13 map keeps land use and landmarks but drops most shops and building outlines, so most places can't be found on it.
- **Anywhere else**, name PMTiles files or URLs that answer range requests: `"map": { "pmtiles": ["/maps/region.pmtiles"] }` in the hub config, `--map /maps/region.pmtiles` on the command line, or `SDG_MAP_PMTILES=/maps/a.pmtiles,/maps/b.pmtiles`. Make one with the `pmtiles` tool: `pmtiles extract https://build.protomaps.com/<date>.pmtiles region.pmtiles --region=region.geojson --maxzoom=15`.

**NOMAD 1.35.1 and zoom 15 for a big region.** NOMAD estimates a download's size with a 60-second limit, and a large country at zoom 15 can take longer, so the download fails before it starts ("Preflight returned no data"). The fix (NOMAD pull request 1423) raises it to 10 minutes and comes with the next NOMAD release. Until then, the workaround is to raise it in the running admin container and restart it:

```bash
sudo docker exec nomad_admin sed -i 's/^const DRY_RUN_TIMEOUT_MS = 60_000;$/const DRY_RUN_TIMEOUT_MS = 600_000;/' /app/app/services/map_service.js && sudo docker restart nomad_admin
```

The change goes away when NOMAD updates.

## How places are matched and ranked

A Protomaps map names each place's kind by its OpenStreetMap tag value (`shop=hardware` is `hardware`, `amenity=pharmacy` is `pharmacy`), so the `osm` tags each building type lists in `data/buildings/` are all the matching needs. Points (shops, amenities, street lamps), areas (industrial land, school grounds, landfills) and building outlines that say what they are (apartments, warehouses) all count; areas are placed at their middle.

For a search, each place takes its building type's score from the search's "where to look" ranking (0 to 100), lowered with distance (half at 1.5 km). To keep the list useful, it shows a few places of each building type, one area or outline each (the nearest residential area stands for houses all around), a named place rather than the grounds around it, and the nearest three of each kind of street fixture, with the rest counted. With no search, it lists every matching place, nearest first. A search the guide can't place shows everything near and says so.

**Further out.** Searches reach 50 km. Within 3 km the hub reads the map's most detailed tiles (every shop); beyond, rings of less detailed tiles (zoom 14 to 10 km, 13 to 25 km, 12 to 50 km) that still hold the big places: schools, industrial areas, hospitals, malls, farms, campgrounds, airports. The distance penalty widens with the search (half at a third of its reach), and a wide search keeps part of its list for each distance band, counting building types per band, so a dense town centre can't crowd out the places a run out of town is planned around.

A search that names a device rather than a part ("hair dryer") ranks building types by how likely that device is to be in them.

## Marking places, markers, runs and the shopping list

Under the map, one panel shows at a time: **Places** (the ranked list), **Run** (the run you're planning), **List** (your shopping list) and **Pins** (your markers), each with a count. On a wide screen the map stays in view on the left with the panels beside it. The same list, runs and markers are in **Plan**, with your stash and field notes.

- **Marking a place.** Tap a place and say how it stands: looted, partly looted, untouched, dangerous or occupied. That is a field note (shared as you choose: only you, peers or the hub), and the pin shows it: grey with an X when looted, red with a ! when dangerous or occupied, ringed amber when partly looted, green when untouched. Field notes within 60 m show with a place, and places noted as cleared drop down the list.
- **Your markers.** Home base, stash points, rally points, water, shelter, danger or a plain marker, with a name and notes. They stay on the device: never synced or shared, only in your backup.
- **Runs.** A plan for a trip to several places: each stop records when, how (the way in, tools, who goes) and what to get, and the run its mode (on foot, with a cart, by bike or vehicle), timing and plan. The map draws the route from your location (or home base) and back, with its length and time; distances are straight lines plus a third for streets, as there is no road routing yet. "Best order" puts the stops nearest-first.
- **The shopping list.** The part types you need and how many. "Plan a run for my list" asks the hub for the best places for every part at once (`/api/v1/places?parts=`), counts a place as covering a part only if it is nearly the best source for it (80% of the top score), picks the fewest stops that cover the list, and makes a run with each stop's parts as what to get. People's homes are left out of list runs. Ticking a part off puts it in your stash.

Markers, runs and the shopping list stay on the device and go in your backup file.

## Your location

Set it with **Use my location** (browsers share it only over https or on the device itself) or by tapping the map. It is rounded to about 10 m, stays on the device, and is sent only to the hub you're connected to, to look places up.

## For developers

| | |
|---|---|
| `GET /api/v1/map` | Which maps the hub has: name, zoom range, bounds |
| `GET /api/v1/map/tiles/{z}/{x}/{y}` | A light tile to draw (water, green and built-up areas, roads, buildings from zoom 14, place names), 512 units a side |
| `GET /api/v1/places?lat=&lon=&km=&q=` | Places near a point, ranked for a search; also `months`, `tools`, `kg`, `limit`; `km` up to 50 |
| `GET /api/v1/places?lat=&lon=&km=&parts=a,b,c&per=5` | The best few places for each part type on a list |

`server/pmtiles.js` reads the archive, `server/mvt.js` decodes vector tiles and `server/map.js` matches, ranks and draws; the app's side is `app/src/map.js`. The hub caches the places it found per tile (only kinds a building type matches) and the drawn tiles. A 50 km search reads a few hundred tiles and takes under a second the first time.

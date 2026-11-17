# What's new

Plain notes for people using the guide. The app shows the latest few under "What's new" on its front page. Details for developers are in the commits.

## 4.0.1 (16 November 2026)

- Simple mode on a narrow phone: the Full app button and the sync status sit under the title instead of being cut off.

## 4.0.0 (16 November 2026)

- First public release. The code is under the MIT License and the data under CC BY-SA 4.0.
- Board pinouts: 26 boards drawn pin by pin, 13 popular ones and 13 Chinese clones and knock-offs, with the boot, strapping, input-only and power pins marked and every header order checked against its maker's documents.
- Microcontrollers cheat sheet: which board you have, what voltage its pins take, which USB chip and driver it needs, how to force each family into its bootloader, the faults that stop boards booting, clone boards, and reflashing ESP smart plugs and bulbs with Tasmota or ESPHome.
- Microcontroller code templates in Arduino C++ and MicroPython: blink and serial, a debounced button, battery voltage, a low-voltage disconnect, a thermostat relay that fails safe, PWM through a MOSFET, an I2C scanner and ESP32 deep sleep.
- LoRa frequencies by country: the band, power limit and duty cycle in 211 countries and territories, with the matching Meshtastic region.
- Two new guides: build a LoRa mesh node from parts, and a LoRa mesh that carries text messages across a whole town with no phone network, internet or grid.
- On a NOMAD box, sources on sites that an installed Kiwix library copies get an offline link to that copy.
- Six more libraries linked: the Arduino, Raspberry Pi and Robotics Q&A sites, the OpenWrt wiki, and the C++ and Python references.
- Shop chemicals: making lye from wood ash.
- Fixed: the run and shopping list buttons on Plan, such as Delete this run, did nothing after visiting the map. The battery card now gives 12.2 V as half charge, matching its own table.

## 3.11.0 (13 November 2026)

- Calculators in the quick reference: Ohm’s law, LED resistor, voltage divider, series and parallel, RC and 555 timers, battery runtime, solar sizing, voltage drop, unit conversion, gears and pulleys, a resistor colour code reader both ways, and an engineering calculator that understands 4k7, 100n and parallel resistors (||).
- 14 new cheat sheets, grouped by topic: first aid, sanitation, food safety, fire and heat, shop chemicals, fasteners and threads, building materials, welding and cutting, knots and lifting, vehicles, shop math, radio and signals, finding your way, and weather. 26 in all, each checked against its sources.
- When no help is coming: first aid, fire, weather, vehicles, sanitation, welding and chemicals say what to do when there is no 911, poison centre or fire crew: when to stop CPR, a tourniquet over hours, wounds and burns over days, rehydration, burial, a chimney fire, heat stroke and frostbite, fuel swallowed, arc eye. Hazard cards link to it.
- Shop chemicals: what the solvents, rust removers, acids, lyes, glues, threadlockers, desiccants and etchants in a garage or pool shed are for, how strong they are, what they ruin, what never to mix, pool chlorine for drinking water, and storage.
- Fixed: a link inside a hazard card left the card open over the page it opened.

## 3.10.0 (12 November 2026)

- Quick reference: warning labels and symbols drawn out (chemical pictograms, machine warning triangles, the diamonds on trucks and tanks, the fire diamond, electrical markings, IP ratings, laser classes, plastic codes), plus cards for component codes, wire colours, connectors and pinouts, what fits what, water filters, date codes and era rules, power draw and battery runtime, and units. A tab on wide screens; on a phone, a switch on the Guides page.
- Device pages show what a device is made of, and from 600,000 community repair records how often it gets fixed and what usually failed: the part to suspect in a dead one.
- 679 routers and access points from the OpenWrt hardware table, with each version's chips, memory, ports and power supply. Search a chip such as MT7621 to find the routers built on it.
- Research wave 3 is done: 130 more documented models since 3.9.0, every part linked to its source and fact-checked (dishwashers, washers, dryers, furnaces, water heaters, mowers, air compressors, chargers, TVs and more), 238 in all, covering every very common device.
- Guides say whether someone who does the work has reviewed them, and the dangerous ones are marked Experienced only.
- Measured weights for ten electronics devices, so the carry limit can judge them.
- About says what the project is, with a legend of what the marks mean and a plain disclaimer.
- Fixed: part numbers are no longer read as ratings, and searching a chip number finds the models that use it. “Sync now” during an automatic sync now sends what you just added.

## 3.9.0 (12 November 2026)

- A new layout built for phones: Find, Map, Plan, Guides and More, along the bottom of the screen where your thumb is.
- Plan keeps your own things together: shopping list, runs, stash, field notes and markers.
- Under the map, one panel at a time (Places, Run, List, Pins); on a wide screen the map sits beside them.
- Shorter search results: filters fold into one line, where to look comes first, and the top six devices show with the rest a tap away.
- Device pages start with what to do: the teardown guide, “Stripped one” and “Log a model”. Tables read as cards on a phone.
- 34 new teardown guides, from fire extinguishers and copiers to escalators and EVs (the 12 V side only). Nearly every device now has one.
- Ten more documented models: mini fridges, bicycles and office desktops, 108 in all.

## 3.8.0 (12 November 2026)

- Plan runs: a trip to several places, with when, how and what to get at each stop, drawn on the map with its distance and time, put in a sensible order and ticked off as you go.
- A shopping list of the parts you need, and "Plan a run for my list": the fewest stops that get them.
- Mark a place looted, partly looted, untouched, dangerous or occupied with one tap on the map; looted places get an X.
- Searches reach 50 km, for planning runs out of town.

## 3.7.0 (12 November 2026)

- Your own map markers: home base, stash points, rally points, water, shelter, danger. They stay on your device and are never shared.
- The map finds far more places: clothing and gift shops, salons, pubs, bakeries, ATMs, jewellers, opticians, liquor and cannabis stores, post offices, thrift and pawn shops, tradespeople and EV chargers. Two new building types: hair salons and spas, and small shops.
- Searching for a device ("hair dryer", "sewing machine") shows where it is found on the map.

## 3.6.1 (12 November 2026)

- The map pans smoothly, has no pale stripes along tile edges, and shows place names in English.
- With no location set, the map finds places around its middle once you zoom in on a town.

## 3.6.0 (12 November 2026)

- A map: the Map tab shows where to look for what you need, near you. Places on the offline map (shops, schools, hospitals, industrial areas, street lamps) are matched to building types and ranked for your search and by distance, with your field notes on the map too.
- On Project NOMAD it uses NOMAD's own maps; download your region at zoom 15 for shops and buildings.
- Fixed: the page no longer jumps back to the top every so often.

## 3.5.0 (12 November 2026)

- Vote on what you find: "Found it" or "Not in mine" on a device's parts, "Helpful" on comments, "Still true" or "Not anymore" on field notes. When three people have found a part, a generic guess counts as likely.
- Logged models are easier to read: a short note at the top, and the research log folded away under "How this was researched".
- This list, and a line for announcements from the hub you sync with.
- Fixed: parts confirmed in real models ranked a little below unchecked guesses.

## 3.4.0 (12 November 2026)

- The tech tree is gone. Guides show plain "Learn first" and "Leads to" links instead.
- Confidence shows as one to four bars on every part, and each device shows how much of it real models have confirmed.

## 3.3.0 (12 November 2026)

- Search by brand ("vevor", "ryobi"), product name ("AirSense 10", "macbook battery") and everyday names ("cpap", "tv", "dewalt drill").
- Every device lists the brands that commonly make it.
- Devices are labelled Generic: what most units of that kind contain.
- Months since collapse now changes results gradually and flags parts looters have probably taken.
- A list of offline libraries worth installing alongside the guide (docs/LIBRARIES.md).

## 3.2.1 (12 November 2026)

- Two-way radios and CPAP machines: 9 more documented models, 98 in all.
- The first release signed with the project's key, so apps can trust updates.

## 3.2.0 (12 November 2026)

- Security fixes, ratings in search ("12v motor" finds 12 V motors), search by chip and model number, every hazard card reviewed, and 38 more documented models.

## 3.1.0 (12 November 2026)

- The first real-world data: 51 documented models, every part tied to a public source.

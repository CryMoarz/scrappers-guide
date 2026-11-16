# The Scrapper’s Digital Guide to the Apocalypse

## The picture

You’re a scrapper keeping a caravan moving. Something breaks: a pump, a charge controller, a motor driver. You need a part, there’s no store, and there’s no internet. You boot up your cyberdeck, open an offline toolkit like Project NOMAD, and hit the scrap button.

You type what you need. Maybe it’s a part number like LM2596, maybe a spec like “12V motor,” maybe just a job like “pump water from the creek.” The guide tells you three things:

1. Which consumer and commercial goods contain that part, ranked by how easy it is to get out.
2. Which kinds of buildings are most likely to have those goods, and how much is probably still there.
3. A map from where you’re standing to the best candidates, ideally as a loop that hits several in one run.

That is the whole product. Everything else exists to make those three answers accurate.

## The core idea: hidden low-hanging fruit

Anyone can find a hardware store. Everyone else found it too, and it was emptied first. The guide’s edge is knowing where useful things hide inside objects people don’t recognize as valuable, in places people don’t think to look.

Lithium cells inside disposable vapes. Battery banks in cell-tower huts. Deep-cycle batteries under the seat of a floor scrubber. A 2 hp DC motor in a treadmill that makes an excellent wind generator. A laser diode, a stepper motor, and neodymium magnets inside every dead DVD drive in a recycling bin. Linear actuators in power recliners. A magnesium fire starter in every water heater.

The ideal target is all three at once: **useful, easy to get, and overlooked.** Valuable but obvious gets looted. Obscure but hard to extract isn’t low-hanging fruit. The ranking is built to find the overlap.

## Principles

**Function over part number.** After a collapse you rarely need that exact part. You need something that does the job. The guide thinks in part types and substitutes, and it can suggest a way around a scarce part instead of only hunting for it. Ask for a drill battery and a good answer includes corded drills, which nobody hoards, plus a way to power them.

**Looters take products, not parts.** People strip food, medicine, fuel, batteries, and anything that stores or makes power. Nobody carries off thirty drills, a commercial dishwasher, or an elevator controller. Looting is modeled per item category and as demand saturation, not as a building being simply “looted” or “not.” Things that store power stay scarce; the devices around them stay abundant.

**Categories first, models later.** You don’t need to know what’s in one specific microwave to know that nearly every microwave has a high-voltage transformer, magnetron magnets, a fan, and a turntable motor. A few hundred category templates cover most of the stuff in the world. Specific models refine those templates over time; they aren’t a prerequisite for usefulness.

**Build once, share everywhere.** Components live on shared boards. A mains power supply board looks much the same in a TV, a printer, and a fire panel, so its parts are described once and inherited by every device that uses it.

**Honest about confidence.** Every part link says whether it’s a generic guess, documented from a source, likely, or verified by someone who opened the thing. The guide never presents a guess as a fact, and verified data gradually corrects the templates.

**Offline first, always.** A guide to the end of the world that needs the internet is a joke. Everything must run on local hardware with local data: the database, the maps, the population snapshot, and the routing.

**Safety is part of the knowledge.** Microwave capacitors, CRTs, damaged lithium cells, refrigerant, garage door springs, and EV traction packs can kill or maim. Hazards are first-class data, shown with every result. A guide that gets someone hurt has failed.

## What makes it hard to copy

OpenStreetMap, population datasets, and routing engines are available to anyone. The scarce asset is the mapping from part types to the devices they hide in, with honest difficulty and obscurity ratings, verified by people who actually took things apart. That knowledge comes from decades of hands-on scrapping, repair, and teardown, and it compounds with every device logged.

## What it should become

**Stage 1: the database (done, in prototype).** Part types, shared boards, device templates with era variants, building types with map tags, confidence levels, a scrap search, a hidden-fruit ranking, and fast model logging. Runs as a single offline web page.

**Stage 1.5: the community system (done, version 3).** One file per record, one schema, fill-in forms, signed contributions with no accounts, moderation, a hub and mirroring nodes that sync whenever they can, file bundles for when there’s no network, comments, field notes, jobs, guides and blueprints, “what can I build”, an AI tool server, a LoRa bridge, and exports down to plain text for microcontrollers. See ARCHITECTURE.md.

**Stage 2: the map layer (first version done, 3.6).** Read an offline OpenStreetMap extract, match buildings to building types by tag, rank candidates by distance from the user’s position, and adjust looting estimates with a local population snapshot. Add roadside and work-zone features where useful (solar signs, telecom sites).

**Stage 3: routing and field memory.** Offline routing that plans a loop through the best candidates. Let users mark sites as cleared, partly looted, untouched, or dangerous, and let those observations update estimates for similar sites nearby. Sync observations between devices when caravans meet.

**Stage 4: NOMAD integration.** Package the app as a small container that installs alongside Project NOMAD’s other offline tools, and expose the database in a form NOMAD’s local AI can use. (The container, MCP and OpenAPI endpoints and text export exist; what’s left is working with the NOMAD community to make it a one-click install.) The AI handles the fuzzy front end (“I need to pump water from the creek”), while ranking and mapping stay deterministic so nothing is hallucinated.

**Stage 5: the reverse direction.** A build mode: here’s what I have, what can I make? Teardown cards with photos of where each part sits and the tools to get it out. Printable field-guide editions for when the batteries die.

**Ongoing: grow the data.** Mine public sources like FCC and ISED equipment filings (which often include internal board photos), teardown sites, and parts lists. Use photo recognition to read component markings. Accept community submissions, with verified hands-on data as the trusted core.

## What it is not

It is not a parts marketplace, and it doesn’t need to make money. It is not a guide to taking things from people; it’s a guide to finding value in what has been abandoned and overlooked. And it is not finished. It’s a database meant to grow for years, built so that every device anyone opens makes it a little more right.

# Contributing

This guide only gets better because people who take things apart write down what they find. Every logged model turns a guess into a fact.

## Four ways in

1. **In the app.** Open it, make a contributor key in Sync (under More on a phone), then:
   - **Log a model** (Contribute tab) after opening a real device. This is the most valuable thing you can do.
   - **Suggest an edit** on any device, part type, building, job, hazard or guide.
   - **Add something new** with the forms in Contribute.
   - **Comment** on a record with tips, corrections or questions.
   - **Field notes** about places (tap a place on the Map, or Plan › Field notes): untouched, partly looted, cleared, dangerous.

   Shared changes apply on your device straight away and go to a hub for review the next time you’re online. No hub? Export a bundle file in Sync and hand it to someone who has one.
2. **Through a hub’s API** if you’re writing a tool. See [docs/API.md](docs/API.md).
3. **With an AI assistant** connected over MCP. Its proposals are labelled as AI-written and always wait for a human moderator. See [docs/AI-TOOLS.md](docs/AI-TOOLS.md).
4. **With git**, if you know it: edit files in `data/`, run the checks, open a pull request. See [docs/GIT-BASICS.md](docs/GIT-BASICS.md) if you’d like to learn.

## Review a guide for work you know

The guides were written with an AI model from general knowledge and checked for consistency, but nobody who does the work has reviewed them yet. If you have stripped escalators, serviced CO2 lasers, worked on EVs, recovered refrigerant, built MOT welders or done any trade a guide touches, read that guide and use **Suggest an edit** to fix what's wrong, or **Comment** to say what you'd change. Say what experience you're drawing on, so reviewers can weigh it. The riskiest guides (above 400 V, pressure vessels, heavy machinery, vehicles) matter most.

## The rules

Read [docs/DATA-GUIDE.md](docs/DATA-GUIDE.md). The short version:

- **Be honest.** Mark only what you’ve seen as verified. Use ranges when you’re not sure. Never invent model numbers, brands or measurements.
- **Safety is data.** If it can hurt someone, say so in the spec and list the hazard.
- **Your own words.** Don’t paste from manuals, websites or books. Credit sources in `sources`.
- **Nothing for hurting people.** No weapons, explosives, injurious traps, drug synthesis, or anything about taking things from people. This is a guide to the abandoned and overlooked.
- **Ids are forever.** Retire records with `deprecated`, don’t rename them.

## Checks before you send (git route)

Requires Node 20 or newer and nothing else.

```bash
node tools/fmt.js           # standard layout for data files
node tools/validate.js --warn
node --test test/*.test.js
node tools/build.js          # optional: try the app with your change
```

Don't commit `app/scrappers-guide.html` or `app/app-build.json` after a build: the committed app is the last release's, signed by a maintainer, and the checks fail if it's replaced by an unsigned one (`git checkout app/` puts it back). The maintainer rebuilds and signs it at release.

## Reviewing

Moderators review in the app’s Review tab, or with `node tools/mod.js`. Look for: honest confidence, units, safety warnings in the right place, original words, no invented specifics, and ids that follow the pattern. Accept what’s right, reject with a kind note explaining what to fix. Stale proposals (the record changed since) need a fresh look before accepting.

## Code

- Zero dependencies. If you need a library, write the small part you need.
- `core/` must run in both browsers and Node.
- Everything must work offline; network features degrade quietly.
- Match the surrounding style. Run `node --test test/*.test.js` before sending.

## Licenses

By contributing you agree your contributions are licensed under the project’s licenses: code under MIT ([LICENSE](LICENSE)), data and guides under CC BY-SA 4.0 ([DATA-LICENSE.md](DATA-LICENSE.md)).

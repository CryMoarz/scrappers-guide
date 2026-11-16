# Security

The Scrapper’s Guide is meant to be trusted offline, so two kinds of problem matter most:

- **Software**: anything that lets someone run code in the app, forge or alter signed data, take over a hub or node, crash one, or read what they shouldn’t (a contributor’s key, peers-only field notes).
- **Safety**: a hazard card, first-aid step or guide that could hurt someone who follows it.

## Reporting a software problem

Please report it privately, not in a public issue: use **Security → Report a vulnerability** on the GitHub repository (private vulnerability reporting). Say what you found, how to reproduce it, and what it lets someone do. You’ll get an answer within a week, and credit in the fix unless you’d rather not.

## Reporting a safety problem

Open an issue with the **Something is wrong** form and tick the safety box. These are fixed before anything else and don’t need to be private: the sooner other people know, the better.

## What’s in scope

The app (`app/`), the hub and node (`server/`), the shared core (`core/`), the AI tool server (`mcp/`), the LoRa bridge, the Docker image and the release and signing tools (`tools/`). The trust model is described in [ARCHITECTURE.md](ARCHITECTURE.md): contributions are signed by their authors, hubs moderate, releases and app updates are signed by maintainer keys listed in `trust/keys.json`, and nodes and apps check those signatures rather than trusting the connection they came over.

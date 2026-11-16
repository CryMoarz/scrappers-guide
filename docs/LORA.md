# LoRa mesh

When the internet, the phone network and the power grid are all gone, a LoRa mesh still works: cheap radios relaying short text messages for kilometres, on batteries and a small solar panel. The guide can sit on that mesh.

## What it does

LoRa is slow and its airtime is shared by everyone on the channel, so the bridge only does what fits:

- **A text bot.** Anyone with a radio (a Meshtastic phone app, a handheld with a keyboard) messages the node and gets an answer from its local database:

  | Send | Get back |
  |---|---|
  | `?scrap 12v motor` | The three best devices to strip, where to look, and the main hazard |
  | `?inside treadmill` | What’s in it, time, tools and hazards |
  | `?safe microwave` | Its hazards and the first thing to do about the worst one |
  | `?job keep food cold` | The approach |
  | `?guide wind generator` | Matching guides with their ids |
  | `?step build_treadmill_wind_generator 3` | One step of a guide at a time, with its warning |
  | `?seen cleared pharmacy` | Logs a field note at your radio’s last shared position |
  | `?status` | This node’s data version and the other nodes it has heard |
  | `?help` | The list |

  Replies go straight to whoever asked, not to the whole channel. Each person gets six questions per ten minutes so nobody hogs the air.
- **Announcements.** Every hour each node says who it is and which data version it has. `?status` and the hub’s `/api/v1/info` show the nodes heard, and which have newer data, so you know which box is worth syncing with when you get close.
- **Field notes between camps.** Notes shared with peers or the public are compressed, split into a few chunks and sent; other nodes reassemble them and take them exactly as they would over the network: signature, schema, bans, work stamps for newcomers, and a note already held is never replaced by someone else’s. (A node keeps notes shared with peers; a hub keeps only public ones.) A note is usually 2 to 4 messages. Notes made with the bot’s `?seen` are signed by the node and carry its work stamp. Reassembly is bounded (32 messages at a time, 12 chunks each, 16 KB unpacked, 10 minutes to complete), as are the radios and nodes remembered.

Machine messages go on Meshtastic’s private-app port, so they don’t clutter anyone’s chat. Full data syncs never go over LoRa: they wait for Wi-Fi, a cable or a USB stick.

## Hardware

| Link | For | Setting |
|---|---|---|
| `meshtastic-tcp` | A Meshtastic radio with Wi-Fi or Ethernet, or `meshtasticd` on a Linux board with a LoRa HAT | `--lora-host 192.168.1.50` (port 4403) |
| `meshtastic-serial` | A Meshtastic radio on USB | `--lora-device /dev/ttyUSB0` (or `/dev/ttyACM0`) |
| `uart` | A plain LoRa module in transparent mode (E22, E32, RYLR998 and similar) | `--lora-device /dev/ttyUSB0`, baud in the config |
| `udp` | No radio: every process on this machine hears every message. For testing. | none; `"udpInterface": "192.168.1.20"` (or `0.0.0.0`) in the `lora` config to reach the LAN |

Serial links use Linux’s `stty`, so they work on Linux (Raspberry Pi, cyberdecks), not Windows. Add your user to the `dialout` group to open serial ports without root.

## Running it

Check the radio first:

```bash
node tools/lora.js listen meshtastic-tcp 192.168.1.50
```

Then run a node with the bridge:

```bash
node server/hub.js --mode node --upstream https://hub.example.org --public --lora meshtastic-tcp --lora-host 192.168.1.50
```

Or in a config file:

```json
{
  "mode": "node",
  "lora": { "enabled": true, "link": "meshtastic-serial", "device": "/dev/ttyUSB0", "announceMinutes": 60, "maxPerMinute": 6 }
}
```

Environment variables work too: `SDG_LORA=meshtastic-tcp SDG_LORA_HOST=192.168.1.50`.

## Being a good neighbour on the air

- `maxPerMinute` (default 6) caps everything the node sends. Bot replies jump the queue; field notes and announcements wait.
- Long replies are cut to at most three messages.
- Items bigger than 12 chunks are never sent over LoRa.
- Follow your region’s rules for the band (duty cycle limits in Europe, for example).

## Honest status

The bot, chunking, signature checks and the Meshtastic wire format are covered by the tests, and the bot has been run end to end over UDP. It has not yet been run against a real Meshtastic radio. If a radio doesn’t respond, run `tools/lora.js listen` and report what it prints.

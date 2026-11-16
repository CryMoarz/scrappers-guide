// Check a LoRa radio before running a hub on it.
//   node tools/lora.js listen meshtastic-tcp 192.168.1.50      print everything heard
//   node tools/lora.js listen meshtastic-serial /dev/ttyUSB0
//   node tools/lora.js listen uart /dev/ttyUSB0 9600
//   node tools/lora.js send meshtastic-tcp 192.168.1.50 "hello mesh"
// Then run the bridge with the hub: node server/hub.js --mode node --lora meshtastic-tcp --lora-host 192.168.1.50
const { createLink } = require('../server/lora-links');

const [cmd, link, where, ...rest] = process.argv.slice(2);
if (!cmd || !link) {
  console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(1, 7).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}
const opts = { link };
if (link === 'meshtastic-tcp') opts.host = where || '127.0.0.1';
else if (link === 'udp') { opts.udpPort = +where || 47878; if (rest[0]) opts.udpInterface = rest[0]; } // this machine only, unless given an interface address
else { opts.device = where || '/dev/ttyUSB0'; if (link === 'uart' && rest[0] && /^\d+$/.test(rest[0])) opts.baud = +rest.shift(); }

const l = createLink(opts);
l.on('status', s => console.log(`[${link}] ${s}`));
l.on('text', m => console.log(`${new Date().toISOString().slice(11, 19)} from ${m.from == null ? '?' : '!' + (m.from >>> 0).toString(16)} port ${m.port}: ${m.text}`));
l.on('position', p => console.log(`${new Date().toISOString().slice(11, 19)} position from !${(p.from >>> 0).toString(16)}: ${p.lat}, ${p.lon}`));
if (cmd === 'send') {
  const text = rest.join(' ') || 'Scrapper’s Guide test';
  const trySend = n => { if (l.send(text)) { console.log('sent'); setTimeout(() => process.exit(0), 1500); } else if (n > 0) setTimeout(() => trySend(n - 1), 1000); else { console.log('could not send: link not up'); process.exit(1); } };
  trySend(15);
}

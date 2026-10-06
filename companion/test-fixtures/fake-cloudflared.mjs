// A stand-in for cloudflared used by companion/test.mjs. It never touches the network.
// It is started through a small shell wrapper that sets:
//   FAKE_CF_RECORD     file to append one JSON line per run (argv, pid, HOME, Cloudflare variables it was given)
//   FAKE_CF_MODE_FILE  optional file holding the mode for this run:
//     ok          (default) print a quick-tunnel banner and "Registered tunnel connection", then stay alive
//     crash       like ok, then exit with code 1 after 300 ms
//     crash-once  like crash, but first delete the mode file (so the next run is "ok")
//     fail        print an error and exit with code 1 at once
//     silent      stay alive without ever connecting
//   FAKE_CF_VERSION    version to print for --version (default 2099.1.0)

import fs from 'node:fs';

const argv = process.argv.slice(2);
const version = process.env.FAKE_CF_VERSION || '2099.1.0';
if (argv.includes('--version') || argv[0] === 'version') {
  process.stdout.write(`cloudflared version ${version} (built 2099-01-01-0000 UTC)\n`);
  process.exit(0);
}

const modeFile = process.env.FAKE_CF_MODE_FILE;
let mode = 'ok';
try {
  mode = fs.readFileSync(modeFile, 'utf8').trim() || 'ok';
} catch {}
if (mode === 'crash-once') {
  try {
    fs.unlinkSync(modeFile);
  } catch {}
  mode = 'crash';
}

const cfVars = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(TUNNEL_|CLOUDFLARED_|CF_|NO_AUTOUPDATE)/.test(k)));
if (process.env.FAKE_CF_RECORD) {
  fs.appendFileSync(process.env.FAKE_CF_RECORD, `${JSON.stringify({ pid: process.pid, argv, home: process.env.HOME, cwd: process.cwd(), cfVars, mode })}\n`);
}

const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const log = (level, msg) => process.stderr.write(`${ts()} ${level} ${msg}\n`);
const named = argv.includes('run');

log('INF', 'Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment.');
if (mode === 'fail') {
  log('ERR', 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host');
  process.exit(1);
}
// A line with the API address must not be taken for the tunnel's address.
log('INF', 'Requesting new quick Tunnel on trycloudflare.com... (https://api.trycloudflare.com/tunnel)');
if (mode !== 'silent') {
  setTimeout(() => {
    if (!named) {
      log('INF', '+--------------------------------------------------------------------------------------------+');
      log('INF', '|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |');
      log('INF', `|  https://fake-words-${process.pid}.trycloudflare.com                                            |`);
      log('INF', '+--------------------------------------------------------------------------------------------+');
    }
    log('INF', 'Starting metrics server on 127.0.0.1:53123/metrics');
    setTimeout(() => log('INF', `Registered tunnel connection connIndex=0 connection=00000000-0000-0000-0000-${String(process.pid).padStart(12, '0')} event=0 ip=198.41.200.13 location=fake protocol=quic`), 100);
  }, 150);
}
if (mode === 'crash') {
  setTimeout(() => {
    log('ERR', 'fake cloudflared: crashing on purpose');
    process.exit(1);
  }, 600);
}
process.on('SIGTERM', () => {
  log('INF', 'Initiating graceful shutdown due to signal terminated ...');
  process.exit(0);
});
setInterval(() => {}, 1 << 30);

// Tests for agent-companion.mjs. Run: node --test companion/
// Every companion under test gets its own temp folder (used both as --home and as $HOME, so `~` and
// the shell's startup files stay inside it) and a random free port. Nothing outside os.tmpdir() is touched.
// By default no companion under test can download cloudflared, find a real cloudflared or use a real desktop
// helper program (see SAFE_ENV): tunnels use a fake cloudflared, desktop tools use stand-in helper programs.
// Opt-in extras: COMPANION_TEST_CLIPBOARD=1 (uses the real clipboard, saved and restored),
// MCP_SDK_DIR=<path to @modelcontextprotocol/sdk> (interop check with the official MCP client),
// COMPANION_TEST_TUNNEL=1 (a real quick tunnel through the installed cloudflared, stopped afterwards),
// COMPANION_TEST_DOWNLOAD=1 (downloads the real cloudflared into a temp folder, which is deleted afterwards),
// COMPANION_TEST_DESKTOP=1 (macOS: runs list_apps, list_windows and desktop_screenshot for real; nothing is typed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'agent-companion.mjs');
const FIXTURE = path.join(HERE, 'test-fixtures', 'fixture-server.mjs');
const FAKE_CF = path.join(HERE, 'test-fixtures', 'fake-cloudflared.mjs');
const FAKE_HELPER = path.join(HERE, 'test-fixtures', 'fake-helper.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-companion-test-'));
const EMPTY_BIN = path.join(ROOT, 'empty-bin');
fs.mkdirSync(EMPTY_BIN);
const SAFE_ENV = {
  AGENT_COMPANION_CLOUDFLARED_URL: 'http://127.0.0.1:9/no-downloads-in-tests',
  AGENT_COMPANION_CLOUDFLARED_PATH: EMPTY_BIN,
  AGENT_COMPANION_DESKTOP_PATH: EMPTY_BIN,
};
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const children = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Last-resort cleanup if the test process dies: companions stop their own children on SIGTERM.
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {}
  }
});

after(async () => {
  await Promise.all([...children].map((c) => stopChild(c)));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

let seq = 0;
function tmpDir(name = 'd') {
  const d = path.join(ROOT, `${name}-${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function userHome() {
  const home = tmpDir('home');
  // An empty rc file keeps the shell's PATH lookup fast and quiet.
  fs.writeFileSync(path.join(home, '.zshrc'), '');
  fs.writeFileSync(path.join(home, '.bashrc'), '');
  return home;
}

const childEnv = (home, extra = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, AGENT_COMPANION_HOME: '', ...SAFE_ENV, ...extra });

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([gone, sleep(6000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function startCompanion({ config, args = [], env = {}, state, home } = {}) {
  const dir = tmpDir('companion');
  state ??= path.join(dir, 'state');
  home ??= userHome();
  if (config !== undefined) {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'companion.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  const child = spawn(process.execPath, [SCRIPT, '--home', state, '--port', '0', ...args], { env: childEnv(home, env), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-500000)));
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-500000)));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  exited.then(() => children.delete(child));
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`companion did not start:\n${stdout}\n${stderr}`)), 20000);
    const check = () => {
      const m = /URL\s+(http:\/\/\S+)/.exec(stdout);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', check);
    exited.then(({ code }) => {
      clearTimeout(t);
      reject(new Error(`companion exited with ${code}:\n${stderr}`));
    });
  });
  const token = JSON.parse(fs.readFileSync(path.join(state, 'companion.json'), 'utf8')).token;
  return { url, port: Number(new URL(url).port), token, state, home, child, exited, out: () => stdout, err: () => stderr, stop: () => stopChild(child) };
}

// Raw HTTP so tests control every header (Host, Origin…).
function request(c, method, p, { body, headers = {}, auth = true, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (auth) h.authorization = `Bearer ${auth === true ? c.token : auth}`;
    let data = body;
    if (data !== undefined && typeof data !== 'string' && !Buffer.isBuffer(data)) {
      data = JSON.stringify(data);
      h['content-type'] ??= 'application/json';
    }
    if (data !== undefined) h['content-length'] ??= Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: c.port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    onRequest?.(req);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

let rid = 0;
async function rpc(c, method, params) {
  const r = await request(c, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: ++rid, method, ...(params !== undefined && { params }) } });
  assert.equal(r.status, 200, r.text);
  if (r.json.error) throw Object.assign(new Error(r.json.error.message), { code: r.json.error.code });
  return r.json.result;
}

async function call(c, name, args = {}) {
  const r = await rpc(c, 'tools/call', { name, arguments: args });
  return { ...r, text: (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n') };
}

async function status(c) {
  const r = await request(c, 'GET', '/status');
  assert.equal(r.status, 200, r.text);
  return r.json;
}

async function waitUntil(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const serverEntry = async (c, name) => (await status(c)).servers.find((s) => s.name === name);

// ------------------------------------------------------------------ CLI and startup

describe('CLI and startup', () => {
  test('--version and --help', () => {
    const v = spawnSync(process.execPath, [SCRIPT, '--version'], { encoding: 'utf8' });
    assert.equal(v.status, 0);
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
    const h = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.equal(h.status, 0);
    for (const flag of ['--port', '--host', '--home', '--print-token', '--install-autostart', '--uninstall-autostart', '--dry-run']) assert.ok(h.stdout.includes(flag), flag);
    const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Unknown option/);
    const lone = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { encoding: 'utf8' });
    assert.notEqual(lone.status, 0);
  });

  test('first run creates a private config with a 32-byte hex token; --print-token shows it', async () => {
    const c = await startCompanion();
    try {
      assert.match(c.token, /^[0-9a-f]{64}$/);
      if (!IS_WIN) {
        assert.equal(fs.statSync(path.join(c.state, 'companion.json')).mode & 0o777, 0o600);
        assert.equal(fs.statSync(c.state).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(c.state, 'companion.log')).mode & 0o777, 0o600);
      }
      // The banner says where the token goes, but does not print it when stdout is not a terminal.
      assert.match(c.out(), /Settings → Computer tools/);
      assert.ok(!c.out().includes(c.token));
      const p = spawnSync(process.execPath, [SCRIPT, '--home', c.state, '--print-token'], { encoding: 'utf8', env: childEnv(c.home) });
      assert.equal(p.stdout.trim(), c.token);
    } finally {
      await c.stop();
    }
  });

  test('a malformed config falls back to defaults, keeps the token and the broken file', async () => {
    const token = 'a'.repeat(64);
    const c = await startCompanion({ config: `{ "token": "${token}", "allowShell": false, oops }` });
    try {
      assert.equal(c.token, token);
      await waitUntil(() => /not valid JSON/.test(c.err()), 3000, 'the warning');
      assert.ok(fs.readdirSync(c.state).some((f) => f.startsWith('companion.json.broken-')));
      const cfg = (await request(c, 'GET', '/config')).json;
      assert.equal(cfg.allowShell, true);
    } finally {
      await c.stop();
    }
  });

  test('invalid fields fall back one by one', async () => {
    const c = await startCompanion({
      config: { allowShell: 'yes', allowWrite: false, commandTimeoutSec: -5, mcpServers: { 'bad name!': { command: 'x' }, ok: { command: 'x', args: 'nope' } } },
    });
    try {
      const cfg = (await request(c, 'GET', '/config')).json;
      assert.deepEqual(cfg, {
        allowShell: true,
        allowWrite: false,
        commandTimeoutSec: 120,
        mcpServers: {},
        tunnel: { autostart: false, kind: 'quick', hasNamedToken: false, exposeLlm: true, exposeMcp: false, namedUrl: null },
        llmUpstreams: {},
        desktopTools: true,
      });
      await waitUntil(() => /allowShell/.test(c.err()) && /Skipping an MCP server/.test(c.err()), 3000, 'the warnings');
    } finally {
      await c.stop();
    }
  });

  test('a port that is in use gives a readable message suggesting --port', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const port = blocker.address().port;
    try {
      const home = userHome();
      const r = spawnSync(process.execPath, [SCRIPT, '--home', path.join(tmpDir(), 'state'), '--port', String(port)], { encoding: 'utf8', env: childEnv(home), timeout: 15000 });
      assert.equal(r.status, 3);
      assert.match(r.stderr, new RegExp(`Port ${port} is already in use`));
      assert.match(r.stderr, /--port/);
    } finally {
      blocker.close();
    }
  });

  test('--install-autostart --dry-run prints the plan and changes nothing', () => {
    const home = userHome();
    const state = path.join(tmpDir(), 'state');
    const r = spawnSync(process.execPath, [SCRIPT, '--install-autostart', '--dry-run', '--home', state, '--port', '9123'], { encoding: 'utf8', env: childEnv(home) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Dry run: nothing is changed/);
    assert.ok(r.stdout.includes(path.join(state, 'agent-companion.mjs')));
    assert.match(r.stdout, /9123/);
    if (IS_MAC) {
      assert.ok(r.stdout.includes(path.join(home, 'Library', 'LaunchAgents', 'com.agent-automation.companion.plist')));
      assert.match(r.stdout, /<key>ProgramArguments<\/key>/);
      assert.match(r.stdout, /launchctl bootstrap gui\/\d+/);
      // The program is this very Node binary (possibly through a stable symlink such as /opt/homebrew/bin/node).
      const node = /<array>\n\s*\| +<string>([^<]+)<\/string>/.exec(r.stdout)?.[1];
      assert.ok(node, r.stdout);
      assert.equal(fs.realpathSync(node), fs.realpathSync(process.execPath));
    } else if (!IS_WIN) {
      assert.match(r.stdout, /agent-companion\.service/);
      assert.match(r.stdout, /systemctl --user enable --now/);
    } else assert.match(r.stdout, /Startup/);
    // Nothing was written anywhere.
    assert.equal(fs.existsSync(state), false);
    assert.deepEqual(fs.readdirSync(home).sort(), ['.bashrc', '.zshrc']);

    const u = spawnSync(process.execPath, [SCRIPT, '--uninstall-autostart', '--dry-run', '--home', state], { encoding: 'utf8', env: childEnv(home) });
    assert.equal(u.status, 0, u.stderr);
    assert.match(u.stdout, /delete /);
    if (IS_MAC) assert.match(u.stdout, /launchctl bootout/);
    assert.equal(fs.existsSync(state), false);
  });
});

// ------------------------------------------------------------------ HTTP security

describe('HTTP security', () => {
  let c;
  before(async () => (c = await startCompanion()));
  after(() => c?.stop());

  test('/health needs no token and reveals only the contract fields', async () => {
    const r = await request(c, 'GET', '/health', { auth: false });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['name', 'ok', 'version']);
    assert.equal(r.json.name, 'agent-companion');
  });

  test('401 without a token, with a wrong token or another scheme', async () => {
    for (const auth of [false, 'wrong', `${c.token}x`]) {
      const r = await request(c, 'GET', '/status', { auth });
      assert.equal(r.status, 401);
      assert.ok(r.json.error);
    }
    const basic = await request(c, 'GET', '/status', { auth: false, headers: { authorization: `Basic ${c.token}` } });
    assert.equal(basic.status, 401);
    const mcp = await request(c, 'POST', '/mcp', { auth: false, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(mcp.status, 401);
    assert.equal((await request(c, 'GET', '/status')).status, 200);
  });

  test('web page origins get 403; the extension and the companion\'s own origin are allowed', async () => {
    const foreignPort = c.port === 3000 ? 3001 : 3000;
    const refused = ['https://evil.example', 'http://evil.example', 'null', 'http://127.0.0.1.evil.example', 'https://localhost', `https://localhost:${c.port}`, `http://localhost:${foreignPort}`, `http://127.0.0.1:${foreignPort}`, `http://[::1]:${foreignPort}`, 'http://localhost'];
    for (const origin of refused) {
      const r = await request(c, 'POST', '/mcp', { headers: { origin }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
      assert.equal(r.status, 403, origin);
    }
    const health = await request(c, 'GET', '/health', { auth: false, headers: { origin: 'https://evil.example' } });
    assert.equal(health.status, 403);
    for (const origin of ['chrome-extension://abc', `http://127.0.0.1:${c.port}`, `http://localhost:${c.port}`, `http://[::1]:${c.port}`]) {
      const r = await request(c, 'POST', '/mcp', { headers: { origin }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
      assert.equal(r.status, 200, origin);
    }
  });

  test('a non-loopback Host header is refused (DNS rebinding)', async () => {
    const r = await request(c, 'GET', '/status', { headers: { host: `evil.example:${c.port}` } });
    assert.equal(r.status, 403);
    const ok = await request(c, 'GET', '/status', { headers: { host: `localhost:${c.port}` } });
    assert.equal(ok.status, 200);
  });

  test('OPTIONS is refused and no CORS headers are ever sent', async () => {
    const pre = await request(c, 'OPTIONS', '/mcp', { auth: false, headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 403);
    const own = await request(c, 'OPTIONS', '/health', { auth: false, headers: { origin: 'chrome-extension://abc' } });
    assert.equal(own.status, 403);
    const responses = [pre, own, await request(c, 'GET', '/status'), await request(c, 'GET', '/health', { auth: false, headers: { origin: 'chrome-extension://abc' } })];
    for (const r of responses) assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')), JSON.stringify(r.headers));
  });

  test('unknown paths and wrong methods', async () => {
    assert.equal((await request(c, 'GET', '/nope')).status, 404);
    assert.equal((await request(c, 'GET', '/nope', { auth: false })).status, 401);
    assert.equal((await request(c, 'GET', '/mcp')).status, 405);
    assert.equal((await request(c, 'DELETE', '/config')).status, 405);
  });

  test('a malformed JSON body gets a JSON-RPC parse error', async () => {
    const r = await request(c, 'POST', '/mcp', { body: '{"jsonrpc": "2.0", "id": 1,', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, -32700);
    assert.equal((await request(c, 'GET', '/health', { auth: false })).status, 200);
  });

  test('bodies over 64 MB are refused with 413', async () => {
    // Declared too large: refused before reading anything.
    const declared = await request(c, 'POST', '/mcp', { body: '{}', headers: { 'content-length': String(65 * 1024 * 1024) } }).catch((e) => ({ error: e }));
    assert.equal(declared.status, 413, String(declared.error));
    // Streamed (chunked) past the limit.
    const streamed = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: c.port, method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', () => resolve('error'));
      const chunk = Buffer.alloc(1024 * 1024, 32);
      let sent = 0;
      const pump = () => {
        while (sent < 66) {
          sent++;
          if (!req.write(chunk)) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    assert.equal(streamed, 413);
    assert.equal((await request(c, 'GET', '/health', { auth: false })).status, 200);
  });
});

// ------------------------------------------------------------------ MCP protocol

describe('MCP protocol', () => {
  let c;
  before(async () => (c = await startCompanion()));
  after(() => c?.stop());

  test('initialize negotiates the protocol version', async () => {
    const r = await rpc(c, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.protocolVersion, '2025-06-18');
    assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
    assert.equal(r.serverInfo.name, 'agent-companion');
    const old = await rpc(c, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(old.protocolVersion, '2024-11-05');
    const unknown = await rpc(c, 'initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.match(unknown.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(unknown.protocolVersion, '1999-01-01');
  });

  test('notifications get 202 with an empty body; ping works; unknown methods get -32601', async () => {
    const n = await request(c, 'POST', '/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(n.status, 202);
    assert.equal(n.text, '');
    assert.deepEqual(await rpc(c, 'ping'), {});
    await assert.rejects(rpc(c, 'resources/list'), (e) => e.code === -32601);
    const bad = await request(c, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 5 } });
    assert.equal(bad.json.error.code, -32600);
  });

  test('tools/list has every built-in tool with a schema and read-only hints', async () => {
    const { tools } = await rpc(c, 'tools/list', {});
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['run_command', 'read_file', 'write_file', 'list_directory', 'find_files', 'open_path', 'clipboard_read', 'clipboard_write', 'system_info']) {
      assert.ok(byName[name], name);
      assert.equal(byName[name].inputSchema.type, 'object');
      assert.ok(byName[name].description.length > 20);
    }
    for (const name of ['read_file', 'list_directory', 'find_files', 'clipboard_read', 'system_info']) assert.equal(byName[name].annotations.readOnlyHint, true, name);
    for (const name of ['run_command', 'write_file', 'open_path', 'clipboard_write']) assert.equal(byName[name].annotations.readOnlyHint, false, name);
  });

  test('unknown tools are a JSON-RPC error; bad arguments are a tool error', async () => {
    await assert.rejects(call(c, 'no_such_tool'), (e) => e.code === -32602);
    const r = await call(c, 'run_command', {});
    assert.equal(r.isError, true);
    assert.match(r.text, /"command" is required/);
  });

  test('batches are answered as arrays', async () => {
    const r = await request(c, 'POST', '/mcp', {
      body: [
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'b', method: 'nope' },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 2);
    assert.deepEqual(r.json[0], { jsonrpc: '2.0', id: 'a', result: {} });
    assert.equal(r.json[1].error.code, -32601);
  });
});

// ------------------------------------------------------------------ built-in tools

describe('built-in tools', () => {
  let c;
  before(async () => (c = await startCompanion()));
  after(() => c?.stop());

  test('run_command: exit code, stdout and stderr', async () => {
    const r = await call(c, 'run_command', { command: 'echo out; echo err >&2; exit 3' });
    assert.ok(!r.isError);
    assert.match(r.text, /^Exit code: 3/);
    assert.match(r.text, /--- stdout ---\nout/);
    assert.match(r.text, /--- stderr ---\nerr/);
    const ok = await call(c, 'run_command', { command: 'true' });
    assert.equal(ok.text, 'Exit code: 0\n(no output)');
  });

  test('run_command: stdin, cwd, ~ and the default home folder', async () => {
    const r = await call(c, 'run_command', { command: 'tr a-z A-Z', stdin: 'hello stdin' });
    assert.match(r.text, /HELLO STDIN/);
    const dir = tmpDir('cwd');
    const inDir = await call(c, 'run_command', { command: 'pwd -P', cwd: dir });
    assert.ok(inDir.text.includes(fs.realpathSync(dir)), inDir.text);
    const tilde = await call(c, 'run_command', { command: 'pwd -P', cwd: '~' });
    assert.ok(tilde.text.includes(fs.realpathSync(c.home)), tilde.text);
    const dflt = await call(c, 'run_command', { command: 'pwd -P' });
    assert.ok(dflt.text.includes(fs.realpathSync(c.home)), dflt.text);
    const missing = await call(c, 'run_command', { command: 'pwd', cwd: '~/does/not/exist' });
    assert.equal(missing.isError, true);
    // Commands waiting for input get end-of-file instead of hanging.
    const cat = await call(c, 'run_command', { command: 'cat; echo done', timeout_sec: 10 });
    assert.match(cat.text, /done/);
  });

  test('run_command: long output keeps head and tail', async () => {
    const r = await call(c, 'run_command', { command: 'seq 1 30000' });
    const out = r.text.split('--- stdout ---\n')[1];
    assert.ok(out.startsWith('1\n2\n3\n'));
    assert.ok(out.trimEnd().endsWith('29999\n30000'));
    assert.match(out, /\[… \d+ chars omitted …\]/);
    assert.ok(out.length < 61000, String(out.length));
    // Several MB: the middle is dropped while reading, not buffered.
    const big = await call(c, 'run_command', { command: "head -c 3000000 /dev/zero | tr '\\0' x; echo; echo END" });
    const bigOut = big.text.split('--- stdout ---\n')[1];
    assert.ok(bigOut.trimEnd().endsWith('END'));
    assert.match(bigOut, /\[… \d+ chars omitted …\]/);
    assert.ok(bigOut.length < 61000);
  });

  test('run_command: a timeout kills the whole process tree', async () => {
    const pidFile = path.join(tmpDir('pid'), 'pid');
    const t0 = Date.now();
    const r = await call(c, 'run_command', { command: `sleep 30 & echo $! > '${pidFile}'; wait`, timeout_sec: 1 });
    assert.ok(Date.now() - t0 < 8000);
    assert.equal(r.isError, true);
    assert.match(r.text, /Timed out after 1 s/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    await waitUntil(() => !isAlive(pid), 5000, `sleep (pid ${pid}) to be killed`);
  });

  test('run_command: the command is killed when the client disconnects', async () => {
    const pidFile = path.join(tmpDir('pid'), 'pid');
    let req;
    const pending = request(c, 'POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'run_command', arguments: { command: `sleep 30 & echo $! > '${pidFile}'; wait` } } },
      onRequest: (r) => (req = r),
    }).catch(() => 'aborted');
    await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 10000, 'the command to start');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(isAlive(pid));
    req.destroy();
    assert.equal(await pending, 'aborted');
    await waitUntil(() => !isAlive(pid), 5000, `sleep (pid ${pid}) to be killed`);
    assert.equal((await request(c, 'GET', '/health', { auth: false })).status, 200);
  });

  test('read_file: text, ~ and relative paths, pagination', async () => {
    fs.writeFileSync(path.join(c.home, 'hello.txt'), 'hello world\n');
    assert.equal((await call(c, 'read_file', { path: '~/hello.txt' })).text, 'hello world\n');
    assert.equal((await call(c, 'read_file', { path: 'hello.txt' })).text, 'hello world\n');
    assert.equal((await call(c, 'read_file', { path: path.join(c.home, 'hello.txt') })).text, 'hello world\n');

    fs.writeFileSync(path.join(c.home, 'long.txt'), 'a'.repeat(10000) + 'b'.repeat(10000) + 'c'.repeat(5000));
    const p1 = await call(c, 'read_file', { path: '~/long.txt' });
    assert.ok(p1.text.startsWith('[Characters 0 to 10000 of 25000. To read on, call read_file with offset=10000.]\n'));
    assert.ok(p1.text.endsWith('a'.repeat(100)));
    const p3 = await call(c, 'read_file', { path: '~/long.txt', offset: 20000 });
    assert.ok(p3.text.startsWith('[Characters 20000 to 25000 of 25000. This is the end of the file.]\n'));
    assert.equal(p3.text.split('\n')[1], 'c'.repeat(5000));
    const small = await call(c, 'read_file', { path: '~/long.txt', offset: 9995, max_chars: 10 });
    assert.ok(small.text.endsWith('\naaaaabbbbb'));
    const past = await call(c, 'read_file', { path: '~/long.txt', offset: 99999 });
    assert.match(past.text, /past the end/);
    const empty = path.join(c.home, 'empty.txt');
    fs.writeFileSync(empty, '');
    assert.match((await call(c, 'read_file', { path: empty })).text, /is empty/);
  });

  test('read_file: binary files come back as an embedded resource blob', async () => {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))]);
    const file = path.join(c.home, 'pic.png');
    fs.writeFileSync(file, bytes);
    const r = await call(c, 'read_file', { path: '~/pic.png' });
    assert.ok(!r.isError);
    const res = r.content.find((x) => x.type === 'resource');
    assert.ok(res, JSON.stringify(r.content).slice(0, 300));
    assert.equal(res.resource.mimeType, 'image/png');
    assert.equal(res.resource.uri, pathToFileURL(file).href);
    assert.deepEqual(Buffer.from(res.resource.blob, 'base64'), bytes);
    // Over 20 MB: a clear error (a sparse file, so this is cheap).
    const big = path.join(c.home, 'big.bin');
    fs.writeFileSync(big, Buffer.from([0]));
    fs.truncateSync(big, 21 * 1024 * 1024);
    const e = await call(c, 'read_file', { path: big });
    assert.equal(e.isError, true);
    assert.match(e.text, /20 MB/);
  });

  test('read_file: folders and missing files give readable errors', async () => {
    const dir = await call(c, 'read_file', { path: '~' });
    assert.equal(dir.isError, true);
    assert.match(dir.text, /list_directory/);
    const missing = await call(c, 'read_file', { path: '~/nope.txt' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Not found/);
  });

  test('write_file: creates folders, appends, decodes base64', async () => {
    const w = await call(c, 'write_file', { path: '~/new/deep/note.txt', content: 'abc' });
    assert.ok(!w.isError, w.text);
    assert.match(w.text, /Wrote 3 bytes/);
    const file = path.join(c.home, 'new', 'deep', 'note.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'abc');
    const a = await call(c, 'write_file', { path: '~/new/deep/note.txt', content: 'def', append: true });
    assert.match(a.text, /Appended 3 bytes.*6 bytes/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
    await call(c, 'write_file', { path: 'rel/b64.bin', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' });
    assert.deepEqual([...fs.readFileSync(path.join(c.home, 'rel', 'b64.bin'))], [0, 1, 2, 255]);
    const bad = await call(c, 'write_file', { path: '~/x.bin', content: '!!not base64!!', encoding: 'base64' });
    assert.equal(bad.isError, true);
    const dir = await call(c, 'write_file', { path: '~/new', content: 'x' });
    assert.equal(dir.isError, true);
  });

  test('list_directory: entries, depth, skipped folders', async () => {
    const root = path.join(c.home, 'proj');
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), '# hi');
    fs.writeFileSync(path.join(root, 'src', 'main.js'), 'x');
    const one = await call(c, 'list_directory', { path: '~/proj' });
    assert.match(one.text, /3 entries/);
    assert.match(one.text, /dir .* src\//);
    assert.match(one.text, /file .* 4 B  README\.md/);
    assert.ok(!one.text.includes('main.js'));
    const two = await call(c, 'list_directory', { path: '~/proj', depth: 2 });
    assert.match(two.text, /\n.*  main\.js/);
    assert.match(two.text, /\(not expanded\)/);
    assert.ok(!two.text.includes('pkg'));
    const deep = await call(c, 'list_directory', { path: '~/proj', depth: 99 });
    assert.ok(!deep.isError);
    const file = await call(c, 'list_directory', { path: '~/proj/README.md' });
    assert.match(file.text, /is a file/);
  });

  test('find_files: globs, substrings, ** and skipped folders', async () => {
    const root = path.join(c.home, 'find');
    fs.mkdirSync(path.join(root, 'a', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    for (const f of ['a/report-2024.md', 'a/deep/notes.txt', 'a/deep/Report.PDF', 'top.md', 'node_modules/x/hidden.md']) fs.writeFileSync(path.join(root, f), 'x');
    const md = await call(c, 'find_files', { path: '~/find', pattern: '*.md' });
    assert.match(md.text, /2 matches/);
    assert.ok(md.text.includes(path.join(root, 'top.md')));
    assert.ok(!md.text.includes('hidden.md'));
    const sub = await call(c, 'find_files', { path: '~/find', pattern: 'report' });
    assert.match(sub.text, /2 matches/);
    const deep = await call(c, 'find_files', { path: '~/find', pattern: '**/deep/*.{txt,pdf}' });
    assert.match(deep.text, /2 matches/);
    const one = await call(c, 'find_files', { path: '~/find', pattern: '*', max_results: 1 });
    assert.match(one.text, /1 match .*stopped after 1/);
    const none = await call(c, 'find_files', { path: '~/find', pattern: '*.xyz' });
    assert.match(none.text, /No matches/);
    const inside = await call(c, 'find_files', { path: '~/find/node_modules', pattern: '*.md' });
    assert.match(inside.text, /1 match/);
  });

  test('open_path: a missing path is a readable error (nothing is opened)', async () => {
    const r = await call(c, 'open_path', { target: '~/definitely/not/here.txt' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Not found/);
  });

  test('clipboard tools validate their input', async () => {
    const r = await call(c, 'clipboard_write', {});
    assert.equal(r.isError, true);
    assert.match(r.text, /"text" is required/);
  });

  test('clipboard tools through stand-in pbcopy/pbpaste (the real clipboard is not touched)', { skip: !IS_MAC && 'macOS only' }, async () => {
    const bin = tmpDir('fakebin');
    const clip = path.join(bin, 'clip.txt');
    const langFile = path.join(bin, 'lang.txt');
    fs.writeFileSync(clip, 'FAKE-CLIPBOARD-SENTINEL');
    fs.writeFileSync(path.join(bin, 'pbpaste'), `#!/bin/sh\ncat '${clip}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'pbcopy'), `#!/bin/sh\necho "$LANG" > '${langFile}'\ncat > '${clip}'\n`, { mode: 0o755 });
    const f = await startCompanion({ env: { PATH: `${bin}:${process.env.PATH}` } });
    try {
      // Only write once reads provably go to the stand-in (and never print what a real clipboard held).
      assert.ok((await call(f, 'clipboard_read')).text === 'FAKE-CLIPBOARD-SENTINEL', 'clipboard_read did not use the stand-in pbpaste');
      const text = 'Grüße ✓ 日本語\nline 2';
      const w = await call(f, 'clipboard_write', { text });
      assert.ok(!w.isError, w.text);
      assert.match(w.text, /Copied \d+ characters/);
      assert.equal(fs.readFileSync(clip, 'utf8'), text);
      assert.match(fs.readFileSync(langFile, 'utf8'), /UTF-8/);
      assert.equal((await call(f, 'clipboard_read')).text, text);
      fs.writeFileSync(clip, '');
      assert.match((await call(f, 'clipboard_read')).text, /clipboard is empty/);
    } finally {
      await f.stop();
    }
  });

  test('clipboard round trip (COMPANION_TEST_CLIPBOARD=1; the clipboard is saved and restored)', { skip: process.env.COMPANION_TEST_CLIPBOARD !== '1' }, async () => {
    const saved = await call(c, 'clipboard_read');
    const original = saved.text.startsWith('(The clipboard is empty') ? '' : saved.text;
    try {
      const text = `companion test ✓ ${Date.now()}`;
      const w = await call(c, 'clipboard_write', { text });
      assert.ok(!w.isError, w.text);
      assert.equal((await call(c, 'clipboard_read')).text, text);
    } finally {
      await call(c, 'clipboard_write', { text: original });
    }
  });

  test('system_info describes the machine', async () => {
    const r = await call(c, 'system_info');
    for (const label of ['OS:', 'Architecture:', 'Hostname:', 'User:', 'Shell:', 'Node.js: v', 'Memory:', 'Disk (home folder):']) assert.ok(r.text.includes(label), label);
    assert.ok(r.text.includes(`Home folder: ${c.home}`));
  });
});

// ------------------------------------------------------------------ allowShell / allowWrite and /config

describe('settings', () => {
  let c;
  before(async () => (c = await startCompanion({ config: { allowShell: false, allowWrite: false } })));
  after(() => c?.stop());

  test('allowShell=false and allowWrite=false hide and refuse those tools', async () => {
    const names = (await rpc(c, 'tools/list', {})).tools.map((t) => t.name);
    for (const hidden of ['run_command', 'open_path', 'write_file']) assert.ok(!names.includes(hidden), hidden);
    assert.ok(names.includes('read_file'));
    const r = await call(c, 'run_command', { command: 'echo hi' });
    assert.equal(r.isError, true);
    assert.match(r.text, /allowShell/);
    const w = await call(c, 'write_file', { path: '~/x.txt', content: 'x' });
    assert.equal(w.isError, true);
    assert.match(w.text, /allowWrite/);
    assert.equal(fs.existsSync(path.join(c.home, 'x.txt')), false);
    const s = await status(c);
    assert.deepEqual(s.config, { allowShell: false, allowWrite: false, commandTimeoutSec: 120 });
    assert.ok(!s.tools.some((t) => t.name === 'run_command'));
  });

  test('GET /config never includes the token', async () => {
    const r = await request(c, 'GET', '/config');
    assert.deepEqual(Object.keys(r.json).sort(), ['allowShell', 'allowWrite', 'commandTimeoutSec', 'desktopTools', 'llmUpstreams', 'mcpServers', 'tunnel']);
    assert.ok(!r.text.includes(c.token));
  });

  test('PUT /config validates strictly and leaves the file alone on errors', async () => {
    const file = path.join(c.state, 'companion.json');
    const before = fs.readFileSync(file, 'utf8');
    const bad = [
      [{ token: 'x'.repeat(64) }, /token/],
      [{ nope: 1 }, /Unknown setting/],
      [{ allowShell: 'yes' }, /allowShell/],
      [{ commandTimeoutSec: 0 }, /commandTimeoutSec/],
      [{ commandTimeoutSec: '60' }, /commandTimeoutSec/],
      [{ mcpServers: [] }, /mcpServers/],
      [{ mcpServers: { 'bad name': { command: 'x' } } }, /not allowed/],
      [{ mcpServers: { ['x'.repeat(33)]: { command: 'x' } } }, /not allowed/],
      [{ mcpServers: { ok: { args: [] } } }, /command/],
      [{ mcpServers: { ok: { command: 'x', args: 'a b' } } }, /args/],
      [{ mcpServers: { ok: { command: 'x', args: [1] } } }, /args/],
      [{ mcpServers: { ok: { command: 'x', env: { A: 1 } } } }, /env/],
      [{ mcpServers: { ok: { command: 'x', disabled: 'no' } } }, /disabled/],
      [{ mcpServers: { ok: { type: 'http', url: 'https://x.example/mcp' } } }, /remote|stdio/],
      ['[1,2]', /object/],
      ['{not json', /not valid JSON/],
    ];
    for (const [body, re] of bad) {
      const r = await request(c, 'PUT', '/config', { body, headers: typeof body === 'string' ? { 'content-type': 'application/json' } : {} });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, re, JSON.stringify(body));
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  test('PUT /config applies, persists (keeping the token) and returns the status', async () => {
    const r = await request(c, 'PUT', '/config', { body: { allowShell: true, commandTimeoutSec: 45 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.config, { allowShell: true, allowWrite: false, commandTimeoutSec: 45 });
    assert.ok(Array.isArray(r.json.tools) && Array.isArray(r.json.servers));
    assert.ok(r.json.tools.some((t) => t.name === 'run_command' && t.server === 'builtin'));
    const saved = JSON.parse(fs.readFileSync(path.join(c.state, 'companion.json'), 'utf8'));
    assert.equal(saved.token, c.token);
    assert.equal(saved.allowShell, true);
    assert.equal(saved.commandTimeoutSec, 45);
    assert.match((await call(c, 'run_command', { command: 'echo on' })).text, /on/);
    // Claude Desktop's format: { command, args, env } plus "type": "stdio" is accepted.
    const s = await request(c, 'PUT', '/config', { body: { mcpServers: { off: { type: 'stdio', command: 'node', args: ['x.js'], env: { K: 'v' }, disabled: true } } } });
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(s.json.servers[0], { name: 'off', state: 'disabled', tools: 0, command: 'node', args: ['x.js'] });
    assert.deepEqual((await request(c, 'GET', '/config')).json.mcpServers, { off: { command: 'node', args: ['x.js'], env: { K: 'v' }, disabled: true } });
  });

  test('concurrent PUTs always leave a complete, valid file behind', async () => {
    const file = path.join(c.state, 'companion.json');
    let reading = true;
    let reads = 0;
    const reader = (async () => {
      while (reading) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(parsed.token, c.token);
        reads++;
        await sleep(1);
      }
    })();
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => request(c, 'PUT', '/config', { body: { commandTimeoutSec: 100 + i, allowWrite: i % 2 === 0 } })));
    reading = false;
    await reader;
    assert.ok(results.every((r) => r.status === 200));
    assert.ok(reads > 0);
    assert.deepEqual(fs.readdirSync(c.state).filter((f) => f.endsWith('.tmp')), []);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const live = (await request(c, 'GET', '/config')).json;
    assert.equal(saved.commandTimeoutSec, live.commandTimeoutSec);
    assert.equal(saved.allowWrite, live.allowWrite);
  });

  test('settings survive a restart, and edits to the file are picked up while running', async () => {
    await request(c, 'PUT', '/config', { body: { commandTimeoutSec: 77, allowWrite: true } });
    await c.stop();
    c = await startCompanion({ state: c.state, home: c.home });
    const cfg = (await request(c, 'GET', '/config')).json;
    assert.equal(cfg.commandTimeoutSec, 77);
    assert.equal(cfg.allowWrite, true);
    const file = path.join(c.state, 'companion.json');
    const edited = { ...JSON.parse(fs.readFileSync(file, 'utf8')), commandTimeoutSec: 33 };
    fs.writeFileSync(file, JSON.stringify(edited));
    await waitUntil(async () => (await request(c, 'GET', '/config')).json.commandTimeoutSec === 33, 8000, 'the edited file to be reloaded');
  });
});

// ------------------------------------------------------------------ stdio MCP servers

describe('stdio MCP proxy', () => {
  let c;
  let fixtureLog;
  before(async () => {
    fixtureLog = path.join(tmpDir('fixture'), 'fixture.log');
    c = await startCompanion({
      config: {
        mcpServers: {
          fx: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_LOG: fixtureLog } },
          missing: { command: 'definitely-not-a-command-xyz', args: [] },
          broken: { command: process.execPath, args: [FIXTURE, '--crash-on-start'] },
        },
      },
    });
    await waitUntil(async () => (await serverEntry(c, 'fx'))?.state === 'running', 15000, 'fx to run');
  });
  after(() => c?.stop());

  test('tools are listed as <server>__<tool>, across pages, with names cleaned and kept short', async () => {
    const { tools } = await rpc(c, 'tools/list', {});
    const names = tools.map((t) => t.name);
    for (const n of ['fx__echo', 'fx__add', 'fx__crash', 'fx__add_tool', 'fx__dotted_name_with_spaces']) assert.ok(names.includes(n), n);
    const echo = tools.find((t) => t.name === 'fx__echo');
    assert.equal(echo.description, 'Echo the text back.');
    assert.deepEqual(echo.inputSchema.required, ['text']);
    assert.equal(echo.annotations.readOnlyHint, true);
    const long = names.find((n) => n.startsWith('fx__a_really_long'));
    assert.ok(long && long.length <= 51, long);
    assert.ok(names.every((n) => /^[A-Za-z0-9_-]{1,60}$/.test(n)));
    const s = await status(c);
    assert.equal(s.tools.find((t) => t.name === 'fx__echo').server, 'fx');
    assert.equal((await serverEntry(c, 'fx')).tools, 11);
    // Built-ins are still there next to the broken servers.
    assert.ok(names.includes('run_command'));
  });

  test('calls round-trip, including isError results and cleaned/shortened names', async () => {
    assert.equal((await call(c, 'fx__echo', { text: 'hi there' })).text, 'hi there');
    assert.equal((await call(c, 'fx__add', { a: 2, b: 40 })).text, '42');
    const f = await call(c, 'fx__fail');
    assert.equal(f.isError, true);
    assert.equal(f.text, 'the fixture failed on purpose');
    assert.equal((await call(c, 'fx__dotted_name_with_spaces')).text, 'called dotted.name/with spaces');
    const long = (await rpc(c, 'tools/list', {})).tools.find((t) => t.name.startsWith('fx__a_really_long')).name;
    assert.equal((await call(c, long)).text, 'called a_really_long_tool_name_that_goes_on_and_on_and_on_forever');
    const unknown = await call(c, 'fx__nope');
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /no tool called "nope"/);
  });

  test('server-to-client requests are answered (roots/list → empty, others → -32601)', async () => {
    assert.deepEqual(JSON.parse((await call(c, 'fx__ask_roots')).text), { roots: [] });
    const s = JSON.parse((await call(c, 'fx__ask_sampling')).text);
    assert.equal(s.error.code, -32601);
  });

  test('a missing command is reported as an error without affecting anything else', async () => {
    const m = await serverEntry(c, 'missing');
    assert.equal(m.state, 'error');
    assert.match(m.error, /Command not found: "definitely-not-a-command-xyz"/);
    assert.equal(m.command, 'definitely-not-a-command-xyz');
    assert.deepEqual(m.args, []);
    assert.match((await call(c, 'system_info')).text, /Node\.js/);
    const r = await call(c, 'missing__anything');
    assert.equal(r.isError, true);
    assert.match(r.text, /not available/);
  });

  test('a server that fails at start shows its stderr', async () => {
    const b = await waitUntil(async () => {
      const e = await serverEntry(c, 'broken');
      return e.state === 'error' && /FAKE_API_KEY/.test(e.error || '') && e;
    }, 5000, 'broken to report its stderr');
    assert.match(b.error, /exited with code 1/);
  });

  test('a server that crashes mid-call fails that call, shows its stderr, and is restarted', async () => {
    const pid1 = Number((await call(c, 'fx__pid')).text);
    const r = await call(c, 'fx__crash');
    assert.equal(r.isError, true);
    assert.match(r.text, /exited with code 7/);
    assert.match(r.text, /about to crash on purpose/);
    const e = await serverEntry(c, 'fx');
    assert.equal(e.state, 'error');
    assert.match(e.error, /about to crash on purpose/);
    await waitUntil(async () => (await serverEntry(c, 'fx')).state === 'running', 8000, 'fx to restart');
    const pid2 = Number((await call(c, 'fx__pid')).text);
    assert.notEqual(pid1, pid2);
    assert.ok(!isAlive(pid1));
    assert.ok((await serverEntry(c, 'fx')).restarts >= 1);
  });

  test('a disconnecting client cancels the call on the server (notifications/cancelled)', async () => {
    let req;
    const pending = request(c, 'POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 'slow-1', method: 'tools/call', params: { name: 'fx__slow', arguments: { ms: 20000 } } },
      onRequest: (r) => (req = r),
    }).catch(() => 'aborted');
    await sleep(400);
    req.destroy();
    assert.equal(await pending, 'aborted');
    await waitUntil(() => fs.existsSync(fixtureLog) && /cancelled \d+/.test(fs.readFileSync(fixtureLog, 'utf8')), 5000, 'the fixture to log the cancellation');
    assert.equal((await call(c, 'fx__echo', { text: 'still fine' })).text, 'still fine');
  });

  test('tools/list_changed refreshes the server\'s tools', async () => {
    assert.equal((await call(c, 'fx__add_tool')).text, 'added');
    await waitUntil(async () => (await rpc(c, 'tools/list', {})).tools.some((t) => t.name === 'fx__extra'), 5000, 'fx__extra');
  });

  test('a slow-starting server does not hold up tools/list; removing a server stops it', async () => {
    const current = (await request(c, 'GET', '/config')).json.mcpServers;
    const t0 = Date.now();
    const put = await request(c, 'PUT', '/config', { body: { mcpServers: { ...current, slow: { command: process.execPath, args: [FIXTURE, '--slow-start', '7000'] } } } });
    assert.equal(put.status, 200);
    assert.ok(Date.now() - t0 < 5500, `PUT took ${Date.now() - t0} ms`);
    assert.equal(put.json.servers.find((s) => s.name === 'slow').state, 'starting');
    const t1 = Date.now();
    const { tools } = await rpc(c, 'tools/list', {});
    assert.ok(Date.now() - t1 < 4500, `tools/list took ${Date.now() - t1} ms`);
    assert.ok(!tools.some((t) => t.name.startsWith('slow__')));
    assert.ok(tools.some((t) => t.name === 'fx__echo'));
    const slow = await waitUntil(async () => {
      const e = await serverEntry(c, 'slow');
      return e.state === 'running' && e;
    }, 15000, 'slow to finish starting');
    assert.equal(slow.tools, 11);
    assert.ok((await rpc(c, 'tools/list', {})).tools.some((t) => t.name === 'slow__echo'));

    const pid = Number((await call(c, 'slow__pid')).text);
    const put2 = await request(c, 'PUT', '/config', { body: { mcpServers: current } });
    assert.equal(put2.status, 200);
    assert.ok(!put2.json.servers.some((s) => s.name === 'slow'));
    await waitUntil(() => !isAlive(pid), 5000, 'the removed server to exit');
  });
});

// ------------------------------------------------------------------ v1.2 helpers

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const REMOTE = { 'cf-connecting-ip': '203.0.113.5', 'cf-ray': '8a1b2c3d4e5f6789-AMS' };

// A fake cloudflared (shell wrapper → test-fixtures/fake-cloudflared.mjs) at <dir>/<name>.
function fakeCloudflared(dir, { name = 'cloudflared', version } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, `${name}.calls.jsonl`);
  const modeFile = path.join(dir, `${name}.mode`);
  const file = path.join(dir, name);
  const vars = `FAKE_CF_RECORD=${shq(record)} FAKE_CF_MODE_FILE=${shq(modeFile)}${version ? ` FAKE_CF_VERSION=${shq(version)}` : ''}`;
  fs.writeFileSync(file, `#!/bin/sh\n${vars} exec ${shq(process.execPath)} ${shq(FAKE_CF)} "$@"\n`, { mode: 0o755 });
  return { file, record, modeFile, setMode: (m) => fs.writeFileSync(modeFile, m), calls: () => readJsonl(record) };
}

const tunnelStatus = async (c) => (await request(c, 'GET', '/tunnel/status')).json;
const waitTunnel = (c, state, ms = 10000) =>
  waitUntil(
    async () => {
      const t = await tunnelStatus(c);
      return t.state === state && t;
    },
    ms,
    `the tunnel to be ${state}`,
  );
const flagValue = (argv, f) => argv[argv.indexOf(f) + 1];

// Stand-in desktop helpers: each name becomes a wrapper around test-fixtures/fake-helper.mjs.
function fakeHelpers(names) {
  const bin = tmpDir('dbin');
  const dir = tmpDir('danswers');
  const logFile = path.join(dir, 'calls.jsonl');
  for (const n of names) fs.writeFileSync(path.join(bin, n), `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(FAKE_HELPER)} ${shq(n)} "$@"\n`, { mode: 0o755 });
  return {
    bin,
    dir,
    answer: (key, { out, err, code } = {}) => {
      for (const [ext, v] of [['out', out], ['err', err], ['code', code]]) {
        const f = path.join(dir, `${key}.${ext}`);
        if (v === undefined) fs.rmSync(f, { force: true });
        else fs.writeFileSync(f, String(v));
      }
    },
    calls: (name) => readJsonl(logFile).filter((c) => !name || c.name === name),
    reset: () => fs.rmSync(logFile, { force: true }),
    env: { AGENT_COMPANION_DESKTOP_PATH: bin, FAKE_HELPER_LOG: logFile, FAKE_HELPER_DIR: dir },
  };
}

function crc32(buf) {
  let c = -1;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// RGBA PNG, filter 0, from a pixel function.
function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      raw.set([r, g, b, 255], y * (w * 4 + 1) + 1 + x * 4);
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// Decodes an 8-bit RGB PNG (what the companion writes), checking every chunk's CRC.
function readRgbPng(buf) {
  let pos = 8;
  let w;
  let h;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    assert.equal(buf.readUInt32BE(pos + 8 + len), crc32(buf.subarray(pos + 4, pos + 8 + len)), `CRC of ${type}`);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      [w, h] = [data.readUInt32BE(0), data.readUInt32BE(4)];
      assert.deepEqual([data[8], data[9]], [8, 2]);
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 3;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= 3 ? px[y * stride + i - 3] : 0;
      const b = y ? px[(y - 1) * stride + i] : 0;
      const c = y && i >= 3 ? px[(y - 1) * stride + i - 3] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      px[y * stride + i] = x + [0, a, b, (a + b) >> 1, pr][f];
    }
  }
  return { width: w, height: h, at: (x, y) => [...px.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)] };
}

// ------------------------------------------------------------------ settings for remote access and desktop tools

describe('v1.2 settings (tunnel, llmUpstreams, desktopTools)', () => {
  let c;
  before(async () => (c = await startCompanion()));
  after(() => c?.stop());

  test('PUT /config rejects bad values and leaves the file alone', async () => {
    const file = path.join(c.state, 'companion.json');
    const before = fs.readFileSync(file, 'utf8');
    const bad = [
      [{ tunnel: 'x' }, /tunnel must be an object/],
      [{ tunnel: { autostart: 'yes' } }, /tunnel\.autostart/],
      [{ tunnel: { kind: 'other' } }, /tunnel\.kind/],
      [{ tunnel: { nope: 1 } }, /Unknown tunnel setting/],
      [{ tunnel: { namedToken: 'short' } }, /namedToken/],
      [{ tunnel: { namedToken: 42 } }, /namedToken/],
      [{ tunnel: { namedUrl: 'http://companion.example.com' } }, /namedUrl/],
      [{ tunnel: { namedUrl: 'https://companion.example.com/path' } }, /namedUrl/],
      [{ llmUpstreams: [] }, /llmUpstreams/],
      [{ llmUpstreams: { 'bad name': { url: 'http://localhost:1234/v1' } } }, /not allowed/],
      [{ llmUpstreams: { a: { url: 'ftp://localhost/v1' } } }, /http/],
      [{ llmUpstreams: { a: { url: 'not a url' } } }, /not a valid URL/],
      [{ llmUpstreams: { a: {} } }, /url/],
      [{ llmUpstreams: { a: 'http://localhost:1234' } }, /object/],
      [{ llmUpstreams: { a: { url: 'http://u:p@localhost:1234' } } }, /password/],
      [{ llmUpstreams: { a: { url: 'http://localhost:1234/v1?x=1' } } }, /"\?"/],
      [{ llmUpstreams: { a: { url: 'http://localhost:1234', extra: 1 } } }, /unknown field/],
      [{ llmUpstreams: { a: { url: 'http://localhost:1234', apiKey: 'has space' } } }, /apiKey/],
      [{ desktopTools: 'no' }, /desktopTools/],
    ];
    for (const [body, re] of bad) {
      const r = await request(c, 'PUT', '/config', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, re, JSON.stringify(body));
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  test('tunnel settings merge field by field; the status has tunnel, remote and desktop', async () => {
    let r = await request(c, 'PUT', '/config', { body: { tunnel: { exposeLlm: false } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.remote, { exposeLlm: false, exposeMcp: false, upstreams: [] });
    assert.equal(r.json.tunnel.state, 'stopped');
    assert.equal(r.json.tunnel.kind, 'quick');
    assert.equal(r.json.tunnel.cloudflared.installed, false);
    assert.equal(r.json.desktop.platform, process.platform);
    assert.equal(r.json.desktop.enabled, true);
    r = await request(c, 'PUT', '/config', { body: { tunnel: { exposeMcp: true } } });
    assert.deepEqual((await request(c, 'GET', '/config')).json.tunnel, { autostart: false, kind: 'quick', hasNamedToken: false, exposeLlm: false, exposeMcp: true, namedUrl: null });
    r = await request(c, 'PUT', '/config', { body: { tunnel: { exposeLlm: true, exposeMcp: false } } });
    assert.equal(r.status, 200);
    // Partial changes sent at the same moment are all kept.
    const puts = await Promise.all([{ exposeLlm: false }, { exposeMcp: true }, { kind: 'named' }, { namedUrl: 'https://a.example.com' }].map((t) => request(c, 'PUT', '/config', { body: { tunnel: t } })));
    assert.ok(puts.every((p) => p.status === 200));
    assert.deepEqual((await request(c, 'GET', '/config')).json.tunnel, { autostart: false, kind: 'named', hasNamedToken: false, exposeLlm: false, exposeMcp: true, namedUrl: 'https://a.example.com' });
    await request(c, 'PUT', '/config', { body: { tunnel: { exposeLlm: true, exposeMcp: false, kind: 'quick', namedUrl: '' } } });
  });

  test('the named-tunnel token is write-only and can be cleared; a pasted command is reduced to the token', async () => {
    const token = `eyJhIjoi${'x'.repeat(80)}`;
    const r = await request(c, 'PUT', '/config', { body: { tunnel: { kind: 'named', namedToken: `sudo cloudflared service install ${token}` } } });
    assert.equal(r.status, 200, r.text);
    const g = await request(c, 'GET', '/config');
    assert.equal(g.json.tunnel.hasNamedToken, true);
    assert.equal(g.json.tunnel.kind, 'named');
    assert.ok(!g.text.includes(token));
    assert.ok(!(await request(c, 'GET', '/status')).text.includes(token));
    const saved = JSON.parse(fs.readFileSync(path.join(c.state, 'companion.json'), 'utf8'));
    assert.equal(saved.tunnel.namedToken, token);
    if (!IS_WIN) assert.equal(fs.statSync(path.join(c.state, 'companion.json')).mode & 0o777, 0o600);
    // Other tunnel changes keep the token.
    await request(c, 'PUT', '/config', { body: { tunnel: { exposeLlm: true } } });
    assert.equal((await request(c, 'GET', '/config')).json.tunnel.hasNamedToken, true);
    await request(c, 'PUT', '/config', { body: { tunnel: { namedToken: '' } } });
    assert.equal((await request(c, 'GET', '/config')).json.tunnel.hasNamedToken, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.state, 'companion.json'), 'utf8')).tunnel.namedToken, undefined);
    await request(c, 'PUT', '/config', { body: { tunnel: { kind: 'quick' } } });
  });

  test('llmUpstreams: URLs are normalized, apiKey is write-only and kept until cleared', async () => {
    let r = await request(c, 'PUT', '/config', { body: { llmUpstreams: { lmstudio: { url: 'http://localhost:1234/v1/', apiKey: 'sk-secret-1' }, ollama: { url: 'http://127.0.0.1:11434/v1' } } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.remote.upstreams, ['lmstudio', 'ollama']);
    let g = await request(c, 'GET', '/config');
    assert.deepEqual(g.json.llmUpstreams, { lmstudio: { url: 'http://localhost:1234/v1', hasApiKey: true }, ollama: { url: 'http://127.0.0.1:11434/v1' } });
    assert.ok(!g.text.includes('sk-secret-1'));
    // The whole map is replaced, but a key that is not sent again is kept.
    await request(c, 'PUT', '/config', { body: { llmUpstreams: { lmstudio: { url: 'http://localhost:1234/v1' } } } });
    g = await request(c, 'GET', '/config');
    assert.deepEqual(g.json.llmUpstreams, { lmstudio: { url: 'http://localhost:1234/v1', hasApiKey: true } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.state, 'companion.json'), 'utf8')).llmUpstreams.lmstudio.apiKey, 'sk-secret-1');
    await request(c, 'PUT', '/config', { body: { llmUpstreams: { lmstudio: { url: 'http://localhost:1234/v1', apiKey: '' } } } });
    assert.deepEqual((await request(c, 'GET', '/config')).json.llmUpstreams, { lmstudio: { url: 'http://localhost:1234/v1' } });
  });

  test('desktopTools switches the desktop group off and on', async () => {
    const names = async () => (await rpc(c, 'tools/list', {})).tools.map((t) => t.name);
    assert.ok((await names()).includes('list_apps'));
    let r = await request(c, 'PUT', '/config', { body: { desktopTools: false } });
    assert.equal(r.json.desktop.enabled, false);
    assert.ok(!(await names()).includes('list_apps'));
    const e = await call(c, 'list_apps');
    assert.equal(e.isError, true);
    assert.match(e.text, /desktopTools is false/);
    r = await request(c, 'PUT', '/config', { body: { desktopTools: true } });
    assert.ok((await names()).includes('list_apps'));
  });

  test('bad tunnel fields in companion.json fall back one by one', async () => {
    const d = await startCompanion({
      config: { tunnel: { kind: 'bogus', exposeMcp: true, autostart: 'x' }, llmUpstreams: { ok: { url: 'http://localhost:1/v1' }, 'bad!': { url: 'x' } }, desktopTools: 'x' },
    });
    try {
      const cfg = (await request(d, 'GET', '/config')).json;
      assert.deepEqual(cfg.tunnel, { autostart: false, kind: 'quick', hasNamedToken: false, exposeLlm: true, exposeMcp: true, namedUrl: null });
      assert.deepEqual(cfg.llmUpstreams, { ok: { url: 'http://localhost:1/v1' } });
      assert.equal(cfg.desktopTools, true);
      await waitUntil(() => /tunnel\.kind/.test(d.err()) && /Skipping a model server/.test(d.err()) && /desktopTools/.test(d.err()), 3000, 'the warnings');
    } finally {
      await d.stop();
    }
  });
});

// ------------------------------------------------------------------ Cloudflare tunnel (fake cloudflared, no network)

describe('Cloudflare tunnel', { skip: IS_WIN && 'POSIX only' }, () => {
  test('start → running with the parsed URL → stop; isolation flags; the private copy wins over one on PATH', async () => {
    const state = tmpDir('state');
    const priv = fakeCloudflared(path.join(state, 'bin'));
    const pathBin = tmpDir('pathbin');
    const onPath = fakeCloudflared(pathBin);
    const home = userHome();
    // The user's own Cloudflare setup must stay untouched.
    fs.mkdirSync(path.join(home, '.cloudflared'));
    fs.writeFileSync(path.join(home, '.cloudflared', 'config.yml'), 'tunnel: users-own-tunnel\n');
    const c = await startCompanion({
      state,
      home,
      env: { PATH: `${pathBin}:${process.env.PATH}`, AGENT_COMPANION_CLOUDFLARED_PATH: pathBin, TUNNEL_TOKEN: 'users-own-token', TUNNEL_ORIGIN_CERT: '/elsewhere/cert.pem', NO_AUTOUPDATE: 'false' },
    });
    let other;
    try {
      let t = await tunnelStatus(c);
      assert.deepEqual([t.state, t.url, t.kind], ['stopped', null, 'quick']);
      assert.equal(t.cloudflared.installed, true);
      assert.equal(t.cloudflared.path, path.join(state, 'bin', 'cloudflared'));
      assert.equal(t.cloudflared.source, 'companion');
      const started = await request(c, 'POST', '/tunnel/start', { body: {} });
      assert.equal(started.status, 200, started.text);
      assert.ok(['starting', 'running'].includes(started.json.state), started.text);
      t = await waitTunnel(c, 'running');
      const calls = priv.calls();
      assert.equal(calls.length, 1);
      const run = calls[0];
      // The URL from the banner, not the api.trycloudflare.com address printed before it.
      assert.equal(t.url, `https://fake-words-${run.pid}.trycloudflare.com`);
      assert.ok(t.since > Date.now() - 20000);
      assert.equal(t.cloudflared.version, '2099.1.0');
      assert.equal(onPath.calls().length, 0, 'the cloudflared on PATH must not be used');
      // Isolation: own config, no auto-update, random metrics port, own HOME, none of the user's Cloudflare variables.
      assert.equal(run.argv[0], 'tunnel');
      assert.equal(flagValue(run.argv, '--config'), path.join(state, 'cloudflared.yml'));
      assert.ok(run.argv.includes('--no-autoupdate'));
      assert.equal(flagValue(run.argv, '--metrics'), '127.0.0.1:0');
      assert.equal(flagValue(run.argv, '--url'), `http://127.0.0.1:${c.port}`);
      assert.equal(flagValue(run.argv, '--http-host-header'), `127.0.0.1:${c.port}`);
      assert.ok(!run.argv.some((a) => /^(login|update|service|create|delete|route|cleanup)$/.test(a)), run.argv.join(' '));
      assert.equal(run.home, path.join(state, 'cloudflared'));
      assert.deepEqual(run.cfVars, {});
      assert.match(fs.readFileSync(path.join(state, 'cloudflared.yml'), 'utf8'), /^no-autoupdate: true$/m);
      assert.equal(fs.readFileSync(path.join(home, '.cloudflared', 'config.yml'), 'utf8'), 'tunnel: users-own-tunnel\n');
      assert.deepEqual(fs.readdirSync(path.join(home, '.cloudflared')), ['config.yml']);
      assert.ok(fs.existsSync(path.join(state, 'cloudflared.pid')));
      const s = await status(c);
      assert.deepEqual({ ...s.tunnel, cloudflared: undefined }, { ...t, cloudflared: undefined });
      assert.match(fs.readFileSync(path.join(state, 'tunnel.log'), 'utf8'), /Registered tunnel connection/);
      // Starting again while running changes nothing.
      assert.equal((await request(c, 'POST', '/tunnel/start')).json.url, t.url);
      assert.equal(priv.calls().length, 1);

      // A cloudflared the companion did not start must survive "stop".
      other = spawn(onPath.file, ['tunnel', '--url', 'http://127.0.0.1:1'], { stdio: 'ignore' });
      children.add(other);
      await waitUntil(() => onPath.calls().length === 1, 5000, 'the other cloudflared to start');
      const stopped = await request(c, 'POST', '/tunnel/stop', { body: {} });
      assert.deepEqual([stopped.json.state, stopped.json.url], ['stopped', null]);
      await waitUntil(() => !isAlive(run.pid), 5000, "the companion's cloudflared to exit");
      await sleep(300);
      assert.ok(isAlive(other.pid), 'a cloudflared started by someone else must keep running');
      assert.ok(!fs.existsSync(path.join(state, 'cloudflared.pid')));
    } finally {
      other?.kill('SIGTERM');
      await c.stop();
    }
  });

  test('a crash is an error with the last output lines; no restart when autostart is off', async () => {
    const state = tmpDir('state');
    const priv = fakeCloudflared(path.join(state, 'bin'));
    priv.setMode('crash');
    const c = await startCompanion({ state });
    try {
      await request(c, 'POST', '/tunnel/start');
      const t = await waitTunnel(c, 'error');
      assert.match(t.error, /cloudflared stopped unexpectedly \(exit code 1\)/);
      assert.match(t.error, /crashing on purpose/);
      assert.doesNotMatch(t.error, /Restarting/);
      assert.equal(t.url, null);
      await sleep(1500);
      assert.equal((await tunnelStatus(c)).state, 'error');
      assert.equal(priv.calls().length, 1);
      // Start again by hand.
      priv.setMode('ok');
      await request(c, 'POST', '/tunnel/start');
      await waitTunnel(c, 'running');
      assert.equal(priv.calls().length, 2);
    } finally {
      await c.stop();
    }
  });

  test('a cloudflared that fails at once, and one that never connects, are errors', async () => {
    const state = tmpDir('state');
    const priv = fakeCloudflared(path.join(state, 'bin'));
    priv.setMode('fail');
    const c = await startCompanion({ state });
    try {
      await request(c, 'POST', '/tunnel/start');
      const t = await waitTunnel(c, 'error');
      assert.match(t.error, /failed to request quick Tunnel/);
      assert.equal(t.url, null);
      // "silent": stays in "starting" (the 90 s connect timeout is not waited for here), and stop still works.
      priv.setMode('silent');
      await request(c, 'POST', '/tunnel/start');
      await sleep(800);
      assert.equal((await tunnelStatus(c)).state, 'starting');
      const pid = priv.calls().at(-1).pid;
      await request(c, 'POST', '/tunnel/stop');
      await waitUntil(() => !isAlive(pid), 5000, 'cloudflared to exit');
    } finally {
      await c.stop();
    }
  });

  test('autostart starts the tunnel with the companion and restarts it after a crash', async () => {
    const state = tmpDir('state');
    const priv = fakeCloudflared(path.join(state, 'bin'));
    priv.setMode('crash-once');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'companion.json'), JSON.stringify({ tunnel: { autostart: true } }));
    const c = await startCompanion({ state });
    try {
      assert.match(c.out(), /tunnel starts now/);
      const err = await waitTunnel(c, 'error', 8000);
      assert.match(err.error, /Restarting in 1 s/);
      const t = await waitTunnel(c, 'running', 8000);
      assert.equal(priv.calls().length, 2);
      assert.match(t.url, /^https:\/\/fake-words-\d+\.trycloudflare\.com$/);
    } finally {
      await c.stop();
    }
  });

  test('PUT autostart: off → on starts a stopped tunnel; re-sending it does not', async () => {
    const state = tmpDir('state');
    const priv = fakeCloudflared(path.join(state, 'bin'));
    const c = await startCompanion({ state });
    try {
      await request(c, 'PUT', '/config', { body: { tunnel: { autostart: true } } });
      await waitTunnel(c, 'running');
      await request(c, 'POST', '/tunnel/stop');
      await request(c, 'PUT', '/config', { body: { tunnel: { autostart: true, exposeLlm: false } } });
      await sleep(500);
      assert.equal((await tunnelStatus(c)).state, 'stopped');
      assert.equal(priv.calls().length, 1);
      await request(c, 'PUT', '/config', { body: { tunnel: { autostart: false } } });
      await request(c, 'PUT', '/config', { body: { tunnel: { autostart: true } } });
      await waitTunnel(c, 'running');
      assert.equal(priv.calls().length, 2);
    } finally {
      await c.stop();
    }
  });

  test('GET /tunnel/connection: 409 while stopped, then a code that round-trips', async () => {
    const state = tmpDir('state');
    fakeCloudflared(path.join(state, 'bin'));
    const c = await startCompanion({ state, config: { llmUpstreams: { lmstudio: { url: 'http://localhost:1234/v1' }, ollama: { url: 'http://localhost:11434/v1' } } } });
    try {
      const early = await request(c, 'GET', '/tunnel/connection');
      assert.equal(early.status, 409);
      assert.match(early.json.error, /not running/);
      await request(c, 'POST', '/tunnel/start');
      const { url } = await waitTunnel(c, 'running');
      let r = (await request(c, 'GET', '/tunnel/connection')).json;
      assert.equal(r.url, url);
      assert.deepEqual(r.llm, { lmstudio: `${url}/llm/lmstudio`, ollama: `${url}/llm/ollama` });
      assert.equal(r.mcp, null);
      assert.match(r.code, /^aa1:[A-Za-z0-9_-]+$/);
      const decode = (code) => JSON.parse(Buffer.from(code.slice(4), 'base64url').toString('utf8'));
      assert.deepEqual(decode(r.code), { u: url, t: c.token, llm: r.llm });
      await request(c, 'PUT', '/config', { body: { tunnel: { exposeMcp: true } } });
      r = (await request(c, 'GET', '/tunnel/connection')).json;
      assert.equal(r.mcp, `${url}/mcp`);
      assert.deepEqual(decode(r.code), { u: url, t: c.token, llm: r.llm, mcp: `${url}/mcp` });
      await request(c, 'PUT', '/config', { body: { tunnel: { exposeLlm: false } } });
      assert.deepEqual(decode((await request(c, 'GET', '/tunnel/connection')).json.code).llm, {});
      // Never through the tunnel itself.
      assert.equal((await request(c, 'GET', '/tunnel/connection', { headers: REMOTE })).status, 403);
    } finally {
      await c.stop();
    }
  });

  test('download: the official asset is fetched into <home>/bin, checked, and used', async () => {
    const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch];
    const asset = IS_MAC ? `cloudflared-darwin-${arch}.tgz` : `cloudflared-linux-${arch}`;
    const src = tmpDir('dlsrc');
    const stub = fakeCloudflared(src);
    let payload = IS_MAC ? null : fs.readFileSync(stub.file);
    if (IS_MAC) {
      const tgz = path.join(tmpDir('tgz'), asset);
      assert.equal(spawnSync('tar', ['-czf', tgz, '-C', src, 'cloudflared']).status, 0);
      payload = fs.readFileSync(tgz);
    }
    const asked = [];
    let body = payload;
    const server = http.createServer((req, res) => {
      asked.push(req.url);
      if (req.url !== `/dl/${asset}`) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      // Slow enough to see the "downloading" state.
      res.write(body.subarray(0, 10));
      setTimeout(() => res.end(body.subarray(10)), 700);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const state = tmpDir('state');
    const c = await startCompanion({ state, env: { AGENT_COMPANION_CLOUDFLARED_URL: `http://127.0.0.1:${server.address().port}/dl` } });
    try {
      assert.equal((await tunnelStatus(c)).cloudflared.installed, false);
      await request(c, 'POST', '/tunnel/start');
      const dl = await waitUntil(async () => {
        const s = await tunnelStatus(c);
        return s.state === 'downloading' && s.progress && s;
      }, 3000, 'the download to be in progress');
      assert.equal(dl.progress.total, payload.length);
      assert.ok(dl.progress.received > 0 && dl.progress.received < payload.length, JSON.stringify(dl.progress));
      const t = await waitTunnel(c, 'running');
      assert.deepEqual(asked, [`/dl/${asset}`]);
      const bin = path.join(state, 'bin', 'cloudflared');
      assert.equal(fs.statSync(bin).mode & 0o111, 0o111);
      assert.deepEqual(t.cloudflared, { installed: true, path: bin, source: 'companion', version: '2099.1.0' });
      assert.deepEqual(fs.readdirSync(path.join(state, 'bin')).filter((f) => f.startsWith('.download')), []);
      assert.equal(stub.calls().length, 1);
      await request(c, 'POST', '/tunnel/stop');
      // Next start: no new download.
      await request(c, 'POST', '/tunnel/start');
      await waitTunnel(c, 'running');
      assert.equal(asked.length, 1);
      await request(c, 'POST', '/tunnel/stop');

      // A download that does not run is refused and removed (nothing else installed → a clear error).
      fs.rmSync(bin);
      body = IS_MAC ? payload : Buffer.from('this is not a program\n');
      if (IS_MAC) {
        const broken = tmpDir('broken');
        fs.writeFileSync(path.join(broken, 'cloudflared'), '#!/bin/sh\necho no\nexit 3\n', { mode: 0o755 });
        const tgz = path.join(tmpDir('tgz'), asset);
        spawnSync('tar', ['-czf', tgz, '-C', broken, 'cloudflared']);
        body = fs.readFileSync(tgz);
      }
      await request(c, 'POST', '/tunnel/start');
      const e = await waitTunnel(c, 'error');
      assert.match(e.error, /does not run/);
      assert.match(e.error, /install cloudflared yourself/);
      assert.equal(fs.existsSync(bin), false);
      assert.deepEqual(fs.readdirSync(path.join(state, 'bin')).filter((f) => f.startsWith('.download')), []);
    } finally {
      await c.stop();
      server.close();
    }
  });

  test('download fails: a cloudflared on PATH is used as is; with none, a readable error', async () => {
    const pathBin = tmpDir('pathbin');
    const sys = fakeCloudflared(pathBin, { version: '2024.6.1' });
    const before = fs.readFileSync(sys.file);
    const mtime = fs.statSync(sys.file).mtimeMs;
    const c = await startCompanion({ env: { AGENT_COMPANION_CLOUDFLARED_PATH: pathBin } });
    try {
      await request(c, 'POST', '/tunnel/start');
      const t = await waitTunnel(c, 'running');
      assert.deepEqual(t.cloudflared, { installed: true, path: sys.file, version: '2024.6.1', source: 'system' });
      assert.equal(sys.calls().length, 1);
      assert.ok(sys.calls()[0].argv.includes('--no-autoupdate'));
      assert.deepEqual(fs.readFileSync(sys.file), before);
      assert.equal(fs.statSync(sys.file).mtimeMs, mtime);
      assert.equal(fs.existsSync(path.join(c.state, 'bin', 'cloudflared')), false);
      assert.match(c.err(), /using the installed one/);
    } finally {
      await c.stop();
    }
    const none = await startCompanion();
    try {
      await request(none, 'POST', '/tunnel/start');
      const e = await waitTunnel(none, 'error');
      assert.match(e.error, /Could not download cloudflared: could not connect to 127\.0\.0\.1:9/);
      assert.match(e.error, IS_MAC ? /brew install cloudflared/ : /install cloudflared yourself/);
      assert.equal(e.cloudflared.installed, false);
    } finally {
      await none.stop();
    }
  });

  test('named tunnel: needs a token, runs "tunnel run" with the token in the environment, shows namedUrl', async () => {
    const state = tmpDir('state');
    const priv = fakeCloudflared(path.join(state, 'bin'));
    const c = await startCompanion({ state, config: { tunnel: { kind: 'named' } } });
    const token = `eyJ${'t'.repeat(60)}`;
    try {
      await request(c, 'POST', '/tunnel/start');
      let t = await waitTunnel(c, 'error');
      assert.match(t.error, /No token is set/);
      assert.equal(priv.calls().length, 0);
      await request(c, 'PUT', '/config', { body: { tunnel: { namedToken: token } } });
      await request(c, 'POST', '/tunnel/start');
      t = await waitTunnel(c, 'running');
      assert.equal(t.kind, 'named');
      assert.equal(t.url, null);
      assert.match(t.note, /Cloudflare dashboard/);
      const run = priv.calls()[0];
      assert.deepEqual(run.argv, ['tunnel', '--config', path.join(state, 'cloudflared.yml'), '--no-autoupdate', '--metrics', '127.0.0.1:0', 'run']);
      assert.deepEqual(run.cfVars, { TUNNEL_TOKEN: token });
      assert.equal((await request(c, 'GET', '/tunnel/connection')).status, 409);
      await request(c, 'PUT', '/config', { body: { tunnel: { namedUrl: 'https://companion.example.com' } } });
      assert.equal((await tunnelStatus(c)).url, 'https://companion.example.com');
      assert.equal(JSON.parse(Buffer.from((await request(c, 'GET', '/tunnel/connection')).json.code.slice(4), 'base64url')).u, 'https://companion.example.com');
      // That host name is accepted only from cloudflared (Cf-* headers present).
      assert.equal((await request(c, 'GET', '/health', { auth: false, headers: { host: 'companion.example.com', ...REMOTE } })).status, 200);
      assert.equal((await request(c, 'GET', '/health', { auth: false, headers: { host: 'companion.example.com' } })).status, 403);
      // Clearing the token restarts the tunnel, which then reports the missing token.
      await request(c, 'PUT', '/config', { body: { tunnel: { namedToken: '' } } });
      await waitUntil(() => !isAlive(run.pid), 5000, 'the old cloudflared to exit');
      t = await waitTunnel(c, 'error');
      assert.match(t.error, /No token is set/);
    } finally {
      await c.stop();
    }
  });

  test('the companion stops its cloudflared on exit, and a leftover one after a crash', async () => {
    const state = tmpDir('state');
    const priv = fakeCloudflared(path.join(state, 'bin'));
    const otherBin = fakeCloudflared(tmpDir('otherbin'));
    let c = await startCompanion({ state });
    const other = spawn(otherBin.file, ['tunnel', '--url', 'http://127.0.0.1:1'], { stdio: 'ignore' });
    children.add(other);
    try {
      await request(c, 'POST', '/tunnel/start');
      await waitTunnel(c, 'running');
      const first = priv.calls()[0].pid;
      // A killed companion cannot clean up: its cloudflared is left over...
      c.child.kill('SIGKILL');
      await c.exited;
      await sleep(300);
      assert.ok(isAlive(first));
      // ...and the next start stops it (it recognises its own config path in the command line), nothing else.
      c = await startCompanion({ state, home: c.home });
      await waitUntil(() => !isAlive(first), 5000, 'the leftover cloudflared to be stopped');
      assert.ok(isAlive(other.pid));
      await request(c, 'POST', '/tunnel/start');
      await waitTunnel(c, 'running');
      const second = priv.calls()[1].pid;
      await c.stop();
      await waitUntil(() => !isAlive(second), 5000, 'cloudflared to exit with the companion');
      assert.ok(isAlive(other.pid));
    } finally {
      other.kill('SIGTERM');
      await c.stop();
    }
  });
});

// ------------------------------------------------------------------ LLM proxy and remote requests

function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const entry = { method: req.method, url: req.url, headers: req.headers, body, aborted: false };
      seen.push(entry);
      res.on('close', () => (entry.aborted = !res.writableFinished));
      if (req.url.startsWith('/v1/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let i = 0;
        const t = setInterval(() => {
          res.write(`data: {"n":${i}}\n\n`);
          if (++i === 4) {
            clearInterval(t);
            res.end('data: [DONE]\n\n');
          }
        }, 300);
        res.on('close', () => clearInterval(t));
      } else if (req.url.startsWith('/v1/forever')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        const t = setInterval(() => res.write('data: more\n\n'), 200);
        res.on('close', () => clearInterval(t));
      } else {
        const out = JSON.stringify({ method: req.method, url: req.url, headers: req.headers, size: body.length, sha: crypto.createHash('sha256').update(body).digest('hex') });
        res.writeHead(418, { 'content-type': 'application/x-teapot', 'x-upstream': 'yes', 'access-control-allow-origin': '*' });
        res.end(out);
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

describe('LLM proxy', () => {
  let c;
  let up;
  before(async () => {
    up = await startUpstream();
    c = await startCompanion({
      config: { llmUpstreams: { up: { url: `${up.url}/v1` }, keyed: { url: `${up.url}/v1`, apiKey: 'sk-upstream-key' }, down: { url: 'http://127.0.0.1:9/v1' } } },
    });
  });
  after(async () => {
    await c?.stop();
    up?.server.close();
  });

  test('server-sent events stream through as they are produced', async () => {
    const arrivals = [];
    const t0 = Date.now();
    const { status, type } = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: c.port, method: 'POST', path: '/llm/up/stream', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' } },
        (res) => {
          res.on('data', (d) => arrivals.push({ at: Date.now() - t0, text: d.toString() }));
          res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ stream: true }));
    });
    assert.equal(status, 200);
    assert.equal(type, 'text/event-stream');
    assert.equal(arrivals.map((a) => a.text).join(''), 'data: {"n":0}\n\ndata: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\ndata: [DONE]\n\n');
    assert.ok(arrivals.length >= 4, JSON.stringify(arrivals));
    // The first event arrives long before the last one: nothing is buffered.
    assert.ok(arrivals.at(-1).at - arrivals[0].at >= 600, JSON.stringify(arrivals));
    assert.deepEqual(JSON.parse(up.seen.at(-1).body.toString()), { stream: true });
  });

  test('method, path, query, body, status and headers pass through; Authorization is replaced', async () => {
    const body = crypto.randomBytes(1024 * 1024);
    const r = await request(c, 'PUT', '/llm/up/echo/deep?a=1&b=two%20words', { body, headers: { 'content-type': 'application/octet-stream', 'x-custom': 'kept', ...REMOTE } });
    assert.equal(r.status, 418);
    assert.equal(r.headers['content-type'], 'application/x-teapot');
    assert.equal(r.headers['x-upstream'], 'yes');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const seen = JSON.parse(r.text);
    assert.equal(seen.method, 'PUT');
    assert.equal(seen.url, '/v1/echo/deep?a=1&b=two%20words');
    assert.equal(seen.size, body.length);
    assert.equal(seen.sha, crypto.createHash('sha256').update(body).digest('hex'));
    assert.equal(seen.headers['x-custom'], 'kept');
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers['cf-connecting-ip'], undefined);
    assert.equal(seen.headers.host, new URL(up.url).host);
    const keyed = JSON.parse((await request(c, 'GET', '/llm/keyed/models')).text);
    assert.equal(keyed.url, '/v1/models');
    assert.equal(keyed.headers.authorization, 'Bearer sk-upstream-key');
    // A chunked request body (no Content-Length) streams through too.
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: c.port, method: 'POST', path: '/llm/up/echo', headers: { authorization: `Bearer ${c.token}` } }, (res) => {
        let t = '';
        res.on('data', (d) => (t += d));
        res.on('end', () => resolve(JSON.parse(t)));
      });
      req.on('error', reject);
      req.write('part one, ');
      setTimeout(() => req.end('part two'), 100);
    });
    assert.equal(chunked.size, 'part one, part two'.length);
  });

  test('upstream down → 502 with a readable message; unknown names, bad paths and no token', async () => {
    const down = await request(c, 'POST', '/llm/down/chat/completions', { body: { model: 'x' } });
    assert.equal(down.status, 502);
    assert.match(down.json.error, /The model server "down" is not running at http:\/\/127\.0\.0\.1:9\/v1/);
    const unknown = await request(c, 'GET', '/llm/nope/models');
    assert.equal(unknown.status, 404);
    assert.match(unknown.json.error, /No model server called "nope".*Set up: up, keyed, down/);
    assert.equal((await request(c, 'GET', '/llm/up/../../etc/passwd')).status, 400);
    assert.equal((await request(c, 'GET', '/llm/up/%2e%2e/x')).status, 400);
    const proxyMsg = "Wrong or missing token for the model proxy. In the extension, the provider's API key must be the companion token (Settings → Computer tools shows it as the connection code).";
    for (const [auth, headers] of [[false, {}], ['wrong', {}], ['wrong', REMOTE]]) {
      const r = await request(c, 'GET', '/llm/up/models', { auth, headers });
      assert.equal(r.status, 401);
      assert.equal(r.json.error, proxyMsg);
    }
    assert.match((await request(c, 'GET', '/status', { auth: false })).json.error, /Settings → Computer tools/);
  });

  test('a client that disconnects aborts the upstream request', async () => {
    const before = up.seen.length;
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: c.port, method: 'POST', path: '/llm/up/forever', headers: { authorization: `Bearer ${c.token}` } }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => {});
      req.end('{}');
      setTimeout(() => reject(new Error('no data')), 5000);
    });
    await waitUntil(() => up.seen.length > before && up.seen.at(-1).aborted, 5000, 'the upstream request to be aborted');
  });
});

describe('remote requests (through the tunnel)', () => {
  let c;
  let up;
  before(async () => {
    up = await startUpstream();
    c = await startCompanion({ config: { llmUpstreams: { up: { url: `${up.url}/v1` } } } });
  });
  after(async () => {
    await c?.stop();
    up?.server.close();
  });
  const remote = (method, p, opts = {}) => request(c, method, p, { ...opts, headers: { ...REMOTE, ...(opts.headers || {}) } });

  test('only /health, GET /status, /llm (exposeLlm) and /mcp (exposeMcp) are reachable', async () => {
    assert.equal((await remote('GET', '/health', { auth: false })).status, 200);
    for (const [m, p] of [['GET', '/config'], ['PUT', '/config'], ['POST', '/tunnel/start'], ['POST', '/tunnel/stop'], ['GET', '/tunnel/status'], ['GET', '/tunnel/connection'], ['POST', '/status'], ['GET', '/nope']]) {
      const r = await remote(m, p, { body: m === 'PUT' ? { allowShell: true } : undefined });
      assert.equal(r.status, 403, `${m} ${p}`);
    }
    // MCP is off by default.
    const mcp = await remote('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal(mcp.status, 403);
    assert.match(mcp.json.error, /Expose computer tools/);
    await request(c, 'PUT', '/config', { body: { tunnel: { exposeMcp: true } } });
    assert.equal((await remote('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 200);
    const info = await remote('POST', '/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'system_info', arguments: {} } } });
    assert.match(info.json.result.content[0].text, /Node\.js/);
    await waitUntil(() => /\[through the tunnel\] system_info/.test(c.out()), 3000, 'the remote call to be shown in the companion window');
    await request(c, 'PUT', '/config', { body: { tunnel: { exposeMcp: false } } });
    // Models are on by default.
    assert.equal((await remote('GET', '/llm/up/models')).status, 418);
    await request(c, 'PUT', '/config', { body: { tunnel: { exposeLlm: false } } });
    const off = await remote('GET', '/llm/up/models');
    assert.equal(off.status, 403);
    assert.match(off.json.error, /Expose local models/);
    assert.equal((await request(c, 'GET', '/llm/up/models')).status, 418, 'local use is not affected');
    await request(c, 'PUT', '/config', { body: { tunnel: { exposeLlm: true } } });
    // Any one Cf header, or a non-loopback Host, makes a request remote.
    assert.equal((await request(c, 'GET', '/config', { headers: { 'cf-ray': 'x' } })).status, 403);
    assert.equal((await request(c, 'GET', '/config', { headers: { 'cf-connecting-ip': '198.51.100.1' } })).status, 403);
    assert.equal((await request(c, 'GET', '/config')).status, 200);
  });

  test('the remote /status is reduced: no home folder, user, tools or config', async () => {
    const r = await remote('GET', '/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { version: r.json.version, tunnel: { state: 'stopped' }, remote: { exposeLlm: true, exposeMcp: false, upstreams: ['up'] } });
    assert.ok(!r.text.includes(c.home));
    assert.equal((await remote('GET', '/status', { auth: false })).status, 401);
  });

  test('origins: extension origins (chrome and moz) or none; web pages are refused', async () => {
    for (const origin of ['chrome-extension://abcdef', 'moz-extension://0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b']) {
      assert.equal((await remote('GET', '/status', { headers: { origin } })).status, 200, origin);
      assert.equal((await request(c, 'GET', '/status', { headers: { origin } })).status, 200, `local ${origin}`);
    }
    for (const origin of ['https://fake-words.trycloudflare.com', `http://127.0.0.1:${c.port}`, 'null', 'https://evil.example']) {
      assert.equal((await remote('GET', '/status', { headers: { origin } })).status, 403, origin);
    }
  });

  test('wrong tokens are rate-limited per client IP (remote only)', async () => {
    const ip = { 'cf-connecting-ip': '198.51.100.77' };
    for (let i = 0; i < 10; i++) assert.equal((await remote('GET', '/status', { auth: 'wrong', headers: ip })).status, 401, `attempt ${i + 1}`);
    const blocked = await remote('GET', '/status', { headers: ip });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 800);
    assert.match(blocked.json.error, /Too many requests/);
    assert.equal((await remote('GET', '/status', { headers: { 'cf-connecting-ip': '198.51.100.78' } })).status, 200);
    assert.equal((await request(c, 'GET', '/status')).status, 200);
    for (let i = 0; i < 12; i++) await request(c, 'GET', '/status', { auth: 'wrong' });
    assert.equal((await request(c, 'GET', '/status')).status, 200, 'local requests are never blocked');
    assert.match(fs.readFileSync(path.join(c.state, 'companion.log'), 'utf8'), /Blocked 198\.51\.100\.77/);
  });
});

// ------------------------------------------------------------------ desktop tools (stand-in helpers only)

describe('desktop tools', { skip: IS_WIN && 'POSIX only' }, () => {
  const png = path.join(ROOT, 'big.png');
  let apps;
  let editorLog;
  before(() => {
    // 3200×1000: left half red, right half blue.
    fs.writeFileSync(png, makePng(3200, 1000, (x) => (x < 1600 ? [255, 0, 0] : [0, 0, 255])));
    apps = tmpDir('xdg');
    const editorBin = tmpDir('editorbin');
    editorLog = path.join(editorBin, 'editor.jsonl');
    fs.writeFileSync(path.join(editorBin, 'fake-editor'), `#!/bin/sh\nFAKE_HELPER_LOG=${shq(editorLog)} exec ${shq(process.execPath)} ${shq(FAKE_HELPER)} fake-editor "$@"\n`, { mode: 0o755 });
    const sys = path.join(apps, 'share', 'applications');
    const user = path.join(apps, 'user', 'applications');
    fs.mkdirSync(path.join(sys, 'sub'), { recursive: true });
    fs.mkdirSync(user, { recursive: true });
    const entry = (fields) => `# test\n[Desktop Entry]\n${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n')}\n[Desktop Action new]\nName=Ignored\nExec=ignored\n`;
    fs.writeFileSync(path.join(sys, 'fake-editor.desktop'), entry({ Type: 'Application', Name: 'Fake Editor', 'Name[de]': 'Falscher Editor', Comment: 'Edits\\sfake files', Exec: `${path.join(editorBin, 'fake-editor')} --new-window %F`, Icon: 'fake' }));
    fs.writeFileSync(path.join(sys, 'sub', 'nested.desktop'), entry({ Type: 'Application', Name: 'Nested App', Exec: `"${path.join(editorBin, 'fake-editor')}" "--title=Nested \\\\"App\\\\"" %u @@` }));
    fs.writeFileSync(path.join(sys, 'hidden.desktop'), entry({ Type: 'Application', Name: 'Hidden App', Exec: 'x', NoDisplay: 'true' }));
    fs.writeFileSync(path.join(sys, 'gone.desktop'), entry({ Type: 'Application', Name: 'Gone App', Exec: 'x' }));
    fs.writeFileSync(path.join(user, 'gone.desktop'), entry({ Name: 'Gone App', Hidden: 'true' }));
  });

  const linuxEnv = (session, h, extra = {}) => ({
    AGENT_COMPANION_DESKTOP_PLATFORM: 'linux',
    XDG_SESSION_TYPE: session === 'none' ? '' : session,
    DISPLAY: session === 'x11' ? ':99' : '',
    WAYLAND_DISPLAY: session === 'wayland' ? 'wayland-0' : '',
    XDG_DATA_HOME: path.join(apps, 'user'),
    XDG_DATA_DIRS: path.join(apps, 'share'),
    FAKE_PNG: png,
    ...(h?.env || {}),
    ...extra,
  });

  test('Linux X11 with nothing installed: install hints, only list_apps and launch_app', async () => {
    const c = await startCompanion({ env: linuxEnv('x11') });
    try {
      const d = (await status(c)).desktop;
      assert.deepEqual({ ...d, missing: undefined }, { platform: 'linux', session: 'x11', enabled: true, available: ['list_apps', 'launch_app'], missing: undefined });
      assert.match(d.missing.send_keys, /Install xdotool \(Debian\/Ubuntu: sudo apt install xdotool; Fedora: sudo dnf install xdotool\)/);
      assert.match(d.missing.type_in_app, /xdotool/);
      assert.match(d.missing.list_windows, /wmctrl/);
      assert.match(d.missing.desktop_screenshot, /scrot/);
      const names = (await rpc(c, 'tools/list', {})).tools.map((t) => t.name);
      assert.ok(names.includes('list_apps') && names.includes('launch_app'));
      assert.ok(!names.includes('send_keys') && !names.includes('desktop_screenshot'));
      const r = await call(c, 'send_keys', { keys: 'ctrl+s' });
      assert.equal(r.isError, true);
      assert.match(r.text, /Install xdotool/);
    } finally {
      await c.stop();
    }
  });

  test('Linux without a graphical session: only list_apps', async () => {
    const c = await startCompanion({ env: linuxEnv('none', fakeHelpers(['xdotool', 'wmctrl', 'scrot'])) });
    try {
      const d = (await status(c)).desktop;
      assert.equal(d.session, null);
      assert.deepEqual(d.available, ['list_apps']);
      assert.match(d.missing.launch_app, /No graphical session/);
      assert.match(d.missing.send_keys, /import-environment/);
    } finally {
      await c.stop();
    }
  });

  test('Linux X11 with xdotool, wmctrl, scrot and gtk-launch', async () => {
    const h = fakeHelpers(['xdotool', 'wmctrl', 'scrot', 'gtk-launch']);
    h.answer('wmctrl', { out: '0x03a00003  0 4242   myhost Fake Notes — Notes\n0x03a00007  0 4243   myhost Terminal\n' });
    const c = await startCompanion({ env: linuxEnv('x11', h) });
    try {
      const d = (await status(c)).desktop;
      assert.deepEqual(d.available.sort(), ['close_window', 'desktop_screenshot', 'focus_window', 'launch_app', 'list_apps', 'list_windows', 'send_keys', 'type_in_app']);
      assert.deepEqual(d.missing, {});
      const { tools } = await rpc(c, 'tools/list', {});
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      for (const n of ['list_apps', 'list_windows', 'desktop_screenshot']) assert.equal(byName[n].annotations.readOnlyHint, true, n);
      for (const n of ['launch_app', 'focus_window', 'close_window', 'send_keys', 'type_in_app']) assert.equal(byName[n].annotations.readOnlyHint, false, n);

      const list = await call(c, 'list_apps');
      assert.match(list.text, /Fake Editor {2}\[fake-editor\] — Edits fake files/);
      assert.match(list.text, /Nested App {2}\[sub-nested\]/);
      assert.doesNotMatch(list.text, /Hidden App|Gone App|Falscher|Ignored/);
      assert.match((await call(c, 'list_apps', { filter: 'nest' })).text, /^1 application/);

      const w = await call(c, 'list_windows');
      assert.match(w.text, /0x03a00003 {2}Fake Notes — Notes {2}\(pid 4242\)/);
      assert.deepEqual(h.calls('wmctrl')[0].args, ['-l', '-p']);
      h.reset();
      assert.match((await call(c, 'focus_window', { title_or_id: 'notes' })).text, /Focused 0x03a00003/);
      assert.deepEqual(h.calls('wmctrl').at(-1).args, ['-i', '-a', '0x03a00003']);
      await call(c, 'close_window', { title_or_id: '0x03a00007' });
      assert.deepEqual(h.calls('wmctrl').at(-1).args, ['-i', '-c', '0x03a00007']);
      const nf = await call(c, 'focus_window', { title_or_id: 'Spreadsheet' });
      assert.equal(nf.isError, true);
      assert.match(nf.text, /No window matches "Spreadsheet"[\s\S]*Terminal/);

      h.reset();
      assert.match((await call(c, 'send_keys', { keys: 'ctrl+s alt+F4 Return ctrl+/' })).text, /Sent ctrl\+s alt\+F4 Return ctrl\+\//);
      assert.deepEqual(h.calls('xdotool')[0].args, ['key', '--clearmodifiers', 'ctrl+s', 'alt+F4', 'Return', 'ctrl+slash']);
      h.reset();
      await call(c, 'send_keys', { keys: 'cmd+l', window: 'Terminal' });
      assert.deepEqual(h.calls().map((x) => [x.name, ...x.args]), [['wmctrl', '-l', '-p'], ['wmctrl', '-i', '-a', '0x03a00007'], ['xdotool', 'key', '--clearmodifiers', 'super+l']]);
      const bad = await call(c, 'send_keys', { keys: 'hyper+x' });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /Unknown modifier "hyper"/);
      h.reset();
      await call(c, 'type_in_app', { text: '-hello wörld' });
      assert.deepEqual(h.calls('xdotool')[0].args, ['type', '--delay', '20', '--clearmodifiers', '--', '-hello wörld']);

      h.reset();
      const shot = await call(c, 'desktop_screenshot');
      assert.ok(!shot.isError, shot.text);
      assert.match(shot.text, /3200×1000, scaled down to 1600×500/);
      const img = shot.content.find((x) => x.type === 'image');
      assert.equal(img.mimeType, 'image/png');
      const decoded = readRgbPng(Buffer.from(img.data, 'base64'));
      assert.deepEqual([decoded.width, decoded.height], [1600, 500]);
      assert.deepEqual(decoded.at(10, 10), [255, 0, 0]);
      assert.deepEqual(decoded.at(1590, 490), [0, 0, 255]);
      const shotFile = h.calls('scrot')[0].args.at(-1);
      assert.equal(fs.existsSync(shotFile), false, 'the temporary screenshot is deleted');
      assert.equal(fs.existsSync(path.dirname(shotFile)), false);

      h.reset();
      assert.match((await call(c, 'launch_app', { name_or_path: 'Fake Editor' })).text, /Launched Fake Editor/);
      assert.deepEqual(h.calls('gtk-launch')[0].args, ['fake-editor']);
      const missing = await call(c, 'launch_app', { name_or_path: 'No Such App 123' });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /list_apps/);
    } finally {
      await c.stop();
    }
  });

  test('Linux Wayland with wtype and grim; Exec lines without gtk-launch; ydotool key codes', async () => {
    const h = fakeHelpers(['wtype', 'grim']);
    const c = await startCompanion({ env: linuxEnv('wayland', h) });
    try {
      const d = (await status(c)).desktop;
      assert.equal(d.session, 'wayland');
      assert.deepEqual(d.available.sort(), ['desktop_screenshot', 'launch_app', 'list_apps', 'send_keys', 'type_in_app']);
      assert.match(d.missing.list_windows, /Wayland/);
      await call(c, 'send_keys', { keys: 'ctrl+shift+t' });
      assert.deepEqual(h.calls('wtype')[0].args, ['-M', 'ctrl', '-M', 'shift', '-k', 't', '-m', 'shift', '-m', 'ctrl']);
      const win = await call(c, 'send_keys', { keys: 'Return', window: 'x' });
      assert.equal(win.isError, true);
      assert.match(win.text, /not possible in this Wayland session/);
      await call(c, 'type_in_app', { text: '-x y' });
      assert.deepEqual(h.calls('wtype').at(-1).args, ['--', '-x y']);
      const shot = await call(c, 'desktop_screenshot', { display: 'HDMI-A-1' });
      assert.ok(!shot.isError, shot.text);
      assert.deepEqual(h.calls('grim')[0].args.slice(0, 2), ['-o', 'HDMI-A-1']);
      // No gtk-launch: the Exec line runs, field codes replaced, quoting undone.
      const r = await call(c, 'launch_app', { name_or_path: 'nested app', args: ['/tmp/file one.txt'] });
      assert.ok(!r.isError, r.text);
      await waitUntil(() => readJsonl(editorLog).length, 5000, 'the app to start');
      assert.deepEqual(readJsonl(editorLog).at(-1).args, ['--title=Nested "App"', '/tmp/file one.txt']);
      await call(c, 'launch_app', { name_or_path: 'fake-editor' });
      await waitUntil(() => readJsonl(editorLog).length === 2, 5000, 'the app to start again');
      assert.deepEqual(readJsonl(editorLog).at(-1).args, ['--new-window']);
    } finally {
      await c.stop();
    }
    const y = fakeHelpers(['ydotool']);
    const c2 = await startCompanion({ env: linuxEnv('wayland', y) });
    try {
      await call(c2, 'send_keys', { keys: 'ctrl+c' });
      assert.deepEqual(y.calls('ydotool')[0].args, ['key', '29:1', '46:1', '46:0', '29:0']);
      await call(c2, 'type_in_app', { text: 'hi' });
      assert.deepEqual(y.calls('ydotool').at(-1).args, ['type', 'hi']);
    } finally {
      await c2.stop();
    }
  });

  test('macOS through stand-in osascript, open and screencapture', async () => {
    const h = fakeHelpers(['osascript', 'open', 'screencapture']);
    h.answer('osascript-list', { out: 'Finder\t1\tDocuments\tfalse\nSafari\t1\tApple — Start Page\ttrue\nSafari\t2\tNews\ttrue\nMusic\t0\t\tfalse\n' });
    const c = await startCompanion({ env: { AGENT_COMPANION_DESKTOP_PLATFORM: 'darwin', FAKE_PNG: png, ...h.env } });
    try {
      const d = (await status(c)).desktop;
      assert.deepEqual([d.platform, d.session, d.available.length], ['darwin', null, 8]);
      const w = await call(c, 'list_windows');
      assert.match(w.text, /Safari\/1 {2}Safari — Apple — Start Page {2}\(front\)/);
      assert.match(w.text, /Music {2}Music \(no windows\)/);
      const script = (x) => x.args.slice(0, x.args.indexOf('--')).filter((a) => a !== '-e').join('\n');
      const argvOf = (x) => x.args.slice(x.args.indexOf('--') + 1);
      h.reset();
      await call(c, 'focus_window', { title_or_id: 'News' });
      let last = h.calls('osascript').at(-1);
      assert.match(script(last), /AXRaise/);
      assert.deepEqual(argvOf(last), ['Safari', '2']);
      await call(c, 'close_window', { title_or_id: 'Safari/1' });
      last = h.calls('osascript').at(-1);
      assert.match(script(last), /AXCloseButton/);
      assert.deepEqual(argvOf(last), ['Safari', '1']);
      const none = await call(c, 'close_window', { title_or_id: 'Music' });
      assert.match(none.text, /has no open windows/);
      h.reset();
      await call(c, 'send_keys', { keys: 'cmd+s Return cmd+shift+F5' });
      last = h.calls('osascript')[0];
      assert.match(script(last), /keystroke \(item 1 of argv\) using \{command down\}\n.*\nkey code 36\n.*\nkey code 96 using \{command down, shift down\}/);
      assert.deepEqual(argvOf(last), ['s']);
      h.reset();
      await call(c, 'type_in_app', { text: 'Hello "world" & \'you\'', window: 'Finder' });
      const [, focus, typed] = h.calls('osascript');
      assert.deepEqual(argvOf(focus), ['Finder', '1']);
      assert.deepEqual(argvOf(typed), ['Hello "world" & \'you\'']);
      assert.ok(!script(typed).includes('world'), 'text is passed as an argument, never inside the script');
      await call(c, 'launch_app', { name_or_path: 'Calculator', args: ['--x'] });
      assert.deepEqual(h.calls('open').at(-1).args, ['-a', 'Calculator', '--args', '--x']);
      const shot = await call(c, 'desktop_screenshot', { display: 2 });
      assert.ok(!shot.isError, shot.text);
      assert.deepEqual(h.calls('screencapture')[0].args.slice(0, 5), ['-x', '-t', 'png', '-D', '2']);
      assert.ok(shot.content.some((x) => x.type === 'image'));
      // macOS privacy errors come with the way out.
      h.answer('osascript', { err: "execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)\n", code: 1 });
      const denied = await call(c, 'send_keys', { keys: 'cmd+c' });
      assert.equal(denied.isError, true);
      assert.match(denied.text, /Privacy & Security → Accessibility/);
      assert.ok(!(await call(c, 'list_apps')).isError);
    } finally {
      await c.stop();
    }
  });

  test('macOS without its helper programs, and Windows: readable "missing" entries', async () => {
    const mac = await startCompanion({ env: { AGENT_COMPANION_DESKTOP_PLATFORM: 'darwin' } });
    try {
      const d = (await status(mac)).desktop;
      assert.deepEqual(d.available, ['list_apps']);
      assert.match(d.missing.send_keys, /osascript was not found/);
      assert.match(d.missing.desktop_screenshot, /screencapture/);
    } finally {
      await mac.stop();
    }
    const win = await startCompanion({ env: { AGENT_COMPANION_DESKTOP_PLATFORM: 'win32' } });
    try {
      const d = (await status(win)).desktop;
      assert.deepEqual(d.available, []);
      assert.equal(Object.keys(d.missing).length, 8);
      assert.match(d.missing.list_apps, /Linux and macOS only/);
      assert.ok(!(await rpc(win, 'tools/list', {})).tools.some((t) => t.name === 'list_apps'));
    } finally {
      await win.stop();
    }
  });

  test('real macOS: list_apps, list_windows, desktop_screenshot (COMPANION_TEST_DESKTOP=1)', { skip: !(IS_MAC && process.env.COMPANION_TEST_DESKTOP === '1') && 'set COMPANION_TEST_DESKTOP=1 on macOS' }, async () => {
    const c = await startCompanion({ env: { AGENT_COMPANION_DESKTOP_PATH: '/usr/bin:/usr/sbin' } });
    try {
      const apps = await call(c, 'list_apps');
      assert.match(apps.text, /Safari|Calculator|TextEdit/);
      const shot = await call(c, 'desktop_screenshot');
      assert.ok(!shot.isError, shot.text);
      const img = shot.content.find((x) => x.type === 'image');
      assert.ok(Buffer.from(img.data, 'base64').readUInt32BE(16) <= 1600 || /not scaled/.test(shot.text), shot.text);
      // Needs the Automation permission for System Events; without it the error must say so.
      const w = await call(c, 'list_windows');
      if (w.isError) assert.match(w.text, /Automation|Accessibility/, w.text);
      console.log(`    real desktop: ${apps.text.split('\n')[0]} | ${shot.text} | ${w.text.split('\n')[0]}`);
    } finally {
      await c.stop();
    }
  });
});

// ------------------------------------------------------------------ real cloudflared (opt-in, uses the network)

describe('real cloudflared', { skip: IS_WIN && 'POSIX only' }, () => {
  test('download the official binary (COMPANION_TEST_DOWNLOAD=1)', { skip: process.env.COMPANION_TEST_DOWNLOAD !== '1' && 'set COMPANION_TEST_DOWNLOAD=1', timeout: 300000 }, async () => {
    // A named tunnel with a token that cannot work: cloudflared is downloaded and run, but no tunnel is created.
    const c = await startCompanion({ env: { AGENT_COMPANION_CLOUDFLARED_URL: undefined }, config: { tunnel: { kind: 'named', namedToken: `eyJ${'A'.repeat(60)}` } } });
    try {
      await request(c, 'POST', '/tunnel/start');
      const seen = new Set();
      const t = await waitUntil(async () => {
        const s = await tunnelStatus(c);
        seen.add(s.state);
        return s.state === 'error' && s;
      }, 240000, 'the download and the expected token error');
      assert.ok(seen.has('downloading') || seen.has('starting'));
      const bin = path.join(c.state, 'bin', 'cloudflared');
      assert.equal(t.cloudflared.path, bin);
      assert.match(t.cloudflared.version, /^\d{4}\.\d+\.\d+/);
      const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
      assert.match(v.stdout, /cloudflared version/);
      console.log(`    downloaded ${v.stdout.trim()} (${(fs.statSync(bin).size / 1048576).toFixed(1)} MB); cloudflared said: ${t.error.split('\n').filter((l) => /token|ERR/i.test(l)).slice(-1)[0] || t.error.split('\n')[0]}`);
    } finally {
      await c.stop();
    }
  });

  test('a real quick tunnel end to end (COMPANION_TEST_TUNNEL=1)', { skip: process.env.COMPANION_TEST_TUNNEL !== '1' && 'set COMPANION_TEST_TUNNEL=1', timeout: 300000 }, async () => {
    const installed = spawnSync('/bin/sh', ['-c', 'command -v cloudflared'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(installed, 'cloudflared must be installed for this test');
    const upstream = await startUpstream();
    const c = await startCompanion({
      env: { AGENT_COMPANION_CLOUDFLARED_PATH: path.dirname(installed) },
      config: { llmUpstreams: { up: { url: `${upstream.url}/v1` } } },
    });
    try {
      await request(c, 'POST', '/tunnel/start');
      const t = await waitTunnel(c, 'running', 120000);
      assert.equal(t.cloudflared.source, 'system');
      console.log(`    tunnel ${t.url} via ${t.cloudflared.path} ${t.cloudflared.version}`);
      const auth = { authorization: `Bearer ${c.token}` };
      const health = await waitUntil(async () => {
        try {
          const r = await fetch(`${t.url}/health`);
          return r.status === 200 && (await r.json());
        } catch {
          return false;
        }
      }, 60000, 'the tunnel to be reachable');
      assert.equal(health.name, 'agent-companion');
      const st = await fetch(`${t.url}/status`, { headers: auth });
      assert.equal(st.status, 200);
      const body = await st.json();
      assert.deepEqual(Object.keys(body).sort(), ['remote', 'tunnel', 'version']);
      assert.equal((await fetch(`${t.url}/config`, { headers: auth })).status, 403);
      assert.equal((await fetch(`${t.url}/status`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
      // SSE through Cloudflare, chunk by chunk.
      const t0 = Date.now();
      const r = await fetch(`${t.url}/llm/up/stream`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"stream":true}' });
      assert.equal(r.status, 200);
      const times = [];
      let text = '';
      for await (const chunk of r.body) {
        times.push(Date.now() - t0);
        text += Buffer.from(chunk).toString();
      }
      assert.match(text, /data: \[DONE\]/);
      console.log(`    SSE chunk arrival times through the tunnel (ms): ${times.join(', ')}`);
      const code = (await request(c, 'GET', '/tunnel/connection')).json;
      assert.equal(JSON.parse(Buffer.from(code.code.slice(4), 'base64url')).u, t.url);
      await request(c, 'POST', '/tunnel/stop');
      assert.equal((await tunnelStatus(c)).state, 'stopped');
    } finally {
      await c.stop();
      upstream.server.close();
    }
  });
});

// ------------------------------------------------------------------ interop with the official MCP client (opt-in)

describe('interop with the official MCP TypeScript SDK client', { skip: !process.env.MCP_SDK_DIR && 'set MCP_SDK_DIR to run' }, () => {
  let c;
  before(async () => (c = await startCompanion()));
  after(() => c?.stop());

  test('connect, list tools and call one over Streamable HTTP', async () => {
    const dir = process.env.MCP_SDK_DIR;
    const { Client } = await import(pathToFileURL(path.join(dir, 'dist/esm/client/index.js')).href);
    const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(dir, 'dist/esm/client/streamableHttp.js')).href);
    const client = new Client({ name: 'interop-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${c.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${c.token}` } } });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'run_command'));
      const r = await client.callTool({ name: 'system_info', arguments: {} });
      assert.match(r.content[0].text, /Node\.js/);
    } finally {
      await client.close();
    }
  });
});

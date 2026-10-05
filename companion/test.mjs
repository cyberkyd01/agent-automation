// Tests for agent-companion.mjs. Run: node --test companion/
// Every companion under test gets its own temp folder (used both as --home and as $HOME, so `~` and
// the shell's startup files stay inside it) and a random free port. Nothing outside os.tmpdir() is touched.
// Opt-in extras: COMPANION_TEST_CLIPBOARD=1 (uses the real clipboard, saved and restored),
// MCP_SDK_DIR=<path to @modelcontextprotocol/sdk> (interop check with the official MCP client).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'agent-companion.mjs');
const FIXTURE = path.join(HERE, 'test-fixtures', 'fixture-server.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-companion-test-'));
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

const childEnv = (home, extra = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, AGENT_COMPANION_HOME: '', ...extra });

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
      assert.deepEqual(cfg, { allowShell: true, allowWrite: false, commandTimeoutSec: 120, mcpServers: {} });
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
    assert.deepEqual(Object.keys(r.json).sort(), ['allowShell', 'allowWrite', 'commandTimeoutSec', 'mcpServers']);
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

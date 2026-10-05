#!/usr/bin/env node
// Agent Automation companion: a small local program that gives the extension's AI agent tools for this
// computer (shell, files, clipboard) and runs stdio MCP servers for it, all behind one MCP endpoint.
// One self-contained file: Node.js 18 or later, no dependencies. Run `node agent-companion.mjs --help`.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = '1.1.0';
const NAME = 'agent-companion';
const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';
const LABEL = 'com.agent-automation.companion';
const MAX_BODY = 64 * 1024 * 1024;
const MAX_BINARY = 20 * 1024 * 1024;
const OUTPUT_CAP = 60000;
const READ_DEFAULT_CHARS = 10000;
const LIST_CAP = 500;
// The extension exposes our tools as `mcp_computer_<name>` and model APIs cap names at 64 chars.
const MAX_TOOL_NAME = 51;
const CALL_TIMEOUT_MS = 300000;
const START_TIMEOUT_MS = 120000;
const RESTART_DELAYS = [1000, 5000, 15000];
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME = os.homedir();
const DEFAULT_CONFIG = Object.freeze({ allowShell: true, allowWrite: true, commandTimeoutSec: 120, mcpServers: {} });
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const TOKEN_RE = /^[\x21-\x7e]{16,256}$/;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.cache', '.npm', '.pnpm-store', '.yarn', '.gradle', '.m2', '.Trash', '$RECYCLE.BIN',
]);
// Huge, mostly private app data: only searched when asked for explicitly.
const HOME_SKIP = new Set(IS_MAC ? ['Library'] : IS_WIN ? ['AppData'] : []);

// ---------------------------------------------------------------- small helpers

class ToolError extends Error {}
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const textResult = (text) => ({ content: [{ type: 'text', text }] });
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[i]}`;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Keeps the head and the tail, which is where the useful parts of long output usually are.
function capText(s, max = OUTPUT_CAP) {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n[… ${s.length - 2 * half} chars omitted …]\n${s.slice(-half)}`;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');

function osName() {
  return IS_MAC ? 'macOS' : IS_WIN ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform;
}

function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || '';
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isExecutableFile(f) {
  try {
    if (!fs.statSync(f).isFile()) return false;
    if (!IS_WIN) fs.accessSync(f, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// `~`, `$HOME/…` and relative paths all mean "relative to the user's home folder".
function resolveUserPath(p, base = HOME) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('The path must be a non-empty string.');
  let s = p.trim();
  if (/^file:\/\//i.test(s)) s = fileURLToPath(s);
  const m = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=$|[\\/])/.exec(s);
  if (m) return path.join(HOME, s.slice(m[0].length));
  return path.resolve(base, s);
}

function fsMessage(e, p) {
  const where = p || e.path || '';
  switch (e.code) {
    case 'ENOENT':
      return `Not found: ${where}`;
    case 'EACCES':
    case 'EPERM':
      return (
        `Permission denied: ${where}` +
        (IS_MAC
          ? ' (macOS may be blocking access; allow it in System Settings → Privacy & Security → Files and Folders or Full Disk Access for the app running the companion).'
          : '')
      );
    case 'ENOTDIR':
      return `Part of this path is not a folder: ${where}`;
    case 'EISDIR':
      return `This is a folder, not a file: ${where}`;
    case 'ENOSPC':
      return 'The disk is full.';
    case 'EROFS':
      return `This location is read-only: ${where}`;
    default:
      return e.message || String(e);
  }
}

function reqString(args, key) {
  const v = args[key];
  if (typeof v !== 'string' || !v.length) throw new ToolError(`Invalid arguments: "${key}" is required and must be a string.`);
  return v;
}

function optString(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`Invalid arguments: "${key}" must be a string.`);
  return v;
}

function intArg(v, key, def, min, max) {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`Invalid arguments: "${key}" must be a number.`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// Default to a UTF-8 locale: under launchd/systemd LANG is often unset and tools then mangle non-ASCII text.
function withLocale(env) {
  if (!IS_WIN && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = IS_MAC ? 'en_US.UTF-8' : 'C.UTF-8';
  return env;
}

// ---------------------------------------------------------------- console + log file

let logger = null;

class Logger {
  constructor(file, max = 2 * 1024 * 1024) {
    this.file = file;
    this.max = max;
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  write(level, msg) {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${String(msg).replace(/\n/g, '\n      ')}\n`;
    try {
      if (this.size + line.length > this.max) {
        try {
          fs.renameSync(this.file, `${this.file}.1`);
        } catch {}
        this.size = 0;
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    } catch {}
  }
}

const log = (level, msg) => logger?.write(level, msg);

function say(msg = '') {
  try {
    process.stdout.write(`${msg}\n`);
  } catch {}
}

function warn(msg) {
  try {
    process.stderr.write(`Warning: ${msg}\n`);
  } catch {}
  log('WARN', msg);
}

function event(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  say(`[${t}] ${msg}`);
  log('INFO', msg);
}

// ---------------------------------------------------------------- processes

const runningCommands = new Set();

// Collects a stream's bytes, keeping only the first and last `limit` bytes of very long output.
class Capture {
  constructor(limit = 1 << 20) {
    this.limit = limit;
    this.head = [];
    this.headLen = 0;
    this.tail = [];
    this.tailLen = 0;
    this.total = 0;
  }

  push(buf) {
    this.total += buf.length;
    if (this.headLen < this.limit) {
      const take = buf.subarray(0, this.limit - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      buf = buf.subarray(take.length);
    }
    if (!buf.length) return;
    this.tail.push(buf);
    this.tailLen += buf.length;
    while (this.tail.length > 1 && this.tailLen - this.tail[0].length >= this.limit) this.tailLen -= this.tail.shift().length;
  }

  text(max = OUTPUT_CAP) {
    const head = Buffer.concat(this.head);
    const tail = Buffer.concat(this.tail);
    const dropped = this.total - head.length - tail.length;
    if (!dropped) return capText(Buffer.concat([head, tail]).toString('utf8'), max);
    const half = Math.floor(max / 2);
    const h = head.toString('utf8');
    const t = tail.toString('utf8');
    return `${h.slice(0, half)}\n[… ${h.length - half + dropped + t.length - half} chars omitted …]\n${t.slice(-half)}`;
  }
}

// Kills a child and everything it started (it runs in its own process group / job tree).
function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
  if (signal !== 'SIGKILL') {
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, 2000).unref();
  }
}

// Runs a program and resolves (never rejects) with its exit status and captured output.
function runProcess(file, argv, { cwd = HOME, env = process.env, input, timeoutMs, signal, maxChars = OUTPUT_CAP, track = false } = {}) {
  return new Promise((resolve) => {
    const out = new Capture();
    const err = new Capture();
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let child;
    try {
      child = spawn(file, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
    } catch (e) {
      return resolve({ error: e, stdout: '', stderr: '' });
    }
    if (track) runningCommands.add(child);
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let drain = null;
    let drainUntil = 0;
    // A background process can keep the pipes open after the command itself exited: don't wait for it forever.
    const armDrain = () => {
      if (!drain) return;
      clearTimeout(drain);
      drain = setTimeout(() => finish(exitInfo), Math.max(0, Math.min(700, drainUntil - Date.now())));
    };
    child.stdout.on('data', (d) => {
      out.push(d);
      armDrain();
    });
    child.stderr.on('data', (d) => {
      err.push(d);
      armDrain();
    });
    child.stdin.on('error', () => {});
    try {
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    } catch {}
    let exitInfo = {};
    child.on('error', (e) => finish({ error: e }));
    child.on('exit', (code, sig) => {
      exitInfo = { code, signal: sig };
      drainUntil = Date.now() + 5000;
      drain = setTimeout(() => finish(exitInfo), 700);
    });
    child.on('close', (code, sig) => finish(exitInfo.code !== undefined || exitInfo.signal ? exitInfo : { code, signal: sig }));
    function finish(info) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      signal?.removeEventListener('abort', onAbort);
      runningCommands.delete(child);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ...info, timedOut, cancelled, stdout: out.text(maxChars), stderr: err.text(maxChars) });
    }
  });
}

// Starts a GUI helper (open/xdg-open/…): reports early failures but never kills what it opened.
function launch(file, argv, waitMs = 4000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, argv, { stdio: ['ignore', 'ignore', 'pipe'], detached: !IS_WIN, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, message: e.message });
    }
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
    const t = setTimeout(() => {
      child.unref();
      child.stderr.destroy();
      resolve({ ok: true });
    }, waitMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, message: e.code === 'ENOENT' ? `"${file}" is not available on this system.` : e.message });
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code === 0 ? { ok: true } : { ok: false, message: stderr.trim() || `${file} exited with code ${code}` });
    });
  });
}

// ---------------------------------------------------------------- shell + PATH

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'mksh', 'dash', 'ash', 'yash']);
let shellCache;

function userShell() {
  if (shellCache) return shellCache;
  let fromPasswd;
  try {
    fromPasswd = os.userInfo().shell;
  } catch {}
  for (const s of [process.env.SHELL, fromPasswd]) {
    if (s && path.isAbsolute(s) && isExecutableFile(s)) {
      const name = path.basename(s);
      if (POSIX_SHELLS.has(name)) return (shellCache = { path: s, name, login: true, own: s });
      // fish, nu, …: their syntax differs from what models write, so run commands in a POSIX shell instead.
      const fallback = isExecutableFile('/bin/bash') ? '/bin/bash' : '/bin/sh';
      return (shellCache = { path: fallback, name: path.basename(fallback), login: false, own: s });
    }
  }
  const fallback = isExecutableFile('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return (shellCache = { path: fallback, name: path.basename(fallback), login: fallback !== '/bin/sh', own: fallback });
}

function shellLabel() {
  if (IS_WIN) return 'PowerShell';
  const s = userShell();
  return s.login ? `${s.name} (login shell)` : s.name;
}

let loginPath = Promise.resolve(process.env.PATH || '');

function mergePath(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists)
    for (const d of String(list || '').split(path.delimiter)) {
      if (d && !seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  return out.join(path.delimiter);
}

// Started by launchd/systemd the companion gets a minimal PATH, so ask the user's own shell for theirs
// (interactive first, because tools like nvm add themselves in ~/.zshrc / ~/.bashrc).
async function resolveLoginPath() {
  const nodeDir = path.dirname(process.execPath);
  if (IS_WIN) return mergePath(process.env.PATH || process.env.Path, nodeDir);
  const extras = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(HOME, '.local/bin'), path.join(HOME, '.cargo/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(isDir);
  const sh = userShell();
  const own = sh.own;
  const ownName = path.basename(own);
  const mark = '__AGENT_COMPANION_PATH__';
  const attempts = [];
  if (ownName === 'fish') attempts.push([own, ['-ilc', `printf '%s%s%s' ${mark} (string join : $PATH) ${mark}`]]);
  else if (POSIX_SHELLS.has(ownName)) {
    attempts.push([own, ['-ilc', `printf '%s%s%s' ${mark} "$PATH" ${mark}`]]);
    attempts.push([own, ['-lc', `printf '%s%s%s' ${mark} "$PATH" ${mark}`]]);
  }
  attempts.push(['/bin/sh', ['-lc', `printf '%s%s%s' ${mark} "$PATH" ${mark}`]]);
  for (const [file, argv] of attempts) {
    const r = await runProcess(file, argv, { timeoutMs: 6000, env: { ...process.env, TERM: 'dumb' }, maxChars: 1e6 });
    const m = new RegExp(`${mark}(.*?)${mark}`, 's').exec(r.stdout || '');
    if (m && m[1].trim()) return mergePath(m[1].trim(), process.env.PATH, nodeDir, extras.join(':'));
  }
  log('WARN', 'Could not read the PATH from the login shell; using a default one.');
  return mergePath(process.env.PATH, nodeDir, extras.join(':'));
}

function which(cmd, PATH, cwd = HOME) {
  if (!cmd) return null;
  const hasSep = cmd.includes('/') || (IS_WIN && cmd.includes('\\'));
  // Windows: the npm folder also holds an extensionless `npx` shell script, so try PATHEXT first.
  const exts = IS_WIN && !path.extname(cmd) ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const bases = hasSep ? [resolveUserPath(cmd, cwd)] : String(PATH).split(path.delimiter).filter(Boolean).map((d) => path.join(d, cmd));
  for (const base of bases) for (const ext of exts) if (isExecutableFile(base + ext)) return base + ext;
  return null;
}

const PS_PRELUDE = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";
const psArgs = (script) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_PRELUDE + script, 'utf16le').toString('base64')];

async function commandEnv() {
  const env = withLocale({ ...process.env, PATH: await loginPath });
  if (IS_WIN) env.Path = env.PATH;
  if (env.NO_COLOR === undefined) env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.PAGER = env.GIT_PAGER = 'cat';
  return env;
}

// ---------------------------------------------------------------- config

let config = { token: '', ...structuredClone(DEFAULT_CONFIG) };
let configFile = '';
let lastWritten = '';
let configQueue = Promise.resolve();

function checkServer(name, s) {
  const where = `mcpServers.${name}`;
  if (!SERVER_NAME_RE.test(name)) return { error: `Server name "${name}" is not allowed: use 1 to 32 letters, digits, "_" or "-".` };
  if (!isObj(s)) return { error: `${where} must be an object with "command" and "args".` };
  if ((s.type !== undefined && s.type !== 'stdio') || (s.url !== undefined && s.command === undefined))
    return { error: `${where}: only local (stdio) servers with a "command" can run in the companion. Add remote MCP servers in the extension's own MCP settings instead.` };
  if (typeof s.command !== 'string' || !s.command.trim() || s.command.length > 4096) return { error: `${where}.command must be a non-empty string.` };
  const args = s.args ?? [];
  if (!Array.isArray(args) || args.length > 500 || !args.every((a) => typeof a === 'string' && a.length <= 32768 && !a.includes('\0')))
    return { error: `${where}.args must be an array of strings.` };
  const env = s.env ?? {};
  if (!isObj(env) || Object.keys(env).length > 500) return { error: `${where}.env must be an object of string values.` };
  for (const [k, v] of Object.entries(env)) {
    if (!k || /[=\0]/.test(k) || typeof v !== 'string' || v.includes('\0')) return { error: `${where}.env.${k} must be a string (and the name must not contain "=").` };
  }
  if (s.cwd !== undefined && (typeof s.cwd !== 'string' || !s.cwd.trim())) return { error: `${where}.cwd must be a non-empty string.` };
  if (s.disabled !== undefined && typeof s.disabled !== 'boolean') return { error: `${where}.disabled must be true or false.` };
  const value = { command: s.command.trim(), args: [...args], env: { ...env } };
  if (s.cwd !== undefined) value.cwd = s.cwd;
  if (s.disabled !== undefined) value.disabled = s.disabled;
  return { value };
}

// Strict validation for PUT /config: anything wrong rejects the whole request.
function checkConfigPatch(body) {
  if (!isObj(body)) throw new HttpError(400, 'The body must be a JSON object.');
  for (const k of Object.keys(body)) {
    if (k === 'token') throw new HttpError(400, 'The token cannot be read or changed through /config. To get a new token, stop the companion, delete companion.json and start it again.');
    if (!['allowShell', 'allowWrite', 'commandTimeoutSec', 'mcpServers'].includes(k)) throw new HttpError(400, `Unknown setting "${k}". Allowed: allowShell, allowWrite, commandTimeoutSec, mcpServers.`);
  }
  const out = {};
  for (const k of ['allowShell', 'allowWrite']) {
    if (!(k in body)) continue;
    if (typeof body[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false.`);
    out[k] = body[k];
  }
  if ('commandTimeoutSec' in body) {
    const n = body.commandTimeoutSec;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || n > 86400) throw new HttpError(400, 'commandTimeoutSec must be a number of seconds between 1 and 86400.');
    out.commandTimeoutSec = Math.round(n);
  }
  if ('mcpServers' in body) {
    if (!isObj(body.mcpServers)) throw new HttpError(400, 'mcpServers must be an object mapping server names to { command, args, env }.');
    const names = Object.keys(body.mcpServers);
    if (names.length > 50) throw new HttpError(400, 'At most 50 MCP servers can be configured.');
    out.mcpServers = {};
    for (const name of names) {
      const r = checkServer(name, body.mcpServers[name]);
      if (r.error) throw new HttpError(400, r.error);
      out.mcpServers[name] = r.value;
    }
  }
  return out;
}

// Lenient validation for the file on disk: bad fields fall back to defaults with a warning.
function normalizeConfig(raw, warnings) {
  const c = { token: '', ...structuredClone(DEFAULT_CONFIG) };
  if (!isObj(raw)) {
    warnings.push('companion.json does not contain a JSON object; using the default settings.');
    return c;
  }
  if (typeof raw.token === 'string' && TOKEN_RE.test(raw.token)) c.token = raw.token;
  else if (raw.token !== undefined) warnings.push('The token in companion.json is not valid; a new one was generated.');
  for (const k of ['allowShell', 'allowWrite']) {
    if (typeof raw[k] === 'boolean') c[k] = raw[k];
    else if (raw[k] !== undefined) warnings.push(`${k} in companion.json must be true or false; using ${DEFAULT_CONFIG[k]}.`);
  }
  const n = raw.commandTimeoutSec;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 86400) c.commandTimeoutSec = Math.round(n);
  else if (n !== undefined) warnings.push(`commandTimeoutSec in companion.json must be between 1 and 86400; using ${DEFAULT_CONFIG.commandTimeoutSec}.`);
  if (isObj(raw.mcpServers)) {
    for (const [name, s] of Object.entries(raw.mcpServers)) {
      const r = checkServer(name, s);
      if (r.error) warnings.push(`Skipping an MCP server from companion.json: ${r.error}`);
      else c.mcpServers[name] = r.value;
    }
  } else if (raw.mcpServers !== undefined) warnings.push('mcpServers in companion.json must be an object; no MCP servers were started.');
  return c;
}

const serializeConfig = (c) =>
  `${JSON.stringify({ token: c.token, allowShell: c.allowShell, allowWrite: c.allowWrite, commandTimeoutSec: c.commandTimeoutSec, mcpServers: c.mcpServers }, null, 2)}\n`;

function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (e) {
        // Windows: a virus scanner or editor can briefly hold the file.
        if (!IS_WIN || i >= 5) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function persistConfig(c) {
  const text = serializeConfig(c);
  writeFileAtomic(configFile, text);
  lastWritten = text;
}

function publicConfig() {
  return { allowShell: config.allowShell, allowWrite: config.allowWrite, commandTimeoutSec: config.commandTimeoutSec, mcpServers: structuredClone(config.mcpServers) };
}

function loadConfig(file) {
  configFile = file;
  const warnings = [];
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') warnings.push(`Could not read ${file} (${e.message}); using the default settings.`);
  }
  let c;
  let write = false;
  let created = false;
  if (text === null) {
    c = { token: '', ...structuredClone(DEFAULT_CONFIG) };
    write = created = true;
  } else {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      const backup = `${file}.broken-${Date.now()}`;
      try {
        fs.renameSync(file, backup);
        warnings.push(`companion.json is not valid JSON (${e.message}). It was kept as ${backup} and the default settings are used.`);
      } catch {
        warnings.push(`companion.json is not valid JSON (${e.message}); the default settings are used.`);
      }
      // Keep the old token if it can still be found, so the extension stays connected.
      raw = { token: /"token"\s*:\s*"([\x21-\x7e]{16,256}?)"/.exec(text)?.[1] };
      write = true;
    }
    c = normalizeConfig(raw, warnings);
    if (text !== null && !write) lastWritten = text;
  }
  if (!c.token) {
    c.token = crypto.randomBytes(32).toString('hex');
    write = true;
  }
  config = c;
  if (write) {
    try {
      persistConfig(c);
    } catch (e) {
      warnings.push(`Could not save ${file}: ${e.message}`);
    }
  }
  if (!IS_WIN) {
    try {
      if (fs.statSync(file).mode & 0o077) fs.chmodSync(file, 0o600);
    } catch {}
  }
  return { warnings, created };
}

function reloadConfigFromDisk() {
  let text;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      try {
        persistConfig(config);
        event('companion.json was deleted; it was written again with the current settings.');
      } catch {}
    }
    return;
  }
  if (text === lastWritten) return;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    lastWritten = text;
    warn(`companion.json was edited but is not valid JSON (${e.message}); keeping the current settings.`);
    return;
  }
  const warnings = [];
  const next = normalizeConfig(raw, warnings);
  warnings.forEach(warn);
  lastWritten = text;
  if (!next.token) {
    next.token = config.token;
    try {
      persistConfig(next);
    } catch {}
  }
  config = next;
  reconcileServers(true);
  event('Reloaded companion.json after it was edited.');
}

// ---------------------------------------------------------------- built-in tools

async function runCommandTool(args, signal) {
  const command = reqString(args, 'command');
  const cwdArg = optString(args, 'cwd');
  const cwd = cwdArg ? resolveUserPath(cwdArg) : HOME;
  if (!isDir(cwd)) throw new ToolError(`The working folder does not exist: ${cwd}`);
  const timeoutSec = intArg(args.timeout_sec, 'timeout_sec', config.commandTimeoutSec, 1, 86400);
  const stdin = optString(args, 'stdin');
  let file;
  let argv;
  if (IS_WIN) [file, argv] = ['powershell.exe', psArgs(command)];
  else {
    const sh = userShell();
    [file, argv] = [sh.path, [sh.login ? '-lc' : '-c', command]];
  }
  const r = await runProcess(file, argv, { cwd, env: await commandEnv(), input: stdin, timeoutMs: timeoutSec * 1000, signal, track: true });
  if (r.error) return toolError(`Could not start ${file}: ${r.error.message}`);
  const lines = [];
  let failed = false;
  if (r.timedOut) {
    lines.push(`Timed out after ${timeoutSec} s; the command and everything it started were stopped.`);
    failed = true;
  } else if (r.cancelled) {
    lines.push('Cancelled; the command and everything it started were stopped.');
    failed = true;
  } else if (r.signal) {
    lines.push(`Terminated by signal ${r.signal}.`);
    failed = true;
  } else lines.push(`Exit code: ${r.code}`);
  const stdout = stripAnsi(r.stdout);
  const stderr = stripAnsi(r.stderr);
  if (stdout) lines.push('--- stdout ---', stdout.replace(/\n$/, ''));
  if (stderr) lines.push('--- stderr ---', stderr.replace(/\n$/, ''));
  if (!stdout && !stderr) lines.push('(no output)');
  const text = lines.join('\n');
  return failed ? toolError(text) : textResult(text);
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', bz2: 'application/x-bzip2', xz: 'application/x-xz',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf', epub: 'application/epub+zip', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', wasm: 'application/wasm', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff',
  woff2: 'font/woff2', sqlite: 'application/vnd.sqlite3', db: 'application/vnd.sqlite3', json: 'application/json', txt: 'text/plain',
  csv: 'text/csv', html: 'text/html', htm: 'text/html', xml: 'application/xml', md: 'text/markdown', exe: 'application/vnd.microsoft.portable-executable',
  dmg: 'application/x-apple-diskimage', iso: 'application/x-iso9660-image', jar: 'application/java-archive',
};
const guessMime = (p) => MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream';

// null → binary; otherwise the text encoding to decode with.
function sniffEncoding(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  if (buf.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true });
  } catch {
    return null;
  }
  let ctrl = 0;
  for (const b of buf) if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27 && b !== 8) ctrl++;
  return buf.length && ctrl / buf.length > 0.1 ? null : 'utf-8';
}

async function readFileTool(args, signal) {
  const p = resolveUserPath(reqString(args, 'path'));
  const offset = intArg(args.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = intArg(args.max_chars, 'max_chars', READ_DEFAULT_CHARS, 1, 1000000);
  const st = await fsp.stat(p);
  if (st.isDirectory()) throw new ToolError(`${p} is a folder. Use list_directory to see what it contains.`);
  if (!st.isFile()) throw new ToolError(`${p} is not a regular file.`);
  const fh = await fsp.open(p, 'r');
  try {
    const sample = Buffer.alloc(Math.min(8192, st.size));
    if (sample.length) await fh.read(sample, 0, sample.length, 0);
    const encoding = sniffEncoding(sample);
    if (!encoding) {
      if (st.size > MAX_BINARY)
        throw new ToolError(`${p} is a binary file of ${fmtBytes(st.size)}, larger than the ${fmtBytes(MAX_BINARY)} read_file can return. Use run_command to inspect it instead (for example "file", "head -c", "unzip -l").`);
      const data = await fh.readFile();
      const mimeType = guessMime(p);
      return {
        content: [
          { type: 'text', text: `Binary file ${p} (${mimeType}, ${fmtBytes(data.length)}), returned as an embedded resource.` },
          { type: 'resource', resource: { uri: pathToFileURL(p).href, mimeType, blob: data.toString('base64') } },
        ],
      };
    }
    // Decode in chunks so huge text files are not loaded whole just to return one page.
    const dec = new TextDecoder(encoding);
    const chunk = Buffer.allocUnsafe(1 << 20);
    const want = offset + maxChars;
    let pos = 0;
    let seen = 0;
    let out = '';
    let eof = false;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      pos += bytesRead;
      const text = bytesRead ? dec.decode(chunk.subarray(0, bytesRead), { stream: true }) : dec.decode();
      const from = Math.max(0, offset - seen);
      const to = Math.min(text.length, want - seen);
      if (to > from) out += text.slice(from, to);
      seen += text.length;
      if (!bytesRead) {
        eof = true;
        break;
      }
      if (seen > want && pos < st.size) break;
    }
    const total = eof ? seen : null;
    const end = offset + out.length;
    const more = total === null || total > end;
    if (total !== null && offset > 0 && offset >= total) return textResult(`[offset ${offset} is past the end of ${p}, which has ${total} characters.]`);
    if (!out) return textResult(`(${p} is empty)`);
    if (offset === 0 && !more) return textResult(out);
    const of = total === null ? '(the file continues)' : `of ${total}`;
    const next = more ? ` To read on, call read_file with offset=${end}.` : ' This is the end of the file.';
    return textResult(`[Characters ${offset} to ${end} ${of}.${next}]\n${out}`);
  } finally {
    await fh.close().catch(() => {});
  }
}

async function writeFileTool(args) {
  const p = resolveUserPath(reqString(args, 'path'));
  if (typeof args.content !== 'string') throw new ToolError('Invalid arguments: "content" is required and must be a string.');
  const encoding = String(args.encoding ?? 'utf8').toLowerCase().replace('-', '');
  if (encoding !== 'utf8' && encoding !== 'base64') throw new ToolError('Invalid arguments: "encoding" must be "utf8" or "base64".');
  let data;
  if (encoding === 'base64') {
    const b64 = args.content.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new ToolError('Invalid arguments: "content" is not valid base64.');
    data = Buffer.from(b64, 'base64');
  } else data = Buffer.from(args.content, 'utf8');
  const append = args.append === true || args.append === 'true';
  let existed = true;
  try {
    if ((await fsp.stat(p)).isDirectory()) throw new ToolError(`${p} is a folder; give a file path.`);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (e.code !== 'ENOENT') throw e;
    existed = false;
  }
  await fsp.mkdir(path.dirname(p), { recursive: true });
  if (append) await fsp.appendFile(p, data);
  else await fsp.writeFile(p, data);
  const size = (await fsp.stat(p)).size;
  const n = data.length.toLocaleString('en-US');
  if (append) return textResult(`Appended ${n} bytes to ${p} (the file is now ${size.toLocaleString('en-US')} bytes).`);
  return textResult(`Wrote ${n} bytes to ${p}${existed ? ' (replaced the previous content)' : ' (new file)'}.`);
}

const byDirThenName = (a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

async function listDirectoryTool(args, signal) {
  const root = resolveUserPath(optString(args, 'path') || '~');
  const depth = intArg(args.depth, 'depth', 1, 1, 4);
  const st = await fsp.stat(root);
  if (!st.isDirectory()) return textResult(`${root} is a file (${fmtBytes(st.size)}, modified ${fmtDate(st.mtimeMs)}). Use read_file to read it.`);
  const lines = [];
  let count = 0;
  let truncated = false;
  const pad = ' '.repeat(35);
  async function walk(dir, level) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      lines.push(`${pad}${'  '.repeat(level)}[cannot read this folder: ${fsMessage(e, dir)}]`);
      return;
    }
    entries.sort(byDirThenName);
    for (const ent of entries) {
      if (signal?.aborted) throw abortError();
      if (count >= LIST_CAP) {
        truncated = true;
        return;
      }
      count++;
      const full = path.join(dir, ent.name);
      let info = null;
      try {
        info = await fsp.lstat(full);
      } catch {}
      const kind = ent.isDirectory() ? 'dir' : ent.isSymbolicLink() ? 'link' : ent.isFile() ? 'file' : 'other';
      let name = ent.name + (kind === 'dir' ? '/' : '');
      if (kind === 'link') {
        try {
          name += ` -> ${await fsp.readlink(full)}`;
        } catch {}
      }
      const size = kind === 'file' && info ? fmtBytes(info.size) : '';
      lines.push(`${kind.padEnd(5)} ${(info ? fmtDate(info.mtimeMs) : '').padEnd(16)} ${size.padStart(10)}  ${'  '.repeat(level)}${name}`);
      if (kind === 'dir' && level + 1 < depth) {
        if (SKIP_DIRS.has(ent.name)) lines.push(`${pad}${'  '.repeat(level + 1)}(not expanded)`);
        else await walk(full, level + 1);
      }
    }
  }
  await walk(root, 0);
  const head = truncated
    ? `${root} (first ${LIST_CAP} entries only; list a subfolder or use a smaller depth to see the rest)`
    : `${root} (${count} ${count === 1 ? 'entry' : 'entries'}${depth > 1 ? `, depth ${depth}` : ''})`;
  return textResult(count ? `${head}\ntype  modified               size  name\n${lines.join('\n')}` : `${root} is an empty folder.`);
}

function globToRegExp(glob) {
  let i = 0;
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  function parse(inBraces) {
    let re = '';
    while (i < glob.length) {
      const c = glob[i];
      if (inBraces && (c === ',' || c === '}')) return re;
      i++;
      if (c === '*') {
        if (glob[i] === '*') {
          i++;
          if (glob[i] === '/') {
            i++;
            re += '(?:.*/)?';
          } else re += '.*';
        } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else if (c === '[') {
        const close = glob.indexOf(']', i + 1);
        if (close < 0) {
          re += '\\[';
          continue;
        }
        let body = glob.slice(i, close);
        i = close + 1;
        if (body[0] === '!') body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
      } else if (c === '{') {
        const alts = [];
        for (;;) {
          alts.push(parse(true));
          if (glob[i] === ',') i++;
          else {
            if (glob[i] === '}') i++;
            break;
          }
        }
        re += `(?:${alts.join('|')})`;
      } else re += esc(c);
    }
    return re;
  }
  return new RegExp(`^${parse(false)}$`, 'i');
}

async function findFilesTool(args, signal) {
  const root = resolveUserPath(optString(args, 'path') || '~');
  const pattern = reqString(args, 'pattern').trim();
  const max = intArg(args.max_results, 'max_results', 100, 1, 2000);
  if (!isDir(root)) throw new ToolError(`Not a folder: ${root}`);
  const onPath = pattern.includes('/');
  let test;
  if (!/[*?[{]/.test(pattern) && !onPath) {
    const needle = pattern.toLowerCase();
    test = (s) => s.toLowerCase().includes(needle);
  } else {
    const re = globToRegExp(pattern.replace(/^\.?\//, ''));
    test = (s) => re.test(s);
  }
  const results = [];
  const queue = [root];
  const deadline = Date.now() + 20000;
  let visited = 0;
  let stopped = '';
  outer: for (let qi = 0; qi < queue.length; qi++) {
    const dir = queue[qi];
    queue[qi] = undefined;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      visited++;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (test(onPath ? rel : ent.name)) {
        results.push(full + (ent.isDirectory() ? path.sep : ''));
        if (results.length >= max) {
          stopped = `stopped after ${max} results (raise max_results or narrow the pattern)`;
          break outer;
        }
      }
      if (ent.isDirectory() && !SKIP_DIRS.has(ent.name) && !(dir === HOME && HOME_SKIP.has(ent.name))) queue.push(full);
    }
    if (signal?.aborted) throw abortError();
    if (visited > 300000) {
      stopped = 'stopped after looking at 300,000 entries (search a smaller folder)';
      break;
    }
    if (Date.now() > deadline) {
      stopped = 'stopped after 20 seconds (search a smaller folder)';
      break;
    }
  }
  const note = `Skipped folders: ${[...SKIP_DIRS].slice(0, 6).join(', ')} and similar${HOME_SKIP.size ? `, ~/${[...HOME_SKIP][0]}` : ''}.`;
  if (!results.length) return textResult(`No matches for "${pattern}" in ${root}${stopped ? ` (${stopped})` : ''}. ${note}`);
  return textResult(`${results.length} match${results.length === 1 ? '' : 'es'} for "${pattern}" in ${root}${stopped ? ` (${stopped})` : ''}:\n${results.join('\n')}`);
}

async function openPathTool(args) {
  const target = reqString(args, 'target').trim();
  const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target) && !/^file:/i.test(target);
  if (IS_WIN) {
    const quoted = `'${target.replace(/'/g, "''")}'`;
    const r = await runProcess('powershell.exe', psArgs(`Start-Process -FilePath ${quoted}`), { timeoutMs: 15000 });
    if (r.error || r.code !== 0) return toolError(`Could not open ${target}: ${(r.stderr || r.error?.message || '').trim()}`);
    return textResult(`Opened ${target}.`);
  }
  let argv;
  let what = target;
  if (isUrl) argv = [target];
  else {
    const p = resolveUserPath(target);
    if (fs.existsSync(p)) {
      argv = [p];
      what = p;
    } else if (IS_MAC && !/[\\/]/.test(target)) argv = ['-a', target.replace(/\.app$/i, '')];
    else throw new ToolError(`Not found: ${p}`);
  }
  const r = await launch(IS_MAC ? 'open' : 'xdg-open', argv);
  if (!r.ok) return toolError(`Could not open ${what}: ${r.message}`);
  return textResult(`Opened ${what}.`);
}

async function clipboardTools() {
  if (IS_MAC) return { read: ['pbpaste', []], write: ['pbcopy', []] };
  if (IS_WIN) return { win: true };
  const PATH = await loginPath;
  const options = [];
  if (process.env.WAYLAND_DISPLAY) options.push({ read: ['wl-paste', ['--no-newline']], write: ['wl-copy', []] });
  options.push({ read: ['xclip', ['-selection', 'clipboard', '-o']], write: ['xclip', ['-selection', 'clipboard', '-i']] });
  options.push({ read: ['xsel', ['--clipboard', '--output']], write: ['xsel', ['--clipboard', '--input']] });
  for (const o of options) {
    const file = which(o.read[0], PATH);
    if (file) return { read: [file, o.read[1]], write: [file === which(o.write[0], PATH) ? file : which(o.write[0], PATH), o.write[1]] };
  }
  throw new ToolError('No clipboard program was found. Install wl-clipboard (Wayland) or xclip / xsel (X11).');
}

async function clipboardReadTool() {
  const tools = await clipboardTools();
  let text;
  if (tools.win) {
    const r = await runProcess('powershell.exe', psArgs("$t = Get-Clipboard -Raw; if ($null -eq $t) { $t = '' }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))"), { timeoutMs: 15000, maxChars: 1e9 });
    if (r.error || r.code !== 0) return toolError(`Could not read the clipboard: ${(r.stderr || r.error?.message || '').trim()}`);
    text = Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
  } else {
    const r = await runProcess(tools.read[0], tools.read[1], { env: withLocale({ ...process.env, LANG: IS_MAC ? 'en_US.UTF-8' : process.env.LANG }), timeoutMs: 15000, maxChars: 1e9 });
    if (r.error) return toolError(`Could not read the clipboard: ${r.error.message}`);
    // wl-paste exits non-zero when the clipboard is empty.
    if (r.code !== 0 && !/no selection|nothing is copied/i.test(r.stderr)) return toolError(`Could not read the clipboard: ${r.stderr.trim() || `exit code ${r.code}`}`);
    text = r.stdout;
  }
  if (!text) return textResult('(The clipboard is empty or does not hold text.)');
  return textResult(capText(text, 100000));
}

async function clipboardWriteTool(args) {
  if (typeof args.text !== 'string') throw new ToolError('Invalid arguments: "text" is required and must be a string.');
  const tools = await clipboardTools();
  let r;
  if (tools.win) {
    r = await runProcess('powershell.exe', psArgs('$b = [Console]::In.ReadToEnd(); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b.Trim())))'), {
      input: Buffer.from(args.text, 'utf8').toString('base64'),
      timeoutMs: 15000,
    });
  } else {
    r = await runProcess(tools.write[0], tools.write[1], { env: withLocale({ ...process.env, LANG: IS_MAC ? 'en_US.UTF-8' : process.env.LANG }), input: args.text, timeoutMs: 15000 });
  }
  if (r.error || r.code !== 0) return toolError(`Could not write the clipboard: ${(r.stderr || r.error?.message || `exit code ${r.code}`).trim()}`);
  return textResult(`Copied ${args.text.length.toLocaleString('en-US')} characters to the clipboard.`);
}

let osVersionCache;
async function osVersion() {
  if (osVersionCache) return osVersionCache;
  let v = `${os.type()} ${os.release()}`;
  if (IS_MAC) {
    const r = await runProcess('/usr/bin/sw_vers', ['-productVersion'], { timeoutMs: 3000 });
    if (r.stdout?.trim()) v = `macOS ${r.stdout.trim()} (Darwin ${os.release()})`;
  } else if (IS_WIN) v = `${os.version?.() || 'Windows'} (${os.release()})`;
  else {
    try {
      const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'));
      if (m) v = `${m[1]} (Linux ${os.release()})`;
    } catch {}
  }
  return (osVersionCache = v);
}

async function diskInfo(p) {
  try {
    if (typeof fsp.statfs === 'function') {
      const s = await fsp.statfs(p);
      return `${fmtBytes(s.bavail * s.bsize)} free of ${fmtBytes(s.blocks * s.bsize)}`;
    }
  } catch {}
  if (IS_WIN) return 'unknown';
  const r = await runProcess('df', ['-k', p], { timeoutMs: 5000 });
  const cols = r.stdout?.trim().split('\n').pop()?.split(/\s+/);
  return cols && cols.length >= 4 && Number(cols[3]) ? `${fmtBytes(Number(cols[3]) * 1024)} free of ${fmtBytes(Number(cols[1]) * 1024)}` : 'unknown';
}

// os.freemem() on macOS counts only completely unused pages; reclaimable cache is what matters.
async function memoryInfo() {
  let free = os.freemem();
  if (IS_MAC) {
    const r = await runProcess('/usr/bin/vm_stat', [], { timeoutMs: 3000 });
    const page = Number(/page size of (\d+)/.exec(r.stdout || '')?.[1]) || 16384;
    const pages = (k) => Number(new RegExp(`Pages ${k}:\\s+(\\d+)`).exec(r.stdout || '')?.[1]) || 0;
    const avail = (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page;
    if (avail > free) free = avail;
  }
  return `${fmtBytes(free)} available of ${fmtBytes(os.totalmem())}`;
}

async function systemInfoTool() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cpus = os.cpus();
  const lines = [
    `OS: ${await osVersion()}`,
    `Architecture: ${process.arch}`,
    `Hostname: ${os.hostname()}`,
    `User: ${userName()}`,
    `Home folder: ${HOME}`,
    `Shell: ${IS_WIN ? 'PowerShell' : userShell().own}${!IS_WIN && userShell().own !== userShell().path ? ` (run_command uses ${userShell().path})` : ''}`,
    `Commands run in: ${HOME} unless run_command is given a cwd (companion's own cwd: ${process.cwd()})`,
    `Node.js: ${process.version}`,
    `CPU: ${cpus[0]?.model?.trim() || 'unknown'} × ${cpus.length}`,
    `Memory: ${await memoryInfo()}`,
    `Disk (home folder): ${await diskInfo(HOME)}`,
    `Local time: ${fmtDate(Date.now())} (${tz})`,
    `Companion: ${NAME} ${VERSION}`,
  ];
  return textResult(lines.join('\n'));
}

const pathProp = (what) => ({ type: 'string', description: `${what} ~ and relative paths are resolved against the user's home folder.` });

const BUILTINS = [
  {
    name: 'run_command',
    gate: 'shell',
    title: 'Run a shell command',
    description: () =>
      `Run a command on the user's computer (${osName()}, ${shellLabel()}) and return its exit code, stdout and stderr. ` +
      `It runs non-interactively with the user's PATH, in their home folder unless cwd is given; programs waiting for input get end-of-file unless stdin is given. ` +
      `It is stopped (with everything it started) after timeout_sec, default ${config.commandTimeoutSec}. ` +
      `To leave a program running in the background, redirect its output, e.g. "nohup cmd > /tmp/cmd.log 2>&1 &". Long output is cut in the middle.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: IS_WIN ? 'PowerShell command line to run.' : 'Shell command line to run, e.g. "ls -la ~/Downloads | head -50".' },
        cwd: pathProp('Working folder. Default: the home folder.'),
        timeout_sec: { type: 'number', minimum: 1, maximum: 86400, description: 'Seconds before the command is stopped.' },
        stdin: { type: 'string', description: 'Text passed to the command on standard input.' },
      },
      required: ['command'],
    },
    annotations: { title: 'Run a shell command', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: runCommandTool,
  },
  {
    name: 'read_file',
    title: 'Read a file',
    description: () =>
      `Read a file on the user's computer. Text files come back as text, up to max_chars characters (default ${READ_DEFAULT_CHARS}) from offset, with a note saying how to read on. ` +
      `Binary files (images, PDFs, Office documents, archives…) up to 20 MB come back as an embedded resource.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProp('File to read.'),
        offset: { type: 'integer', minimum: 0, description: 'Character offset to start from (for reading long text files in pages). Default 0.' },
        max_chars: { type: 'integer', minimum: 1, maximum: 1000000, description: `Maximum characters to return. Default ${READ_DEFAULT_CHARS}.` },
      },
      required: ['path'],
    },
    annotations: { title: 'Read a file', readOnlyHint: true },
    run: readFileTool,
  },
  {
    name: 'write_file',
    gate: 'write',
    title: 'Write a file',
    description: () => 'Create or overwrite a file on the user\'s computer (or append to it), creating missing parent folders. Use encoding "base64" for binary content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProp('File to write.'),
        content: { type: 'string', description: 'The content to write.' },
        append: { type: 'boolean', description: 'Append to the end of the file instead of replacing it. Default false.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How content is encoded. Default "utf8".' },
      },
      required: ['path', 'content'],
    },
    annotations: { title: 'Write a file', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: writeFileTool,
  },
  {
    name: 'list_directory',
    title: 'List a folder',
    description: () => `List a folder on the user's computer: type, modification time, size and name of each entry, folders first. depth 2 to 4 also lists subfolders (at most ${LIST_CAP} entries in total).`,
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProp('Folder to list. Default: the home folder.'),
        depth: { type: 'integer', minimum: 1, maximum: 4, description: 'How many levels to list. Default 1.' },
      },
      required: ['path'],
    },
    annotations: { title: 'List a folder', readOnlyHint: true },
    run: listDirectoryTool,
  },
  {
    name: 'find_files',
    title: 'Find files',
    description: () =>
      'Find files and folders by name under a folder (searched breadth-first, nearest first). pattern is a glob: "*" and "?" match within a name, "**" across folders, "{a,b}" alternatives; ' +
      'without wildcards it matches names containing the text. Case-insensitive. A pattern with "/" is matched against the path relative to the folder. ' +
      'node_modules, .git and similar cache folders are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProp('Folder to search in. Default: the home folder.'),
        pattern: { type: 'string', description: 'For example "*.pdf", "report*", "**/src/*.{js,ts}", "invoice".' },
        max_results: { type: 'integer', minimum: 1, maximum: 2000, description: 'Default 100.' },
      },
      required: ['path', 'pattern'],
    },
    annotations: { title: 'Find files', readOnlyHint: true },
    run: findFilesTool,
  },
  {
    name: 'open_path',
    gate: 'shell',
    title: 'Open a file, folder, app or URL',
    description: () => `Open a file, folder${IS_MAC || IS_WIN ? ', application' : ''} or URL on the user's computer with its default program, as if the user double-clicked it.`,
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: `A path (~ allowed), a URL${IS_MAC ? ', or an application name such as "Calculator"' : IS_WIN ? ', or a program name such as "notepad"' : ''}.` } },
      required: ['target'],
    },
    annotations: { title: 'Open a file, folder, app or URL', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: openPathTool,
  },
  {
    name: 'clipboard_read',
    title: 'Read the clipboard',
    description: () => 'Return the text currently on the user\'s clipboard.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Read the clipboard', readOnlyHint: true },
    run: clipboardReadTool,
  },
  {
    name: 'clipboard_write',
    title: 'Copy text to the clipboard',
    description: () => 'Put text on the user\'s clipboard (replacing what is there).',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The text to copy.' } }, required: ['text'] },
    annotations: { title: 'Copy text to the clipboard', readOnlyHint: false, destructiveHint: false },
    run: clipboardWriteTool,
  },
  {
    name: 'system_info',
    title: 'Describe this computer',
    description: () => 'Describe the user\'s computer: OS and version, architecture, hostname, user name, home folder, shell, Node.js version, free memory and disk space, local time.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Describe this computer', readOnlyHint: true },
    run: systemInfoTool,
  },
];
const BUILTIN_BY_NAME = new Map(BUILTINS.map((t) => [t.name, t]));

const toolEnabled = (t) => (t.gate === 'shell' ? config.allowShell : t.gate === 'write' ? config.allowWrite : true);

function describeBuiltin(t) {
  return { name: t.name, title: t.title, description: t.description(), inputSchema: t.inputSchema, annotations: t.annotations };
}

function argSummary(name, args) {
  if (name === 'write_file') return `${args.path} (${typeof args.content === 'string' ? args.content.length : 0} chars${args.append ? ', append' : ''})`;
  if (name === 'clipboard_write') return `(${typeof args.text === 'string' ? args.text.length : 0} chars)`;
  const v = args.command ?? args.path ?? args.target ?? (Object.keys(args).length ? JSON.stringify(args) : '');
  const s = String(v).replace(/\s+/g, ' ');
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// ---------------------------------------------------------------- stdio MCP servers

let servers = new Map();

function spawnSpec(file, args) {
  // Node refuses to spawn .cmd/.bat files directly (CVE-2024-27980), and npx/uvx are .cmd shims on Windows.
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
    return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(q).join(' ')}"`], { windowsVerbatimArguments: true }];
  }
  return [file, args, {}];
}

class StdioServer {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.state = cfg.disabled ? 'disabled' : 'stopped';
    this.tools = [];
    this.stderrLines = [];
    this.error = undefined;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.failures = 0;
    this.restarts = 0;
    this.gaveUp = false;
    this.gen = 0;
    this.failedGen = -1;
    this.ready = Promise.resolve();
    this.restartTimer = null;
  }

  start() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const gen = ++this.gen;
    this.error = undefined;
    this.tools = [];
    if (this.cfg.disabled) {
      this.state = 'disabled';
      return (this.ready = Promise.resolve());
    }
    this.state = 'starting';
    this.startedAt = Date.now();
    this.ready = this.boot(gen).catch((e) => this.fail(e.message, gen));
    return this.ready;
  }

  restart() {
    this.rejectAll(new Error(`The MCP server "${this.name}" is being restarted.`));
    this.killChild();
    return this.start();
  }

  async boot(gen) {
    const PATH = await loginPath;
    if (gen !== this.gen) return;
    const cwd = this.cfg.cwd ? resolveUserPath(this.cfg.cwd) : HOME;
    if (!isDir(cwd)) throw new Error(`Its working folder does not exist: ${cwd}`);
    const file = which(this.cfg.command, PATH, cwd);
    if (!file) throw new Error(`Command not found: "${this.cfg.command}". Check that it is installed, or give its full path.\nSearched PATH: ${PATH}`);
    const env = withLocale({ ...process.env, PATH, ...(IS_WIN && { Path: PATH }), ...this.cfg.env });
    const [cmd, argv, extra] = spawnSpec(file, this.cfg.args);
    this.stderrLines = [];
    const child = spawn(cmd, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true, ...extra });
    this.child = child;
    child.on('error', (e) => {
      if (child === this.child) this.fail(`Could not start "${this.cfg.command}": ${e.message}`, gen);
    });
    // 'exit' can arrive before the last stderr lines (often the useful ones): give 'close' a moment.
    child.on('exit', (code, sig) => {
      let handled = false;
      const handle = () => {
        if (handled) return;
        handled = true;
        this.onExit(child, code, sig, gen);
      };
      child.once('close', handle);
      setTimeout(handle, 500).unref();
    });
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (child === this.child) this.onLine(line);
      }
      if (buf.length > MAX_BODY) {
        buf = '';
        this.noteStderr('[companion] dropped an over-long line from stdout');
      }
    });
    let ebuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      ebuf += d;
      const parts = ebuf.split(/\r?\n/);
      ebuf = parts.pop();
      if (ebuf.length > 2000) {
        parts.push(ebuf);
        ebuf = '';
      }
      if (child === this.child) parts.forEach((l) => this.noteStderr(l));
    });
    child.stderr.on('end', () => {
      if (ebuf && child === this.child) this.noteStderr(ebuf);
      ebuf = '';
    });
    const init = await this.request(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: false } }, clientInfo: { name: NAME, title: 'Agent Automation companion', version: VERSION } },
      { timeoutMs: START_TIMEOUT_MS, what: 'start' },
    );
    if (gen !== this.gen) return;
    this.serverInfo = init?.serverInfo;
    this.notify('notifications/initialized');
    await this.loadTools();
    if (gen !== this.gen) return;
    this.state = 'running';
    event(`MCP server "${this.name}" is running (${this.tools.length} tool${this.tools.length === 1 ? '' : 's'}).`);
  }

  noteStderr(line) {
    if (!line.trim()) return;
    this.stderrLines.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
    if (this.stderrLines.length > 40) this.stderrLines.shift();
  }

  stderrTail(n = 40) {
    const lines = this.stderrLines.slice(-n);
    return lines.length ? `\nLast stderr lines:\n${lines.join('\n')}` : '';
  }

  onExit(child, code, sig, gen) {
    if (child !== this.child) return;
    this.child = null;
    const how = sig ? `was stopped by signal ${sig}` : `exited with code ${code}`;
    this.rejectAll(new Error(`The MCP server "${this.name}" ${how} while handling this request.${this.stderrTail(10)}`));
    this.fail(`The server process ${how}.`, gen);
  }

  fail(message, gen) {
    if (gen !== this.gen || this.failedGen === gen) return;
    this.failedGen = gen;
    this.rejectAll(new Error(`The MCP server "${this.name}" failed: ${message}`));
    this.killChild();
    this.state = 'error';
    this.tools = [];
    if (Date.now() - this.startedAt > 60000) this.failures = 0;
    this.failures++;
    let note = '';
    if (this.failures > RESTART_DELAYS.length) {
      this.gaveUp = true;
      note = '\nIt is not restarted automatically any more; it is tried again when one of its tools is called or the settings change.';
    } else {
      const delay = RESTART_DELAYS[this.failures - 1];
      note = `\nRestarting in ${delay / 1000} s.`;
      this.restartTimer = setTimeout(() => {
        this.restarts++;
        this.start();
      }, delay);
      this.restartTimer.unref?.();
    }
    this.error = `${message}${note}${this.stderrTail()}`;
    warn(`MCP server "${this.name}": ${message.split('\n')[0]}${note.replace(/\n/g, ' ')}`);
  }

  killChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {}
    killTree(child, 'SIGTERM');
  }

  stop() {
    this.gen++;
    clearTimeout(this.restartTimer);
    this.state = this.cfg.disabled ? 'disabled' : 'stopped';
    this.tools = [];
    this.error = undefined;
    this.rejectAll(new Error(`The MCP server "${this.name}" was stopped.`));
    const child = this.child;
    this.child = null;
    if (!child) return Promise.resolve();
    if (child.exitCode !== null || child.signalCode !== null) {
      killTree(child, 'SIGTERM'); // whatever it started may still be running
      return Promise.resolve();
    }
    // MCP shutdown: close stdin, then SIGTERM, then SIGKILL.
    return new Promise((resolve) => {
      child.once('exit', () => {
        killTree(child, 'SIGTERM');
        resolve();
      });
      try {
        child.stdin.end();
      } catch {}
      setTimeout(() => killTree(child, 'SIGTERM'), 300).unref();
      setTimeout(() => {
        killTree(child, 'SIGKILL');
        resolve();
      }, 2500).unref();
    });
  }

  rejectAll(err) {
    for (const p of [...this.pending.values()]) p.reject(err);
  }

  send(msg) {
    try {
      this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {}
  }

  notify(method, params) {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  request(method, params, { timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error(`The MCP server "${this.name}" is not running.`));
      if (signal?.aborted) return reject(abortError());
      const id = this.nextId++;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        cleanup();
        this.notify('notifications/cancelled', { requestId: id, reason: 'The user cancelled the request.' });
        reject(abortError());
      };
      const timer = setTimeout(() => {
        cleanup();
        if (method !== 'initialize') this.notify('notifications/cancelled', { requestId: id, reason: 'Timed out.' });
        reject(new Error(`The MCP server "${this.name}" did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.${method === 'initialize' ? this.stderrTail(10) : ''}`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      this.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
    });
  }

  onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.noteStderr(`[stdout, not JSON] ${line}`);
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      try {
        this.onMessage(m);
      } catch (e) {
        log('WARN', `MCP server "${this.name}": could not handle a message: ${e.message}`);
      }
    }
  }

  onMessage(m) {
    if (!isObj(m)) return;
    if (typeof m.method === 'string') {
      if (m.id !== undefined && m.id !== null) return this.answer(m);
      if (m.method === 'notifications/tools/list_changed' && this.state === 'running') {
        const gen = this.gen;
        this.loadTools().catch((e) => gen === this.gen && log('WARN', `MCP server "${this.name}": could not refresh its tools: ${e.message}`));
      }
      return;
    }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.error) p.reject(new RpcError(m.error.code, m.error.message || 'MCP error', m.error.data));
    else p.resolve(m.result);
  }

  // Requests from the server to us: answer them all so a server never waits forever.
  answer(m) {
    let reply;
    if (m.method === 'ping') reply = { result: {} };
    else if (m.method === 'roots/list') reply = { result: { roots: [] } };
    else reply = { error: { code: -32601, message: `The Agent Automation companion does not support ${m.method}.` } };
    this.send({ jsonrpc: '2.0', id: m.id, ...reply });
  }

  async loadTools() {
    const all = [];
    let cursor;
    let pages = 0;
    do {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: 30000 });
      if (Array.isArray(r?.tools)) all.push(...r.tools);
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
    } while (cursor && ++pages < 100);
    this.tools = all.filter((t) => isObj(t) && typeof t.name === 'string' && t.name);
  }

  // A server that gave up restarting gets exactly one more try when it is used again.
  async ensureStarted(signal) {
    if (this.state === 'error' && this.gaveUp) {
      this.gaveUp = false;
      this.failures = RESTART_DELAYS.length;
      this.restarts++;
      this.start();
    }
    if (this.state === 'starting') await waitFor(this.ready, START_TIMEOUT_MS + 5000, signal);
  }

  async call(toolName, args, signal) {
    await this.ensureStarted(signal);
    if (signal?.aborted) return toolError('Cancelled.');
    if (this.state !== 'running') return toolError(`The MCP server "${this.name}" is not available (${this.state}).${this.error ? ` ${this.error}` : ''}`);
    try {
      const r = await this.request('tools/call', { name: toolName, arguments: args }, { timeoutMs: CALL_TIMEOUT_MS, signal });
      return isObj(r) ? r : textResult(JSON.stringify(r));
    } catch (e) {
      if (e.name === 'AbortError') return toolError('Cancelled.');
      if (e instanceof RpcError) return toolError(`The MCP server "${this.name}" reported an error: ${e.message}`);
      return toolError(e.message);
    }
  }

  statusEntry() {
    const s = { name: this.name, state: this.state, tools: this.state === 'running' ? this.tools.length : 0 };
    if (this.error) s.error = this.error;
    s.command = this.cfg.command;
    s.args = this.cfg.args;
    if (this.restarts) s.restarts = this.restarts;
    return s;
  }
}

function waitFor(promise, ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    Promise.resolve(promise).then(done, done);
  });
}

function reconcileServers(retryFailed = false) {
  const next = new Map();
  for (const [name, cfg] of Object.entries(config.mcpServers)) {
    let s = servers.get(name);
    if (!s) {
      s = new StdioServer(name, cfg);
      s.start();
    } else if (JSON.stringify(s.cfg) !== JSON.stringify(cfg)) {
      s.cfg = cfg;
      s.failures = 0;
      s.gaveUp = false;
      s.restart();
    } else if (retryFailed && s.state === 'error') {
      s.failures = 0;
      s.gaveUp = false;
      s.restart();
    }
    next.set(name, s);
  }
  for (const [name, s] of servers) if (!next.has(name)) s.stop();
  servers = next;
}

// Don't make the agent wait on a server that is still installing itself (first `npx -y …` run etc.).
async function settleServers(ms = 3000) {
  const starting = [...servers.values()].filter((s) => s.state === 'starting' && Date.now() - s.startedAt < 20000).map((s) => s.ready);
  if (starting.length) await waitFor(Promise.allSettled(starting), ms);
}

function proxyEntries() {
  const out = [];
  const taken = new Set(BUILTINS.map((t) => t.name));
  for (const s of servers.values()) {
    if (s.state !== 'running') continue;
    for (const tool of s.tools) {
      let name = `${s.name}__${tool.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      if (name.length > MAX_TOOL_NAME || taken.has(name)) {
        const h = crypto.createHash('sha1').update(`${s.name}\0${tool.name}`).digest('hex').slice(0, 6);
        name = `${name.slice(0, MAX_TOOL_NAME - 7)}_${h}`;
      }
      taken.add(name);
      out.push({ name, server: s, tool });
    }
  }
  return out;
}

function describeProxied({ name, server, tool }) {
  const d = {
    name,
    description: tool.description || `${tool.name} (from the ${server.name} MCP server)`,
    inputSchema: isObj(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
  };
  if (tool.title) d.title = tool.title;
  if (isObj(tool.annotations)) d.annotations = tool.annotations;
  if (isObj(tool.outputSchema)) d.outputSchema = tool.outputSchema;
  return d;
}

async function callProxied(name, args, signal) {
  let entry = proxyEntries().find((e) => e.name === name);
  if (entry) return entry.server.call(entry.tool.name, args, signal);
  const server = [...servers.values()].find((s) => name.startsWith(`${s.name}__`));
  if (!server) return null;
  if (server.state === 'disabled') return toolError(`The MCP server "${server.name}" is disabled in the companion settings.`);
  await server.ensureStarted(signal);
  entry = proxyEntries().find((e) => e.name === name);
  if (entry) return entry.server.call(entry.tool.name, args, signal);
  if (server.state !== 'running') return toolError(`The MCP server "${server.name}" is not available (${server.state}).${server.error ? ` ${server.error}` : ''}`);
  return toolError(`The MCP server "${server.name}" has no tool called "${name.slice(server.name.length + 2)}". Its tools are: ${server.tools.map((t) => t.name).join(', ') || 'none'}.`);
}

// ---------------------------------------------------------------- MCP endpoint

function negotiateVersion(v) {
  return PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0];
}

async function listAllTools() {
  await settleServers(3000);
  return [...BUILTINS.filter(toolEnabled).map(describeBuiltin), ...proxyEntries().map(describeProxied)];
}

async function callTool(params, signal) {
  if (!isObj(params) || typeof params.name !== 'string') throw new RpcError(-32602, 'Invalid params: tools/call needs a tool "name".');
  const { name } = params;
  const args = params.arguments ?? {};
  if (!isObj(args)) return toolError('Invalid arguments: "arguments" must be an object.');
  const builtin = BUILTIN_BY_NAME.get(name);
  if (builtin) {
    if (!toolEnabled(builtin)) {
      const flag = builtin.gate === 'shell' ? 'allowShell' : 'allowWrite';
      return toolError(`${name} is turned off in the companion settings (${flag} is false). The user can turn it on in the extension: Settings → Computer tools.`);
    }
    event(`${name} ${argSummary(name, args)}`);
    try {
      return await builtin.run(args, signal);
    } catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) return toolError('Cancelled.');
      if (e instanceof ToolError) return toolError(e.message);
      if (e?.code) return toolError(fsMessage(e));
      log('ERROR', `${name} failed: ${e?.stack || e}`);
      return toolError(`${name} failed: ${e?.message || e}`);
    }
  }
  if (name.includes('__')) {
    event(`${name} ${argSummary(name, args)}`);
    const r = await callProxied(name, args, signal);
    if (r) return r;
  }
  throw new RpcError(-32602, `Unknown tool: ${name}`);
}

function rpcReply(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function dispatch(msg, signal) {
  if (!isObj(msg)) return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object.');
  const hasId = msg.id !== undefined;
  if (typeof msg.method !== 'string') {
    // A response to a request we never send, or garbage: nothing to answer.
    if (hasId && ('result' in msg || 'error' in msg)) return null;
    return rpcError(hasId ? msg.id : null, -32600, 'Invalid Request: "method" is missing.');
  }
  if (!hasId) return null; // notification
  if (msg.jsonrpc !== '2.0') return rpcError(msg.id, -32600, 'Invalid Request: "jsonrpc" must be "2.0".');
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        return rpcReply(id, {
          protocolVersion: negotiateVersion(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NAME, title: 'Agent Automation companion', version: VERSION },
          instructions:
            `These tools act directly on the user's own computer (${osName()}, user "${userName()}", home folder ${HOME}). ` +
            'Paths may start with ~. Prefer read_file, list_directory and find_files to shell commands for looking at files, and confirm before deleting or overwriting anything important.',
        });
      case 'ping':
        return rpcReply(id, {});
      case 'tools/list':
        return rpcReply(id, { tools: await listAllTools() });
      case 'tools/call':
        return rpcReply(id, await callTool(params, signal));
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (e instanceof RpcError) return rpcError(id, e.code, e.message);
    log('ERROR', `${method} failed: ${e?.stack || e}`);
    return rpcError(id, -32603, `Internal error: ${e?.message || e}`);
  }
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'This MCP endpoint only accepts POST (no SSE stream is offered).' }, { Allow: 'POST' });
  const body = await readBody(req);
  let msg;
  try {
    msg = JSON.parse(body.toString('utf8'));
  } catch {
    return send(res, 400, rpcError(null, -32700, 'Parse error: the request body is not valid JSON.'));
  }
  // The extension's Stop button aborts the fetch: stop the work that was started for it.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  let reply;
  if (Array.isArray(msg)) {
    if (!msg.length) return send(res, 400, rpcError(null, -32600, 'Invalid Request: empty batch.'));
    reply = (await Promise.all(msg.map((m) => dispatch(m, ac.signal)))).filter(Boolean);
    if (!reply.length) reply = null;
  } else reply = await dispatch(msg, ac.signal);
  if (ac.signal.aborted) return;
  if (!reply) {
    res.writeHead(202, { 'Content-Length': '0', 'Cache-Control': 'no-store' });
    return res.end();
  }
  send(res, 200, reply);
}

// ---------------------------------------------------------------- HTTP server

let listenHost = DEFAULT_HOST;
let listenPort = DEFAULT_PORT;
let remoteMode = false;

const isLoopbackName = (h) => h === 'localhost' || h === '[::1]' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);

function hostnameOf(hostHeader) {
  const h = String(hostHeader).toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i >= 0 ? h.slice(0, i) : h;
}

function hostAllowed(hostHeader) {
  if (remoteMode) return true;
  if (!hostHeader) return false;
  return isLoopbackName(hostnameOf(hostHeader));
}

function originAllowed(origin) {
  if (/^chrome-extension:\/\/[A-Za-z0-9_-]+$/.test(origin)) return true;
  // A loopback page is accepted only on the companion's own port, so other local dev servers can't reach it.
  const loopback = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/.exec(origin);
  if (loopback && (loopback[1] ?? '80') === String(listenPort)) return true;
  const own = listenHost.includes(':') ? `[${listenHost}]` : listenHost;
  return origin === `http://${own}:${listenPort}`;
}

function authorized(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  return crypto.timingSafeEqual(sha256(m ? m[1] : ''), sha256(config.token)) && !!m;
}

function send(res, status, obj, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new HttpError(413, `The request is too large (limit ${fmtBytes(limit)}).`));
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      finish(reject, new HttpError(408, 'Timed out waiting for the request body.'));
      req.destroy();
    }, 120000);
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > limit) {
        finish(reject, new HttpError(413, `The request is too large (limit ${fmtBytes(limit)}).`));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (e) => finish(reject, new HttpError(400, `Could not read the request: ${e.message}`)));
    req.on('aborted', () => finish(reject, new HttpError(400, 'The request was aborted.')));
  });
}

function statusBody() {
  const tools = [
    ...BUILTINS.filter(toolEnabled).map((t) => ({ name: t.name, description: t.description(), server: 'builtin' })),
    ...proxyEntries().map((e) => ({ name: e.name, description: e.tool.description || '', server: e.server.name })),
  ];
  return {
    version: VERSION,
    platform: process.platform,
    user: userName(),
    home: HOME,
    config: { allowShell: config.allowShell, allowWrite: config.allowWrite, commandTimeoutSec: config.commandTimeoutSec },
    tools,
    servers: [...servers.values()].map((s) => s.statusEntry()),
  };
}

async function handleConfig(req, res) {
  if (req.method === 'GET') return send(res, 200, publicConfig());
  if (req.method !== 'PUT') return send(res, 405, { error: 'Use GET or PUT.' }, { Allow: 'GET, PUT' });
  const body = await readBody(req, 1024 * 1024);
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
  const patch = checkConfigPatch(parsed);
  // One change at a time, so the file and the running servers always agree.
  const job = configQueue.then(async () => {
    const next = { ...config, ...patch, token: config.token };
    try {
      persistConfig(next);
    } catch (e) {
      throw new HttpError(500, `Could not save the settings to ${configFile}: ${e.message}`);
    }
    config = next;
    if ('mcpServers' in patch) reconcileServers(true);
    event(`Settings changed (${Object.keys(patch).join(', ') || 'nothing'}).`);
  });
  configQueue = job.catch(() => {});
  await job;
  await settleServers(3000);
  send(res, 200, statusBody());
}

async function route(req, res) {
  const pathname = (req.url || '/').split('?')[0];
  if (!hostAllowed(req.headers.host)) {
    log('WARN', `Refused a request with Host "${req.headers.host}" (possible DNS rebinding).`);
    return send(res, 403, { error: 'Forbidden: the companion only answers requests addressed to 127.0.0.1 or localhost.' });
  }
  // No CORS at all: browsers can never get a web page's cross-origin request through.
  if (req.method === 'OPTIONS') return send(res, 403, { error: 'Forbidden: cross-origin requests are not allowed.' });
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(origin)) {
    log('WARN', `Refused a request from origin ${origin}.`);
    return send(res, 403, { error: `Forbidden: requests from web pages (${origin}) are not allowed.` });
  }
  if (pathname === '/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Use GET.' }, { Allow: 'GET' });
    return send(res, 200, { ok: true, name: NAME, version: VERSION });
  }
  if (!authorized(req.headers.authorization)) {
    log('WARN', `Refused a request to ${pathname} without the right token.`);
    return send(
      res,
      401,
      { error: 'Missing or wrong token. Copy the token shown by the companion (or run: node agent-companion.mjs --print-token) into the extension: Settings → Computer tools.' },
      { 'WWW-Authenticate': 'Bearer' },
    );
  }
  switch (pathname) {
    case '/mcp':
      return handleMcp(req, res);
    case '/status':
      return req.method === 'GET' ? send(res, 200, statusBody()) : send(res, 405, { error: 'Use GET.' }, { Allow: 'GET' });
    case '/config':
      return handleConfig(req, res);
    default:
      return send(res, 404, { error: `Not found: ${pathname}. Endpoints: /health, /mcp, /status, /config.` });
  }
}

async function handleRequest(req, res) {
  try {
    await route(req, res);
  } catch (e) {
    if (e instanceof HttpError) {
      send(res, e.status, { error: e.message }, e.status === 413 || e.status === 408 ? { Connection: 'close' } : {});
      if (e.status === 413) res.on('finish', () => setTimeout(() => req.destroy(), 1000).unref());
      return;
    }
    log('ERROR', `Request ${req.method} ${req.url} failed: ${e?.stack || e}`);
    send(res, 500, { error: `Internal error: ${e?.message || e}` });
  }
}

function checkExisting(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b).name === NAME);
        } catch {
          resolve(false);
        }
      });
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => {
      r.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------- autostart

function defaultHome() {
  return path.join(HOME, '.agent-automation');
}

function resolveHome(flag) {
  const h = flag || process.env.AGENT_COMPANION_HOME || defaultHome();
  return path.resolve(h.replace(/^~(?=$|[\\/])/, HOME));
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const systemdQuote = (a) => `"${String(a).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// process.execPath can be a versioned path (Homebrew's Cellar/node/26.5.0/…) that disappears on upgrade:
// prefer a stable link on PATH that points at the very same binary.
function stableNodePath() {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const target = real(process.execPath);
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const d of dirs) {
    if (!d || !path.isAbsolute(d) || d.includes(`${path.sep}Cellar${path.sep}`)) continue;
    const candidate = path.join(d, IS_WIN ? 'node.exe' : 'node');
    if (candidate !== process.execPath && target && real(candidate) === target) return candidate;
  }
  return process.execPath;
}

function autostartPlan(opts, home, uninstall) {
  const src = fileURLToPath(import.meta.url);
  const dest = path.join(home, 'agent-companion.mjs');
  const extra = [];
  if (opts.port !== undefined && opts.port !== DEFAULT_PORT) extra.push('--port', String(opts.port));
  if (opts.host) extra.push('--host', opts.host);
  if (path.resolve(home) !== path.resolve(defaultHome())) extra.push('--home', home);
  const argv = [stableNodePath(), dest, ...extra];
  const plan = { copy: null, write: [], remove: [], run: [], notes: [], dest, argv };
  if (!uninstall && !samePath(src, dest)) plan.copy = { from: src, to: dest };
  if (uninstall && !samePath(src, dest)) plan.remove.push(dest);
  if (IS_MAC) {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const domain = `gui/${process.getuid()}`;
    plan.run.push({ argv: ['launchctl', 'bootout', `${domain}/${LABEL}`], ignore: true, why: 'stops a running copy, if any' });
    if (uninstall) plan.remove.push(plist);
    else {
      const logFile = path.join(home, 'autostart.log');
      plan.write.push({
        path: plist,
        mode: 0o644,
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xmlEsc(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEsc(HOME)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEsc(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEsc(logFile)}</string>
</dict>
</plist>
`,
      });
      plan.run.push({ argv: ['launchctl', 'enable', `${domain}/${LABEL}`], ignore: true });
      plan.run.push({ argv: ['launchctl', 'bootstrap', domain, plist], fallback: ['launchctl', 'load', '-w', plist] });
    }
  } else if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    const launcher = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'agent-companion.cmd');
    if (uninstall) {
      plan.remove.push(launcher);
      plan.notes.push('If the companion is running now, close its "Agent Automation companion" window to stop it.');
    } else {
      const q = (a) => `"${String(a).replace(/%/g, '%%')}"`;
      plan.write.push({
        path: launcher,
        content: `@echo off\r\nrem Starts the Agent Automation companion at login. Remove with: node agent-companion.mjs --uninstall-autostart\r\nstart "Agent Automation companion" /min ${argv.map(q).join(' ')}\r\n`,
      });
      plan.run.push({ argv: [process.env.ComSpec || 'cmd.exe', '/d', '/c', launcher], detach: true, why: 'starts it now' });
    }
  } else {
    const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'systemd', 'user');
    const unit = path.join(unitDir, 'agent-companion.service');
    if (uninstall) {
      plan.run.push({ argv: ['systemctl', '--user', 'disable', '--now', 'agent-companion.service'], ignore: true });
      plan.remove.push(unit);
      plan.run.push({ argv: ['systemctl', '--user', 'daemon-reload'], ignore: true, after: true });
    } else {
      plan.write.push({
        path: unit,
        content: `[Unit]
Description=Agent Automation companion (computer tools for the browser extension)

[Service]
ExecStart=${argv.map(systemdQuote).join(' ')}
WorkingDirectory=%h
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
      });
      plan.run.push({ argv: ['systemctl', '--user', 'daemon-reload'] });
      plan.run.push({ argv: ['systemctl', '--user', 'enable', '--now', 'agent-companion.service'] });
    }
  }
  return plan;
}

const showCmd = (argv) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');

async function autostart(opts, home) {
  const uninstall = opts.uninstall;
  const plan = autostartPlan(opts, home, uninstall);
  const steps = [];
  if (plan.copy) steps.push({ text: `copy ${plan.copy.from}\n     to ${plan.copy.to}` });
  for (const r of plan.run.filter((r) => !r.after && uninstall)) steps.push({ text: `run  ${showCmd(r.argv)}${r.ignore ? '   (errors ignored)' : ''}` });
  for (const w of plan.write) steps.push({ text: `write ${w.path}:\n${w.content.replace(/^/gm, '     | ')}` });
  for (const p of plan.remove) steps.push({ text: `delete ${p}` });
  for (const r of plan.run.filter((r) => r.after || !uninstall))
    steps.push({ text: `run  ${showCmd(r.argv)}${r.fallback ? `\n     (if that fails: ${showCmd(r.fallback)})` : ''}${r.ignore ? '   (errors ignored)' : ''}` });

  if (opts.dryRun) {
    say(`Dry run: nothing is changed. ${uninstall ? 'Removing' : 'Installing'} autostart would:`);
    for (const s of steps) say(`  - ${s.text}`);
    if (!uninstall) say(`\nThe companion would then start at every login as: ${showCmd(plan.argv)}`);
    for (const n of plan.notes) say(n);
    if (!IS_MAC) say(`\nNote: autostart on ${osName()} has not been tested yet.`);
    return 0;
  }

  try {
    if (!uninstall) {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      logger = new Logger(path.join(home, 'companion.log'));
      const { warnings } = loadConfig(path.join(home, 'companion.json'));
      warnings.forEach(warn);
      if (plan.copy) fs.copyFileSync(plan.copy.from, plan.copy.to);
    }
    const exec = async (r) => {
      if (r.detach) {
        spawn(r.argv[0], r.argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
        return true;
      }
      let res = await runProcess(r.argv[0], r.argv.slice(1), { timeoutMs: 20000 });
      if (!res.error && res.code === 0) return true;
      if (r.fallback) {
        await sleep(1000);
        res = await runProcess(r.argv[0], r.argv.slice(1), { timeoutMs: 20000 });
        if (!res.error && res.code === 0) return true;
        res = await runProcess(r.fallback[0], r.fallback.slice(1), { timeoutMs: 20000 });
        if (!res.error && res.code === 0) return true;
      }
      if (!r.ignore) throw new Error(`${showCmd(r.argv)} failed: ${(res.stderr || res.stdout || res.error?.message || '').trim()}`);
      return false;
    };
    if (uninstall) for (const r of plan.run.filter((r) => !r.after)) await exec(r);
    for (const w of plan.write) {
      fs.mkdirSync(path.dirname(w.path), { recursive: true });
      fs.writeFileSync(w.path, w.content, { mode: w.mode ?? 0o644 });
    }
    for (const p of plan.remove) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    for (const r of plan.run.filter((r) => r.after || !uninstall)) await exec(r);
  } catch (e) {
    console.error(`Could not ${uninstall ? 'remove' : 'set up'} autostart: ${e.message}`);
    return 1;
  }

  if (uninstall) {
    say(`Autostart removed. Your settings and token were kept in ${home}.`);
    for (const n of plan.notes) say(n);
    return 0;
  }
  const port = opts.port ?? DEFAULT_PORT;
  say(`Autostart is set up: the companion now starts automatically when you log in${IS_WIN ? '' : ', and it is starting now'}.`);
  say(`  Program   ${plan.dest}`);
  say(`  URL       http://127.0.0.1:${port}`);
  say(`  Token     ${config.token}`);
  say('\nPaste the token into the extension: Settings → Computer tools');
  if (!IS_MAC) say(`Note: autostart on ${osName()} has not been tested yet; if the companion is not running after you log in again, start it by hand.`);
  if (opts.port !== 0) {
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      if (await checkExisting(port)) {
        say('It is running.');
        return 0;
      }
    }
    say(`It did not answer yet. If it does not start, look at ${path.join(home, IS_MAC ? 'autostart.log' : 'companion.log')}.`);
  }
  return 0;
}

// ---------------------------------------------------------------- main

const USAGE = `Agent Automation companion ${VERSION}
Gives the Agent Automation browser extension tools for this computer (shell, files,
clipboard) and runs local stdio MCP servers for it.

Usage: node agent-companion.mjs [options]

  --port <n>             Port to listen on (default ${DEFAULT_PORT}; 0 picks any free port)
  --host <address>       Address to listen on (default ${DEFAULT_HOST}). Anything other than a
                         loopback address exposes shell access to your network: avoid it.
  --home <dir>           Folder for companion.json and companion.log
                         (default ~/.agent-automation, or $AGENT_COMPANION_HOME)
  --print-token          Print the access token and exit
  --install-autostart    Start the companion automatically at login, then exit
  --uninstall-autostart  Stop starting it at login, then exit
  --dry-run              With --install-autostart / --uninstall-autostart: only show what
                         would be written and run, change nothing
  --version              Print the version and exit
  --help                 Show this help`;

function parseArgs(argv) {
  const o = { printToken: false, install: false, uninstall: false, dryRun: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      if (eq > 0) return a.slice(eq + 1);
      if (i + 1 >= argv.length) throw new Error(`${key} needs a value.`);
      return argv[++i];
    };
    switch (key) {
      case '--port': {
        const v = value();
        const n = Number(v);
        if (!/^\d+$/.test(v) || n > 65535) throw new Error(`--port must be a number from 0 to 65535 (got "${v}").`);
        o.port = n;
        break;
      }
      case '--host':
        o.host = value().trim();
        if (!o.host) throw new Error('--host needs an address.');
        break;
      case '--home':
        o.home = value();
        break;
      case '--print-token':
        o.printToken = true;
        break;
      case '--install-autostart':
        o.install = true;
        break;
      case '--uninstall-autostart':
        o.uninstall = true;
        break;
      case '--dry-run':
        o.dryRun = true;
        break;
      case '--help':
      case '-h':
        o.help = true;
        break;
      case '--version':
      case '-v':
        o.version = true;
        break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  if (o.install && o.uninstall) throw new Error('Use either --install-autostart or --uninstall-autostart, not both.');
  if (o.dryRun && !o.install && !o.uninstall) throw new Error('--dry-run only applies to --install-autostart and --uninstall-autostart.');
  return o;
}

let httpServer = null;
let shuttingDown = false;

async function shutdown(reason) {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  event(`Stopping (${reason})…`);
  try {
    httpServer?.close();
    httpServer?.closeAllConnections?.();
  } catch {}
  for (const c of runningCommands) killTree(c, 'SIGTERM');
  await waitFor(Promise.all([...servers.values()].map((s) => s.stop())), 2700);
  for (const c of runningCommands) killTree(c, 'SIGKILL');
  log('INFO', 'Stopped.');
  process.exit(0);
}

async function main() {
  process.stdout.on?.('error', () => {});
  process.stderr.on?.('error', () => {});
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nRun "node agent-companion.mjs --help" to see the options.`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) return say(USAGE);
  if (opts.version) return say(VERSION);
  const home = resolveHome(opts.home);
  if (opts.install || opts.uninstall) {
    process.exitCode = await autostart(opts, home);
    return;
  }

  try {
    const existed = fs.existsSync(home);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    if (!IS_WIN && (!existed || path.resolve(home) === path.resolve(defaultHome()))) fs.chmodSync(home, 0o700);
  } catch (e) {
    console.error(`Cannot use the folder ${home}: ${e.message}\nChoose another one with --home <dir>.`);
    process.exitCode = 1;
    return;
  }
  logger = new Logger(path.join(home, 'companion.log'));
  if (!opts.printToken) log('INFO', `Starting ${VERSION} (pid ${process.pid}, Node ${process.version}).`);
  // The autostart log is written by launchd and is never rotated; keep it small.
  try {
    const al = path.join(home, 'autostart.log');
    if (fs.statSync(al).size > 1024 * 1024) fs.truncateSync(al, 0);
  } catch {}
  const { warnings, created } = loadConfig(path.join(home, 'companion.json'));
  if (opts.printToken) return say(config.token);

  process.on('uncaughtException', (e) => {
    log('ERROR', `Unexpected error (the companion keeps running): ${e?.stack || e}`);
    try {
      process.stderr.write(`Unexpected error (the companion keeps running): ${e?.message || e}\n`);
    } catch {}
  });
  process.on('unhandledRejection', (e) => {
    log('ERROR', `Unhandled promise rejection (the companion keeps running): ${e?.stack || e}`);
  });

  listenHost = opts.host || DEFAULT_HOST;
  listenPort = opts.port ?? DEFAULT_PORT;
  remoteMode = !isLoopbackName(listenHost.toLowerCase());

  loginPath = resolveLoginPath().catch(() => process.env.PATH || '');

  httpServer = http.createServer({ requestTimeout: 0, headersTimeout: 60000 }, handleRequest);
  httpServer.on('clientError', (e, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {}
  });
  try {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen({ port: listenPort, host: listenHost }, resolve);
    });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      const ours = await checkExisting(listenPort);
      console.error(
        `Port ${listenPort} is already in use${ours ? ' by another Agent Automation companion, which is already running' : ' by another program'}.\n` +
          `${ours ? 'Use that one, or stop it first. ' : ''}To run on a different port: node agent-companion.mjs --port ${listenPort === 65535 ? 8766 : listenPort + 1}\n` +
          '(then change the URL in the extension: Settings → Computer tools)',
      );
      log('ERROR', `Port ${listenPort} is already in use.`);
      process.exit(3);
    }
    console.error(
      e.code === 'EACCES'
        ? `Not allowed to listen on port ${listenPort}. Choose a port above 1024 with --port.`
        : e.code === 'EADDRNOTAVAIL'
          ? `This computer has no address ${listenHost}. Leave out --host to use 127.0.0.1.`
          : `Could not start the server: ${e.message}`,
    );
    process.exit(1);
  }
  httpServer.on('error', (e) => log('ERROR', `Server error: ${e.message}`));
  listenPort = httpServer.address().port;

  const shownHost = remoteMode ? (listenHost.includes(':') ? `[${listenHost}]` : listenHost) : '127.0.0.1';
  const url = `http://${shownHost}:${listenPort}`;
  const tokenLine = process.stdout.isTTY ? config.token : '(hidden because the output is not a terminal; run with --print-token to show it)';
  say(`
Agent Automation companion ${VERSION}
  URL      ${url}
  Token    ${tokenLine}
  Config   ${configFile}
  Log      ${logger.file}

Paste the token into the extension: Settings → Computer tools
Shell commands: ${config.allowShell ? 'allowed' : 'off'}   File writing: ${config.allowWrite ? 'allowed' : 'off'}   MCP servers: ${Object.keys(config.mcpServers).length}
Press Ctrl+C to stop.
`);
  if (created) say(`A new token was created and saved in ${configFile}.\n`);
  warnings.forEach(warn);
  if (remoteMode) {
    const bar = '!'.repeat(78);
    process.stderr.write(
      `${bar}\n!! WARNING: listening on ${listenHost}, not only on this computer.\n` +
        '!! Anyone on your network who learns the token can run commands as you, and the token travels\n' +
        '!! unencrypted over plain HTTP. Only do this on a network you fully trust.\n' +
        `${bar}\n`,
    );
    log('WARN', `Listening on non-loopback address ${listenHost}.`);
  }
  log('INFO', `Started ${VERSION} on ${url} (pid ${process.pid}).`);

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
  reconcileServers();
  fs.watchFile(configFile, { interval: 2000, persistent: false }, () => {
    try {
      reloadConfigFromDisk();
    } catch (e) {
      log('WARN', `Could not reload companion.json: ${e.message}`);
    }
  });
}

main().catch((e) => {
  log('ERROR', `Fatal: ${e?.stack || e}`);
  console.error(`The companion could not start: ${e?.message || e}`);
  process.exit(1);
});

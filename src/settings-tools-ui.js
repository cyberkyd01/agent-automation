// Settings sections for tools that run outside the browser: the local companion program ("Computer tools"),
// "Remote access" (the companion's Cloudflare tunnel), the "Add from connection code" form of Providers and the
// per-server Test button of "Remote MCP servers".
// settings-ui.js hands in its own field helpers (`kit`), so everything here looks and behaves like the rest of
// Settings. The pure helpers below are exported so they can be tested without a DOM.
import { newId, repoLink } from './util.js';

const DEFAULT_URL = 'http://127.0.0.1:8765';
const DEFAULT_COMPANION = { enabled: false, url: DEFAULT_URL, token: '', approval: 'ask' };

export const APPROVAL_OPTIONS = [
  ['ask', 'Always ask before computer tools (recommended)'],
  ['follow', 'Follow the chat’s approval mode'],
];

export const QUEUE_MODES = [
  ['auto', 'Run all (start the next prompt straight away)'],
  ['step', 'One at a time (wait for you after each prompt)'],
];

const NAME_RE = /^[A-Za-z0-9_-]+$/;
// /status reports the built-in tools as server 'builtin', so a stdio server may not take that name.
const RESERVED_NAMES = ['builtin'];
const STATUS_TIMEOUT = 8000;
const APPLY_TIMEOUT = 30000;
const POLL_MS = 1500;
const POLL_MAX = 6;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- settings defaults ---------- */

// Settings saved by v1.0 have none of the new fields; fill them in without trusting what is stored.
export function ensureToolSettings(settings, defaults = {}) {
  const base = { ...DEFAULT_COMPANION, ...(isObj(defaults.companion) ? defaults.companion : {}) };
  if (!isObj(settings.companion)) settings.companion = {};
  const c = settings.companion;
  for (const k of Object.keys(base)) if (c[k] === undefined) c[k] = base[k];
  c.enabled = !!c.enabled;
  c.url = typeof c.url === 'string' && c.url.trim() ? c.url.trim() : base.url;
  c.token = typeof c.token === 'string' ? c.token : '';
  c.approval = c.approval === 'follow' ? 'follow' : 'ask';
  if (!QUEUE_MODES.some(([v]) => v === settings.queueMode)) settings.queueMode = defaults.queueMode === 'step' ? 'step' : 'auto';
  if (!Array.isArray(settings.mcpServers)) settings.mcpServers = [];
  // v1.2: 0 = no step limit; settings saved by older versions may lack both fields.
  const steps = Number(settings.maxSteps ?? 0);
  settings.maxSteps = Number.isFinite(steps) && steps >= 0 ? Math.round(steps) : 0;
  settings.notifications = settings.notifications == null ? defaults.notifications !== false : !!settings.notifications;
}

/* ---------- pure helpers ---------- */

// Keeps just scheme://host:port (what the companion's endpoints hang off). null when it cannot be an address.
export function normalizeCompanionUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return DEFAULT_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

const isLoopbackUrl = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '[::1]' || /^127\./.test(h);
  } catch {
    return true;
  }
};

// One argument per line. Blank lines are dropped and edge whitespace trimmed; quotes are left exactly as typed.
export function parseArgs(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export const formatArgs = (args) => (Array.isArray(args) ? args.map(str).join('\n') : '');

// One KEY=value per line, split at the FIRST '='. `bad` lists the 1-based line numbers that are not in that form.
export function parseEnv(text) {
  const entries = [];
  const bad = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const eq = line.indexOf('=');
      const key = eq > 0 ? line.slice(0, eq).trim() : '';
      if (!key || /\s/.test(key)) bad.push(i + 1);
      else entries.push([key, line.slice(eq + 1).trim()]);
    });
  return { env: Object.fromEntries(entries), bad };
}

export const formatEnv = (env) => (isObj(env) ? Object.entries(env).map(([k, v]) => `${k}=${str(v)}`).join('\n') : '');

// '' when the name is usable. `siblings` are the other servers' names.
export function checkServerName(name, siblings = [], { allowEmpty = false } = {}) {
  if (!name) return allowEmpty ? '' : 'Give the server a name.';
  if (!NAME_RE.test(name)) return 'Use only letters, numbers, - and _ (no spaces).';
  if (RESERVED_NAMES.includes(name.toLowerCase())) return `“${name}” is reserved. Pick another name.`;
  if (siblings.includes(name)) return 'Another server already uses this name.';
  return '';
}

// Draft (editor state) → the object the companion's /config expects.
export function serverBody(d) {
  const b = { command: d.command, args: [...d.args], env: { ...d.env } };
  if (d.cwd) b.cwd = d.cwd;
  b.disabled = !!d.disabled;
  return b;
}

const EXAMPLE_JSON = '{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] } } }';

// Accepts Claude Desktop's { "mcpServers": { name: {command, args, env} } }, the inner map alone, or one bare server.
// → { ok: true, servers: [{ name, command, args, env, cwd, disabled }], notes: string[] } | { ok: false, error }
export function parseMcpJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: 'Paste the JSON first.' };
  let root;
  try {
    root = JSON.parse(raw);
  } catch (e) {
    // A common slip: copying `"name": { … }` without the outer braces.
    try {
      if (!raw.startsWith('"')) throw e;
      root = JSON.parse(`{${raw.replace(/,\s*$/, '')}}`);
    } catch {
      return { ok: false, error: `That is not valid JSON (${e.message}). Paste a config like ${EXAMPLE_JSON}` };
    }
  }
  if (!isObj(root)) return { ok: false, error: `Expected a JSON object like ${EXAMPLE_JSON}` };

  let map;
  if ('mcpServers' in root) {
    if (!isObj(root.mcpServers)) return { ok: false, error: '“mcpServers” must be an object with one entry per server.' };
    map = root.mcpServers;
  } else if (typeof root.command === 'string') {
    map = { server: root };
  } else {
    map = root;
  }

  const entries = Object.entries(map);
  if (!entries.length) return { ok: false, error: 'No servers found in that JSON.' };

  const servers = [];
  const errors = [];
  const notes = [];
  for (const [rawName, v] of entries) {
    const label = `“${rawName}”`;
    if (!isObj(v)) {
      errors.push(`${label} must be an object with a "command".`);
      continue;
    }
    if (typeof v.command !== 'string' || !v.command.trim()) {
      errors.push(
        typeof v.url === 'string'
          ? `${label} has a URL, not a command. Remote servers belong under “Remote MCP servers”.`
          : `${label} has no "command".`
      );
      continue;
    }
    if (v.args !== undefined && (!Array.isArray(v.args) || v.args.some((a) => a !== null && typeof a === 'object'))) {
      errors.push(`${label}: "args" must be a list of strings.`);
      continue;
    }
    if (v.env !== undefined && (!isObj(v.env) || Object.values(v.env).some((x) => x === null || typeof x === 'object'))) {
      errors.push(`${label}: "env" must be an object of KEY: "value" pairs.`);
      continue;
    }
    if (v.cwd !== undefined && typeof v.cwd !== 'string') {
      errors.push(`${label}: "cwd" must be a text path.`);
      continue;
    }
    let name = rawName.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'server';
    if (RESERVED_NAMES.includes(name.toLowerCase())) name += '_server';
    for (let k = 2; servers.some((s) => s.name === name); k++) name = `${name.replace(/_\d+$/, '')}_${k}`;
    if (name !== rawName) notes.push(`Renamed “${rawName}” to “${name}” (names allow only letters, numbers, - and _).`);
    servers.push({
      name,
      command: v.command.trim(),
      args: (v.args || []).map((a) => str(a)),
      env: Object.fromEntries(Object.entries(v.env || {}).map(([k, x]) => [k, str(x)])),
      cwd: str(v.cwd).trim(),
      disabled: v.disabled === true,
    });
  }
  if (errors.length) return { ok: false, error: errors.join('\n') };
  return { ok: true, servers, notes };
}

// What went wrong, in plain words: { kind, parts: (string | { code })[], hint? }.
// `r` is a result of `request()`. `what`: 'connect' (Test connection), 'refresh' or 'apply'.
export function explainFailure(r, { base, what = 'connect', version = '' } = {}) {
  const ver = version ? ` (version ${version})` : '';
  const detail = r.error ? ` — ${r.error}` : '';
  const editsKept = what === 'apply' ? 'Your edits are still here; fix this and click Apply again.' : '';
  if (r.net === 'down') {
    return {
      kind: 'error',
      parts: [`The companion is not running at ${base}. Start it with: `, { code: 'node agent-companion.mjs' }],
      hint: what === 'apply' ? 'Your edits are still here; start it, then click Apply again.' : 'Already running? Check the Address above, including the port.',
    };
  }
  if (r.net === 'timeout') {
    return what === 'apply'
      ? {
          kind: 'error',
          parts: [`The companion did not answer within ${APPLY_TIMEOUT / 1000} seconds, so it is not clear whether your changes were applied.`],
          hint: 'Click Refresh to see what it is running now. Your edits are still here.',
        }
      : {
          kind: 'error',
          parts: [`${base} did not answer within ${STATUS_TIMEOUT / 1000} seconds.`],
          hint: 'Check the Address above, and that the companion (not something else) is using that port.',
        };
  }
  if (r.status === 401) {
    return {
      kind: 'error',
      parts: [`The companion${ver} is running but rejected the token${what === 'apply' ? ', so nothing was applied' : ''}.`],
      hint: 'Copy the token it printed when it started into the Token field above. If you restarted it with a new token, use that one.',
    };
  }
  if (r.status === 403) {
    return {
      kind: 'error',
      parts: [`The companion${ver} is refusing this connection (HTTP 403). It does not accept requests from this extension’s origin.${what === 'apply' ? ' Nothing was applied.' : ''}`],
      hint: 'Update agent-companion.mjs to the latest version, restart it, and try again.',
    };
  }
  if (r.status === 404) {
    return {
      kind: 'error',
      parts: [`This companion does not support that request (HTTP 404). It is probably an older version.`],
      hint: 'Update agent-companion.mjs to the latest version and restart it.',
    };
  }
  if (r.bad) {
    return {
      kind: 'error',
      parts: [`Something answered at ${base}, but it does not look like the Agent Automation companion.`],
      hint: 'Check the Address above, including the port.',
    };
  }
  if (what === 'apply' && (r.status === 400 || r.status === 422)) {
    return { kind: 'error', parts: [`The companion did not accept these settings${detail || ` (HTTP ${r.status})`}.`], hint: editsKept };
  }
  return {
    kind: 'error',
    parts: [`The companion answered with an error (HTTP ${r.status}${detail}).`],
    hint: editsKept || 'Check the companion’s terminal window for details.',
  };
}

// Never throws: network trouble comes back as { net: 'down' | 'timeout' }.
async function request(base, token, method, path, { body, timeout = STATUS_TIMEOUT } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers, signal: AbortSignal.timeout(timeout), cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(base + path, init);
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, status: 0, net: timedOut ? 'timeout' : 'down', data: null, error: '' };
  }
  let text = '';
  let data = null;
  try {
    text = await res.text();
  } catch {}
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  const error = typeof data?.error === 'string' ? data.error : data?.error?.message || (data ? '' : text.slice(0, 200));
  return { ok: res.ok, status: res.status, net: '', data, error };
}

// `prepare` runs just before the fallback selects `node` (for text that is hidden or masked until then).
async function copyText(text, node, prepare) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  // Fallback: select the text so Ctrl/Cmd+C works even if programmatic copying is blocked.
  try {
    prepare?.();
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return !!document.execCommand?.('copy');
  } catch {
    return false;
  }
}

function extLink(href, text) {
  const a = document.createElement('a');
  a.className = 'tools-link';
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}

// A Copy button whose label flips to "Copied" (or "Ctrl/⌘+C" when the clipboard is blocked) for a moment.
// `getText()` is read at click time; `getNode()` is what the blocked-clipboard fallback selects.
function wireCopy(btn, getText, getNode, prepare) {
  let timer = 0;
  btn.addEventListener('click', async () => {
    const text = getText();
    if (!text) return;
    const ok = await copyText(text, getNode(), prepare);
    btn.textContent = ok ? 'Copied' : 'Ctrl/⌘+C';
    clearTimeout(timer);
    timer = setTimeout(() => (btn.textContent = 'Copy'), 1800);
  });
}

// Monospace text with a Copy button beside it.
function makeCodeBlock(kit, text, label) {
  const { el, button } = kit;
  const wrap = el('div', 'codeblock');
  const code = el('code', 'codeblock-text', text);
  const copy = button('Copy');
  copy.setAttribute('aria-label', label);
  wireCopy(copy, () => text, () => code);
  wrap.append(code, copy);
  return wrap;
}

/* ---------- v1.2 helpers: private addresses, connection codes, failures ---------- */

const normUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '');

// True when the URL points at this computer or the local network (what a tunnel can usefully expose).
export function isPrivateUrl(raw) {
  let h;
  try {
    const u = new URL(String(raw ?? '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    h = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe80:/.test(h) ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h)
  );
}

// The name an extension provider is exposed under on the companion: [A-Za-z0-9_-]{1,32}, unique among `taken`.
export function upstreamName(provider, taken = []) {
  const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  const base = clean(provider?.name) || clean(provider?.id && `provider-${provider.id}`) || 'model';
  let name = base;
  for (let k = 2; taken.includes(name); k++) {
    const suffix = `-${k}`;
    name = base.slice(0, 32 - suffix.length) + suffix;
  }
  return name;
}

const CODE_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const httpUrl = (s) => {
  try {
    const u = new URL(String(s).trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u : null;
  } catch {
    return null;
  }
};

// "aa1:" + base64url(JSON { u: link, t: token, llm: { name: '<link>/llm/<name>' }, mcp: '<link>/mcp' | null }).
// → { ok: true, url, token, models: [{ name, baseUrl }], mcp: string | null } | { ok: false, error }
export function parseConnectionCode(raw) {
  const bad = (error) => ({ ok: false, error });
  const s = String(raw ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '');
  if (!s) return bad('Paste the connection code first.');
  if (!/^aa1:/i.test(s)) {
    return bad('That is not a connection code: it should start with “aa1:”. Copy it again from Settings → Remote access on the computer that runs the tunnel.');
  }
  const body = s.slice(4);
  if (!body) return bad('The code is empty after “aa1:”. Copy it again in full.');
  if (!/^[A-Za-z0-9_\-+/]+={0,2}$/.test(body)) {
    return bad('The code is damaged: it contains characters that cannot be part of a code. Copy it again in full.');
  }
  let text;
  try {
    const std = body.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return bad('The code is damaged: it is not valid base64, so part of it was probably cut off. Copy it again in full.');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return bad('The code is damaged: what is inside it is not valid data. Copy it again in full.');
  }
  if (!isObj(data)) return bad('The code is damaged: it does not contain the expected data.');

  const link = typeof data.u === 'string' ? httpUrl(data.u) : null;
  if (typeof data.u !== 'string' || !data.u.trim()) return bad('The code has no tunnel link. Copy it again from the computer that runs the tunnel.');
  if (!link) return bad('The code contains a tunnel link that is not a web address.');
  // Tunnels are always https; a code that names plain http on the internet would send the token unencrypted.
  if (link.protocol === 'http:' && !isPrivateUrl(link.href)) {
    return bad('The code points to an unencrypted (http) address on the internet, so it is refused: the access token would travel in the clear. Tunnel links start with https.');
  }
  const token = typeof data.t === 'string' ? data.t.trim() : '';
  if (!token) return bad('The code has no access token. Copy it again from the computer that runs the tunnel.');
  const llm = data.llm == null ? {} : data.llm;
  if (!isObj(llm)) return bad('The code lists its models in a form this version cannot read.');

  const url = normUrl(link.href);
  const models = [];
  for (const [name, given] of Object.entries(llm)) {
    if (!CODE_NAME_RE.test(name)) return bad(`The code lists a model with an unusable name (“${name.slice(0, 40)}”).`);
    const g = typeof given === 'string' ? httpUrl(given) : null;
    // The token only ever goes to the tunnel the code names, whatever else the code claims.
    const baseUrl = g && g.origin === link.origin ? normUrl(g.href) : `${url}/llm/${name}`;
    models.push({ name, baseUrl });
  }
  // `mcp` is null unless the other computer has "Expose computer tools" on (a guessed <u>/mcp would be refused
  // there), so it is never derived. An address on another origin is dropped like the model ones.
  const m = typeof data.mcp === 'string' && data.mcp.trim() ? httpUrl(data.mcp) : null;
  const mcp = m && m.origin === link.origin ? normUrl(m.href) : null;
  return { ok: true, url, token, models, mcp };
}

// Adds what a parsed code describes to `settings`: one openai provider per model (skipping base URLs that already
// exist) and, with `mcp`, a remote MCP server. Returns what happened.
export function applyConnectionCode(settings, parsed, { mcp = false } = {}) {
  if (!Array.isArray(settings.providers)) settings.providers = [];
  if (!Array.isArray(settings.mcpServers)) settings.mcpServers = [];
  const have = new Set(settings.providers.map((p) => normUrl(p.baseUrl)));
  const unique = (base, list) => {
    let name = base;
    for (let k = 2; list.some((x) => x.name === name); k++) name = `${base} ${k}`;
    return name;
  };
  const providers = [];
  let skipped = 0;
  for (const m of parsed.models) {
    if (have.has(normUrl(m.baseUrl))) {
      skipped++;
      continue;
    }
    const p = { id: newId(), name: unique(`${m.name} (remote)`, settings.providers), type: 'openai', baseUrl: m.baseUrl, apiKey: parsed.token, model: '', models: [] };
    settings.providers.push(p);
    have.add(normUrl(m.baseUrl));
    providers.push(p);
  }
  let server = null;
  let serverSkipped = false;
  if (mcp && parsed.mcp) {
    if (settings.mcpServers.some((s) => normUrl(s.url) === normUrl(parsed.mcp))) serverSkipped = true;
    else {
      const names = settings.mcpServers.map((s) => ({ name: s.name }));
      server = { id: newId(), name: unique('remote-computer', names), url: parsed.mcp, headers: `Authorization: Bearer ${parsed.token}`, enabled: true };
      settings.mcpServers.push(server);
    }
  }
  return { providers, skipped, server, serverSkipped };
}

// One plain sentence (or two) for a failed request to the companion.
function failureText(r, base) {
  if (r.status === 400 || r.status === 422) return `The companion did not accept that${r.error ? `: ${r.error}` : ` (HTTP ${r.status})`}.`;
  const f = explainFailure(r, { base, what: 'refresh' });
  const t = f.parts.map((p) => (typeof p === 'string' ? p : p.code)).join('');
  return f.hint ? `${t} ${f.hint}` : t;
}

/* ---------- Computer tools ---------- */

// `hooks` lets the Remote access section follow what this one learns: onStatus(/status body | null when not
// connected) and onConfig(/config body).
export function computerToolsSection(settings, kit, hooks = {}) {
  const { el, textInput, numberInput, textArea, selectBox, checkbox, button, removeButton, field, checkField, section, onChange, bindSelect, commit } = kit;
  const c = settings.companion;

  const root = section(
    'Computer tools',
    'Lets the agent use your own computer: run commands, read and write files, use the clipboard and run local MCP servers. This needs a small companion program running on this computer.'
  );
  root.id = 'computerTools';

  /* --- small builders --- */

  const lineOf = (parts) => {
    const d = el('div');
    for (const p of parts) d.append(typeof p === 'string' ? document.createTextNode(p) : el('code', 'tools-code', p.code));
    return d;
  };
  const msgBox = (id) => {
    const m = el('div', 'tools-msg');
    if (id) m.id = id;
    m.setAttribute('role', 'status');
    m.hidden = true;
    return m;
  };
  const show = (box, kind, parts, hint) => {
    box.className = `tools-msg ${kind}`;
    box.replaceChildren(lineOf(parts));
    if (hint) box.append(el('div', 'tools-msg-hint', hint));
    box.hidden = false;
  };
  const hide = (box) => {
    box.hidden = true;
    box.replaceChildren();
  };
  const showFailure = (box, r, what, version) => {
    const f = explainFailure(r, { base: c.url, what, version });
    show(box, f.kind, f.parts, f.hint);
  };

  const codeBlock = (text, label) => makeCodeBlock(kit, text, label);

  // Adds an inline error line under a field and returns the setter for it.
  const withError = (f, ctl) => {
    const e = el('div', 'field-error');
    e.id = `${ctl.id}-err`;
    e.hidden = true;
    f.append(e);
    ctl.setAttribute('aria-describedby', [ctl.getAttribute('aria-describedby'), e.id].filter(Boolean).join(' '));
    return (text) => {
      e.textContent = text || '';
      e.hidden = !text;
      if (text) ctl.setAttribute('aria-invalid', 'true');
      else ctl.removeAttribute('aria-invalid');
    };
  };

  /* --- set-up steps --- */

  const setup = el('details', 'tools-setup');
  setup.id = 'companionSetup';
  setup.open = !c.token;
  const setupBody = el('div', 'tools-setup-body');
  const steps = el('ol', 'tools-steps');

  const step1 = el('li');
  step1.append('Install Node.js 18 or later (', extLink('https://nodejs.org', 'nodejs.org'), ').');

  const step2 = el('li');
  const dl = repoLink('tools-link', 'agent-companion.mjs', '/releases/latest');
  if (dl) step2.append('Download ', dl, ' from the latest release.');
  else step2.append('Download the file agent-companion.mjs from this project’s releases page.');

  const step3 = el('li');
  step3.append('In a terminal, go to the folder with that file and run:', codeBlock('node agent-companion.mjs', 'Copy command'));

  const step4 = el('li', null, 'Copy the token it prints into the Token field below, and switch Enabled on.');

  steps.append(step1, step2, step3, step4);
  const autostart = el('div', 'tools-setup-extra');
  autostart.append(el('p', 'hint', 'Optional: this makes the companion start every time you log in.'), codeBlock('node agent-companion.mjs --install-autostart', 'Copy autostart command'));
  setupBody.append(steps, autostart);
  setup.append(el('summary', null, 'Set up'), setupBody);
  root.append(setup);

  /* --- companion settings (auto-saved) --- */

  const enabled = checkbox(c.enabled);
  enabled.id = 'companionEnabled';
  const enabledText = () =>
    !c.enabled
      ? 'Off. The agent cannot use computer tools.'
      : !c.token
        ? 'On, but there is no token yet. Paste it below, or computer tools stay unavailable.'
        : 'On. Use Test connection to check that the companion is reachable.';
  const enabledField = checkField('Enabled', enabled, enabledText());
  const paintEnabled = () => (enabledField.querySelector('.hint').textContent = enabledText());
  onChange(enabled, () => {
    c.enabled = enabled.checked;
    paintEnabled();
    if (c.enabled && c.token && !statusData && !busy) connect().catch(() => {});
  });

  const url = textInput(c.url, 'url', DEFAULT_URL);
  url.id = 'companionUrl';
  const urlField = field('Address', url, 'Where the companion is listening. The default works unless you changed its port.');
  const setUrlNote = withError(urlField, url);
  const urlWarn = el('div', 'field-warn');
  urlWarn.hidden = true;
  urlField.append(urlWarn);
  const paintUrlWarn = () => {
    const risky = !isLoopbackUrl(c.url) && c.url.startsWith('http:');
    urlWarn.hidden = !risky;
    urlWarn.textContent = risky ? 'This is not this computer, and http is unencrypted: the token and everything the agent does would cross the network in the clear. Only use a network you trust.' : '';
  };
  paintUrlWarn();
  onChange(url, () => {
    const next = normalizeCompanionUrl(url.value);
    if (!next) {
      setUrlNote(`That does not look like an address. Example: ${DEFAULT_URL}`);
      return;
    }
    setUrlNote('');
    url.value = next;
    if (next === c.url) return;
    c.url = next;
    paintUrlWarn();
    connectionChanged();
  });

  const token = textInput(c.token, 'password', 'Paste the token the companion printed');
  token.id = 'companionToken';
  const tokenField = field('Token', token, 'The companion prints it when it starts. It is stored in this browser only.');
  const reveal = button('Show');
  reveal.id = 'companionTokenToggle';
  reveal.setAttribute('aria-controls', token.id);
  reveal.setAttribute('aria-pressed', 'false');
  reveal.setAttribute('aria-label', 'Show token');
  reveal.addEventListener('click', () => {
    const on = token.type === 'password';
    token.type = on ? 'text' : 'password';
    reveal.textContent = on ? 'Hide' : 'Show';
    reveal.setAttribute('aria-pressed', String(on));
    reveal.setAttribute('aria-label', on ? 'Hide token' : 'Show token');
  });
  const tokenRow = el('div', 'input-row');
  tokenField.replaceChild(tokenRow, token);
  tokenRow.append(token, reveal);
  onChange(token, () => {
    const v = token.value.trim();
    token.value = v;
    if (v === c.token) return;
    c.token = v;
    paintEnabled();
    connectionChanged();
  });

  const approval = selectBox(APPROVAL_OPTIONS, c.approval);
  approval.id = 'companionApproval';
  const approvalField = field(
    'Approval',
    approval,
    'Caution: these tools act outside the browser, and a web page could try to trick the model into misusing them. Keep “Always ask” unless you fully trust the pages the agent reads.'
  );
  const caution = approvalField.querySelector('.hint');
  caution.classList.add('caution');
  const paintCaution = () => caution.classList.toggle('warn', c.approval === 'follow');
  paintCaution();
  bindSelect(c, 'approval', approval, paintCaution);

  root.append(enabledField, urlField, tokenField, approvalField);

  /* --- test connection --- */

  const testBtn = button('Test connection');
  testBtn.id = 'companionTest';
  const testRow = el('div', 'tools-actions');
  testRow.append(testBtn);

  const result = el('div', 'tools-result');
  result.id = 'companionResult';
  const resultMsg = msgBox('companionResultMsg');
  const resultStatus = el('div', 'tools-status');
  resultStatus.id = 'companionStatus';
  resultStatus.setAttribute('role', 'status');
  resultStatus.hidden = true;
  result.append(resultMsg, resultStatus);
  root.append(testRow, result);

  const setResultMsg = (kind, parts, hint) => {
    resultStatus.hidden = true;
    show(resultMsg, kind, parts, hint);
  };
  const setResultStatus = (s) => {
    hide(resultMsg);
    const n = Array.isArray(s.tools) ? s.tools.length : 0;
    const grid = el('dl', 'tools-grid');
    for (const [k, v] of [['Version', s.version], ['Platform', s.platform], ['User', s.user]]) {
      const dt = el('dt', null, k);
      const dd = el('dd', null, str(v) || 'unknown');
      dd.dataset.field = k.toLowerCase();
      grid.append(dt, dd);
    }
    const count = el('div', 'tools-count', `${plural(n, 'tool')} available`);
    count.dataset.field = 'tools';
    resultStatus.replaceChildren(el('div', 'tools-status-head', '✓ Connected to the companion'), grid, count);
    resultStatus.hidden = false;
  };

  /* --- management area (needs a working connection; edits are applied explicitly) --- */

  let run = 0; // bumped whenever a newer request supersedes older ones
  let statusData = null; // last good /status body
  let baseline = null; // the config known to be live on the companion; Apply compares against it
  let baselineJson = '';
  let configError = null;
  let drafts = [];
  let draftKey = 0;
  const m = { allowShell: false, allowWrite: false, timeout: NaN };
  let dirty = false;
  let applying = false;
  let busy = false;
  let pollTimer = 0;
  let pollCount = 0;
  let painters = [];

  const manage = el('div', 'tools-manage');
  manage.id = 'companionManage';
  manage.hidden = true;

  const manageHead = el('div', 'tools-manage-head');
  manageHead.append(el('h4', 'tools-sub', 'Companion settings'));
  const refreshBtn = button('Refresh');
  refreshBtn.id = 'companionRefresh';
  manageHead.append(refreshBtn);
  const manageMsg = msgBox('companionManageMsg');
  const cfgErrorBox = msgBox('companionConfigError');

  const editor = el('div', 'tools-editor');
  editor.id = 'companionEditor';
  editor.hidden = true;

  const allowShell = checkbox(false);
  allowShell.id = 'companionAllowShell';
  const allowWrite = checkbox(false);
  allowWrite.id = 'companionAllowWrite';
  const timeout = numberInput('', { min: 1, step: 1, placeholder: 'e.g. 120' });
  timeout.id = 'companionTimeout';
  const shellField = checkField('Allow shell commands', allowShell, 'Lets the agent run commands on this computer.');
  const writeField = checkField('Allow writing files', allowWrite, 'Lets the agent create, change and overwrite files. Without this it can only read.');
  const timeoutField = field('Command timeout (seconds)', timeout, 'A command that runs longer than this is stopped.');
  const setTimeoutError = withError(timeoutField, timeout);

  const serversTitle = el('h4', 'tools-sub', 'Local MCP servers (stdio)');
  const serversHint = el('p', 'hint', 'Programs the companion starts and talks to, for example npx running an MCP server. Their tools appear to the agent alongside the built-in ones.');
  const serverList = el('div', 'cards');
  serverList.id = 'companionServers';
  const serversMsg = msgBox('companionServersMsg');

  const addServer = button('Add server');
  addServer.id = 'companionAddServer';
  const pasteToggle = button('Paste JSON');
  pasteToggle.id = 'companionPasteToggle';
  pasteToggle.setAttribute('aria-expanded', 'false');
  pasteToggle.setAttribute('aria-controls', 'companionPaste');
  const serverActions = el('div', 'tools-actions');
  serverActions.append(addServer, pasteToggle);

  const paste = el('div', 'card tools-paste');
  paste.id = 'companionPaste';
  paste.hidden = true;
  const pasteText = textArea('', { rows: 6, placeholder: '{\n  "mcpServers": {\n    "files": { "command": "npx", "args": ["-y", "…"] }\n  }\n}', mono: true });
  pasteText.id = 'companionPasteJson';
  const pasteMsg = msgBox('companionPasteMsg');
  const pasteAdd = button('Add to list', 'primary');
  pasteAdd.id = 'companionPasteAdd';
  const pasteCancel = button('Cancel');
  const pasteActions = el('div', 'card-actions');
  pasteActions.append(pasteAdd, pasteCancel);
  paste.append(
    field('Server config (JSON)', pasteText, 'Accepts the Claude Desktop format {"mcpServers": {…}} or just the inner map of servers. Nothing changes until you click Apply.'),
    pasteMsg,
    pasteActions
  );

  const applyBar = el('div', 'tools-apply');
  const dirtyHint = el('div', 'tools-dirty', 'Unsaved changes. They take effect when you click Apply.');
  dirtyHint.id = 'companionDirty';
  dirtyHint.setAttribute('role', 'status');
  dirtyHint.hidden = true;
  const applyBtn = button('Apply', 'primary');
  applyBtn.id = 'companionApply';
  applyBtn.disabled = true;
  const discardBtn = button('Discard changes');
  discardBtn.id = 'companionDiscard';
  discardBtn.hidden = true;
  const applyButtons = el('div', 'tools-actions');
  applyButtons.append(applyBtn, discardBtn);
  const applyMsg = msgBox('companionApplyMsg');
  applyBar.append(dirtyHint, applyButtons, applyMsg);

  editor.append(
    el('h4', 'tools-sub', 'Commands and files'),
    shellField,
    writeField,
    timeoutField,
    serversTitle,
    serversHint,
    serverList,
    serversMsg,
    serverActions,
    paste,
    applyBar
  );
  /* --- desktop tools (apps, windows, screenshots, keystrokes): applied at once, not part of Apply --- */

  const desk = el('div', 'tools-desktop');
  desk.id = 'desktopTools';
  desk.hidden = true;
  const deskOn = checkbox(true);
  deskOn.id = 'desktopToolsEnabled';
  const deskSwitch = checkField('Enabled', deskOn, 'Lets the agent list, open, focus and close apps and windows, take screenshots of the screen and send keystrokes.');
  const deskMsg = msgBox('desktopToolsMsg');
  const deskEnv = el('div', 'tools-desktop-env');
  deskEnv.id = 'desktopEnv';
  const deskAvailLabel = el('div', 'field-label', 'Available tools');
  const deskAvail = el('div', 'desktop-chips');
  deskAvail.id = 'desktopAvailable';
  const deskMissingLabel = el('div', 'field-label', 'Missing helpers');
  const deskMissing = el('div', 'desktop-missing');
  deskMissing.id = 'desktopMissing';
  desk.append(el('h4', 'tools-sub', 'Desktop tools'), deskSwitch, deskMsg, deskEnv, deskAvailLabel, deskAvail, deskMissingLabel, deskMissing);

  let deskCfg = null; // desktopTools from /config, once known
  let deskSig = ''; // what the block currently shows
  let deskBusy = false;
  const PLATFORMS = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
  const SESSIONS = { x11: 'X11', wayland: 'Wayland' };

  const paintDesktop = () => {
    desk.hidden = !statusData;
    if (!statusData) return;
    const d = isObj(statusData.desktop) ? statusData.desktop : null;
    deskOn.disabled = deskBusy || !d;
    deskOn.checked = !d ? false : typeof deskCfg === 'boolean' ? deskCfg : d.enabled !== false;
    const hint = deskSwitch.querySelector('.hint');
    // Every status refresh repaints this; leave the DOM alone when nothing changed (keeps focus and "Copied").
    const sig = JSON.stringify([d, deskOn.checked]);
    if (sig === deskSig) return;
    deskSig = sig;
    deskEnv.replaceChildren();
    deskAvail.replaceChildren();
    deskMissing.replaceChildren();
    if (!d) {
      deskEnv.textContent = 'This companion version has no desktop tools. Update agent-companion.mjs and restart it.';
      deskAvailLabel.hidden = deskAvail.hidden = deskMissingLabel.hidden = deskMissing.hidden = true;
      hint.hidden = true;
      return;
    }
    hint.hidden = false;
    const plat = PLATFORMS[d.platform] || str(d.platform) || 'unknown platform';
    const session = d.session ? ` · ${SESSIONS[d.session] || str(d.session)} session` : '';
    deskEnv.textContent = d.platform === 'win32' ? `${plat}: desktop tools are not available on this system yet.` : `${plat}${session}${deskOn.checked ? '' : ' · switched off, so the agent does not see these tools'}`;
    const available = Array.isArray(d.available) ? d.available.map(str).filter(Boolean) : [];
    const missing = isObj(d.missing) ? Object.entries(d.missing) : [];
    deskAvailLabel.hidden = deskAvail.hidden = false;
    if (available.length) for (const name of available) deskAvail.append(el('span', 'desktop-chip', name));
    else deskAvail.append(el('span', 'hint', d.platform === 'win32' ? 'None.' : 'None yet.'));
    deskMissingLabel.hidden = deskMissing.hidden = !missing.length;
    for (const [tool, how] of missing) {
      const item = el('div', 'desktop-missing-item');
      item.dataset.tool = tool;
      item.append(el('div', 'desktop-missing-name', tool), codeBlock(str(how), `Copy install hint for ${tool}`));
      deskMissing.append(item);
    }
  };

  deskOn.addEventListener('change', async () => {
    const want = deskOn.checked;
    deskBusy = true;
    deskOn.disabled = true;
    hide(deskMsg);
    const r = await request(c.url, c.token, 'PUT', '/config', { body: { desktopTools: want }, timeout: APPLY_TIMEOUT });
    deskBusy = false;
    if (!r.ok) {
      deskOn.checked = !want;
      deskOn.disabled = false;
      show(deskMsg, 'error', [`Could not change desktop tools. ${failureText(r, c.url)}`]);
      return;
    }
    deskCfg = want;
    if (isObj(statusData?.desktop)) statusData.desktop.enabled = want;
    paintDesktop();
    refresh(run, { statusOnly: true, quiet: true }).catch(() => {});
  });

  manage.append(manageHead, manageMsg, cfgErrorBox, desk, editor);
  root.append(manage);

  /* --- editor state --- */

  const newDraft = (name, v, origName) => ({
    key: ++draftKey,
    origName,
    name,
    command: str(v?.command).trim(),
    args: Array.isArray(v?.args) ? v.args.map(str) : [],
    env: isObj(v?.env) ? Object.fromEntries(Object.entries(v.env).map(([k, x]) => [k, str(x)])) : {},
    cwd: str(v?.cwd).trim(),
    disabled: !!v?.disabled,
    envBad: [],
  });

  // The editor-normalised JSON of a /config body, so an unchanged config does not rebuild the cards under the user's cursor.
  const normalizedJson = (cfg) => {
    const t = Number(cfg.commandTimeoutSec);
    const body = { allowShell: !!cfg.allowShell, allowWrite: !!cfg.allowWrite };
    if (Number.isFinite(t) && t > 0) body.commandTimeoutSec = t;
    body.mcpServers = Object.fromEntries(
      Object.entries(isObj(cfg.mcpServers) ? cfg.mcpServers : {}).map(([name, v]) => [name, serverBody(newDraft(name, v, name))])
    );
    return JSON.stringify(body);
  };

  const currentBody = () => {
    const body = { allowShell: m.allowShell, allowWrite: m.allowWrite };
    if (Number.isFinite(m.timeout)) body.commandTimeoutSec = m.timeout;
    body.mcpServers = Object.fromEntries(drafts.map((d) => [d.name, serverBody(d)]));
    return body;
  };

  const updateDirty = () => {
    const was = dirty;
    dirty = !!baseline && (JSON.stringify(currentBody()) !== baselineJson || drafts.some((d) => d.envBad.length));
    if (dirty && !was) hide(applyMsg); // the earlier "Applied. …" no longer describes the editor
    dirtyHint.hidden = !dirty;
    discardBtn.hidden = !dirty;
    applyBtn.disabled = !dirty || applying || busy;
    manage.dataset.dirty = String(dirty);
  };

  // Replaces the editor's state with `cfg` (a /config-shaped body) and makes it the new baseline.
  const loadBaseline = (cfg) => {
    m.allowShell = !!cfg.allowShell;
    m.allowWrite = !!cfg.allowWrite;
    const t = Number(cfg.commandTimeoutSec);
    m.timeout = Number.isFinite(t) && t > 0 ? t : NaN;
    drafts = Object.entries(isObj(cfg.mcpServers) ? cfg.mcpServers : {}).map(([name, v]) => newDraft(name, v, name));
    allowShell.checked = m.allowShell;
    allowWrite.checked = m.allowWrite;
    timeout.value = Number.isFinite(m.timeout) ? String(m.timeout) : '';
    setTimeoutError('');
    baselineJson = JSON.stringify(currentBody());
    baseline = JSON.parse(baselineJson);
    configError = null;
    renderServers();
    updateDirty();
  };

  // These edits are deliberately not auto-saved: applying them restarts processes on the companion.
  allowShell.addEventListener('change', () => {
    m.allowShell = allowShell.checked;
    updateDirty();
  });
  allowWrite.addEventListener('change', () => {
    m.allowWrite = allowWrite.checked;
    updateDirty();
  });
  timeout.addEventListener('input', () => {
    const t = timeout.value.trim();
    m.timeout = t === '' ? NaN : Number(t);
    updateDirty();
  });
  timeout.addEventListener('change', () => {
    const t = timeout.value.trim();
    const v = t === '' ? NaN : Number(t);
    const back = baseline?.commandTimeoutSec;
    if (Number.isFinite(v)) m.timeout = Math.max(1, Math.round(v));
    else m.timeout = back ?? NaN;
    timeout.value = Number.isFinite(m.timeout) ? String(m.timeout) : '';
    setTimeoutError('');
    updateDirty();
  });

  const statusFor = (name) => (Array.isArray(statusData?.servers) ? statusData.servers.find((s) => s?.name === name) : undefined);

  const STATE_LABELS = { running: 'Running', starting: 'Starting…', error: 'Error', stopped: 'Stopped', disabled: 'Disabled', new: 'Not applied yet', unknown: 'Unknown' };

  const refreshNameErrors = ({ live = false } = {}) => {
    for (const d of drafts) {
      const siblings = drafts.filter((x) => x !== d).map((x) => x.name);
      d.ui?.setNameError(checkServerName(d.name, siblings, { allowEmpty: live }));
    }
  };

  function serverCard(d) {
    const card = el('div', 'card server-card');
    card.dataset.serverCard = '';
    card.dataset.server = d.name;

    const head = el('div', 'srv-head');
    const title = el('span', 'srv-title', d.name || 'New server');
    const badge = el('span', 'badge');
    badge.dataset.role = 'badge';
    head.append(title, badge);
    const errBox = el('div', 'srv-error');
    errBox.dataset.role = 'error';
    errBox.tabIndex = 0;
    errBox.setAttribute('role', 'region');
    errBox.setAttribute('aria-label', `Error output for ${d.name || 'new server'}`);
    errBox.hidden = true;

    const paint = () => {
      const st = d.origName == null ? null : statusFor(d.origName);
      const state = d.origName == null ? 'new' : st ? str(st.state) || 'unknown' : 'unknown';
      card.dataset.state = state;
      badge.className = `badge ${/^[a-z]+$/.test(state) ? state : 'unknown'}`;
      const n = Number(st?.tools);
      badge.textContent = (STATE_LABELS[state] || state) + (state === 'running' && Number.isFinite(n) ? ` · ${plural(n, 'tool')}` : '');
      const err = st?.error ? str(st.error) : '';
      errBox.hidden = !err;
      errBox.textContent = err;
    };
    painters.push(paint);

    const name = textInput(d.name, 'text', 'e.g. files');
    name.dataset.field = 'name';
    name.setAttribute('maxlength', '64');
    const nameField = field('Name', name, 'Letters, numbers, - and _. Tool names start with this.');
    const setNameError = withError(nameField, name);
    name.addEventListener('input', () => {
      d.name = name.value.trim();
      card.dataset.server = d.name;
      title.textContent = d.name || 'New server';
      refreshNameErrors({ live: true });
      updateDirty();
    });
    name.addEventListener('change', () => {
      name.value = d.name;
      refreshNameErrors();
    });

    const command = textInput(d.command, 'text', 'e.g. npx');
    command.className = 'mono';
    command.dataset.field = 'command';
    const commandField = field('Command', command, 'Just the program to run. Put each argument on its own line below.');
    const setCommandError = withError(commandField, command);
    const commandNote = el('div', 'field-warn');
    commandNote.hidden = true;
    commandField.append(commandNote);
    const looksLikeLine = () => /\s/.test(d.command) && !/[\\/]/.test(d.command) && !d.args.length;
    const paintCommandNote = () => {
      commandNote.hidden = !looksLikeLine();
      commandNote.textContent = looksLikeLine() ? 'This looks like a whole command line. Put only the program here (for example npx) and each argument on its own line under Arguments.' : '';
    };
    command.addEventListener('input', () => {
      d.command = command.value.trim();
      paintCommandNote();
      if (d.command) setCommandError('');
      updateDirty();
    });
    command.addEventListener('change', () => {
      command.value = d.command;
      setCommandError(d.command ? '' : 'Enter the program to run.');
    });
    paintCommandNote();

    const args = textArea(formatArgs(d.args), { rows: 3, placeholder: '-y\n@modelcontextprotocol/server-filesystem\n/Users/you/Documents', mono: true });
    args.dataset.field = 'args';
    const argsField = field('Arguments', args, 'One per line. No quoting needed, and quotes you type are kept as they are.');
    args.addEventListener('input', () => {
      d.args = parseArgs(args.value);
      paintCommandNote();
      updateDirty();
    });

    const env = textArea(formatEnv(d.env), { rows: 2, placeholder: 'API_KEY=…', mono: true });
    env.dataset.field = 'env';
    const envField = field('Environment', env, 'One KEY=value per line. Optional.');
    const setEnvError = withError(envField, env);
    const envProblem = () => (d.envBad.length ? `${d.envBad.length === 1 ? 'Line' : 'Lines'} ${d.envBad.join(', ')} ${d.envBad.length === 1 ? 'is' : 'are'} not in the form KEY=value.` : '');
    env.addEventListener('input', () => {
      const r = parseEnv(env.value);
      d.env = r.env;
      d.envBad = r.bad;
      if (!r.bad.length) setEnvError('');
      updateDirty();
    });
    env.addEventListener('change', () => setEnvError(envProblem()));

    const cwd = textInput(d.cwd, 'text', 'Optional, e.g. /Users/you/project');
    cwd.className = 'mono';
    cwd.dataset.field = 'cwd';
    const cwdField = field('Working directory', cwd, 'The folder the program starts in. Leave blank to use the companion’s own.');
    cwd.addEventListener('input', () => {
      d.cwd = cwd.value.trim();
      updateDirty();
    });

    const on = checkbox(!d.disabled);
    on.dataset.field = 'enabled';
    on.addEventListener('change', () => {
      d.disabled = !on.checked;
      updateDirty();
    });

    const remove = removeButton(() => {
      const i = drafts.indexOf(d);
      if (i >= 0) drafts.splice(i, 1);
      renderServers();
      refreshNameErrors({ live: true });
      updateDirty();
      addServer.focus();
    });
    remove.dataset.role = 'remove';
    const actions = el('div', 'card-actions');
    actions.append(checkField('Enabled', on), remove);

    d.ui = { setNameError, setCommandError, setEnvError, envProblem, name, command, env };
    card.append(head, errBox, nameField, commandField, argsField, envField, cwdField, actions);
    paint();
    return card;
  }

  function renderServers() {
    painters = [];
    serverList.replaceChildren(...drafts.map(serverCard));
    if (!drafts.length) serverList.append(el('p', 'hint', 'No local MCP servers yet. Add one below, or paste an existing config.'));
  }

  const repaintStates = () => painters.forEach((p) => p());

  addServer.addEventListener('click', () => {
    drafts.push(newDraft('', {}, null));
    hide(serversMsg);
    renderServers();
    updateDirty();
    const card = serverList.lastElementChild;
    card?.querySelector('input')?.focus();
    card?.scrollIntoView?.({ block: 'nearest' });
  });

  const setPasteOpen = (open) => {
    paste.hidden = !open;
    pasteToggle.setAttribute('aria-expanded', String(open));
    if (open) pasteText.focus();
  };
  pasteToggle.addEventListener('click', () => setPasteOpen(paste.hidden));
  pasteCancel.addEventListener('click', () => {
    hide(pasteMsg);
    setPasteOpen(false);
    pasteToggle.focus();
  });
  pasteAdd.addEventListener('click', () => {
    const r = parseMcpJson(pasteText.value);
    if (!r.ok) {
      show(pasteMsg, 'error', [r.error]);
      pasteText.setAttribute('aria-invalid', 'true');
      return;
    }
    pasteText.removeAttribute('aria-invalid');
    const added = [];
    const updated = [];
    for (const s of r.servers) {
      const existing = drafts.find((d) => d.name === s.name);
      if (existing) {
        Object.assign(existing, newDraft(s.name, s, existing.origName), { key: existing.key });
        updated.push(s.name);
      } else {
        drafts.push(newDraft(s.name, s, null));
        added.push(s.name);
      }
    }
    pasteText.value = '';
    hide(pasteMsg);
    setPasteOpen(false);
    renderServers();
    refreshNameErrors({ live: true });
    updateDirty();
    const said = [];
    if (added.length) said.push(`Added ${plural(added.length, 'server')}: ${added.join(', ')}.`);
    if (updated.length) said.push(`Replaced the settings of ${updated.join(', ')}.`);
    show(serversMsg, 'ok', [[...said, ...r.notes].join(' ')], 'Nothing has changed on the companion yet. Review the list, then click Apply.');
    pasteToggle.focus();
  });

  /* --- connecting --- */

  const hasStarting = () => Array.isArray(statusData?.servers) && statusData.servers.some((s) => s?.state === 'starting');

  const schedulePoll = () => {
    clearTimeout(pollTimer);
    if (pollCount >= POLL_MAX || !hasStarting()) return;
    pollTimer = setTimeout(async () => {
      if (!root.isConnected) return;
      pollCount++;
      await refresh(run, { statusOnly: true, quiet: true });
    }, POLL_MS);
  };

  // Only the operation that set busy may clear it, so a superseded request cannot re-enable the buttons early.
  let busyOwner = 0;
  const setBusy = (b, id = 0) => {
    if (!b && id !== busyOwner) return;
    busyOwner = b ? id : 0;
    busy = b;
    testBtn.disabled = b;
    refreshBtn.disabled = b;
    updateDirty();
  };

  // Re-reads /status (and /config unless there are unsaved edits). Returns true when the companion answered properly.
  async function refresh(id, { statusOnly = false, quiet = false, onFail } = {}) {
    const s = await request(c.url, c.token, 'GET', '/status');
    if (id !== run) return false;
    if (!s.ok || !isObj(s.data)) {
      if (!quiet) {
        hooks.onStatus?.(null);
        onFail?.(s.ok ? { ...s, ok: false, bad: true } : s);
      }
      return false;
    }
    statusData = s.data;
    hooks.onStatus?.(statusData);
    setResultStatus(statusData);
    paintDesktop();
    if (!statusOnly) {
      const cf = await request(c.url, c.token, 'GET', '/config');
      if (id !== run) return false;
      if (cf.ok && isObj(cf.data)) {
        if (typeof cf.data.desktopTools === 'boolean') deskCfg = cf.data.desktopTools;
        paintDesktop();
        hooks.onConfig?.(cf.data);
        if (!dirty && !(baseline && normalizedJson(cf.data) === baselineJson)) loadBaseline(cf.data);
      } else if (!baseline) {
        configError = cf.ok ? { ...cf, ok: false, bad: true } : cf;
      }
    }
    manage.hidden = false;
    editor.hidden = !baseline;
    if (baseline) hide(cfgErrorBox);
    else if (configError) {
      const f = explainFailure(configError, { base: c.url, what: 'refresh' });
      show(cfgErrorBox, f.kind, [`Could not read the companion’s configuration. `, ...f.parts], f.hint);
    }
    repaintStates();
    schedulePoll();
    return true;
  }

  async function connect() {
    const id = ++run;
    pollCount = 0;
    clearTimeout(pollTimer);
    setBusy(true, id);
    setResultMsg('info', ['Testing the connection…']);
    try {
      const h = await request(c.url, c.token, 'GET', '/health');
      if (id !== run) return;
      if (!h.ok) {
        hooks.onStatus?.(null);
        const f = explainFailure(h, { base: c.url });
        setResultMsg(f.kind, f.parts, f.hint);
        return;
      }
      if (!isObj(h.data) || h.data.name !== 'agent-companion') {
        hooks.onStatus?.(null);
        const f = explainFailure({ ok: false, status: h.status, bad: true }, { base: c.url });
        setResultMsg(f.kind, f.parts, f.hint);
        return;
      }
      const version = str(h.data.version);
      if (!c.token) {
        hooks.onStatus?.(null);
        setResultMsg(
          'warn',
          [`The companion${version ? ` (version ${version})` : ''} is running at ${c.url}, but no token is set yet.`],
          'Copy the token it printed when it started into the Token field above, then test again.'
        );
        return;
      }
      const ok = await refresh(id, {
        onFail: (r) => {
          const f = explainFailure(r, { base: c.url, version });
          setResultMsg(f.kind, f.parts, f.hint);
        },
      });
      if (ok) hide(manageMsg);
    } finally {
      setBusy(false, id);
    }
  }

  // The address or token changed: whatever was loaded belongs to another companion (or none).
  function connectionChanged() {
    run++;
    pollCount = 0;
    clearTimeout(pollTimer);
    statusData = null;
    hooks.onStatus?.(null);
    deskCfg = null;
    paintDesktop();
    baseline = null;
    baselineJson = '';
    configError = null;
    drafts = [];
    painters = [];
    dirty = false;
    setBusy(false, busyOwner);
    hide(resultMsg);
    resultStatus.hidden = true;
    hide(manageMsg);
    hide(applyMsg);
    manage.hidden = true;
    editor.hidden = true;
    updateDirty();
    if (!c.token) return;
    // Saving also refreshes the request-header rules for a new address, so let it finish before the first request.
    const mine = run;
    Promise.resolve(commit())
      .then(() => run === mine && connect())
      .catch(() => {});
  }

  testBtn.addEventListener('click', () => {
    connect().catch((e) => setResultMsg('error', [`Unexpected problem: ${e?.message || e}`]));
  });

  refreshBtn.addEventListener('click', async () => {
    const id = ++run;
    pollCount = 0;
    clearTimeout(pollTimer);
    setBusy(true, id);
    show(manageMsg, 'info', ['Refreshing…']);
    try {
      const ok = await refresh(id, {
        onFail: (r) => {
          showFailure(manageMsg, r, 'refresh');
          const f = explainFailure(r, { base: c.url, what: 'refresh' });
          setResultMsg(f.kind, f.parts, f.hint);
        },
      });
      if (ok && id === run) show(manageMsg, 'ok', [dirty ? 'Status refreshed. Your unsaved edits were kept.' : 'Refreshed.']);
    } catch (e) {
      show(manageMsg, 'error', [`Unexpected problem: ${e?.message || e}`]);
    } finally {
      setBusy(false, id);
    }
  });

  /* --- apply / discard --- */

  // Marks every invalid field and returns the first one to focus (null when everything is fine).
  function validateAll() {
    let first = null;
    const note = (ctl) => (first ||= ctl);
    refreshNameErrors();
    for (const d of drafts) {
      const siblings = drafts.filter((x) => x !== d).map((x) => x.name);
      if (checkServerName(d.name, siblings)) note(d.ui.name);
      if (!d.command) {
        d.ui.setCommandError('Enter the program to run.');
        note(d.ui.command);
      }
      const ep = d.ui.envProblem();
      d.ui.setEnvError(ep);
      if (ep) note(d.ui.env);
    }
    if (m.timeout !== undefined && !Number.isNaN(m.timeout) && (!Number.isFinite(m.timeout) || m.timeout < 1 || !Number.isInteger(m.timeout))) {
      setTimeoutError('Use a whole number of seconds, 1 or more.');
      note(timeout);
    }
    return first;
  }

  applyBtn.addEventListener('click', async () => {
    if (applying || !baseline) return;
    const bad = validateAll();
    if (bad) {
      show(applyMsg, 'error', ['Some fields need attention before this can be applied. They are marked in red above.']);
      bad.focus();
      return;
    }
    const body = currentBody();
    const hadFocus = document.activeElement === applyBtn;
    applying = true;
    const id = ++run;
    clearTimeout(pollTimer);
    setBusy(true, id);
    updateDirty();
    show(applyMsg, 'info', ['Applying… starting a server can take a few seconds.']);
    try {
      const r = await request(c.url, c.token, 'PUT', '/config', { body, timeout: APPLY_TIMEOUT });
      if (!r.ok) {
        showFailure(applyMsg, r, 'apply');
        return;
      }
      pollCount = 0;
      const live = isObj(r.data) && Array.isArray(r.data.servers) ? r.data : null;
      // The companion may adjust values (for example clamp the timeout), so prefer what it reports.
      const cfg = { ...body, ...(isObj(live?.config) ? live.config : {}) };
      applying = false;
      if (live) {
        // The reply is a /status body; keep what an older or partial one leaves out.
        const prev = statusData;
        statusData = { ...live };
        for (const k of ['desktop', 'tunnel', 'remote']) if (statusData[k] === undefined && prev?.[k] !== undefined) statusData[k] = prev[k];
        hooks.onStatus?.(statusData);
        setResultStatus(live);
        paintDesktop();
      }
      loadBaseline(cfg);
      const servers = live?.servers || [];
      const count = plural(Object.keys(body.mcpServers).length, 'local server');
      const failed = servers.filter((s) => s?.state === 'error').length;
      const starting = servers.filter((s) => s?.state === 'starting').length;
      const detail = [`${servers.filter((s) => s?.state === 'running').length} running`];
      if (starting) detail.push(`${starting} starting`);
      if (failed) detail.push(`${failed} with an error (see its card)`);
      show(applyMsg, failed ? 'warn' : 'ok', [`Applied. ${count} configured${servers.length ? `: ${detail.join(', ')}` : ''}.`]);
      if (hadFocus) {
        applyMsg.tabIndex = -1;
        applyMsg.focus();
      }
      if (live) schedulePoll();
      else refresh(run, { statusOnly: true, quiet: true }).catch(() => {});
    } catch (e) {
      show(applyMsg, 'error', [`Unexpected problem: ${e?.message || e}. Your edits are still here.`]);
    } finally {
      applying = false;
      setBusy(false, id);
      updateDirty();
    }
  });

  discardBtn.addEventListener('click', () => {
    if (!baseline) return;
    loadBaseline(baseline);
    hide(applyMsg);
    hide(serversMsg);
    show(manageMsg, 'info', ['Changes discarded.']);
    refreshBtn.focus();
  });

  // Show the current state right away when it is switched on and configured, so a problem is visible without a click.
  if (c.enabled && c.token) connect().catch(() => {});

  return root;
}

/* ---------- Remote access (the companion's Cloudflare tunnel) ---------- */

// Mutable so tests can speed it up. During a Start/Stop the UI polls GET /tunnel/status every `intervalMs`, for at
// most `maxMs`. A tunnel that is running is re-checked every `watchMs` while Settings is open, so one that died
// on its own (cloudflared crashed) shows as such instead of as a dead link.
export const TUNNEL_POLL = { intervalMs: 1500, maxMs: 120000, watchMs: 10000 };

const TUNNEL_STATES = ['stopped', 'downloading', 'starting', 'running', 'error'];
const TUNNEL_LABELS = { stopped: 'Stopped', downloading: 'Downloading cloudflared…', starting: 'Starting…', running: 'Running', error: 'Error' };
const MASKED_CODE = 'aa1:••••';

// The tunnel object of /status, /tunnel/status and /tunnel/start|stop, whatever is missing from it.
export function normalizeTunnel(raw) {
  let t = isObj(raw) ? raw : {};
  if (isObj(t.tunnel) && !('state' in t)) t = t.tunnel;
  const cf = isObj(t.cloudflared) ? t.cloudflared : null;
  return {
    state: TUNNEL_STATES.includes(t.state) ? t.state : 'stopped',
    url: typeof t.url === 'string' && t.url ? t.url : null,
    kind: t.kind === 'named' ? 'named' : 'quick',
    error: t.error != null && t.error !== '' ? str(t.error) : '',
    cloudflared: cf ? { installed: !!cf.installed, version: str(cf.version) } : null,
  };
}

// The public address of a named tunnel: an https origin such as https://agent.example.com.
// → { ok: true, url } (normalised to the origin) | { ok: false, error }
export function normalizeNamedUrl(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return { ok: false, error: 'Enter the public address you gave this tunnel in Cloudflare, for example https://agent.example.com.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `https://${t}`;
  let u;
  try {
    u = new URL(t);
  } catch {
    return { ok: false, error: 'That does not look like a web address. Example: https://agent.example.com' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'The public address must start with https:// (Cloudflare serves named tunnels over https).' };
  if (!u.hostname.includes('.') || u.username || u.password) return { ok: false, error: 'Use just the address, like https://agent.example.com (a host name, no user name or password).' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { ok: false, error: 'Use just the address, like https://agent.example.com, without a path.' };
  return { ok: true, url: u.origin };
}

const hasTunnelShape = (d) => isObj(d) && ('state' in d || isObj(d.tunnel));
const spanText = (ms) => (ms >= 60000 ? plural(Math.round(ms / 60000), 'minute') : plural(Math.max(1, Math.round(ms / 1000)), 'second'));

// Assign only when something differs, so a polled repaint does not re-announce or flicker.
function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}
const setAttr = (node, name, value) => node.getAttribute(name) !== value && node.setAttribute(name, value);
const setHidden = (node, v) => node.hidden !== v && (node.hidden = v);
const setDisabled = (node, v) => node.disabled !== v && (node.disabled = v);

function newMsg(el, id) {
  const m = el('div', 'tools-msg');
  if (id) m.id = id;
  m.setAttribute('role', 'status');
  m.hidden = true;
  return m;
}

function setMsg(box, kind, text) {
  if (!text) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.className = `tools-msg ${kind}`;
  box.textContent = text;
  box.hidden = false;
}

// Returns { root, hooks, refreshProviders }. `hooks` goes to computerToolsSection, which reports the companion's
// /status and /config; this section only shows while that connection works.
export function remoteAccessSection(settings, kit) {
  const { el, selectBox, checkbox, button, textInput, field, checkField, section } = kit;
  const c = settings.companion;

  const root = section('Remote access');
  root.id = 'remoteAccess';
  const off = el('p', 'hint tunnel-off', 'Connect the companion above to use remote access');
  off.id = 'remoteAccessOff';
  const body = el('div', 'tunnel-body');
  body.id = 'remoteAccessBody';
  body.hidden = true;
  root.append(off, body);

  let connected = false;
  let tunnel = null; // normalised tunnel object
  let busy = false; // a Start / Stop / Refresh request is in flight
  let waiting = false; // polling for a transition
  let gaveUp = false; // polling timed out while still transitioning
  let code = ''; // the connection code; kept out of the DOM while masked
  let revealed = false;
  let configKnown = false;
  // The companion's defaults: exposeLlm on, everything else off.
  let tunnelCfg = { exposeLlm: true, exposeMcp: false, autostart: false, kind: 'quick', hasNamedToken: false, namedUrl: '' };
  let lastKind = 'quick'; // what the Advanced fields last got from the companion
  let lastNamedUrl = '';
  let upstreams = {}; // llmUpstreams from /config: name → { url, … }
  let pollId = 0;
  let pollTimer = 0;
  let connRun = 0;
  let connLoading = false;

  /* --- layout --- */

  const intro = el('p', 'hint tunnel-intro', 'Use your local models and this computer’s tools from another browser or device. The companion opens a Cloudflare tunnel for you.');

  const safety = el('div', 'tunnel-safety');
  safety.id = 'tunnelSafety';
  const privateCopy = el(
    'p',
    null,
    'The tunnel runs from the companion’s own private copy of cloudflared, with its own configuration. It does not touch any other Cloudflare setup on this computer: no shared config, services or accounts are changed.'
  );
  privateCopy.dataset.role = 'private-copy';
  safety.append(
    el('p', null, 'Anyone who has both the link and the access token can use whatever you expose here. Share the connection code only with people and browsers you trust, and stop the tunnel when you are not using it.'),
    el('p', null, 'A quick tunnel gets a new link every time it starts, so copy the connection code again after a restart.'),
    privateCopy
  );

  const stateRow = el('div', 'tunnel-state');
  stateRow.id = 'tunnelState';
  stateRow.setAttribute('role', 'status');
  const badge = el('span', 'badge');
  const stateText = el('span', 'tunnel-state-text');
  stateRow.append(badge, stateText);
  const cfLine = el('p', 'hint tunnel-cf');
  cfLine.id = 'tunnelCloudflared';

  const startBtn = button('Start tunnel', 'primary');
  startBtn.id = 'tunnelStart';
  const stopBtn = button('Stop tunnel');
  stopBtn.id = 'tunnelStop';
  const refreshBtn = button('Refresh');
  refreshBtn.id = 'tunnelRefresh';
  const actions = el('div', 'tools-actions');
  actions.append(startBtn, stopBtn, refreshBtn);
  const tunnelMsg = newMsg(el, 'tunnelMsg');

  const codeNote = el('p', 'hint tunnel-code-wait', 'The link and the connection code are available once the tunnel is running.');
  codeNote.id = 'tunnelCodeWait';

  // The public link.
  const linkBlock = el('div', 'tunnel-block');
  linkBlock.id = 'tunnelLink';
  const linkRow = el('div', 'codeblock');
  const urlText = el('code', 'codeblock-text');
  urlText.id = 'tunnelUrl';
  const copyUrl = button('Copy');
  copyUrl.id = 'tunnelCopyUrl';
  copyUrl.setAttribute('aria-label', 'Copy link');
  linkRow.append(urlText, copyUrl);
  linkBlock.append(el('div', 'field-label', 'Public link'), linkRow);
  wireCopy(copyUrl, () => tunnel?.url || '', () => urlText);

  // The connection code, masked until the user asks.
  const codeBlock = el('div', 'tunnel-block');
  codeBlock.id = 'tunnelCodeBlock';
  const codeRow = el('div', 'codeblock wrap');
  const codeText = el('code', 'codeblock-text');
  codeText.id = 'tunnelCode';
  const showCode = button('Show');
  showCode.id = 'tunnelShowCode';
  showCode.setAttribute('aria-controls', 'tunnelCode');
  const copyCode = button('Copy');
  copyCode.id = 'tunnelCopyCode';
  copyCode.setAttribute('aria-label', 'Copy connection code');
  const codeBtns = el('div', 'codeblock-btns');
  codeBtns.append(showCode, copyCode);
  codeRow.append(codeText, codeBtns);
  codeBlock.append(
    el('div', 'field-label', 'Connection code'),
    codeRow,
    el('p', 'hint tunnel-code-note', 'In the other browser: Settings → Providers → Add from connection code. Treat the code like a password: it includes the access token.')
  );
  const setRevealed = (on) => {
    revealed = on;
    paintCode();
  };
  showCode.addEventListener('click', () => setRevealed(!revealed));
  wireCopy(copyCode, () => (connLoading ? '' : code), () => codeText, () => setRevealed(true));

  // What to expose.
  const exposeLlm = checkbox(false);
  exposeLlm.id = 'tunnelExposeLlm';
  const exposeMcp = checkbox(false);
  exposeMcp.id = 'tunnelExposeMcp';
  const autostart = checkbox(false);
  autostart.id = 'tunnelAutostart';
  const optLlm = checkField('Expose local models', exposeLlm, 'Lets the other browser send prompts to the local models ticked below.');
  const optMcp = checkField(
    'Expose computer tools',
    exposeMcp,
    'Lets the other browser use this computer’s tools (commands, files, apps), within the limits set under Computer tools. Only turn this on if you need it.'
  );
  const mcpHint = optMcp.querySelector('.hint');
  mcpHint.classList.add('caution');
  const optAuto = checkField('Start tunnel when the companion starts', autostart, 'The companion opens the tunnel by itself each time it starts.');
  const optionsMsg = newMsg(el, 'tunnelOptionsMsg');
  const opts = el('div', 'tunnel-opts');
  opts.append(optLlm, optMcp, optAuto, optionsMsg);

  // Which local models.
  const upWrap = el('div', 'tunnel-upstreams');
  upWrap.id = 'tunnelUpstreams';
  const upList = el('div', 'tunnel-upstream-list');
  const upEmpty = el('p', 'hint', 'No local model providers to list. Providers whose address is on this computer or your local network (for example LM Studio or Ollama) show up here.');
  const upOther = el('p', 'hint');
  upWrap.append(
    el('h4', 'tools-sub', 'Expose these local models'),
    el('p', 'hint', 'Only the models ticked here can be reached through the tunnel, and only while “Expose local models” is on.'),
    upList,
    upEmpty,
    upOther
  );

  // Named tunnel (advanced).
  const adv = el('details', 'tools-setup tunnel-advanced');
  adv.id = 'tunnelAdvanced';
  const advBody = el('div', 'tools-setup-body tunnel-advanced-body');
  const kind = selectBox(
    [
      ['quick', 'Quick tunnel (no account, new link each time)'],
      ['named', 'Named tunnel (your Cloudflare account, fixed link)'],
    ],
    'quick'
  );
  kind.id = 'tunnelKind';
  const named = textInput('', 'password', 'Paste the tunnel token');
  named.id = 'tunnelNamedToken';
  const namedField = field('Named tunnel token', named, 'Create the tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels) and paste its token. The companion keeps it on this computer and never shows it again.');
  const savedRow = el('div', 'tunnel-token-row');
  const saved = el('span', 'tunnel-token-saved', 'A token is saved');
  saved.id = 'tunnelTokenSaved';
  saved.hidden = true;
  const clearToken = button('Clear token', 'ghost');
  clearToken.id = 'tunnelClearToken';
  clearToken.hidden = true;
  savedRow.append(saved, clearToken);
  const namedUrl = textInput('', 'text', 'https://agent.example.com');
  namedUrl.id = 'tunnelNamedUrl';
  namedUrl.className = 'mono';
  namedUrl.setAttribute('inputmode', 'url');
  const namedUrlField = field(
    'Public address',
    namedUrl,
    'The https address you gave this tunnel in Cloudflare (Public hostname), for example https://agent.example.com. The companion shows it as the link and accepts requests for it.'
  );
  namedUrlField.id = 'tunnelNamedUrlField';
  namedUrlField.hidden = true; // only for the named kind
  const saveNamed = button('Save');
  saveNamed.id = 'tunnelSaveNamed';
  const advActions = el('div', 'tools-actions');
  advActions.append(saveNamed);
  const advMsg = newMsg(el, 'tunnelAdvancedMsg');
  advBody.append(
    el('p', 'hint', 'A quick tunnel needs no account but gets a new link every time it starts. A named tunnel keeps one fixed link.'),
    field('Tunnel type', kind, 'Applies when you click Save. A running tunnel restarts with it.'),
    namedField,
    savedRow,
    namedUrlField,
    advActions,
    advMsg
  );
  adv.append(el('summary', null, 'Advanced: named tunnel'), advBody);

  body.append(intro, safety, stateRow, cfLine, actions, tunnelMsg, codeNote, linkBlock, codeBlock, opts, upWrap, adv);

  /* --- painting --- */

  function paintCode() {
    const show = !!code && tunnel?.state === 'running';
    setHidden(codeBlock, !show);
    setHidden(codeNote, show || connLoading);
    setText(codeText, show ? (revealed ? code : MASKED_CODE) : '');
    setDisabled(showCode, connLoading);
    setDisabled(copyCode, connLoading);
    setText(showCode, revealed ? 'Hide' : 'Show');
    setAttr(showCode, 'aria-pressed', String(revealed));
    setAttr(showCode, 'aria-label', revealed ? 'Hide connection code' : 'Show connection code');
  }

  function paint() {
    const t = tunnel || normalizeTunnel({});
    const transitional = t.state === 'downloading' || t.state === 'starting';
    setAttr(stateRow, 'data-state', t.state);
    setAttr(badge, 'class', `badge ${t.state}`);
    setText(badge, TUNNEL_LABELS[t.state]);
    setText(
      stateText,
      t.state === 'error'
        ? t.error || 'The tunnel stopped with an error.'
        : t.state === 'downloading'
          ? 'Fetching the cloudflared program. This happens once and can take a minute.'
          : t.state === 'starting'
            ? 'Opening the tunnel…'
            : t.state === 'running'
              ? t.url
                ? `${t.kind === 'named' ? 'Named' : 'Quick'} tunnel is open.`
                : 'The tunnel is open. Its link is the public hostname you set for it in Cloudflare.'
              : 'The tunnel is not running.'
    );
    stateRow.classList.toggle('is-error', t.state === 'error');
    setHidden(cfLine, !t.cloudflared);
    setText(
      cfLine,
      !t.cloudflared
        ? ''
        : t.cloudflared.installed
          ? `cloudflared${t.cloudflared.version ? ` ${t.cloudflared.version}` : ''} is installed.`
          : 'cloudflared is not installed yet. It is downloaded automatically the first time you start the tunnel.'
    );
    const locked = busy || waiting;
    setDisabled(startBtn, locked || !(t.state === 'stopped' || t.state === 'error'));
    setDisabled(stopBtn, locked || !(t.state === 'running' || (gaveUp && transitional)));
    setDisabled(refreshBtn, busy);
    setHidden(linkBlock, !(t.state === 'running' && t.url));
    setText(urlText, t.state === 'running' && t.url ? t.url : '');
    paintCode();
    syncWatch();
  }

  function paintToken() {
    saved.hidden = clearToken.hidden = !tunnelCfg.hasNamedToken;
    if (!tunnelCfg.hasNamedToken) resetClear();
  }

  const paintNamed = () => setHidden(namedUrlField, kind.value !== 'named');
  kind.addEventListener('change', paintNamed);

  // Two clicks to clear the saved token, like Remove elsewhere: it cannot be read back, so it must be pasted again.
  let clearTimer = 0;
  function resetClear() {
    clearTimeout(clearTimer);
    clearTimer = 0;
    clearToken.textContent = 'Clear token';
    clearToken.classList.remove('confirm');
  }
  clearToken.addEventListener('click', async () => {
    if (!clearTimer) {
      clearToken.textContent = 'Confirm clear';
      clearToken.classList.add('confirm');
      clearTimer = setTimeout(resetClear, 3000);
      return;
    }
    resetClear();
    clearToken.disabled = true;
    setMsg(advMsg, '', '');
    const r = await putConfig({ tunnel: { namedToken: '' } });
    clearToken.disabled = false;
    if (!r.ok) {
      setMsg(advMsg, 'error', `Could not clear the token. ${failureText(r, c.url)}`);
      return;
    }
    tunnelCfg.hasNamedToken = false;
    paintToken();
    followTunnel(r); // a running named tunnel is ended by the companion (it has no token any more)
    setMsg(advMsg, 'ok', 'Token cleared.');
    named.focus();
  });
  clearToken.addEventListener('blur', () => clearTimer && resetClear());

  function setMcpWarn() {
    mcpHint.classList.toggle('warn', exposeMcp.checked);
  }

  /* --- tunnel state and polling --- */

  const stopPolling = () => {
    pollId++;
    clearTimeout(pollTimer);
    waiting = false;
  };

  // Slow check on a running tunnel. Runs only while connected, nothing else is talking to /tunnel/* and the
  // page is still on screen; every paint() re-evaluates that, so it needs no other wiring.
  let watchTimer = 0;
  let watchId = 0;
  let watchFails = 0;
  const stopWatch = () => {
    clearTimeout(watchTimer);
    watchTimer = 0;
    watchId++;
    watchFails = 0;
  };
  function syncWatch() {
    const want = connected && tunnel?.state === 'running' && !waiting && !busy;
    if (!want) {
      if (watchTimer || watchFails) stopWatch();
      return;
    }
    if (watchTimer) return;
    const my = ++watchId;
    watchTimer = setTimeout(async () => {
      watchTimer = 0;
      if (my !== watchId) return;
      if (!root.isConnected) return stopWatch();
      const r = await request(c.url, c.token, 'GET', '/tunnel/status');
      if (my !== watchId) return; // something else took over meanwhile
      if (r.ok && hasTunnelShape(r.data)) {
        watchFails = 0;
        const t = normalizeTunnel(r.data);
        const died = t.state !== 'running';
        applyTunnel(t);
        if (died) setMsg(tunnelMsg, 'warn', 'The tunnel stopped on its own, so its link and connection code no longer work.');
      } else if (++watchFails === 3) {
        setMsg(tunnelMsg, 'warn', `Lost touch with the companion, so the tunnel may no longer be running. ${failureText(r, c.url)}`);
      }
      syncWatch();
    }, TUNNEL_POLL.watchMs);
  }

  const isDone = (state, expect) => (expect === 'down' ? state === 'stopped' || state === 'error' : state === 'running' || state === 'error' || state === 'stopped');

  // Re-reads the link and code (what is exposed changed). Copy and Show wait for the answer.
  function refreshConnection() {
    if (tunnel?.state === 'running') loadConnection();
  }

  async function loadConnection() {
    const my = ++connRun;
    connLoading = true;
    paint();
    const r = await request(c.url, c.token, 'GET', '/tunnel/connection');
    if (my !== connRun) return;
    connLoading = false;
    code = r.ok && isObj(r.data) && typeof r.data.code === 'string' ? r.data.code : '';
    if (code && tunnel && typeof r.data.url === 'string' && /^https?:\/\//i.test(r.data.url) && normUrl(r.data.url) !== normUrl(tunnel.url)) {
      tunnel = { ...tunnel, url: normUrl(r.data.url) };
    }
    // 409: the companion has no tunnel to describe (yet, or any more). That is not an error: the note under the
    // buttons says the link and code come once it runs, and one status check catches a state we had out of date.
    if (!code && r.status === 409) {
      paint();
      const mine = connRun;
      const st = await request(c.url, c.token, 'GET', '/tunnel/status');
      if (mine === connRun && st.ok && hasTunnelShape(st.data)) {
        const t = normalizeTunnel(st.data);
        if (t.state !== tunnel?.state || t.url !== tunnel?.url) applyTunnel(t);
      }
      return;
    }
    if (!code) {
      setMsg(
        tunnelMsg,
        'warn',
        r.ok ? 'The tunnel is running, but the companion did not give a connection code. Click Refresh to try again.' : `Could not read the connection code. ${failureText(r, c.url)}`
      );
    }
    paint();
  }

  function applyTunnel(t, { poll = true } = {}) {
    const prev = tunnel;
    tunnel = t;
    if (t.state !== 'running') {
      code = '';
      revealed = false;
      connRun++;
      connLoading = false;
    }
    if (isDone(t.state, null)) gaveUp = false;
    paint();
    if (t.state === 'running' && (prev?.state !== 'running' || prev.url !== t.url)) loadConnection();
    if (poll && !waiting && !gaveUp && (t.state === 'downloading' || t.state === 'starting')) startPolling(null);
  }

  // expect: 'up' (after Start), 'down' (after Stop) or null (a transition seen in /status).
  function startPolling(expect) {
    stopPolling();
    const my = pollId;
    waiting = true;
    gaveUp = false;
    const t0 = Date.now();
    let fails = 0;
    paint();
    const tick = async () => {
      if (my !== pollId) return;
      if (!root.isConnected) {
        stopPolling();
        return;
      }
      const r = await request(c.url, c.token, 'GET', '/tunnel/status');
      if (my !== pollId) return;
      if (r.ok && hasTunnelShape(r.data)) {
        fails = 0;
        const t = normalizeTunnel(r.data);
        applyTunnel(t, { poll: false });
        if (isDone(t.state, expect)) {
          stopPolling();
          paint();
          return;
        }
      } else if (++fails >= 3) {
        stopPolling();
        setMsg(tunnelMsg, 'error', `Lost touch with the companion while waiting for the tunnel. ${failureText(r, c.url)}`);
        paint();
        return;
      }
      if (Date.now() - t0 >= TUNNEL_POLL.maxMs) {
        stopPolling();
        gaveUp = true;
        const what = tunnel?.state === 'downloading' ? 'downloading cloudflared' : expect === 'down' ? 'stopping' : 'starting';
        setMsg(tunnelMsg, 'warn', `Still ${what} after ${spanText(TUNNEL_POLL.maxMs)}, so this page stopped checking. Click Refresh to check again, or Stop tunnel to cancel. The companion’s terminal window may say what is wrong.`);
        paint();
        return;
      }
      pollTimer = setTimeout(tick, TUNNEL_POLL.intervalMs);
    };
    pollTimer = setTimeout(tick, TUNNEL_POLL.intervalMs);
  }

  // Start or stop: the companion answers at once with the tunnel object; progress comes from polling.
  async function command(action) {
    if (busy) return;
    busy = true;
    gaveUp = false;
    setMsg(tunnelMsg, '', '');
    paint();
    const r = await request(c.url, c.token, 'POST', `/tunnel/${action}`, { body: {}, timeout: APPLY_TIMEOUT });
    busy = false;
    if (!r.ok || !hasTunnelShape(r.data)) {
      stopPolling();
      setMsg(tunnelMsg, 'error', r.ok ? 'The companion gave an answer this page does not understand. Click Refresh.' : `Could not ${action} the tunnel. ${failureText(r, c.url)}`);
      paint();
      return;
    }
    const t = normalizeTunnel(r.data);
    const expect = action === 'start' ? 'up' : 'down';
    applyTunnel(t, { poll: false });
    if (isDone(t.state, expect)) {
      stopPolling();
      paint();
    } else startPolling(expect);
  }

  async function refreshTunnel() {
    if (busy) return;
    busy = true;
    gaveUp = false;
    setMsg(tunnelMsg, '', '');
    paint();
    const r = await request(c.url, c.token, 'GET', '/tunnel/status');
    busy = false;
    if (!r.ok || !hasTunnelShape(r.data)) {
      setMsg(tunnelMsg, 'error', r.ok ? 'The companion gave an answer this page does not understand.' : `Could not read the tunnel status. ${failureText(r, c.url)}`);
      paint();
      return;
    }
    applyTunnel(normalizeTunnel(r.data));
    if (tunnel.state === 'running' && !code && !connLoading) loadConnection();
    paint();
  }

  startBtn.addEventListener('click', () => command('start').catch((e) => setMsg(tunnelMsg, 'error', `Unexpected problem: ${e?.message || e}`)));
  stopBtn.addEventListener('click', () => command('stop').catch((e) => setMsg(tunnelMsg, 'error', `Unexpected problem: ${e?.message || e}`)));
  refreshBtn.addEventListener('click', () => refreshTunnel().catch((e) => setMsg(tunnelMsg, 'error', `Unexpected problem: ${e?.message || e}`)));

  /* --- settings that apply at once --- */

  const putConfig = (patch) => request(c.url, c.token, 'PUT', '/config', { body: patch, timeout: APPLY_TIMEOUT });
  // PUT /config answers with /status. The companion restarts a running tunnel itself when the kind or the named
  // token changes, and starts a stopped one when autostart is turned on: show that at once (polling follows it).
  const followTunnel = (r) => {
    if (isObj(r.data) && hasTunnelShape(r.data.tunnel)) applyTunnel(normalizeTunnel(r.data.tunnel));
  };

  const wireOption = (input, key) =>
    input.addEventListener('change', async () => {
      const want = input.checked;
      input.disabled = true;
      setMsg(optionsMsg, '', '');
      if (input === exposeMcp) setMcpWarn();
      const r = await putConfig({ tunnel: { [key]: want } });
      input.disabled = false;
      if (!r.ok) {
        input.checked = !want;
        if (input === exposeMcp) setMcpWarn();
        setMsg(optionsMsg, 'error', `Could not change that setting. ${failureText(r, c.url)}`);
        return;
      }
      tunnelCfg[key] = want;
      followTunnel(r);
      if (key !== 'autostart') refreshConnection(); // the code lists what is exposed
    });
  wireOption(exposeLlm, 'exposeLlm');
  wireOption(exposeMcp, 'exposeMcp');
  wireOption(autostart, 'autostart');

  // The extension's own providers whose address a tunnel can usefully reach.
  const candidates = () => (settings.providers || []).filter((p) => p && p.type === 'openai' && typeof p.baseUrl === 'string' && isPrivateUrl(p.baseUrl));
  const exposedAs = (p) => Object.entries(upstreams).find(([, v]) => normUrl(v?.url) === normUrl(p.baseUrl))?.[0];

  // The note about upstreams the companion has that no extension provider matches (they are left alone).
  function paintOthers() {
    const known = new Set(candidates().map((p) => normUrl(p.baseUrl)));
    const others = Object.entries(upstreams)
      .filter(([, v]) => !known.has(normUrl(v?.url)))
      .map(([n]) => n);
    upOther.hidden = !others.length;
    upOther.textContent = others.length ? `Also set up on the companion, and kept as they are: ${others.join(', ')}.` : '';
  }

  function renderUpstreams() {
    const list = candidates();
    upList.replaceChildren();
    for (const p of list) {
      const box = checkbox(exposedAs(p) !== undefined);
      box.dataset.providerId = p.id;
      box.id = `tunnelUpstream-${String(p.id).replace(/[^A-Za-z0-9_-]/g, '')}`;
      box.addEventListener('change', () => toggleUpstream(p, box));
      const row = el('label', 'tunnel-upstream');
      const text = el('span', 'tunnel-upstream-text');
      text.append(el('span', 'tunnel-upstream-name', p.name || 'Unnamed provider'), el('span', 'tunnel-upstream-url', p.baseUrl));
      row.append(box, text);
      upList.append(row);
    }
    upEmpty.hidden = list.length > 0;
    paintOthers();
  }

  async function toggleUpstream(p, box) {
    const want = box.checked;
    const next = JSON.parse(JSON.stringify(upstreams));
    const key = normUrl(p.baseUrl);
    if (want) {
      if (!Object.values(next).some((v) => normUrl(v?.url) === key)) next[upstreamName(p, Object.keys(next))] = { url: p.baseUrl.trim() };
    } else {
      for (const [n, v] of Object.entries(next)) if (normUrl(v?.url) === key) delete next[n];
    }
    const boxes = [...upList.querySelectorAll('input')];
    boxes.forEach((b) => (b.disabled = true));
    setMsg(optionsMsg, '', '');
    const r = await putConfig({ llmUpstreams: next });
    boxes.forEach((b) => (b.disabled = false));
    if (!r.ok) {
      box.checked = !want;
      setMsg(optionsMsg, 'error', `Could not change the list of models. ${failureText(r, c.url)}`);
      return;
    }
    upstreams = next;
    paintOthers();
    refreshConnection();
  }

  saveNamed.addEventListener('click', async () => {
    const raw = named.value.trim();
    const isNamed = kind.value === 'named';
    // The dashboard shows a whole command ("cloudflared service install <token>"); the token is its last word.
    const token = raw ? raw.split(/\s+/).pop() : '';
    named.removeAttribute('aria-invalid');
    namedUrl.removeAttribute('aria-invalid');
    if (isNamed && !token && !tunnelCfg.hasNamedToken) {
      named.setAttribute('aria-invalid', 'true');
      setMsg(advMsg, 'error', 'Paste the tunnel token first. A named tunnel cannot start without it.');
      named.focus();
      return;
    }
    const patch = { kind: kind.value };
    if (token) patch.namedToken = token; // blank keeps the saved token
    let addr = '';
    if (isNamed) {
      const u = normalizeNamedUrl(namedUrl.value);
      if (!u.ok) {
        namedUrl.setAttribute('aria-invalid', 'true');
        setMsg(advMsg, 'error', u.error);
        namedUrl.focus();
        return;
      }
      addr = u.url;
      patch.namedUrl = addr;
    }
    saveNamed.disabled = true;
    setMsg(advMsg, '', '');
    const r = await putConfig({ tunnel: patch });
    saveNamed.disabled = false;
    if (!r.ok) {
      setMsg(advMsg, 'error', `Could not save. ${failureText(r, c.url)}`);
      return;
    }
    if (named.value.trim() === raw) named.value = ''; // not if the user already typed something else
    tunnelCfg.kind = kind.value;
    lastKind = kind.value;
    if (isNamed) {
      tunnelCfg.namedUrl = addr;
      if (namedUrl.value.trim() === addr || normalizeNamedUrl(namedUrl.value).url === addr) namedUrl.value = addr;
      lastNamedUrl = addr;
    }
    if (token) tunnelCfg.hasNamedToken = true;
    paintToken();
    const wasActive = tunnel?.state === 'running' || tunnel?.state === 'starting' || tunnel?.state === 'downloading';
    followTunnel(r);
    setMsg(advMsg, 'ok', wasActive && tunnel?.state !== 'running' ? 'Saved. The tunnel is restarting with the new settings.' : 'Saved.');
  });

  /* --- hooks from the Computer tools section --- */

  function setStatus(s) {
    connected = isObj(s);
    off.hidden = connected;
    body.hidden = !connected;
    if (!connected) {
      // Whatever was shown belonged to the connection that is gone; the next good /status starts afresh.
      stopPolling();
      tunnel = null;
      code = '';
      revealed = false;
      connRun++;
      connLoading = false;
      gaveUp = false;
      configKnown = false;
      upstreams = {};
      for (const m of [tunnelMsg, optionsMsg, advMsg]) setMsg(m, '', '');
      paint();
      renderUpstreams();
      return;
    }
    if (isObj(s.tunnel)) applyTunnel(normalizeTunnel(s.tunnel));
    else if (!tunnel) applyTunnel(normalizeTunnel({}));
    if (!configKnown && isObj(s.remote)) {
      exposeLlm.checked = !!s.remote.exposeLlm;
      exposeMcp.checked = !!s.remote.exposeMcp;
      setMcpWarn();
    }
  }

  function setConfig(cfg) {
    configKnown = isObj(cfg);
    const tc = isObj(cfg?.tunnel) ? cfg.tunnel : {};
    const flag = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
    const has = isObj(cfg?.tunnel); // a companion without tunnel support reports none: nothing is on there
    tunnelCfg = {
      exposeLlm: flag(tc.exposeLlm, has),
      exposeMcp: flag(tc.exposeMcp, false),
      autostart: flag(tc.autostart, false),
      kind: tc.kind === 'named' ? 'named' : 'quick',
      hasNamedToken: !!tc.hasNamedToken,
      namedUrl: typeof tc.namedUrl === 'string' ? tc.namedUrl : '',
    };
    if (!exposeLlm.disabled) exposeLlm.checked = tunnelCfg.exposeLlm;
    if (!exposeMcp.disabled) exposeMcp.checked = tunnelCfg.exposeMcp;
    if (!autostart.disabled) autostart.checked = tunnelCfg.autostart;
    setMcpWarn();
    // Unsaved edits in these two survive a refresh; untouched ones follow the companion.
    if (kind.value === lastKind) kind.value = tunnelCfg.kind;
    lastKind = tunnelCfg.kind;
    if (namedUrl.value === lastNamedUrl) namedUrl.value = tunnelCfg.namedUrl;
    lastNamedUrl = tunnelCfg.namedUrl;
    paintNamed();
    paintToken();
    upstreams = isObj(cfg?.llmUpstreams) ? JSON.parse(JSON.stringify(cfg.llmUpstreams)) : {};
    renderUpstreams();
  }

  renderUpstreams();
  paint();
  paintToken();
  return { root, hooks: { onStatus: setStatus, onConfig: setConfig }, refreshProviders: renderUpstreams };
}

/* ---------- Providers: Add from connection code ---------- */

// Returns { button, form }. `onAdded()` runs after providers (and maybe an MCP server) were added to `settings`.
export function providerCodeControls(settings, kit, { onAdded } = {}) {
  const { el, textInput, button, field, checkField, checkbox } = kit;

  const open = button('Add from connection code');
  open.id = 'providerAddFromCode';
  open.setAttribute('aria-expanded', 'false');
  open.setAttribute('aria-controls', 'providerCodeForm');

  const form = el('div', 'card provider-code');
  form.id = 'providerCodeForm';
  form.hidden = true;

  const input = textInput('', 'password', 'aa1:…');
  input.id = 'providerCodeInput';
  input.className = 'mono';
  const inputField = field('Connection code', input, 'Paste the code from Settings → Remote access in the other browser. It includes the access token, so it is hidden here.');
  const reveal = button('Show');
  reveal.id = 'providerCodeShow';
  reveal.setAttribute('aria-controls', input.id);
  reveal.setAttribute('aria-pressed', 'false');
  reveal.setAttribute('aria-label', 'Show code');
  reveal.addEventListener('click', () => {
    const on = input.type === 'password';
    input.type = on ? 'text' : 'password';
    reveal.textContent = on ? 'Hide' : 'Show';
    reveal.setAttribute('aria-pressed', String(on));
    reveal.setAttribute('aria-label', on ? 'Hide code' : 'Show code');
  });
  const inputRow = el('div', 'input-row');
  inputField.replaceChild(inputRow, input);
  inputRow.append(input, reveal);

  const mcp = checkbox(false);
  mcp.id = 'providerCodeMcp';
  const mcpField = checkField('Also add its computer tools as a remote MCP server', mcp, 'This code includes the computer tools of the computer that made it.');
  const msg = newMsg(el, 'providerCodeMsg');
  const add = button('Add', 'primary');
  add.id = 'providerCodeAdd';
  const cancel = button('Cancel');
  const actions = el('div', 'card-actions');
  actions.append(add, cancel);
  mcpField.id = 'providerCodeMcpField';
  mcpField.hidden = true; // shown only while the pasted code carries an MCP address
  form.append(inputField, mcpField, msg, actions);

  // Follows what is pasted: the box exists only for a code that offers computer tools.
  const syncMcp = () => {
    const p = input.value.trim() ? parseConnectionCode(input.value) : null;
    const offered = !!(p?.ok && p.mcp);
    mcpField.hidden = !offered;
    if (!offered) mcp.checked = false;
  };

  const setOpen = (on) => {
    form.hidden = !on;
    open.setAttribute('aria-expanded', String(on));
    if (on) input.focus();
  };
  open.addEventListener('click', () => setOpen(form.hidden));
  cancel.addEventListener('click', () => {
    setMsg(msg, '', '');
    input.value = '';
    input.removeAttribute('aria-invalid');
    syncMcp();
    setOpen(false);
    open.focus();
  });
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    if (msg.classList.contains('error')) setMsg(msg, '', '');
    syncMcp();
  });

  const run = () => {
    const parsed = parseConnectionCode(input.value);
    if (!parsed.ok) {
      input.setAttribute('aria-invalid', 'true');
      setMsg(msg, 'error', parsed.error);
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    syncMcp();
    const wantMcp = !!parsed.mcp && mcp.checked;
    if (!parsed.models.length && !wantMcp) {
      setMsg(
        msg,
        'error',
        parsed.mcp
          ? 'This code does not list any local models. Tick the box above to add only its computer tools.'
          : 'This code has nothing to add: it lists no local models, and its computer is not sharing its computer tools. Check “Expose local models” and the model list under Settings → Remote access there.'
      );
      return;
    }
    const r = applyConnectionCode(settings, parsed, { mcp: wantMcp });
    const parts = [];
    if (r.providers.length) parts.push(plural(r.providers.length, 'provider'));
    if (r.server) parts.push('a remote MCP server');
    const notes = [];
    if (r.skipped) notes.push(`${plural(r.skipped, 'provider')} already in the list ${r.skipped === 1 ? 'was' : 'were'} left as ${r.skipped === 1 ? 'it is' : 'they are'}.`);
    if (r.serverSkipped) notes.push('That MCP server is already in the list.');
    if (!parts.length) {
      setMsg(msg, 'warn', `Nothing was added. ${notes.join(' ')}`.trim());
      return;
    }
    input.value = '';
    syncMcp();
    onAdded?.(r);
    const next = r.providers.length ? ' Next: use Test connection on a new provider to load its models.' : '';
    setMsg(msg, 'ok', `Added ${parts.join(' and ')}.${next}${notes.length ? ` ${notes.join(' ')}` : ''}`);
  };
  add.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });

  return { button: open, form };
}

/* ---------- Remote MCP: per-server Test ---------- */

async function runMcpTest(cfg) {
  let mod;
  try {
    mod = await import('./mcp.js');
  } catch (e) {
    return { ok: false, error: `Could not load the MCP client: ${e?.message || e}` };
  }
  if (typeof mod.testMcpServer !== 'function') return { ok: false, error: 'Testing servers is not available in this version.' };
  try {
    return await mod.testMcpServer(cfg, AbortSignal.timeout(20000));
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// A Test button plus its result area for one remote MCP server. `getCfg()` returns the server's current settings.
export function mcpTestControls(kit, getCfg) {
  const { el, button } = kit;
  const btn = button('Test');
  btn.dataset.role = 'mcp-test';
  const result = el('div', 'test-result');
  result.dataset.role = 'mcp-result';
  result.setAttribute('role', 'status');
  result.hidden = true;

  btn.addEventListener('click', async () => {
    const s = getCfg();
    result.hidden = false;
    result.className = 'test-result';
    if (!str(s.url).trim()) {
      result.classList.add('error');
      result.textContent = 'Enter the server URL first.';
      return;
    }
    btn.disabled = true;
    result.textContent = 'Testing…';
    try {
      const r = await runMcpTest({ name: s.name, url: s.url, headers: s.headers });
      if (r?.ok) {
        const tools = Array.isArray(r.tools) ? r.tools : [];
        result.classList.add('ok');
        if (!tools.length) {
          result.textContent = '✓ Connected, but the server lists no tools.';
        } else {
          const d = el('details', 'mcp-tools');
          d.append(el('summary', null, `✓ ${plural(tools.length, 'tool')}`));
          const ul = el('ul', 'mcp-tool-list');
          for (const t of tools) {
            const first = str(t?.description).split(/\r?\n/)[0].trim();
            const li = el('li');
            li.append(el('span', 'mcp-tool-name', str(t?.name)));
            if (first) li.append(' ', el('span', 'mcp-tool-desc', first.length > 140 ? `${first.slice(0, 139)}…` : first));
            ul.append(li);
          }
          d.append(ul);
          result.replaceChildren(d);
        }
      } else {
        result.classList.add('error');
        result.textContent = r?.error || 'The server did not respond.';
      }
    } finally {
      btn.disabled = false;
    }
  });
  return { button: btn, result };
}

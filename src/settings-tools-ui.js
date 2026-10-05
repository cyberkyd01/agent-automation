// Settings sections for tools that run outside the browser: the local companion program ("Computer tools")
// and the per-server Test button of "Remote MCP servers".
// settings-ui.js hands in its own field helpers (`kit`), so everything here looks and behaves like the rest of
// Settings. The pure helpers below are exported so they can be tested without a DOM.
import { repoLink } from './util.js';

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

async function copyText(text, node) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  // Fallback: select the text so Ctrl/Cmd+C works even if programmatic copying is blocked.
  try {
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

/* ---------- Computer tools ---------- */

export function computerToolsSection(settings, kit) {
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

  const codeBlock = (text, label) => {
    const wrap = el('div', 'codeblock');
    const code = el('code', 'codeblock-text', text);
    const copy = button('Copy');
    copy.setAttribute('aria-label', label);
    let timer = 0;
    copy.addEventListener('click', async () => {
      const ok = await copyText(text, code);
      copy.textContent = ok ? 'Copied' : 'Ctrl/⌘+C';
      clearTimeout(timer);
      timer = setTimeout(() => (copy.textContent = 'Copy'), 1800);
    });
    wrap.append(code, copy);
    return wrap;
  };

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
  manage.append(manageHead, manageMsg, cfgErrorBox, editor);
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
      if (!quiet) onFail?.(s.ok ? { ...s, ok: false, bad: true } : s);
      return false;
    }
    statusData = s.data;
    setResultStatus(statusData);
    if (!statusOnly) {
      const cf = await request(c.url, c.token, 'GET', '/config');
      if (id !== run) return false;
      if (cf.ok && isObj(cf.data)) {
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
        const f = explainFailure(h, { base: c.url });
        setResultMsg(f.kind, f.parts, f.hint);
        return;
      }
      if (!isObj(h.data) || h.data.name !== 'agent-companion') {
        const f = explainFailure({ ok: false, status: h.status, bad: true }, { base: c.url });
        setResultMsg(f.kind, f.parts, f.hint);
        return;
      }
      const version = str(h.data.version);
      if (!c.token) {
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
        statusData = live;
        setResultStatus(live);
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

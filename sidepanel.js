// The side panel is a view: every chat, its agent, queue and saving live in the engine (src/engine/engine.js,
// in Chrome's offscreen document), which keeps working when the panel is closed. The panel connects to it over
// the 'panel' port (src/engine/PROTOCOL.md), renders what it is told and sends commands.
import { fileToAssetData, formatBytes, toBlob } from './src/files.js';
import { md, stripToolCalls } from './src/markdown.js';
import { listModels, pickModel } from './src/providers.js';
import { isZipFile, sessionToMarkdown, store, titleFrom } from './src/sessions.js';
import { renderSettings } from './src/settings-ui.js';
import { loadSettings, saveSettings, syncOriginRules } from './src/storage.js';
import { newId, repoLink, safeParse, sleep, splitThink } from './src/util.js';

const CUSTOM_MODEL = '__custom__';
const TOOL_TEXT_LIMIT = 4000;
const CONFIRM_MS = 5000;
const STORE_TIMEOUT = 10000; // a storage call slower than this is reported, never waited on forever
const DRAFT_DELAY = 300;
const HISTORY_PAGE = 60;
const DEFAULT_TITLE = 'New chat';
const PLACEHOLDER = 'Ask anything, or give me a task…';
const MODE_LABEL = { auto: 'Run all', step: 'One at a time' };
const PORT_NAME = 'panel';
const TO_HOST = 'aa-host';
const SUGGESTIONS = [
  'Summarise this page',
  'Find unanswered customer enquiries on this page and draft replies',
  'Compare this page with similar products on the web',
  'Extract the table on this page as CSV',
];

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const providerSel = $('provider');
const modelSel = $('model');
const modelCustom = $('modelCustom');
const reloadBtn = $('reloadModels');
const historyBtn = $('openHistory');
const settingsBtn = $('openSettings');
const tabList = $('tabList');
const newTabBtn = $('newTab');
const statusEl = $('status');
const chatsEl = $('chats');
const queueBar = $('queueBar');
const queueToggle = $('queueToggle');
const queueSummary = $('queueSummary');
const queueRunNext = $('queueRunNext');
const queueRunAll = $('queueRunAll');
const queueResume = $('queueResume');
const queueClear = $('queueClear');
const queueBody = $('queueBody');
const queueModeSel = $('queueMode');
const queueListEl = $('queueList');
const attachRow = $('attachments');
const input = $('input');
const approvalSel = $('approval');
const attachBtn = $('attach');
const fileInput = $('fileInput');
const batchBtn = $('batchOpen');
const tabEl = $('tab');
const tabIcon = $('tabIcon');
const tabTitle = $('tabTitle');
const stopBtn = $('stop');
const sendBtn = $('send');
const announceEl = $('announce');
const settingsEl = $('settings');
const settingsBody = $('settingsBody');
const closeSettingsBtn = $('closeSettings');
const historyEl = $('history');
const closeHistoryBtn = $('closeHistory');
const historyImportBtn = $('historyImport');
const historyExportAllBtn = $('historyExportAll');
const importInput = $('importInput');
const historySearch = $('historySearch');
const historyThisSite = $('historyThisSite');
const historyNotice = $('historyNotice');
const historyBody = $('historyBody');
const historyList = $('historyList');
const historyEmpty = $('historyEmpty');
const historyMore = $('historyMore');
const batchEl = $('batch');
const closeBatchBtn = $('closeBatch');
const batchItems = $('batchItems');
const batchTemplate = $('batchTemplate');
const batchCount = $('batchCount');
const batchPreview = $('batchPreview');
const batchCancelBtn = $('batchCancel');
const batchAddBtn = $('batchAdd');
const batchModeInputs = [...document.querySelectorAll('input[name="batchMode"]')];

let settings = null;
let windowId = null;
let statusSeq = 0;
let currentTab = null; // the active browser tab, for session meta and the "This site" filter
let active = null; // the chat session shown in the panel
let queueClearArmed = null;
let batchTarget = null;
let closeFocus = null; // where focus goes when the active chat-tab closes
const sessions = new Map(); // id → session view, in tab order
const loadingModels = new Set();
const chatOwner = new WeakMap();
const resizer = new ResizeObserver((entries) => {
  for (const e of entries) {
    const s = chatOwner.get(e.target);
    if (s) follow(s);
  }
});

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function option(value, label, { disabled = false, selected = false } = {}) {
  const o = el('option', null, label);
  o.value = value;
  o.disabled = disabled;
  o.selected = selected;
  return o;
}

function button(cls, label, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function withTimeout(promise, ms, what = 'The browser storage') {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} is not responding.`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
const errText = (e) => e?.message || String(e ?? 'Unknown error');
// Storage errors already read "Could not … the chat: why"; don't say it twice.
const failText = (prefix, e) => {
  const t = typeof e === 'string' ? e : errText(e);
  return /^Could not /.test(t) ? t : `${prefix}: ${t}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  up: ['M12 19V5', 'M5 12l7-7 7 7'],
  down: ['M12 5v14', 'M19 12l-7 7-7-7'],
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'],
  remove: ['M18 6L6 18', 'M6 6l12 12'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  clip: ['M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'],
};

function svgIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

function iconButton(name, label, action) {
  const b = button(`icon i-${name}`);
  b.title = label;
  b.setAttribute('aria-label', label);
  if (action) b.dataset.action = action;
  b.append(svgIcon(name));
  return b;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}

function typeBadge(name = '', mime = '') {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  const sub = /\/(?:x-|vnd\.)?([a-z0-9]+)/i.exec(mime)?.[1];
  return (ext || sub || 'file').slice(0, 4).toUpperCase();
}

const announce = (text) => (announceEl.textContent = text);

/* ---------- status line ---------- */

function setStatus(text, kind = 'info') {
  statusEl.textContent = text || '';
  statusEl.className = kind === 'error' ? 'error' : '';
  statusEl.hidden = !text;
  return ++statusSeq;
}

const clearStatus = (seq) => seq === statusSeq && setStatus('');

function flashStatus(text, ms = 4000) {
  const seq = setStatus(text);
  setTimeout(() => clearStatus(seq), ms);
}

/* ---------- the engine connection ---------- */

const engine = { port: null, connected: false, seq: 0, calls: new Map(), firstSnapshot: true, statusSeq: 0, connecting: null };

// Sends a command. With { reply: false } nothing is awaited; otherwise resolves with the engine's answer.
function cmd(t, args = {}, { reply = true } = {}) {
  const port = engine.connected ? engine.port : null;
  if (!port) return reply ? Promise.reject(new Error('The agent is not connected yet — try again in a moment.')) : Promise.resolve();
  const msg = { t, ...args };
  let p = Promise.resolve();
  if (reply) {
    msg.rid = ++engine.seq;
    p = new Promise((resolve, reject) => engine.calls.set(msg.rid, { resolve, reject }));
  }
  try {
    port.postMessage(msg);
  } catch (e) {
    if (reply) engine.calls.delete(msg.rid);
    return reply ? Promise.reject(new Error('The connection to the agent was lost.')) : Promise.resolve();
  }
  return p;
}

const tell = (t, args) => void cmd(t, args, { reply: false });

function connectEngine() {
  engine.connecting ??= (async () => {
    for (let attempt = 0; ; attempt++) {
      // Chrome: the service worker starts the offscreen document. Elsewhere nobody answers, which is fine.
      let problem = '';
      try {
        const r = await chrome.runtime.sendMessage({ to: TO_HOST, op: 'ensureEngine' });
        if (r && !r.ok) problem = r.error?.message || 'unknown error';
      } catch {}
      if (await openPort()) break;
      if (attempt >= 2) engine.statusSeq = setStatus(problem ? `Could not start the agent (${problem}). Retrying…` : 'Connecting to the agent…', problem ? 'error' : 'info');
      await sleep(Math.min(2000, 150 * (attempt + 1)));
    }
  })().finally(() => (engine.connecting = null));
  return engine.connecting;
}

function openPort() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      return resolve(false);
    }
    let up = false;
    port.onMessage.addListener((m) => {
      if (!up && m?.t === 'snapshot') {
        up = true;
        engine.port = port;
        engine.connected = true;
        resolve(true);
      }
      if (up) onEngineMessage(m);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!up) return resolve(false);
      if (engine.port === port) onDisconnected();
    });
    try {
      port.postMessage({ t: 'hello', windowId });
    } catch {
      resolve(false);
    }
  });
}

function onDisconnected() {
  engine.port = null;
  engine.connected = false;
  for (const { reject } of engine.calls.values()) reject(new Error('The connection to the agent was lost.'));
  engine.calls.clear();
  updateComposer();
  engine.statusSeq = setStatus('Reconnecting to the agent…');
  connectEngine();
}

function onEngineMessage(m) {
  switch (m?.t) {
    case 'reply': {
      const c = engine.calls.get(m.rid);
      if (!c) return;
      engine.calls.delete(m.rid);
      if (m.ok) c.resolve(m.value);
      else c.reject(new Error(m.error || 'Unknown error'));
      return;
    }
    case 'snapshot':
      return onSnapshot(m);
    case 'sessions':
      return syncSessions(m.sessions, m.activeId);
    case 'state': {
      const s = sessions.get(m.s?.id);
      if (s) applyState(s, m.s);
      return;
    }
    case 'items': {
      const s = sessions.get(m.sid);
      if (s) renderItems(s, m.items, m.assets);
      return;
    }
    case 'item': {
      const s = sessions.get(m.sid);
      if (s?.ready) upsertItem(s, m.item);
      return;
    }
    case 'itemRemoved': {
      const s = sessions.get(m.sid);
      const rec = s?.nodes.get(m.id);
      if (rec) {
        rec.node?.remove();
        s.nodes.delete(m.id);
      }
      return;
    }
    case 'asset': {
      const s = sessions.get(m.sid);
      if (s && m.asset?.id) s.assets.set(m.asset.id, m.asset);
      return;
    }
    case 'assetRemoved': {
      const s = sessions.get(m.sid);
      if (s) s.assets.delete(m.id);
      return;
    }
    case 'status':
      return setStatus(m.text, m.kind);
    case 'draftBack': {
      const s = sessions.get(m.sid);
      if (s) returnToComposer(s, m.text, m.ids);
      return;
    }
    case 'focus': {
      const s = sessions.get(m.sid);
      if (s) activate(s, { focus: 'none' });
      return;
    }
  }
}

function onSnapshot(m) {
  clearStatus(engine.statusSeq);
  syncSessions(m.sessions || [], m.activeId, { snapshot: true });
  for (const [id, d] of Object.entries(m.drafts || {})) {
    const s = sessions.get(id);
    if (!s || (s === active ? input.value : s.draft) || s.pending.length) continue;
    s.draft = String(d?.text || '');
    s.pending = Array.isArray(d?.pending) ? d.pending.map(String) : [];
    if (s === active) {
      input.value = s.draft;
      autosize();
      renderChips();
    }
  }
  const first = engine.firstSnapshot;
  engine.firstSnapshot = false;
  const want = (active && sessions.get(active.id)) || sessions.get(m.activeId) || [...sessions.values()].at(-1);
  if (want) activate(want, { focus: first ? 'input' : 'none', force: true });
  updateComposer();
}

/* ---------- scrolling ---------- */

const nearBottom = (c) => c.scrollHeight - c.scrollTop - c.clientHeight < 60;

// Keep following new content only while the user hasn't scrolled up to read.
function follow(s, force = false) {
  if (force) s.pinned = true;
  if (s.pinned) s.chat.scrollTop = s.chat.scrollHeight;
}

function add(s, node) {
  s.chat.querySelector('.empty, .pane-loading')?.remove();
  s.chat.append(node);
  markUnread(s);
  follow(s);
  return node;
}

/* ---------- chat views (each bound to one session) ---------- */

function showEmpty(s) {
  const wrap = el('div', 'empty');
  wrap.append(
    el('div', 'empty-title', 'What can I do for you?'),
    el(
      'p',
      'empty-text',
      'I can read the page beside me, click, type, fill in forms, open tabs and search the web. In “Ask before acting” mode you approve each action first.'
    )
  );
  const list = el('div', 'suggestions');
  for (const text of SUGGESTIONS) {
    list.append(
      button('suggestion', text, () => {
        if (s !== active) return;
        input.value = text;
        autosize();
        updateComposer();
        input.focus();
        syncDraft(s);
      })
    );
  }
  wrap.append(list);
  const rate = repoLink('empty-link', '★ Rate on GitHub');
  if (rate) wrap.append(rate);
  s.chat.replaceChildren(wrap);
}

function showLoading(s) {
  s.chat.replaceChildren(el('div', 'pane-loading', 'Loading chat…'));
}

function thumb(src, { onRemove, label, s } = {}) {
  const wrap = el('div', 'thumb');
  const open = button('thumb-open');
  open.title = label ? `${label} — open in a new tab` : 'Open image in a new tab';
  const img = el('img');
  img.alt = label || '';
  img.src = src;
  if (s) img.addEventListener('load', () => follow(s));
  open.append(img);
  open.addEventListener('click', () => openImage(src));
  wrap.append(open);
  if (onRemove) wrap.append(removeX(`Remove ${label || 'image'}`, onRemove, 'thumb-x'));
  return wrap;
}

function removeX(label, onClick, cls) {
  const x = button(cls, '×', onClick);
  x.title = 'Remove';
  x.setAttribute('aria-label', label);
  return x;
}

function thumbs(list, s) {
  const r = el('div', 'thumbs');
  for (const src of list) r.append(thumb(src, { s }));
  return r;
}

// The engine hands over an object URL for each asset's Blob (thumbnails, Download links); v1.0 inline images
// keep their data URL.
function urlFor(s, a) {
  if (typeof a?.src === 'string') return a.src;
  return s.assets.get(String(a?.id ?? '').toLowerCase())?.url || '';
}

// One attachment: a thumbnail for images we have bytes for, otherwise a type badge + name + size.
function attachmentChip(a, { onRemove, s } = {}) {
  const src = (a.kind === 'image' || /^image\//.test(a.mime || '')) && s ? urlFor(s, a) : '';
  if (src) {
    const t = thumb(src, { onRemove, label: a.name, s });
    t.dataset.assetId = a.id || '';
    return t;
  }
  const c = el('div', 'chip');
  c.dataset.assetId = a.id || '';
  const size = Number.isFinite(a.size) ? formatBytes(a.size) : '';
  c.title = [a.name || a.id, size].filter(Boolean).join(' · ');
  c.append(el('span', 'chip-badge', typeBadge(a.name, a.mime)), el('span', 'chip-name', a.name || a.id || 'file'));
  if (size) c.append(el('span', 'chip-size', size));
  if (onRemove) c.append(removeX(`Remove ${a.name || 'file'}`, onRemove, 'chip-x'));
  return c;
}

function loadingChip(name) {
  const c = el('div', 'chip loading');
  c.title = `Reading ${name}…`;
  c.append(el('span', 'chip-spin'), el('span', 'chip-name', name), el('span', 'chip-size', 'reading…'));
  return c;
}

async function openImage(src) {
  let url = src;
  try {
    // Chrome blocks top-level navigation to data: URLs, so hand it over as a blob URL.
    if (src.startsWith('data:')) {
      url = URL.createObjectURL(await (await fetch(src)).blob());
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    await chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

function userBubble(s, text, atts = []) {
  const m = el('div', 'msg user');
  if (atts.length) {
    const row = el('div', 'thumbs');
    for (const a of atts) row.append(attachmentChip(a, { s }));
    m.append(row);
  }
  if (text) m.append(el('div', 'text', text));
  return add(s, m);
}

function workingDots() {
  const w = el('div', 'working');
  w.setAttribute('role', 'img');
  w.setAttribute('aria-label', 'Working');
  w.append(el('span'), el('span'), el('span'));
  return w;
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const wrap = el('div', 'code');
    pre.replaceWith(wrap);
    const b = button('copy', 'Copy', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Copy failed';
      }
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    });
    wrap.append(pre, b);
  }
}

function assistantView(s) {
  const wrap = el('div', 'msg assistant');
  const think = el('details', 'think live');
  const thinkBody = el('div', 'think-body');
  think.append(el('summary', null, 'Thinking'), thinkBody);
  think.hidden = true;
  const body = el('div', 'md');
  body.hidden = true;
  const dots = workingDots();
  wrap.append(think, body, dots);
  add(s, wrap);

  let latest = { content: '', reasoning: '' };
  let raf = 0;
  let finished = false;
  let shownText = null;
  let shownThink = null;

  const render = () => {
    raf = 0;
    const { body: text, think: inlineThink } = splitThink(stripToolCalls(latest.content));
    const reasoning = [stripToolCalls(latest.reasoning).trim(), inlineThink].filter(Boolean).join('\n\n');
    if (reasoning !== shownThink) {
      thinkBody.textContent = reasoning;
      think.hidden = !reasoning;
      shownThink = reasoning;
    }
    const t = text.trim();
    if (t !== shownText) {
      body.innerHTML = md(t);
      body.hidden = !t;
      shownText = t;
    }
    if (t || reasoning) dots.remove();
    follow(s);
    return Boolean(t || reasoning);
  };

  return {
    node: wrap,
    apply(item) {
      if (finished) return;
      latest = { content: item.content || '', reasoning: item.reasoning || '' };
      if (!item.done) {
        markUnread(s);
        if (!raf) raf = requestAnimationFrame(render);
        return;
      }
      // Renders synchronously: requestAnimationFrame doesn't fire while the panel is hidden.
      finished = true;
      if (raf) cancelAnimationFrame(raf);
      const any = render();
      dots.remove();
      think.classList.remove('live');
      if (!any) wrap.remove();
      else addCopyButtons(body);
    },
  };
}

const ARG_FIRST = { type: 0, action: 0, url: 1, id: 2 };
const RAW_KEYS = new Set(['type', 'action', 'selector', 'key', 'keys', 'direction', 'mode', 'format']);

// One-line summary such as "id 12" or "https://…" for the collapsed tool card.
function argSummary(args) {
  if (args == null || args === '') return '';
  if (typeof args !== 'object') return clip(String(args).replace(/\s+/g, ' '), 70);
  const entries = Object.entries(args)
    .filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
    .sort(([a], [b]) => (ARG_FIRST[a] ?? 9) - (ARG_FIRST[b] ?? 9));
  const parts = entries.map(([k, v]) => {
    if (typeof v !== 'string' || /^(id|tabId|.*_id)$/i.test(k)) return `${k} ${v}`;
    const t = v.replace(/\s+/g, ' ').trim();
    return /^https?:\/\//i.test(t) || RAW_KEYS.has(k) ? t : `"${clip(t, 40)}"`;
  });
  return clip(parts.join(' · '), 70);
}

const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '');
const capText = (t) => (t.length > TOOL_TEXT_LIMIT ? `${t.slice(0, TOOL_TEXT_LIMIT)}\n… (${t.length - TOOL_TEXT_LIMIT} more characters)` : t);

function toolCard(s, item) {
  const args = item.args;
  const parsed = typeof args === 'string' ? safeParse(args, null) ?? args : args;
  const wrap = el('div', 'tool running');
  const det = el('details');
  const sum = el('summary');
  const icon = el('span', 'tool-icon');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', 'Running');
  sum.append(icon, el('span', 'tool-name', item.name || 'tool'));
  const summary = argSummary(parsed);
  if (summary) sum.append(el('span', 'tool-arg', summary));
  const body = el('div', 'tool-body');
  body.append(el('div', 'tool-label', 'Input'), el('pre', 'tool-pre', capText(pretty(parsed ?? {}))));
  det.append(sum, body);
  wrap.append(det);
  add(s, wrap);

  let askBar = null;
  let finished = false;
  const setState = (state, label, glyph) => {
    wrap.classList.remove('running', 'ok', 'error', 'stopped', 'asking');
    wrap.classList.add(state);
    icon.textContent = glyph;
    icon.setAttribute('aria-label', label);
  };
  const closeAsk = () => {
    if (!askBar) return;
    askBar.remove();
    askBar = null;
    wrap.classList.remove('asking');
  };
  const showAsk = (ask) => {
    det.open = true;
    wrap.classList.add('asking');
    const sensitive = Boolean(ask?.sensitive);
    const bar = el('div', 'ask');
    askBar = bar;
    markUnread(s);
    const choice = (label, value, cls) =>
      button(`btn ${cls}`.trim(), label, () => {
        closeAsk();
        cmd('approve', { id: s.id, itemId: item.id, answer: value }).catch((e) => setStatus(errText(e), 'error'));
      });
    bar.append(el('span', 'ask-q', 'Allow this action?'));
    if (sensitive) bar.append(el('span', 'ask-warn', 'Caution: this tool acts on your computer, outside the browser.'));
    bar.append(
      choice('Allow', 'allow', 'primary'),
      choice(sensitive ? 'Always allow this tool (this chat)' : 'Allow all (this chat)', 'always', ''),
      choice('Deny', 'deny', 'danger')
    );
    wrap.append(bar);
    // Approval needs attention even if the user scrolled up.
    if (s === active) bar.scrollIntoView({ block: 'nearest' });
    follow(s);
  };

  const view = {
    node: wrap,
    apply(it) {
      if (finished) return;
      if (it.state === 'running') {
        if (it.ask && !askBar) showAsk(it.ask);
        else if (!it.ask && askBar) closeAsk();
        return;
      }
      finished = true;
      closeAsk();
      if (it.state === 'stopped') return setState('stopped', 'Stopped', '–');
      const isError = it.state === 'error';
      setState(isError ? 'error' : 'ok', isError ? 'Failed' : 'Done', isError ? '✕' : '✓');
      const out = it.result == null ? '' : typeof it.result === 'string' ? it.result : pretty(it.result);
      body.append(el('div', 'tool-label', isError ? 'Error' : 'Result'), el('pre', `tool-pre${isError ? ' err' : ''}`, capText(out || '(no output)')));
      if (isError && out) sum.title = clip(out.replace(/\s+/g, ' '), 200);
      if (it.images?.length) body.append(thumbs(it.images, s));
      markUnread(s);
      follow(s);
    },
  };
  view.apply(item);
  return view;
}

// item.actions: [{ label, id }] — small buttons; the engine removes them when the next job starts.
function noticeView(s, item) {
  const n = el('div', `notice ${item.kind === 'error' ? 'error' : 'info'}`);
  n.append(el('span', 'notice-text', String(item.text ?? '')));
  if (item.kind === 'error') n.setAttribute('role', 'alert');
  let box = null;
  if (item.actions?.length) {
    box = el('span', 'notice-actions');
    for (const a of item.actions) {
      const b = button('btn', a.label, () => {
        box?.remove();
        box = null;
        cmd('noticeAction', { id: s.id, itemId: item.id, action: a.id, page: pageInfo() }).catch((e) => setStatus(errText(e), 'error'));
      });
      if (a.id) b.dataset.action = a.id;
      box.append(b);
    }
    n.append(box);
  }
  add(s, n);
  return {
    node: n,
    apply(it) {
      if (!it.actions?.length && box) {
        box.remove();
        box = null;
      }
    },
  };
}

function fileName(id, mime) {
  const ext = (/^image\/([a-z0-9.+-]+)/i.exec(mime || '')?.[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  return `${String(id || 'image').replace(/[^\w.-]+/g, '_')}.${ext}`;
}

function assetCard(s, a) {
  const url = a ? urlFor(s, a) : '';
  if (!url) return null;
  const { id, label } = a;
  const isImage = a.kind ? a.kind === 'image' : /^image\//i.test(a.mime || '');
  const card = el('div', isImage ? 'asset' : 'asset file');
  card.dataset.assetId = id || '';
  if (isImage) {
    const open = button('asset-img');
    open.title = 'Open in a new tab';
    const img = el('img');
    img.alt = a.name || label || id || 'Generated image';
    img.src = url;
    img.addEventListener('load', () => follow(s));
    open.append(img);
    open.addEventListener('click', () => openImage(url));
    card.append(open);
  } else {
    const head = el('div', 'asset-file');
    const info = el('div', 'asset-file-info');
    const name = el('span', 'asset-file-name', a.name || id || 'file');
    name.title = a.name || '';
    info.append(name, el('span', 'asset-file-size', [Number.isFinite(a.size) ? formatBytes(a.size) : '', a.mime].filter(Boolean).join(' · ')));
    head.append(el('span', 'file-badge', typeBadge(a.name, a.mime)), info);
    card.append(head);
  }

  const meta = el('div', 'asset-meta');
  if (id) meta.append(el('code', 'asset-id', id));
  if (label) {
    const l = el('span', 'asset-label', label);
    l.title = label;
    meta.append(l);
  }
  const dl = el('a', 'btn', 'Download');
  dl.href = url;
  dl.download = a.name || fileName(id, a.mime);
  const attach = button('btn', 'Attach', () => attachExisting(s, id));
  attach.title = 'Add to the message you are writing';
  attach.dataset.action = 'attach-asset';
  const foot = el('div', 'asset-foot');
  foot.append(meta, dl, attach);
  card.append(foot);
  return add(s, card);
}

/* ---------- transcript items (built by the engine) ---------- */

function renderItem(s, item) {
  switch (item.type) {
    case 'user':
      return { node: userBubble(s, item.text, Array.isArray(item.atts) ? item.atts : []) };
    case 'assistant': {
      const v = assistantView(s);
      v.apply(item);
      return v;
    }
    case 'tool':
      return toolCard(s, item);
    case 'notice':
      return noticeView(s, item);
    case 'asset':
      return { node: assetCard(s, s.assets.get(String(item.assetId).toLowerCase())) };
  }
  return null;
}

function upsertItem(s, item) {
  if (!item?.id) return;
  const rec = s.nodes.get(item.id);
  if (rec) return rec.apply?.(item);
  const r = renderItem(s, item);
  if (r) s.nodes.set(item.id, r);
}

function renderItems(s, items, assets) {
  s.assets = new Map((Array.isArray(assets) ? assets : []).filter((a) => a?.id).map((a) => [a.id, a]));
  s.restoring = true;
  s.chat.replaceChildren();
  s.nodes.clear();
  try {
    for (const item of Array.isArray(items) ? items : []) upsertItem(s, item);
  } finally {
    s.restoring = false;
  }
  s.ready = true;
  if (!s.chat.children.length) showEmpty(s);
  if (s === active) {
    renderChips();
    renderQueue();
    updateComposer();
  }
  follow(s, true);
}

/* ---------- sessions ---------- */

function createView(st) {
  const s = {
    id: String(st.id),
    meta: st.meta || { id: st.id, title: DEFAULT_TITLE },
    state: st,
    ready: false, // its transcript has arrived
    restoring: false,
    nodes: new Map(), // item id → { node, apply }
    assets: new Map(), // asset id → { id, kind, name, mime, size, label, url }
    draft: '',
    pending: [], // asset ids attached to the draft
    loadingNames: [],
    attaching: 0,
    queueOpen: false,
    pinned: true,
    unread: false,
    saveBanner: null,
    loadBanner: null,
    draftTimer: 0,
    starting: false,
    closed: false,
    closeArmed: false,
    closeTimer: 0,
  };
  buildTab(s);
  buildPane(s);
  sessions.set(s.id, s);
  renderBanners(s);
  return s;
}

// The engine's list of open chats (the same in every panel): add, update, drop and order the tabs.
function syncSessions(states, engineActive, { snapshot = false } = {}) {
  const ids = states.map((x) => String(x.id));
  const before = [...sessions.keys()];
  const wasActive = active;
  for (const s of [...sessions.values()]) if (!ids.includes(s.id) && !s.opening) dropView(s);
  for (const st of states) {
    const s = sessions.get(String(st.id));
    if (!s) createView(st);
    else {
      // A restarted engine has not loaded this chat yet.
      if (snapshot && !st.ready && s.ready) {
        s.ready = false;
        s.nodes.clear();
        s.chat.replaceChildren();
      }
      applyState(s, st);
    }
  }
  // Same order as the engine (a chat still being opened stays at the end).
  const ordered = [...ids.map((id) => sessions.get(id)).filter(Boolean), ...[...sessions.values()].filter((s) => s.opening && !ids.includes(s.id))];
  sessions.clear();
  for (const s of ordered) {
    sessions.set(s.id, s);
    tabList.append(s.tab);
  }
  if (wasActive && !sessions.has(wasActive.id)) {
    active = null;
    const i = before.indexOf(wasActive.id);
    const next = before.slice(i + 1).map((id) => sessions.get(id)).find(Boolean) || before.slice(0, i).reverse().map((id) => sessions.get(id)).find(Boolean) || sessions.get(engineActive);
    const focus = closeFocus || 'input';
    closeFocus = null;
    if (next) activate(next, { focus });
  }
  if (!active && !snapshot && sessions.size) activate(sessions.get(engineActive) || [...sessions.values()].at(-1));
}

function dropView(s) {
  s.closed = true;
  clearTimeout(s.closeTimer);
  clearTimeout(s.draftTimer);
  resizer.unobserve(s.chat);
  s.tab.remove();
  s.pane.remove();
  sessions.delete(s.id);
  if (batchTarget === s) batchTarget = null;
  if (queueClearArmed === s) disarmQueueClear();
}

function applyState(s, st) {
  const wasRunning = s.state?.running;
  // Sent, and the engine has not answered yet: it is starting.
  if (s.starting && !st.running) st = { ...st, running: true };
  s.state = st;
  if (st.meta && !(s.starting && st.meta.title === DEFAULT_TITLE)) s.meta = st.meta;
  if (!st.running && wasRunning) disarmClose(s);
  renderTab(s);
  renderBanners(s);
  if (s === active) {
    renderQueue();
    updateComposer();
  }
}

function buildTab(s) {
  const t = el('div', 'ctab');
  t.id = `ctab-${s.id}`;
  t.dataset.sessionId = s.id;
  t.setAttribute('role', 'tab');
  t.setAttribute('aria-selected', 'false');
  t.setAttribute('aria-controls', `pane-${s.id}`);
  t.setAttribute('aria-keyshortcuts', 'F2 Delete');
  t.tabIndex = -1;
  const ind = el('span', 'ctab-ind');
  ind.setAttribute('aria-hidden', 'true');
  const title = el('span', 'ctab-title');
  // Not a nested button (tabs can't contain controls); keyboard users close with Delete.
  const x = el('span', 'ctab-x', '×');
  x.setAttribute('aria-hidden', 'true');
  x.dataset.action = 'close';
  x.title = 'Close chat';
  t.append(ind, title, x);
  tabList.append(t);
  Object.assign(s, { tab: t, tabTitle: title, tabClose: x });
  renderTab(s);
}

function renderTab(s) {
  if (!s.tab) return;
  const title = s.meta.title || DEFAULT_TITLE;
  const retitled = s.tabTitle.textContent !== title;
  if (!s.tab.querySelector('.ctab-edit')) s.tabTitle.textContent = title;
  s.tab.title = [title, s.meta.pageTitle || hostOf(s.meta.url)].filter(Boolean).join('\n');
  const states = [];
  const flag = (cls, on, label) => {
    s.tab.classList.toggle(cls, Boolean(on));
    if (on) states.push(label);
  };
  flag('running', s.state?.running, 'running');
  flag('asking', s.state?.asking > 0, 'waiting for your approval');
  flag('unread', s.unread, 'new output');
  flag('save-failed', s.state?.saveError, 'not saved');
  s.tab.setAttribute('aria-label', [title, ...states].join(', '));
  // The first prompt's title widens the tab, which can push the active tab past the strip's edge.
  if (retitled && s === active) s.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function buildPane(s) {
  const pane = el('div', 'pane');
  pane.id = `pane-${s.id}`;
  pane.dataset.sessionId = s.id;
  pane.setAttribute('role', 'tabpanel');
  pane.setAttribute('aria-labelledby', `ctab-${s.id}`);
  pane.hidden = true;
  const banners = el('div', 'pane-banners');
  const chat = el('div', 'chat');
  chat.setAttribute('aria-label', 'Conversation');
  chat.addEventListener('scroll', () => (s.pinned = nearBottom(chat)), { passive: true });
  chatOwner.set(chat, s);
  resizer.observe(chat);
  pane.append(banners, chat);
  chatsEl.append(pane);
  Object.assign(s, { pane, banners, chat });
}

function markUnread(s) {
  if (s === active || s.restoring || s.unread || s.closed) return;
  s.unread = true;
  renderTab(s);
}

function activate(s, { focus = 'input', force = false } = {}) {
  if (!s || s.closed) return;
  const prev = active;
  if (prev && prev !== s && !prev.closed) {
    prev.draft = input.value;
    syncDraft(prev, true);
  }
  if (prev !== s) disarmQueueClear();
  active = s;
  for (const x of sessions.values()) {
    const on = x === s;
    x.tab.classList.toggle('active', on);
    x.tab.setAttribute('aria-selected', String(on));
    x.tab.tabIndex = on ? 0 : -1;
    x.pane.hidden = !on;
  }
  s.unread = false;
  renderTab(s);
  // Its transcript comes from the engine (which loads it from the store first if needed).
  if (!s.ready && !s.state?.loadError && !s.chat.children.length) showLoading(s);
  s.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (prev !== s || force) {
    input.value = s.draft;
    autosize();
  }
  renderChips();
  renderQueue();
  updateComposer();
  follow(s);
  if (prev !== s || force) tell('activate', { id: s.id });
  if (focus === 'input' && !input.disabled) input.focus();
  else if (focus === 'tab') s.tab.focus();
}

// Shown at once under an id chosen here; the engine creates the chat with it.
async function newTab() {
  if (!engine.connected) return null;
  const prev = active;
  const id = crypto.randomUUID();
  const p = cmd('new', { id });
  const s = createView({ id, meta: { id, title: DEFAULT_TITLE }, ready: true, running: false, asking: 0, queue: [] });
  s.opening = true;
  renderItems(s, [], []);
  activate(s);
  try {
    await p;
    return s;
  } catch (e) {
    if (!s.closed) dropView(s);
    if (active === s || !active) {
      active = null;
      const next = (prev && sessions.get(prev.id)) || [...sessions.values()].at(-1);
      if (next) activate(next);
    }
    setStatus(failText('Could not open a new chat', e), 'error');
    return null;
  } finally {
    s.opening = false;
  }
}

// A brand-new chat nobody has touched: replacing it loses nothing.
const isPristine = (s) => !s.state?.stored && s.ready && !s.state?.running && !s.nodes.size && !s.state?.queue?.length && !s.pending.length && !s.attaching && !(s === active ? input.value : s.draft || '').trim();

async function openSession(id, meta = { id }) {
  const existing = sessions.get(id);
  if (existing) {
    activate(existing);
    return existing;
  }
  const prev = active;
  const p = cmd('open', { id, meta, replace: prev && isPristine(prev) ? prev.id : null });
  // Shown (loading) at once; the engine's list of open chats confirms it.
  const s = createView({ id, meta: { ...meta, id, title: meta?.title || DEFAULT_TITLE }, ready: false, running: false, asking: 0, queue: [] });
  s.opening = true;
  activate(s);
  try {
    await p;
  } catch (e) {
    if (!s.closed) dropView(s);
    if (active === s || !active) {
      active = null;
      const next = (prev && sessions.get(prev.id)) || [...sessions.values()].at(-1);
      if (next) activate(next);
    }
    throw e;
  } finally {
    s.opening = false;
  }
  return sessions.get(id) || s;
}

function syncDraft(s, now = false) {
  if (!s || s.closed) return;
  clearTimeout(s.draftTimer);
  const send = () => tell('draft', { id: s.id, text: s === active ? input.value : s.draft, pending: s.pending });
  if (now) send();
  else s.draftTimer = setTimeout(send, DRAFT_DELAY);
}

const pageInfo = () => ({ url: currentTab?.url || '', title: currentTab?.title || '' });

/* ---------- banners (load and save problems) ---------- */

function banner(kind, text, actions = []) {
  const b = el('div', `banner ${kind}`);
  b.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  b.append(el('span', 'banner-text', text));
  const box = el('span', 'banner-actions');
  for (const a of actions) {
    const btn = button('btn', a.label, a.run);
    if (a.id) btn.dataset.action = a.id;
    box.append(btn);
  }
  b.append(box);
  return b;
}

function renderBanners(s) {
  const le = s.state?.loadError;
  const loadKey = le ? `${le.text}|${le.retry}` : '';
  if (loadKey !== (s.loadBanner?.dataset.key || '')) {
    s.loadBanner?.remove();
    s.loadBanner = null;
    if (le) {
      const actions = [];
      if (le.retry) actions.push({ label: 'Retry', id: 'retry-load', run: () => tell('load', { id: s.id }) });
      actions.push({ label: 'Close tab', id: 'close-tab', run: () => closeSession(s, { save: false }) });
      s.loadBanner = banner('error', le.text, actions);
      s.loadBanner.dataset.key = loadKey;
      s.banners.append(s.loadBanner);
      if (!s.ready) s.chat.replaceChildren();
    }
  }
  const se = s.state?.saveError;
  const saveKey = se ? `${se}|${!!s.state.closeBlocked}` : '';
  if (saveKey !== (s.saveBanner?.dataset.key || '')) {
    if (!se) {
      s.saveBanner?.remove();
      s.saveBanner = null;
    } else {
      const actions = [{ label: 'Retry', id: 'retry-save', run: () => cmd('retrySave', { id: s.id }).catch(() => {}) }];
      if (s.state.closeBlocked) actions.push({ label: 'Close without saving', id: 'close-unsaved', run: () => closeSession(s, { save: false }) });
      const b = banner('error', failText('Could not save this chat', se), actions);
      b.dataset.kind = 'save-error';
      b.dataset.key = saveKey;
      if (s.saveBanner) s.saveBanner.replaceWith(b);
      else s.banners.prepend(b);
      s.saveBanner = b;
    }
  }
}

/* ---------- running jobs & the queue ---------- */

function modelProblem() {
  const p = activeProvider();
  if (!p) return 'Add a model provider in Settings first.';
  if (!p.model) return 'Choose a model first: reload the list or pick “Custom model ID…”.';
  return '';
}

function stopSession(s) {
  if (!s?.state?.running) return;
  tell('stop', { id: s.id });
}

function submit() {
  const s = active;
  if (!s || !s.ready || s.attaching || !engine.connected) return;
  const text = input.value.trim();
  if (!text && !s.pending.length) return;
  const running = Boolean(s.state?.running);
  if (!running) {
    const problem = modelProblem();
    if (problem) return setStatus(problem, 'error');
  }
  const ids = s.pending.splice(0);
  const qid = newId();
  clearComposer(s);
  // Shown at once (queued item, or the job running); the engine's state confirms it.
  if (running) s.state = { ...s.state, queue: [...(s.state.queue || []), { id: qid, text, attachmentIds: ids }] };
  else {
    s.starting = true;
    // The first prompt names the chat (the engine does the same), so the tab does not change size later.
    if (!s.nodes.size && (s.meta.title || DEFAULT_TITLE) === DEFAULT_TITLE) {
      const names = ids.map((id) => s.assets.get(id)?.name).filter(Boolean);
      s.meta = { ...s.meta, title: titleFrom(text || names.join(', ')) || DEFAULT_TITLE };
    }
  }
  applyState(s, s.state);
  cmd('send', { id: s.id, text, attachmentIds: ids, qid, page: pageInfo() }).then(
    (r) => {
      s.starting = false;
      if (r?.queued) announce(`Added to the queue. ${plural(r.n, 'prompt')} waiting.`);
    },
    (e) => {
      // Nothing was started or queued: undo what was shown.
      const was = s.starting;
      s.starting = false;
      applyState(s, { ...s.state, running: was ? false : s.state.running, queue: queueOf(s).filter((x) => x.id !== qid) });
      returnToComposer(s, text, ids);
      setStatus(errText(e), 'error');
    }
  );
  syncDraft(s, true);
}

function clearComposer(s) {
  s.draft = '';
  if (s !== active) return;
  input.value = '';
  autosize();
  renderChips();
}

function returnToComposer(s, text, ids = []) {
  const current = s === active ? input.value : s.draft;
  const merged = [current, text].filter((x) => x && x.trim()).join('\n\n');
  for (const id of ids || []) if (!s.pending.includes(id)) s.pending.push(id);
  if (s === active) {
    input.value = merged;
    autosize();
    renderChips();
  } else s.draft = merged;
  syncDraft(s);
}

const queueOf = (s) => (Array.isArray(s?.state?.queue) ? s.state.queue : []);

function renderQueue() {
  const s = active;
  const q = queueOf(s);
  const n = s?.ready ? q.length : 0;
  queueBar.hidden = !n;
  if (!n) {
    queueBar.dataset.state = 'empty';
    queueListEl.replaceChildren();
    return;
  }
  const mode = queueMode();
  const running = Boolean(s.state.running);
  const paused = s.state.paused && !running;
  const waiting = !running && !s.state.paused;
  queueBar.classList.toggle('paused', paused);
  queueBar.dataset.state = running ? 'running' : paused ? 'paused' : 'waiting';
  queueSummary.textContent = paused ? `Paused — ${n} queued` : running ? `${n} queued · ${MODE_LABEL[mode]}` : `${n} queued`;
  queueRunNext.hidden = !waiting;
  queueRunAll.hidden = !waiting || n < 2;
  queueResume.hidden = !paused;
  queueClear.hidden = !paused && !s.queueOpen;
  if (queueClearArmed !== s) {
    queueClear.textContent = 'Clear';
    queueClear.classList.remove('confirm');
  }
  queueModeSel.value = mode;
  queueToggle.setAttribute('aria-expanded', String(s.queueOpen));
  queueToggle.title = s.queueOpen ? 'Hide queued prompts' : 'Show queued prompts';
  queueBody.hidden = !s.queueOpen;
  if (s.queueOpen) renderQueueItems(s);
}

function renderQueueItems(s) {
  const q = queueOf(s);
  const last = q.length - 1;
  queueListEl.replaceChildren(
    ...q.map((item, i) => {
      const li = el('li', 'queue-item');
      li.dataset.queueId = item.id;
      const text = el('span', 'q-text', item.text.replace(/\s+/g, ' ').trim() || '(attachments only)');
      text.title = item.text;
      li.append(el('span', 'q-num', String(i + 1)), text);
      const k = item.attachmentIds.length;
      if (k) {
        const att = el('span', 'q-att');
        att.title = plural(k, 'attachment');
        att.append(svgIcon('clip'), String(k));
        li.append(att);
      }
      const up = iconButton('up', 'Move up', 'up');
      up.disabled = i === 0;
      const down = iconButton('down', 'Move down', 'down');
      down.disabled = i === last;
      li.append(up, down, iconButton('edit', 'Edit: move back to the message box', 'edit'), iconButton('remove', 'Remove from the queue', 'remove'));
      return li;
    })
  );
}

// Queue edits show at once on a local copy; the engine does the same and its state replaces the copy.
function localQueue(s, fn) {
  const q = [...queueOf(s)];
  fn(q);
  s.state = { ...s.state, queue: q, ...(q.length ? {} : { paused: false, drain: false }) };
  renderQueue();
}

function onQueueItemClick(e) {
  const b = e.target.closest('button[data-action]');
  const s = active;
  if (!b || !s) return;
  const id = b.closest('.queue-item')?.dataset.queueId;
  const i = queueOf(s).findIndex((q) => q.id === id);
  if (i < 0) return;
  const action = b.dataset.action;
  let item = null;
  localQueue(s, (q) => {
    if (action === 'up' && i > 0) [q[i - 1], q[i]] = [q[i], q[i - 1]];
    else if (action === 'down' && i < q.length - 1) [q[i + 1], q[i]] = [q[i], q[i + 1]];
    else if (action === 'remove' || action === 'edit') [item] = q.splice(i, 1);
  });
  if (action === 'edit' && item) {
    returnToComposer(s, item.text, item.attachmentIds);
    input.focus();
  }
  tell('queue', { id: s.id, op: action, itemId: id });
  if (action === 'up' || action === 'down') {
    const li = [...queueListEl.children].find((x) => x.dataset.queueId === id);
    const same = li?.querySelector(`[data-action="${action}"]`);
    (same && !same.disabled ? same : li?.querySelector('[data-action="edit"]'))?.focus();
  }
}

function disarmQueueClear() {
  queueClearArmed = null;
  queueClear.textContent = 'Clear';
  queueClear.classList.remove('confirm');
}

function onQueueClear() {
  const s = active;
  if (!s) return;
  if (queueClearArmed !== s) {
    queueClearArmed = s;
    queueClear.textContent = `Clear ${queueOf(s).length}?`;
    queueClear.classList.add('confirm');
    setTimeout(() => queueClearArmed === s && disarmQueueClear(), CONFIRM_MS);
    return;
  }
  disarmQueueClear();
  localQueue(s, (q) => void q.splice(0));
  tell('queue', { id: s.id, op: 'clear' });
  announce('Queue cleared.');
  input.focus();
}

// The engine checks the model first, like Send (a problem pauses the queue and shows in the status line).
function queueRun(op) {
  const s = active;
  if (s) tell('queue', { id: s.id, op, page: pageInfo() });
}

/* ---------- closing tabs ---------- */

function requestClose(s) {
  if (s.state?.running && !s.closeArmed) return armClose(s);
  closeSession(s);
}

function armClose(s) {
  s.closeArmed = true;
  s.tab.classList.add('confirm');
  s.tabClose.textContent = 'Stop and close';
  s.tabClose.title = 'This chat is still working. Click again to stop it and close the tab.';
  announce('This chat is still working. Press Delete again, or click “Stop and close”, to stop it and close the tab.');
  clearTimeout(s.closeTimer);
  s.closeTimer = setTimeout(() => disarmClose(s), CONFIRM_MS);
  s.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function disarmClose(s) {
  if (!s.closeArmed) return;
  s.closeArmed = false;
  clearTimeout(s.closeTimer);
  s.tab.classList.remove('confirm');
  s.tabClose.textContent = '×';
  s.tabClose.title = 'Close chat';
}

// Closing never deletes: the chat stays in History. save:false skips the final save (used before deleting).
async function closeSession(s, { save = true } = {}) {
  if (s.closed) return false;
  disarmClose(s);
  if (s === active) {
    s.draft = input.value;
    closeFocus = tabList.contains(document.activeElement) ? 'tab' : 'input';
  }
  syncDraft(s, true);
  let r;
  try {
    r = await cmd('close', { id: s.id, save });
  } catch (e) {
    setStatus(failText('Could not close this chat', e), 'error');
    return false;
  }
  if (!r?.closed && !s.closed) {
    closeFocus = null;
    activate(s);
    announce('This chat could not be saved, so it was kept open.');
    return false;
  }
  return true;
}

/* ---------- renaming ---------- */

async function renameChat(id, title) {
  const s = sessions.get(id);
  if (s) {
    s.meta = { ...s.meta, title };
    renderTab(s);
  }
  await cmd('rename', { id, title });
}

function startTabRename(s) {
  if (s.tab.querySelector('.ctab-edit')) return;
  const box = el('input', 'ctab-edit');
  box.type = 'text';
  box.value = s.meta.title;
  box.maxLength = 120;
  box.spellcheck = false;
  box.setAttribute('aria-label', 'Chat name');
  s.tabTitle.hidden = true;
  s.tab.insertBefore(box, s.tabClose);
  box.focus();
  box.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const v = box.value.replace(/\s+/g, ' ').trim();
    box.remove();
    s.tabTitle.hidden = false;
    renderTab(s);
    if (s === active) s.tab.focus();
    if (!commit || !v || v === s.meta.title) return;
    try {
      await renameChat(s.id, v);
    } catch (e) {
      tell('notice', { id: s.id, text: failText('Could not rename this chat', e), kind: 'error' });
    }
  };
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  box.addEventListener('blur', () => finish(true));
  for (const type of ['click', 'dblclick']) box.addEventListener(type, (e) => e.stopPropagation());
}

/* ---------- attachments ---------- */

function attachmentInfo(s, id) {
  const a = s.assets.get(String(id).toLowerCase());
  return a ? { ...a } : { id, kind: 'file', name: id };
}

function renderChips() {
  const s = active;
  if (!s) return;
  const chips = s.pending.map((id) => attachmentChip(attachmentInfo(s, id), { onRemove: () => removePending(s, id), s }));
  for (const name of s.loadingNames) chips.push(loadingChip(name));
  attachRow.replaceChildren(...chips);
  attachRow.hidden = !chips.length;
  updateComposer();
}

// The file goes straight into the chat store (shared with the engine); the engine then takes it from there.
async function attachOne(s, f) {
  const d = await fileToAssetData(f);
  const meta = await cmd('attachReserve', { id: s.id, name: d.name, mime: d.mime, size: d.size });
  const ms = STORE_TIMEOUT + Math.ceil((Number(d.size) || 0) / 5e6) * 1000;
  await withTimeout(store.putAsset(s.id, { ...meta, blob: toBlob(d.blob, meta.mime) }), ms);
  const asset = await cmd('attach', { id: s.id, assetId: meta.id });
  s.assets.set(asset.id, asset);
  return asset;
}

async function addFiles(s, files) {
  if (!s || !files.length) return;
  const names = files.map((f) => f.name || 'file');
  s.attaching += files.length;
  s.loadingNames.push(...names);
  if (s === active) renderChips();
  for (const [i, f] of files.entries()) {
    const name = names[i];
    try {
      const asset = await attachOne(s, f);
      if (!s.closed && asset?.id && !s.pending.includes(asset.id)) s.pending.push(asset.id);
    } catch (e) {
      const msg = errText(e);
      const text = msg.includes(name) ? msg : `Could not attach ${name}: ${msg}`;
      cmd('notice', { id: s.id, text, kind: 'error' }).catch(() => setStatus(text, 'error'));
    } finally {
      s.attaching--;
      s.loadingNames.splice(s.loadingNames.indexOf(name), 1);
      if (s === active) renderChips();
    }
  }
  syncDraft(s);
}

function attachExisting(s, id) {
  if (!id || !s.assets.has(id)) return;
  if (!s.pending.includes(id)) s.pending.push(id);
  if (s === active) {
    renderChips();
    input.focus();
  }
  syncDraft(s);
}

function removePending(s, id) {
  s.pending = s.pending.filter((x) => x !== id);
  // The engine drops the file if nothing else uses it (a queued prompt, the history).
  tell('discard', { id: s.id, assetId: id });
  renderChips();
  input.focus();
  syncDraft(s);
}

/* ---------- providers & models ---------- */

const activeProvider = () => settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0] || null;
const queueMode = () => (settings?.queueMode === 'step' ? 'step' : 'auto');

async function saveAll() {
  approvalSel.value = settings.approval;
  try {
    await saveSettings(settings);
  } catch (e) {
    setStatus(`Could not save settings: ${errText(e)}`, 'error');
  }
  // The engine also hears about it from chrome.storage; this makes the change apply at once.
  tell('settings');
}

function renderProviderSelect() {
  const p = activeProvider();
  if (p && settings.activeProviderId !== p.id) {
    settings.activeProviderId = p.id;
    saveAll();
  }
  providerSel.replaceChildren(...settings.providers.map((x) => option(x.id, x.name || x.baseUrl || 'Unnamed', { selected: x === p })));
  if (!p) providerSel.append(option('', 'No providers', { selected: true }));
  providerSel.disabled = !p;
  providerSel.title = p ? `${p.name}${p.baseUrl ? ` · ${p.baseUrl}` : ''}` : 'Add a provider in Settings';
}

function renderModels() {
  const p = activeProvider();
  modelSel.replaceChildren();
  modelSel.disabled = !p;
  if (!p) {
    modelSel.append(option('', 'No model', { selected: true }));
    return;
  }
  if (!p.model && p.models?.length) {
    p.model = pickModel(p.models);
    saveAll();
  }
  const list = [...(p.models || [])];
  if (p.model && !list.includes(p.model)) list.unshift(p.model);
  if (!p.model) {
    const label = loadingModels.has(p.id) ? 'Loading models…' : 'Select a model';
    modelSel.append(option('', label, { disabled: true, selected: true }));
  }
  for (const m of list) modelSel.append(option(m, m, { selected: m === p.model }));
  modelSel.append(option(CUSTOM_MODEL, 'Custom model ID…'));
  modelSel.title = p.model || 'Model';
}

async function fetchModels(p, { quiet = false } = {}) {
  if (!p || loadingModels.has(p.id)) return;
  loadingModels.add(p.id);
  reloadBtn.classList.add('busy');
  const seq = quiet ? null : setStatus(`Loading models from ${p.name || p.baseUrl}…`);
  if (p === activeProvider()) renderModels();
  try {
    const models = await listModels(p, AbortSignal.timeout(20000));
    p.models = models;
    if (!p.model) p.model = pickModel(models);
    await saveAll();
    if (p === activeProvider()) {
      if (!models.length) setStatus(`${p.name} returned no models. Download or load one, then reload.`, 'error');
      else if (seq) clearStatus(seq);
    }
  } catch (e) {
    if (p === activeProvider()) setStatus(errText(e), 'error');
  } finally {
    loadingModels.delete(p.id);
    reloadBtn.classList.toggle('busy', loadingModels.size > 0);
    if (p === activeProvider() && modelCustom.hidden) renderModels();
  }
}

function openCustomModel() {
  const p = activeProvider();
  modelCustom.value = p?.model || '';
  modelSel.hidden = true;
  modelCustom.hidden = false;
  modelCustom.focus();
  modelCustom.select();
}

function closeCustomModel(commit) {
  if (modelCustom.hidden) return;
  const p = activeProvider();
  const v = modelCustom.value.trim();
  modelCustom.hidden = true;
  modelSel.hidden = false;
  if (commit && p && v && v !== p.model) {
    p.model = v;
    saveAll();
  }
  renderModels();
}

/* ---------- composer ---------- */

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function updateComposer() {
  const s = active;
  const running = Boolean(s?.state?.running);
  input.disabled = !s;
  input.placeholder = running ? 'Add a prompt to the queue…' : PLACEHOLDER;
  sendBtn.textContent = running ? 'Queue' : 'Send';
  sendBtn.title = running ? 'Add to the queue — it runs when the current job ends (Enter)' : 'Send (Enter)';
  sendBtn.disabled = !s || !s.ready || !engine.connected || s.attaching > 0 || (!input.value.trim() && !s.pending.length);
  stopBtn.hidden = !running;
  attachBtn.disabled = !s;
  batchBtn.disabled = !s || !s.ready;
  document.body.classList.toggle('running', running);
}

/* ---------- active browser tab ---------- */

async function updateTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}
  currentTab = tab || null;
  if (!historyEl.hidden) updateThisSite(true);
  if (!tab) {
    tabTitle.textContent = 'No active tab';
    tabEl.title = '';
    tabIcon.hidden = true;
    return;
  }
  tabTitle.textContent = tab.title || tab.url || 'Untitled tab';
  tabEl.title = [tab.title, tab.url].filter(Boolean).join('\n');
  // chrome:// favicons can't be loaded from an extension page.
  const icon = /^(https?|data):/.test(tab.favIconUrl || '') ? tab.favIconUrl : '';
  if (icon) {
    if (tabIcon.getAttribute('src') !== icon) tabIcon.src = icon;
    tabIcon.hidden = false;
  } else {
    tabIcon.hidden = true;
    tabIcon.removeAttribute('src');
  }
}

/* ---------- settings overlay ---------- */

function openSettings() {
  closeCustomModel(false);
  renderSettings(settingsBody, settings, {
    save: saveAll,
    onProvidersChanged: () => {
      renderProviderSelect();
      renderModels();
    },
  });
  if (FIREFOX) firefoxSettings();
  appEl.inert = true;
  settingsEl.hidden = false;
  settingsBody.scrollTop = 0;
  closeSettingsBtn.focus();
}

function closeSettings() {
  // Blur first so a field being edited fires its change event (and saves).
  if (settingsEl.contains(document.activeElement)) document.activeElement.blur();
  settingsEl.hidden = true;
  appEl.inert = false;
  settingsBody.replaceChildren();
  approvalSel.value = settings.approval;
  renderProviderSelect();
  renderModels();
  renderQueue();
  const p = activeProvider();
  if (p && !p.models?.length && (p.baseUrl || p.type === 'anthropic')) fetchModels(p, { quiet: true });
  settingsBtn.focus();
}

/* ---------- history overlay ---------- */

const hist = { metas: [], rows: [], shown: 0, seq: 0 };

function relTime(ts) {
  const t = Number(ts);
  if (!t) return '';
  const d = Date.now() - t;
  const min = 60000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (d < min) return 'just now';
  if (d < hour) return `${Math.floor(d / min)} min ago`;
  if (d < day) return `${Math.floor(d / hour)} h ago`;
  if (d < 2 * day) return 'yesterday';
  if (d < 7 * day) return `${Math.floor(d / day)} days ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
}

function historyMessage(text, kind = 'info') {
  historyNotice.textContent = text || '';
  historyNotice.className = kind === 'error' ? 'error' : '';
  historyNotice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  historyNotice.hidden = !text;
}

let siteOrigin = '';

function updateThisSite(rerender = false) {
  const origin = originOf(currentTab?.url);
  const changed = origin !== siteOrigin;
  siteOrigin = origin;
  historyThisSite.disabled = !origin;
  historyThisSite.closest('label').title = origin
    ? `Only chats started on ${hostOf(currentTab.url)}`
    : 'The active browser tab is not a web page';
  const wasChecked = historyThisSite.checked;
  if (!origin) historyThisSite.checked = false;
  // Tab updates fire often while a page loads; only re-filter when the site really changed.
  if (rerender && changed && wasChecked && hist.metas.length) renderHistoryList();
}

function setHistoryEmpty(text, { retry = false } = {}) {
  historyEmpty.replaceChildren();
  historyEmpty.hidden = !text;
  if (!text) return;
  historyEmpty.append(el('p', null, text));
  if (retry) {
    const b = button('btn', 'Retry', loadHistory);
    b.dataset.action = 'retry';
    historyEmpty.append(b);
  }
}

// The engine writes chats; before reading the store, let it finish what it has pending.
const flushEngine = (args = {}) => withTimeout(cmd('flush', args), STORE_TIMEOUT + 1000, 'The agent').catch(() => {});

async function openHistory() {
  closeCustomModel(false);
  appEl.inert = true;
  historyEl.hidden = false;
  historyMessage('');
  updateThisSite();
  historySearch.focus();
  historySearch.select();
  historyList.replaceChildren();
  historyMore.hidden = true;
  setHistoryEmpty('Loading…');
  await flushEngine({ timeout: 1500 });
  await loadHistory();
}

function closeHistory({ focus = 'button' } = {}) {
  if (historyEl.contains(document.activeElement)) document.activeElement.blur();
  historyEl.hidden = true;
  appEl.inert = false;
  hist.seq++;
  hist.metas = [];
  hist.rows = [];
  historyList.replaceChildren();
  historyMore.hidden = true;
  setHistoryEmpty('');
  if (focus === 'button') historyBtn.focus();
  else if (focus === 'input' && !input.disabled) input.focus();
}

async function loadHistory() {
  const seq = ++hist.seq;
  let metas;
  try {
    metas = await withTimeout(store.list(), STORE_TIMEOUT);
  } catch (e) {
    if (seq !== hist.seq) return;
    historyList.replaceChildren();
    historyMore.hidden = true;
    setHistoryEmpty(failText('Could not load saved chats', e), { retry: true });
    return;
  }
  if (seq !== hist.seq || historyEl.hidden) return;
  hist.metas = Array.isArray(metas) ? metas.filter((m) => m && m.id) : [];
  renderHistoryList();
}

function filteredMetas() {
  const q = historySearch.value.trim().toLowerCase();
  const origin = historyThisSite.checked ? originOf(currentTab?.url) : '';
  return hist.metas.filter((m) => {
    if (historyThisSite.checked && (!origin || originOf(m.url) !== origin)) return false;
    if (!q) return true;
    return [m.title, m.preview, m.url, m.pageTitle].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
  });
}

function renderHistoryList() {
  hist.rows = filteredMetas();
  hist.shown = 0;
  historyList.replaceChildren();
  historyBody.scrollTop = 0;
  const msg = hist.rows.length
    ? ''
    : !hist.metas.length
      ? 'No saved chats yet. Chats are saved automatically as you go.'
      : historySearch.value.trim()
        ? 'No chats match your search.'
        : 'No chats from this site yet.';
  setHistoryEmpty(msg);
  appendHistoryRows();
}

// Incremental: a page of rows at a time, more as the list scrolls.
function appendHistoryRows() {
  const end = Math.min(hist.rows.length, hist.shown + HISTORY_PAGE);
  const frag = document.createDocumentFragment();
  for (let i = hist.shown; i < end; i++) frag.append(historyRow(hist.rows[i]));
  hist.shown = end;
  historyList.append(frag);
  updateHistoryMore();
}

function updateHistoryMore() {
  const left = hist.rows.length - hist.shown;
  historyMore.hidden = left <= 0;
  historyMore.textContent = `Show more (${left})`;
}

function historyRow(m) {
  const row = el('div', 'hist-row');
  row.setAttribute('role', 'listitem');
  row.dataset.sessionId = m.id;
  const main = button('hist-main');
  main.dataset.action = 'open';
  main.title = m.preview ? `Open — ${clip(String(m.preview), 140)}` : 'Open this chat';
  const line = el('span', 'hist-title-line');
  line.append(el('span', 'hist-title', m.title || DEFAULT_TITLE));
  if (sessions.has(m.id)) line.append(el('span', 'hist-badge', 'In a tab'));
  const n = Number(m.messageCount) || 0;
  const bits = [relTime(m.updatedAt), hostOf(m.url), n ? plural(n, 'message') : ''].filter(Boolean);
  main.append(line, el('span', 'hist-meta', bits.join(' · ')));
  const more = iconButton('more', `Actions for “${m.title || DEFAULT_TITLE}”`, 'more');
  more.classList.add('hist-toggle');
  more.setAttribute('aria-expanded', 'false');
  row.append(main, more);
  return row;
}

const rowOf = (id) => [...historyList.children].find((r) => r.dataset.sessionId === id);
const metaOf = (id) => hist.metas.find((m) => m.id === id);

function toggleRowActions(row) {
  const open = row.querySelector('.hist-actions');
  for (const r of historyList.querySelectorAll('.hist-actions')) {
    r.remove();
  }
  for (const t of historyList.querySelectorAll('.hist-toggle[aria-expanded="true"]')) t.setAttribute('aria-expanded', 'false');
  if (open) return;
  const box = el('div', 'hist-actions');
  for (const [action, label, cls] of [
    ['open', 'Open', 'primary'],
    ['rename', 'Rename'],
    ['export-json', 'Export'],
    ['export-md', 'Export Markdown'],
    ['delete', 'Delete', 'danger'],
  ]) {
    const b = button(`btn ${cls || ''}`.trim(), label);
    b.dataset.action = action;
    box.append(b);
  }
  row.append(box);
  row.querySelector('.hist-toggle').setAttribute('aria-expanded', 'true');
}

async function onHistoryClick(e) {
  const b = e.target.closest('[data-action]');
  if (!b || !historyList.contains(b)) return;
  const row = b.closest('.hist-row');
  const id = row?.dataset.sessionId;
  switch (b.dataset.action) {
    case 'more':
      return toggleRowActions(row);
    case 'open':
      return openFromHistory(id);
    case 'rename':
      return startHistoryRename(row, id);
    case 'export-json':
      return withBusy(b, 'Exporting…', () => exportJson(id));
    case 'export-md':
      return withBusy(b, 'Exporting…', () => exportMarkdown(id));
    case 'delete':
      return confirmDelete(b, id);
  }
}

async function openFromHistory(id) {
  const meta = metaOf(id) || { id };
  closeHistory({ focus: 'none' });
  try {
    await openSession(id, meta);
  } catch (e) {
    setStatus(failText('Could not open the chat', e), 'error');
  }
  if (!input.disabled) input.focus();
}

function startHistoryRename(row, id) {
  const main = row.querySelector('.hist-main');
  const titleEl = row.querySelector('.hist-title');
  if (!main || !titleEl || row.querySelector('.hist-rename')) return;
  const box = el('input', 'hist-rename');
  box.type = 'text';
  box.value = titleEl.textContent;
  box.maxLength = 120;
  box.spellcheck = false;
  box.setAttribute('aria-label', 'Chat name');
  main.hidden = true;
  row.prepend(box);
  box.focus();
  box.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const v = box.value.replace(/\s+/g, ' ').trim();
    box.remove();
    main.hidden = false;
    main.focus();
    if (!commit || !v || v === titleEl.textContent) return;
    const old = titleEl.textContent;
    titleEl.textContent = v;
    try {
      await renameChat(id, v);
      const m = metaOf(id);
      if (m) m.title = v;
    } catch (e) {
      titleEl.textContent = old;
      historyMessage(failText('Could not rename the chat', e), 'error');
    }
  };
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  box.addEventListener('blur', () => finish(true));
}

function confirmDelete(b, id) {
  if (b.classList.contains('confirm')) {
    clearTimeout(b._timer);
    return deleteChat(id);
  }
  b.classList.add('confirm');
  b.textContent = 'Confirm delete';
  b._timer = setTimeout(() => {
    b.classList.remove('confirm');
    b.textContent = 'Delete';
  }, CONFIRM_MS);
}

async function deleteChat(id) {
  try {
    // The engine closes the chat (in every panel) and deletes it with its files.
    await cmd('delete', { id });
  } catch (e) {
    historyMessage(failText('Could not delete the chat', e), 'error');
    return loadHistory();
  }
  hist.metas = hist.metas.filter((m) => m.id !== id);
  const at = hist.rows.findIndex((m) => m.id === id);
  if (at >= 0) {
    hist.rows.splice(at, 1);
    if (at < hist.shown) hist.shown--;
  }
  rowOf(id)?.remove();
  if (!hist.rows.length) renderHistoryList();
  else updateHistoryMore();
  announce('Chat deleted.');
}

async function withBusy(b, label, fn) {
  const text = b.textContent;
  b.disabled = true;
  b.textContent = label;
  try {
    await fn();
  } catch (e) {
    historyMessage(errText(e), 'error');
  } finally {
    b.disabled = false;
    b.textContent = text;
  }
}

function slug(s) {
  return (
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'chat'
  );
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const exportName = (title, ext) => `agent-chat-${slug(title)}-${today()}.${ext}`;

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // A big export takes a while to write to disk.
  setTimeout(() => URL.revokeObjectURL(url), blob.size > 50e6 ? 600000 : 60000);
}

// A chat with files exports as a .zip (manifest + the files themselves), one without as .json.
async function exportJson(id) {
  await flushEngine({ id });
  let file;
  try {
    file = await store.exportSession(id);
  } catch (e) {
    throw new Error(failText('Could not export the chat', e));
  }
  downloadBlob(file.blob, exportName(file.title || metaOf(id)?.title, file.ext));
}

async function exportMarkdown(id) {
  await flushEngine({ id });
  let session;
  try {
    session = await store.get(id);
  } catch (e) {
    throw new Error(failText('Could not export the chat', e));
  }
  if (!session) throw new Error('This chat is no longer saved.');
  downloadBlob(new Blob([sessionToMarkdown(session)], { type: 'text/markdown' }), exportName(session.title, 'md'));
}

async function exportAll() {
  await flushEngine();
  try {
    const file = await store.exportAll();
    downloadBlob(file.blob, `agent-chats-all-${today()}.${file.ext}`);
  } catch (e) {
    historyMessage(failText('Could not export', e), 'error');
  }
}

function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// Imports are written to the store here (a big .zip is read in place, never sent to the engine); the engine
// is then asked to open the first imported chat.
async function importFiles(files) {
  if (!files.length) return;
  historyMessage(`Importing ${plural(files.length, 'file')}…`);
  const ids = [];
  const errors = [];
  for (const f of files) {
    try {
      let got;
      // A .zip is read in place (never loaded whole); a .json export is parsed here.
      if (await isZipFile(f)) got = await store.importFile(f);
      else {
        let obj;
        try {
          obj = JSON.parse(await readText(f));
        } catch {
          throw new Error('it is not a valid JSON file.');
        }
        got = await store.importFile(obj);
      }
      ids.push(...(Array.isArray(got) ? got : []));
    } catch (e) {
      errors.push(`${f.name}: ${errText(e)}`);
    }
  }
  const done = ids.length ? `Imported ${plural(ids.length, 'chat')}.` : '';
  if (errors.length) {
    historyMessage([done, `Could not import ${errors.join('\n')}`].filter(Boolean).join('\n'), 'error');
    if (ids.length) await loadHistory();
    return;
  }
  if (!ids.length) return historyMessage('No chats were found in that file.', 'error');
  closeHistory({ focus: 'none' });
  try {
    // Its title is shown at once (the store's list holds only the small metadata).
    const meta = (await store.list().catch(() => [])).find((m) => m.id === ids[0]) || { id: ids[0] };
    await openSession(ids[0], meta);
  } catch (e) {
    setStatus(failText('Could not open the imported chat', e), 'error');
    return;
  }
  flashStatus(done);
  if (!input.disabled) input.focus();
}

/* ---------- batch dialog ---------- */

const ITEM_RE = /\{\{\s*item\s*\}\}/i;

// One prompt per non-blank line; {{item}} in the instruction is replaced, otherwise the line is appended.
function expandBatch(items, template) {
  const lines = String(items || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const t = String(template || '').trim();
  if (!t) return lines;
  if (ITEM_RE.test(t)) return lines.map((l) => t.replace(new RegExp(ITEM_RE.source, 'gi'), () => l));
  return lines.map((l) => `${t}\n${l}`);
}

function openBatch() {
  const s = active;
  if (!s || !s.ready) return;
  closeCustomModel(false);
  batchTarget = s;
  for (const r of batchModeInputs) r.checked = r.value === queueMode();
  appEl.inert = true;
  batchEl.hidden = false;
  updateBatchPreview();
  batchItems.focus();
}

function closeBatch({ focus = true } = {}) {
  if (batchEl.contains(document.activeElement)) document.activeElement.blur();
  batchEl.hidden = true;
  appEl.inert = false;
  batchTarget = null;
  if (focus) batchBtn.focus();
}

function updateBatchPreview() {
  const jobs = expandBatch(batchItems.value, batchTemplate.value);
  const n = jobs.length;
  batchCount.textContent = n ? `${plural(n, 'job')} · first prompt:` : 'No jobs yet — add one item per line.';
  batchPreview.hidden = !n;
  batchPreview.textContent = n ? clip(jobs[0], 600) : '';
  batchAddBtn.textContent = n ? `Add ${plural(n, 'job')} to queue` : 'Add jobs to queue';
  batchAddBtn.disabled = !n;
}

function addBatch() {
  const s = batchTarget && !batchTarget.closed ? batchTarget : active;
  const jobs = expandBatch(batchItems.value, batchTemplate.value);
  if (!jobs.length || !s || !s.ready) return;
  const mode = batchModeInputs.find((r) => r.checked)?.value === 'step' ? 'step' : 'auto';
  if (mode !== queueMode()) {
    settings.queueMode = mode;
    saveAll();
  }
  batchItems.value = '';
  batchTemplate.value = '';
  closeBatch({ focus: false });
  if (s !== active) activate(s);
  // Shown at once (the first job starting when idle, like the engine does); the engine's state confirms it.
  const items = jobs.map((text) => ({ id: newId(), text, attachmentIds: [] }));
  const idle = !s.state.running && !modelProblem();
  if (idle) s.starting = true;
  localQueue(s, (q) => {
    q.push(...items);
    if (idle) q.shift();
  });
  s.state = { ...s.state, paused: false, drain: false };
  applyState(s, s.state);
  cmd('batch', { id: s.id, jobs: items, mode, page: pageInfo() }).then(
    () => {
      s.starting = false;
      announce(`${plural(jobs.length, 'job')} added to the queue.`);
    },
    (e) => {
      s.starting = false;
      setStatus(failText('Could not add the jobs', e), 'error');
    }
  );
  if (!input.disabled) input.focus();
}

/* ---------- wiring ---------- */

function onTabListClick(e) {
  const t = e.target.closest('.ctab');
  const s = t && sessions.get(t.dataset.sessionId);
  if (!s || e.target.closest('.ctab-edit')) return;
  if (e.target.closest('[data-action="close"]')) return requestClose(s);
  activate(s);
}

function onTabListKey(e) {
  const t = e.target.closest?.('.ctab');
  if (!t || e.target !== t) return;
  const list = [...sessions.values()];
  const s = sessions.get(t.dataset.sessionId);
  const i = list.indexOf(s);
  let next = null;
  switch (e.key) {
    case 'ArrowRight':
      next = list[(i + 1) % list.length];
      break;
    case 'ArrowLeft':
      next = list[(i - 1 + list.length) % list.length];
      break;
    case 'Home':
      next = list[0];
      break;
    case 'End':
      next = list.at(-1);
      break;
    case 'Delete':
      e.preventDefault();
      return requestClose(s);
    case 'F2':
      e.preventDefault();
      return startTabRename(s);
    case 'Enter':
    case ' ':
      e.preventDefault();
      return activate(s, { focus: 'input' });
    default:
      return;
  }
  e.preventDefault();
  activate(next, { focus: 'tab' });
}

function bindEvents() {
  providerSel.addEventListener('change', async () => {
    settings.activeProviderId = providerSel.value;
    closeCustomModel(false);
    setStatus('');
    renderProviderSelect();
    renderModels();
    await saveAll();
    const p = activeProvider();
    if (p && !p.models?.length) fetchModels(p);
  });

  modelSel.addEventListener('change', () => {
    const p = activeProvider();
    if (!p) return;
    if (modelSel.value === CUSTOM_MODEL) return openCustomModel();
    p.model = modelSel.value;
    modelSel.title = p.model;
    saveAll();
  });

  modelCustom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      closeCustomModel(true);
      modelSel.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCustomModel(false);
      modelSel.focus();
    }
  });
  modelCustom.addEventListener('blur', () => closeCustomModel(true));

  reloadBtn.addEventListener('click', () => fetchModels(activeProvider()));
  settingsBtn.addEventListener('click', openSettings);
  closeSettingsBtn.addEventListener('click', closeSettings);
  historyBtn.addEventListener('click', openHistory);
  statusEl.addEventListener('click', () => setStatus(''));

  // tab strip
  newTabBtn.addEventListener('click', () => newTab());
  tabList.addEventListener('click', onTabListClick);
  tabList.addEventListener('auxclick', (e) => {
    const t = e.button === 1 && e.target.closest('.ctab');
    const s = t && sessions.get(t.dataset.sessionId);
    if (s) {
      e.preventDefault();
      requestClose(s);
    }
  });
  tabList.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.ctab');
    const s = t && sessions.get(t.dataset.sessionId);
    if (s && !e.target.closest('[data-action="close"], .ctab-edit')) startTabRename(s);
  });
  tabList.addEventListener('keydown', onTabListKey);
  tabList.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || tabList.scrollWidth <= tabList.clientWidth) return;
      tabList.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false }
  );

  // overlays: Esc closes the topmost one
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!batchEl.hidden) {
      e.preventDefault();
      closeBatch();
    } else if (!historyEl.hidden) {
      e.preventDefault();
      closeHistory();
    } else if (!settingsEl.hidden) {
      e.preventDefault();
      closeSettings();
    } else if (active?.state?.running && !e.defaultPrevented) {
      // v1.0: Esc stops, wherever the focus is.
      e.preventDefault();
      stopSession(active);
    }
  });

  approvalSel.addEventListener('change', () => {
    settings.approval = approvalSel.value;
    saveAll();
  });

  // composer
  input.addEventListener('input', () => {
    autosize();
    updateComposer();
    syncDraft(active);
  });
  input.addEventListener('keydown', (e) => {
    // keyCode 229 = IME still composing (Safari-style); isComposing covers Chrome.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && active?.state?.running) {
      e.preventDefault();
      e.stopPropagation();
      stopSession(active);
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || !active) return;
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
    addFiles(active, files);
  });

  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', () => stopSession(active));
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    addFiles(active, files);
  });

  // queue bar
  queueToggle.addEventListener('click', () => {
    if (!active) return;
    active.queueOpen = !active.queueOpen;
    renderQueue();
  });
  queueRunNext.addEventListener('click', () => queueRun('runNext'));
  queueRunAll.addEventListener('click', () => queueRun('runAll'));
  queueResume.addEventListener('click', () => queueRun('resume'));
  queueClear.addEventListener('click', onQueueClear);
  queueModeSel.addEventListener('change', () => {
    settings.queueMode = queueModeSel.value === 'step' ? 'step' : 'auto';
    saveAll();
    renderQueue();
  });
  queueListEl.addEventListener('click', onQueueItemClick);

  // batch dialog
  batchBtn.addEventListener('click', openBatch);
  closeBatchBtn.addEventListener('click', () => closeBatch());
  batchCancelBtn.addEventListener('click', () => closeBatch());
  batchAddBtn.addEventListener('click', addBatch);
  batchItems.addEventListener('input', updateBatchPreview);
  batchTemplate.addEventListener('input', updateBatchPreview);
  batchItems.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      addBatch();
    }
  });

  // history overlay
  closeHistoryBtn.addEventListener('click', () => closeHistory());
  historySearch.addEventListener('input', renderHistoryList);
  historyThisSite.addEventListener('change', renderHistoryList);
  historyList.addEventListener('click', onHistoryClick);
  historyMore.addEventListener('click', () => {
    appendHistoryRows();
    // Keep keyboard focus in the list instead of on a button that may disappear.
    if (historyMore.hidden) historySearch.focus();
  });
  historyBody.addEventListener(
    'scroll',
    () => {
      if (hist.shown < hist.rows.length && historyBody.scrollHeight - historyBody.scrollTop - historyBody.clientHeight < 200) appendHistoryRows();
    },
    { passive: true }
  );
  historyNotice.addEventListener('click', () => historyMessage(''));
  historyImportBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    const files = [...importInput.files];
    importInput.value = '';
    importFiles(files);
  });
  historyExportAllBtn.addEventListener('click', () => withBusy(historyExportAllBtn, 'Exporting…', exportAll));

  // drag & drop: any file, into the active chat's draft
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const endDrag = () => {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  };
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --dragDepth <= 0) endDrag();
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    endDrag();
    if (!appEl.inert && active) addFiles(active, [...e.dataTransfer.files]);
  });

  // The engine keeps the chats; only the draft being typed lives here until it is sent over.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && active) syncDraft(active, true);
  });
  window.addEventListener('pagehide', () => active && syncDraft(active, true));

  tabIcon.addEventListener('error', () => (tabIcon.hidden = true));
  chrome.tabs.onActivated.addListener((info) => {
    if (windowId == null || info.windowId === windowId) updateTab();
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (!tab.active || (windowId != null && tab.windowId !== windowId)) return;
    if (info.title || info.favIconUrl || info.url || info.status === 'complete') updateTab();
  });
}

/* ---------- Firefox ---------- */

// Firefox shows this page in its sidebar (moz-extension://). The code below runs only there, never in Chrome.
const FIREFOX = location.protocol === 'moz-extension:';
const ALL_SITES = { origins: ['<all_urls>'] };
let siteBanner = null;

// Firefox lets people take an extension's access to websites away (about:addons → Permissions), and versions
// before 127 did not grant it at install. Without it the agent can neither work on pages nor reach model
// servers, so the panel asks for it. permissions.request must run in the click itself (nothing awaited first).
async function checkSiteAccess() {
  let granted = true;
  try {
    granted = await chrome.permissions.contains(ALL_SITES);
  } catch {}
  if (granted) {
    siteBanner?.remove();
    siteBanner = null;
    return;
  }
  if (siteBanner) return;
  const allow = () =>
    chrome.permissions.request(ALL_SITES).then(
      (ok) => {
        if (!ok) return setStatus('Firefox did not give access to websites.', 'error');
        checkSiteAccess();
        syncOriginRules(settings).catch(() => {});
        const p = activeProvider();
        if (p && !p.models?.length) fetchModels(p, { quiet: true });
      },
      (e) => setStatus(`Could not ask for access to websites: ${errText(e)}`, 'error')
    );
  siteBanner = el('div', 'pane-banners site-access');
  siteBanner.append(
    banner('error', 'Agent Automation needs access to all websites to read and act on pages and to reach your model. Firefox has not given it yet.', [
      { label: 'Allow access', id: 'allowSites', run: allow },
    ])
  );
  chatsEl.before(siteBanner);
}

// Trusted input events use Chrome's debugger API, which Firefox does not have: the switch is shown off and
// disabled (the engine ignores the setting there).
function firefoxSettings() {
  for (const label of settingsBody.querySelectorAll('.field.check label')) {
    if (label.textContent.trim() !== 'Trusted input events') continue;
    const box = label.querySelector('input[type="checkbox"]');
    if (box) {
      box.checked = false;
      box.disabled = true;
    }
    const hint = label.closest('.field')?.querySelector('.hint');
    if (hint) hint.textContent = 'Not available in Firefox: it needs Chrome’s debugger API.';
  }
}

function setupFirefox() {
  if (!FIREFOX) return;
  checkSiteAccess();
  chrome.permissions.onAdded?.addListener(() => checkSiteAccess());
  chrome.permissions.onRemoved?.addListener(() => checkSiteAccess());
}

async function init() {
  setupFirefox();
  settings = await loadSettings();
  await syncOriginRules(settings);
  approvalSel.value = settings.approval;
  renderProviderSelect();
  renderModels();
  bindEvents();
  autosize();
  updateComposer();
  try {
    windowId = (await chrome.windows.getCurrent()).id;
  } catch {}
  await updateTab();
  await connectEngine();
  if (!input.disabled) input.focus();

  const p = activeProvider();
  if (!p) setStatus('No model provider configured. Add one in Settings.', 'error');
  else if (!p.models?.length) fetchModels(p, { quiet: true });
}

init().catch((e) => {
  console.error(e);
  setStatus(`Failed to start: ${errText(e)}`, 'error');
});

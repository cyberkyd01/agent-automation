import { Agent } from './src/agent.js';
import { formatBytes } from './src/files.js';
import { md, stripToolCalls } from './src/markdown.js';
import { listModels, pickModel } from './src/providers.js';
import { newSession, sessionToMarkdown, store, titleFrom } from './src/sessions.js';
import { renderSettings } from './src/settings-ui.js';
import { loadSettings, saveSettings, syncOriginRules } from './src/storage.js';
import { newId, repoLink, safeParse, sleep, splitThink } from './src/util.js';

const CUSTOM_MODEL = '__custom__';
const TOOL_TEXT_LIMIT = 4000;
const SAVE_DELAY = 300;
const CONFIRM_MS = 5000;
const STORE_TIMEOUT = 10000; // a storage call slower than this is reported, never waited on forever
const HISTORY_PAGE = 60;
const DEFAULT_TITLE = 'New chat';
const LOCK_PREFIX = 'agent-automation-session:';
const PLACEHOLDER = 'Ask anything, or give me a task…';
const MODE_LABEL = { auto: 'Run all', step: 'One at a time' };
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
let lastApproval = null;
let windowId = null;
let statusSeq = 0;
let currentTab = null; // the active browser tab, for session meta and the "This site" filter
let active = null; // the chat session shown in the panel
let panelTimer = 0;
let queueClearArmed = null;
let batchTarget = null;
const sessions = new Map(); // id → session, in tab order
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
        if (s !== active || s.readOnly) return;
        input.value = text;
        autosize();
        updateComposer();
        input.focus();
      })
    );
  }
  wrap.append(list);
  const rate = repoLink('empty-link', '★ Rate on GitHub');
  if (rate) wrap.append(rate);
  s.chat.replaceChildren(wrap);
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

// One attachment: a thumbnail for images we have bytes for, otherwise a type badge + name + size.
function attachmentChip(a, { onRemove, s } = {}) {
  const isImage = (a.kind === 'image' || /^image\//.test(a.mime || '')) && typeof a.dataUrl === 'string';
  if (isImage) {
    const t = thumb(a.dataUrl, { onRemove, label: a.name, s });
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

const textOf = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '';

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

  // Renders synchronously: requestAnimationFrame doesn't fire while the panel is hidden.
  const end = (msg) => {
    if (finished) return;
    finished = true;
    s.live.delete(view);
    if (raf) cancelAnimationFrame(raf);
    if (msg) latest = { content: textOf(msg.content), reasoning: msg._reasoning || latest.reasoning };
    const any = render();
    dots.remove();
    think.classList.remove('live');
    if (!any) wrap.remove();
    else addCopyButtons(body);
  };

  const view = {
    update({ content, reasoning } = {}) {
      if (finished) return;
      latest = { content: content || '', reasoning: reasoning || '' };
      markUnread(s);
      if (!raf) raf = requestAnimationFrame(render);
    },
    done: (msg) => end(msg),
    settle: () => end(),
  };
  s.live.add(view);
  return view;
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

function toolCard(s, name, args) {
  const parsed = typeof args === 'string' ? safeParse(args, null) ?? args : args;
  const wrap = el('div', 'tool running');
  const det = el('details');
  const sum = el('summary');
  const icon = el('span', 'tool-icon');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', 'Running');
  sum.append(icon, el('span', 'tool-name', name || 'tool'));
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

  const card = {
    ask(signal, info = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        det.open = true;
        wrap.classList.add('asking');
        const sensitive = Boolean(info?.sensitive);
        const bar = el('div', 'ask');
        askBar = bar;
        s.asking++;
        markUnread(s);
        renderTab(s);
        const close = () => {
          if (!askBar) return;
          bar.remove();
          askBar = null;
          wrap.classList.remove('asking');
          signal?.removeEventListener('abort', onAbort);
          s.asking = Math.max(0, s.asking - 1);
          renderTab(s);
        };
        const onAbort = () => {
          close();
          reject(signal.reason);
        };
        const choice = (label, value, cls) =>
          button(`btn ${cls}`.trim(), label, () => {
            close();
            resolve(value);
          });
        bar.append(el('span', 'ask-q', 'Allow this action?'));
        if (sensitive) bar.append(el('span', 'ask-warn', 'Caution: this tool acts on your computer, outside the browser.'));
        bar.append(
          choice('Allow', 'allow', 'primary'),
          choice(sensitive ? 'Always allow this tool (this chat)' : 'Allow all (this chat)', 'always', ''),
          choice('Deny', 'deny', 'danger')
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        wrap.append(bar);
        card.closeAsk = close;
        // Approval needs attention even if the user scrolled up.
        if (s === active) bar.scrollIntoView({ block: 'nearest' });
        follow(s);
      });
    },
    finish(text, isError, images) {
      if (finished) return;
      finished = true;
      s.live.delete(card);
      card.closeAsk?.();
      setState(isError ? 'error' : 'ok', isError ? 'Failed' : 'Done', isError ? '✕' : '✓');
      const out = text == null ? '' : typeof text === 'string' ? text : pretty(text);
      body.append(el('div', 'tool-label', isError ? 'Error' : 'Result'), el('pre', `tool-pre${isError ? ' err' : ''}`, capText(out || '(no output)')));
      if (isError && out) sum.title = clip(out.replace(/\s+/g, ' '), 200);
      if (images?.length) body.append(thumbs(images, s));
      markUnread(s);
      follow(s);
    },
    settle() {
      if (finished) return;
      finished = true;
      s.live.delete(card);
      card.closeAsk?.();
      setState('stopped', 'Stopped', '–');
    },
  };
  s.live.add(card);
  return card;
}

// actions: [{ label, run, id? }] — rendered as small buttons; they are removed when the next job starts.
function notice(s, text, kind = 'info', actions = []) {
  const n = el('div', `notice ${kind === 'error' ? 'error' : 'info'}`);
  n.append(el('span', 'notice-text', String(text ?? '')));
  if (kind === 'error') n.setAttribute('role', 'alert');
  if (actions.length) {
    const box = el('span', 'notice-actions');
    for (const a of actions) {
      const b = button('btn', a.label, () => {
        box.remove();
        s.noticeActions.delete(box);
        a.run();
      });
      if (a.id) b.dataset.action = a.id;
      box.append(b);
    }
    n.append(box);
    s.noticeActions.add(box);
  }
  return add(s, n);
}

function clearNoticeActions(s) {
  for (const box of s.noticeActions) box.remove();
  s.noticeActions.clear();
}

function fileName(id, src) {
  const ext = (/^data:image\/([a-z0-9.+-]+)/i.exec(src)?.[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  return `${String(id || 'image').replace(/[^\w.-]+/g, '_')}.${ext}`;
}

function assetCard(s, a) {
  if (!a?.dataUrl) return;
  const { id, dataUrl, label } = a;
  const isImage = a.kind ? a.kind === 'image' : /^data:image\//i.test(dataUrl);
  const card = el('div', isImage ? 'asset' : 'asset file');
  card.dataset.assetId = id || '';
  if (isImage) {
    const open = button('asset-img');
    open.title = 'Open in a new tab';
    const img = el('img');
    img.alt = a.name || label || id || 'Generated image';
    img.src = dataUrl;
    img.addEventListener('load', () => follow(s));
    open.append(img);
    open.addEventListener('click', () => openImage(dataUrl));
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
  dl.href = dataUrl;
  dl.download = a.name || fileName(id, dataUrl);
  const attach = button('btn', 'Attach', () => attachExisting(s, id));
  attach.title = 'Add to the message you are writing';
  attach.dataset.action = 'attach-asset';
  const foot = el('div', 'asset-foot');
  foot.append(meta, dl, attach);
  card.append(foot);
  add(s, card);
}

function settleLive(s) {
  for (const v of [...s.live]) v.settle();
  s.live.clear();
}

/* ---------- transcript restore ---------- */

function userText(m) {
  if (typeof m._text === 'string') return m._text;
  let raw = textOf(m.content);
  const i = raw.lastIndexOf('<context>');
  if (i >= 0 && /<\/context>\s*$/.test(raw)) raw = raw.slice(0, i);
  return raw.trim();
}

function attachmentInfo(s, ref) {
  const a = s.agent.assets.get(String(ref.id ?? ref).toLowerCase());
  if (typeof ref === 'string') return a ? { ...a } : { id: ref, kind: 'file', name: ref };
  return { ...ref, dataUrl: a?.dataUrl, name: ref.name || a?.name };
}

function userAttachments(s, m) {
  if (Array.isArray(m._attachments)) return m._attachments.filter((x) => x && x.id).map((x) => attachmentInfo(s, x));
  // v1.0 history kept image data inline.
  const legacy = Array.isArray(m._images)
    ? m._images
    : Array.isArray(m.content)
      ? m.content.filter((p) => p?.type === 'image_url').map((p) => p.image_url?.url)
      : [];
  return legacy.filter(Boolean).map((dataUrl, i) => ({ id: `image ${i + 1}`, kind: 'image', dataUrl }));
}

function restoreAssets(s, m) {
  for (const id of Array.isArray(m._assets) ? m._assets : []) assetCard(s, s.agent.assets.get(String(id).toLowerCase()));
}

// History doesn't record failure explicitly; these are the agent's error/denial/cancel replies.
const toolFailed = (m) => /^(error\b|cancelled\.|the user denied)/i.test(String(m.content ?? ''));

function renderTranscript(s) {
  s.restoring = true;
  s.chat.replaceChildren();
  const cards = new Map();
  try {
    for (const m of s.agent.messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'user') {
        const text = userText(m);
        const atts = userAttachments(s, m);
        if (text || atts.length) userBubble(s, text, atts);
      } else if (m.role === 'assistant') {
        assistantView(s).done(m);
        // Images the model itself returned come right after its reply, before any tool calls.
        restoreAssets(s, m);
        for (const tc of m.tool_calls || []) cards.set(tc.id, toolCard(s, tc.function?.name, tc.function?.arguments));
      } else if (m.role === 'tool') {
        cards.get(m.tool_call_id)?.finish(m.content, toolFailed(m), m._images);
        cards.delete(m.tool_call_id);
        restoreAssets(s, m);
      }
    }
    settleLive(s);
  } finally {
    s.restoring = false;
  }
  if (!s.chat.children.length) showEmpty(s);
}

/* ---------- sessions ---------- */

function pickMeta(m = {}) {
  const now = Date.now();
  return {
    id: String(m.id),
    title: typeof m.title === 'string' && m.title.trim() ? m.title : DEFAULT_TITLE,
    createdAt: Number(m.createdAt) || now,
    updatedAt: Number(m.updatedAt) || Number(m.createdAt) || now,
    url: typeof m.url === 'string' ? m.url : '',
    pageTitle: typeof m.pageTitle === 'string' ? m.pageTitle : '',
  };
}

const cleanQueue = (q) =>
  (Array.isArray(q) ? q : [])
    .filter((x) => x && typeof x.text === 'string')
    .map((x) => ({ id: String(x.id || newId()), text: x.text, attachmentIds: Array.isArray(x.attachmentIds) ? x.attachmentIds.map(String) : [] }));

const queueMode = () => (settings?.queueMode === 'step' ? 'step' : 'auto');

function createSession(meta, { stored = false, ready = false } = {}) {
  const s = {
    id: String(meta.id),
    meta: pickMeta(meta),
    stored, // exists in the store
    ready, // history loaded (or a fresh chat)
    loading: null,
    renamed: false,
    restoring: false,
    muted: false, // ignore agent hooks (while importing or after closing)
    draft: '',
    pending: [], // asset ids attached to the draft
    loadingNames: [],
    attaching: 0,
    queue: [],
    queueOpen: false,
    paused: false,
    drain: false, // "Run all remaining" in step mode
    running: false,
    stopRequested: false,
    runPromise: Promise.resolve(),
    asking: 0,
    live: new Set(),
    noticeActions: new Set(),
    pinned: true,
    unread: false,
    dirty: false,
    saveTimer: 0,
    saving: Promise.resolve(),
    saveError: null,
    saveBanner: null,
    roBanner: null,
    loadBanner: null,
    assetBacklog: new Map(), // assets not yet written to the store
    readOnly: false,
    lock: null,
    lockWait: null,
    closed: false,
    closing: false,
    closeArmed: false,
    closeBlocked: false,
    closeTimer: 0,
  };
  s.agent = new Agent(
    {
      assistantStart: () => assistantView(s),
      toolStart: (name, args) => toolCard(s, name, args),
      notice: (text, kind) => notice(s, text, kind),
      asset: (a) => assetCard(s, a),
    },
    {
      onChange: () => !s.muted && scheduleSave(s),
      onAsset: (a) => !s.muted && queueAsset(s, a),
    }
  );
  buildTab(s);
  buildPane(s);
  sessions.set(s.id, s);
  return s;
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
  s.tabTitle.textContent = title;
  s.tab.title = [title, s.meta.pageTitle || hostOf(s.meta.url)].filter(Boolean).join('\n');
  const states = [];
  const flag = (cls, on, label) => {
    s.tab.classList.toggle(cls, Boolean(on));
    if (on) states.push(label);
  };
  flag('running', s.running, 'running');
  flag('asking', s.asking > 0, 'waiting for your approval');
  flag('unread', s.unread, 'new output');
  flag('save-failed', s.saveError, 'not saved');
  flag('readonly', s.readOnly, 'read-only');
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

function activate(s, { focus = 'input' } = {}) {
  if (!s || s.closed) return;
  const prev = active;
  if (prev && prev !== s && !prev.closed) prev.draft = input.value;
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
  s.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (prev !== s) {
    input.value = s.draft;
    autosize();
  }
  renderChips();
  renderQueue();
  updateComposer();
  follow(s);
  persistPanel();
  if (!s.ready) hydrate(s);
  if (focus === 'input' && !input.disabled) input.focus();
  else if (focus === 'tab') s.tab.focus();
}

function newTab({ activateIt = true } = {}) {
  const s = createSession(newSession(), { stored: false, ready: true });
  showEmpty(s);
  acquireLock(s.id).then((lock) => {
    if (s.closed) lock.release();
    else s.lock = lock;
  });
  if (activateIt) activate(s);
  return s;
}

// A brand-new chat nobody has touched: replacing it loses nothing.
const isPristine = (s) =>
  !s.stored && s.ready && !s.running && !s.agent.messages.length && !s.queue.length && !s.pending.length && !s.attaching && !(s.draft || '').trim();

async function openSession(id, meta = { id }) {
  const existing = sessions.get(id);
  if (existing) {
    activate(existing);
    return existing;
  }
  const prev = active;
  const s = createSession({ ...meta, id }, { stored: true, ready: false });
  activate(s);
  if (prev && prev !== s && isPristine(prev)) closeSession(prev, { save: false });
  await s.loading;
  return s;
}

function persistPanel() {
  clearTimeout(panelTimer);
  panelTimer = setTimeout(writePanel, 50);
}

function writePanel() {
  clearTimeout(panelTimer);
  panelTimer = 0;
  const state = { open: [...sessions.keys()], active: active?.id || '' };
  try {
    chrome.storage.local.set({ panel: state }).catch?.((e) => console.warn('Could not save open tabs', e));
  } catch (e) {
    console.warn('Could not save open tabs', e);
  }
}

/* ---------- loading & locking ---------- */

const lockName = (id) => LOCK_PREFIX + id;

// Resolves { ok, release }. ok is false when another panel (another window) has this chat open.
function acquireLock(id) {
  const free = { ok: true, release() {} };
  if (!navigator.locks?.request) return Promise.resolve(free);
  return new Promise((resolve) => {
    navigator.locks
      .request(lockName(id), { ifAvailable: true }, (lock) => {
        if (!lock) return resolve({ ok: false, release() {} });
        return new Promise((release) => resolve({ ok: true, release }));
      })
      .catch((e) => {
        console.warn('Web lock unavailable', e);
        resolve(free);
      });
  });
}

async function heldLocks() {
  try {
    const { held = [] } = (await navigator.locks?.query?.()) || {};
    return new Set(held.map((l) => l.name));
  } catch {
    return new Set();
  }
}

async function heldElsewhere(id) {
  const s = sessions.get(id);
  if (s?.lock?.ok) return false; // we hold it
  if (s?.readOnly) return true;
  return (await heldLocks()).has(lockName(id)); // includes tabs here that haven't loaded yet (they hold nothing)
}

function hydrate(s) {
  if (s.loading) return s.loading;
  s.loading = (async () => {
    setLoadBanner(s, null);
    s.chat.replaceChildren(el('div', 'pane-loading', 'Loading chat…'));
    const lock = await acquireLock(s.id);
    let data;
    let assets = [];
    let assetError = null;
    try {
      [data, assets] = await Promise.all([
        withTimeout(store.get(s.id), STORE_TIMEOUT),
        withTimeout(store.getAssets(s.id), STORE_TIMEOUT).catch((e) => {
          assetError = e;
          return [];
        }),
      ]);
    } catch (e) {
      lock.release();
      s.loading = null;
      if (s.closed) return;
      s.chat.replaceChildren();
      setLoadBanner(s, failText('Could not open this chat', e), true);
      return;
    }
    if (s.closed) return lock.release();
    if (!data) {
      lock.release();
      s.loading = null;
      s.stored = false;
      s.chat.replaceChildren();
      setLoadBanner(s, 'This chat is no longer saved — it may have been deleted in another window.', false);
      return;
    }
    applyLoaded(s, data, assets, lock);
    if (assetError) notice(s, `Some files of this chat could not be loaded: ${errText(assetError)}`, 'error');
  })();
  return s.loading;
}

function applyLoaded(s, data, assets, lock) {
  s.meta = pickMeta({ ...data, id: s.id });
  s.renamed = s.meta.title !== DEFAULT_TITLE;
  s.muted = true;
  try {
    s.agent.importMessages(Array.isArray(data.messages) ? data.messages : [], Array.isArray(assets) ? assets : []);
  } catch (e) {
    console.warn('Could not restore chat', e);
  } finally {
    s.muted = false;
  }
  s.queue = cleanQueue(data.queue);
  s.paused = s.queue.length > 0; // a restored queue never starts by itself
  s.drain = false;
  s.stored = true;
  s.ready = true;
  s.lock = lock.ok ? lock : null;
  setReadOnly(s, !lock.ok);
  renderTranscript(s);
  if (!s.readOnly && s.agent.canResume) {
    notice(s, 'This chat was interrupted.', 'info', [{ label: 'Continue', id: 'continue', run: () => resumeRun(s) }]);
  }
  renderTab(s);
  if (s === active) {
    renderChips();
    renderQueue();
    updateComposer();
  }
  follow(s, true);
}

function setReadOnly(s, on) {
  s.readOnly = on;
  if (!on) {
    s.roBanner?.remove();
    s.roBanner = null;
    s.lockWait?.abort();
    s.lockWait = null;
  } else {
    if (!s.roBanner) {
      s.roBanner = banner(
        'info',
        'This chat is open in another window, so it is read-only here. It becomes editable when that window closes it.',
        [{ label: 'Open a copy', id: 'open-copy', run: () => openCopy(s) }]
      );
      s.banners.append(s.roBanner);
    }
    waitForLock(s);
  }
  renderTab(s);
  if (s === active) updateComposer();
}

// When the other window lets go, reload the latest saved copy and continue here.
function waitForLock(s) {
  if (!navigator.locks?.request || s.lockWait) return;
  const ctrl = new AbortController();
  s.lockWait = ctrl;
  navigator.locks
    .request(lockName(s.id), { signal: ctrl.signal }, (lock) => {
      if (!lock) return;
      return new Promise((release) => {
        s.lockWait = null;
        if (s.closed || !s.readOnly) return release();
        takeOver(s, { ok: true, release });
      });
    })
    .catch(() => {});
}

async function takeOver(s, lock) {
  let data;
  let assets = [];
  try {
    [data, assets] = await Promise.all([
      withTimeout(store.get(s.id), STORE_TIMEOUT),
      withTimeout(store.getAssets(s.id), STORE_TIMEOUT).catch(() => []),
    ]);
  } catch (e) {
    data = null;
    console.warn('Could not reload chat', e);
  }
  if (s.closed || !data) {
    lock.release();
    if (!s.closed) setLoadBanner(s, 'This chat could not be reloaded after the other window closed it.', true);
    return;
  }
  applyLoaded(s, data, assets, lock);
  notice(s, 'The other window closed this chat, so you can continue it here.', 'info');
}

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

function setLoadBanner(s, text, canRetry) {
  s.loadBanner?.remove();
  s.loadBanner = null;
  if (!text) return;
  const actions = [];
  if (canRetry) actions.push({ label: 'Retry', id: 'retry-load', run: () => hydrate(s) });
  actions.push({ label: 'Close tab', id: 'close-tab', run: () => closeSession(s, { save: false }) });
  s.loadBanner = banner('error', text, actions);
  s.banners.append(s.loadBanner);
}

async function openCopy(s) {
  try {
    const file = await store.exportSession(s.id);
    const [id] = await store.importFile(file);
    if (!id) throw new Error('Nothing was copied.');
    const title = clip(`${s.meta.title} (copy)`, 80);
    await store.rename(id, title).catch(() => {});
    await openSession(id, { id, title });
  } catch (e) {
    notice(s, failText('Could not copy this chat', e), 'error');
  }
}

/* ---------- saving ---------- */

function scheduleSave(s) {
  if (s.closed || s.readOnly || !s.ready) return;
  s.dirty = true;
  clearTimeout(s.saveTimer);
  // The first save is immediate so a brand-new chat can't be lost to the debounce.
  s.saveTimer = setTimeout(() => saveNow(s), s.stored ? SAVE_DELAY : 0);
}

// Serialised per session; never rejects (failures show in the chat).
function saveNow(s) {
  clearTimeout(s.saveTimer);
  s.saveTimer = 0;
  s.saving = s.saving.then(() => persist(s));
  return s.saving;
}

async function persist(s) {
  if (s.closed || s.readOnly || !s.ready) return;
  try {
    if (s.dirty) {
      const messages = s.agent.exportMessages();
      // An untouched "New chat" stays out of History.
      if (!s.stored && !messages.length && !s.queue.length) {
        s.dirty = false;
        return;
      }
      s.dirty = false;
      const session = { ...s.meta, messages, queue: s.queue.map((q) => ({ id: q.id, text: q.text, attachmentIds: [...q.attachmentIds] })) };
      try {
        await withTimeout(store.put(session), STORE_TIMEOUT);
      } catch (e) {
        s.dirty = true;
        throw e;
      }
      s.stored = true;
    }
    if (s.stored) {
      for (const [id, a] of [...s.assetBacklog]) {
        if (s.closed) return;
        await withTimeout(store.putAsset(s.id, a), STORE_TIMEOUT);
        if (s.assetBacklog.get(id) === a) s.assetBacklog.delete(id);
      }
    }
    setSaveError(s, null);
  } catch (e) {
    console.warn('Could not save chat', e);
    setSaveError(s, e);
  }
}

function queueAsset(s, a) {
  if (!a?.id || s.closed || s.readOnly) return;
  s.assetBacklog.set(a.id, a);
  if (s.stored) saveNow(s);
}

function flushAll(timeout = 2000) {
  const all = [...sessions.values()].map((s) => (s.dirty || s.saveTimer || s.assetBacklog.size ? saveNow(s) : s.saving));
  return Promise.race([Promise.all(all), sleep(timeout)]);
}

function setSaveError(s, e) {
  const msg = e ? errText(e) : null;
  if (!msg) {
    if (!s.saveError) return;
    s.saveError = null;
    s.closeBlocked = false;
    s.saveBanner?.remove();
    s.saveBanner = null;
    renderTab(s);
    return;
  }
  s.saveError = msg;
  renderSaveBanner(s);
  renderTab(s);
}

function renderSaveBanner(s) {
  const actions = [
    {
      label: 'Retry',
      id: 'retry-save',
      run: () => {
        s.dirty = true;
        saveNow(s);
      },
    },
  ];
  if (s.closeBlocked) actions.push({ label: 'Close without saving', id: 'close-unsaved', run: () => closeSession(s, { save: false }) });
  const b = banner('error', failText('Could not save this chat', s.saveError), actions);
  b.dataset.kind = 'save-error';
  if (s.saveBanner) s.saveBanner.replaceWith(b);
  else s.banners.prepend(b);
  s.saveBanner = b;
}

/* ---------- running jobs & the queue ---------- */

function modelProblem() {
  const p = activeProvider();
  if (!p) return 'Add a model provider in Settings first.';
  if (!p.model) return 'Choose a model first: reload the list or pick “Custom model ID…”.';
  return '';
}

function setRunning(s, on) {
  s.running = on;
  if (!on) disarmClose(s);
  renderTab(s);
  if (s === active) {
    updateComposer();
    renderQueue();
  }
}

function startJob(s, job) {
  s.runPromise = runJob(s, job);
  return s.runPromise;
}

// job: { kind: 'direct' | 'queued' | 'resume', text, attachmentIds, item }
async function runJob(s, job) {
  if (s.running || s.closed || s.readOnly || !s.ready) return;
  const { agent } = s;
  const ids = job.attachmentIds || [];
  clearNoticeActions(s);
  s.stopRequested = false;
  const before = agent.messages.length;
  let bubble = null;
  if (job.kind !== 'resume') {
    if (!before) {
      if (!s.renamed) {
        const names = ids.map((id) => agent.assets.get(id)?.name).filter(Boolean);
        s.meta.title = titleFrom(job.text || names.join(', ')) || DEFAULT_TITLE;
      }
      if (!s.meta.url) {
        s.meta.url = currentTab?.url || '';
        s.meta.pageTitle = currentTab?.title || '';
      }
    }
    bubble = userBubble(s, job.text, ids.map((id) => attachmentInfo(s, id)));
    follow(s, true);
  }
  setRunning(s, true);
  let error = null;
  try {
    if (job.kind === 'resume') await agent.resume(settings);
    else await agent.run(job.text, ids, settings, job.kind === 'queued' ? { keepTab: true } : {});
  } catch (e) {
    error = e || new Error('Unknown error');
  }
  settleLive(s);
  // Failproof: a prompt that never reached the history goes back where it came from.
  if (error && job.kind !== 'resume' && !agent.messages.slice(before).some((m) => m?.role === 'user')) {
    bubble?.remove();
    if (job.kind === 'queued') s.queue.unshift(job.item);
    else returnToComposer(s, job.text, ids);
  }
  setRunning(s, false);
  scheduleSave(s);
  if (s.closed) return;
  const stopped = s.stopRequested || error?.name === 'AbortError';
  if (error) {
    const canResume = Boolean(agent.canResume);
    if (error.name === 'AbortError') {
      notice(s, 'Stopped.', 'info', canResume ? [{ label: 'Continue', id: 'continue', run: () => resumeRun(s) }] : []);
    } else {
      notice(s, errText(error), 'error', canResume ? [{ label: 'Retry', id: 'retry', run: () => resumeRun(s) }] : []);
    }
  }
  if (error || stopped) {
    if (s.queue.length) s.paused = true;
    s.drain = false;
  } else if (job.kind !== 'direct') {
    // A queued job or a successful retry carries the queue on.
    s.paused = false;
  }
  if (!s.queue.length) {
    s.paused = false;
    s.drain = false;
  }
  if (s === active) renderQueue();
  if (!error && !stopped) continueQueue(s);
}

function continueQueue(s) {
  if (s.running || s.closed || s.readOnly || s.paused || !s.queue.length) return;
  if (queueMode() === 'auto' || s.drain) runNext(s);
}

function runNext(s) {
  if (s.running || s.closed || s.readOnly || !s.ready || !s.queue.length) return;
  const problem = modelProblem();
  if (problem) {
    s.paused = true;
    setStatus(problem, 'error');
    if (s === active) renderQueue();
    return;
  }
  const item = s.queue.shift();
  startJob(s, { kind: 'queued', item, text: item.text, attachmentIds: item.attachmentIds });
  if (s === active) renderQueue();
}

function resumeRun(s) {
  if (s.running || s.readOnly || s.closed || !s.ready) return;
  const problem = modelProblem();
  if (problem) return setStatus(problem, 'error');
  if (!s.agent.canResume) {
    notice(s, 'There is nothing to continue.', 'info');
    return;
  }
  startJob(s, { kind: 'resume' });
}

function stopSession(s) {
  if (!s?.running) return;
  s.stopRequested = true;
  s.agent.stop();
}

function submit() {
  const s = active;
  if (!s || s.readOnly || !s.ready || s.attaching) return;
  const text = input.value.trim();
  if (!text && !s.pending.length) return;
  if (s.running) {
    s.queue.push({ id: newId(), text, attachmentIds: s.pending.splice(0) });
    clearComposer(s);
    renderQueue();
    scheduleSave(s);
    announce(`Added to the queue. ${plural(s.queue.length, 'prompt')} waiting.`);
    return;
  }
  const problem = modelProblem();
  if (problem) return setStatus(problem, 'error');
  const ids = s.pending.splice(0);
  clearComposer(s);
  startJob(s, { kind: 'direct', text, attachmentIds: ids });
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
  for (const id of ids) if (!s.pending.includes(id)) s.pending.push(id);
  if (s === active) {
    input.value = merged;
    autosize();
    renderChips();
  } else s.draft = merged;
}

function renderQueue() {
  const s = active;
  const n = s?.ready ? s.queue.length : 0;
  queueBar.hidden = !n;
  if (!n) {
    queueBar.dataset.state = 'empty';
    queueListEl.replaceChildren();
    return;
  }
  const mode = queueMode();
  const paused = s.paused && !s.running;
  const waiting = !s.running && !s.paused;
  queueBar.classList.toggle('paused', paused);
  queueBar.dataset.state = s.running ? 'running' : paused ? 'paused' : 'waiting';
  queueSummary.textContent = paused ? `Paused — ${n} queued` : s.running ? `${n} queued · ${MODE_LABEL[mode]}` : `${n} queued`;
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
  const last = s.queue.length - 1;
  queueListEl.replaceChildren(
    ...s.queue.map((q, i) => {
      const li = el('li', 'queue-item');
      li.dataset.queueId = q.id;
      const text = el('span', 'q-text', q.text.replace(/\s+/g, ' ').trim() || '(attachments only)');
      text.title = q.text;
      li.append(el('span', 'q-num', String(i + 1)), text);
      const k = q.attachmentIds.length;
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

function onQueueItemClick(e) {
  const b = e.target.closest('button[data-action]');
  const s = active;
  if (!b || !s) return;
  const id = b.closest('.queue-item')?.dataset.queueId;
  const i = s.queue.findIndex((q) => q.id === id);
  if (i < 0) return;
  const action = b.dataset.action;
  const q = s.queue;
  if (action === 'up' && i > 0) [q[i - 1], q[i]] = [q[i], q[i - 1]];
  else if (action === 'down' && i < q.length - 1) [q[i + 1], q[i]] = [q[i], q[i + 1]];
  else if (action === 'remove') {
    const [item] = q.splice(i, 1);
    for (const aid of item.attachmentIds) discardIfUnused(s, aid);
  } else if (action === 'edit') {
    const [item] = q.splice(i, 1);
    returnToComposer(s, item.text, item.attachmentIds);
    input.focus();
  }
  if (!q.length) {
    s.paused = false;
    s.drain = false;
  }
  scheduleSave(s);
  renderQueue();
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
    queueClear.textContent = `Clear ${s.queue.length}?`;
    queueClear.classList.add('confirm');
    setTimeout(() => queueClearArmed === s && disarmQueueClear(), CONFIRM_MS);
    return;
  }
  disarmQueueClear();
  const items = s.queue.splice(0);
  for (const item of items) for (const aid of item.attachmentIds) discardIfUnused(s, aid);
  s.paused = false;
  s.drain = false;
  scheduleSave(s);
  renderQueue();
  announce('Queue cleared.');
  input.focus();
}

/* ---------- closing tabs ---------- */

function requestClose(s) {
  if (s.running && !s.closeArmed) return armClose(s);
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
  if (s.closed || s.closing) return false;
  const hadFocus = tabList.contains(document.activeElement);
  s.closing = true;
  try {
    disarmClose(s);
    if (s.running) {
      stopSession(s);
      await Promise.race([s.runPromise, sleep(2000)]);
    }
    if (save && s.ready && !s.readOnly) {
      if (s === active) s.draft = input.value;
      // persist() times out its own storage calls, so this can't hang the close.
      await saveNow(s);
      if (s.dirty && !s.saveError) await saveNow(s); // a change that landed during the first write
      if (s.saveError) {
        // Never drop a chat that isn't safely stored.
        s.closeBlocked = true;
        renderSaveBanner(s);
        activate(s);
        announce('This chat could not be saved, so it was kept open.');
        return false;
      }
    }
  } finally {
    s.closing = false;
  }
  s.closed = true;
  s.muted = true;
  clearTimeout(s.saveTimer);
  clearTimeout(s.closeTimer);
  s.lockWait?.abort();
  s.lock?.release();
  try {
    s.agent.stop();
    s.agent.reset(); // releases MCP connections
  } catch {}
  const ids = [...sessions.keys()];
  const i = ids.indexOf(s.id);
  sessions.delete(s.id);
  resizer.unobserve(s.chat);
  s.tab.remove();
  s.pane.remove();
  if (batchTarget === s) batchTarget = null;
  if (active === s) {
    active = null;
    const next = sessions.get(ids[i + 1]) || sessions.get(ids[i - 1]);
    if (next) activate(next, { focus: hadFocus ? 'tab' : 'input' });
  }
  if (!sessions.size) newTab();
  persistPanel();
  return true;
}

/* ---------- renaming ---------- */

async function renameChat(id, title) {
  const s = sessions.get(id);
  if (s) {
    s.meta.title = title;
    s.renamed = true;
    renderTab(s);
    // Not stored yet: the first save carries the title.
    if (!s.stored) return;
  }
  await store.rename(id, title);
}

function startTabRename(s) {
  if (s.tab.querySelector('.ctab-edit')) return;
  // The other window would overwrite the name on its next save.
  if (s.readOnly) return announce('This chat is open in another window. Rename it there.');
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
    if (s === active) s.tab.focus();
    if (!commit || !v || v === s.meta.title) return;
    try {
      await renameChat(s.id, v);
    } catch (e) {
      notice(s, failText('Could not rename this chat', e), 'error');
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

function renderChips() {
  const s = active;
  if (!s) return;
  const chips = s.pending.map((id) => attachmentChip(attachmentInfo(s, id), { onRemove: () => removePending(s, id) }));
  for (const name of s.loadingNames) chips.push(loadingChip(name));
  attachRow.replaceChildren(...chips);
  attachRow.hidden = !chips.length;
  updateComposer();
}

async function addFiles(s, files) {
  if (!s || s.readOnly || !files.length) return;
  const names = files.map((f) => f.name || 'file');
  s.attaching += files.length;
  s.loadingNames.push(...names);
  if (s === active) renderChips();
  for (const [i, f] of files.entries()) {
    const name = names[i];
    try {
      const asset = await s.agent.attach(f);
      if (!s.closed && asset?.id && !s.pending.includes(asset.id)) s.pending.push(asset.id);
    } catch (e) {
      const msg = errText(e);
      notice(s, msg.includes(name) ? msg : `Could not attach ${name}: ${msg}`, 'error');
    } finally {
      s.attaching--;
      s.loadingNames.splice(s.loadingNames.indexOf(name), 1);
      if (s === active) renderChips();
    }
  }
}

function attachExisting(s, id) {
  if (!id || s.readOnly || !s.agent.assets.has(id)) return;
  if (!s.pending.includes(id)) s.pending.push(id);
  if (s === active) {
    renderChips();
    input.focus();
  }
}

function removePending(s, id) {
  s.pending = s.pending.filter((x) => x !== id);
  discardIfUnused(s, id);
  renderChips();
  input.focus();
}

// Drop a user upload that was never sent (still only in the draft or a removed queue item).
function discardIfUnused(s, id) {
  const a = s.agent.assets.get(id);
  if (!a || a.label !== 'attached') return;
  if (s.pending.includes(id) || s.queue.some((q) => q.attachmentIds.includes(id))) return;
  if (s.agent.messages.some((m) => m?._attachments?.some?.((x) => x?.id === id) || m?._assets?.includes?.(id))) return;
  s.agent.removeAsset(id);
  const unsaved = s.assetBacklog.delete(id);
  if (s.stored && !unsaved) store.deleteAsset(s.id, id).catch((e) => console.warn('Could not delete file', e));
}

/* ---------- providers & models ---------- */

const activeProvider = () => settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0] || null;

async function saveAll() {
  if (settings.approval !== lastApproval) {
    lastApproval = settings.approval;
    for (const s of sessions.values()) s.agent.autoApprove = false;
    approvalSel.value = settings.approval;
  }
  try {
    await saveSettings(settings);
  } catch (e) {
    setStatus(`Could not save settings: ${errText(e)}`, 'error');
  }
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
  const ro = !s || s.readOnly;
  input.disabled = ro;
  input.placeholder = ro ? 'Read-only: this chat is open in another window' : s.running ? 'Add a prompt to the queue…' : PLACEHOLDER;
  sendBtn.textContent = s?.running ? 'Queue' : 'Send';
  sendBtn.title = s?.running ? 'Add to the queue — it runs when the current job ends (Enter)' : 'Send (Enter)';
  sendBtn.disabled = ro || !s.ready || s.attaching > 0 || (!input.value.trim() && !s.pending.length);
  stopBtn.hidden = !s?.running;
  attachBtn.disabled = ro;
  batchBtn.disabled = ro || !s.ready;
  document.body.classList.toggle('running', Boolean(s?.running));
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
  await flushAll(1500);
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
    ['export-json', 'Export JSON'],
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
  await openSession(id, meta);
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
    if (await heldElsewhere(id)) return historyMessage('This chat is open in another window. Rename it there.', 'error');
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
  if (await heldElsewhere(id)) {
    historyMessage('This chat is open in another window. Close it there first, then delete it.', 'error');
    return;
  }
  const s = sessions.get(id);
  if (s) await closeSession(s, { save: false });
  try {
    await store.delete(id);
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
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function flushOne(id) {
  const s = sessions.get(id);
  if (s && (s.dirty || s.saveTimer || s.assetBacklog.size)) await Promise.race([saveNow(s), sleep(STORE_TIMEOUT)]);
}

async function exportJson(id) {
  await flushOne(id);
  let file;
  try {
    file = await store.exportSession(id);
  } catch (e) {
    throw new Error(failText('Could not export the chat', e));
  }
  const title = file?.sessions?.[0]?.title || metaOf(id)?.title;
  downloadBlob(new Blob([JSON.stringify(file)], { type: 'application/json' }), exportName(title, 'json'));
}

async function exportMarkdown(id) {
  await flushOne(id);
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
  await flushAll();
  try {
    const file = await store.exportAll();
    downloadBlob(new Blob([JSON.stringify(file)], { type: 'application/json' }), `agent-chats-all-${today()}.json`);
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

async function importFiles(files) {
  if (!files.length) return;
  historyMessage(`Importing ${plural(files.length, 'file')}…`);
  const ids = [];
  const errors = [];
  for (const f of files) {
    try {
      let obj;
      try {
        obj = JSON.parse(await readText(f));
      } catch {
        throw new Error('it is not a valid JSON file.');
      }
      const got = await store.importFile(obj);
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
  await openSession(ids[0]);
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
  if (!s || s.readOnly || !s.ready) return;
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
  if (!jobs.length || !s || s.readOnly || !s.ready) return;
  const mode = batchModeInputs.find((r) => r.checked)?.value === 'step' ? 'step' : 'auto';
  if (mode !== queueMode()) {
    settings.queueMode = mode;
    saveAll();
  }
  for (const text of jobs) s.queue.push({ id: newId(), text, attachmentIds: [] });
  batchItems.value = '';
  batchTemplate.value = '';
  closeBatch({ focus: false });
  if (s !== active) activate(s);
  scheduleSave(s);
  announce(`${plural(jobs.length, 'job')} added to the queue.`);
  // Adding jobs is a request to run them: un-pause, and start right away when idle (from the front).
  s.paused = false;
  s.drain = false;
  if (!s.running) runNext(s);
  renderQueue();
  if (!input.disabled) input.focus();
}

/* ---------- restore ---------- */

async function restoreSessions() {
  let state = {};
  try {
    ({ panel: state = {} } = await chrome.storage.local.get('panel'));
  } catch {}
  let open = Array.isArray(state?.open) ? state.open.filter((x) => typeof x === 'string' && x) : [];
  let activeId = typeof state?.active === 'string' ? state.active : '';
  try {
    const legacy = await withTimeout(store.migrateLegacy(), STORE_TIMEOUT);
    if (legacy) {
      if (!open.includes(legacy)) open.push(legacy);
      activeId = legacy;
    }
  } catch (e) {
    setStatus(`Could not restore the chat from the previous version: ${errText(e)}`, 'error');
  }
  let metas = null;
  try {
    metas = await withTimeout(store.list(), STORE_TIMEOUT);
  } catch (e) {
    setStatus(failText('Could not load saved chats', e), 'error');
  }
  const byId = new Map((metas || []).map((m) => [m.id, m]));
  const held = await heldLocks();
  // Chats open in another window's panel stay there (they're in History if needed here).
  open = [...new Set(open)].filter((id) => (!metas || byId.has(id)) && !held.has(lockName(id)));
  for (const id of open) createSession(byId.get(id) || { id, title: 'Chat' }, { stored: true, ready: false });
  const first = sessions.get(activeId) || [...sessions.values()].at(-1);
  if (!first) {
    newTab();
    return;
  }
  activate(first);
  await first.loading;
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
    } else if (active?.running && !e.defaultPrevented) {
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
  });
  input.addEventListener('keydown', (e) => {
    // keyCode 229 = IME still composing (Safari-style); isComposing covers Chrome.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && active?.running) {
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
  queueRunNext.addEventListener('click', () => {
    const s = active;
    if (!s) return;
    s.paused = false;
    s.drain = false;
    runNext(s);
  });
  queueRunAll.addEventListener('click', () => {
    const s = active;
    if (!s) return;
    s.paused = false;
    s.drain = true;
    runNext(s);
  });
  queueResume.addEventListener('click', () => {
    const s = active;
    if (!s) return;
    s.paused = false;
    s.drain = false;
    runNext(s);
  });
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

  // save before the panel goes away
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAll();
      if (panelTimer) writePanel();
    }
  });
  window.addEventListener('pagehide', () => {
    flushAll();
    if (panelTimer) writePanel();
  });

  tabIcon.addEventListener('error', () => (tabIcon.hidden = true));
  chrome.tabs.onActivated.addListener((info) => {
    if (windowId == null || info.windowId === windowId) updateTab();
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (!tab.active || (windowId != null && tab.windowId !== windowId)) return;
    if (info.title || info.favIconUrl || info.url || info.status === 'complete') updateTab();
  });
}

async function init() {
  settings = await loadSettings();
  lastApproval = settings.approval;
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
  try {
    await restoreSessions();
  } catch (e) {
    console.error(e);
    setStatus(`Could not restore your open chats: ${errText(e)}`, 'error');
  }
  if (!sessions.size) newTab();
  if (!input.disabled) input.focus();

  const p = activeProvider();
  if (!p) setStatus('No model provider configured. Add one in Settings.', 'error');
  else if (!p.models?.length) fetchModels(p, { quiet: true });
}

init().catch((e) => {
  console.error(e);
  setStatus(`Failed to start: ${errText(e)}`, 'error');
});

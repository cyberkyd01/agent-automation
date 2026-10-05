import { Agent } from './src/agent.js';
import { md, stripToolCalls } from './src/markdown.js';
import { listModels, pickModel } from './src/providers.js';
import { renderSettings } from './src/settings-ui.js';
import { loadSettings, saveSettings, syncOriginRules } from './src/storage.js';
import { blobToDataUrl, repoLink, safeParse, splitThink } from './src/util.js';

const CUSTOM_MODEL = '__custom__';
const TOOL_TEXT_LIMIT = 4000;
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
const newChatBtn = $('newChat');
const settingsBtn = $('openSettings');
const statusEl = $('status');
const chatEl = $('chat');
const attachRow = $('attachments');
const input = $('input');
const approvalSel = $('approval');
const attachBtn = $('attach');
const fileInput = $('fileInput');
const tabEl = $('tab');
const tabIcon = $('tabIcon');
const tabTitle = $('tabTitle');
const sendBtn = $('send');
const settingsEl = $('settings');
const settingsBody = $('settingsBody');
const closeSettingsBtn = $('closeSettings');

let settings = null;
let lastApproval = null;
let windowId = null;
let running = false;
let runGen = 0;
let runDone = Promise.resolve();
let pinned = true;
let statusSeq = 0;
const attachments = [];
const live = new Set(); // views still streaming/running; settled when a run ends
const loadingModels = new Set();

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

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/* ---------- agent ---------- */

const ui = {
  assistantStart: () => assistantView(),
  toolStart: (name, args) => toolCard(name, args),
  notice: (text, kind) => notice(text, kind),
  asset: (a) => assetCard(a),
};

const agent = new Agent(ui);

/* ---------- scrolling ---------- */

const nearBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
chatEl.addEventListener('scroll', () => (pinned = nearBottom()), { passive: true });
new ResizeObserver(() => follow()).observe(chatEl);

// Keep following new content only while the user hasn't scrolled up to read.
function follow(force = false) {
  if (force) pinned = true;
  if (pinned) chatEl.scrollTop = chatEl.scrollHeight;
}

function add(node) {
  chatEl.querySelector('.empty')?.remove();
  chatEl.append(node);
  follow();
  return node;
}

/* ---------- status line ---------- */

function setStatus(text, kind = 'info') {
  statusEl.textContent = text || '';
  statusEl.className = kind === 'error' ? 'error' : '';
  statusEl.hidden = !text;
  return ++statusSeq;
}

const clearStatus = (seq) => seq === statusSeq && setStatus('');

/* ---------- chat views ---------- */

function showEmpty() {
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
  for (const s of SUGGESTIONS) {
    const b = el('button', 'suggestion', s);
    b.type = 'button';
    b.addEventListener('click', () => {
      input.value = s;
      autosize();
      updateSend();
      input.focus();
    });
    list.append(b);
  }
  wrap.append(list);
  const rate = repoLink('empty-link', '★ Rate on GitHub');
  if (rate) wrap.append(rate);
  chatEl.replaceChildren(wrap);
}

function thumb(src, onRemove) {
  const wrap = el('div', 'thumb');
  const open = el('button', 'thumb-open');
  open.type = 'button';
  open.title = 'Open image in a new tab';
  const img = el('img');
  img.alt = '';
  img.src = src;
  img.addEventListener('load', () => follow());
  open.append(img);
  open.addEventListener('click', () => openImage(src));
  wrap.append(open);
  if (onRemove) {
    const x = el('button', 'thumb-x', '×');
    x.type = 'button';
    x.title = 'Remove';
    x.setAttribute('aria-label', 'Remove image');
    x.addEventListener('click', onRemove);
    wrap.append(x);
  }
  return wrap;
}

function thumbs(list) {
  const r = el('div', 'thumbs');
  for (const src of list) r.append(thumb(src));
  return r;
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

function userBubble(text, images = []) {
  const m = el('div', 'msg user');
  if (images.length) m.append(thumbs(images));
  if (text) m.append(el('div', 'text', text));
  add(m);
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
    const b = el('button', 'copy', 'Copy');
    b.type = 'button';
    b.addEventListener('click', async () => {
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

function assistantView() {
  const wrap = el('div', 'msg assistant');
  const think = el('details', 'think live');
  const thinkBody = el('div', 'think-body');
  think.append(el('summary', null, 'Thinking'), thinkBody);
  think.hidden = true;
  const body = el('div', 'md');
  body.hidden = true;
  const dots = workingDots();
  wrap.append(think, body, dots);
  add(wrap);

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
    follow();
    return Boolean(t || reasoning);
  };

  // Renders synchronously: requestAnimationFrame doesn't fire while the panel is hidden.
  const end = (msg) => {
    if (finished) return;
    finished = true;
    live.delete(view);
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
      if (!raf) raf = requestAnimationFrame(render);
    },
    done: (msg) => end(msg),
    settle: () => end(),
  };
  live.add(view);
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
    const s = v.replace(/\s+/g, ' ').trim();
    return /^https?:\/\//i.test(s) || RAW_KEYS.has(k) ? s : `"${clip(s, 40)}"`;
  });
  return clip(parts.join(' · '), 70);
}

const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '');
const capText = (s) => (s.length > TOOL_TEXT_LIMIT ? `${s.slice(0, TOOL_TEXT_LIMIT)}\n… (${s.length - TOOL_TEXT_LIMIT} more characters)` : s);

function toolCard(name, args) {
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
  add(wrap);

  let askBar = null;
  let finished = false;
  const setState = (state, label, glyph) => {
    wrap.classList.remove('running', 'ok', 'error', 'stopped', 'asking');
    wrap.classList.add(state);
    icon.textContent = glyph;
    icon.setAttribute('aria-label', label);
  };

  const card = {
    ask(signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        det.open = true;
        wrap.classList.add('asking');
        const bar = el('div', 'ask');
        askBar = bar;
        const close = () => {
          bar.remove();
          askBar = null;
          wrap.classList.remove('asking');
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          close();
          reject(signal.reason);
        };
        const choice = (label, value, cls) => {
          const b = el('button', `btn ${cls}`.trim(), label);
          b.type = 'button';
          b.addEventListener('click', () => {
            close();
            resolve(value);
          });
          return b;
        };
        bar.append(
          el('span', 'ask-q', 'Allow this action?'),
          choice('Allow', 'allow', 'primary'),
          choice('Allow all (this chat)', 'always', ''),
          choice('Deny', 'deny', 'danger')
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        wrap.append(bar);
        // Approval needs attention even if the user scrolled up.
        bar.scrollIntoView({ block: 'nearest' });
        follow();
      });
    },
    finish(text, isError, images) {
      if (finished) return;
      finished = true;
      live.delete(card);
      askBar?.remove();
      setState(isError ? 'error' : 'ok', isError ? 'Failed' : 'Done', isError ? '✕' : '✓');
      const out = text == null ? '' : typeof text === 'string' ? text : pretty(text);
      body.append(el('div', 'tool-label', isError ? 'Error' : 'Result'), el('pre', `tool-pre${isError ? ' err' : ''}`, capText(out || '(no output)')));
      if (isError && out) sum.title = clip(out.replace(/\s+/g, ' '), 200);
      if (images?.length) body.append(thumbs(images));
      follow();
    },
    settle() {
      if (finished) return;
      finished = true;
      live.delete(card);
      askBar?.remove();
      setState('stopped', 'Stopped', '–');
    },
  };
  live.add(card);
  return card;
}

function notice(text, kind = 'info') {
  const n = el('div', `notice ${kind === 'error' ? 'error' : 'info'}`, String(text ?? ''));
  if (kind === 'error') n.setAttribute('role', 'alert');
  add(n);
}

function fileName(id, src) {
  const ext = (/^data:image\/([a-z0-9.+-]+)/i.exec(src)?.[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  return `${String(id || 'image').replace(/[^\w.-]+/g, '_')}.${ext}`;
}

function assetCard({ id, dataUrl, label } = {}) {
  if (!dataUrl) return;
  const card = el('div', 'asset');
  const open = el('button', 'asset-img');
  open.type = 'button';
  open.title = 'Open in a new tab';
  const img = el('img');
  img.alt = label || id || 'Generated image';
  img.src = dataUrl;
  img.addEventListener('load', () => follow());
  open.append(img);
  open.addEventListener('click', () => openImage(dataUrl));

  const meta = el('div', 'asset-meta');
  if (id) meta.append(el('code', 'asset-id', id));
  if (label) {
    const l = el('span', 'asset-label', label);
    l.title = label;
    meta.append(l);
  }
  const dl = el('a', 'btn', 'Download');
  dl.href = dataUrl;
  dl.download = fileName(id, dataUrl);
  const attach = el('button', 'btn', 'Attach');
  attach.type = 'button';
  attach.title = 'Add to the message you are writing';
  attach.addEventListener('click', () => {
    addAttachment(dataUrl);
    input.focus();
  });
  const foot = el('div', 'asset-foot');
  foot.append(meta, dl, attach);
  card.append(open, foot);
  add(card);
}

function settleLive() {
  for (const v of [...live]) v.settle();
  live.clear();
}

/* ---------- history ---------- */

function userText(m) {
  if (typeof m._text === 'string') return m._text;
  let raw = textOf(m.content);
  const i = raw.lastIndexOf('<context>');
  if (i >= 0 && /<\/context>\s*$/.test(raw)) raw = raw.slice(0, i);
  return raw.trim();
}

function userImages(m) {
  if (Array.isArray(m._images)) return m._images;
  if (!Array.isArray(m.content)) return [];
  return m.content.filter((p) => p?.type === 'image_url').map((p) => p.image_url?.url).filter(Boolean);
}

// History doesn't record failure explicitly; these are the agent's error/denial/cancel replies.
const toolFailed = (m) => /^(error\b|cancelled\.|the user denied)/i.test(String(m.content ?? ''));

function renderHistory(messages) {
  chatEl.replaceChildren();
  const cards = new Map();
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      const text = userText(m);
      const images = userImages(m);
      if (text || images.length) userBubble(text, images);
    } else if (m.role === 'assistant') {
      ui.assistantStart().done(m);
      for (const tc of m.tool_calls || []) cards.set(tc.id, toolCard(tc.function?.name, tc.function?.arguments));
    } else if (m.role === 'tool') {
      cards.get(m.tool_call_id)?.finish(m.content, toolFailed(m), m._images);
      cards.delete(m.tool_call_id);
    }
  }
  settleLive();
  if (!chatEl.children.length) showEmpty();
}

async function restoreChat() {
  let saved;
  try {
    ({ chat: saved } = await chrome.storage.local.get('chat'));
  } catch {}
  if (!Array.isArray(saved) || !saved.length) return showEmpty();
  try {
    agent.importMessages(saved);
  } catch (e) {
    console.warn('Could not restore chat', e);
    return showEmpty();
  }
  renderHistory(agent.messages?.length ? agent.messages : saved);
  follow(true);
}

async function persistChat() {
  try {
    const messages = agent.exportMessages();
    if (messages?.length) await chrome.storage.local.set({ chat: messages });
    else await chrome.storage.local.remove('chat');
  } catch (e) {
    console.warn('Could not save chat', e);
  }
}

/* ---------- providers & models ---------- */

const activeProvider = () => settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0] || null;

async function saveAll() {
  if (settings.approval !== lastApproval) {
    lastApproval = settings.approval;
    agent.autoApprove = false;
    approvalSel.value = settings.approval;
  }
  await saveSettings(settings);
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
    if (p === activeProvider()) setStatus(e?.message || String(e), 'error');
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

function updateSend() {
  sendBtn.disabled = !running && !input.value.trim() && !attachments.length;
}

function renderAttachments() {
  attachRow.replaceChildren(
    ...attachments.map((src, i) =>
      thumb(src, () => {
        attachments.splice(i, 1);
        renderAttachments();
        input.focus();
      })
    )
  );
  attachRow.hidden = !attachments.length;
  updateSend();
}

function addAttachment(src) {
  attachments.push(src);
  renderAttachments();
}

async function addFiles(files) {
  let skipped = 0;
  for (const f of files) {
    if (!f.type.startsWith('image/')) {
      skipped++;
      continue;
    }
    try {
      addAttachment(await blobToDataUrl(f));
    } catch (e) {
      setStatus(`Could not read ${f.name}: ${e.message}`, 'error');
    }
  }
  if (skipped) setStatus('Only images can be attached.');
}

function setRunning(on) {
  running = on;
  sendBtn.textContent = on ? 'Stop' : 'Send';
  sendBtn.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  sendBtn.classList.toggle('primary', !on);
  sendBtn.classList.toggle('stop', on);
  document.body.classList.toggle('running', on);
  updateSend();
}

async function send() {
  if (running) {
    agent.stop();
    return;
  }
  const text = input.value.trim();
  if (!text && !attachments.length) return;
  const p = activeProvider();
  if (!p) return setStatus('Add a model provider in Settings first.', 'error');
  if (!p.model) return setStatus('Choose a model first: reload the list or pick “Custom model ID…”.', 'error');

  const images = attachments.splice(0);
  input.value = '';
  autosize();
  renderAttachments();
  userBubble(text, images);
  follow(true);

  const gen = ++runGen;
  let release;
  runDone = new Promise((r) => (release = r));
  setRunning(true);
  try {
    await agent.run(text, images, settings);
  } catch (e) {
    if (gen === runGen) {
      if (e?.name === 'AbortError') notice('Stopped.', 'info');
      else notice(e?.message || String(e), 'error');
    }
  } finally {
    // A newer generation means "New chat" already took over this UI.
    if (gen === runGen) {
      settleLive();
      setRunning(false);
      await persistChat();
    }
    release();
  }
}

async function newChat() {
  if (running) {
    agent.stop();
    await Promise.race([runDone, new Promise((r) => setTimeout(r, 2000))]);
  }
  runGen++;
  settleLive();
  setRunning(false);
  agent.reset();
  agent.autoApprove = false;
  showEmpty();
  follow(true);
  try {
    await chrome.storage.local.remove('chat');
  } catch {}
  input.focus();
}

/* ---------- active tab ---------- */

async function updateTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}
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
  const p = activeProvider();
  if (p && !p.models?.length && (p.baseUrl || p.type === 'anthropic')) fetchModels(p, { quiet: true });
  settingsBtn.focus();
}

/* ---------- wiring ---------- */

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
  newChatBtn.addEventListener('click', newChat);
  settingsBtn.addEventListener('click', openSettings);
  closeSettingsBtn.addEventListener('click', closeSettings);
  statusEl.addEventListener('click', () => setStatus(''));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsEl.hidden) {
      e.preventDefault();
      closeSettings();
    }
  });

  approvalSel.addEventListener('change', () => {
    settings.approval = approvalSel.value;
    saveAll();
  });

  input.addEventListener('input', () => {
    autosize();
    updateSend();
  });
  input.addEventListener('keydown', (e) => {
    // keyCode 229 = IME still composing (Safari-style); isComposing covers Chrome.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!running) send();
    } else if (e.key === 'Escape' && running) {
      e.preventDefault();
      agent.stop();
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
    addFiles(files);
  });

  sendBtn.addEventListener('click', send);
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });

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
    if (settingsEl.hidden) addFiles([...e.dataTransfer.files]);
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
  setRunning(false);
  autosize();
  await restoreChat();
  try {
    windowId = (await chrome.windows.getCurrent()).id;
  } catch {}
  updateTab();
  input.focus();

  const p = activeProvider();
  if (!p) setStatus('No model provider configured. Add one in Settings.', 'error');
  else if (!p.models?.length) fetchModels(p, { quiet: true });
}

init().catch((e) => {
  console.error(e);
  setStatus(`Failed to start: ${e?.message || e}`, 'error');
});

// Settings: a home page with a "Getting started" card and one card per area, and one page per area.
// Every area is built once per opening of Settings and kept in the page (only the visible one is shown), so the
// stateful areas (Computer tools, Remote access) keep running while the user moves between pages.
import { DEFAULTS, PRESETS } from './storage.js';
import { listModels, modelLabel, pickModel } from './providers.js';
import { newId, repoLink } from './util.js';
import { IMAGE_VENDORS } from './image.js';
import { memStore, originOf } from './memory.js';
import { QUEUE_MODES, computerToolsSection, ensureToolSettings, mcpTestControls, providerCodeControls, remoteAccessSection } from './settings-tools-ui.js';

/* ---------- areas ---------- */

export const SECTIONS = [
  {
    key: 'models',
    name: 'Models & providers',
    purpose: 'Where the AI comes from.',
    icon: 'models',
    intro: 'A provider is where the AI runs: a model server on this computer (such as LM Studio or Ollama) or an online service. Add one, click Test connection to load its models, then choose it in the header at the top of the panel.',
  },
  {
    key: 'images',
    name: 'Images',
    purpose: 'Create and edit images.',
    icon: 'images',
    intro: 'Lets the agent make pictures from a description and change images you attach. It can already do this with your main chat model if that model can output images: pick “Your main chat model” below. Choose another vendor only if your workflow needs one.',
  },
  {
    key: 'behaviour',
    name: 'Behaviour',
    purpose: 'Approvals, queue, limits, notifications.',
    icon: 'behaviour',
    intro: 'How the agent works: when it asks you first, how queued prompts run, how far it may go on its own, and what it is told on every request.',
  },
  {
    key: 'memory',
    name: 'Memory',
    purpose: 'What the agent remembers across chats.',
    icon: 'memory',
    intro: 'The agent can remember lasting facts across chats, either everywhere (Global) or for one website, and keeps a short progress note inside each chat so long tasks do not repeat finished work. Here you review and delete what it has saved. It saves these itself when it learns something worth keeping, and you can tell it “remember that …” or “forget …”.',
  },
  {
    key: 'computer',
    name: 'Computer tools',
    purpose: 'Let the agent use this computer: commands, files, terminals, apps.',
    icon: 'computer',
    intro: 'Lets the agent run commands, read and write files, keep terminals open and work in apps on this computer. A small companion program does this for the extension; nothing runs until you set it up below.',
  },
  {
    key: 'remote',
    name: 'Remote access',
    purpose: 'Use your local models and tools from another browser or device.',
    icon: 'remote',
    intro: 'Use the models of this computer, and if you choose its tools, from another browser or device. The companion opens a private Cloudflare tunnel; only what you tick is shared.',
  },
  {
    key: 'mcp',
    name: 'Remote MCP servers',
    purpose: 'Tools from servers on the internet.',
    icon: 'mcp',
    intro: 'Adds tools from MCP servers on the internet, reached over HTTP or SSE. Servers that run on this computer are set up under Computer tools.',
  },
  {
    key: 'about',
    name: 'About & help',
    purpose: 'Version, user guide, feedback.',
    icon: 'about',
    intro: 'The version you are running, the user guide, and where to report a problem.',
  },
];
const SECTION = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

// How long a companion check stays good enough for the home page pills.
export const COMPANION_TTL = 10000;

// Kept for the whole panel session (across openings of Settings): the last companion check, the tunnel state and
// the result of each provider's last Test connection.
const live = { companion: null, tunnel: null, providers: new Map(), chats: null, memCount: null };
export function resetSettingsState() {
  live.companion = null;
  live.tunnel = null;
  live.providers.clear();
  live.chats = null;
  live.memCount = null;
}

/* ---------- small DOM helpers ---------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING = 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0';
const ICONS = {
  models: ['M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z', 'M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5', 'M10 10h4v4h-4z'],
  images: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M7 9.5a2 2 0 1 0 4 0a2 2 0 1 0-4 0', 'M21 15l-5-5L5 20'],
  behaviour: ['M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3z', 'M9 12l2 2 4-4'],
  computer: ['M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8 21h8M12 17v4', 'M7.5 8.5l2.5 2-2.5 2M12.5 12.5h4'],
  remote: [RING, 'M3 12h18', 'M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z'],
  mcp: ['M9 2.5V7M15 2.5V7', 'M6 7h12v4a6 6 0 0 1-12 0V7z', 'M12 17v4.5'],
  memory: ['M9 3h6v3.5a2 2 0 0 0 .6 1.4L18 10.3V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-9.7l2.4-2.4A2 2 0 0 0 9 6.5V3z', 'M9.5 14h5M9.5 17h3'],
  about: [RING, 'M12 11v5.5', 'M12 7.6v.01'],
  start: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z', 'M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z'],
  chevron: ['M9 6l6 6-6 6'],
  down: ['M6 9l6 6 6-6'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  warn: ['M12 3.5l9.5 16.5h-19L12 3.5z', 'M12 10v4.5', 'M12 17.4v.01'],
};

function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `ico${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

// A status pill: data-state is ok | warn | off | error | info.
function pill(text = '', state = 'off') {
  const p = el('span', 'pill', text);
  p.dataset.state = state;
  return p;
}
const setAttr = (node, name, value) => node.getAttribute(name) !== value && node.setAttribute(name, value);

function setPill(p, text, state) {
  if (p.textContent !== text) p.textContent = text;
  if (p.dataset.state !== state) p.dataset.state = state;
}

// An icon and one or two short lines, for things the user must not miss.
function callout(kind, lines) {
  const c = el('div', `callout ${kind}`);
  c.append(icon(kind === 'warn' ? 'warn' : 'about', 'callout-icon'));
  const t = el('div', 'callout-text');
  for (const l of lines) t.append(typeof l === 'string' ? el('p', null, l) : l);
  c.append(t);
  return c;
}

let uid = 0;

function textInput(value, type = 'text', placeholder = '') {
  const i = el('input');
  i.type = type;
  i.value = value ?? '';
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.autocomplete = 'off';
  return i;
}

function numberInput(value, { min, max, step = 1, placeholder = '' } = {}) {
  const i = textInput(value, 'number', placeholder);
  if (min != null) i.min = String(min);
  if (max != null) i.max = String(max);
  i.step = String(step);
  return i;
}

function textArea(value, { rows = 3, placeholder = '', mono = false } = {}) {
  const t = el('textarea', mono ? 'ctl mono' : 'ctl');
  t.value = value ?? '';
  t.rows = rows;
  t.placeholder = placeholder;
  t.spellcheck = !mono;
  return t;
}

function setOptions(sel, options, value) {
  sel.replaceChildren(
    ...options.map(([v, label]) => {
      const o = el('option', null, label);
      o.value = v;
      return o;
    })
  );
  sel.value = value ?? '';
}

function selectBox(options, value) {
  const s = el('select');
  setOptions(s, options, value);
  return s;
}

function checkbox(checked) {
  const c = el('input');
  c.type = 'checkbox';
  c.checked = !!checked;
  return c;
}

function button(label, cls = '') {
  const b = el('button', `btn ${cls}`.trim(), label);
  b.type = 'button';
  return b;
}

// Two clicks to remove, so a stray click can't delete a configured entry.
function removeButton(onConfirm) {
  const b = button('Remove', 'danger');
  let timer = 0;
  const reset = () => {
    clearTimeout(timer);
    timer = 0;
    b.textContent = 'Remove';
    b.classList.remove('confirm');
  };
  b.addEventListener('click', () => {
    if (timer) {
      reset();
      onConfirm();
      return;
    }
    b.textContent = 'Confirm remove';
    b.classList.add('confirm');
    timer = setTimeout(reset, 3000);
  });
  b.addEventListener('blur', () => timer && reset());
  return b;
}

// Like removeButton, with its own labels: the first click asks, the second (within 3 s) does it.
function confirmButton(label, confirmLabel, onConfirm) {
  const b = button(label, 'danger');
  let timer = 0;
  const reset = () => {
    clearTimeout(timer);
    timer = 0;
    b.textContent = label;
    b.classList.remove('confirm');
  };
  b.addEventListener('click', () => {
    if (timer) {
      reset();
      onConfirm();
      return;
    }
    b.textContent = confirmLabel;
    b.classList.add('confirm');
    timer = setTimeout(reset, 3000);
  });
  b.addEventListener('blur', () => timer && reset());
  return b;
}

function hintFor(ctl, text) {
  const h = el('div', 'hint', text);
  h.id = `${ctl.id}-hint`;
  ctl.setAttribute('aria-describedby', h.id);
  return h;
}

function field(label, ctl, hint) {
  const f = el('div', 'field');
  ctl.id ||= `set-${++uid}`;
  const l = el('label', 'field-label', label);
  l.htmlFor = ctl.id;
  f.append(l, ctl);
  if (hint) f.append(hintFor(ctl, hint));
  return f;
}

function checkField(label, ctl, hint) {
  const f = el('div', 'field check');
  ctl.id ||= `set-${++uid}`;
  const l = el('label');
  l.append(ctl, el('span', null, label));
  f.append(l);
  if (hint) f.append(hintFor(ctl, hint));
  return f;
}

function row(...children) {
  const r = el('div', 'row2');
  r.append(...children);
  return r;
}

// A group of controls: a card with a heading and a one-line hint.
function card(title, hint, { id, cls = '' } = {}) {
  const c = el('section', `set-card ${cls}`.trim());
  if (id) c.id = id;
  if (title) c.append(el('h3', 'set-card-title', title));
  if (hint) c.append(el('p', 'hint set-card-hint', hint));
  return c;
}

// Kept for older callers: a plain titled block (now a card).
const section = (title, hint) => card(title, hint);

// Collapsed "Advanced" block at the bottom of a page.
function advanced(id) {
  const d = el('details', 'advanced');
  if (id) d.id = id;
  const body = el('div', 'advanced-body');
  d.append(el('summary', null, 'Advanced'), body);
  return { root: d, body };
}

// One numbered step of a guided flow (.steps > .step[data-done]). A collapsible step has a button as its header;
// a collapsed one shows a one-line summary instead of its body.
let stepUid = 0;
function step({ n, title, collapsible = false, optional = false, wide = false }) {
  const root = el('div', `step${wide ? ' wide' : ''}`);
  root.dataset.step = String(n);
  root.dataset.done = 'false';
  const h = el('h3', 'step-h');
  const head = el(collapsible ? 'button' : 'div', 'step-head');
  if (collapsible) head.type = 'button';
  const mark = el('span', 'step-mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.append(el('span', 'step-num', String(n)), icon('check', 'step-check'));
  const text = el('span', 'step-text');
  const titleEl = el('span', 'step-title', title);
  if (optional) titleEl.append(' ', el('span', 'step-tag', 'Optional'));
  const summary = el('span', 'step-summary');
  summary.hidden = true;
  text.append(titleEl, summary);
  const sr = el('span', 'sr-only');
  head.append(mark, text, sr);
  if (collapsible) head.append(icon('down', 'step-chev'));
  h.append(head);
  const body = el('div', 'step-body');
  body.id = `step-body-${++stepUid}`;
  root.append(h, body);
  let summaryText = '';
  const paintSummary = () => {
    const show = !!summaryText && body.hidden;
    if (summary.hidden !== !show) summary.hidden = !show;
    if (summary.textContent !== summaryText) summary.textContent = summaryText;
  };
  const api = {
    root,
    body,
    head,
    collapsible,
    userToggled: false,
    get open() {
      return !body.hidden;
    },
    // Every write is skipped when nothing changes, so a polled repaint does not re-announce or flicker.
    setOpen(open) {
      open = !!open;
      if (body.hidden !== !open) body.hidden = !open;
      setAttr(root, 'data-open', String(open));
      if (collapsible) setAttr(head, 'aria-expanded', String(open));
      paintSummary();
    },
    set({ done = false, current = false, problem = false, summary: s = '' } = {}) {
      setAttr(root, 'data-done', String(!!done));
      if (root.hasAttribute('data-current') !== !!current) root.toggleAttribute('data-current', !!current);
      if (root.hasAttribute('data-problem') !== !!problem) root.toggleAttribute('data-problem', !!problem);
      const srText = done ? ' (done)' : current ? ' (next step)' : '';
      if (sr.textContent !== srText) sr.textContent = srText;
      summaryText = s || '';
      paintSummary();
    },
  };
  if (collapsible) {
    head.setAttribute('aria-controls', body.id);
    head.addEventListener('click', () => {
      api.userToggled = true;
      api.setOpen(body.hidden);
    });
  }
  api.setOpen(true);
  return api;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MODEL_SUMMARY_MAX = 8; // models named on a provider card before "and N more"
const errText = (e) => (e?.message || String(e || 'unknown error')).replace(/\s+/g, ' ').trim();

// The image vendor a setting stands for. Settings saved before vendors existed hold a provider and no vendor.
const imageVendorOf = (img) => {
  const v = img?.vendor;
  if (typeof v === 'string' && Object.hasOwn(IMAGE_VENDORS, v)) return v;
  return !v && img?.providerId ? 'openai' : 'none';
};

/* ---------- render ---------- */

// Builds Settings into `container` (the scrolling #settingsBody). Returns { show(section), section, refresh() }.
// opts: save() (rejects when saving failed), onProvidersChanged(), onNavigate({ section, title, focus }),
// onClose(), hasChats() → Promise<boolean>, section (the page to show first, default 'home').
export function renderSettings(container, settings, opts = {}) {
  const { save, onProvidersChanged, onNavigate, onClose, hasChats } = opts;
  // Settings saved by an older version lack the newer fields.
  ensureToolSettings(settings, DEFAULTS);
  if (!settings.memory || typeof settings.memory !== 'object') settings.memory = {};
  settings.memory.enabled = settings.memory.enabled !== false;
  if (!Number.isFinite(Number(settings.memory.maxInjectChars))) settings.memory.maxInjectChars = DEFAULTS.memory?.maxInjectChars ?? 4000;

  /* --- saving --- */

  const notice = el('div', 'settings-notice');
  notice.id = 'settingsNotice';
  notice.setAttribute('role', 'alert');
  notice.hidden = true;

  const saveErrors = new Map(); // control → its error line
  const showSaveError = (ctl, e) => {
    const reason = errText(e);
    if (!ctl) {
      notice.textContent = `Could not save your settings: ${reason}`;
      notice.hidden = false;
      return;
    }
    let line = saveErrors.get(ctl);
    if (!line) {
      line = el('div', 'field-error save-error');
      line.setAttribute('role', 'alert');
      const host = ctl.closest('.field') || ctl.parentElement;
      host?.append(line);
      saveErrors.set(ctl, line);
    }
    line.textContent = `Could not save this change (${reason}), so it was put back.`;
    line.hidden = false;
  };
  const clearSaveError = (ctl) => {
    if (ctl) {
      const line = saveErrors.get(ctl);
      if (line) line.hidden = true;
    }
    notice.hidden = true;
  };
  // Resolves true when saved; a failure is shown (next to `ctl`, or at the top of the page) and resolves false.
  const commit = (ctl) =>
    Promise.resolve()
      .then(() => save?.())
      .then(
        () => {
          clearSaveError(ctl);
          return true;
        },
        (e) => {
          showSaveError(ctl, e);
          return false;
        }
      );

  // Remote access lists the providers that sit on this network, so it follows every provider edit.
  let remote = null;
  const headerChanged = () => {
    try {
      onProvidersChanged?.();
    } catch {}
    remote?.refreshProviders?.();
  };

  // `capture()` runs before the change is applied and returns the function that puts the old value back, used
  // when saving fails.
  const onChange = (ctl, fn, capture) =>
    ctl.addEventListener('change', () => {
      let undo = null;
      try {
        undo = capture?.() || null;
      } catch {}
      fn();
      commit(ctl).then((ok) => {
        if (ok || !undo) return;
        undo();
        // Keep what is stored and what is shown the same once storage works again.
        Promise.resolve()
          .then(() => save?.())
          .catch(() => {});
      });
    });
  const keep = (obj, key, ctl, prop = 'value', after) => () => {
    const old = obj[key];
    return () => {
      obj[key] = old;
      if (prop === 'checked') ctl.checked = !!old;
      else ctl.value = old == null ? '' : String(old);
      after?.();
    };
  };
  const bindText = (obj, key, ctl, after) =>
    onChange(
      ctl,
      () => {
        obj[key] = ctl.value.trim();
        after?.();
      },
      keep(obj, key, ctl, 'value', after)
    );
  const bindSelect = (obj, key, ctl, after) =>
    onChange(
      ctl,
      () => {
        obj[key] = ctl.value;
        after?.();
      },
      keep(obj, key, ctl, 'value', after)
    );
  // Blank stores '' for optional fields and restores the default for required ones.
  const bindNumber = (obj, key, ctl, { blank = false, int = true, min, max } = {}) =>
    onChange(
      ctl,
      () => {
        const raw = ctl.value.trim();
        let v = raw === '' ? NaN : Number(raw);
        if (Number.isFinite(v)) {
          if (int) v = Math.round(v);
          if (min != null) v = Math.max(min, v);
          if (max != null) v = Math.min(max, v);
        } else v = blank ? '' : DEFAULTS[key];
        obj[key] = v;
        ctl.value = v === '' ? '' : String(v);
      },
      keep(obj, key, ctl)
    );

  let navigate = () => {};
  // The areas build their controls with these same helpers.
  const kit = {
    el,
    icon,
    pill,
    setPill,
    callout,
    textInput,
    numberInput,
    textArea,
    selectBox,
    checkbox,
    button,
    removeButton,
    field,
    checkField,
    row,
    card,
    section,
    advanced,
    step,
    onChange,
    bindSelect,
    commit,
    navigate: (key, o) => navigate(key, o),
  };

  const activeProvider = () => settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0] || null;
  const providerSig = (p) => `${p.type}|${p.baseUrl}|${p.apiKey}`;
  // The result of the provider's last Test connection, while its address and key are unchanged.
  const checkOf = (p) => {
    const r = p && live.providers.get(p.id);
    return r && r.sig === providerSig(p) ? r : null;
  };

  /* ---------- page: Models & providers ---------- */

  let renderMcp = () => {};
  let refreshImageProviders = () => {};

  function buildModels(root) {
    const providerList = el('div', 'cards');
    providerList.id = 'providerList';

    const renderProviders = () => {
      providerList.replaceChildren(...settings.providers.map(providerCard));
      if (!settings.providers.length) providerList.append(el('p', 'hint', 'No providers yet. Add one below.'));
    };

    function providerCard(p) {
      const cardEl = el('div', 'card provider-card');
      cardEl.dataset.providerId = p.id;

      const head = el('div', 'prov-head');
      const title = el('span', 'prov-name', p.name || 'Unnamed provider');
      const status = pill();
      status.dataset.role = 'provider-status';
      head.append(title, status);
      const isActive = p.id === activeProvider()?.id;
      const inUse = el('div', 'prov-use');
      if (isActive) inUse.append(el('span', 'prov-active', 'In use in the header'));
      else {
        const use = button('Use this provider', 'ghost');
        use.dataset.role = 'use-provider';
        use.addEventListener('click', () => {
          const old = settings.activeProviderId;
          settings.activeProviderId = p.id;
          headerChanged();
          commit().then((ok) => {
            if (!ok) {
              settings.activeProviderId = old;
              headerChanged();
            }
            renderProviders();
            const again = [...providerList.children].find((x) => x.dataset.providerId === p.id);
            again?.scrollIntoView?.({ block: 'nearest' });
            again?.querySelector('[data-role=provider-test]')?.focus();
          });
        });
        inUse.append(use);
      }

      // For LM Studio (the server said which models are loaded): the models, those that are loaded marked as in the header.
      const summary = el('p', 'hint prov-models');
      summary.dataset.role = 'provider-models';
      const paintModels = () => {
        const list = p.models || [];
        const known = Array.isArray(p.loadedModels) && list.length > 0;
        summary.hidden = !known;
        if (!known) return summary.replaceChildren();
        const shown = list.slice(0, MODEL_SUMMARY_MAX).map((m) => modelLabel(p, m));
        const more = list.length - shown.length;
        summary.textContent = `Models: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
      };

      const paintStatus = () => {
        const r = checkOf(p);
        const n = p.models?.length || 0;
        if (r?.state === 'testing') setPill(status, 'Testing…', 'info');
        else if (r?.state === 'error') setPill(status, 'Not reachable', 'error');
        else if (r?.state === 'ok' || n) setPill(status, `Connected · ${plural(r?.state === 'ok' ? r.n : n, 'model')}`, 'ok');
        else setPill(status, 'Not tested', 'off');
        paintModels();
      };

      const name = textInput(p.name, 'text', 'Name');
      bindText(p, 'name', name, () => {
        title.textContent = p.name || 'Unnamed provider';
        headerChanged();
        refreshImageProviders();
      });

      const type = selectBox([['openai', 'OpenAI-compatible'], ['anthropic', 'Anthropic']], p.type);
      // A different server or API shape makes the cached model list meaningless.
      const MODEL_KEYS = ['models', 'loadedModels', 'modelTypes']; // the list, and (LM Studio) which are loaded and what each is
      const oldModels = () => {
        const old = MODEL_KEYS.map((k) => [k, p[k]]);
        return () => old.forEach(([k, v]) => (v === undefined ? delete p[k] : (p[k] = v)));
      };
      const forgetModels = () => {
        p.models = [];
        delete p.loadedModels;
        delete p.modelTypes;
      };
      onChange(
        type,
        () => {
          p.type = type.value;
          forgetModels();
          headerChanged();
          refreshImageProviders();
          paintStatus();
        },
        () => {
          const undoType = keep(p, 'type', type)();
          const undoModels = oldModels();
          return () => {
            undoType();
            undoModels();
            paintStatus();
          };
        }
      );

      const base = textInput(p.baseUrl, 'url', p.type === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:1234/v1');
      onChange(
        base,
        () => {
          p.baseUrl = base.value.trim();
          forgetModels();
          headerChanged();
          paintStatus();
        },
        () => {
          const undoUrl = keep(p, 'baseUrl', base)();
          const undoModels = oldModels();
          return () => {
            undoUrl();
            undoModels();
            paintStatus();
          };
        }
      );

      const key = textInput(p.apiKey, 'password', 'not needed for local servers');
      bindText(p, 'apiKey', key, paintStatus);

      const result = el('div', 'test-result');
      result.setAttribute('role', 'status');
      result.hidden = true;

      const test = button('Test connection', 'primary');
      test.dataset.role = 'provider-test';
      test.addEventListener('click', async () => {
        test.disabled = true;
        result.hidden = false;
        result.className = 'test-result';
        result.textContent = 'Testing…';
        const sig = providerSig(p);
        live.providers.set(p.id, { state: 'testing', sig, n: 0 });
        paintStatus();
        try {
          const models = await listModels(p, AbortSignal.timeout(20000));
          p.models = models;
          if (!p.model) p.model = pickModel(models, p.loadedModels, p.modelTypes);
          live.providers.set(p.id, { state: 'ok', sig, n: models.length });
          await commit(test);
          headerChanged();
          result.classList.add('ok');
          result.textContent = `✓ ${models.length} model${models.length === 1 ? '' : 's'}`;
        } catch (e) {
          live.providers.set(p.id, { state: 'error', sig, n: 0, error: errText(e) });
          result.classList.add('error');
          result.textContent = e?.message || String(e);
        } finally {
          test.disabled = false;
          paintStatus();
        }
      });

      const remove = removeButton(() => {
        const i = settings.providers.indexOf(p);
        if (i >= 0) settings.providers.splice(i, 1);
        if (!settings.providers.some((x) => x.id === settings.activeProviderId)) {
          settings.activeProviderId = settings.providers[0]?.id || '';
        }
        live.providers.delete(p.id);
        renderProviders();
        refreshImageProviders();
        headerChanged();
        commit();
        addProvider.focus();
      });

      const actions = el('div', 'card-actions');
      actions.append(test, remove);
      paintStatus();
      cardEl.append(head, inUse, summary, row(field('Name', name), field('Type', type)), field('Base URL', base), field('API key', key), actions, result);
      return cardEl;
    }

    const uniqueName = (b) => {
      let n = b;
      for (let k = 2; settings.providers.some((p) => p.name === n); k++) n = `${b} ${k}`;
      return n;
    };

    const addProvider = selectBox([['', 'Add provider…'], ...Object.entries(PRESETS).map(([k, v]) => [k, v.name])], '');
    addProvider.className = 'add-select';
    addProvider.id = 'providerAdd';
    addProvider.setAttribute('aria-label', 'Add provider');
    addProvider.addEventListener('change', () => {
      const preset = PRESETS[addProvider.value];
      addProvider.value = '';
      if (!preset) return;
      const p = { id: newId(), name: uniqueName(preset.name), type: preset.type, baseUrl: preset.baseUrl, apiKey: '', model: '', models: [] };
      settings.providers.push(p);
      if (!settings.providers.some((x) => x.id === settings.activeProviderId)) settings.activeProviderId = p.id;
      renderProviders();
      refreshImageProviders();
      headerChanged();
      commit();
      // Jump to the field the user most likely has to fill in next.
      const c = providerList.lastElementChild;
      const local = /\/\/(localhost|127\.)/.test(p.baseUrl);
      c?.querySelector(!p.baseUrl ? 'input[type=url]' : local ? 'input' : 'input[type=password]')?.focus();
      c?.scrollIntoView?.({ block: 'nearest' });
    });

    // Providers made from a connection code (Settings → Remote access in another browser) also add Remote MCP servers.
    const fromCode = providerCodeControls(settings, kit, {
      onAdded: () => {
        if (!settings.providers.some((x) => x.id === settings.activeProviderId)) settings.activeProviderId = settings.providers[0]?.id || '';
        renderProviders();
        refreshImageProviders();
        renderMcp();
        headerChanged();
        commit();
      },
    });

    renderProviders();
    const list = card('Your providers', 'Test a provider to load its models. The one in use, and its model, are chosen in the header at the top of the panel.', { id: 'settingsProviders' });
    list.append(providerList);

    const add = card('Add a provider', null, { id: 'settingsAddProvider' });
    const presetBlock = el('div', 'add-option');
    presetBlock.append(el('p', 'hint', 'A ready-made entry: a model server on this computer (LM Studio, Ollama) or an online service (OpenAI, Anthropic, …).'), addProvider);
    const codeBlock = el('div', 'add-option');
    codeBlock.append(el('p', 'hint', 'Models shared by another computer: paste the connection code from Settings → Remote access there.'), fromCode.button, fromCode.form);
    add.append(presetBlock, codeBlock);

    root.append(list, add);
    return { onShow: () => renderProviders() };
  }

  /* ---------- page: Images ---------- */

  function buildImages(root) {
    const img = settings.image;
    // Settings saved before vendors existed name no vendor: they were using their OpenAI-compatible provider.
    if (!img.vendor) img.vendor = imageVendorOf(img);
    const vendorOf = () => imageVendorOf(img);
    const specOf = () => IMAGE_VENDORS[vendorOf()] || {};
    const hintOf = (f) => f.querySelector('.hint');

    const vendor = selectBox(
      Object.entries(IMAGE_VENDORS).map(([k, v]) => [k, v.label || k]),
      vendorOf()
    );
    vendor.id = 'imageVendor';
    const note = el('p', 'hint image-note', 'Uses the model selected in the panel header, when it can output images.');
    note.id = 'imageVendorNote';

    // The Test result is about the settings as they were; any change takes it away.
    const testBtn = button('Test', 'primary');
    testBtn.id = 'imageTest';
    const actions = el('div', 'card-actions');
    actions.append(testBtn);
    const testMsg = el('div', 'test-result');
    testMsg.id = 'imageTestMsg';
    testMsg.setAttribute('role', 'status');
    testMsg.hidden = true;
    let testRun = 0;
    function resetTest() {
      testRun++;
      testBtn.disabled = false;
      testMsg.hidden = true;
      testMsg.textContent = '';
    }

    /* OpenAI-compatible provider: the provider, its API mode, model and size. */
    const imageProvider = el('select');
    imageProvider.id = 'imageProvider';
    const noProviders = el('div', 'add-option');
    noProviders.hidden = true;
    const goModels = button('Open Models & providers');
    goModels.addEventListener('click', () => navigate('models'));
    noProviders.append(el('p', 'hint', 'There is no OpenAI-compatible provider yet. Add one first, for example OpenAI or OpenRouter.'), goModels);
    bindSelect(img, 'providerId', imageProvider, resetTest);

    const imgApi = selectBox(
      [
        ['images', 'Images API (/images/generations, /images/edits)'],
        ['chat', 'Chat completions with image output'],
      ],
      img.api
    );
    imgApi.id = 'imageApiMode';
    bindSelect(img, 'api', imgApi, resetTest);

    const providerField = field('Provider', imageProvider);
    const apiField = field('API mode', imgApi, 'Use chat completions for models that return images in chat replies (e.g. Gemini image models via OpenRouter).');

    /* Hosted vendors: an API key (masked unless Show is pressed), a link to where to get one. */
    const key = textInput(img.apiKey, 'password', 'Paste your API key');
    key.id = 'imageApiKey';
    const keyField = field('API key', key, 'Stored in this browser only.');
    const reveal = button('Show');
    reveal.id = 'imageApiKeyShow';
    reveal.setAttribute('aria-controls', key.id);
    const maskKey = () => {
      key.type = 'password';
      reveal.textContent = 'Show';
      reveal.setAttribute('aria-pressed', 'false');
      reveal.setAttribute('aria-label', 'Show API key');
    };
    reveal.addEventListener('click', () => {
      const on = key.type === 'password';
      key.type = on ? 'text' : 'password';
      reveal.textContent = on ? 'Hide' : 'Show';
      reveal.setAttribute('aria-pressed', String(on));
      reveal.setAttribute('aria-label', on ? 'Hide API key' : 'Show API key');
    });
    const keyRow = el('div', 'input-row');
    keyField.replaceChild(keyRow, key);
    keyRow.append(key, reveal);
    bindText(img, 'apiKey', key, resetTest);
    const keyLink = el('a', 'tools-link', 'Get a key');
    keyLink.id = 'imageKeyLink';
    keyLink.target = '_blank';
    keyLink.rel = 'noreferrer';
    const keyWhere = el('span', 'image-key-where');
    const keyHelp = el('div', 'hint image-key-help');
    keyHelp.append(keyLink, keyWhere);
    keyField.append(keyHelp);

    /* Model and size are shared by both kinds; the vendor's own suggestions come as a datalist. */
    const model = textInput(img.model, 'text');
    model.id = 'imageModel';
    const modelList = el('datalist');
    modelList.id = 'imageModelList';
    bindText(img, 'model', model, resetTest);
    const modelField = field('Model', model, ' ');
    modelField.append(modelList);

    const size = textInput(img.size, 'text');
    size.id = 'imageSize';
    const sizeList = el('datalist');
    sizeList.id = 'imageSizeList';
    bindText(img, 'size', size, resetTest);
    const sizeField = field('Size', size, 'Optional. Leave blank for the model default.');
    sizeField.append(sizeList);

    /* Advanced: where the vendor's API lives, for a proxy or a server of your own. */
    const base = textInput(img.baseUrl, 'url');
    base.id = 'imageBaseUrl';
    bindText(img, 'baseUrl', base, resetTest);
    const baseField = field('Base URL', base, ' ');
    const adv = advanced('imageAdvanced');
    adv.root.classList.add('image-adv');
    adv.body.append(el('p', 'hint', 'Change this only to use a proxy or a server you run yourself.'), baseField);

    const setList = (list, values) => list.replaceChildren(...values.map((v) => Object.assign(el('option'), { value: v })));
    const point = (ctl, list, values) => (values.length ? ctl.setAttribute('list', list.id) : ctl.removeAttribute('list'));

    // Shows the fields this vendor uses, with its own labels, suggestions and key link.
    function paint() {
      const v = vendorOf();
      const spec = specOf();
      const openai = v === 'openai';
      const native = !!spec.byok;
      const models = Array.isArray(spec.models) ? spec.models.filter((m) => typeof m === 'string') : [];
      const sizes = Array.isArray(spec.sizes) ? spec.sizes.filter((m) => typeof m === 'string') : [];
      if (vendor.value !== v) vendor.value = v;
      const label = spec.label || v;

      note.hidden = v !== 'chat-model';
      noProviders.hidden = !openai || imageProvider.options.length > 1;
      providerField.hidden = !openai;
      apiField.hidden = !openai;
      keyField.hidden = !native;
      modelField.hidden = !(openai || native);
      sizeField.hidden = !(openai || (native && sizes.length > 0));
      adv.root.hidden = !native;
      actions.hidden = v === 'none';

      hintOf(keyField).textContent = `Stored in this browser only, and sent only to ${label}.`;
      const url = typeof spec.keyUrl === 'string' && /^https:\/\//i.test(spec.keyUrl) ? spec.keyUrl : '';
      keyLink.hidden = !url;
      if (url) keyLink.href = url;
      else keyLink.removeAttribute('href');
      keyWhere.textContent = spec.keyHelp ? ` · ${spec.keyHelp}` : '';

      model.placeholder = openai ? 'e.g. gpt-image-1' : models[0] ? `e.g. ${models[0]}` : 'Model ID';
      setList(modelList, models);
      point(model, modelList, models);
      hintOf(modelField).textContent = openai
        ? 'The image model your provider offers.'
        : models.length
          ? 'Pick one of the suggestions or type any model ID. Blank uses the default.'
          : 'The vendor’s model ID. Blank uses the default.';

      size.placeholder = sizes[0] || '1024x1024';
      setList(sizeList, sizes);
      point(size, sizeList, sizes);

      base.placeholder = spec.baseUrl || '';
      hintOf(baseField).textContent = spec.baseUrl ? `Blank uses ${spec.baseUrl}.` : 'Blank uses the vendor’s own address.';
    }

    // The values of the fields, after the vendor changed.
    function fill() {
      key.value = img.apiKey ?? '';
      model.value = img.model ?? '';
      size.value = img.size ?? '';
      base.value = img.baseUrl ?? '';
      maskKey();
      if (img.baseUrl && specOf().byok) adv.root.open = true;
    }

    // The key, model, size and address belong to one vendor. Switching clears them (one vendor's key is never
    // sent to another), but while Settings stays open, switching back brings the vendor's values back.
    const VENDOR_FIELDS = ['apiKey', 'baseUrl', 'model', 'size'];
    const memory = new Map();
    onChange(
      vendor,
      () => {
        const from = vendorOf();
        const to = vendor.value;
        if (to === from && img.vendor === to) return;
        memory.set(from, Object.fromEntries(VENDOR_FIELDS.map((k) => [k, img[k] ?? ''])));
        const back = memory.get(to) || {};
        for (const k of VENDOR_FIELDS) img[k] = back[k] ?? '';
        img.vendor = to;
        fill();
        paint();
        resetTest();
      },
      () => {
        const old = Object.fromEntries(['vendor', ...VENDOR_FIELDS].map((k) => [k, img[k]]));
        return () => {
          Object.assign(img, old);
          vendor.value = vendorOf();
          fill();
          paint();
          resetTest();
        };
      }
    );

    refreshImageProviders = () => {
      const opts = [['', 'Choose a provider…'], ...settings.providers.filter((p) => p.type === 'openai').map((p) => [p.id, p.name || 'Unnamed provider'])];
      if (img.providerId && !opts.some(([v]) => v === img.providerId)) {
        img.providerId = '';
        commit();
      }
      setOptions(imageProvider, opts, img.providerId);
      paint();
    };

    testBtn.addEventListener('click', async () => {
      const run = ++testRun;
      const say = (kind, text) => {
        if (run !== testRun) return;
        testMsg.hidden = false;
        testMsg.className = `test-result${kind ? ` ${kind}` : ''}`;
        testMsg.textContent = text;
      };
      const v = vendorOf();
      // OpenAI-compatible: the provider chosen here; the chat model: the one in the header.
      const prov = v === 'openai' ? settings.providers.find((p) => p.id === img.providerId) || null : activeProvider();
      if (specOf().byok && !String(img.apiKey || '').trim()) return say('error', 'Enter the API key first.');
      if (v === 'openai' && !prov) return say('error', 'Choose a provider first.');
      if (v === 'chat-model' && !prov) return say('error', 'Add a provider in Models & providers first.');
      testBtn.disabled = true;
      say('', 'Testing…');
      try {
        const m = await import('./image.js');
        if (typeof m.testImageVendor !== 'function') return say('error', 'Testing is not available in this version.');
        const r = await m.testImageVendor(img, prov, AbortSignal.timeout(20000));
        if (r?.ok) say('ok', `✓ ${String(r.info || 'Connected').replace(/^✓\s*/, '')}`);
        else say('error', errText(r?.error || 'The test failed.'));
      } catch (e) {
        say('error', errText(e));
      } finally {
        if (run === testRun) testBtn.disabled = false;
      }
    });

    const c = card('Image vendor', 'Where the agent gets its pictures from. Changes are saved as you make them.', { id: 'settingsImage' });
    c.append(field('Vendor', vendor), note, noProviders, providerField, apiField, keyField, modelField, sizeField, actions, testMsg);
    root.append(c, adv.root);

    refreshImageProviders();
    fill();
    return { onShow: () => refreshImageProviders() };
  }

  /* ---------- page: Behaviour ---------- */

  function buildBehaviour(root) {
    const approval = selectBox([['ask', 'Ask before acting'], ['auto', 'Act without asking']], settings.approval);
    approval.id = 'settingsApproval';
    bindSelect(settings, 'approval', approval);
    const toComputer = button('Computer tools approval ›', 'ghost');
    toComputer.id = 'settingsComputerApproval';
    toComputer.addEventListener('click', () => navigate('computer', { focus: '#companionApproval' }));
    const approvals = card('Approvals', 'Whether the agent waits for your OK before it changes pages or data.', { id: 'settingsApprovals' });
    const link = el('div', 'link-row');
    link.append(el('span', 'hint', 'Computer tools (commands, files, apps) have their own, stricter setting:'), toComputer);
    approvals.append(field('Approval', approval, 'Ask pauses for your OK before actions that change pages or data. You can also switch it under the message box.'), link);

    const queueMode = selectBox(QUEUE_MODES, settings.queueMode);
    // Not 'queueMode': the queue bar's select already has that id, and a duplicate would steal this label.
    queueMode.id = 'settingsQueueMode';
    bindSelect(settings, 'queueMode', queueMode);
    const queue = card('Queue', 'What happens when you send more prompts while one is running.', { id: 'settingsQueue' });
    queue.append(field('Queue mode', queueMode, 'You can also switch this from the queue bar in a chat.'));

    // 0 = no limit. Blank and negative values mean 0 too.
    const maxSteps = numberInput(settings.maxSteps, { min: 0, placeholder: '0' });
    maxSteps.id = 'maxSteps';
    onChange(
      maxSteps,
      () => {
        const v = Number(maxSteps.value.trim());
        settings.maxSteps = Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
        maxSteps.value = String(settings.maxSteps);
      },
      keep(settings, 'maxSteps', maxSteps)
    );
    const limits = card('Limits', 'How far the agent may go on one prompt before it stops by itself.', { id: 'settingsLimits' });
    limits.append(field('Max steps per prompt', maxSteps, '0 = no limit.'));

    const notifications = checkbox(settings.notifications);
    notifications.id = 'notifications';
    onChange(
      notifications,
      () => {
        settings.notifications = notifications.checked;
      },
      keep(settings, 'notifications', notifications, 'checked')
    );
    const notif = card('Notifications', 'Hear about the agent while the panel is closed.', { id: 'settingsNotifications' });
    notif.append(checkField('Desktop notifications', notifications, 'Approvals and finished jobs while the panel is closed.'));

    const vision = selectBox([['auto', 'Auto-detect'], ['on', 'On'], ['off', 'Off']], settings.vision);
    vision.id = 'settingsVision';
    bindSelect(settings, 'vision', vision);

    const toolMode = selectBox(
      [
        ['auto', 'Auto (native, fall back to prompted)'],
        ['native', 'Native'],
        ['prompt', 'Prompted (for models without tool support)'],
      ],
      settings.toolMode
    );
    toolMode.id = 'settingsToolMode';
    bindSelect(settings, 'toolMode', toolMode);

    const maxTokens = numberInput(settings.maxTokens, { min: 1, placeholder: 'Provider default' });
    maxTokens.id = 'settingsMaxTokens';
    bindNumber(settings, 'maxTokens', maxTokens, { blank: true, min: 1 });

    const model = card('Model options', 'How the agent talks to the model. The defaults suit most models.', { id: 'settingsModelOptions' });
    model.append(
      field('Vision', vision, 'Send screenshots and images to the model.'),
      field('Tool calling', toolMode, 'Prompted describes tools in the system prompt instead of using the API’s tool calling.'),
      field('Max output tokens', maxTokens, 'Blank = provider default.')
    );

    const customPrompt = textArea(settings.customPrompt, { rows: 4, placeholder: 'e.g. Reply in British English. Never submit payment forms.' });
    customPrompt.id = 'settingsCustomPrompt';
    bindText(settings, 'customPrompt', customPrompt);
    const custom = card('Your instructions', 'Rules in your own words that the agent follows on every request.', { id: 'settingsCustom' });
    custom.append(field('Custom instructions', customPrompt, 'Added to the system prompt on every request.'));

    /* advanced */
    const temperature = numberInput(settings.temperature, { min: 0, max: 2, step: 0.1, placeholder: 'Default' });
    temperature.id = 'settingsTemperature';
    bindNumber(settings, 'temperature', temperature, { blank: true, int: false, min: 0, max: 2 });

    const contextChars = numberInput(settings.contextChars, { min: 2000, step: 1000, placeholder: String(DEFAULTS.contextChars) });
    contextChars.id = 'settingsContextChars';
    bindNumber(settings, 'contextChars', contextChars, { min: 2000 });

    const maxToolChars = numberInput(settings.maxToolChars, { min: 2000, step: 500, placeholder: String(DEFAULTS.maxToolChars) });
    maxToolChars.id = 'settingsMaxToolChars';
    bindNumber(settings, 'maxToolChars', maxToolChars, { min: 2000 });

    const trusted = checkbox(settings.trustedInput);
    trusted.id = 'settingsTrustedInput';
    onChange(
      trusted,
      () => {
        settings.trustedInput = trusted.checked;
      },
      keep(settings, 'trustedInput', trusted, 'checked')
    );

    const adv = advanced('behaviourAdvanced');
    adv.body.append(
      el('p', 'hint', 'Change these only if you know you need to.'),
      field('Temperature', temperature, 'How adventurous the model is, 0 to 2. Blank = model default.'),
      row(field('Context budget (chars)', contextChars, 'Older history is trimmed to fit.'), field('Max tool output (chars)', maxToolChars, 'Longer tool results are cut.')),
      checkField(
        'Trusted input events',
        trusted,
        'Uses Chrome’s debugger for real mouse/keyboard events on sites that ignore synthetic ones. Chrome shows a debugging banner while active.'
      )
    );

    root.append(approvals, queue, limits, notif, model, custom, adv.root);
    return {};
  }

  /* ---------- page: Remote MCP servers ---------- */

  function buildMcp(root) {
    const mcpList = el('div', 'cards');
    mcpList.id = 'remoteMcpList';
    renderMcp = () => {
      mcpList.replaceChildren(...settings.mcpServers.map(mcpCard));
      if (!settings.mcpServers.length) mcpList.append(el('p', 'hint', 'No remote MCP servers yet.'));
    };

    function mcpCard(s) {
      const c = el('div', 'card');
      const name = textInput(s.name, 'text', 'e.g. github');
      bindText(s, 'name', name);
      const url = textInput(s.url, 'url', 'https://example.com/mcp');
      bindText(s, 'url', url);
      const headers = textArea(s.headers, { rows: 2, placeholder: 'Authorization: Bearer …', mono: true });
      bindText(s, 'headers', headers);
      const enabled = checkbox(s.enabled !== false);
      onChange(
        enabled,
        () => {
          s.enabled = enabled.checked;
        },
        () => {
          const old = s.enabled;
          return () => {
            s.enabled = old;
            enabled.checked = old !== false;
          };
        }
      );
      const remove = removeButton(() => {
        const i = settings.mcpServers.indexOf(s);
        if (i >= 0) settings.mcpServers.splice(i, 1);
        renderMcp();
        commit();
        addMcp.focus();
      });
      // The fields save on change, which fires on blur just before this click, so `s` is current.
      const test = mcpTestControls(kit, () => s);
      const actions = el('div', 'card-actions');
      actions.append(checkField('Enabled', enabled), test.button, remove);
      c.dataset.mcpCard = '';
      c.append(
        field('Name', name, 'Prefixes the tool names this server provides.'),
        field('URL', url),
        field('Headers', headers, 'One “Header: value” per line, e.g. Authorization: Bearer <token>.'),
        actions,
        test.result
      );
      return c;
    }

    const addMcp = button('Add MCP server');
    addMcp.id = 'remoteMcpAdd';
    addMcp.addEventListener('click', () => {
      settings.mcpServers.push({ id: newId(), name: '', url: '', headers: '', enabled: true });
      renderMcp();
      commit();
      mcpList.lastElementChild?.querySelector('input')?.focus();
    });

    renderMcp();
    const c = card('Your servers', 'Each server needs a name and its address. Use Test to check it and see its tools.', { id: 'settingsMcpServers' });
    c.append(mcpList, addMcp);
    root.append(c);
    return {};
  }

  /* ---------- page: About & help ---------- */

  const manifest = (() => {
    try {
      return chrome.runtime.getManifest() || {};
    } catch {
      return {};
    }
  })();
  const appName = manifest.name || 'Agent Automation';
  const version = manifest.version || '';

  function buildAbout(root) {
    const c = card('About', null, { id: 'settingsAboutCard' });
    c.append(el('p', 'about-name', `${appName} ${version}`.trim()), el('p', 'hint', 'Open source under the MIT licence.'));
    const help = card('Help and feedback', 'Read the guide, report a problem, or rate the project.', { id: 'settingsHelp' });
    const rate = repoLink('btn primary', '★ Rate on GitHub');
    const issues = repoLink('btn', 'Report an issue', '/issues');
    const guide = repoLink('btn', 'User guide', '/blob/main/docs/USER_GUIDE.md');
    if (rate && issues && guide) {
      const links = el('div', 'about-links');
      links.append(rate, issues, guide);
      help.append(links);
    } else help.append(el('p', 'hint', 'The project’s web address is not available in this build.'));
    root.append(c, help);
    return {};
  }

  /* ---------- page: Memory ---------- */

  const MEM_DEFAULT_CHARS = DEFAULTS.memory?.maxInjectChars ?? 4000;
  const scopeLabel = (scope) => (scope === 'global' ? 'Global' : scope);
  const memDate = (t) => {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  // The origin of the tab the user is looking at ('' when there is none or it is not a website).
  async function activeOrigin() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.url ? originOf(tab.url) || '' : '';
    } catch {
      return '';
    }
  }

  let memRefreshPill = () => {};

  function buildMemory(root) {
    let all = [];
    let loaded = false;
    let siteOrigin = '';

    const enabled = checkbox(settings.memory.enabled);
    enabled.id = 'memoryEnabled';
    onChange(
      enabled,
      () => {
        settings.memory.enabled = enabled.checked;
        memRefreshPill();
      },
      keep(settings.memory, 'enabled', enabled, 'checked', () => memRefreshPill())
    );

    const search = textInput('', 'search', 'Search memories');
    search.id = 'memorySearch';
    const scope = selectBox([['all', 'All']], 'all');
    scope.id = 'memoryScope';
    const msg = el('div', 'tools-msg memory-msg');
    msg.id = 'memoryMsg';
    msg.setAttribute('role', 'status');
    msg.hidden = true;
    const say = (text, kind = '') => {
      msg.className = `tools-msg memory-msg${kind ? ` ${kind}` : ''}`;
      msg.textContent = text || '';
      msg.hidden = !text;
    };
    const list = el('div', 'memory-list');
    list.id = 'memoryList';
    const empty = el('p', 'hint memory-empty', 'Nothing saved yet. The agent will add notes here when it learns something worth keeping.');
    empty.id = 'memoryEmpty';
    empty.hidden = true;
    const status = el('p', 'hint memory-status');
    status.id = 'memoryStatus';
    status.setAttribute('role', 'status');

    function memRow(m) {
      const r = el('div', 'memory-row');
      r.dataset.memoryId = m.id;
      const text = el('p', 'memory-text', m.text);
      text.title = m.text;
      const meta = el('div', 'memory-meta');
      meta.append(el('span', `memory-scope${m.scope === 'global' ? ' global' : ''}`, scopeLabel(m.scope)));
      const when = memDate(m.updatedAt || m.createdAt);
      if (when) meta.append(el('span', 'memory-date', when));
      if (m.source === 'user') meta.append(el('span', 'memory-date', 'you asked'));
      const del = confirmButton('Delete', 'Confirm', async () => {
        del.disabled = true;
        try {
          await memStore.delete(m.id);
          all = all.filter((x) => x.id !== m.id);
          say('');
          const hadFocus = r.contains(document.activeElement);
          render();
          memCountChanged();
          if (hadFocus) search.focus();
        } catch (e) {
          del.disabled = false;
          say(`Could not delete that memory: ${errText(e)}`, 'error');
        }
      });
      del.dataset.role = 'delete';
      del.setAttribute('aria-label', `Delete memory: ${m.text.slice(0, 60)}`);
      r.append(text, meta, del);
      return r;
    }

    const clearSite = confirmButton('Clear this site', 'Confirm clear', () => doClear({ scope: siteOrigin }, `Cleared the memories for ${siteOrigin}.`));
    clearSite.id = 'memoryClearSite';
    clearSite.hidden = true;
    const clearAll = confirmButton('Clear all', 'Confirm clear all', () => doClear({}, 'Cleared all memories.'));
    clearAll.id = 'memoryClearAll';

    async function doClear(arg, done) {
      try {
        await memStore.clear(arg);
        say(done, 'ok');
      } catch (e) {
        say(`Could not clear: ${errText(e)}`, 'error');
      }
      await load(true);
    }

    // Rebuilds the scope filter from the loaded list, keeping the choice when it still exists.
    function paintScopes() {
      const keep = scope.value;
      const sites = [...new Set(all.map((m) => m.scope).filter((x) => x && x !== 'global'))].sort();
      setOptions(scope, [['all', 'All'], ['global', 'Global'], ...sites.map((o) => [o, o])], keep);
      if (scope.value !== keep) scope.value = 'all';
    }

    function render() {
      paintScopes();
      const q = search.value.trim().toLowerCase();
      const sc = scope.value;
      const shown = all.filter((m) => (sc === 'all' || m.scope === sc) && (!q || String(m.text).toLowerCase().includes(q)));
      // Global first, then each site; newest first inside a group (the store already sorts by newest).
      const groups = [...new Set(shown.map((m) => m.scope))].sort((a, b) => (a === 'global' ? -1 : b === 'global' ? 1 : a.localeCompare(b)));
      const nodes = [];
      for (const g of groups) {
        const h = el('h4', 'memory-group', scopeLabel(g));
        h.dataset.scope = g;
        nodes.push(h, ...shown.filter((m) => m.scope === g).map(memRow));
      }
      list.replaceChildren(...nodes);
      empty.hidden = !loaded || all.length > 0;
      list.hidden = !shown.length;
      status.hidden = !loaded || !all.length || !!shown.length;
      status.textContent = 'No memories match.';
      clearAll.disabled = !all.length;
      const hasSite = !!siteOrigin && all.some((m) => m.scope === siteOrigin);
      clearSite.hidden = !hasSite;
      if (hasSite) clearSite.title = `Delete the memories saved for ${siteOrigin}`;
    }

    function memCountChanged() {
      live.memCount = all.length;
      memRefreshPill();
    }

    async function load(quiet = false) {
      if (!quiet) {
        loaded = false;
        list.replaceChildren();
        empty.hidden = true;
        status.hidden = false;
        status.textContent = 'Loading…';
      }
      siteOrigin = await activeOrigin();
      try {
        const items = await memStore.list();
        all = Array.isArray(items) ? items : [];
        loaded = true;
        live.memCount = all.length;
        memRefreshPill();
        if (!quiet) say('');
      } catch (e) {
        all = [];
        loaded = true;
        say(`Could not read the saved memories: ${errText(e)}`, 'error');
      }
      render();
    }

    search.addEventListener('input', render);
    scope.addEventListener('change', render);

    const maxInject = numberInput(settings.memory.maxInjectChars, { min: 0, step: 500, placeholder: String(MEM_DEFAULT_CHARS) });
    maxInject.id = 'memoryMaxInject';
    onChange(
      maxInject,
      () => {
        const raw = maxInject.value.trim();
        const v = raw === '' ? NaN : Number(raw);
        settings.memory.maxInjectChars = Number.isFinite(v) ? Math.max(0, Math.round(v)) : MEM_DEFAULT_CHARS;
        maxInject.value = String(settings.memory.maxInjectChars);
      },
      keep(settings.memory, 'maxInjectChars', maxInject)
    );

    const saved = card('Saved memories', 'Notes the agent keeps between chats. Delete any you do not want it to use.', { id: 'settingsMemory' });
    const filters = el('div', 'memory-filters');
    filters.append(field('Search', search), field('Show', scope));
    const actions = el('div', 'card-actions memory-actions');
    actions.append(clearSite, clearAll);
    saved.append(checkField('Use saved memories', enabled, 'When off, the agent is not shown what it saved. Nothing is deleted.'), filters, msg, status, empty, list, actions);

    const adv = advanced('memoryAdvanced');
    adv.body.append(field('How much to include', maxInject, 'Characters of saved memory added to each request. 0 turns injection off without deleting anything.'));

    root.append(saved, adv.root);
    return { onShow: () => load() };
  }

  /* ---------- pages ---------- */

  const home = el('div', 'settings-home');
  home.id = 'settingsHome';
  const page = el('div', 'settings-page');
  page.id = 'settingsPage';
  page.hidden = true;

  const areas = new Map(); // key → { root, api }
  const failBox = (e) => {
    const box = el('div', 'tools-msg error render-error');
    box.setAttribute('role', 'alert');
    box.textContent = `This section could not be displayed: ${errText(e)}`;
    return box;
  };

  // Remote access follows the companion connection that Computer tools makes, so it is built first.
  let computer = null; // { root, recheck(), onShow() }
  const builders = {
    models: buildModels,
    images: buildImages,
    behaviour: buildBehaviour,
    memory: buildMemory,
    computer: (root) => {
      computer = computerToolsSection(settings, kit, { ...(remote?.hooks || {}), onCheck: companionChecked });
      root.append(computer.root);
      return computer;
    },
    remote: (root) => {
      root.append(remote.root);
      return remote;
    },
    mcp: (root) => {
      const body = el('div', 'area-body');
      body.id = 'remoteMcp';
      root.append(body);
      return buildMcp(body);
    },
    about: buildAbout,
  };

  try {
    remote = remoteAccessSection(settings, kit, { onTunnel: tunnelChanged });
  } catch (e) {
    remote = { failed: e };
  }

  for (const sec of SECTIONS) {
    const root = el('section', 'settings-area');
    root.dataset.area = sec.key;
    root.hidden = true;
    root.setAttribute('aria-label', sec.name);
    const intro = el('div', 'area-intro');
    const introIcon = el('span', 'area-icon');
    introIcon.append(icon(sec.icon));
    const introText = el('div', 'area-intro-text');
    introText.append(el('div', 'area-intro-label', 'What this does'), el('p', null, sec.intro));
    intro.append(introIcon, introText);
    root.append(intro);
    let api = {};
    try {
      if (sec.key === 'remote' && remote?.failed) throw remote.failed;
      api = builders[sec.key](root) || {};
    } catch (e) {
      root.append(failBox(e));
      api = { failed: e };
    }
    areas.set(sec.key, { root, api });
    page.append(root);
  }
  if (remote?.failed) remote = null;

  /* ---------- home ---------- */

  const cards = new Map(); // key → { btn, pill }
  const nav = el('div', 'settings-cards');
  nav.setAttribute('role', 'list');
  nav.setAttribute('aria-label', 'Settings areas');
  for (const sec of SECTIONS) {
    const b = el('button', 'settings-card');
    b.type = 'button';
    b.dataset.section = sec.key;
    b.setAttribute('role', 'listitem');
    const ic = el('span', 'settings-card-icon');
    ic.append(icon(sec.icon));
    const txt = el('span', 'settings-card-text');
    const p = pill('…', 'off');
    p.dataset.role = 'pill';
    txt.append(el('span', 'settings-card-name', sec.name), el('span', 'settings-card-purpose', sec.purpose), p);
    b.append(ic, txt, icon('chevron', 'settings-card-chev'));
    b.addEventListener('click', () => show(sec.key));
    cards.set(sec.key, { btn: b, pill: p });
    nav.append(b);
  }

  // Getting started.
  const start = el('section', 'set-card gs-card');
  start.id = 'settingsStart';
  const startHead = el('div', 'gs-head');
  startHead.append(icon('start', 'gs-icon'), el('h3', 'set-card-title', 'Getting started'));
  const startSteps = el('div', 'steps gs-steps');
  const gs1 = step({ n: 1, title: 'Connect a model' });
  const gs1Text = el('p', 'hint');
  const gs1Btn = button('Open Models & providers', 'primary');
  gs1Btn.dataset.role = 'start-models';
  gs1Btn.addEventListener('click', () => show('models'));
  gs1.body.append(gs1Text, gs1Btn);
  const gs2 = step({ n: 2, title: 'Try a task' });
  const gs2Btn = button('Go to the chat');
  gs2Btn.dataset.role = 'start-chat';
  gs2Btn.addEventListener('click', () => onClose?.());
  gs2.body.append(el('p', 'hint', 'Close Settings and ask the agent to do something on the page beside it, for example “Summarise this page”.'), gs2Btn);
  const gs3 = step({ n: 3, title: 'Optional: computer tools, remote access' });
  const gs3Btns = el('div', 'tools-actions');
  const gs3a = button('Computer tools');
  gs3a.dataset.role = 'start-computer';
  gs3a.addEventListener('click', () => show('computer'));
  const gs3b = button('Remote access');
  gs3b.dataset.role = 'start-remote';
  gs3b.addEventListener('click', () => show('remote'));
  gs3Btns.append(gs3a, gs3b);
  gs3.body.append(el('p', 'hint', 'Let the agent use this computer (commands, files, apps), or use your local models from another device.'), gs3Btns);
  startSteps.append(gs1.root, gs2.root, gs3.root);
  start.append(startHead, startSteps);

  home.append(start, nav, el('p', 'hint settings-note', 'Changes are saved automatically.'));
  container.replaceChildren(notice, home, page);

  /* --- live state for the pills --- */

  const companionKey = () => `${settings.companion.url}|${settings.companion.token}`;
  let checking = false;

  function companionChecked(info) {
    checking = info.phase === 'checking';
    if (!checking) live.companion = { ...info, key: companionKey(), at: Date.now() };
    if (!home.hidden) paintHome({ recheck: false });
  }

  function tunnelChanged(t) {
    live.tunnel = t ? { state: t.state, key: companionKey(), at: Date.now() } : null;
    if (!home.hidden) paintHome({ recheck: false });
  }

  // The last companion check for the current address and token, while it is fresh.
  const companionInfo = () => {
    const i = live.companion;
    return i && i.key === companionKey() && Date.now() - i.at < COMPANION_TTL ? i : null;
  };

  function companionPill() {
    const c = settings.companion;
    if (!c.enabled) return c.token ? ['Switched off', 'off'] : ['Not set up', 'off'];
    if (!c.token) return ['Not set up', 'warn'];
    const i = companionInfo();
    if (!i || checking) return ['Checking…', 'info'];
    switch (i.phase) {
      case 'ok':
        return [`Connected · ${plural(i.tools || 0, 'tool')}`, 'ok'];
      case 'down':
      case 'timeout':
        return ['Not running', 'warn'];
      case 'token':
        return ['Wrong token', 'error'];
      case 'notoken':
        return ['Not set up', 'warn'];
      default:
        return ['Error', 'error'];
    }
  }

  const companionOk = () => settings.companion.enabled && !!settings.companion.token && companionInfo()?.phase === 'ok' && !checking;

  function remotePill() {
    const c = settings.companion;
    if (c.enabled && c.token && (checking || !companionInfo())) return ['Checking…', 'info'];
    if (!companionOk()) return ['Needs computer tools', 'off'];
    const t = live.tunnel && live.tunnel.key === companionKey() ? live.tunnel.state : 'stopped';
    if (t === 'running') return ['Running', 'ok'];
    if (t === 'starting' || t === 'downloading') return ['Starting…', 'info'];
    if (t === 'error') return ['Error', 'error'];
    return ['Stopped', 'off'];
  }

  const PILLS = {
    models: () => {
      const p = activeProvider();
      if (!p) return ['No provider', 'warn'];
      if (!p.model) return ['No model chosen', 'warn'];
      const label = `${p.name || 'Unnamed provider'} · ${p.model}`;
      return checkOf(p)?.state === 'error' ? [`${label} · not reachable`, 'error'] : [label, 'ok'];
    },
    images: () => {
      const img = settings.image || {};
      const v = imageVendorOf(img);
      if (v === 'none') return ['Off', 'off'];
      const label = IMAGE_VENDORS[v].label || v;
      const model = String(img.model || '').trim();
      // Green once it can work: a provider and a model, or a key. Amber while something is still missing.
      if (v === 'openai') {
        const p = img.providerId && settings.providers.find((x) => x.id === img.providerId);
        return [[p ? p.name || 'Unnamed provider' : label, model].filter(Boolean).join(' · '), p && model ? 'ok' : 'warn'];
      }
      if (v === 'chat-model') return [label, 'ok'];
      return [model ? `${label} · ${model}` : label, String(img.apiKey || '').trim() ? 'ok' : 'warn'];
    },
    behaviour: () => {
      const n = Number(settings.maxSteps) || 0;
      const steps = n > 0 ? `max ${plural(n, 'step')}` : 'no step limit';
      return settings.approval === 'auto' ? [`Act without asking · ${steps}`, 'warn'] : [`Ask before acting · ${steps}`, 'info'];
    },
    memory: () => {
      if (!settings.memory.enabled) return ['Off', 'off'];
      return [live.memCount == null ? 'On' : `On · ${live.memCount} saved`, 'ok'];
    },
    computer: companionPill,
    remote: remotePill,
    mcp: () => {
      const all = settings.mcpServers || [];
      const on = all.filter((s) => s && s.enabled !== false).length;
      if (!all.length) return ['None', 'off'];
      if (!on) return ['All switched off', 'off'];
      return [plural(on, 'server'), 'ok'];
    },
    about: () => [version ? `Version ${version}` : 'Version unknown', 'off'],
  };

  memRefreshPill = () => {
    const c = cards.get('memory');
    if (!c) return;
    const [text, state] = PILLS.memory();
    setPill(c.pill, text, state);
  };

  function modelReady() {
    const p = activeProvider();
    if (!p || !p.model) return false;
    const r = checkOf(p);
    return r ? r.state === 'ok' : (p.models?.length || 0) > 0;
  }

  // `fold`: also decide which steps are folded. Only done when the home page is shown, so a late answer (the chat
  // check, the companion check) never moves the cards under the pointer.
  function paintStart(fold) {
    const p = activeProvider();
    const one = modelReady();
    gs1Text.textContent = !settings.providers.length
      ? 'Add a model server or an online service, then click Test connection to load its models.'
      : !p?.model
        ? `Click Test connection on “${p?.name || 'your provider'}” to load its models, then pick one in the header.`
        : `“${p.name || 'Your provider'}” has not answered yet. Start it, or click Test connection to check it.`;
    gs1.set({ done: one, current: !one, summary: one ? `Using ${p.name || 'your provider'} · ${p.model}` : '' });
    const two = live.chats === true;
    gs2.set({ done: two, current: one && !two, summary: two ? 'You have already given the agent a task.' : '' });
    const three = companionOk();
    gs3.set({ done: three, current: one && two && !three, summary: three ? 'Computer tools are connected.' : '' });
    if (fold) {
      gs1.setOpen(!one);
      gs2.setOpen(!two);
      gs3.setOpen(!three);
    }
    start.dataset.done = String(one && two);
  }

  function paintHome({ recheck = true } = {}) {
    // Whether a chat exists: answered at once when the panel knows (a boolean), otherwise later (a promise).
    let pending = null;
    if (recheck && live.chats !== true && hasChats) {
      try {
        const v = hasChats();
        if (typeof v === 'boolean') live.chats = v;
        else pending = v;
      } catch {}
    }
    for (const sec of SECTIONS) {
      const c = cards.get(sec.key);
      try {
        const [text, state] = PILLS[sec.key]();
        setPill(c.pill, text, state);
      } catch {
        setPill(c.pill, 'Unavailable', 'error');
      }
    }
    if (recheck && settings.memory.enabled) {
      Promise.resolve()
        .then(() => memStore.list())
        .then(
          (items) => {
            live.memCount = Array.isArray(items) ? items.length : null;
            memRefreshPill();
          },
          () => {}
        );
    }
    try {
      paintStart(recheck);
    } catch (e) {
      start.replaceChildren(startHead, failBox(e));
    }
    if (!recheck) return;
    // A stale (or missing) companion check is done again; the pills say "Checking…" meanwhile.
    const c = settings.companion;
    if (c.enabled && c.token && !checking && !companionInfo() && computer?.recheck) {
      try {
        computer.recheck();
      } catch {}
    }
    if (pending) {
      Promise.resolve(pending).then(
        (v) => {
          live.chats = !!v;
          if (!home.hidden) paintHome({ recheck: false });
        },
        () => {}
      );
    }
  }

  /* --- navigation --- */

  let current = 'home';
  let homeScroll = 0;

  function show(key, { focus = true, focusSel = '' } = {}) {
    if (key !== 'home' && !areas.has(key)) key = 'home';
    const prev = current;
    // Leaving a page: a field being edited fires its change event (and saves) first.
    const a = document.activeElement;
    if (a && a !== document.body && container.contains(a) && key !== prev) a.blur();
    if (prev === 'home' && key !== 'home') homeScroll = container.scrollTop;
    current = key;
    home.hidden = key !== 'home';
    page.hidden = key === 'home';
    if (key === 'home') delete page.dataset.section;
    else page.dataset.section = key;
    for (const [k, x] of areas) x.root.hidden = k !== key;
    notice.hidden = true;
    const shown = key === 'home' ? home : areas.get(key).root;
    shown.classList.remove('enter');
    void shown.offsetWidth;
    if (key !== prev) shown.classList.add('enter');
    try {
      if (key === 'home') paintHome();
      else areas.get(key).api.onShow?.();
    } catch (e) {
      if (key !== 'home') areas.get(key).root.append(failBox(e));
    }
    container.scrollTop = key === 'home' ? homeScroll : 0;
    try {
      onNavigate?.({ section: key, title: key === 'home' ? 'Settings' : SECTION[key].name, focus: focus && key !== 'home' });
    } catch {}
    if (key === 'home' && focus && prev !== 'home') cards.get(prev)?.btn.focus();
    if (key !== 'home' && focusSel) {
      const t = areas.get(key).root.querySelector(focusSel);
      if (t && !t.closest('[hidden]')) {
        t.scrollIntoView?.({ block: 'center' });
        t.focus();
      }
    }
    return key;
  }
  navigate = (key, o = {}) => show(key, { focusSel: o.focus || '' });

  for (const sec of SECTIONS) {
    const root = areas.get(sec.key).root;
    root.addEventListener('animationend', () => root.classList.remove('enter'));
  }
  home.addEventListener('animationend', () => home.classList.remove('enter'));

  show(opts.section || 'home', { focus: false });

  return {
    show: (key, o) => show(key, o),
    get section() {
      return current;
    },
    refresh: () => !home.hidden && paintHome(),
  };
}

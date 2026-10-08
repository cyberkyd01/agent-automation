// The agent engine: every open chat session with its Agent, queue, transcript view and saving, independent of
// any side panel. Panels connect over a runtime port named 'panel' (protocol: PROTOCOL.md next to this file);
// all of them show the same chats and receive the same events, and a job keeps running when none is open.
// It does not care how it was started: Chrome runs it in the offscreen document with the rpc api, Firefox in
// the background page with the direct one.
import { Agent } from '../agent.js';
import { assetBlob } from '../files.js';
import { TO_ENGINE } from '../host/api.js';
import { stripToolCalls } from '../markdown.js';
import { originOf } from '../memory.js';
import { newSession, store, titleFrom } from '../sessions.js';
import { loadSettings, syncOriginRules } from '../storage.js';
import { newId, safeParse, sleep, splitThink } from '../util.js';

export const PORT_NAME = 'panel';

const SAVE_DELAY = 300;
const STORE_TIMEOUT = 10000; // a storage call slower than this is reported, never waited on forever
const STREAM_MS = 50; // streamed text goes to the panels at most this often
const KEEPALIVE_MS = 20000; // Chrome stops an idle service worker after 30 s
const PANEL_DELAY = 50;
const TOOL_TEXT_LIMIT = 4000;
const ARGS_LIMIT = 64 * 1024;
const DEFAULT_TITLE = 'New chat';
const ICON = 'icons/icon128.png';

export function startEngine({ api, keepAlive } = {}) {
  if (!api) throw new Error('startEngine needs an api.');
  const engine = new Engine(api, { keepAlive });
  engine.start();
  return engine;
}

/* ---------- small helpers ---------- */

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
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '');
const capText = (t) => (t.length > TOOL_TEXT_LIMIT ? `${t.slice(0, TOOL_TEXT_LIMIT)}\n… (${t.length - TOOL_TEXT_LIMIT} more characters)` : t);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '');
// History doesn't record failure explicitly; these are the agent's error/denial/cancel replies.
const toolFailed = (m) => /^(error\b|cancelled\.|stopped by the user|the user denied)/i.test(String(m.content ?? ''));

// Would an assistant bubble with this text show anything (text or thinking)?
function visible(content, reasoning) {
  const { body, think } = splitThink(stripToolCalls(content));
  return Boolean(body.trim() || stripToolCalls(reasoning).trim() || think);
}

// Tool arguments as the panel shows them: parsed when they are JSON; a huge value only as capped text.
function argsOut(args) {
  const v = typeof args === 'string' ? (safeParse(args, null) ?? args) : args;
  let size = 0;
  try {
    size = typeof v === 'string' ? v.length : JSON.stringify(v ?? {}).length;
  } catch {
    return '';
  }
  return size > ARGS_LIMIT ? capText(pretty(v)) : v ?? {};
}

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

const cleanIds = (ids) => (Array.isArray(ids) ? [...new Set(ids.map((x) => String(x).toLowerCase()).filter(Boolean))] : []);

function userText(m) {
  if (typeof m._text === 'string') return m._text;
  let raw = textOf(m.content);
  const i = raw.lastIndexOf('<context>');
  if (i >= 0 && /<\/context>\s*$/.test(raw)) raw = raw.slice(0, i);
  return raw.trim();
}

// One line for a notification: "click · id 12" style, like the panel's tool card summary.
function argLine(args) {
  if (args == null || args === '') return '';
  if (typeof args !== 'object') return clip(String(args).replace(/\s+/g, ' '), 120);
  const parts = Object.entries(args)
    .filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ').trim()}`);
  return clip(parts.join(' · '), 160);
}

/* ---------- the engine ---------- */

class Engine {
  constructor(api, { keepAlive } = {}) {
    this.api = api;
    this.keepAliveFn = keepAlive;
    this.settings = {};
    this.settingsLoad = Promise.resolve();
    this.lastApproval = null;
    this.sessions = new Map(); // id → session, in tab order
    this.activeId = '';
    this.ports = new Set();
    this.ready = false;
    this.boot = null;
    this.panelTimer = 0;
    this.keepTimer = 0;
    this.badge = '';
  }

  start() {
    const rt = this.api.runtime;
    // Registered at once: a panel may connect while the chats are still being restored.
    rt.onConnect.addListener((port) => {
      if (port.name === PORT_NAME) this.connect(port);
    });
    rt.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.to !== TO_ENGINE || msg.op !== 'ping') return;
      reply({ ready: this.ready });
    });
    this.api.events.on('storage.changed', (changes, area) => {
      if (area === 'local' && changes?.settings) this.reloadSettings().catch(() => {});
    });
    this.api.events.on('notifications.clicked', (id) => this.onNotification(id, null));
    this.api.events.on('notifications.buttonClicked', (id, index) => this.onNotification(id, index));
    this.boot = this.restore()
      .catch((e) => {
        console.error('Could not restore the open chats', e);
        if (!this.sessions.size) this.newTab();
      })
      .finally(() => {
        this.ready = true;
      });
    this.api.action.setBadgeText({ text: '' }).catch(() => {});
  }

  /* ----- settings ----- */

  // Updates the shared settings object in place, so a running job sees changes (approval mode, limits) at once.
  reloadSettings() {
    this.settingsLoad = this.settingsLoad.then(async () => {
      const fresh = await loadSettings();
      const s = this.settings;
      for (const k of Object.keys(s)) if (!(k in fresh)) delete s[k];
      Object.assign(s, fresh);
      if (s.approval !== this.lastApproval) {
        // Switching the approval mode cancels "Allow all (this chat)".
        if (this.lastApproval != null) for (const x of this.sessions.values()) x.agent.autoApprove = false;
        this.lastApproval = s.approval;
      }
    });
    return this.settingsLoad;
  }

  queueMode() {
    return this.settings?.queueMode === 'step' ? 'step' : 'auto';
  }

  modelProblem() {
    const ps = this.settings.providers || [];
    const p = ps.find((x) => x.id === this.settings.activeProviderId) || ps[0] || null;
    if (!p) return 'Add a model provider in Settings first.';
    if (!p.model) return 'Choose a model first: reload the list or pick “Custom model ID…”.';
    return '';
  }

  /* ----- start-up ----- */

  async restore() {
    await this.reloadSettings().catch((e) => console.warn('Could not load settings', e));
    syncOriginRules(this.settings).catch(() => {});
    let state = {};
    try {
      ({ panel: state = {} } = (await this.api.storage.local.get('panel')) || {});
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
      this.status(`Could not restore the chat from the previous version: ${errText(e)}`, 'error');
    }
    let metas = null;
    try {
      metas = await withTimeout(store.list(), STORE_TIMEOUT);
    } catch (e) {
      this.status(failText('Could not load saved chats', e), 'error');
    }
    const byId = new Map((metas || []).map((m) => [m.id, m]));
    open = [...new Set(open)].filter((id) => !metas || byId.has(id));
    for (const id of open) this.createSession(byId.get(id) || { id, title: 'Chat' }, { stored: true, ready: false });
    const first = this.sessions.get(activeId) || [...this.sessions.values()].at(-1);
    if (!first) {
      this.newTab();
      return;
    }
    this.activeId = first.id;
    // The chat a panel will show first is loaded right away; the others when they are opened.
    await this.hydrate(first);
  }

  /* ----- panels ----- */

  connect(port) {
    this.ports.add(port);
    port.onDisconnect.addListener(() => {
      void this.api.runtime.lastError;
      this.ports.delete(port);
      // Nobody is looking any more: pending approvals become desktop notifications.
      if (!this.ports.size) for (const s of this.sessions.values()) for (const ap of s.approvals.values()) this.notifyApproval(ap);
    });
    port.onMessage.addListener((m) => {
      this.boot.then(() => this.command(port, m));
    });
    // A panel is open: approvals are answered there.
    for (const s of this.sessions.values()) for (const ap of s.approvals.values()) this.clearNotification(ap);
  }

  post(port, msg) {
    try {
      port.postMessage(msg);
    } catch {
      this.ports.delete(port);
    }
  }

  broadcast(msg) {
    for (const p of [...this.ports]) this.post(p, msg);
  }

  status(text, kind = 'info') {
    this.broadcast({ t: 'status', text, kind });
  }

  async command(port, m) {
    if (!m || typeof m.t !== 'string') return;
    const fn = COMMANDS[m.t];
    let value;
    let error = null;
    try {
      if (!fn) throw new Error(`Unknown command "${m.t}".`);
      value = await fn.call(this, m, port);
    } catch (e) {
      error = e || new Error('Unknown error');
      if (!m.rid) console.warn(`Panel command ${m.t} failed`, e);
    }
    if (m.rid) this.post(port, error ? { t: 'reply', rid: m.rid, ok: false, error: errText(error) } : { t: 'reply', rid: m.rid, ok: true, value: value ?? null });
  }

  snapshot(port) {
    const drafts = {};
    for (const s of this.sessions.values()) if (s.draft.text || s.draft.pending.length) drafts[s.id] = s.draft;
    this.post(port, { t: 'snapshot', activeId: this.activeId, sessions: [...this.sessions.values()].map((s) => this.stateOf(s)), drafts, settingsNotice: null });
    for (const s of this.sessions.values()) if (s.ready) this.post(port, this.itemsMsg(s));
  }

  stateOf(s) {
    return {
      id: s.id,
      meta: s.meta,
      stored: s.stored,
      ready: s.ready,
      loadError: s.loadError,
      running: s.running,
      asking: s.asking,
      queue: s.queue,
      notes: s.notes,
      paused: s.paused,
      drain: s.drain,
      saveError: s.saveError,
      closeBlocked: s.closeBlocked,
    };
  }

  emitState(s) {
    if (!s.closed) this.broadcast({ t: 'state', s: this.stateOf(s) });
  }

  emitSessions() {
    this.broadcast({ t: 'sessions', sessions: [...this.sessions.values()].map((s) => this.stateOf(s)), activeId: this.activeId });
  }

  itemsMsg(s) {
    return { t: 'items', sid: s.id, items: s.items, assets: [...s.agent.assets.values()].map((a) => this.assetMeta(s, a)) };
  }

  persistPanel() {
    clearTimeout(this.panelTimer);
    this.panelTimer = setTimeout(() => {
      this.panelTimer = 0;
      this.api.storage.local.set({ panel: { open: [...this.sessions.keys()], active: this.activeId } }).catch((e) => console.warn('Could not save open tabs', e));
    }, PANEL_DELAY);
  }

  /* ----- sessions ----- */

  need(id) {
    const s = this.sessions.get(String(id));
    if (!s || s.closed) throw new Error('That chat is not open.');
    return s;
  }

  // The panel's window and page travel with its commands: the job works in that window.
  touch(s, port, m) {
    if (port?.windowId != null) s.windowId = port.windowId;
    if (m?.page && typeof m.page === 'object') s.page = { url: String(m.page.url || ''), title: String(m.page.title || '') };
  }

  createSession(meta, { stored = false, ready = false } = {}) {
    const s = {
      id: String(meta.id),
      meta: pickMeta(meta),
      stored, // exists in the store
      ready, // history loaded (or a fresh chat)
      loading: null,
      loadError: null,
      renamed: false,
      muted: false, // ignore agent hooks (while importing or after closing)
      queue: [],
      notes: '', // per-chat progress log (round-trips with the session body)
      paused: false,
      drain: false, // "Run all remaining" in step mode
      running: false,
      stopRequested: false,
      afterStop: null, // a fresh instruction sent while a Stop was still unwinding; runs next
      runPromise: Promise.resolve(),
      items: [],
      itemSeq: 0,
      live: new Set(), // items still streaming or running
      approvals: new Map(), // tool item id → pending approval
      asking: 0,
      dirty: false,
      saveTimer: 0,
      saving: Promise.resolve(),
      saveError: null,
      closeBlocked: false,
      assetBacklog: new Map(), // assets not yet written to the store
      urls: new Map(), // Blob → object URL handed to the panels
      draft: { text: '', pending: [] },
      windowId: null,
      page: null,
      closed: false,
      closing: false,
    };
    s.agent = new Agent(this.uiFor(s), {
      onChange: () => !s.muted && this.scheduleSave(s),
      onAsset: (a) => !s.muted && this.onAsset(s, a),
    });
    s.agent.autoApprove = false;
    this.sessions.set(s.id, s);
    return s;
  }

  // id: the panel may choose it (a fresh UUID), so it can show the tab before the engine answers.
  newTab(id) {
    const fresh = typeof id === 'string' && /^[\w-]{8,64}$/.test(id) && !this.sessions.has(id) ? { id } : {};
    const s = this.createSession(newSession(fresh), { stored: false, ready: true });
    this.activeId = s.id;
    this.emitSessions();
    this.broadcast(this.itemsMsg(s));
    this.persistPanel();
    return s;
  }

  // A brand-new chat nobody has touched: replacing it loses nothing.
  isPristine(s) {
    return !s.stored && s.ready && !s.running && !s.agent.messages.length && !s.queue.length && !s.draft.pending.length && !(s.draft.text || '').trim();
  }

  hydrate(s) {
    if (s.ready) return Promise.resolve();
    if (s.loading) return s.loading;
    s.loadError = null;
    s.loading = (async () => {
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
        s.loading = null;
        if (s.closed) return;
        s.loadError = { text: failText('Could not open this chat', e), retry: true };
        this.emitState(s);
        return;
      }
      if (s.closed) return;
      s.loading = null;
      if (!data) {
        s.stored = false;
        s.loadError = { text: 'This chat is no longer saved — it may have been deleted in another window.', retry: false };
        this.emitState(s);
        return;
      }
      this.applyLoaded(s, data, assets);
      if (assetError) this.addNotice(s, `Some files of this chat could not be loaded: ${errText(assetError)}`, 'error');
    })();
    this.emitState(s);
    return s.loading;
  }

  applyLoaded(s, data, assets) {
    s.meta = pickMeta({ ...data, id: s.id });
    s.renamed = s.meta.title !== DEFAULT_TITLE;
    s.muted = true;
    this.revokeUrls(s);
    try {
      s.agent.importMessages(Array.isArray(data.messages) ? data.messages : [], Array.isArray(assets) ? assets : []);
    } catch (e) {
      console.warn('Could not restore chat', e);
    } finally {
      s.muted = false;
    }
    s.queue = cleanQueue(data.queue);
    s.notes = typeof data.notes === 'string' ? data.notes : '';
    s.paused = s.queue.length > 0; // a restored queue never starts by itself
    s.drain = false;
    s.stored = true;
    s.ready = true;
    s.loadError = null;
    this.buildItems(s);
    if (s.agent.canResume) this.pushItem(s, { type: 'notice', text: 'This chat was interrupted.', kind: 'info', actions: [{ label: 'Continue', id: 'continue' }] });
    this.broadcast(this.itemsMsg(s));
    this.emitState(s);
  }

  async closeSession(s, { save = true } = {}) {
    if (s.closed || s.closing) return false;
    s.closing = true;
    try {
      if (s.running) {
        this.stopSession(s);
        await Promise.race([s.runPromise, sleep(2000)]);
      }
      if (save && s.ready) {
        // persist() times out its own storage calls, so this can't hang the close.
        await this.saveNow(s);
        if (s.dirty && !s.saveError) await this.saveNow(s); // a change that landed during the first write
        if (s.saveError) {
          // Never drop a chat that isn't safely stored.
          s.closeBlocked = true;
          this.emitState(s);
          return false;
        }
      }
    } finally {
      s.closing = false;
    }
    s.closed = true;
    s.afterStop = null;
    s.muted = true;
    clearTimeout(s.saveTimer);
    for (const ap of [...s.approvals.values()]) ap.cleanup();
    try {
      s.agent.stop();
      s.agent.reset(); // releases MCP connections
    } catch {}
    this.revokeUrls(s);
    // Files attached to a draft that was never saved.
    if (!s.stored) store.delete(s.id).catch(() => {});
    const ids = [...this.sessions.keys()];
    const i = ids.indexOf(s.id);
    this.sessions.delete(s.id);
    if (this.activeId === s.id) this.activeId = (this.sessions.get(ids[i + 1]) || this.sessions.get(ids[i - 1]))?.id || '';
    if (!this.sessions.size) this.newTab();
    else this.emitSessions();
    this.updateBadge();
    this.persistPanel();
    return true;
  }

  async renameChat(id, title) {
    const name = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new Error('The chat needs a name.');
    const s = this.sessions.get(id);
    if (s) {
      s.meta.title = name;
      s.renamed = true;
      this.emitState(s);
      // Not stored yet: the first save carries the title.
      if (!s.stored) return;
    }
    await store.rename(id, name);
  }

  /* ----- transcript items ----- */

  pushItem(s, item) {
    item.id = `i${++s.itemSeq}`;
    s.items.push(item);
    return item;
  }

  addItem(s, item) {
    this.pushItem(s, item);
    this.emitItem(s, item);
    return item;
  }

  emitItem(s, item) {
    if (!s.closed && s.items.includes(item)) this.broadcast({ t: 'item', sid: s.id, item });
  }

  removeItem(s, item) {
    const i = s.items.indexOf(item);
    if (i < 0) return;
    s.items.splice(i, 1);
    s.live.delete(item);
    this.broadcast({ t: 'itemRemoved', sid: s.id, id: item.id });
  }

  addNotice(s, text, kind = 'info', actions = []) {
    return this.addItem(s, { type: 'notice', text: String(text ?? ''), kind: kind === 'error' ? 'error' : 'info', actions });
  }

  clearNoticeActions(s) {
    for (const it of s.items) {
      if (it.type === 'notice' && it.actions?.length) {
        it.actions = [];
        this.emitItem(s, it);
      }
    }
  }

  // The same sequence the v1.1 panel rendered when it restored a chat.
  buildItems(s) {
    s.items = [];
    s.live.clear();
    const cards = new Map();
    for (const m of s.agent.messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.role === 'user') {
        const text = userText(m);
        const atts = this.userAttachments(s, m);
        if (text || atts.length) this.pushItem(s, { type: 'user', text, atts });
      } else if (m.role === 'assistant') {
        const content = textOf(m.content);
        const reasoning = m._reasoning || '';
        if (visible(content, reasoning)) this.pushItem(s, { type: 'assistant', content, reasoning, done: true });
        // Images the model itself returned come right after its reply, before any tool calls.
        this.restoreAssets(s, m);
        for (const tc of m.tool_calls || []) cards.set(tc.id, this.pushItem(s, { type: 'tool', name: tc.function?.name || 'tool', args: argsOut(tc.function?.arguments), state: 'running' }));
      } else if (m.role === 'tool') {
        const card = cards.get(m.tool_call_id);
        if (card) {
          card.state = toolFailed(m) ? 'error' : 'ok';
          card.result = capText(pretty(m.content ?? ''));
          if (Array.isArray(m._images) && m._images.length) card.images = m._images;
          cards.delete(m.tool_call_id);
        }
        this.restoreAssets(s, m);
      }
    }
    for (const card of cards.values()) card.state = 'stopped';
  }

  restoreAssets(s, m) {
    for (const id of Array.isArray(m._assets) ? m._assets : []) {
      const a = s.agent.assets.get(String(id).toLowerCase());
      if (a) this.pushItem(s, { type: 'asset', assetId: a.id });
    }
  }

  attachmentInfo(s, ref) {
    const id = String(ref?.id ?? ref).toLowerCase();
    const a = s.agent.assets.get(id);
    if (typeof ref === 'string') return a ? { id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size } : { id: ref, kind: 'file', name: ref };
    const { id: rid, kind, name, mime, size } = ref;
    return { id: rid, kind, name: name || a?.name, mime, size };
  }

  userAttachments(s, m) {
    if (Array.isArray(m._attachments)) return m._attachments.filter((x) => x && x.id).map((x) => this.attachmentInfo(s, x));
    // v1.0 history kept image data inline.
    const legacy = Array.isArray(m._images)
      ? m._images
      : Array.isArray(m.content)
        ? m.content.filter((p) => p?.type === 'image_url').map((p) => p.image_url?.url)
        : [];
    return legacy.filter((u) => typeof u === 'string' && u.startsWith('data:')).map((src, i) => ({ id: `image ${i + 1}`, kind: 'image', src }));
  }

  // The Agent's UI for one session: everything becomes transcript items the panels render.
  uiFor(s) {
    return {
      assistantStart: () => {
        const item = this.addItem(s, { type: 'assistant', content: '', reasoning: '', done: false });
        s.live.add(item);
        let timer = 0;
        const flush = () => {
          timer = 0;
          if (!item.done) this.emitItem(s, item);
        };
        return {
          update: ({ content, reasoning } = {}) => {
            if (item.done) return;
            item.content = content || '';
            item.reasoning = reasoning || '';
            if (!timer) timer = setTimeout(flush, STREAM_MS);
          },
          done: (msg) => {
            clearTimeout(timer);
            this.endAssistant(s, item, msg);
          },
        };
      },
      toolStart: (name, args) => this.toolView(s, this.addItem(s, { type: 'tool', name: name || 'tool', args: argsOut(args), state: 'running' })),
      notice: (text, kind) => this.addNotice(s, text, kind),
      asset: (a) => this.addItem(s, { type: 'asset', assetId: a.id }),
    };
  }

  endAssistant(s, item, msg) {
    if (item.done) return;
    item.done = true;
    s.live.delete(item);
    if (msg) {
      item.content = textOf(msg.content);
      item.reasoning = msg._reasoning || item.reasoning;
    }
    if (visible(item.content, item.reasoning)) this.emitItem(s, item);
    else this.removeItem(s, item);
  }

  toolView(s, item) {
    s.live.add(item);
    let pending = null;
    const closeAsk = () => {
      const ap = pending;
      pending = null;
      ap?.cleanup();
    };
    return {
      ask: (signal, info = {}) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason);
          let done = false;
          const onAbort = () => {
            closeAsk();
            reject(signal.reason);
          };
          const ap = {
            s,
            item,
            notification: null,
            answer: (v) => {
              if (done) return false;
              closeAsk();
              resolve(v);
              return true;
            },
            cleanup: () => {
              if (done) return;
              done = true;
              signal?.removeEventListener('abort', onAbort);
              s.approvals.delete(item.id);
              s.asking = Math.max(0, s.asking - 1);
              item.ask = null;
              this.clearNotification(ap);
              this.emitItem(s, item);
              this.emitState(s);
              this.updateBadge();
            },
          };
          pending = ap;
          s.approvals.set(item.id, ap);
          s.asking++;
          item.ask = { sensitive: Boolean(info?.sensitive), tool: info?.tool || item.name };
          signal?.addEventListener('abort', onAbort, { once: true });
          this.emitItem(s, item);
          this.emitState(s);
          this.updateBadge();
          if (!this.ports.size) this.notifyApproval(ap);
        }),
      finish: (text, isError, images) => {
        if (!s.live.has(item)) return;
        s.live.delete(item);
        closeAsk();
        item.state = isError ? 'error' : 'ok';
        item.result = capText(text == null ? '' : pretty(text));
        if (images?.length) item.images = images;
        this.emitItem(s, item);
      },
    };
  }

  // After a run: a bubble still streaming keeps what arrived, a tool still running shows as stopped.
  settleLive(s) {
    for (const item of [...s.live]) {
      if (item.type === 'assistant') this.endAssistant(s, item);
      else if (item.type === 'tool') {
        s.live.delete(item);
        s.approvals.get(item.id)?.cleanup();
        item.state = 'stopped';
        this.emitItem(s, item);
      }
    }
    s.live.clear();
  }

  /* ----- assets ----- */

  urlFor(s, a) {
    let blob;
    try {
      blob = assetBlob(a);
    } catch {
      return '';
    }
    let url = s.urls.get(blob);
    if (!url) s.urls.set(blob, (url = URL.createObjectURL(blob)));
    return url;
  }

  revokeUrls(s, a) {
    let one = null;
    if (a) {
      try {
        one = assetBlob(a);
      } catch {
        return;
      }
    }
    for (const [blob, url] of a ? [[one, s.urls.get(one)]] : [...s.urls]) {
      if (!url) continue;
      URL.revokeObjectURL(url);
      s.urls.delete(blob);
    }
  }

  assetMeta(s, a) {
    return { id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size, label: a.label || '', url: this.urlFor(s, a) };
  }

  onAsset(s, a) {
    this.broadcast({ t: 'asset', sid: s.id, asset: this.assetMeta(s, a) });
    this.queueAsset(s, a);
  }

  // Drop a user upload that was never sent (still only in a draft or a removed queue item).
  discardIfUnused(s, id) {
    const a = s.agent.assets.get(id);
    if (!a || a.label !== 'attached') return;
    if (s.draft.pending.includes(id) || s.queue.some((q) => q.attachmentIds.includes(id))) return;
    if (s.agent.messages.some((m) => m?._attachments?.some?.((x) => x?.id === id) || m?._assets?.includes?.(id))) return;
    this.revokeUrls(s, a);
    s.agent.removeAsset(id);
    s.assetBacklog.delete(id);
    // The panel stored the file itself, so it is always in the store.
    store.deleteAsset(s.id, id).catch((e) => console.warn('Could not delete file', e));
    this.broadcast({ t: 'assetRemoved', sid: s.id, id });
  }

  /* ----- saving ----- */

  scheduleSave(s) {
    if (s.closed || !s.ready) return;
    s.dirty = true;
    clearTimeout(s.saveTimer);
    // The first save is immediate so a brand-new chat can't be lost to the debounce.
    s.saveTimer = setTimeout(() => this.saveNow(s), s.stored ? SAVE_DELAY : 0);
  }

  // Serialised per session; never rejects (failures show in the chat).
  saveNow(s) {
    clearTimeout(s.saveTimer);
    s.saveTimer = 0;
    s.saving = s.saving.then(() => this.persist(s));
    return s.saving;
  }

  async persist(s) {
    if (s.closed || !s.ready) return;
    try {
      if (s.dirty) {
        const messages = s.agent.exportMessages();
        // An untouched "New chat" stays out of History.
        if (!s.stored && !messages.length && !s.queue.length) {
          s.dirty = false;
          return;
        }
        s.dirty = false;
        const session = { ...s.meta, messages, queue: s.queue.map((q) => ({ id: q.id, text: q.text, attachmentIds: [...q.attachmentIds] })), notes: s.notes || '' };
        try {
          await withTimeout(store.put(session), STORE_TIMEOUT);
        } catch (e) {
          s.dirty = true;
          throw e;
        }
        if (!s.stored) {
          s.stored = true;
          this.emitState(s);
        }
      }
      if (s.stored) {
        for (const [id, a] of [...s.assetBacklog]) {
          if (s.closed) return;
          // Writing a big file to disk takes a while; allow about 5 MB/s on top of the usual limit.
          await withTimeout(store.putAsset(s.id, a), STORE_TIMEOUT + Math.ceil((Number(a.size) || 0) / 5e6) * 1000);
          if (s.assetBacklog.get(id) === a) s.assetBacklog.delete(id);
        }
      }
      this.setSaveError(s, null);
    } catch (e) {
      console.warn('Could not save chat', e);
      this.setSaveError(s, e);
    }
  }

  queueAsset(s, a) {
    if (!a?.id || s.closed) return;
    s.assetBacklog.set(a.id, a);
    if (s.stored) this.saveNow(s);
  }

  flushAll(timeout = 2000) {
    const all = [...this.sessions.values()].map((s) => (s.dirty || s.saveTimer || s.assetBacklog.size ? this.saveNow(s) : s.saving));
    return Promise.race([Promise.all(all), sleep(timeout)]);
  }

  setSaveError(s, e) {
    const msg = e ? errText(e) : null;
    if (!msg) {
      if (!s.saveError) return;
      s.saveError = null;
      s.closeBlocked = false;
      this.emitState(s);
      return;
    }
    s.saveError = msg;
    this.emitState(s);
  }

  /* ----- jobs and the queue ----- */

  setRunning(s, on) {
    s.running = on;
    this.emitState(s);
    this.updateBadge();
    this.updateKeepAlive();
  }

  startJob(s, job) {
    if (s.running || s.closed || !s.ready) return Promise.resolve();
    this.setRunning(s, true);
    s.runPromise = this.runJob(s, job);
    return s.runPromise;
  }

  // job: { kind: 'direct' | 'queued' | 'resume', text, attachmentIds, item }
  async runJob(s, job) {
    const { agent } = s;
    const ids = job.attachmentIds || [];
    this.clearNoticeActions(s);
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
          s.meta.url = s.page?.url || '';
          s.meta.pageTitle = s.page?.title || '';
        }
        this.emitState(s);
      }
      bubble = this.addItem(s, { type: 'user', text: job.text, atts: ids.map((id) => this.attachmentInfo(s, id)) });
    }
    let error = null;
    try {
      // Settings saved a moment ago (another panel, a test) may not have arrived as an event yet.
      await this.reloadSettings().catch(() => {});
      const opts = {
        windowId: s.windowId,
        origin: originOf(s.page?.url || s.meta?.url || ''),
        notes: s.notes || '',
        onNotes: (text) => {
          s.notes = text;
          this.scheduleSave(s);
          if (!s.closed) this.broadcast({ t: 'notes', sid: s.id, notes: s.notes });
        },
      };
      if (job.kind === 'resume') await agent.resume(this.settings, opts);
      else await agent.run(job.text, ids, this.settings, job.kind === 'queued' ? { ...opts, keepTab: true } : opts);
    } catch (e) {
      error = e || new Error('Unknown error');
    }
    this.settleLive(s);
    // Failproof: a prompt that never reached the history goes back where it came from.
    if (error && job.kind !== 'resume' && !agent.messages.slice(before).some((m) => m?.role === 'user')) {
      if (bubble) this.removeItem(s, bubble);
      if (job.kind === 'queued') s.queue.unshift(job.item);
      else this.returnToComposer(s, job.text, ids);
    }
    this.setRunning(s, false);
    this.scheduleSave(s);
    const pend = s.afterStop;
    s.afterStop = null;
    if (s.closed) return;
    const stopped = s.stopRequested || error?.name === 'AbortError';
    if (error) {
      const canResume = Boolean(agent.canResume);
      if (error.name === 'AbortError') this.addNotice(s, 'Stopped.', 'info', canResume ? [{ label: 'Continue', id: 'continue' }] : []);
      else this.addNotice(s, errText(error), 'error', canResume ? [{ label: 'Retry', id: 'retry' }] : []);
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
    this.emitState(s);
    if (pend) {
      // A fresh instruction beats a queue that the Stop paused.
      if (this.modelProblem()) this.returnToComposer(s, pend.text, pend.attachmentIds);
      else {
        this.startJob(s, { kind: 'direct', text: pend.text, attachmentIds: pend.attachmentIds });
        return;
      }
    }
    const next = !error && !stopped && this.continueQueue(s);
    if (!next && !stopped) this.notifyJob(s, error);
  }

  continueQueue(s) {
    if (s.running || s.closed || s.paused || !s.queue.length) return false;
    if (this.queueMode() === 'auto' || s.drain) return this.runNext(s);
    return false;
  }

  runNext(s) {
    if (s.running || s.closed || !s.ready || !s.queue.length) return false;
    const problem = this.modelProblem();
    if (problem) {
      s.paused = true;
      this.status(problem, 'error');
      this.emitState(s);
      return false;
    }
    const item = s.queue.shift();
    this.startJob(s, { kind: 'queued', item, text: item.text, attachmentIds: item.attachmentIds });
    return true;
  }

  resumeRun(s) {
    if (s.running || s.closed || !s.ready) return;
    const problem = this.modelProblem();
    if (problem) return this.status(problem, 'error');
    if (!s.agent.canResume) {
      this.addNotice(s, 'There is nothing to continue.', 'info');
      return;
    }
    this.startJob(s, { kind: 'resume' });
  }

  stopSession(s) {
    if (!s?.running) return;
    s.stopRequested = true;
    s.agent.stop();
  }

  // The prompt goes back into the message box (every panel showing this chat gets it).
  returnToComposer(s, text, ids = []) {
    s.draft = { text: [s.draft.text, text].filter((x) => x && x.trim()).join('\n\n'), pending: [...new Set([...s.draft.pending, ...ids])] };
    this.broadcast({ t: 'draftBack', sid: s.id, text, ids });
  }

  /* ----- toolbar badge, keep-alive, notifications ----- */

  updateBadge() {
    let n = 0;
    let asking = false;
    for (const s of this.sessions.values()) {
      if (s.running) n++;
      if (s.asking) asking = true;
    }
    const key = `${n}|${asking}`;
    if (key === this.badge) return;
    this.badge = key;
    const { action } = this.api;
    action.setBadgeText({ text: n ? String(n) : '' }).catch(() => {});
    if (n) action.setBadgeBackgroundColor({ color: asking ? '#d97706' : '#2563eb' }).catch(() => {});
    action.setTitle({ title: n ? `Agent Automation — ${plural(n, 'chat')} working${asking ? ', waiting for your approval' : ''}` : 'Open Agent Automation' }).catch(() => {});
  }

  updateKeepAlive() {
    const busy = [...this.sessions.values()].some((s) => s.running);
    if (busy && !this.keepTimer && this.keepAliveFn) {
      this.keepAliveFn();
      this.keepTimer = setInterval(() => this.keepAliveFn(), KEEPALIVE_MS);
    } else if (!busy && this.keepTimer) {
      clearInterval(this.keepTimer);
      this.keepTimer = 0;
    }
  }

  notifyApproval(ap) {
    if (this.settings?.notifications === false || ap.notification || this.ports.size) return;
    const { s, item } = ap;
    const id = `aa|ask|${s.id}|${item.id}|${s.windowId ?? 0}`;
    ap.notification = id;
    const line = argLine(item.args);
    const basic = {
      type: 'basic',
      iconUrl: this.api.runtime.getURL(ICON),
      title: item.ask?.sensitive ? 'Allow this action on your computer?' : 'Allow this action?',
      message: clip(`${item.name}${line ? ` — ${line}` : ''}`, 220),
    };
    this.api.notifications
      .create(id, { ...basic, contextMessage: s.meta.title, buttons: [{ title: 'Allow' }, { title: 'Deny' }], requireInteraction: true, priority: 2 })
      // Browsers without notification buttons (Firefox): the click opens the panel, where it can be answered.
      .catch(() => this.api.notifications.create(id, { ...basic, message: `${basic.message}\nClick to answer in the side panel.` }))
      .catch((e) => console.warn('Could not show the approval notification', e));
  }

  clearNotification(ap) {
    if (!ap.notification) return;
    this.api.notifications.clear(ap.notification).catch(() => {});
    ap.notification = null;
  }

  notifyJob(s, error) {
    if (this.ports.size || this.settings?.notifications === false || s.closed) return;
    const id = `aa|job|${s.id}|${Date.now().toString(36)}|${s.windowId ?? 0}`;
    let message;
    if (error) message = clip(errText(error), 220);
    else {
      const last = [...s.items].reverse().find((x) => x.type === 'assistant' && x.done);
      const answer = last ? splitThink(stripToolCalls(last.content)).body.replace(/\s+/g, ' ').trim() : '';
      const waiting = s.queue.length ? ` ${plural(s.queue.length, 'queued prompt')} waiting.` : '';
      message = clip(answer || 'Done.', 200 - waiting.length) + waiting;
    }
    const basic = { type: 'basic', iconUrl: this.api.runtime.getURL(ICON), title: error ? 'Job failed' : 'Job finished', message };
    this.api.notifications
      .create(id, { ...basic, contextMessage: s.meta.title, priority: error ? 1 : 0 })
      .catch(() => this.api.notifications.create(id, basic))
      .catch((e) => console.warn('Could not show the notification', e));
  }

  // Notification ids: aa|ask|<session>|<item>|<window> and aa|job|<session>|<n>|<window>.
  onNotification(id, button) {
    if (typeof id !== 'string' || !id.startsWith('aa|')) return;
    const [, kind, sid, itemId] = id.split('|');
    const s = this.sessions.get(sid);
    if (!s) return;
    if (button == null) {
      // The service worker opened the side panel; show this chat there.
      this.activeId = sid;
      this.persistPanel();
      this.broadcast({ t: 'focus', sid });
      return;
    }
    if (kind === 'ask') s.approvals.get(itemId)?.answer(button === 0 ? 'allow' : 'deny');
  }
}

/* ---------- panel commands (see PROTOCOL.md) ---------- */

const COMMANDS = {
  hello(m, port) {
    port.windowId = Number.isFinite(Number(m.windowId)) && m.windowId != null ? Number(m.windowId) : null;
    this.snapshot(port);
  },

  new(m) {
    return { id: this.newTab(m.id).id };
  },

  open(m) {
    const id = String(m.id || '');
    if (!id) throw new Error('No chat to open.');
    let s = this.sessions.get(id);
    if (!s) {
      const prev = m.replace ? this.sessions.get(String(m.replace)) : null;
      s = this.createSession({ ...(m.meta || {}), id }, { stored: true, ready: false });
      this.activeId = id;
      this.emitSessions();
      this.hydrate(s);
      if (prev && prev !== s && this.isPristine(prev)) this.closeSession(prev, { save: false });
    }
    this.activeId = id;
    this.persistPanel();
    return { id };
  },

  // (A panel may still show a chat another panel has just closed: nothing to do then.)
  activate(m) {
    const s = this.sessions.get(String(m.id));
    if (!s) return;
    this.activeId = s.id;
    this.persistPanel();
    if (!s.ready) this.hydrate(s);
  },

  load(m) {
    const s = this.sessions.get(String(m.id));
    if (s && !s.ready) this.hydrate(s);
  },

  async close(m) {
    const s = this.need(m.id);
    return { closed: await this.closeSession(s, { save: m.save !== false }) };
  },

  rename(m) {
    return this.renameChat(String(m.id), m.title);
  },

  async delete(m) {
    const id = String(m.id);
    const s = this.sessions.get(id);
    if (s) await this.closeSession(s, { save: false });
    await store.delete(id);
  },

  async flush(m) {
    if (m.id) {
      const s = this.sessions.get(String(m.id));
      if (s && (s.dirty || s.saveTimer || s.assetBacklog.size)) await Promise.race([this.saveNow(s), sleep(STORE_TIMEOUT)]);
    } else await this.flushAll(m.timeout || 2000);
  },

  send(m, port) {
    const s = this.need(m.id);
    if (!s.ready) throw new Error('This chat is still loading.');
    this.touch(s, port, m);
    const text = String(m.text ?? '');
    const ids = cleanIds(m.attachmentIds);
    if (!text.trim() && !ids.length) throw new Error('Nothing to send.');
    if (s.running && s.stopRequested) {
      // A Stop is still unwinding: this is a fresh instruction, not a queued follow-up. Only the latest one counts.
      if (s.afterStop) this.returnToComposer(s, s.afterStop.text, s.afterStop.attachmentIds);
      s.afterStop = { text, attachmentIds: ids };
      return { queued: true, afterStop: true };
    }
    if (s.running) {
      // The panel already shows the item under the id it chose.
      const qid = typeof m.qid === 'string' && m.qid && !s.queue.some((x) => x.id === m.qid) ? m.qid : newId();
      s.queue.push({ id: qid, text, attachmentIds: ids });
      this.scheduleSave(s);
      this.emitState(s);
      return { queued: true, n: s.queue.length };
    }
    const problem = this.modelProblem();
    if (problem) throw new Error(problem);
    this.startJob(s, { kind: 'direct', text, attachmentIds: ids });
    return { queued: false };
  },

  batch(m, port) {
    const s = this.need(m.id);
    if (!s.ready) throw new Error('This chat is still loading.');
    this.touch(s, port, m);
    // Prompts as text, or { id, text } when the panel already shows them under those ids.
    const taken = new Set(s.queue.map((q) => q.id));
    const jobs = (Array.isArray(m.jobs) ? m.jobs : [])
      .map((j) => (j && typeof j === 'object' ? { id: String(j.id || ''), text: String(j.text ?? '') } : { id: '', text: String(j ?? '') }))
      .filter((j) => j.text.trim());
    if (!jobs.length) return { n: 0 };
    if (m.mode === 'auto' || m.mode === 'step') this.settings.queueMode = m.mode; // the panel saves it too
    for (const j of jobs) {
      const id = j.id && !taken.has(j.id) ? j.id : newId();
      taken.add(id);
      s.queue.push({ id, text: j.text, attachmentIds: [] });
    }
    this.scheduleSave(s);
    // Adding jobs is a request to run them: un-pause, and start right away when idle (from the front).
    s.paused = false;
    s.drain = false;
    if (!s.running) this.runNext(s);
    this.emitState(s);
    return { n: jobs.length };
  },

  queue(m, port) {
    const s = this.need(m.id);
    this.touch(s, port, m);
    const q = s.queue;
    const i = q.findIndex((x) => x.id === m.itemId);
    let out = null;
    switch (m.op) {
      case 'up':
        if (i > 0) [q[i - 1], q[i]] = [q[i], q[i - 1]];
        break;
      case 'down':
        if (i >= 0 && i < q.length - 1) [q[i + 1], q[i]] = [q[i], q[i + 1]];
        break;
      case 'remove':
        if (i >= 0) for (const aid of q.splice(i, 1)[0].attachmentIds) this.discardIfUnused(s, aid);
        break;
      case 'edit':
        if (i >= 0) {
          const [item] = q.splice(i, 1);
          out = { text: item.text, attachmentIds: item.attachmentIds };
          // They are in that panel's draft now.
          s.draft.pending = [...new Set([...s.draft.pending, ...item.attachmentIds])];
        }
        break;
      case 'clear':
        for (const item of q.splice(0)) for (const aid of item.attachmentIds) this.discardIfUnused(s, aid);
        s.paused = false;
        s.drain = false;
        break;
      case 'runNext':
      case 'resume':
      case 'runAll':
        s.paused = false;
        s.drain = m.op === 'runAll';
        this.runNext(s);
        break;
      default:
        throw new Error(`Unknown queue operation "${m.op}".`);
    }
    if (!q.length) {
      s.paused = false;
      s.drain = false;
    }
    if (!['runNext', 'resume', 'runAll'].includes(m.op)) this.scheduleSave(s);
    this.emitState(s);
    return out;
  },

  stop(m) {
    const s = this.sessions.get(String(m.id));
    if (s) this.stopSession(s);
  },

  noticeAction(m, port) {
    const s = this.need(m.id);
    const item = s.items.find((x) => x.id === m.itemId && x.type === 'notice');
    if (!item || !item.actions?.some((a) => a.id === m.action)) return false;
    item.actions = [];
    this.emitItem(s, item);
    this.touch(s, port, m);
    if (m.action === 'continue' || m.action === 'retry') this.resumeRun(s);
    return true;
  },

  approve(m) {
    const s = this.need(m.id);
    const ap = s.approvals.get(String(m.itemId));
    if (!ap) return false;
    const answer = ['allow', 'always', 'deny'].includes(m.answer) ? m.answer : 'deny';
    return ap.answer(answer);
  },

  // Attachments: the panel asks for an id, writes the file into the store itself, then hands it over.
  attachReserve(m) {
    const s = this.need(m.id);
    if (!s.ready) throw new Error('This chat is still loading.');
    return s.agent.reserveAsset({ name: m.name, mime: m.mime, size: m.size });
  },

  async attach(m) {
    const s = this.need(m.id);
    const a = await withTimeout(store.getAsset(s.id, String(m.assetId)), STORE_TIMEOUT);
    if (!a) throw new Error('The file could not be read back from the browser storage.');
    const asset = s.agent.adoptAsset(a);
    const meta = this.assetMeta(s, asset);
    this.broadcast({ t: 'asset', sid: s.id, asset: meta });
    return meta;
  },

  discard(m) {
    const s = this.sessions.get(String(m.id));
    if (!s) return;
    s.draft.pending = s.draft.pending.filter((x) => x !== m.assetId);
    this.discardIfUnused(s, String(m.assetId));
  },

  notice(m) {
    const s = this.need(m.id);
    this.addNotice(s, m.text, m.kind);
  },

  draft(m) {
    const s = this.sessions.get(String(m.id));
    if (!s) return;
    s.draft = { text: String(m.text ?? ''), pending: cleanIds(m.pending) };
  },

  retrySave(m) {
    const s = this.need(m.id);
    s.dirty = true;
    return this.saveNow(s);
  },

  settings() {
    return this.reloadSettings();
  },
};

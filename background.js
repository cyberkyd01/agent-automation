// Service worker. The agent engine runs in an offscreen document (src/engine/offscreen.js), which Chrome keeps
// alive on its own, so jobs go on when the side panel is closed. The document only has chrome.runtime, so this
// worker makes the browser API calls for it (rpc), forwards browser events to it, and opens the side panel.
// The engine pings while jobs run, which keeps this worker from idling out in the middle of one.
import { api, invoke, serializeError, EVENTS, TO_ENGINE, TO_HOST } from './src/host/api.js';

const OFFSCREEN = 'offscreen.html';
const ORIGIN = chrome.runtime.getURL('');
const ENGINE_URL = chrome.runtime.getURL(OFFSCREEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

/* ---------- the offscreen document ---------- */

let creating = null;

async function hasEngineDocument() {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [ENGINE_URL] });
  return ctx.length > 0;
}

// Creates the engine's document if needed and waits until the engine answers.
async function ensureEngine() {
  if (!(await hasEngineDocument())) {
    creating ??= chrome.offscreen
      .createDocument({
        url: OFFSCREEN,
        reasons: ['DOM_PARSER', 'BLOBS', 'WORKERS'],
        justification: 'Runs the browser agent so jobs continue while the side panel is closed: it parses web pages, holds attached files and reads PDFs in a worker.',
      })
      .catch((e) => {
        if (!/single offscreen|already exists/i.test(e?.message || '')) throw e;
      })
      .finally(() => (creating = null));
    await creating;
  }
  for (let i = 0; i < 200; i++) {
    const r = await chrome.runtime.sendMessage({ to: TO_ENGINE, op: 'ping' }).catch(() => null);
    if (r?.ready) return;
    await sleep(50);
  }
  throw new Error('The agent engine did not start.');
}

/* ---------- events → engine ---------- */

// Event names the engine listens for. Kept in session storage so a restarted worker still forwards them.
const subs = new Set();
const subsLoaded = chrome.storage.session
  .get('engineEvents')
  .then(({ engineEvents }) => {
    for (const n of Array.isArray(engineEvents) ? engineEvents : []) subscribe(n, false);
  })
  .catch(() => {});

function forward(name) {
  return (...args) => {
    subsLoaded.then(() => {
      if (!subs.has(name)) return;
      chrome.runtime.sendMessage({ to: TO_ENGINE, op: 'event', name, args: JSON.parse(JSON.stringify(args ?? [])) }).catch(() => {});
    });
  };
}

// Rare events are registered at the top level (so they wake this worker); the chatty tab events only once the
// engine asks for them.
const LAZY = new Set(['tabs.removed', 'tabs.updated', 'tabs.activated']);
const registered = new Set();
function register(name) {
  if (registered.has(name)) return;
  const [space, ev] = EVENTS[name] || [];
  const target = space && chrome[space]?.[ev];
  if (!target) return;
  registered.add(name);
  target.addListener(name.startsWith('notifications.') ? notificationHandler(name) : forward(name));
}

function subscribe(name, persist = true) {
  if (!EVENTS[name]) throw new Error(`Unknown event ${name}.`);
  register(name);
  if (subs.has(name)) return;
  subs.add(name);
  if (persist) chrome.storage.session.set({ engineEvents: [...subs] }).catch(() => {});
}

// Notification ids made by the engine: aa|<kind>|<session id>|<item>|<window id>.
function notificationHandler(name) {
  const send = forward(name);
  return (id, ...rest) => {
    if (typeof id !== 'string' || !id.startsWith('aa|')) return;
    if (name === 'notifications.clicked') {
      // Must happen right here: opening the side panel needs the user gesture of this click.
      const windowId = Number(id.split('|')[4]);
      chrome.sidePanel.open({ windowId: windowId > 0 ? windowId : chrome.windows.WINDOW_ID_CURRENT }).catch((e) => console.warn('Could not open the side panel', e));
    }
    if (name !== 'notifications.closed') chrome.notifications.clear(id).catch(() => {});
    send(id, ...rest);
  };
}

for (const name of Object.keys(EVENTS)) if (!LAZY.has(name)) register(name);

/* ---------- messages ---------- */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.to !== TO_HOST || sender.id !== chrome.runtime.id) return;
  // Only extension pages: a content script (our injected page functions) has the web page's URL.
  const fromExtension = String(sender.url || '').startsWith(ORIGIN);
  if (!fromExtension) return;
  const fromEngine = String(sender.url).startsWith(ENGINE_URL);
  const answer = (p) =>
    p.then(
      (value) => reply({ ok: true, value }),
      (e) => reply({ ok: false, error: serializeError(e) })
    );
  switch (msg.op) {
    case 'call':
      if (!fromEngine) return;
      if (msg.path === 'events.subscribe') return answer(Promise.resolve().then(() => subscribe(String(msg.args?.[0])))), true;
      return answer(Promise.resolve().then(() => invoke(api, msg.path, msg.args))), true;
    case 'keepalive':
      reply({ ok: true });
      return;
    case 'ensureEngine':
      return answer(ensureEngine()), true;
  }
});

// A restarted browser has no running jobs: clear a badge left from before.
chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
});

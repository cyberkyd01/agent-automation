// Promise-based facade over the browser APIs the engine uses, so the same engine code runs where those APIs
// exist (Chrome service worker, Firefox background page, the panel, test pages: "direct") and in a Chrome
// offscreen document, which only has chrome.runtime ("rpc": every call is made by the service worker,
// background.js, which answers with invoke()).
import * as page from '../page.js';

// Message routing: every extension context sees runtime messages, so each one says who it is for.
export const TO_HOST = 'aa-host'; // the service worker (Chrome) / background page (Firefox)
export const TO_ENGINE = 'aa-engine'; // the engine (offscreen document)

// api.events name → [namespace, event] of the browser API.
export const EVENTS = {
  'debugger.detach': ['debugger', 'onDetach'],
  'downloads.changed': ['downloads', 'onChanged'],
  'tabs.removed': ['tabs', 'onRemoved'],
  'tabs.updated': ['tabs', 'onUpdated'],
  'tabs.activated': ['tabs', 'onActivated'],
  'notifications.clicked': ['notifications', 'onClicked'],
  'notifications.buttonClicked': ['notifications', 'onButtonClicked'],
  'notifications.closed': ['notifications', 'onClosed'],
  'storage.changed': ['storage', 'onChanged'],
};

// The browser namespace: Firefox's `browser` has the promise forms everywhere; Chrome's `chrome` has them in MV3.
const ns = () => globalThis.browser ?? globalThis.chrome;

const pageFuncs = Object.fromEntries(Object.entries(page).filter(([, f]) => typeof f === 'function'));

// A src/page.js export by name (the only kind of function that can travel to the service worker).
export function pageFunc(name) {
  const f = pageFuncs[name];
  if (!f) throw new Error(`Unknown page function "${name}".`);
  return f;
}

// Errors cross the message boundary as { message, name }.
const errorOf = (e) => ({ message: String(e?.message || e || 'Unknown error'), name: String(e?.name || 'Error') });
function toError(x) {
  const e = new Error(x?.message || 'Unknown error');
  if (x?.name && x.name !== 'Error') e.name = x.name;
  return e;
}

/* ---------- direct ---------- */

function makeDirect() {
  const call = (space, fn) => (...args) => {
    const s = ns()?.[space];
    if (!s?.[fn]) return Promise.reject(new Error(`${space}.${fn} is not available here.`));
    // Argument errors are thrown at the call (Firefox: "Property "buttons" is unsupported by Firefox"); callers
    // expect a rejection, as they get over rpc.
    try {
      return Promise.resolve(s[fn](...args));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const group = (space, fns) => Object.fromEntries(fns.map((f) => [f, call(space, f)]));
  const listeners = new Map(); // name → { fns: Set, native }

  return {
    mode: 'direct',
    tabs: group('tabs', ['get', 'query', 'create', 'update', 'remove', 'goBack', 'goForward', 'reload', 'captureVisibleTab', 'getZoom']),
    windows: group('windows', ['get', 'getCurrent', 'getLastFocused', 'getAll', 'update', 'create']),
    scripting: {
      async executeScript({ target, func, funcName, args, world }) {
        const fn = func || pageFunc(funcName);
        return call('scripting', 'executeScript')({ target, func: fn, args: args || [], ...(world ? { world } : {}) });
      },
    },
    debugger: {
      ...group('debugger', ['attach', 'detach', 'sendCommand']),
      // Firefox has no debugger API (trusted input events, the CSP fallback of run_javascript).
      get available() {
        return Boolean(ns()?.debugger);
      },
    },
    downloads: group('downloads', ['download', 'search', 'cancel', 'erase']),
    storage: {
      local: {
        get: (keys) => Promise.resolve(ns().storage.local.get(keys)),
        set: (items) => Promise.resolve(ns().storage.local.set(items)),
        remove: (keys) => Promise.resolve(ns().storage.local.remove(keys)),
      },
    },
    declarativeNetRequest: {
      getDynamicRules: call('declarativeNetRequest', 'getDynamicRules'),
      updateDynamicRules: (options) => call('declarativeNetRequest', 'updateDynamicRules')(ownInitiator(options)),
    },
    notifications: group('notifications', ['create', 'clear', 'getAll']),
    action: group('action', ['setBadgeText', 'setBadgeBackgroundColor', 'setTitle']),
    get runtime() {
      return ns().runtime;
    },
    events: {
      on(name, fn) {
        let l = listeners.get(name);
        if (!l) {
          const [space, ev] = EVENTS[name] || [];
          const target = space && ns()?.[space]?.[ev];
          if (!target) return; // this browser or context has no such event
          l = { fns: new Set(), native: (...a) => l.fns.forEach((f) => safe(f, a)) };
          target.addListener(l.native);
          listeners.set(name, l);
        }
        l.fns.add(fn);
      },
      off(name, fn) {
        listeners.get(name)?.fns.delete(fn);
      },
    },
  };
}

function safe(fn, args) {
  try {
    fn(...args);
  } catch (e) {
    console.error('Event listener failed', e);
  }
}

// DNR rules for "requests made by this extension" name it in initiatorDomains by its id, which is the host of
// Chrome's chrome-extension://<id>/ pages. Firefox serves extension pages from moz-extension://<internal UUID>/
// and rejects an add-on id there ("Invalid domain"), so it gets that host instead. Chrome: unchanged.
function ownInitiator(options) {
  const rt = ns()?.runtime;
  let host = '';
  try {
    host = new URL(rt.getURL('')).hostname;
  } catch {}
  if (!host || !rt?.id || host === rt.id || !Array.isArray(options?.addRules)) return options;
  const fix = (r) => {
    const domains = r?.condition?.initiatorDomains;
    if (!Array.isArray(domains) || !domains.includes(rt.id)) return r;
    return { ...r, condition: { ...r.condition, initiatorDomains: domains.map((d) => (d === rt.id ? host : d)) } };
  };
  return { ...options, addRules: options.addRules.map(fix) };
}

/* ---------- rpc ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The message never reached the service worker (it was starting or restarting): safe to send again.
const undelivered = (e) => /Receiving end does not exist|Could not establish connection/i.test(e?.message || '');
// The worker went away while answering: only calls that change nothing may simply be made again.
const dropped = (e) => /message port closed|message channel closed/i.test(e?.message || '');
const READ_ONLY = /\.(get|getAll|getCurrent|getLastFocused|query|search|getZoom|getDynamicRules)$/;

function makeRpc() {
  const runtime = globalThis.chrome?.runtime;
  async function call(path, args) {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await runtime.sendMessage({ to: TO_HOST, op: 'call', path, args });
      } catch (e) {
        if (attempt < 4 && (undelivered(e) || (dropped(e) && READ_ONLY.test(path)))) {
          await sleep(150 * (attempt + 1));
          continue;
        }
        throw toError(errorOf(e));
      }
      if (r?.ok) return r.value;
      if (!r && attempt < 4) {
        await sleep(150 * (attempt + 1));
        continue;
      }
      throw toError(r?.error || { message: 'The extension background did not answer.' });
    }
  }
  const remote = (space, fns) => Object.fromEntries(fns.map((f) => [f, (...args) => call(`${space}.${f}`, args)]));
  const listeners = new Map(); // name → Set

  runtime?.onMessage.addListener((msg) => {
    if (msg?.to !== TO_ENGINE || msg.op !== 'event') return;
    for (const fn of listeners.get(msg.name) || []) safe(fn, Array.isArray(msg.args) ? msg.args : []);
  });

  return {
    mode: 'rpc',
    tabs: remote('tabs', ['get', 'query', 'create', 'update', 'remove', 'goBack', 'goForward', 'reload', 'captureVisibleTab', 'getZoom']),
    windows: remote('windows', ['get', 'getCurrent', 'getLastFocused', 'getAll', 'update', 'create']),
    scripting: {
      executeScript({ target, func, funcName, args, world }) {
        const name = funcName || func?.name;
        if (!name || (func && pageFuncs[name] !== func)) return Promise.reject(new Error('Only src/page.js functions can be injected from here.'));
        return call('scripting.executeScript', [{ target, funcName: name, args: args || [], world }]);
      },
    },
    debugger: { ...remote('debugger', ['attach', 'detach', 'sendCommand']), available: true }, // Chrome's worker has it
    downloads: remote('downloads', ['download', 'search', 'cancel', 'erase']),
    storage: { local: remote('storage.local', ['get', 'set', 'remove']) },
    declarativeNetRequest: remote('declarativeNetRequest', ['getDynamicRules', 'updateDynamicRules']),
    notifications: remote('notifications', ['create', 'clear', 'getAll']),
    action: remote('action', ['setBadgeText', 'setBadgeBackgroundColor', 'setTitle']),
    runtime,
    events: {
      on(name, fn) {
        if (!EVENTS[name]) return;
        let set = listeners.get(name);
        if (!set) {
          listeners.set(name, (set = new Set()));
          call('events.subscribe', [name]).catch((e) => console.warn(`Could not listen for ${name}`, e));
        }
        set.add(fn);
      },
      off(name, fn) {
        listeners.get(name)?.delete(fn);
      },
    },
  };
}

/* ---------- the host side of rpc ---------- */

// Runs one rpc call against a direct api (background.js). Only the functions of the facade can be reached.
export async function invoke(direct, path, args) {
  const parts = String(path || '').split('.');
  const fn = parts.pop();
  let obj = direct;
  for (const p of parts) obj = Object.hasOwn(obj, p) ? obj[p] : undefined;
  if (!obj || parts[0] === 'events' || parts[0] === 'runtime' || !Object.hasOwn(obj, fn) || typeof obj[fn] !== 'function') {
    throw new Error(`Unknown call ${path}.`);
  }
  return obj[fn](...(Array.isArray(args) ? args : []));
}

export const serializeError = errorOf;

export const api = ns()?.tabs ? makeDirect() : makeRpc();

// Cross-chat memory: durable notes the agent saves, scoped 'global' or to a site origin, read back into later
// chats. Kept in extension storage through the api facade (api.storage.local), so it works both in the engine's
// offscreen document (rpc to the service worker) and in the panel (direct). Small text only; capped at MEMORY_MAX.
import { api } from './host/api.js';

export const MEMORY_MAX = 200;
const KEY = 'memories';
const MAX_TEXT = 2000; // one memory's text is capped so a runaway note can't bloat storage or context

// The origin a memory is scoped to, or '' for pages that have none (chrome:, about:, extension pages, blank).
export function originOf(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch {
    return '';
  }
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const normScope = (scope) => (scope === 'global' || !scope ? 'global' : originOf(scope) || String(scope));

async function read() {
  try {
    const got = await api.storage.local.get(KEY);
    const list = got?.[KEY];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.text === 'string') : [];
  } catch {
    return [];
  }
}

// Writes are serialised: list() → mutate → set() can't interleave and lose each other.
let chain = Promise.resolve();
function withList(fn) {
  const next = chain.then(async () => {
    const list = await read();
    const result = await fn(list);
    await api.storage.local.set({ [KEY]: list });
    return result;
  });
  chain = next.catch(() => {});
  return next;
}

const byNewest = (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);

export const memStore = {
  // scope: 'global' | an origin | undefined (= all). Newest first.
  async list({ scope } = {}) {
    const list = await read();
    const filtered = scope ? list.filter((m) => m.scope === normScope(scope)) : list.slice();
    return filtered.sort(byNewest);
  },

  // The memories to inject into a run now: 'global' + this origin, newest first, trimmed so the total text fits budget.
  async relevant(origin, budgetChars) {
    const budget = Number(budgetChars) || 0;
    if (budget <= 0) return [];
    const org = originOf(origin) || origin || '';
    const list = (await read()).filter((m) => m.scope === 'global' || (org && m.scope === org)).sort(byNewest);
    const out = [];
    let used = 0;
    for (const m of list) {
      const cost = (m.text || '').length + 12;
      if (out.length && used + cost > budget) break;
      out.push(m);
      used += cost;
    }
    return out;
  },

  // Upsert. Empty text is ignored. A near-identical note in the same scope is refreshed instead of duplicated.
  async save({ scope, text, id, source = 'agent' } = {}) {
    const body = clean(text).slice(0, MAX_TEXT);
    const sc = normScope(scope);
    if (!body) return null;
    return withList((list) => {
      let entry = id ? list.find((m) => m.id === id) : null;
      if (!entry) {
        const key = body.toLowerCase();
        entry = list.find((m) => m.scope === sc && clean(m.text).toLowerCase() === key);
      }
      const now = Date.now();
      if (entry) {
        entry.text = body;
        entry.scope = sc;
        entry.updatedAt = now;
        if (source === 'user') entry.source = 'user';
      } else {
        entry = { id: crypto.randomUUID(), scope: sc, text: body, source, createdAt: now, updatedAt: now };
        list.push(entry);
        // Over the cap: drop the oldest agent-written memory (never silently drop something the user asked to keep).
        while (list.length > MEMORY_MAX) {
          let victim = -1;
          for (let i = 0; i < list.length; i++) {
            if (list[i].source !== 'user' && (victim < 0 || byNewest(list[i], list[victim]) > 0)) victim = i;
          }
          if (victim < 0) victim = list.reduce((oldest, m, i, a) => (byNewest(m, a[oldest]) > 0 ? i : oldest), 0);
          list.splice(victim, 1);
        }
      }
      return { ...entry };
    });
  },

  async delete(id) {
    await withList((list) => {
      const i = list.findIndex((m) => m.id === id);
      if (i >= 0) list.splice(i, 1);
    });
  },

  // scope omitted = all. Returns the number removed.
  async clear({ scope } = {}) {
    return withList((list) => {
      const before = list.length;
      const keep = scope ? list.filter((m) => m.scope !== normScope(scope)) : [];
      list.length = 0;
      list.push(...keep);
      return before - list.length;
    });
  },
};

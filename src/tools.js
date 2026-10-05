import { pageRead, pageAct, mainEval } from './page.js';
import { cdp, cdpClick, cdpInsertText, cdpKey, cdpEval } from './cdp.js';
import { sleep, blobToDataUrl, httpError, safeParse } from './util.js';

/* ---------- page plumbing ---------- */

const RESTRICTED = 'This page cannot be automated (browser-internal or restricted page). Use navigate/open_tab to go to a regular website.';
const GONE = 'That tab no longer exists. Use list_tabs.';
const NAVIGATED = 'The page navigated or reloaded during the action. Call read_page to see the new state.';

function friendly(e) {
  const m = String(e?.message || e);
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery/i.test(m)) return RESTRICTED;
  if (/No tab with id/i.test(m)) return GONE;
  if (/showing error page/i.test(m)) return 'The page failed to load (the browser is showing an error page). Check the URL or try again.';
  if (/Frame with ID|frame.*removed/i.test(m)) return NAVIGATED;
  return m;
}

const rethrow = (e) => {
  throw new Error(friendly(e));
};

async function inject(tabId, func, arg, world = 'ISOLATED') {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [arg ?? {}], world });
    return res?.result;
  } catch (e) {
    rethrow(e);
  }
}

async function act(tabId, action) {
  const r = await inject(tabId, pageAct, action);
  if (!r) throw new Error('No response from page.');
  if (r.error) throw new Error(r.error);
  return r;
}

const has = (v) => v != null && v !== '';
const short = (s, n = 60) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Only the fallback is remembered: passing tab_id targets a tab without changing the current one.
async function tabOf(args, ctx) {
  if (has(args.tab_id)) return Number(args.tab_id);
  if (ctx.tabId != null) return Number(ctx.tabId);
  let [t] = ctx.windowId != null ? await chrome.tabs.query({ active: true, windowId: ctx.windowId }) : [];
  if (!t) [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('No active tab. Use open_tab.');
  ctx.tabId = t.id;
  return Number(t.id);
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function settle(tabId, ms = 350, max = 12000, signal) {
  await pause(ms, signal);
  const end = Date.now() + max;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'complete') return;
    await pause(150, signal);
  }
}

async function pageLine(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  return t ? `Page now: "${t.title || ''}" — ${t.url || t.pendingUrl || ''}` : 'The tab is gone (it was closed).';
}

// Runs a page-changing action, waits for the page to settle and reports where we ended up.
async function acting(tabId, ctx, fn, max = 12000) {
  const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
  let msg;
  try {
    msg = await fn();
  } catch (e) {
    // The frame vanishing mid-action usually means our click/submit navigated: don't invite a retry.
    if (e.message !== NAVIGATED) throw e;
    msg = 'The page navigated during the action (it most likely took effect).';
  }
  await settle(tabId, 350, max, ctx.signal);
  const lines = [msg, await pageLine(tabId)];
  for (const t of await chrome.tabs.query({})) {
    if (!before.has(t.id)) lines.push(`New tab opened: id=${t.id} ${t.pendingUrl || t.url} (use switch_tab to work in it)`);
  }
  return lines.join('\n');
}

function target(args, required = true) {
  if (has(args.id)) return { id: args.id };
  if (has(args.selector)) return { selector: String(args.selector) };
  if (required) throw new Error('Provide an element id (from read_page) or a CSS selector.');
  return {};
}

function withScheme(u) {
  u = String(u ?? '').trim();
  if (!u) throw new Error('Missing url.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data|mailto|view-source):/i.test(u)) return u;
  return (/^(localhost|127\.|\[::1\])/i.test(u) ? 'http://' : 'https://') + u;
}

// Keeps paginated output under the agent's truncation limit so the "more" note survives.
const room = (ctx) => Math.max(1000, (Number(ctx.settings.maxToolChars) || 12000) - 400);

/* ---------- keys ---------- */

const KEY_NAMES = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  space: ' ',
  spacebar: ' ',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};
const MOD_NAMES = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', meta: 'meta', cmd: 'meta', command: 'meta' };

const normKey = (k) => (k.length === 1 ? k : KEY_NAMES[k.toLowerCase().replace(/[\s_-]/g, '')] || k);

function parseKey(args) {
  const mods = { ctrl: !!args.ctrl, shift: !!args.shift, alt: !!args.alt, meta: !!args.meta };
  let key = String(args.key ?? '');
  // Models often write combos like "Ctrl+A" instead of using the modifier flags.
  if (key.length > 1 && key.includes('+')) {
    const parts = key.split('+');
    key = parts.pop() || '+';
    for (const p of parts) {
      const m = MOD_NAMES[p.trim().toLowerCase()];
      if (m) mods[m] = true;
    }
  }
  if (!key) throw new Error('Missing key.');
  // "Ctrl+A" means the A key: a real keyboard reports it as "a" unless Shift is held.
  if (/^[A-Z]$/.test(key) && !mods.shift && (mods.ctrl || mods.alt || mods.meta)) key = key.toLowerCase();
  return { key: normKey(key), mods };
}

/* ---------- images ---------- */

async function decodeImage(src) {
  const blob = await (await fetch(src)).blob();
  try {
    return await createImageBitmap(blob);
  } catch {
    // SVG (and a few other formats) only decode through an <img>.
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  }
}

// Re-encodes an image, scaling it down to maxW. Returns the input untouched when nothing would change.
async function encode(src, { maxW = Infinity, type = 'image/jpeg', quality = 0.8 } = {}) {
  const img = await decodeImage(src);
  const w0 = img.naturalWidth || img.width || 512;
  const h0 = img.naturalHeight || img.height || 512;
  const k = Math.min(1, maxW / w0);
  if (k === 1 && src.startsWith(`data:${type}`)) {
    img.close?.();
    return { dataUrl: src, width: w0, height: h0, origWidth: w0, origHeight: h0 };
  }
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  if (type === 'image/jpeg') {
    // JPEG has no alpha; transparent areas would turn black.
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
  }
  g.drawImage(img, 0, 0, w, h);
  img.close?.();
  const dataUrl = await blobToDataUrl(await canvas.convertToBlob({ type, quality }));
  return { dataUrl, width: w, height: h, origWidth: w0, origHeight: h0 };
}

const toPng = async (dataUrl) => (await encode(dataUrl, { type: 'image/png' })).dataUrl;
const preview = (dataUrl) => encode(dataUrl, { maxW: 1024 });

const mimeOf = (dataUrl) => /^data:([^;,]+)/.exec(dataUrl)?.[1] || 'application/octet-stream';
const extOf = (mime) =>
  ({ 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico' })[mime] || /^[a-z]+\/([a-z0-9]+)$/i.exec(mime)?.[1] || 'png';

export async function capture(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(rethrow);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(250);
  }
  let shot;
  for (let i = 0; ; i++) {
    try {
      shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
      break;
    } catch (e) {
      // Chrome allows only ~2 captures per second.
      if (i < 2 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(e.message)) await sleep(600);
      else rethrow(e);
    }
  }
  const img = await encode(shot, { maxW: 1280, quality: 0.75 });
  // tab.width is in device-independent px; page zoom makes CSS px larger than that.
  const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
  return { dataUrl: img.dataUrl, scale: tab.width / (zoom || 1) / img.width };
}

export async function toDataUrl(url, signal) {
  if (url.startsWith('data:')) return url;
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw await httpError(res);
  return blobToDataUrl(await res.blob());
}

async function resolveSource(source, ctx, tabId) {
  const s = String(source ?? '').trim();
  if (/^img_\d+$/i.test(s)) {
    const a = ctx.getAsset(s.toLowerCase());
    if (!a) throw new Error(`There is no image asset ${s}.`);
    return a.dataUrl;
  }
  if (s.toLowerCase() === 'screenshot') return (await capture(tabId ?? (await tabOf({}, ctx)))).dataUrl;
  const el = /^(?:element:\s*)?(\d+)$/i.exec(s);
  if (el) {
    const r = await act(tabId ?? (await tabOf({}, ctx)), { type: 'image_src', id: el[1] });
    return toDataUrl(r.src, ctx.signal);
  }
  if (s.startsWith('data:')) return s;
  if (/^https?:\/\//i.test(s)) return toDataUrl(s, ctx.signal);
  throw new Error('Invalid source. Use an asset id (img_1), "screenshot", "element:<id>" from read_page, or an image URL.');
}

/* ---------- image generation ---------- */

function imageApi(ctx) {
  const cfg = ctx.settings.image || {};
  const p = cfg.providerId && (ctx.settings.providers || []).find((x) => x.id === cfg.providerId);
  if (!p || !cfg.model) throw new Error('No image model configured. Ask the user to open Settings → Image generation and choose a provider and model.');
  return {
    cfg,
    name: p.name || p.id,
    base: (p.baseUrl || '').replace(/\/+$/, ''),
    auth: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
  };
}

async function postJson(url, init, who, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', ...init, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Cannot reach ${who} at ${url} (${e.message}).`);
  }
  if (!res.ok) throw await httpError(res);
  return res.json();
}

const b64Mime = (b64) => (b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png');

// Returns data URLs. `src` (a PNG data URL) switches from generation to editing.
async function makeImages(ctx, prompt, src, size) {
  const { cfg, name, base, auth } = imageApi(ctx);
  const { signal } = ctx;
  size = size || cfg.size;
  const json = { 'Content-Type': 'application/json', ...auth };

  if (cfg.api === 'chat') {
    const content = [{ type: 'text', text: prompt }];
    if (src) content.push({ type: 'image_url', image_url: { url: src } });
    const body = { model: cfg.model, messages: [{ role: 'user', content }], modalities: ['image', 'text'] };
    const j = await postJson(`${base}/chat/completions`, { headers: json, body: JSON.stringify(body) }, name, signal);
    const msg = j.choices?.[0]?.message || {};
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const urls = [...(msg.images || []), ...parts.filter((p) => p?.type === 'image_url')]
      .map((im) => im?.image_url?.url || im?.url)
      .filter(Boolean);
    if (!urls.length) {
      const said = typeof msg.content === 'string' ? msg.content : parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
      throw new Error('The image model returned no image.' + (said ? ' It replied: ' + short(said, 500) : ''));
    }
    return Promise.all(urls.map((u) => toDataUrl(u, signal)));
  }

  let j;
  if (src) {
    const fd = new FormData();
    fd.append('model', cfg.model);
    fd.append('prompt', prompt);
    fd.append('image', await (await fetch(src)).blob(), 'image.png');
    if (size) fd.append('size', size);
    j = await postJson(`${base}/images/edits`, { headers: auth, body: fd }, name, signal);
  } else {
    const body = { model: cfg.model, prompt, n: 1, ...(size ? { size } : {}) };
    j = await postJson(`${base}/images/generations`, { headers: json, body: JSON.stringify(body) }, name, signal);
  }
  const out = [];
  for (const d of j.data || []) {
    if (d.b64_json) out.push(`data:${b64Mime(d.b64_json)};base64,${d.b64_json}`);
    else if (d.url) out.push(await toDataUrl(d.url, signal));
  }
  if (!out.length) throw new Error('The image API returned no images.');
  return out;
}

async function assetResult(urls, label, ctx) {
  const assets = urls.map((u) => ctx.addAsset(u, label));
  const images = [];
  if (ctx.vision()) for (const a of assets) images.push((await preview(a.dataUrl)).dataUrl);
  return {
    text: `Created ${assets.map((a) => a.id).join(', ')} (shown to the user). Use it as source in upload_file / set_page_image / download / edit_image.`,
    images,
  };
}

/* ---------- web ---------- */

const BLOCK = new Set(
  'address article aside blockquote br caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody tfoot thead tr ul'.split(' ')
);

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,template').forEach((e) => e.remove());
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) return void out.push(n.nodeValue);
    if (n.nodeType !== 1) return;
    const tag = n.localName;
    const block = BLOCK.has(tag);
    if (block) out.push('\n');
    if (/^h[1-6]$/.test(tag)) out.push('#'.repeat(+tag[1]) + ' ');
    else if (tag === 'li') out.push('- ');
    for (const c of n.childNodes) walk(c);
    if (tag === 'td' || tag === 'th') out.push(' | ');
    if (block) out.push('\n');
  };
  walk(doc.body || doc.documentElement);
  const text = out
    .join('')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  const title = (doc.title || '').trim();
  return title ? `Title: ${title}\n\n${text}` : text;
}

const textOf = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

function bingUrl(href) {
  const m = /[?&]u=a1([^&]+)/.exec(href);
  if (!m) return href;
  try {
    const b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return href;
  }
}

async function searchPage(url, signal) {
  const res = await fetch(url, { credentials: 'omit', signal });
  if (!res.ok) throw await httpError(res);
  return new DOMParser().parseFromString(await res.text(), 'text/html');
}

async function webSearch(query, n, signal) {
  const q = encodeURIComponent(query);
  const results = [];
  try {
    const doc = await searchPage(`https://html.duckduckgo.com/html/?q=${q}`, signal);
    for (const r of doc.querySelectorAll('.result')) {
      const a = r.querySelector('.result__a');
      let href = a?.getAttribute('href') || '';
      if (!href || r.classList.contains('result--ad') || href.includes('duckduckgo.com/y.js')) continue;
      const m = /[?&]uddg=([^&]+)/.exec(href);
      if (m) href = decodeURIComponent(m[1]);
      else if (href.startsWith('//')) href = 'https:' + href;
      if (!/^https?:/i.test(href)) continue;
      results.push({ title: textOf(a), url: href, snippet: textOf(r.querySelector('.result__snippet')) });
      if (results.length >= n) break;
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  if (!results.length) {
    try {
      const doc = await searchPage(`https://www.bing.com/search?q=${q}`, signal);
      for (const r of doc.querySelectorAll('li.b_algo')) {
        const a = r.querySelector('h2 a');
        const href = bingUrl(a?.getAttribute('href') || '');
        if (!/^https?:/i.test(href)) continue;
        results.push({ title: textOf(a), url: href, snippet: textOf(r.querySelector('.b_caption p')) });
        if (results.length >= n) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }
  if (!results.length) {
    return `No results could be fetched (the search engines may be blocking automated requests). Instead, open_tab a search URL such as https://duckduckgo.com/?q=${q} and read_page it.`;
  }
  return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}${r.snippet ? '\n' + r.snippet : ''}`).join('\n\n');
}

/* ---------- tools ---------- */

const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const TAB = { tab_id: { type: 'integer' } };
const EL = {
  id: { type: 'integer', description: 'Element id from read_page' },
  selector: { type: 'string', description: 'CSS selector (instead of id)' },
};
const SOURCE = { type: 'string', description: 'img_N, "screenshot", "element:<id>" or an image URL' };

export const TOOLS = [
  {
    name: 'list_tabs',
    description: 'List open tabs with their ids.',
    parameters: obj({}),
    run: async (args, ctx) => {
      const tabs = await chrome.tabs.query({});
      const multi = new Set(tabs.map((t) => t.windowId)).size > 1;
      return tabs
        .map((t) => {
          const marks = [t.active && 'active', t.id === ctx.tabId && 'current'].filter(Boolean);
          return `id=${t.id}${marks.length ? ` [${marks.join(', ')}]` : ''}${multi ? ` window=${t.windowId}` : ''} "${t.title || ''}" ${t.url || t.pendingUrl || ''}`;
        })
        .join('\n');
    },
  },
  {
    name: 'open_tab',
    description: 'Open a URL in a new tab and make it the current tab.',
    parameters: obj({ url: { type: 'string' }, background: { type: 'boolean', description: "Don't switch the user's view to it" } }, ['url']),
    run: async (args, ctx) => {
      const url = withScheme(args.url);
      const t = await chrome.tabs.create({ url, active: !args.background, ...(ctx.windowId != null ? { windowId: ctx.windowId } : {}) });
      ctx.tabId = t.id;
      await settle(t.id, 350, 20000, ctx.signal);
      return `Opened tab id=${t.id}${args.background ? ' in the background' : ''}; it is now the current tab.\n${await pageLine(t.id)}`;
    },
  },
  {
    name: 'switch_tab',
    description: 'Make a tab the current tab and show it.',
    parameters: obj({ tab_id: { type: 'integer' } }, ['tab_id']),
    run: async (args, ctx) => {
      const id = Number(args.tab_id);
      await chrome.tabs.update(id, { active: true }).catch(rethrow);
      ctx.tabId = id;
      return `Switched to tab id=${id}.\n${await pageLine(id)}`;
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab.',
    parameters: obj({ tab_id: { type: 'integer' } }, ['tab_id']),
    mutating: () => true,
    run: async (args, ctx) => {
      const id = Number(args.tab_id);
      await chrome.tabs.remove(id).catch(rethrow);
      if (Number(ctx.tabId) === id) {
        ctx.tabId = null;
        return `Closed tab id=${id}. It was the current tab; page tools now use the active tab.`;
      }
      return `Closed tab id=${id}.`;
    },
  },
  {
    name: 'navigate',
    description: 'Go to a URL in the current tab, or go back/forward/reload.',
    parameters: obj({ url: { type: 'string' }, action: { type: 'string', enum: ['back', 'forward', 'reload'] }, ...TAB }),
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const action = { back: 'back', forward: 'forward', reload: 'reload', refresh: 'reload' }[String(args.action || '').toLowerCase()];
      if (!action && !has(args.url)) throw new Error('Provide url or action.');
      return acting(
        tabId,
        ctx,
        async () => {
          if (action === 'back') {
            // Chrome refuses to go back to a tab's first page if nothing ever interacted with it; the page itself still can.
            await chrome.tabs.goBack(tabId).catch(async (e) => {
              if (!(await inject(tabId, () => history.length > 1 && (history.back(), true)))) rethrow(e);
            });
          }
          else if (action === 'forward') await chrome.tabs.goForward(tabId).catch(rethrow);
          else if (action === 'reload') await chrome.tabs.reload(tabId).catch(rethrow);
          else {
            const url = withScheme(args.url);
            await chrome.tabs.update(tabId, { url }).catch(rethrow);
            return `Navigated to ${url}.`;
          }
          return `Done: ${action}.`;
        },
        20000
      );
    },
  },
  {
    name: 'read_page',
    description:
      'Read the page as text. [12:button "Save"] = interactive element with id 12 (pass it to click, type_text, …); [7:link> … <7] wraps a clickable region; [9:image "alt" WxH] = image, usable as source "element:9".',
    parameters: obj({
      offset: { type: 'integer', description: 'Start at this character (pagination)' },
      max_chars: { type: 'integer' },
      filter: { type: 'string', description: 'Only lines containing this text' },
      include_links: { type: 'boolean', description: 'Show link URLs' },
      ...TAB,
    }),
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const filter = String(args.filter ?? '');
      const r = await inject(tabId, pageRead, {
        offset: Math.max(0, Number(args.offset) || 0),
        maxChars: Math.min(Number(args.max_chars) || 12000, room(ctx)),
        filter,
        includeLinks: !!args.include_links,
      });
      if (!r) throw new Error('No response from page.');
      if (r.error) throw new Error(r.error);
      const lines = [`Page: "${r.title || ''}" — ${r.url}`, `Scroll: ${r.scrollY} of ${r.scrollMax}px${filter ? ` | lines containing "${filter}"` : ''}`, ''];
      lines.push(r.text || (filter ? '(no lines match the filter)' : r.offset ? '(no more text)' : '(no visible text)'));
      const end = r.offset + r.text.length;
      if (r.more) lines.push('', `[showing chars ${r.offset}–${end} of ${r.total}; call read_page with offset=${end} for more, or use filter]`);
      else if (r.offset > 0) lines.push('', `[showing chars ${r.offset}–${end} of ${r.total} (end)]`);
      return lines.join('\n');
    },
  },
  {
    name: 'click',
    description: 'Click an element (id or selector), or a viewport point (x, y).',
    parameters: obj({ ...EL, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' }, ...TAB }),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const xy = has(args.x) && has(args.y);
      const t = target(args, !xy);
      return acting(tabId, ctx, async () => {
        if (ctx.settings.trustedInput) {
          let x = Number(args.x);
          let y = Number(args.y);
          let desc = `point (${x}, ${y})`;
          if (t.id != null || t.selector) ({ x, y, desc } = await act(tabId, { ...t, type: 'locate' }));
          await cdpClick(tabId, x, y, args.double ? 2 : 1);
          return `Clicked ${desc}.`;
        }
        const where = t.id != null || t.selector ? t : { x: Number(args.x), y: Number(args.y) };
        const r = await act(tabId, { ...where, type: 'click', double: !!args.double });
        return `Clicked ${r.desc}.`;
      });
    },
  },
  {
    name: 'type_text',
    description: 'Type into an input, textarea or editable element. Replaces its text unless clear=false.',
    parameters: obj({ ...EL, text: { type: 'string' }, clear: { type: 'boolean' }, press_enter: { type: 'boolean' }, ...TAB }, ['text']),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args);
      const text = String(args.text ?? '');
      const clear = args.clear !== false;
      const enter = !!args.press_enter;
      return acting(tabId, ctx, async () => {
        let desc;
        if (ctx.settings.trustedInput) {
          desc = (await act(tabId, { ...t, type: 'focus', clear })).desc;
          if (text) await cdpInsertText(tabId, text);
          else if (clear) await cdpKey(tabId, 'Backspace');
          if (enter) await cdpKey(tabId, 'Enter');
        } else {
          desc = (await act(tabId, { ...t, type: 'type', text, clear, enter })).desc;
        }
        return `Typed "${short(text)}" into ${desc}${enter ? ' and pressed Enter' : ''}.`;
      });
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option of a <select> by value or visible text.',
    parameters: obj({ ...EL, value: { type: 'string' }, ...TAB }, ['value']),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args);
      return acting(tabId, ctx, async () => `Selected ${(await act(tabId, { ...t, type: 'select', value: String(args.value ?? '') })).desc}.`);
    },
  },
  {
    name: 'press_key',
    description: 'Press a key (Enter, Escape, Tab, ArrowDown, a, …) on an element, or on the focused element.',
    parameters: obj(
      { key: { type: 'string' }, ...EL, ctrl: { type: 'boolean' }, shift: { type: 'boolean' }, alt: { type: 'boolean' }, meta: { type: 'boolean' }, ...TAB },
      ['key']
    ),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args, false);
      const { key, mods } = parseKey(args);
      const label = [...Object.keys(mods).filter((m) => mods[m]), key === ' ' ? 'Space' : key].join('+');
      return acting(tabId, ctx, async () => {
        if (ctx.settings.trustedInput) {
          let desc = 'the focused element';
          if (t.id != null || t.selector) desc = (await act(tabId, { ...t, type: 'focus', clear: false })).desc;
          await cdpKey(tabId, key, mods);
          return `Pressed ${label} on ${desc}.`;
        }
        return `Pressed ${label} on ${(await act(tabId, { ...t, type: 'key', key, mods })).desc}.`;
      });
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page, or a scrollable element. With an element and no direction, scrolls it into view.',
    parameters: obj({
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
      amount: { type: 'number', description: 'Pixels (default: about one screen)' },
      ...EL,
      ...TAB,
    }),
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args, false);
      const r = await act(tabId, { ...t, type: 'scroll', direction: args.direction || undefined, amount: args.amount });
      const what = !args.direction && (t.id != null || t.selector) ? `${r.desc} into view` : `${args.direction || 'down'}${r.desc !== 'page' ? ' inside ' + r.desc : ''}`;
      return `Scrolled ${what}. Scroll position: ${r.scrollY} of ${r.scrollMax}px.`;
    },
  },
  {
    name: 'hover',
    description: 'Move the mouse over an element (opens hover menus and tooltips).',
    parameters: obj({ ...EL, ...TAB }),
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args);
      if (ctx.settings.trustedInput) {
        // CSS :hover only reacts to real pointer movement.
        const r = await act(tabId, { ...t, type: 'locate' });
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
        return `Hovered over ${r.desc}.`;
      }
      return `Hovered over ${(await act(tabId, { ...t, type: 'hover' })).desc}.`;
    },
  },
  {
    name: 'wait',
    description: 'Wait some seconds, or until text or a CSS selector appears on the page.',
    parameters: obj({
      seconds: { type: 'number' },
      for_text: { type: 'string' },
      for_selector: { type: 'string' },
      timeout: { type: 'number', description: 'Seconds (default 10)' },
      ...TAB,
    }),
    run: async (args, ctx) => {
      if (!has(args.for_text) && !has(args.for_selector)) {
        const s = Math.min(Math.max(Number(args.seconds) || 2, 0), 30);
        await pause(s * 1000, ctx.signal);
        return `Waited ${s}s.`;
      }
      const tabId = await tabOf(args, ctx);
      const check = has(args.for_selector) ? { type: 'check', selector: String(args.for_selector) } : { type: 'check', text: String(args.for_text) };
      const what = check.selector ? `selector ${check.selector}` : `text "${check.text}"`;
      const secs = Math.min(Number(args.timeout) || 10, 60);
      const end = Date.now() + secs * 1000;
      let last = '';
      for (;;) {
        try {
          if ((await act(tabId, check)).found) return `Found ${what}.\n${await pageLine(tabId)}`;
        } catch (e) {
          // Pages mid-navigation can't be scripted for a moment; only give up on errors that won't heal.
          if (/Invalid CSS selector|no longer exists|cannot be automated/.test(e.message)) throw e;
          last = e.message;
        }
        if (Date.now() >= end) throw new Error(`Timed out after ${secs}s waiting for ${what}.${last ? ' Last error: ' + last : ''}`);
        await pause(400, ctx.signal);
      }
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the visible part of the current tab as an image.',
    parameters: obj({ ...TAB }),
    run: async (args, ctx) => {
      if (!ctx.vision()) return 'Vision is unavailable for this model — use read_page instead.';
      const { dataUrl, scale } = await capture(await tabOf(args, ctx));
      return {
        text: `Screenshot of the visible viewport. To click by coordinates, multiply image pixel coordinates by ${+scale.toFixed(3)}.`,
        images: [dataUrl],
      };
    },
  },
  {
    name: 'run_javascript',
    description: 'Run JavaScript in the page. Runs as an async function body: use `return` for a value (a single expression also works).',
    parameters: obj({ code: { type: 'string' }, ...TAB }, ['code']),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      // A trailing ';' would stop `document.title;` from being evaluated as an expression.
      const code = String(args.code ?? '').replace(/;\s*$/, '');
      let r = await inject(tabId, mainEval, code, 'MAIN');
      if (r?.csp) r = await cdpEval(tabId, code);
      if (!r) throw new Error('No response from page.');
      if (r.error) throw new Error(r.error);
      return r.result ?? 'undefined';
    },
  },
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs and snippets.',
    parameters: obj({ query: { type: 'string' }, max_results: { type: 'integer' } }, ['query']),
    run: async (args, ctx) => webSearch(String(args.query ?? ''), Math.min(Number(args.max_results) || 8, 20), ctx.signal),
  },
  {
    name: 'fetch_url',
    description: "Fetch a URL without opening a tab (uses the browser's cookies). HTML is converted to text.",
    parameters: obj(
      {
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'string' },
        offset: { type: 'integer' },
        max_chars: { type: 'integer' },
      },
      ['url']
    ),
    mutating: (a) => !['GET', 'HEAD'].includes(String(a.method || 'GET').toUpperCase()),
    run: async (args, ctx) => {
      const url = withScheme(args.url);
      const method = String(args.method || 'GET').toUpperCase();
      const init = { method, credentials: 'include', signal: ctx.signal, headers: safeParse(args.headers, {}) };
      if (has(args.body) && !['GET', 'HEAD'].includes(method)) init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error(`Could not fetch ${url} (${e.message}).`);
      }
      const type = res.headers.get('content-type') || '';
      const head = `HTTP ${res.status}${res.url && res.url !== url ? ` (redirected to ${res.url})` : ''} — ${type || 'unknown type'}`;
      if (/^image\//i.test(type)) {
        const a = ctx.addAsset(await blobToDataUrl(await res.blob()), 'fetched');
        return `${head}\nSaved the image as ${a.id} (shown to the user). Use it as source in view_image / upload_file / download / edit_image.`;
      }
      if (type && !/^text\/|json|xml|javascript|ecmascript|csv|yaml|urlencoded/i.test(type)) {
        return `${head}\n(${(await res.blob()).size} bytes of binary content, not shown)`;
      }
      let text = await res.text();
      if (/html/i.test(type) || (!type && /^\s*<(!doctype|html)/i.test(text))) text = htmlToText(text);
      const off = Math.max(0, Number(args.offset) || 0);
      const max = Math.min(Number(args.max_chars) || 12000, room(ctx));
      const part = text.slice(off, off + max);
      let out = `${head}\n\n${part || (off ? '(no more text)' : '(empty body)')}`;
      if (off + max < text.length) out += `\n\n[showing chars ${off}–${off + part.length} of ${text.length}; call fetch_url with offset=${off + part.length} for more]`;
      return out;
    },
  },
  {
    name: 'generate_image',
    description: 'Create an image from a text prompt.',
    parameters: obj({ prompt: { type: 'string' }, size: { type: 'string', description: 'e.g. 1024x1024' } }, ['prompt']),
    run: async (args, ctx) => assetResult(await makeImages(ctx, String(args.prompt ?? ''), null, args.size), 'generated', ctx),
  },
  {
    name: 'edit_image',
    description: 'Edit an image as described by the prompt.',
    parameters: obj({ prompt: { type: 'string' }, source: SOURCE }, ['prompt', 'source']),
    run: async (args, ctx) => {
      imageApi(ctx); // fail fast before capturing or fetching the source
      const png = await toPng(await resolveSource(args.source, ctx));
      return assetResult(await makeImages(ctx, String(args.prompt ?? ''), png), 'edited', ctx);
    },
  },
  {
    name: 'view_image',
    description: 'Look at an image.',
    parameters: obj({ source: SOURCE }, ['source']),
    run: async (args, ctx) => {
      if (!ctx.vision()) return 'Vision is unavailable for this model, so images cannot be viewed. Use read_page or image alt text instead.';
      const p = await preview(await resolveSource(args.source, ctx));
      return { text: `Image ${args.source} (${p.origWidth}x${p.origHeight}px).`, images: [p.dataUrl] };
    },
  },
  {
    name: 'upload_file',
    description: 'Put an image into a file input (target the input or its container).',
    parameters: obj({ ...EL, source: SOURCE, filename: { type: 'string' }, ...TAB }, ['source']),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args);
      const dataUrl = await resolveSource(args.source, ctx, tabId);
      const name = has(args.filename) ? String(args.filename) : `image.${extOf(mimeOf(dataUrl))}`;
      const r = await act(tabId, { ...t, type: 'upload', files: [{ dataUrl, name }] });
      return `Uploaded ${name} to ${r.desc}.`;
    },
  },
  {
    name: 'set_page_image',
    description: 'Replace an image on the page (visual preview only, not saved to the site).',
    parameters: obj({ ...EL, source: SOURCE, ...TAB }, ['source']),
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args);
      const dataUrl = await resolveSource(args.source, ctx, tabId);
      const r = await act(tabId, { ...t, type: 'set_image', dataUrl });
      return `Replaced the image of ${r.desc}. This is a visual preview only — nothing was saved to the site (use upload_file to really upload).`;
    },
  },
  {
    name: 'download',
    description: "Save an image or a file URL to the user's Downloads folder.",
    parameters: obj({ source: SOURCE, filename: { type: 'string' } }, ['source']),
    mutating: () => true,
    run: async (args, ctx) => {
      const s = String(args.source ?? '').trim();
      const url = /^https?:\/\//i.test(s) ? s : await resolveSource(s, ctx);
      let filename = has(args.filename) ? String(args.filename) : '';
      if (!filename && url.startsWith('data:')) filename = `${/^img_\d+$/i.test(s) ? s.toLowerCase() : 'image'}.${extOf(mimeOf(url))}`;
      // chrome.downloads rejects absolute paths, '..' and reserved characters.
      filename = filename.replace(/[<>:"|?*\\\x00-\x1f]/g, '_').replace(/\.\.+/g, '.').replace(/^[/.]+/, '');
      const id = await chrome.downloads.download({ url, ...(filename ? { filename } : {}) });
      return `Download started (id ${id})${filename ? ` as ${filename}` : ''}.`;
    },
  },
];

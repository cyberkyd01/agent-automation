import { api } from './host/api.js';
import { cdp, cdpClick, cdpInsertText, cdpKey, cdpEval, hasDebugger, NO_DEBUGGER } from './cdp.js';
import { sleep, pause, blobToDataUrl, httpError, safeParse, mimeOf, withExt } from './util.js';
import { extractText, formatBytes, guessMime, MAX_ATTACH_BYTES, MAX_DATA_URL_BYTES, assetBlob, assetDataUrl, bytesToBase64, toBlob } from './files.js';
import { generateImage, editImage, imageReady } from './image.js';

/* ---------- page plumbing ---------- */

const RESTRICTED = 'This page cannot be automated (browser-internal or restricted page). Use navigate/open_tab to go to a regular website.';
const GONE = 'That tab no longer exists. Use list_tabs.';
const NAVIGATED = 'The page navigated or reloaded during the action. Call read_page to see the new state.';

function friendly(e) {
  const m = String(e?.message || e);
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery/i.test(m)) return RESTRICTED;
  // Firefox says this for its own and other extensions' pages, and for every site while the user has not given
  // the extension access to websites (the panel then shows an "Allow access" banner).
  if (/Missing host permission/i.test(m)) return `${RESTRICTED} If it is a normal website, Firefox has not given Agent Automation access to websites: ask the user to click "Allow access" in the panel.`;
  if (/No tab with id|Invalid tab ID/i.test(m)) return GONE;
  // Firefox before 152 (and after some updates) does not count "access to all websites" for screenshots of MV3
  // add-ons; it allows them on a tab where the user clicked the toolbar button or pressed the shortcut.
  if (/Missing activeTab permission/i.test(m)) return 'Firefox did not allow a screenshot of this tab. Ask the user to click the Agent Automation toolbar button (or press its shortcut) while this tab is shown, then try again; or use read_page.';
  if (/showing error page/i.test(m)) return 'The page failed to load (the browser is showing an error page). Check the URL or try again.';
  if (/Frame with ID|frame.*removed/i.test(m)) return NAVIGATED;
  return m;
}

const rethrow = (e) => {
  throw new Error(friendly(e));
};

// funcName: an export of page.js (only those can be injected from the offscreen document).
async function inject(tabId, funcName, arg, world = 'ISOLATED') {
  try {
    const [res] = await api.scripting.executeScript({ target: { tabId }, funcName, args: [arg ?? {}], world });
    return res?.result;
  } catch (e) {
    rethrow(e);
  }
}

async function act(tabId, action) {
  const r = await inject(tabId, 'pageAct', action);
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
  let [t] = ctx.windowId != null ? await api.tabs.query({ active: true, windowId: ctx.windowId }) : [];
  if (!t) [t] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('No active tab. Use open_tab.');
  ctx.tabId = t.id;
  return Number(t.id);
}

async function settle(tabId, ms = 350, max = 12000, signal) {
  await pause(ms, signal);
  const end = Date.now() + max;
  while (Date.now() < end) {
    const t = await api.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'complete') return;
    await pause(150, signal);
  }
}

async function pageLine(tabId) {
  const t = await api.tabs.get(tabId).catch(() => null);
  return t ? `Page now: "${t.title || ''}" — ${t.url || t.pendingUrl || ''}` : 'The tab is gone (it was closed).';
}

// Runs a page-changing action, waits for the page to settle and reports where we ended up.
async function acting(tabId, ctx, fn, max = 12000) {
  const before = new Set((await api.tabs.query({})).map((t) => t.id));
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
  for (const t of await api.tabs.query({})) {
    if (!before.has(t.id)) lines.push(`New tab opened: id=${t.id} ${t.pendingUrl || t.url} (use switch_tab to work in it)`);
  }
  return lines.join('\n');
}

// Trusted input events go through Chrome's debugger. Firefox has none: there the setting is ignored, and says so.
const trusted = (ctx) => Boolean(ctx.settings.trustedInput) && hasDebugger();
const untrustedNote = (ctx) => (ctx.settings.trustedInput && !hasDebugger() ? `\nNote: trusted input events are ${NO_DEBUGGER}; a normal page event was used.` : '');

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

// fetch_url reads at most this much of a text response.
const FETCH_TEXT_BYTES = 32 * 1024 * 1024;

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

// `src`: a Blob or a (data:) URL.
async function decodeImage(src) {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  try {
    return await createImageBitmap(blob);
  } catch {
    // SVG (and a few other formats) only decode through an <img>.
    const url = typeof src === 'string' ? src : URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      if (url !== src) URL.revokeObjectURL(url);
    }
  }
}

// Re-encodes an image (a Blob or data URL), scaling it down to maxW (and maxSide for the longer side).
// Returns the input as is when nothing would change and it is small, unless `force`.
async function encode(src, { maxW = Infinity, maxSide = Infinity, type = 'image/jpeg', quality = 0.8, force = false } = {}) {
  const img = await decodeImage(src);
  const w0 = img.naturalWidth || img.width || 512;
  const h0 = img.naturalHeight || img.height || 512;
  const k = Math.min(1, maxW / w0, maxSide / Math.max(w0, h0));
  const same = typeof src === 'string' ? src.startsWith(`data:${type}`) : src.type === type && src.size <= 4e6;
  if (k === 1 && !force && same) {
    img.close?.();
    return { dataUrl: typeof src === 'string' ? src : await blobToDataUrl(src), width: w0, height: h0, origWidth: w0, origHeight: h0 };
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

const toPng = async (src) => (await encode(src, { type: 'image/png' })).dataUrl;
const preview = (src) => encode(src, { maxW: 1024 });

const MODEL_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

// An image attachment as a provider will accept it (a data URL): PNG/JPEG/GIF/WebP of a few MB at most.
// Other formats and very large files are re-encoded; null when that is impossible.
export async function modelImage(asset) {
  const mime = assetMime(asset);
  const blob = assetBlob(asset);
  if (MODEL_IMAGE.test(mime) && blob.size <= 4e6) return assetDataUrl(asset);
  try {
    return (await encode(toBlob(blob, mime), { maxSide: 2048, quality: 0.85, force: true })).dataUrl;
  } catch {
    return MODEL_IMAGE.test(mime) && blob.size <= MAX_DATA_URL_BYTES ? assetDataUrl(asset) : null;
  }
}

export async function capture(tabId) {
  const tab = await api.tabs.get(tabId).catch(rethrow);
  if (!tab.active) {
    await api.tabs.update(tabId, { active: true });
    await sleep(250);
  }
  let shot;
  for (let i = 0; ; i++) {
    try {
      shot = await api.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
      break;
    } catch (e) {
      // Chrome allows only ~2 captures per second.
      if (i < 2 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(e.message)) await sleep(600);
      else rethrow(e);
    }
  }
  const img = await encode(shot, { maxW: 1280, quality: 0.75 });
  // tab.width is in device-independent px; page zoom makes CSS px larger than that.
  const zoom = await api.tabs.getZoom(tabId).catch(() => 1);
  return { dataUrl: img.dataUrl, scale: tab.width / (zoom || 1) / img.width };
}

export async function toDataUrl(url, signal) {
  if (url.startsWith('data:')) return url;
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw await httpError(res);
  return blobToDataUrl(await res.blob());
}

/* ---------- files and assets ---------- */

const tooBig = (n) => `The file is too large (${n > MAX_ATTACH_BYTES ? formatBytes(n) : `over ${formatBytes(MAX_ATTACH_BYTES)}`}; the limit is ${formatBytes(MAX_ATTACH_BYTES)}).`;
const SLICE_BYTES = 8 * 1024 * 1024;

// A response body as a Blob, collected a few MB at a time. Stops downloading as soon as it passes
// MAX_ATTACH_BYTES: → { blob } or { tooBig: bytes seen }.
async function readBody(res) {
  const type = res.headers.get('content-type') || '';
  const len = Number(res.headers.get('content-length'));
  if (len > MAX_ATTACH_BYTES) {
    res.body?.cancel().catch(() => {});
    return { tooBig: len };
  }
  if (!res.body?.getReader) {
    const blob = await res.blob();
    return blob.size > MAX_ATTACH_BYTES ? { tooBig: blob.size } : { blob };
  }
  const reader = res.body.getReader();
  const parts = [];
  let group = [];
  let groupSize = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ATTACH_BYTES) {
      reader.cancel().catch(() => {});
      return { tooBig: total };
    }
    group.push(value);
    groupSize += value.length;
    if (groupSize >= SLICE_BYTES) {
      parts.push(new Blob(group));
      group = [];
      groupSize = 0;
    }
  }
  if (group.length) parts.push(new Blob(group));
  return { blob: new Blob(parts, { type }) };
}

// A file name for a fetched resource: Content-Disposition, else the URL's last path segment; always with an extension.
function nameFor(url, mime, disposition = '') {
  const m = /filename\*\s*=\s*(?:[\w-]+'[^']*')?"?([^";]+)"?/i.exec(disposition) || /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  let name = m ? m[1].trim() : '';
  try {
    name = decodeURIComponent(name || new URL(url).pathname.split('/').pop() || '');
  } catch {}
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(-120);
  if (!name || /^[._]+$/.test(name)) name = 'download';
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) name = withExt(name, mime);
  return name;
}

async function looksTextual(blob) {
  const b = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return false; // %PDF
  if (b[0] === 0x50 && b[1] === 0x4b) return false; // zip, and so Office documents
  return !b.includes(0);
}

async function fetchFile(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw await httpError(res);
  const { blob, tooBig: n } = await readBody(res);
  if (!blob) throw new Error(tooBig(n));
  let mime = (blob.type || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const name = nameFor(res.url || url, mime, res.headers.get('content-disposition') || '');
  if (mime === 'application/octet-stream') mime = guessMime(name, mime);
  return { blob: toBlob(blob, mime), name, mime };
}

const ASSET_ID = /^(img|file)[_\s-]?(\d+)$/i;

const assetMime = (a) => a.mime || a.blob?.type || mimeOf(a.dataUrl);
const assetName = (a) => a.name || withExt(a.id, assetMime(a));

function findAsset(s, ctx) {
  const m = ASSET_ID.exec(s);
  if (!m) return null;
  const id = `${m[1].toLowerCase()}_${m[2]}`;
  const a = ctx.getAsset(id);
  if (a) return a;
  const ids = (ctx.listAssets?.() || []).map((x) => x.id);
  const list = ids.length > 40 ? [...ids.slice(0, 40), '…'] : ids;
  throw new Error(`There is no asset ${id}. ${ids.length ? `Available assets: ${list.join(', ')}.` : 'This chat has no assets yet.'}`);
}

// A tool's `source`: an asset id, "screenshot", "element:<id>", a data: URL or a web URL → { blob, name?, mime, asset? }.
async function resolveFile(source, ctx, tabId) {
  const s = String(source ?? '').trim();
  const asset = findAsset(s, ctx);
  if (asset) return { blob: assetBlob(asset), name: assetName(asset), mime: assetMime(asset), asset };
  if (s.toLowerCase() === 'screenshot') {
    const { dataUrl } = await capture(tabId ?? (await tabOf({}, ctx)));
    return { blob: toBlob(dataUrl), name: 'screenshot.jpg', mime: 'image/jpeg' };
  }
  const el = /^(?:element:\s*)?(\d+)$/i.exec(s);
  if (el) {
    const r = await act(tabId ?? (await tabOf({}, ctx)), { type: 'image_src', id: el[1] });
    return r.src.startsWith('data:') ? { blob: toBlob(r.src), mime: mimeOf(r.src) } : fetchFile(r.src, ctx.signal);
  }
  if (s.startsWith('data:')) return { blob: toBlob(s), mime: mimeOf(s) };
  if (/^https?:\/\//i.test(s)) return fetchFile(s, ctx.signal);
  throw new Error('Invalid source. Use an asset id (img_1, file_1), "screenshot", "element:<id>" from read_page, or a URL.');
}

// resolveFile for tools that need an image; returns it as a Blob of its image type.
async function resolveSource(source, ctx, tabId) {
  const f = await resolveFile(source, ctx, tabId);
  if (/^image\//.test(f.mime) || (!f.asset && f.mime === 'application/octet-stream')) return toBlob(f.blob, f.mime);
  throw new Error(
    f.asset
      ? `${f.asset.id} ("${f.name}") is not an image (${f.mime}). Use read_file to read it, or upload_file / download.`
      : `That source is not an image (${f.mime}). Use read_file or fetch_url for other files.`
  );
}

async function readText(file) {
  try {
    const r = await extractText(file);
    return { kind: r?.kind || 'binary', text: String(r?.text || ''), note: r?.note || '' };
  } catch (e) {
    return { kind: 'binary', text: '', note: `The file could not be read (${e?.message || e}).` };
  }
}

// Extracted text per asset (keyed by its Blob), least recently used first out once the total passes the
// budget: paging through a big PDF or CSV, or the next run's <attachments> block, must not re-extract it.
const TEXT_CACHE_CHARS = 64 * 1024 * 1024;
const TEXT_CACHE_ENTRIES = 64;
const texts = new Map(); // Blob → { p, chars }
let textChars = 0;

function trimTexts() {
  for (const [k, e] of texts) {
    if ((textChars <= TEXT_CACHE_CHARS && texts.size <= TEXT_CACHE_ENTRIES) || texts.size <= 1) break;
    texts.delete(k);
    textChars -= e.chars;
  }
}

// Never rejects.
export function assetText(asset) {
  let blob;
  try {
    blob = assetBlob(asset);
  } catch (e) {
    return Promise.resolve({ kind: 'binary', text: '', note: e.message });
  }
  const hit = texts.get(blob);
  if (hit) {
    texts.delete(blob);
    texts.set(blob, hit);
    return hit.p;
  }
  const entry = { p: null, chars: 0 };
  entry.p = readText({ blob, name: assetName(asset), mime: assetMime(asset) }).then((x) => {
    if (texts.get(blob) === entry) {
      entry.chars = x.text.length;
      textChars += entry.chars;
      trimTexts();
    }
    return x;
  });
  texts.set(blob, entry);
  return entry.p;
}

/* ---------- files into pages, files to Downloads ---------- */

// Raw bytes per executeScript call (base64 makes the message 4/3 of that). Measured with 100 MB in Chrome:
// 8 MB is no faster than 4 MB and leaves more garbage behind in the page between collections.
const CHUNK_BYTES = 4 * 1024 * 1024;
const DROP_MS = 5000;

// Sends a Blob into the page's isolated world CHUNK_BYTES at a time (each executeScript message stays small),
// runs fn(transfer) — a pageAct call that takes the file — and always clears the page-side buffer afterwards,
// on success, error or Stop.
async function withTransfer(tabId, blob, info, signal, fn) {
  const key = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try {
    const n = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
    for (let i = 0; i < n; i++) {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(await blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer());
      const r = await inject(tabId, 'pageChunk', { key, index: i, b64: bytesToBase64(bytes) });
      if (!r) throw new Error('No response from page.');
      if (r.error) throw new Error(r.error);
    }
    signal?.throwIfAborted();
    return await fn({ key, name: info.name, mime: info.mime, size: blob.size });
  } finally {
    await Promise.race([inject(tabId, 'pageChunk', { op: 'drop', key }).catch(() => {}), sleep(DROP_MS)]);
  }
}

// Object URLs handed to chrome.downloads are revoked once Chrome has the file (or gave up), or after a while.
const DOWNLOAD_URL_MS = 10 * 60 * 1000;
const downloadUrls = new Map(); // download id → release()
let watchingDownloads = false;

function watchDownloads() {
  if (watchingDownloads) return;
  watchingDownloads = true;
  api.events.on('downloads.changed', (d) => {
    const state = d.state?.current;
    if (state === 'complete' || state === 'interrupted') downloadUrls.get(d.id)?.();
  });
}

function revokeWhenDone(id, url) {
  let timer = 0;
  const release = () => {
    clearTimeout(timer);
    downloadUrls.delete(id);
    URL.revokeObjectURL(url);
  };
  timer = setTimeout(release, DOWNLOAD_URL_MS);
  downloadUrls.set(id, release);
  // It may have finished before we knew its id.
  Promise.resolve(api.downloads.search({ id }))
    .then((items) => {
      const st = items?.[0]?.state;
      if (st === 'complete' || st === 'interrupted') release();
    })
    .catch(() => {});
}

// One page of a long text, with read_page-style pagination notes. `next(end)` says how to get more.
function paginate(text, args, ctx, next) {
  const off = Math.max(0, Number(args.offset) || 0);
  const max = Math.min(Number(args.max_chars) || 12000, room(ctx));
  const part = text.slice(off, off + max);
  const end = off + part.length;
  if (!part) return off ? `(no more text: it is ${text.length} characters long)` : '(empty)';
  const out = [part];
  if (end < text.length) out.push('', `[showing chars ${off}–${end} of ${text.length}; ${next(end)} for more]`);
  else if (off > 0) out.push('', `[showing chars ${off}–${end} of ${text.length} (end)]`);
  return out.join('\n');
}

/* ---------- image generation ---------- */

// The active chat provider, for the 'chat-model' image vendor (and resolved by src/image.js for 'openai').
const activeProviderOf = (ctx) => (ctx.settings.providers || []).find((p) => p.id === ctx.settings.activeProviderId) || null;

// Throws the readable "not configured" reason (which names Settings → Images) before any source is captured.
function requireImage(ctx) {
  const r = imageReady(ctx.settings);
  if (!r.ok) throw new Error(r.reason || 'No image model configured — open Settings → Images and choose a vendor.');
}

async function assetResult(urls, label, ctx) {
  const assets = urls.map((u) => ctx.addAsset(u, label));
  const images = [];
  if (ctx.vision()) for (const a of assets) images.push((await preview(toBlob(assetBlob(a), a.mime))).dataUrl);
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
const FILE_SOURCE = { type: 'string', description: 'Asset id (file_N or img_N), "screenshot", "element:<id>" or a URL' };

const tabLine = (t, ctx) => `id=${t.id}${t.id === ctx.tabId ? ' [current]' : ''} "${t.title || ''}" ${t.url || t.pendingUrl || ''}`;

// Tabs whose title or URL contains the query (case-insensitive); failing that, those containing every word of it.
function matchTabs(tabs, query) {
  const q = query.toLowerCase();
  const hay = (t) => `${t.title || ''}\n${t.url || t.pendingUrl || ''}`.toLowerCase();
  let hits = tabs.filter((t) => hay(t).includes(q));
  const words = q.split(/\s+/).filter(Boolean);
  if (!hits.length && words.length > 1) hits = tabs.filter((t) => words.every((w) => hay(t).includes(w)));
  return hits;
}

export const TOOLS = [
  {
    name: 'list_tabs',
    group: 'browser',
    description: 'List open tabs with their ids.',
    parameters: obj({}),
    run: async (args, ctx) => {
      const tabs = await api.tabs.query({});
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
    group: 'browser',
    description: 'Open a URL in a new tab and make it the current tab.',
    parameters: obj({ url: { type: 'string' }, background: { type: 'boolean', description: "Don't switch the user's view to it" } }, ['url']),
    run: async (args, ctx) => {
      const url = withScheme(args.url);
      const t = await api.tabs.create({ url, active: !args.background, ...(ctx.windowId != null ? { windowId: ctx.windowId } : {}) });
      ctx.tabId = t.id;
      await settle(t.id, 350, 20000, ctx.signal);
      return `Opened tab id=${t.id}${args.background ? ' in the background' : ''}; it is now the current tab.\n${await pageLine(t.id)}`;
    },
  },
  {
    name: 'switch_tab',
    group: 'browser',
    description: 'Make a tab the current tab and show it. Give tab_id, or query: text in the tab title or URL.',
    parameters: obj({ tab_id: { type: 'integer' }, query: { type: 'string', description: 'Text in the title or URL' } }),
    run: async (args, ctx) => {
      let id;
      let others = '';
      const query = String(args.query ?? '').trim();
      if (has(args.tab_id)) id = Number(args.tab_id);
      else if (query) {
        const tabs = await api.tabs.query({});
        let hits = /^\d+$/.test(query) ? tabs.filter((t) => t.id === Number(query)) : [];
        if (!hits.length) hits = matchTabs(tabs, query);
        if (!hits.length) {
          const list = tabs.slice(0, 50).map((t) => tabLine(t, ctx));
          throw new Error(`No tab matches "${query}". Open tabs:\n${list.join('\n')}`);
        }
        // Prefer the panel's window, then the most recently used tab.
        const inWin = (t) => (t.windowId === ctx.windowId ? 1 : 0);
        hits.sort((a, b) => inWin(b) - inWin(a) || (b.lastAccessed || 0) - (a.lastAccessed || 0) || (b.active ? 1 : 0) - (a.active ? 1 : 0));
        id = hits[0].id;
        if (hits.length > 1) {
          const rest = hits.slice(1, 11).map((t) => tabLine(t, ctx));
          others = `\n${hits.length - 1} other tab${hits.length > 2 ? 's' : ''} also matched (use tab_id to pick one):\n${rest.join('\n')}${hits.length > 11 ? '\n…' : ''}`;
        }
      } else throw new Error('Provide tab_id, or a query matching the tab title or URL.');
      const t = await api.tabs.update(id, { active: true }).catch(rethrow);
      if (t?.windowId != null && t.windowId !== ctx.windowId) await api.windows.update(t.windowId, { focused: true }).catch(() => {});
      ctx.tabId = id;
      return `Switched to tab id=${id}.\n${await pageLine(id)}${others}`;
    },
  },
  {
    name: 'close_tab',
    group: 'browser',
    description: 'Close a tab.',
    parameters: obj({ tab_id: { type: 'integer' } }, ['tab_id']),
    mutating: () => true,
    run: async (args, ctx) => {
      const id = Number(args.tab_id);
      await api.tabs.remove(id).catch(rethrow);
      if (Number(ctx.tabId) === id) {
        ctx.tabId = null;
        return `Closed tab id=${id}. It was the current tab; page tools now use the active tab.`;
      }
      return `Closed tab id=${id}.`;
    },
  },
  {
    name: 'navigate',
    group: 'browser',
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
            await api.tabs.goBack(tabId).catch(async (e) => {
              if (!(await inject(tabId, 'pageBack'))) rethrow(e);
            });
          }
          else if (action === 'forward') await api.tabs.goForward(tabId).catch(rethrow);
          else if (action === 'reload') await api.tabs.reload(tabId).catch(rethrow);
          else {
            const url = withScheme(args.url);
            await api.tabs.update(tabId, { url }).catch(rethrow);
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
    group: 'browser',
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
      const r = await inject(tabId, 'pageRead', {
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
    group: 'browser',
    description: 'Click an element (id or selector), or a viewport point (x, y).',
    parameters: obj({ ...EL, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' }, ...TAB }),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const xy = has(args.x) && has(args.y);
      const t = target(args, !xy);
      return acting(tabId, ctx, async () => {
        if (trusted(ctx)) {
          let x = Number(args.x);
          let y = Number(args.y);
          let desc = `point (${x}, ${y})`;
          if (t.id != null || t.selector) ({ x, y, desc } = await act(tabId, { ...t, type: 'locate' }));
          await cdpClick(tabId, x, y, args.double ? 2 : 1);
          return `Clicked ${desc}.`;
        }
        const where = t.id != null || t.selector ? t : { x: Number(args.x), y: Number(args.y) };
        const r = await act(tabId, { ...where, type: 'click', double: !!args.double });
        return `Clicked ${r.desc}.${untrustedNote(ctx)}`;
      });
    },
  },
  {
    name: 'type_text',
    group: 'browser',
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
        if (trusted(ctx)) {
          desc = (await act(tabId, { ...t, type: 'focus', clear })).desc;
          if (text) await cdpInsertText(tabId, text);
          else if (clear) await cdpKey(tabId, 'Backspace');
          if (enter) await cdpKey(tabId, 'Enter');
        } else {
          desc = (await act(tabId, { ...t, type: 'type', text, clear, enter })).desc;
        }
        return `Typed "${short(text)}" into ${desc}${enter ? ' and pressed Enter' : ''}.${untrustedNote(ctx)}`;
      });
    },
  },
  {
    name: 'select_option',
    group: 'browser',
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
    group: 'browser',
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
        if (trusted(ctx)) {
          let desc = 'the focused element';
          if (t.id != null || t.selector) desc = (await act(tabId, { ...t, type: 'focus', clear: false })).desc;
          await cdpKey(tabId, key, mods);
          return `Pressed ${label} on ${desc}.`;
        }
        return `Pressed ${label} on ${(await act(tabId, { ...t, type: 'key', key, mods })).desc}.${untrustedNote(ctx)}`;
      });
    },
  },
  {
    name: 'scroll',
    group: 'browser',
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
    group: 'browser',
    description: 'Move the mouse over an element (opens hover menus and tooltips).',
    parameters: obj({ ...EL, ...TAB }),
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args);
      if (trusted(ctx)) {
        // CSS :hover only reacts to real pointer movement.
        const r = await act(tabId, { ...t, type: 'locate' });
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
        return `Hovered over ${r.desc}.`;
      }
      return `Hovered over ${(await act(tabId, { ...t, type: 'hover' })).desc}.${untrustedNote(ctx)}`;
    },
  },
  {
    name: 'wait',
    group: 'browser',
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
    group: 'browser',
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
    group: 'browser',
    description: 'Run JavaScript in the page. Runs as an async function body: use `return` for a value (a single expression also works).',
    parameters: obj({ code: { type: 'string' }, ...TAB }, ['code']),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      // A trailing ';' would stop `document.title;` from being evaluated as an expression.
      const code = String(args.code ?? '').replace(/;\s*$/, '');
      let r = await inject(tabId, 'mainEval', code, 'MAIN');
      if (r?.csp) {
        if (!hasDebugger()) {
          throw new Error(`This page's Content Security Policy blocks running JavaScript. The workaround used in Chrome is ${NO_DEBUGGER}. Use read_page, click, type_text and the other page tools instead.`);
        }
        r = await cdpEval(tabId, code);
      }
      if (!r) throw new Error('No response from page.');
      if (r.error) throw new Error(r.error);
      return r.result ?? 'undefined';
    },
  },
  {
    name: 'web_search',
    group: 'web',
    description: 'Search the web. Returns titles, URLs and snippets.',
    parameters: obj({ query: { type: 'string' }, max_results: { type: 'integer' } }, ['query']),
    run: async (args, ctx) => webSearch(String(args.query ?? ''), Math.min(Number(args.max_results) || 8, 20), ctx.signal),
  },
  {
    name: 'fetch_url',
    group: 'web',
    description:
      "Fetch a URL without opening a tab (uses the browser's cookies). HTML is converted to text; images and other files (PDF, Office, …) are saved as assets and their text is returned when readable.",
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
      const { blob, tooBig: n } = await readBody(res);
      if (!blob) return `${head}\n${tooBig(n)} Use download to save it, or open_tab to view it.`;
      const isImage = /^image\//i.test(type);
      const textual = !isImage && (type ? /^text\/|json|xml|javascript|ecmascript|csv|yaml|urlencoded/i.test(type) : await looksTextual(blob));
      if (!textual) {
        if (!blob.size || method === 'HEAD') return `${head}\n(empty body)`;
        if (!res.ok) return `${head}\n(${blob.size} bytes of binary content, not shown)`;
        let mime = type.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
        const name = nameFor(res.url || url, mime, res.headers.get('content-disposition') || '');
        if (mime === 'application/octet-stream') mime = guessMime(name, mime);
        const a = ctx.addAsset(toBlob(blob, mime), { label: 'fetched', name, mime });
        if (/^image\//.test(mime)) return `${head}\nSaved the image as ${a.id} (shown to the user). Use it as source in view_image / upload_file / download / edit_image.`;
        const saved = `Saved as ${a.id} "${a.name || name}" (${formatBytes(blob.size)}, shown to the user); use it as source in upload_file / download.`;
        const x = await assetText(a);
        if (!x.text) return `${head}\n${saved}\n${x.note || 'It cannot be read as text.'}`;
        return `${head}\n${saved} Its text:\n\n${paginate(x.text, args, ctx, (end) => `call read_file with source "${a.id}" and offset=${end}`)}`;
      }
      // Like read_file: a huge text response is only read up to FETCH_TEXT_BYTES.
      const cut = blob.size > FETCH_TEXT_BYTES;
      let text = await (cut ? blob.slice(0, FETCH_TEXT_BYTES) : blob).text();
      if (/html/i.test(type) || (!type && /^\s*<(!doctype|html)/i.test(text))) text = htmlToText(text);
      if (cut) text += `\n[only the first ${formatBytes(FETCH_TEXT_BYTES)} of ${formatBytes(blob.size)} were read]`;
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
    group: 'images',
    description: 'Create an image from a text prompt.',
    parameters: obj({ prompt: { type: 'string' }, size: { type: 'string', description: 'e.g. 1024x1024' } }, ['prompt']),
    run: async (args, ctx) => {
      requireImage(ctx);
      const { dataUrls } = await generateImage({
        prompt: String(args.prompt ?? ''),
        size: args.size,
        settings: ctx.settings,
        activeProvider: activeProviderOf(ctx),
        signal: ctx.signal,
      });
      return assetResult(dataUrls, 'generated', ctx);
    },
  },
  {
    name: 'edit_image',
    group: 'images',
    description: 'Edit an image as described by the prompt.',
    parameters: obj({ prompt: { type: 'string' }, source: SOURCE, size: { type: 'string', description: 'e.g. 1024x1024' } }, ['prompt', 'source']),
    run: async (args, ctx) => {
      requireImage(ctx); // fail fast before capturing or fetching the source
      const png = await toPng(await resolveSource(args.source, ctx));
      const { dataUrls } = await editImage({
        prompt: String(args.prompt ?? ''),
        images: [png],
        size: args.size,
        settings: ctx.settings,
        activeProvider: activeProviderOf(ctx),
        signal: ctx.signal,
      });
      return assetResult(dataUrls, 'edited', ctx);
    },
  },
  {
    name: 'view_image',
    group: 'browser',
    description: 'Look at an image.',
    parameters: obj({ source: SOURCE }, ['source']),
    run: async (args, ctx) => {
      if (!ctx.vision()) return 'Vision is unavailable for this model, so images cannot be viewed. Use read_page or image alt text instead.';
      const src = await resolveSource(args.source, ctx);
      let p;
      try {
        p = await preview(src);
      } catch {
        throw new Error(`The image could not be decoded (${src.type || 'unknown type'}). If it is a document, use read_file.`);
      }
      return { text: `Image ${args.source} (${p.origWidth}x${p.origHeight}px).`, images: [p.dataUrl] };
    },
  },
  {
    name: 'read_file',
    group: 'browser',
    description: 'Read the text of a file: an attachment or other asset (file_N), or a file URL. Handles text, PDF, Word, Excel and PowerPoint. Long text is paginated.',
    parameters: obj({ source: FILE_SOURCE, offset: { type: 'integer', description: 'Start at this character (pagination)' }, max_chars: { type: 'integer' } }, ['source']),
    run: async (args, ctx) => {
      const f = await resolveFile(args.source, ctx);
      const name = f.name || withExt('file', f.mime);
      const x = f.asset ? await assetText(f.asset) : await readText({ blob: f.blob, name, mime: f.mime });
      const head = `File: ${f.asset ? f.asset.id + ' ' : ''}"${name}" (${f.mime}, ${formatBytes(f.asset?.size || f.blob.size)})`;
      if (!x.text) {
        // files.js has its own note for images; the model needs the pointer to view_image instead.
        const why = /^image\//.test(f.mime) ? 'This is an image, not a document — use view_image to look at it.' : x.note || 'No text could be extracted from this file.';
        return `${head}\n${why}`;
      }
      const src = String(args.source ?? '').trim();
      // A partial read (a huge text file, a long workbook) says so on the first page.
      const why = x.note && !(Number(args.offset) > 0) ? `\nNote: ${x.note}` : '';
      return `${head}${why}\n\n${paginate(x.text, args, ctx, (end) => `call read_file with source "${f.asset?.id || src}" and offset=${end}`)}`;
    },
  },
  {
    name: 'upload_file',
    group: 'browser',
    description: 'Put a file or image (any asset) into a file input (target the input or its container).',
    parameters: obj({ ...EL, source: FILE_SOURCE, filename: { type: 'string' }, ...TAB }, ['source']),
    mutating: () => true,
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args);
      const f = await resolveFile(args.source, ctx, tabId);
      const name = has(args.filename) ? String(args.filename) : f.name || withExt(/^image\//.test(f.mime) ? 'image' : 'file', f.mime);
      const mime = f.mime === 'application/octet-stream' ? guessMime(name, f.mime) : f.mime;
      // Find the input first, so a big file is not sent to a page that has nowhere to put it.
      if (f.blob.size > CHUNK_BYTES) await act(tabId, { ...t, type: 'upload', probe: true });
      const r = await withTransfer(tabId, f.blob, { name, mime }, ctx.signal, (transfer) => act(tabId, { ...t, type: 'upload', transfer }));
      return `Uploaded ${name} to ${r.desc}.`;
    },
  },
  {
    name: 'set_page_image',
    group: 'browser',
    description: 'Replace an image on the page (visual preview only, not saved to the site).',
    parameters: obj({ ...EL, source: SOURCE, ...TAB }, ['source']),
    run: async (args, ctx) => {
      const tabId = await tabOf(args, ctx);
      const t = target(args);
      const img = await resolveSource(args.source, ctx, tabId);
      if (img.size > MAX_DATA_URL_BYTES) {
        throw new Error(`That image is ${formatBytes(img.size)}; set_page_image previews images up to ${formatBytes(MAX_DATA_URL_BYTES)}. Use upload_file to put it into the page.`);
      }
      const r =
        img.size <= CHUNK_BYTES
          ? await act(tabId, { ...t, type: 'set_image', dataUrl: await blobToDataUrl(img) })
          : await withTransfer(tabId, img, { name: 'image', mime: img.type }, ctx.signal, (transfer) => act(tabId, { ...t, type: 'set_image', transfer }));
      return `Replaced the image of ${r.desc}. This is a visual preview only — nothing was saved to the site (use upload_file to really upload).`;
    },
  },
  {
    name: 'download',
    group: 'browser',
    description: "Save an asset (image or file) or a file URL to the user's Downloads folder.",
    parameters: obj({ source: FILE_SOURCE, filename: { type: 'string' } }, ['source']),
    mutating: () => true,
    run: async (args, ctx) => {
      const s = String(args.source ?? '').trim();
      let url = s;
      let objectUrl = null;
      let filename = has(args.filename) ? String(args.filename) : '';
      if (!/^https?:\/\//i.test(s)) {
        const f = await resolveFile(s, ctx);
        // An object URL, not a data URL: Chrome limits URL length, and the file is not copied into a string.
        url = objectUrl = URL.createObjectURL(toBlob(f.blob, f.mime));
        if (!filename) filename = f.name || withExt(/^image\//.test(f.mime) ? 'image' : 'file', f.mime);
      }
      // chrome.downloads rejects absolute paths, '..' and reserved characters.
      filename = filename.replace(/[<>:"|?*\\\x00-\x1f]/g, '_').replace(/\.\.+/g, '.').replace(/^[/.]+/, '');
      if (objectUrl) watchDownloads();
      let id;
      try {
        id = await api.downloads.download({ url, ...(filename ? { filename } : {}) });
      } catch (e) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        throw e;
      }
      if (objectUrl) revokeWhenDone(id, objectUrl);
      return `Download started (id ${id})${filename ? ` as ${filename}` : ''}.`;
    },
  },
  {
    name: 'update_progress',
    group: 'memory',
    description:
      'Keep a running summary of what is done and what is left for long or bulk tasks. Replaces this chat\'s progress note; it survives even when older messages are trimmed from context, so you never redo finished items.',
    parameters: obj({ notes: { type: 'string', description: 'The full updated progress summary (replaces the previous one)' } }, ['notes']),
    mutating: () => false,
    run: async (args, ctx) => {
      ctx.setNotes(String(args.notes || ''));
      return 'Progress note updated.';
    },
  },
  {
    name: 'remember',
    group: 'memory',
    description: 'Save a durable fact to cross-chat memory so later chats can use it. scope "global" (everywhere) or "site" (this website, the default).',
    parameters: obj({ text: { type: 'string' }, scope: { type: 'string', enum: ['site', 'global'], description: 'Default "site"' } }, ['text']),
    mutating: () => false,
    run: async (args, ctx) => {
      const text = String(args.text || '');
      if (!text.trim()) throw new Error('Nothing to remember — the text is empty.');
      let resolved;
      let note = '';
      if (args.scope === 'global') {
        resolved = 'global';
      } else if (ctx.origin) {
        resolved = ctx.origin;
      } else {
        resolved = 'global';
        note = ' (saved globally because this page has no website)';
      }
      const saved = await ctx.memory.save({ scope: resolved, text, source: 'agent' });
      if (!saved) throw new Error('That memory could not be saved.');
      const where = saved.scope === 'global' ? 'globally' : `for ${saved.scope}`;
      return `Remembered ${where}${note}. (id ${saved.id} — use forget to remove it.)`;
    },
  },
  {
    name: 'recall',
    group: 'memory',
    description: 'Look up saved memories (the relevant ones are already shown to you automatically). scope "all" (default), "site" or "global"; query filters by text.',
    parameters: obj({ query: { type: 'string' }, scope: { type: 'string', enum: ['all', 'site', 'global'], description: 'Default "all"' } }),
    mutating: () => false,
    run: async (args, ctx) => {
      let list = await ctx.memory.list();
      if (args.scope === 'global') list = list.filter((m) => m.scope === 'global');
      else if (args.scope === 'site') list = list.filter((m) => ctx.origin && m.scope === ctx.origin);
      const q = String(args.query || '').trim().toLowerCase();
      if (q) list = list.filter((m) => String(m.text || '').toLowerCase().includes(q));
      if (!list.length) return 'Nothing saved.';
      const MAX = 100;
      const shown = list.slice(0, MAX);
      const lines = shown.map((m, i) => `${i + 1}. ${m.id} · [${m.scope === 'global' ? 'global' : 'site'}] ${m.text}`);
      if (list.length > MAX) lines.push(`… and ${list.length - MAX} more (narrow with query).`);
      return lines.join('\n');
    },
  },
  {
    name: 'forget',
    group: 'memory',
    description: 'Delete a saved memory by its id (get the id from recall).',
    parameters: obj({ id: { type: 'string' } }, ['id']),
    mutating: () => false,
    run: async (args, ctx) => {
      const id = String(args.id || '').trim();
      if (!id) throw new Error('Provide the memory id (from recall).');
      await ctx.memory.delete(id);
      return `Forgot memory ${id}.`;
    },
  },
];

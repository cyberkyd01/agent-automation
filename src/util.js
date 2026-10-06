export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sleep() that rejects with signal.reason as soon as the signal aborts.
export function pause(ms, signal) {
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

/* ---------- data URLs and MIME types ---------- */

// Image types a browser can display; any other MIME type makes an asset a plain file.
export const isImageMime = (mime) => /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml|avif)$/i.test(mime || '');

export const mimeOf = (dataUrl) => (/^data:([^;,]+)/.exec(dataUrl || '')?.[1] || 'application/octet-stream').toLowerCase();

// Decoded byte length, without decoding.
export function dataUrlSize(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (comma < 0) return 0;
  const body = s.slice(comma + 1);
  if (!/;base64$/i.test(s.slice(0, comma))) return body.replace(/%[0-9a-f]{2}/gi, '_').length;
  const pad = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - pad);
}

const EXTS = {
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/x-zip-compressed': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-tar': 'tar',
  'application/x-7z-compressed': '7z',
  'text/tab-separated-values': 'tsv',
  'text/x-python': 'py',
  'audio/mpeg': 'mp3',
  'video/quicktime': 'mov',
};

// '' when the type is unknown (application/octet-stream included).
export function extFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'application/octet-stream') return '';
  return EXTS[m] || /^[a-z]+\/(?:x-)?([a-z0-9]{1,5})$/.exec(m)?.[1] || '';
}

// A default file name. Unknown types get no extension, so text sniffing still applies to them.
export const withExt = (base, mime) => (extFor(mime) ? `${base}.${extFor(mime)}` : base);

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

// Host names (URL.hostname) of this computer and of the local network.
export const isLoopback = (h) => h === 'localhost' || h === '[::1]' || /^127\./.test(h);
export const isPrivate = (h) =>
  isLoopback(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/.test(h);

export function safeParse(s, fallback = {}) {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// The project's repo URL: the manifest's homepage_url is the single source of truth. '' if absent or not http(s).
export function repoUrl() {
  const u = chrome.runtime.getManifest().homepage_url;
  return typeof u === 'string' && /^https?:\/\//.test(u) ? u.replace(/\/+$/, '') : '';
}

// External link to the repo (or a path under it); null when there is no repo URL, so callers render nothing.
export function repoLink(cls, text, path = '') {
  const base = repoUrl();
  if (!base) return null;
  const a = document.createElement('a');
  a.className = cls;
  a.textContent = text;
  a.href = base + path;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Local reasoning models often inline their thinking as <think>…</think>.
export function splitThink(s) {
  let think = '';
  s = s || '';
  // Some chat templates emit the opening tag themselves, so the model's text has only the closing one.
  const close = s.search(/<\/think(?:ing)?>/);
  if (close >= 0 && !/<think(?:ing)?>/.test(s.slice(0, close))) s = '<think>' + s;
  const body = s.replace(/<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/g, (_, t) => {
    think += t;
    return '';
  });
  return { think: think.trim(), body };
}

// Line-per-event SSE reader. LLM APIs and MCP both send single-line JSON data.
export async function* sseEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = 'message';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line === '') event = 'message';
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) yield { event, data: line.slice(5).trim() };
      }
    }
    if (buf.startsWith('data:')) yield { event, data: buf.slice(5).trim() };
  } finally {
    reader.cancel().catch(() => {});
  }
}

// An HTML error page (a proxy's, or Cloudflare's when a tunnel is down) becomes one readable line, not markup.
function htmlErrorText(html, res) {
  const plain = (s) =>
    s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  const title = plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  let host = '';
  try {
    host = new URL(res.url).host;
  } catch {}
  // Cloudflare answers 530 / error 1033 for a tunnel whose cloudflared is not connected (stopped, or a quick
  // tunnel's old link after a restart).
  if (res.status === 530 || /Cloudflare Tunnel error/i.test(title) || /errorCode:\s*1033\b/.test(html)) {
    return `The Cloudflare tunnel${host ? ` at ${host}` : ''} is not running (Cloudflare error 1033). On the computer that shares the model, start it again in Settings → Remote access. A quick tunnel gets a new link each time it starts: then add its new connection code here (Settings → Models & providers → Add from connection code).`;
  }
  return `${title || res.statusText || 'Error'}${host ? ` (an error page from ${host})` : ''}`;
}

export async function httpError(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {}
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || text;
  } catch {
    if (/^\s*(<!doctype html|<html)/i.test(text) || /<\/(head|body|title)>/i.test(text)) msg = htmlErrorText(text, res);
  }
  const e = new Error(`HTTP ${res.status}: ${String(msg).slice(0, 600) || res.statusText}`);
  e.status = res.status;
  return e;
}

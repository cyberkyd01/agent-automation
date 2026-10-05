export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

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

export async function httpError(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {}
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || text;
  } catch {}
  const e = new Error(`HTTP ${res.status}: ${String(msg).slice(0, 600) || res.statusText}`);
  e.status = res.status;
  return e;
}

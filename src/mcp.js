import { sseEvents } from './util.js';
import { guessMime, formatBytes } from './files.js';

const CONNECT_MS = 15000;
const CALL_MS = 5 * 60 * 1000;

function parseHeaders(text) {
  const h = {};
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return h;
}

const duration = (ms) => (ms >= 60000 ? `${ms / 60000} min` : `${ms / 1000} s`);

// Runs fn with a signal that also fires after `ms`. A Stop stays an AbortError; a timeout becomes a readable Error.
async function timed(signal, ms, what, fn) {
  const timer = AbortSignal.timeout(ms);
  const s = signal ? AbortSignal.any([signal, timer]) : timer;
  try {
    return await fn(s);
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    if (timer.aborted) throw new Error(`${what} within ${duration(ms)}.`);
    throw e;
  }
}

function unreachable(cfg, e) {
  let where = cfg.url;
  try {
    where = new URL(cfg.url).origin;
  } catch {}
  const hint = cfg.companion ? 'Is the companion program running?' : 'Is the server running and the URL correct?';
  const err = new Error(`Cannot reach ${where}. ${hint} (${e?.message || e})`);
  err.network = true;
  return err;
}

async function httpFailure(res) {
  let detail = '';
  try {
    detail = (await res.text()).trim();
    const j = JSON.parse(detail);
    detail = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || detail;
  } catch {}
  detail = String(detail).replace(/\s+/g, ' ').slice(0, 300);
  const hint =
    res.status === 401 || res.status === 403
      ? ' Check the access token / headers.'
      : res.status === 404 || res.status === 405
        ? ' Check the URL (servers usually listen on /mcp, older ones on /sse).'
        : '';
  const e = new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}${/[.!?]$/.test(detail) ? '' : '.'}${hint}`);
  e.status = res.status;
  return e;
}

function rpcError(err) {
  const e = new Error(err?.message || 'MCP error');
  e.code = err?.code;
  return e;
}

function streamClosed() {
  const e = new Error('The MCP event stream closed.');
  e.streamClosed = true;
  return e;
}

// Minimal MCP client for remote servers: Streamable HTTP, plus the legacy HTTP+SSE
// transport when the URL ends in /sse. (stdio servers run behind the companion.)
// Every request takes an AbortSignal; connecting and calls are bounded by timeouts.
export class McpClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.nextId = 1;
    this.conn = null; // legacy SSE connection: { stream, postUrl, pending, dead }
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...parseHeaders(this.cfg.headers) };
    if (this.session) h['Mcp-Session-Id'] = this.session;
    if (this.version) h['MCP-Protocol-Version'] = this.version;
    return h;
  }

  connect(signal) {
    return timed(signal, CONNECT_MS, 'The server did not answer', async (s) => {
      this.closeStream();
      this.session = this.version = undefined;
      let url;
      try {
        url = new URL(this.cfg.url);
      } catch {
        throw new Error(`"${this.cfg.url || ''}" is not a valid URL.`);
      }
      if (/\/sse\/?$/.test(url.pathname)) await this.openLegacy(s);
      const r = await this.rpc(
        'initialize',
        { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-automation', version: '1.1.0' } },
        { signal: s }
      );
      this.version = r?.protocolVersion;
      await this.rpc('notifications/initialized', undefined, { notify: true, signal: s });
    });
  }

  async openLegacy(signal) {
    const stream = new AbortController();
    const conn = { stream, postUrl: '', pending: new Map(), dead: false };
    // Only the connect attempt may cancel the stream; once open it outlives the run that opened it.
    const onAbort = () => stream.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await fetch(this.cfg.url, { headers: { ...parseHeaders(this.cfg.headers), Accept: 'text/event-stream' }, signal: stream.signal });
      } catch (e) {
        if (stream.signal.aborted) throw e;
        throw unreachable(this.cfg, e);
      }
      if (!res.ok) throw await httpFailure(res);
      conn.postUrl = await new Promise((resolve, reject) => {
        (async () => {
          try {
            for await (const ev of sseEvents(res)) {
              if (ev.event === 'endpoint') resolve(new URL(ev.data, this.cfg.url).href);
              else dispatch(conn.pending, ev.data);
            }
            throw streamClosed();
          } catch (e) {
            // A dropped stream fails everything still waiting on it, and every later request (→ reconnect).
            conn.dead = true;
            reject(e);
            const err = stream.signal.aborted ? e : streamClosed();
            for (const p of conn.pending.values()) p.reject(err);
            conn.pending.clear();
          }
        })();
      });
      this.conn = conn;
    } catch (e) {
      stream.abort();
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async rpc(method, params, { notify = false, signal } = {}) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    const id = notify ? undefined : (msg.id = this.nextId++);
    try {
      return await (this.conn ? this.rpcLegacy(msg, id, signal) : this.rpcHttp(msg, id, signal));
    } catch (e) {
      // Best effort: tell the server to stop work nobody is waiting for any more.
      if (id != null && signal?.aborted && method !== 'initialize') {
        this.rpc('notifications/cancelled', { requestId: id, reason: 'Cancelled by the user' }, { notify: true, signal: AbortSignal.timeout(5000) }).catch(() => {});
      }
      throw e;
    }
  }

  async post(url, msg, signal) {
    try {
      return await fetch(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw unreachable(this.cfg, e);
    }
  }

  async rpcHttp(msg, id, signal) {
    const res = await this.post(this.cfg.url, msg, signal);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (!res.ok) throw await httpFailure(res);
    if (id == null) {
      res.body?.cancel().catch(() => {});
      return;
    }
    let reply;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for await (const ev of sseEvents(res)) {
        try {
          const m = JSON.parse(ev.data);
          if (m.id === id && ('result' in m || 'error' in m)) {
            reply = m;
            break;
          }
        } catch {}
      }
    } else {
      const text = await res.text();
      try {
        reply = JSON.parse(text);
      } catch {
        throw new Error(`The server sent an invalid reply: ${text.replace(/\s+/g, ' ').slice(0, 120) || '(empty)'}`);
      }
      if (Array.isArray(reply)) reply = reply.find((m) => m?.id === id);
    }
    if (!reply) throw new Error('The server closed the connection without answering.');
    if (reply.error) throw rpcError(reply.error);
    return reply.result;
  }

  async rpcLegacy(msg, id, signal) {
    const conn = this.conn;
    if (conn.dead) throw streamClosed();
    let wait;
    if (id != null) {
      wait = new Promise((resolve, reject) => conn.pending.set(id, { resolve, reject }));
      wait.catch(() => {});
    }
    // The answer arrives on the stream, so a Stop or timeout has to fail the wait itself.
    const onAbort = () => conn.pending.get(id)?.reject(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) throw signal.reason;
      const res = await this.post(conn.postUrl, msg, signal);
      if (!res.ok) throw await httpFailure(res);
      res.body?.cancel().catch(() => {});
      return await wait;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (id != null) conn.pending.delete(id);
    }
  }

  listTools(signal) {
    return timed(signal, CONNECT_MS, 'The server did not list its tools', async (s) => {
      const tools = [];
      let cursor;
      for (let page = 0; page < 50; page++) {
        const r = await this.rpc('tools/list', cursor ? { cursor } : {}, { signal: s });
        tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return tools.filter((t) => t && typeof t.name === 'string' && t.name);
    });
  }

  async callTool(name, args, signal) {
    const call = () => timed(signal, CALL_MS, 'The tool did not finish', (s) => this.rpc('tools/call', { name, arguments: args ?? {} }, { signal: s }));
    try {
      return await call();
    } catch (e) {
      // Session expired or stream dropped: reconnect once.
      if (!(e.streamClosed || (this.session && (e.status === 400 || e.status === 404)))) throw e;
      await this.connect(signal);
      return call();
    }
  }

  closeStream() {
    this.conn?.stream.abort();
    this.conn = null;
  }

  close() {
    this.closeStream();
    if (this.session) {
      // Streamable HTTP: end the server-side session (best effort).
      fetch(this.cfg.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(() => {});
      this.session = undefined;
    }
  }
}

function dispatch(pending, data) {
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  const p = pending.get(m?.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(rpcError(m.error));
  else p.resolve(m.result);
}

/* ---------- tools in the agent's format ---------- */

const san = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

function toolName(server, tool, used) {
  const base = `mcp_${san(server)}_${san(tool)}`.slice(0, 64);
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base.slice(0, 63 - String(n).length)}_${n}`;
  used.add(name);
  return name;
}

// Providers reject tool schemas that aren't plain object schemas.
export function objectSchema(schema) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) if (k !== '$schema') o[k] = strip(x);
    return o;
  };
  const o = schema && typeof schema === 'object' && !Array.isArray(schema) ? strip(schema) : {};
  o.type = 'object';
  if (!o.properties || typeof o.properties !== 'object' || Array.isArray(o.properties)) o.properties = {};
  if ('required' in o && !Array.isArray(o.required)) delete o.required;
  return o;
}

function basename(uri) {
  let p = String(uri || '');
  try {
    p = new URL(p).pathname;
  } catch {}
  p = p.split(/[\\/]/).pop().split(/[?#]/)[0];
  try {
    p = decodeURIComponent(p);
  } catch {}
  return p;
}

// MCP tool result → { text, images }. Binary resources become assets the model can read_file / upload_file.
export function mcpResult(r, ctx, label = 'from MCP') {
  const parts = [];
  const images = [];
  for (const c of Array.isArray(r?.content) ? r.content : []) {
    try {
      if (c?.type === 'text') parts.push(String(c.text ?? ''));
      else if (c?.type === 'image' && c.data) images.push(`data:${c.mimeType || 'image/png'};base64,${c.data}`);
      else if (c?.type === 'resource' && c.resource) {
        const res = c.resource;
        if (typeof res.text === 'string') parts.push(res.uri ? `[${res.uri}]\n${res.text}` : res.text);
        else if (typeof res.blob === 'string') {
          const name = basename(res.uri) || undefined;
          const mime = res.mimeType || (name ? guessMime(name) : 'application/octet-stream');
          const a = ctx.addAsset(`data:${mime};base64,${res.blob}`, { label, name, mime });
          const use = /^image\//.test(a.mime || mime) ? 'view_image / upload_file / download' : 'read_file / upload_file / download';
          parts.push(`Received "${a.name || name || a.id}" (${a.mime || mime}, ${formatBytes(a.size ?? 0)}) as asset ${a.id} (shown to the user). Use it as source in ${use}.`);
        }
      } else if (c?.type === 'resource_link' && c.uri) {
        parts.push(`Resource: ${c.name ? `${c.name} — ` : ''}${c.uri}`);
      }
    } catch (e) {
      parts.push(`(a ${c?.type || 'content'} item could not be used: ${e?.message || e})`);
    }
  }
  const text = parts.filter(Boolean).join('\n');
  if (r?.isError) throw new Error(text || 'The MCP tool reported an error.');
  return { text: text || (r?.structuredContent ? JSON.stringify(r.structuredContent) : '(no output)'), images };
}

// settings.companion → the MCP server entry for the local companion program (null when off).
export function companionServer(c) {
  if (!c?.enabled || !String(c.token || '').trim()) return null;
  const base = String(c.url || 'http://127.0.0.1:8765').trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
  return { id: 'companion', name: 'computer', url: `${base}/mcp`, headers: `Authorization: Bearer ${String(c.token).trim()}`, enabled: true, companion: true };
}

// Keeps one connection per configured server. Healthy connections are reused (their tool lists are
// refreshed each time, which is cheap); a server that failed is simply tried again next time.
export class McpPool {
  constructor() {
    this.entries = new Map(); // key → { client, ok }
    this.busy = Promise.resolve();
  }

  // Never rejects: failures are reported through onError and that server's tools are left out.
  tools(servers, opts = {}) {
    const run = this.busy.then(() => this.load(servers, opts));
    this.busy = run.catch(() => {});
    return run;
  }

  async load(servers, { signal, onError } = {}) {
    const wanted = servers.map((s) => ({ s, key: JSON.stringify([s.name || '', s.url, s.headers || '', !!s.companion]) }));
    const keys = new Set(wanted.map((w) => w.key));
    for (const [k, e] of this.entries) {
      if (!keys.has(k)) {
        e.client.close();
        this.entries.delete(k);
      }
    }
    const lists = await Promise.all(
      wanted.map(({ s, key }) =>
        this.open(s, key, signal).catch((err) => {
          if (!signal?.aborted) onError?.(`${s.companion ? 'Computer companion' : `MCP server "${s.name || s.url}"`}: ${err?.message || err}`);
          return null;
        })
      )
    );
    // Built in configuration order so duplicate-name suffixes don't depend on which server answered first.
    const used = new Set();
    const tools = [];
    wanted.forEach(({ s, key }, i) => {
      const entry = this.entries.get(key);
      if (lists[i] && entry) for (const t of lists[i]) tools.push(this.wrap(s, entry, t, used));
    });
    return tools;
  }

  async open(s, key, signal) {
    let e = this.entries.get(key);
    if (e?.ok) {
      try {
        return await e.client.listTools(signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        // The cached connection went stale: reconnect below.
      }
    }
    e?.client.close();
    e = { client: new McpClient(s), ok: false };
    this.entries.set(key, e);
    try {
      await e.client.connect(signal);
      const list = await e.client.listTools(signal);
      e.ok = true;
      return list;
    } catch (err) {
      e.client.close();
      if (this.entries.get(key) === e) this.entries.delete(key);
      throw err;
    }
  }

  wrap(s, entry, t, used) {
    const sensitive = !!s.companion;
    const tool = {
      name: toolName(s.name || 'server', t.name, used),
      description: String(t.description || t.title || t.name).slice(0, 1024),
      parameters: objectSchema(t.inputSchema),
      mutating: sensitive ? () => true : () => !t.annotations?.readOnlyHint,
      run: async (args, ctx) => {
        try {
          return mcpResult(await entry.client.callTool(t.name, args, ctx?.signal), ctx, sensitive ? 'from computer' : 'from MCP');
        } catch (err) {
          if (err?.network) entry.ok = false; // reconnect (and re-check) on the next run
          throw err;
        }
      },
    };
    if (sensitive) tool.sensitive = true;
    return tool;
  }

  close() {
    for (const e of this.entries.values()) e.client.close();
    this.entries.clear();
  }
}

// v1.0 API: connects to every enabled server and returns their tools in the agent's tool format.
export async function loadMcpTools(servers, onError) {
  const pool = new McpPool();
  const tools = await pool.tools(
    servers.filter((s) => s.enabled !== false && s.url),
    { onError }
  );
  return { tools, close: () => pool.close() };
}

// For Settings: connect, list the tools, disconnect. Never rejects.
export async function testMcpServer(cfg, signal) {
  if (!cfg?.url) return { ok: false, error: 'Enter the server URL first.' };
  const client = new McpClient(cfg);
  try {
    await client.connect(signal);
    const tools = await client.listTools(signal);
    return { ok: true, tools: tools.map((t) => ({ name: t.name, description: String(t.description || t.title || '') })) };
  } catch (e) {
    const error = e?.name === 'AbortError' ? 'Cancelled.' : e?.name === 'TimeoutError' ? 'The server did not answer in time.' : e?.message || String(e);
    return { ok: false, error };
  } finally {
    client.close();
  }
}

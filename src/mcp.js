import { sseEvents } from './util.js';

function parseHeaders(text) {
  const h = {};
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return h;
}

// Minimal MCP client for remote servers: Streamable HTTP, plus the legacy HTTP+SSE
// transport when the URL ends in /sse. (stdio servers need an HTTP bridge.)
export class McpClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.nextId = 1;
    this.pending = new Map();
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...parseHeaders(this.cfg.headers) };
    if (this.session) h['Mcp-Session-Id'] = this.session;
    if (this.version) h['MCP-Protocol-Version'] = this.version;
    return h;
  }

  async connect() {
    this.session = this.version = this.postUrl = undefined;
    if (/\/sse\/?$/.test(new URL(this.cfg.url).pathname)) await this.openLegacy();
    const r = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agent-automation', version: '1.0.0' },
    });
    this.version = r.protocolVersion;
    await this.rpc('notifications/initialized', undefined, true);
  }

  async openLegacy() {
    this.stream?.abort();
    this.stream = new AbortController();
    const res = await fetch(this.cfg.url, { headers: { ...parseHeaders(this.cfg.headers), Accept: 'text/event-stream' }, signal: this.stream.signal });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    this.postUrl = await new Promise((resolve, reject) => {
      (async () => {
        try {
          for await (const ev of sseEvents(res)) {
            if (ev.event === 'endpoint') resolve(new URL(ev.data, this.cfg.url).href);
            else this.dispatch(ev.data);
          }
          throw new Error('MCP SSE stream closed');
        } catch (e) {
          reject(e);
          for (const p of this.pending.values()) p.reject(e);
          this.pending.clear();
        }
      })();
    });
  }

  dispatch(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || 'MCP error'));
    else p.resolve(m.result);
  }

  async rpc(method, params, notify = false) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    const id = notify ? undefined : (msg.id = this.nextId++);

    if (this.postUrl) {
      const wait = notify ? null : new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
      wait?.catch(() => {});
      const res = await fetch(this.postUrl, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg) });
      if (!res.ok) {
        this.pending.delete(id);
        throw new Error(`MCP HTTP ${res.status}`);
      }
      return wait;
    }

    const res = await fetch(this.cfg.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (notify) return;
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
      reply = await res.json();
    }
    if (!reply) throw new Error('MCP: no response');
    if (reply.error) throw new Error(reply.error.message || 'MCP error');
    return reply.result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const r = await this.rpc('tools/list', cursor ? { cursor } : {});
      tools.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name, args) {
    try {
      return await this.rpc('tools/call', { name, arguments: args });
    } catch (e) {
      // Session expired or stream dropped: reconnect once.
      if (!/HTTP (400|404)|stream closed/.test(e.message)) throw e;
      await this.connect();
      return this.rpc('tools/call', { name, arguments: args });
    }
  }

  close() {
    this.stream?.abort();
  }
}

// Connects to every enabled server and returns their tools in the agent's tool format.
export async function loadMcpTools(servers, onError) {
  const tools = [];
  const clients = [];
  const san = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  await Promise.all(
    servers
      .filter((s) => s.enabled !== false && s.url)
      .map(async (s) => {
        const client = new McpClient(s);
        try {
          await client.connect();
          clients.push(client);
          for (const t of await client.listTools()) {
            tools.push({
              name: `mcp_${san(s.name || 'server')}_${san(t.name)}`.slice(0, 64),
              description: (t.description || t.name).slice(0, 1024),
              parameters: t.inputSchema || { type: 'object', properties: {} },
              mutating: () => !t.annotations?.readOnlyHint,
              run: async (args) => {
                const r = await client.callTool(t.name, args);
                const content = r.content || [];
                const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
                const images = content.filter((c) => c.type === 'image').map((c) => `data:${c.mimeType};base64,${c.data}`);
                if (r.isError) throw new Error(text || 'MCP tool error');
                return { text: text || (r.structuredContent ? JSON.stringify(r.structuredContent) : '(no output)'), images };
              },
            });
          }
        } catch (e) {
          client.close();
          onError?.(`MCP server "${s.name || s.url}": ${e.message}`);
        }
      })
  );
  return { tools, close: () => clients.forEach((c) => c.close()) };
}

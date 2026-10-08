import { httpError, isPrivate, newId, safeParse, sseEvents } from './util.js';

const trimSlash = (u) => (u || '').replace(/\/+$/, '');
const anthropicBase = (p) => trimSlash(p.baseUrl || 'https://api.anthropic.com').replace(/\/v1$/, '');

const openaiHeaders = (p) => ({
  'Content-Type': 'application/json',
  ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
});

const anthropicHeaders = (p) => ({
  'content-type': 'application/json',
  'x-api-key': p.apiKey || '',
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
});

async function doFetch(url, init, p) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error(`Cannot reach ${p.name} at ${p.baseUrl}. Is the server running and the URL correct? (${e.message})`);
    err.transient = true; // network failure: the agent may retry
    throw err;
  }
  if (!res.ok) throw await httpError(res);
  return res;
}

// Errors reported inside a stream (after HTTP 200). Only server-side/overload codes get a status,
// so the 4xx capability probing in chat() never reacts to them.
function streamError(message, code) {
  const e = new Error(message);
  const n = Number(code);
  if (n === 429 || n >= 500) e.status = n;
  return e;
}
const ANTHROPIC_STREAM_CODES = { overloaded_error: 529, api_error: 500, rate_limit_error: 429 };

// LM Studio lists every downloaded model on /v1/models, loaded or not. Its own API says which are loaded:
// GET <origin>/api/v0/models → { data: [{ id, type: 'llm' | 'vlm' | 'embeddings' | …, state: 'loaded' | 'not-loaded' }] }.
// Only asked of a model server on this computer or network, and never through the companion's /llm/<name> proxy.
const LMSTUDIO_TIMEOUT = 2000;

function lmStudioUrl(p) {
  try {
    const u = new URL(trimSlash(p.baseUrl));
    if (!/^https?:$/.test(u.protocol) || !isPrivate(u.hostname) || /(^|\/)llm(\/|$)/.test(u.pathname)) return '';
    return `${u.origin}/api/v0/models`;
  } catch {
    return '';
  }
}

// → { loaded: [ids, in LM Studio's order], types: { id: type } }, or null when there is no such answer.
async function lmStudioModels(p, signal) {
  const url = lmStudioUrl(p);
  if (!url || signal?.aborted) return null;
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  const timer = setTimeout(stop, LMSTUDIO_TIMEOUT);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const res = await fetch(url, { headers: openaiHeaders(p), signal: ctl.signal });
    if (!res.ok) return null;
    const data = (await res.json())?.data;
    if (!Array.isArray(data)) return null;
    const out = { loaded: [], types: {} };
    for (const m of data) {
      if (typeof m?.id !== 'string' || !m.id) continue;
      if (typeof m.type === 'string') out.types[m.id] = m.type;
      if (m.state === 'loaded' && !out.loaded.includes(m.id)) out.loaded.push(m.id);
    }
    return out;
  } catch {
    return null; // not LM Studio, too slow, or not JSON: the plain list is all there is
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

// The model ids of a provider. For LM Studio it also records which are loaded (p.loadedModels, p.modelTypes) and
// lists those first, so the default is a model that is ready rather than one that has to be loaded first.
export async function listModels(p, signal) {
  if (p.type === 'anthropic') {
    delete p.loadedModels;
    delete p.modelTypes;
    const res = await doFetch(anthropicBase(p) + '/v1/models?limit=1000', { headers: anthropicHeaders(p), signal }, p);
    return ((await res.json()).data || []).map((m) => m.id);
  }
  const res = await doFetch(trimSlash(p.baseUrl) + '/models', { headers: openaiHeaders(p), signal }, p);
  const j = await res.json();
  const ids = (j.data || j.models || [])
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .sort();
  const lm = await lmStudioModels(p, signal);
  if (!lm) {
    delete p.loadedModels;
    delete p.modelTypes;
    return ids;
  }
  p.loadedModels = lm.loaded;
  p.modelTypes = lm.types;
  const have = new Set(ids);
  const first = lm.loaded.filter((id) => have.has(id));
  const isFirst = new Set(first);
  return [...first, ...ids.filter((id) => !isFirst.has(id))];
}

// " · loaded" after the id of a model that LM Studio has loaded (text only: the option's value stays the id).
export const modelLabel = (p, id) => (p?.loadedModels?.includes(id) ? `${id} · loaded` : id);

// Default to a chat model: local servers also list embedding, image and speech models. A model that is already
// loaded wins (`loaded`: ids; `types`: { id: type } when the server says what each model is).
export function pickModel(models, loaded = [], types = {}) {
  const other = /embed|rerank|image|diffusion|flux|sdxl|dall-e|whisper|tts|speech|moderation/i;
  const chat = (m) => (types?.[m] ? /^(llm|vlm)$/i.test(types[m]) : !other.test(m));
  const ready = (loaded || []).find((m) => models.includes(m) && chat(m));
  return ready || models.find((m) => !other.test(m)) || models[0] || '';
}

/* ---------- prompted tool calling (for models/servers without native tools) ---------- */

function parseLoose(s) {
  try {
    return JSON.parse(s);
  } catch {}
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {}
  }
  return null;
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;

export function extractToolCalls(text) {
  const calls = [];
  for (const m of (text || '').matchAll(TOOL_CALL_RE)) {
    const j = parseLoose(m[1]);
    if (j?.name) {
      calls.push({
        id: 'call_' + newId(),
        type: 'function',
        function: { name: j.name, arguments: JSON.stringify(j.arguments ?? j.parameters ?? {}) },
      });
    }
  }
  return { calls, clean: (text || '').replace(TOOL_CALL_RE, '').trim() };
}

function toolPrompt(tools) {
  return (
    '\n\n## Tool calling\nTo call a tool, output exactly this (valid JSON inside the tags):\n' +
    '<tool_call>{"name": "tool_name", "arguments": {"arg": "value"}}</tool_call>\n' +
    'You may output several tool calls. After your tool calls, stop and wait: results arrive in <tool_result> blocks. ' +
    'When the task is finished, answer normally with no tool_call tags.\n\nAvailable tools:\n' +
    tools.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`).join('\n')
  );
}

/* ---------- message conversion ---------- */

const hasImages = (m) =>
  (m._images && m._images.length) || (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

// Only the most recent image-bearing messages keep their images; older ones cost context for little value.
function imageKeepSet(messages, caps) {
  const keep = new Set();
  if (caps.noImages) return keep;
  for (let i = messages.length - 1; i >= 0 && keep.size < 2; i--) if (hasImages(messages[i])) keep.add(messages[i]);
  return keep;
}

function toOpenAI(messages, caps) {
  const keep = imageKeepSet(messages, caps);
  const out = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Image output of the tool call(s) above:' },
        ...pending.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    });
    pending = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    if (m.role === 'tool') {
      if (caps.promptTools) out.push({ role: 'user', content: `<tool_result name="${m.name}">\n${m.content}\n</tool_result>` });
      else out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
      if (m._images && keep.has(m)) pending.push(...m._images);
    } else if (m.role === 'assistant') {
      if (caps.promptTools) {
        const calls = (m.tool_calls || [])
          .map((tc) => `\n<tool_call>${JSON.stringify({ name: tc.function.name, arguments: safeParse(tc.function.arguments) })}</tool_call>`)
          .join('');
        out.push({ role: 'assistant', content: (m.content || '') + calls });
      } else {
        const o = { role: 'assistant', content: m.content || '' };
        if (m.tool_calls?.length) o.tool_calls = m.tool_calls;
        out.push(o);
      }
    } else if (Array.isArray(m.content)) {
      const parts = m.content.filter((p) => p.type !== 'image_url' || keep.has(m));
      out.push({ role: m.role, content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  flush();
  return caps.promptTools ? mergeUsers(out) : out;
}

// Many chat templates require strict user/assistant alternation.
function mergeUsers(msgs) {
  const out = [];
  const parts = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && m.role === 'user') {
      if (typeof last.content === 'string' && typeof m.content === 'string') last.content += '\n\n' + m.content;
      else last.content = [...parts(last.content), ...parts(m.content)];
    } else out.push({ ...m });
  }
  return out;
}

function toAnthropic(messages, caps) {
  const keep = imageKeepSet(messages, caps);
  let system = '';
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  const img = (u) => {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(u);
    return m
      ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
      : { type: 'image', source: { type: 'url', url: u } };
  };
  const tid = (id) => String(id || 'call').replace(/[^a-zA-Z0-9_-]/g, '_');
  for (const m of messages) {
    if (m.role === 'system') system += (system ? '\n\n' : '') + m.content;
    else if (m.role === 'user') {
      const src = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      push(
        'user',
        src
          .filter((p) => (p.type === 'text' ? p.text : keep.has(m)))
          .map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : img(p.image_url.url)))
      );
    } else if (m.role === 'assistant') {
      const b = [];
      if (m.content) b.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls || []) {
        b.push({ type: 'tool_use', id: tid(tc.id), name: tc.function.name, input: safeParse(tc.function.arguments) });
      }
      push('assistant', b);
    } else if (m.role === 'tool') {
      const c = [{ type: 'text', text: m.content || '(empty)' }];
      if (m._images && keep.has(m)) c.push(...m._images.map(img));
      push('user', [{ type: 'tool_result', tool_use_id: tid(m.tool_call_id), content: c }]);
    }
  }
  return { system, messages: out };
}

/* ---------- reasoning ---------- */

// Qwen soft switch: append ' /think' or ' /no_think' to the model-visible text of the LAST user turn only.
// Edits a shallow copy (never the original, so the UI `_text` is untouched) and never doubles the token.
function appendToLastUser(messages, suffix) {
  if (!suffix) return messages;
  const token = suffix.trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const out = messages.slice();
    if (Array.isArray(m.content)) {
      const c = m.content.slice();
      let at = -1;
      for (let k = c.length - 1; k >= 0; k--) if (c[k].type === 'text') { at = k; break; }
      if (at >= 0) {
        if (new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$').test(c[at].text || '')) return messages;
        c[at] = { ...c[at], text: (c[at].text || '') + suffix };
      } else {
        c.push({ type: 'text', text: token });
      }
      out[i] = { ...m, content: c };
    } else {
      const text = String(m.content ?? '');
      if (new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$').test(text)) return messages;
      out[i] = { ...m, content: text + suffix };
    }
    return out;
  }
  return messages;
}

const ANTHROPIC_BUDGET = { minimal: 1024, low: 2048, medium: 8000, high: 16000 };
// Model ids that may support extended thinking (claude 3.7 / 4 / opus / sonnet families).
const THINKABLE = /claude-?3[.\-]?7|claude-?4|opus|sonnet/i;

/* ---------- chat ---------- */

function finishCalls(tcs) {
  return tcs
    .filter((t) => t && t.function.name)
    .map((t) => ({ ...t, id: t.id || 'call_' + newId(), function: { ...t.function, arguments: t.function.arguments || '{}' } }));
}

async function openaiChat({ provider, model, messages, tools, settings, signal, onDelta, caps }) {
  const useTools = tools.length > 0;
  const mode = settings.thinking?.mode || 'auto';
  const reason = mode === 'on' && !caps.noReason; // request reasoning this turn
  const isQwen = /qwen/i.test(model || '');
  // Qwen's soft switch: /think when we ask for reasoning, /no_think when the user turned it off. Never both.
  const qwenSuffix = reason && isQwen ? ' /think' : mode === 'off' && isQwen ? ' /no_think' : '';

  let msgs = messages;
  if (useTools && caps.promptTools) {
    msgs = messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: m.content + toolPrompt(tools) } : m));
  }
  if (qwenSuffix) msgs = appendToLastUser(msgs, qwenSuffix);
  const body = { model, messages: toOpenAI(msgs, caps), stream: true };
  if (useTools && !caps.promptTools) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (settings.temperature !== '' && settings.temperature != null) body.temperature = Number(settings.temperature);
  if (settings.maxTokens) body.max_tokens = Number(settings.maxTokens);
  if (reason) body.reasoning_effort = settings.thinking?.effort || 'medium';

  const res = await doFetch(
    trimSlash(provider.baseUrl) + '/chat/completions',
    { method: 'POST', headers: openaiHeaders(provider), body: JSON.stringify(body), signal },
    provider
  );

  let content = '';
  let reasoning = '';
  const images = [];
  let tcs = [];
  const addImages = (list) => {
    for (const im of list || []) {
      const u = im?.image_url?.url || im?.url;
      if (u) images.push(u);
    }
  };

  if ((res.headers.get('content-type') || '').includes('application/json')) {
    // Server ignored stream:true.
    const msg = (await res.json()).choices?.[0]?.message || {};
    content = typeof msg.content === 'string' ? msg.content : '';
    reasoning = msg.reasoning_content || msg.reasoning || '';
    tcs = (msg.tool_calls || []).map((t) => ({
      id: t.id,
      type: 'function',
      function: {
        name: t.function?.name,
        arguments: typeof t.function?.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function?.arguments ?? {}),
      },
    }));
    addImages(msg.images);
    onDelta?.({ content, reasoning });
  } else {
    for await (const { data } of sseEvents(res)) {
      if (data === '[DONE]') break;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw streamError(j.error.message || JSON.stringify(j.error), j.error.code ?? j.error.status);
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (typeof d.content === 'string') content += d.content;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string') reasoning += r;
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? (tc.id ? tcs.length : Math.max(0, tcs.length - 1));
        const cur = (tcs[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name && !cur.function.name) cur.function.name = tc.function.name;
        const a = tc.function?.arguments;
        if (a != null) cur.function.arguments += typeof a === 'string' ? a : JSON.stringify(a);
      }
      addImages(d.images);
      onDelta?.({ content, reasoning });
    }
  }

  let tool_calls = finishCalls(tcs);
  if (useTools && !tool_calls.length && content.includes('<tool_call>')) {
    const ex = extractToolCalls(content);
    if (ex.calls.length) {
      tool_calls = ex.calls;
      content = ex.clean;
    }
  }
  return { content, reasoning, tool_calls, images };
}

async function anthropicChat({ provider, model, messages, tools, settings, signal, onDelta, caps }) {
  const conv = toAnthropic(messages, caps);
  const body = {
    model,
    max_tokens: Number(settings.maxTokens) || 8192,
    messages: conv.messages,
    stream: true,
  };
  if (conv.system) body.system = [{ type: 'text', text: conv.system, cache_control: { type: 'ephemeral' } }];
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
  }
  // Extended thinking: only when asked (mode 'on'), not already given up on (noReason), and the model id looks capable.
  const useThinking = settings.thinking?.mode === 'on' && !caps.noReason && THINKABLE.test(model || '');
  if (useThinking) {
    const budget = ANTHROPIC_BUDGET[settings.thinking?.effort] ?? ANTHROPIC_BUDGET.medium;
    body.thinking = { type: 'enabled', budget_tokens: budget };
    body.max_tokens = Math.max(body.max_tokens, budget + 4096); // the API requires max_tokens > budget_tokens
    // temperature must be unset (or 1) with thinking — omit it entirely.
  } else if (settings.temperature !== '' && settings.temperature != null) {
    body.temperature = Number(settings.temperature);
  }

  const res = await doFetch(
    anthropicBase(provider) + '/v1/messages',
    { method: 'POST', headers: anthropicHeaders(provider), body: JSON.stringify(body), signal },
    provider
  );

  let content = '';
  let reasoning = '';
  let stop = '';
  const blocks = [];
  for await (const { data } of sseEvents(res)) {
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.type === 'content_block_start') {
      const b = j.content_block;
      blocks[j.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, json: '' } : { type: b.type };
    } else if (j.type === 'content_block_delta') {
      const d = j.delta;
      if (d.type === 'text_delta') content += d.text;
      else if (d.type === 'thinking_delta') reasoning += d.thinking;
      else if (d.type === 'input_json_delta' && blocks[j.index]) blocks[j.index].json += d.partial_json;
      onDelta?.({ content, reasoning });
    } else if (j.type === 'message_delta') {
      stop = j.delta?.stop_reason || stop;
    } else if (j.type === 'error') {
      throw streamError(j.error?.message || 'Stream error', ANTHROPIC_STREAM_CODES[j.error?.type]);
    }
  }
  const tool_calls = blocks
    .filter((b) => b?.type === 'tool_use')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.json || '{}' } }));
  if (stop === 'refusal' && !content) content = '(The model declined to respond.)';
  return { content, reasoning, tool_calls, images: [] };
}

// caps is a per-model memo ({promptTools, noImages, noReason}) so a discovered limitation is only probed once.
export async function chat(opts) {
  const { provider, settings, messages, tools, caps } = opts;
  for (let attempt = 0; ; attempt++) {
    // The memo only records limitations discovered in auto mode; an explicit setting always wins.
    const eff = {
      promptTools: settings.toolMode === 'prompt' || (settings.toolMode !== 'native' && !!caps.promptTools),
      noImages: settings.vision === 'off' || (settings.vision !== 'on' && !!caps.noImages),
      noReason: !!caps.noReason,
    };
    // Reasoning params are only sent when the user turned thinking 'on' and we haven't already given up on them.
    const sentReason = settings.thinking?.mode === 'on' && !eff.noReason;
    try {
      return await (provider.type === 'anthropic' ? anthropicChat : openaiChat)({ ...opts, caps: eff });
    } catch (e) {
      const s = e.status;
      if (attempt < 2 && s >= 400 && s < 500 && ![401, 403, 429].includes(s)) {
        if (!eff.promptTools && tools.length && settings.toolMode === 'auto' && provider.type !== 'anthropic' && /tool|function/i.test(e.message)) {
          caps.promptTools = true;
          continue;
        }
        if (!eff.noImages && settings.vision === 'auto' && messages.some(hasImages) && /image|vision|modal|content/i.test(e.message)) {
          caps.noImages = true;
          continue;
        }
        if (sentReason && /reason|think|unsupported|unknown.*param|extra.*field|budget/i.test(e.message)) {
          caps.noReason = true;
          continue;
        }
      }
      throw e;
    }
  }
}

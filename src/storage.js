import { api } from './host/api.js';
import { isLoopback, isPrivate } from './util.js';

export const PRESETS = {
  lmstudio: { name: 'LM Studio', type: 'openai', baseUrl: 'http://localhost:1234/v1' },
  ollama: { name: 'Ollama', type: 'openai', baseUrl: 'http://localhost:11434/v1' },
  openai: { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  gemini: { name: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  openrouter: { name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  groq: { name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  mistral: { name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1' },
  deepseek: { name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  xai: { name: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1' },
  together: { name: 'Together AI', type: 'openai', baseUrl: 'https://api.together.xyz/v1' },
  custom: { name: 'Custom (OpenAI-compatible)', type: 'openai', baseUrl: '' },
};

const provider = (id) => ({ id, ...PRESETS[id], apiKey: '', model: '', models: [] });

export const DEFAULTS = {
  providers: [provider('lmstudio'), provider('ollama')],
  activeProviderId: 'lmstudio',
  // Vendor-aware (v1.4). Old { providerId, model, api, size } objects are migrated on load (see migrateImage).
  image: { vendor: 'none', providerId: '', apiKey: '', baseUrl: '', model: '', size: '', api: 'images' },
  mcpServers: [],
  approval: 'ask', // ask | auto
  vision: 'auto', // auto | on | off
  toolMode: 'auto', // auto | native | prompt
  maxSteps: 0, // model turns per prompt; 0 = no limit
  maxTokens: '',
  temperature: '',
  contextChars: 100000,
  maxToolChars: 12000,
  trustedInput: false,
  customPrompt: '',
  // Model reasoning. mode: 'auto' (provider default, send no knob) | 'on' (request reasoning at `effort`) | 'off'
  // (ask the model not to think where we can). effort: 'minimal' | 'low' | 'medium' | 'high' (only when mode 'on').
  // show: render the Thinking block in the chat (pure UI).
  thinking: { mode: 'auto', effort: 'medium', show: true },
  // Tool use. enabled:false => send no tools (plain chat). groups: per-category enable (missing => on).
  tools: { enabled: true, groups: { browser: true, web: true, images: true, computer: true, memory: true } },
  // Local program that gives the agent OS tools; approval: 'ask' (always confirm its tools) | 'follow' (use `approval`).
  companion: { enabled: false, url: 'http://127.0.0.1:8765', token: '', approval: 'ask' },
  // Cross-chat memory: inject saved notes into new runs; maxInjectChars caps how much is injected per run.
  memory: { enabled: true, maxInjectChars: 4000 },
  queueMode: 'auto', // auto (run queued prompts back to back) | step (pause after each)
  notifications: true, // desktop notifications (approvals, finished/failed jobs) while the panel is closed
};

// v1.1 saved its default step limit (40) with every settings save; v1.2 has no limit unless the user sets one.
const OLD_DEFAULT_STEPS = 40;

// v1.4 made settings.image vendor-aware. A pre-v1.4 object has no `vendor`: one that named an OpenAI-compatible
// provider becomes vendor 'openai'; otherwise image tools were effectively off, so 'none'. Unknown keys are kept.
function migrateImage(image) {
  if (!image || typeof image !== 'object') return {};
  if (typeof image.vendor === 'string' && image.vendor) return image; // already vendor-aware
  return { ...image, vendor: image.providerId ? 'openai' : 'none' };
}

export async function loadSettings() {
  const { settings = {} } = (await api.storage.local.get('settings')) || {};
  const base = structuredClone(DEFAULTS);
  const s = {
    ...base,
    ...settings,
    image: { ...base.image, ...migrateImage(settings.image) },
    companion: { ...base.companion, ...settings.companion },
    memory: { ...base.memory, ...settings.memory },
    thinking: { ...base.thinking, ...settings.thinking },
    tools: { ...base.tools, ...settings.tools, groups: { ...base.tools.groups, ...(settings.tools?.groups) } },
  };
  if (!settings.stepsV12) {
    if (Number(s.maxSteps) === OLD_DEFAULT_STEPS) s.maxSteps = 0;
    s.stepsV12 = true;
  }
  return s;
}

export async function saveSettings(s) {
  await api.storage.local.set({ settings: s });
  await syncOriginRules(s);
}

// Local servers (Ollama in particular) reject the chrome-extension:// Origin header.
// Rewrite it on our own requests to local hosts so no server-side CORS setup is needed.
let ruleSync = Promise.resolve();

// Serialised: overlapping updates would both read the same old rule set and collide on rule ids.
export function syncOriginRules(s) {
  ruleSync = ruleSync.then(() => applyOriginRules(s));
  return ruleSync;
}

async function applyOriginRules(s) {
  const origins = new Map();
  // [url, own]: the companion only accepts its own origin; other LAN servers (Ollama) expect a localhost one.
  const urls = [
    ...(s.providers || []).map((p) => [p.baseUrl, false]),
    ...(s.mcpServers || []).map((m) => [m.url, false]),
    [s.companion?.url, true],
    // A self-hosted image endpoint (base URL override) needs the same Origin rewrite when it is loopback/private.
    [s.image?.baseUrl, false],
  ];
  for (const [u, own] of urls) {
    try {
      const x = new URL(u);
      if (isPrivate(x.hostname)) origins.set(x.origin, own || isLoopback(x.hostname) ? x.origin : 'http://localhost');
    } catch {}
  }
  const addRules = [...origins].map(([origin, value], i) => ({
    id: i + 1,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'set', value }] },
    condition: { urlFilter: `|${origin}/`, initiatorDomains: [api.runtime.id], resourceTypes: ['xmlhttprequest'] },
  }));
  try {
    const old = await api.declarativeNetRequest.getDynamicRules();
    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules });
  } catch (e) {
    console.warn('Origin rule sync failed', e);
  }
}

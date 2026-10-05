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
  image: { providerId: '', model: '', api: 'images', size: '' },
  mcpServers: [],
  approval: 'ask', // ask | auto
  vision: 'auto', // auto | on | off
  toolMode: 'auto', // auto | native | prompt
  maxSteps: 40,
  maxTokens: '',
  temperature: '',
  contextChars: 100000,
  maxToolChars: 12000,
  trustedInput: false,
  customPrompt: '',
  // Local program that gives the agent OS tools; approval: 'ask' (always confirm its tools) | 'follow' (use `approval`).
  companion: { enabled: false, url: 'http://127.0.0.1:8765', token: '', approval: 'ask' },
  queueMode: 'auto', // auto (run queued prompts back to back) | step (pause after each)
};

export async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const base = structuredClone(DEFAULTS);
  return {
    ...base,
    ...settings,
    image: { ...base.image, ...settings.image },
    companion: { ...base.companion, ...settings.companion },
  };
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ settings: s });
  await syncOriginRules(s);
}

const isLoopback = (h) => h === 'localhost' || h === '[::1]' || /^127\./.test(h);
const isPrivate = (h) =>
  isLoopback(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/.test(h);

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
    condition: { urlFilter: `|${origin}/`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
  }));
  try {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules });
  } catch (e) {
    console.warn('Origin rule sync failed', e);
  }
}

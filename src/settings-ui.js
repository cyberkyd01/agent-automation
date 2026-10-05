import { DEFAULTS, PRESETS } from './storage.js';
import { listModels, pickModel } from './providers.js';
import { newId, repoLink } from './util.js';
import { QUEUE_MODES, computerToolsSection, ensureToolSettings, mcpTestControls } from './settings-tools-ui.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let uid = 0;

function textInput(value, type = 'text', placeholder = '') {
  const i = el('input');
  i.type = type;
  i.value = value ?? '';
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.autocomplete = 'off';
  return i;
}

function numberInput(value, { min, max, step = 1, placeholder = '' } = {}) {
  const i = textInput(value, 'number', placeholder);
  if (min != null) i.min = String(min);
  if (max != null) i.max = String(max);
  i.step = String(step);
  return i;
}

function textArea(value, { rows = 3, placeholder = '', mono = false } = {}) {
  const t = el('textarea', mono ? 'ctl mono' : 'ctl');
  t.value = value ?? '';
  t.rows = rows;
  t.placeholder = placeholder;
  t.spellcheck = !mono;
  return t;
}

function setOptions(sel, options, value) {
  sel.replaceChildren(
    ...options.map(([v, label]) => {
      const o = el('option', null, label);
      o.value = v;
      return o;
    })
  );
  sel.value = value ?? '';
}

function selectBox(options, value) {
  const s = el('select');
  setOptions(s, options, value);
  return s;
}

function checkbox(checked) {
  const c = el('input');
  c.type = 'checkbox';
  c.checked = !!checked;
  return c;
}

function button(label, cls = '') {
  const b = el('button', `btn ${cls}`.trim(), label);
  b.type = 'button';
  return b;
}

// Two clicks to remove, so a stray click can't delete a configured entry.
function removeButton(onConfirm) {
  const b = button('Remove', 'danger');
  let timer = 0;
  const reset = () => {
    clearTimeout(timer);
    timer = 0;
    b.textContent = 'Remove';
    b.classList.remove('confirm');
  };
  b.addEventListener('click', () => {
    if (timer) {
      reset();
      onConfirm();
      return;
    }
    b.textContent = 'Confirm remove';
    b.classList.add('confirm');
    timer = setTimeout(reset, 3000);
  });
  b.addEventListener('blur', () => timer && reset());
  return b;
}

function hintFor(ctl, text) {
  const h = el('div', 'hint', text);
  h.id = `${ctl.id}-hint`;
  ctl.setAttribute('aria-describedby', h.id);
  return h;
}

function field(label, ctl, hint) {
  const f = el('div', 'field');
  ctl.id ||= `set-${++uid}`;
  const l = el('label', 'field-label', label);
  l.htmlFor = ctl.id;
  f.append(l, ctl);
  if (hint) f.append(hintFor(ctl, hint));
  return f;
}

function checkField(label, ctl, hint) {
  const f = el('div', 'field check');
  ctl.id ||= `set-${++uid}`;
  const l = el('label');
  l.append(ctl, el('span', null, label));
  f.append(l);
  if (hint) f.append(hintFor(ctl, hint));
  return f;
}

function row(...children) {
  const r = el('div', 'row2');
  r.append(...children);
  return r;
}

function section(title, hint) {
  const s = el('section', 'set-section');
  s.append(el('h3', null, title));
  if (hint) s.append(el('p', 'hint', hint));
  return s;
}

export function renderSettings(container, settings, { save, onProvidersChanged }) {
  // Settings saved by an older version lack the newer fields.
  ensureToolSettings(settings, DEFAULTS);
  const commit = () => Promise.resolve().then(save).catch((e) => console.error('Saving settings failed', e));
  const headerChanged = () => onProvidersChanged?.();

  const onChange = (ctl, fn) =>
    ctl.addEventListener('change', () => {
      fn();
      commit();
    });
  const bindText = (obj, key, ctl, after) =>
    onChange(ctl, () => {
      obj[key] = ctl.value.trim();
      after?.();
    });
  const bindSelect = (obj, key, ctl, after) =>
    onChange(ctl, () => {
      obj[key] = ctl.value;
      after?.();
    });
  // Blank stores '' for optional fields and restores the default for required ones.
  const bindNumber = (obj, key, ctl, { blank = false, int = true, min, max } = {}) =>
    onChange(ctl, () => {
      const raw = ctl.value.trim();
      let v = raw === '' ? NaN : Number(raw);
      if (Number.isFinite(v)) {
        if (int) v = Math.round(v);
        if (min != null) v = Math.max(min, v);
        if (max != null) v = Math.min(max, v);
      } else v = blank ? '' : DEFAULTS[key];
      obj[key] = v;
      ctl.value = v === '' ? '' : String(v);
    });

  // The new tool sections live in settings-tools-ui.js and build their controls with these same helpers.
  const kit = { el, textInput, numberInput, textArea, selectBox, checkbox, button, removeButton, field, checkField, row, section, onChange, bindSelect, commit };

  /* ---------- providers ---------- */

  const providerList = el('div', 'cards');
  const imageProvider = el('select');

  const refreshImageProviders = () => {
    const img = settings.image;
    const opts = [['', 'None'], ...settings.providers.filter((p) => p.type === 'openai').map((p) => [p.id, p.name || 'Unnamed provider'])];
    if (img.providerId && !opts.some(([v]) => v === img.providerId)) {
      img.providerId = '';
      commit();
    }
    setOptions(imageProvider, opts, img.providerId);
  };

  const renderProviders = () => {
    providerList.replaceChildren(...settings.providers.map(providerCard));
    if (!settings.providers.length) providerList.append(el('p', 'hint', 'No providers yet. Add one below.'));
  };

  function providerCard(p) {
    const card = el('div', 'card');

    const name = textInput(p.name, 'text', 'Name');
    bindText(p, 'name', name, () => {
      headerChanged();
      refreshImageProviders();
    });

    const type = selectBox([['openai', 'OpenAI-compatible'], ['anthropic', 'Anthropic']], p.type);
    // A different server or API shape makes the cached model list meaningless.
    bindSelect(p, 'type', type, () => {
      p.models = [];
      headerChanged();
      refreshImageProviders();
    });

    const base = textInput(p.baseUrl, 'url', p.type === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:1234/v1');
    bindText(p, 'baseUrl', base, () => {
      p.models = [];
      headerChanged();
    });

    const key = textInput(p.apiKey, 'password', 'not needed for local servers');
    bindText(p, 'apiKey', key);

    const result = el('div', 'test-result');
    result.setAttribute('role', 'status');
    result.hidden = true;

    const test = button('Test connection');
    test.addEventListener('click', async () => {
      test.disabled = true;
      result.hidden = false;
      result.className = 'test-result';
      result.textContent = 'Testing…';
      try {
        const models = await listModels(p, AbortSignal.timeout(20000));
        p.models = models;
        if (!p.model) p.model = pickModel(models);
        await commit();
        headerChanged();
        result.classList.add('ok');
        result.textContent = `✓ ${models.length} model${models.length === 1 ? '' : 's'}`;
      } catch (e) {
        result.classList.add('error');
        result.textContent = e?.message || String(e);
      } finally {
        test.disabled = false;
      }
    });

    const remove = removeButton(() => {
      const i = settings.providers.indexOf(p);
      if (i >= 0) settings.providers.splice(i, 1);
      if (!settings.providers.some((x) => x.id === settings.activeProviderId)) {
        settings.activeProviderId = settings.providers[0]?.id || '';
      }
      renderProviders();
      refreshImageProviders();
      headerChanged();
      commit();
      addProvider.focus();
    });

    const actions = el('div', 'card-actions');
    actions.append(test, remove);
    card.append(row(field('Name', name), field('Type', type)), field('Base URL', base), field('API key', key), actions, result);
    return card;
  }

  const uniqueName = (base) => {
    let name = base;
    for (let k = 2; settings.providers.some((p) => p.name === name); k++) name = `${base} ${k}`;
    return name;
  };

  const addProvider = selectBox([['', 'Add provider…'], ...Object.entries(PRESETS).map(([k, v]) => [k, v.name])], '');
  addProvider.className = 'add-select';
  addProvider.setAttribute('aria-label', 'Add provider');
  addProvider.addEventListener('change', () => {
    const preset = PRESETS[addProvider.value];
    addProvider.value = '';
    if (!preset) return;
    const p = { id: newId(), name: uniqueName(preset.name), type: preset.type, baseUrl: preset.baseUrl, apiKey: '', model: '', models: [] };
    settings.providers.push(p);
    if (!settings.providers.some((x) => x.id === settings.activeProviderId)) settings.activeProviderId = p.id;
    renderProviders();
    refreshImageProviders();
    headerChanged();
    commit();
    // Jump to the field the user most likely has to fill in next.
    const card = providerList.lastElementChild;
    const local = /\/\/(localhost|127\.)/.test(p.baseUrl);
    card?.querySelector(!p.baseUrl ? 'input[type=url]' : local ? 'input' : 'input[type=password]')?.focus();
    card?.scrollIntoView({ block: 'nearest' });
  });

  renderProviders();
  const providers = section('Providers', 'Model servers and APIs. Pick the active one and its model in the header.');
  providers.append(providerList, addProvider);

  /* ---------- image generation ---------- */

  const img = settings.image;
  refreshImageProviders();
  bindSelect(img, 'providerId', imageProvider);

  const imgModel = textInput(img.model, 'text', 'e.g. gpt-image-1');
  bindText(img, 'model', imgModel);

  const imgApi = selectBox(
    [
      ['images', 'Images API (/images/generations, /images/edits)'],
      ['chat', 'Chat completions with image output'],
    ],
    img.api
  );
  bindSelect(img, 'api', imgApi);

  const imgSize = textInput(img.size, 'text', '1024x1024');
  bindText(img, 'size', imgSize);

  const image = section('Image generation', 'Lets the agent create and edit images. Only OpenAI-compatible providers are listed.');
  image.append(
    field('Provider', imageProvider),
    field('Model ID', imgModel),
    field('API mode', imgApi, 'Use chat completions for models that return images in chat replies (e.g. Gemini image models via OpenRouter).'),
    field('Size', imgSize, 'Optional. Leave blank for the model default.')
  );

  /* ---------- computer tools (local companion) ---------- */

  const computer = computerToolsSection(settings, kit);

  /* ---------- remote MCP servers ---------- */

  const mcpList = el('div', 'cards');
  const renderMcp = () => mcpList.replaceChildren(...settings.mcpServers.map(mcpCard));

  function mcpCard(s) {
    const card = el('div', 'card');
    const name = textInput(s.name, 'text', 'e.g. github');
    bindText(s, 'name', name);
    const url = textInput(s.url, 'url', 'https://example.com/mcp');
    bindText(s, 'url', url);
    const headers = textArea(s.headers, { rows: 2, placeholder: 'Authorization: Bearer …', mono: true });
    bindText(s, 'headers', headers);
    const enabled = checkbox(s.enabled !== false);
    onChange(enabled, () => {
      s.enabled = enabled.checked;
    });
    const remove = removeButton(() => {
      const i = settings.mcpServers.indexOf(s);
      if (i >= 0) settings.mcpServers.splice(i, 1);
      renderMcp();
      commit();
      addMcp.focus();
    });
    // The fields save on change, which fires on blur just before this click, so `s` is current.
    const test = mcpTestControls(kit, () => s);
    const actions = el('div', 'card-actions');
    actions.append(checkField('Enabled', enabled), test.button, remove);
    card.dataset.mcpCard = '';
    card.append(
      field('Name', name, 'Prefixes the tool names this server provides.'),
      field('URL', url),
      field('Headers', headers, 'One “Header: value” per line, e.g. Authorization: Bearer <token>.'),
      actions,
      test.result
    );
    return card;
  }

  const addMcp = button('Add MCP server');
  addMcp.addEventListener('click', () => {
    settings.mcpServers.push({ id: newId(), name: '', url: '', headers: '', enabled: true });
    renderMcp();
    commit();
    mcpList.lastElementChild?.querySelector('input')?.focus();
  });

  renderMcp();
  const mcp = section(
    'Remote MCP servers',
    'Servers reached over HTTP or SSE. Local (stdio) servers are set up under Computer tools.'
  );
  mcp.id = 'remoteMcp';
  mcp.append(mcpList, addMcp);

  /* ---------- behaviour ---------- */

  const approval = selectBox([['ask', 'Ask before acting'], ['auto', 'Act without asking']], settings.approval);
  bindSelect(settings, 'approval', approval);

  const queueMode = selectBox(QUEUE_MODES, settings.queueMode);
  // Not 'queueMode': the queue bar's select already has that id, and a duplicate would steal this label.
  queueMode.id = 'settingsQueueMode';
  bindSelect(settings, 'queueMode', queueMode);

  const vision = selectBox([['auto', 'Auto-detect'], ['on', 'On'], ['off', 'Off']], settings.vision);
  bindSelect(settings, 'vision', vision);

  const toolMode = selectBox(
    [
      ['auto', 'Auto (native, fall back to prompted)'],
      ['native', 'Native'],
      ['prompt', 'Prompted (for models without tool support)'],
    ],
    settings.toolMode
  );
  bindSelect(settings, 'toolMode', toolMode);

  const maxSteps = numberInput(settings.maxSteps, { min: 1, placeholder: String(DEFAULTS.maxSteps) });
  bindNumber(settings, 'maxSteps', maxSteps, { min: 1, max: 1000 });

  const maxTokens = numberInput(settings.maxTokens, { min: 1, placeholder: 'Provider default' });
  bindNumber(settings, 'maxTokens', maxTokens, { blank: true, min: 1 });

  const temperature = numberInput(settings.temperature, { min: 0, max: 2, step: 0.1, placeholder: 'Default' });
  bindNumber(settings, 'temperature', temperature, { blank: true, int: false, min: 0, max: 2 });

  const contextChars = numberInput(settings.contextChars, { min: 2000, step: 1000, placeholder: String(DEFAULTS.contextChars) });
  bindNumber(settings, 'contextChars', contextChars, { min: 2000 });

  const maxToolChars = numberInput(settings.maxToolChars, { min: 2000, step: 500, placeholder: String(DEFAULTS.maxToolChars) });
  bindNumber(settings, 'maxToolChars', maxToolChars, { min: 2000 });

  const trusted = checkbox(settings.trustedInput);
  onChange(trusted, () => {
    settings.trustedInput = trusted.checked;
  });

  const customPrompt = textArea(settings.customPrompt, { rows: 4, placeholder: 'e.g. Reply in British English. Never submit payment forms.' });
  bindText(settings, 'customPrompt', customPrompt);

  const behaviour = section('Behaviour');
  behaviour.append(
    field('Approval', approval, 'Ask pauses for your OK before actions that change pages or data.'),
    field('Queue mode', queueMode, 'You can also switch this from the queue bar in a chat.'),
    row(
      field('Vision', vision, 'Send screenshots and images to the model.'),
      field('Max steps', maxSteps, 'Model turns per request.')
    ),
    field('Tool calling', toolMode, 'Prompted describes tools in the system prompt instead of using the API’s tool calling.'),
    row(
      field('Max output tokens', maxTokens, 'Blank = provider default.'),
      field('Temperature', temperature, 'Blank = model default.')
    ),
    row(
      field('Context budget (chars)', contextChars, 'Older history is trimmed to fit.'),
      field('Max tool output (chars)', maxToolChars, 'Longer tool results are cut.')
    ),
    checkField(
      'Trusted input events',
      trusted,
      'Uses Chrome’s debugger for real mouse/keyboard events on sites that ignore synthetic ones. Chrome shows a debugging banner while active.'
    ),
    field('Custom instructions', customPrompt, 'Added to the system prompt on every request.')
  );

  /* ---------- about ---------- */

  const { name: appName, version } = chrome.runtime.getManifest();
  const about = section('About');
  about.append(el('p', 'about-name', `${appName} ${version}`), el('p', 'hint', 'Open source under the MIT licence.'));
  const rate = repoLink('btn primary', '★ Rate on GitHub');
  const issues = repoLink('btn', 'Report an issue', '/issues');
  const guide = repoLink('btn', 'User guide', '/blob/main/docs/USER_GUIDE.md');
  if (rate && issues && guide) {
    const links = el('div', 'about-links');
    links.append(rate, issues, guide);
    about.append(links);
  }

  container.replaceChildren(el('p', 'hint settings-note', 'Changes are saved automatically.'), providers, image, computer, mcp, behaviour, about);
}

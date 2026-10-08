// Image generation / editing adapter layer (v1.4).
//
// One clean surface over several hosted vendors plus the two existing OpenAI-compatible paths. tools.js calls
// generateImage / editImage; settings-ui.js reads IMAGE_VENDORS and calls testImageVendor. Every failure is a
// readable Error naming the vendor and the cause; every fetch gets the caller's `signal`.

import { blobToDataUrl, httpError, pause } from './util.js';
import { MAX_ATTACH_BYTES, toBlob } from './files.js';

// One entry per vendor describing defaults and capabilities, for the UI (labels, suggestions, key links) and the
// engine (default base URL + model). Keep in sync with the Settings → Images page.
export const IMAGE_VENDORS = {
  none: { label: 'None (image tools off)', byok: false },
  'chat-model': {
    label: 'Your main chat model',
    byok: false,
    note: 'Uses the model selected in the panel header, when it can output images.',
  },
  openai: {
    label: 'OpenAI-compatible provider',
    byok: false,
    baseUrl: '',
    edit: true,
    sizes: ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
  },
  stability: {
    label: 'Stability AI',
    byok: true,
    baseUrl: 'https://api.stability.ai',
    edit: true,
    // 'core'/'ultra' pick their own generate endpoint; an 'sd3*' id selects the sd3 endpoint and is sent as its
    // `model` form field (current SD3.5 ids — bare 'sd3' is no longer a valid model value).
    models: ['core', 'ultra', 'sd3.5-large', 'sd3.5-large-turbo', 'sd3.5-medium'],
    sizes: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4', '21:9', '9:21'],
    keyHelp: 'platform.stability.ai → API Keys',
    keyUrl: 'https://platform.stability.ai/account/keys',
  },
  fal: {
    label: 'fal.ai',
    byok: true,
    baseUrl: 'https://fal.run',
    edit: true,
    models: ['fal-ai/flux/dev', 'fal-ai/flux/schnell', 'fal-ai/flux-pro/v1.1', 'fal-ai/flux/dev/image-to-image', 'fal-ai/fast-sdxl'],
    keyHelp: 'fal.ai → Dashboard → Keys',
    keyUrl: 'https://fal.ai/dashboard/keys',
  },
  replicate: {
    label: 'Replicate',
    byok: true,
    baseUrl: 'https://api.replicate.com',
    edit: true,
    async: true,
    models: ['black-forest-labs/flux-dev', 'black-forest-labs/flux-schnell', 'black-forest-labs/flux-1.1-pro', 'stability-ai/sdxl'],
    keyHelp: 'replicate.com → Account → API tokens',
    keyUrl: 'https://replicate.com/account/api-tokens',
  },
  google: {
    label: 'Google (Gemini / Imagen)',
    byok: true,
    baseUrl: 'https://generativelanguage.googleapis.com',
    edit: true,
    // Gemini image models ("Nano Banana") work with an AI Studio key for both generate and edit via
    // :generateContent. Imagen 3 was retired in the Gemini API; imagen-4.0 ids (where you have access) still use
    // :predict. Default to the Gemini model so a plain AI Studio key works today.
    models: ['gemini-2.5-flash-image', 'imagen-4.0-generate-001', 'imagen-4.0-ultra-generate-001'],
    sizes: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21'],
    keyHelp: 'aistudio.google.com → Get API key',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
};

/* ---------- small helpers ---------- */

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
const short = (s, n = 300) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const clampN = (n) => Math.min(Math.max(1, Math.floor(Number(n) || 1)), 8);

const SHORT_NAME = {
  'chat-model': 'your chat model',
  openai: 'the OpenAI-compatible provider',
  stability: 'Stability AI',
  fal: 'fal.ai',
  replicate: 'Replicate',
  google: 'Google',
};
const shortName = (vendor) => SHORT_NAME[vendor] || IMAGE_VENDORS[vendor]?.label || vendor || 'the image service';

const authHeaders = (key) => (key ? { Authorization: `Bearer ${key}` } : {});
const jsonHeaders = (key) => ({ 'Content-Type': 'application/json', ...authHeaders(key) });
const falHeaders = (key) => ({ 'Content-Type': 'application/json', ...(key ? { Authorization: `Key ${key}` } : {}) });

const b64Mime = (b64) => (b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png');

// A base64 data: URL → { mime, b64 }. Edit sources arrive as base64 PNG data URLs.
function splitDataUrl(u) {
  const s = String(u || '');
  const comma = s.indexOf(',');
  if (!s.startsWith('data:') || comma < 0) return { mime: 'image/png', b64: '' };
  const mime = s.slice(5, comma).split(';')[0] || 'image/png';
  return { mime, b64: s.slice(comma + 1) };
}

// 'WxH' (or 'W:H') → { w, h }, else null.
function parseSize(size) {
  const m = /^(\d+)\s*[x×:]\s*(\d+)$/i.exec(String(size || '').trim());
  if (!m) return null;
  const w = +m[1];
  const h = +m[2];
  return w && h ? { w, h } : null;
}

// Nearest supported aspect ratio for a 'WxH'/'W:H' size. '' when the size is blank/unparseable.
function aspectRatio(size, allowed) {
  const s = parseSize(size);
  if (!s) return '';
  const r = s.w / s.h;
  const opts = allowed || ['1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4', '21:9', '9:21', '4:3', '3:4'];
  let best = opts[0];
  let bd = Infinity;
  for (const o of opts) {
    const [a, b] = o.split(':').map(Number);
    const d = Math.abs(r - a / b);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

async function vendorError(vendor, res) {
  const base = await httpError(res); // "HTTP <status>: <message>"
  const s = res.status;
  const name = shortName(vendor);
  let hint = '';
  if (s === 401 || s === 403) hint = ` — check the API key for ${name}.`;
  else if (s === 404) hint = ` — ${name} did not recognise that model or endpoint; check the model id and base URL.`;
  else if (s === 429) hint = ` — ${name} rate limit reached; wait a moment and try again.`;
  else if (s >= 500) hint = ` — ${name} had a server error; try again shortly.`;
  const e = new Error(`${name}: ${base.message}${hint}`);
  e.status = s;
  return e;
}

async function vendorFetch(vendor, url, init, signal) {
  let res;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Cannot reach ${shortName(vendor)} at ${url} (${e.message}).`);
  }
  if (!res.ok) throw await vendorError(vendor, res);
  return res;
}

// A Blob → data URL, rejecting anything over the attachment cap.
async function blobToCappedDataUrl(blob, vendor) {
  if (blob.size > MAX_ATTACH_BYTES) {
    throw new Error(`${shortName(vendor)} returned an image larger than ${Math.round(MAX_ATTACH_BYTES / 1048576)} MB.`);
  }
  return blobToDataUrl(blob);
}

// A remote image URL → data URL, fetched WITHOUT credentials and size-capped. data: URLs pass through.
async function fetchImageDataUrl(url, signal, vendor) {
  if (typeof url !== 'string' || !url) throw new Error(`${shortName(vendor)} returned an invalid image reference.`);
  if (url.startsWith('data:')) return url;
  let res;
  try {
    res = await fetch(url, { credentials: 'omit', signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Could not download the image ${shortName(vendor)} produced (${e.message}).`);
  }
  if (!res.ok) throw await httpError(res);
  const len = Number(res.headers.get('content-length'));
  if (len && len > MAX_ATTACH_BYTES) {
    throw new Error(`${shortName(vendor)} returned an image larger than ${Math.round(MAX_ATTACH_BYTES / 1048576)} MB.`);
  }
  return blobToCappedDataUrl(await res.blob(), vendor);
}

const collectUrls = (urls, signal, vendor) => Promise.all(urls.map((u) => fetchImageDataUrl(u, signal, vendor)));

/* ---------- configuration ---------- */

// Resolve the settings.image object (+ the provider to use for 'openai'/'chat-model') into a concrete request
// config, or throw a plain, readable reason. `provider` is the referenced OpenAI-compatible provider for the
// 'openai' vendor, the active provider for 'chat-model', and unused for the native vendors.
function configFromParts(image = {}, provider) {
  const vendor = image.vendor || 'none';
  if (vendor === 'none') return fail('No image model configured — open Settings → Images and choose a vendor.');
  const def = IMAGE_VENDORS[vendor];
  if (!def) return fail(`Unknown image vendor "${vendor}" — open Settings → Images.`);

  if (vendor === 'chat-model') {
    if (!provider || !provider.model) return fail('No chat model selected — pick a provider and model in the panel header (the image tools use your main chat model).');
    return { vendor, mode: 'chat', base: trimSlash(provider.baseUrl), key: provider.apiKey || '', model: provider.model };
  }
  if (vendor === 'openai') {
    if (!provider) return fail('The OpenAI-compatible provider for images is not set — open Settings → Images.');
    if (!image.model) return fail('No image model is set — open Settings → Images and enter a model id.');
    return {
      vendor,
      mode: image.api === 'chat' ? 'chat' : 'images',
      base: trimSlash(image.baseUrl || provider.baseUrl),
      key: provider.apiKey || '',
      model: image.model,
    };
  }
  // Native BYOK vendors.
  if (!image.apiKey) return fail(`Add your ${def.label} API key in Settings → Images.`);
  return {
    vendor,
    mode: 'native',
    base: trimSlash(image.baseUrl || def.baseUrl),
    key: image.apiKey,
    model: image.model || (def.models && def.models[0]) || '',
    size: image.size || '',
  };
}

function fail(reason) {
  const e = new Error(reason);
  e.notConfigured = true;
  throw e;
}

// The provider object generateImage/editImage should hand configFromParts.
function providerFor(settings, activeProvider, image) {
  if ((image.vendor || 'none') === 'openai') return (settings.providers || []).find((p) => p.id === image.providerId) || null;
  return activeProvider || (settings.providers || []).find((p) => p.id === settings.activeProviderId) || null;
}

/* ---------- public API ---------- */

export async function generateImage({ prompt, size, n = 1, settings = {}, activeProvider, signal } = {}) {
  const image = settings.image || {};
  const cfg = configFromParts(image, providerFor(settings, activeProvider, image));
  prompt = String(prompt ?? '');
  if (!prompt.trim()) throw new Error('An image prompt is required.');
  const dataUrls = await runVendor(cfg, { op: 'generate', prompt, images: [], mask: null, size: size || image.size || '', n: clampN(n), signal });
  if (!dataUrls.length) throw new Error(`${shortName(cfg.vendor)} returned no images.`);
  return { dataUrls };
}

export async function editImage({ prompt, images = [], mask, size, n = 1, settings = {}, activeProvider, signal } = {}) {
  const image = settings.image || {};
  const cfg = configFromParts(image, providerFor(settings, activeProvider, image));
  prompt = String(prompt ?? '');
  if (!prompt.trim()) throw new Error('An edit instruction (prompt) is required.');
  if (!images.length) throw new Error('No source image to edit.');
  const dataUrls = await runVendor(cfg, { op: 'edit', prompt, images, mask: mask || null, size: size || image.size || '', n: clampN(n), signal });
  if (!dataUrls.length) throw new Error(`${shortName(cfg.vendor)} returned no images.`);
  return { dataUrls };
}

// { ok } when the image tools can run; { ok:false, reason } (a plain sentence) otherwise.
export function imageReady(settings = {}) {
  const image = settings.image || {};
  try {
    configFromParts(image, providerFor(settings, null, image));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// A connection/auth check for the Settings "Test" button. Never throws. `provider` is what the UI resolved
// (the referenced provider for 'openai', the active provider for 'chat-model').
export async function testImageVendor(image = {}, activeProvider, signal) {
  let cfg;
  try {
    cfg = configFromParts(image, activeProvider);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  try {
    switch (cfg.vendor) {
      case 'chat-model':
      case 'openai': {
        await vendorFetch(cfg.vendor, `${cfg.base}/models`, { headers: jsonHeaders(cfg.key) }, signal);
        return { ok: true, info: `Reachable. Using model ${cfg.model || '(none)'} — image output depends on the model.` };
      }
      case 'stability': {
        await vendorFetch(cfg.vendor, `${cfg.base}/v1/user/account`, { headers: authHeaders(cfg.key) }, signal);
        return { ok: true, info: `API key accepted by Stability AI (model ${cfg.model || 'core'}).` };
      }
      case 'replicate': {
        await vendorFetch(cfg.vendor, `${cfg.base}/v1/account`, { headers: authHeaders(cfg.key) }, signal);
        return { ok: true, info: `API token accepted by Replicate (model ${cfg.model || '(set one)'}).` };
      }
      case 'google': {
        await vendorFetch(cfg.vendor, `${cfg.base}/v1beta/models`, { headers: { 'x-goog-api-key': cfg.key } }, signal);
        return { ok: true, info: `API key accepted by Google (model ${cfg.model || '(set one)'}).` };
      }
      case 'fal':
        // fal has no cheap auth probe; the key is verified on the first generation.
        return { ok: true, info: `API key stored for fal.ai (model ${cfg.model || '(set one)'}). It is checked on first use.` };
      default:
        return { ok: false, error: `Cannot test vendor "${cfg.vendor}".` };
    }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: 'The test was cancelled.' };
    return { ok: false, error: e.message };
  }
}

/* ---------- dispatch ---------- */

function runVendor(cfg, ctx) {
  if (cfg.mode === 'chat') return chatModalImages(cfg, ctx);
  if (cfg.mode === 'images') return openaiImagesApi(cfg, ctx);
  switch (cfg.vendor) {
    case 'stability':
      return stabilityImages(cfg, ctx);
    case 'fal':
      return falImages(cfg, ctx);
    case 'replicate':
      return replicateImages(cfg, ctx);
    case 'google':
      return googleImages(cfg, ctx);
    default:
      return Promise.reject(new Error(`Image vendor "${cfg.vendor}" cannot create images.`));
  }
}

/* ---------- chat modalities (chat-model, and openai api:'chat') ---------- */

async function chatModalImages(cfg, { prompt, images, signal }) {
  const content = [{ type: 'text', text: prompt }];
  for (const url of images || []) content.push({ type: 'image_url', image_url: { url } });
  const body = { model: cfg.model, messages: [{ role: 'user', content }], modalities: ['image', 'text'] };
  const res = await vendorFetch(cfg.vendor, `${cfg.base}/chat/completions`, { method: 'POST', headers: jsonHeaders(cfg.key), body: JSON.stringify(body) }, signal);
  const j = await res.json();
  const msg = j.choices?.[0]?.message || {};
  const parts = Array.isArray(msg.content) ? msg.content : [];
  const urls = [...(msg.images || []), ...parts.filter((p) => p?.type === 'image_url')].map((im) => im?.image_url?.url || im?.url).filter(Boolean);
  if (!urls.length) {
    const said = typeof msg.content === 'string' ? msg.content : parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
    throw new Error(`${shortName(cfg.vendor)} returned no image.` + (said ? ' It replied: ' + short(said, 500) : ''));
  }
  return collectUrls(urls, signal, cfg.vendor);
}

/* ---------- OpenAI images API (vendor openai, api:'images') ---------- */

async function openaiImagesApi(cfg, { op, prompt, images, size, n, signal }) {
  let j;
  if (op === 'edit') {
    const fd = new FormData();
    fd.append('model', cfg.model);
    fd.append('prompt', prompt);
    fd.append('image', toBlob(images[0]), 'image.png');
    if (size) fd.append('size', size);
    if (n > 1) fd.append('n', String(n));
    const res = await vendorFetch(cfg.vendor, `${cfg.base}/images/edits`, { method: 'POST', headers: authHeaders(cfg.key), body: fd }, signal);
    j = await res.json();
  } else {
    const body = { model: cfg.model, prompt, n, ...(size ? { size } : {}) };
    const res = await vendorFetch(cfg.vendor, `${cfg.base}/images/generations`, { method: 'POST', headers: jsonHeaders(cfg.key), body: JSON.stringify(body) }, signal);
    j = await res.json();
  }
  const out = [];
  for (const d of j.data || []) {
    if (d.b64_json) out.push(`data:${b64Mime(d.b64_json)};base64,${d.b64_json}`);
    else if (d.url) out.push(await fetchImageDataUrl(d.url, signal, cfg.vendor));
  }
  return out;
}

/* ---------- Stability AI (v2beta Stable Image REST) ---------- */

// settings.image.model selects the generate engine: 'core' (default), 'ultra', 'sd3', or an 'sd3-*' sub-model.
function stabilityEngine(model) {
  const m = String(model || '').trim().toLowerCase();
  if (m === 'ultra') return { engine: 'ultra' };
  if (m === 'sd3' || /^sd3/.test(m)) return { engine: 'sd3', sd3Model: m === 'sd3' ? '' : m };
  return { engine: 'core' };
}

async function stabilityOnce(cfg, url, fields, signal) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    if (v instanceof Blob) fd.append(k, v, k === 'mask' ? 'mask.png' : 'image.png');
    else fd.append(k, String(v));
  }
  const res = await vendorFetch(cfg.vendor, url, { method: 'POST', headers: { Accept: 'image/*', ...authHeaders(cfg.key) }, body: fd }, signal);
  // Accept: image/* → raw bytes. Some proxies answer JSON {image:<base64>} instead.
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/json')) {
    const j = await res.json();
    const b64 = j.image || j.artifacts?.[0]?.base64;
    if (!b64) throw new Error(`Stability AI returned no image (${short(JSON.stringify(j), 200)}).`);
    return `data:${b64Mime(b64)};base64,${b64}`;
  }
  return blobToCappedDataUrl(await res.blob(), cfg.vendor);
}

async function stabilityImages(cfg, { op, prompt, images, mask, size, n, signal }) {
  const base = `${cfg.base}/v2beta/stable-image`;
  const out = [];
  for (let i = 0; i < n; i++) {
    signal?.throwIfAborted();
    if (op === 'edit') {
      const image = toBlob(images[0]);
      if (mask) {
        out.push(await stabilityOnce(cfg, `${base}/edit/inpaint`, { prompt, image, mask: toBlob(mask), output_format: 'png' }, signal));
      } else {
        // No mask → image-to-image on the sd3 generate endpoint (the v2beta image-to-image path).
        const { sd3Model } = stabilityEngine(cfg.model);
        out.push(
          await stabilityOnce(cfg, `${base}/generate/sd3`, { prompt, image, mode: 'image-to-image', strength: '0.65', model: sd3Model, output_format: 'png' }, signal)
        );
      }
    } else {
      const { engine, sd3Model } = stabilityEngine(cfg.model);
      const ar = aspectRatio(size, ['1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4', '21:9', '9:21']);
      out.push(
        await stabilityOnce(cfg, `${base}/generate/${engine}`, { prompt, aspect_ratio: ar, model: engine === 'sd3' ? sd3Model : '', output_format: 'png' }, signal)
      );
    }
  }
  return out;
}

/* ---------- fal.ai ---------- */

const FAL_CAP_MS = 180000;

function falImageList(j) {
  const urls = [];
  const take = (im) => {
    if (typeof im === 'string') urls.push(im);
    else if (im?.url) urls.push(im.url);
  };
  for (const im of j.images || []) take(im);
  if (j.image) take(j.image);
  if (Array.isArray(j.output)) for (const im of j.output) take(im);
  else if (j.output) take(j.output);
  return urls;
}

async function falResult(cfg, j, signal) {
  const status = j.status;
  if (status && status !== 'COMPLETED') {
    const statusUrl = j.status_url || (j.response_url ? trimSlash(j.response_url) + '/status' : '');
    const resultUrl = j.response_url;
    if (!statusUrl) throw new Error('fal.ai queued the request but returned no status URL.');
    const deadline = Date.now() + FAL_CAP_MS;
    let delay = 700;
    for (;;) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error('fal.ai timed out while generating the image.');
      await pause(delay, signal);
      delay = Math.min(delay * 1.5, 4000);
      const s = await (await vendorFetch(cfg.vendor, statusUrl, { headers: falHeaders(cfg.key) }, signal)).json();
      if (s.status === 'COMPLETED') {
        j = await (await vendorFetch(cfg.vendor, resultUrl || s.response_url, { headers: falHeaders(cfg.key) }, signal)).json();
        break;
      }
      if (s.status && !['IN_QUEUE', 'IN_PROGRESS'].includes(s.status)) throw new Error(`fal.ai request ${s.status}.`);
    }
  } else if (status === 'COMPLETED' && !falImageList(j).length && j.response_url) {
    j = await (await vendorFetch(cfg.vendor, j.response_url, { headers: falHeaders(cfg.key) }, signal)).json();
  }
  const urls = falImageList(j);
  if (!urls.length) throw new Error('fal.ai returned no images.');
  return collectUrls(urls, signal, cfg.vendor);
}

async function falImages(cfg, { op, prompt, images, size, n, signal }) {
  if (!cfg.model) throw new Error('No fal.ai model set — open Settings → Images and enter a model id (e.g. fal-ai/flux/dev).');
  const input = { prompt, num_images: n };
  const s = parseSize(size);
  if (s) input.image_size = { width: s.w, height: s.h };
  else if (size) input.image_size = size; // a fal preset like 'landscape_16_9'
  if (op === 'edit') input.image_url = images[0];
  const res = await vendorFetch(cfg.vendor, `${cfg.base}/${cfg.model}`, { method: 'POST', headers: falHeaders(cfg.key), body: JSON.stringify(input) }, signal);
  return falResult(cfg, await res.json(), signal);
}

/* ---------- Replicate ---------- */

const REPLICATE_CAP_MS = 180000;

async function replicateImages(cfg, { op, prompt, images, size, n, signal }) {
  if (!cfg.model) throw new Error('No Replicate model set — open Settings → Images and enter a model id (e.g. black-forest-labs/flux-dev).');
  const input = { prompt };
  const s = parseSize(size);
  if (s) {
    input.width = s.w;
    input.height = s.h;
  }
  if (n > 1) input.num_outputs = n;
  if (op === 'edit') input.image = images[0];

  const model = cfg.model.trim();
  let url;
  let body;
  if (model.includes(':')) {
    url = `${cfg.base}/v1/predictions`;
    body = { version: model.split(':').pop(), input };
  } else if (model.includes('/')) {
    url = `${cfg.base}/v1/models/${model}/predictions`;
    body = { input };
  } else {
    url = `${cfg.base}/v1/predictions`;
    body = { version: model, input };
  }

  let pred = await (
    await vendorFetch(cfg.vendor, url, { method: 'POST', headers: { ...jsonHeaders(cfg.key), Prefer: 'wait' }, body: JSON.stringify(body) }, signal)
  ).json();

  const deadline = Date.now() + REPLICATE_CAP_MS;
  let delay = 700;
  while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error('Replicate timed out while generating the image.');
    await pause(delay, signal);
    delay = Math.min(delay * 1.5, 5000);
    const getUrl = pred.urls?.get || `${cfg.base}/v1/predictions/${pred.id}`;
    pred = await (await vendorFetch(cfg.vendor, getUrl, { headers: authHeaders(cfg.key) }, signal)).json();
  }
  if (pred.status !== 'succeeded') {
    throw new Error(`Replicate ${pred.status} the image${pred.error ? `: ${short(String(pred.error))}` : ''}.`);
  }
  const out = pred.output;
  const urls = Array.isArray(out) ? out.filter((x) => typeof x === 'string') : typeof out === 'string' ? [out] : out?.url ? [out.url] : [];
  if (!urls.length) throw new Error('Replicate returned no image.');
  return collectUrls(urls, signal, cfg.vendor);
}

/* ---------- Google (Imagen :predict, Gemini :generateContent) ---------- */

const GEMINI_EDIT_FALLBACK = 'gemini-2.5-flash-image';

async function googleImages(cfg, { op, prompt, images, size, n, signal }) {
  // Default to a Gemini image model: it works with an AI Studio API key for both generate and edit.
  // An 'imagen-*' id still uses the :predict path (for users who have Imagen access).
  const model = cfg.model || 'gemini-2.5-flash-image';
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key };
  const isImagen = /^imagen/i.test(model);

  // Imagen (text-to-image only here): editing always goes through Gemini multimodal.
  if (op === 'generate' && isImagen) {
    const ar = aspectRatio(size, ['1:1', '16:9', '9:16', '4:3', '3:4']);
    const body = { instances: [{ prompt }], parameters: { sampleCount: n, ...(ar ? { aspectRatio: ar } : {}) } };
    const j = await (await vendorFetch(cfg.vendor, `${cfg.base}/v1beta/models/${model}:predict`, { method: 'POST', headers, body: JSON.stringify(body) }, signal)).json();
    const out = (j.predictions || []).map((p) => p?.bytesBase64Encoded).filter(Boolean).map((b64) => `data:${b64Mime(b64)};base64,${b64}`);
    if (!out.length) throw new Error('Google (Imagen) returned no image.');
    return out;
  }

  // Gemini image output via generateContent.
  const gmodel = isImagen ? GEMINI_EDIT_FALLBACK : model;
  const parts = [{ text: prompt }];
  for (const url of images || []) {
    const { mime, b64 } = splitDataUrl(url);
    parts.push({ inline_data: { mime_type: mime, data: b64 } });
  }
  const generationConfig = { responseModalities: ['IMAGE', 'TEXT'] };
  // Gemini 2.5 Flash Image (GA) takes the output aspect ratio in imageConfig; only meaningful when generating.
  const ar = op === 'generate' ? aspectRatio(size, ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21']) : '';
  if (ar) generationConfig.imageConfig = { aspectRatio: ar };
  const body = { contents: [{ role: 'user', parts }], generationConfig };
  const j = await (await vendorFetch(cfg.vendor, `${cfg.base}/v1beta/models/${gmodel}:generateContent`, { method: 'POST', headers, body: JSON.stringify(body) }, signal)).json();
  const out = [];
  for (const c of j.candidates || []) {
    for (const p of c.content?.parts || []) {
      const inl = p.inlineData || p.inline_data;
      if (inl?.data) out.push(`data:${inl.mimeType || inl.mime_type || b64Mime(inl.data)};base64,${inl.data}`);
    }
  }
  if (!out.length) {
    const said = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('\n');
    throw new Error('Google (Gemini) returned no image.' + (said ? ' It replied: ' + short(said, 500) : ''));
  }
  return out;
}

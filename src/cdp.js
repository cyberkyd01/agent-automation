// Chrome DevTools Protocol helpers (via chrome.debugger). Used for trusted input events
// and for running JavaScript on pages whose CSP blocks eval.
import { api } from './host/api.js';

const attached = new Set();
api.events.on('debugger.detach', (src) => attached.delete(src?.tabId));

// Firefox has no chrome.debugger, so nothing in this file can work there.
export const hasDebugger = () => api.debugger.available !== false;
export const NO_DEBUGGER = 'not available in Firefox (it needs Chrome’s debugger API)';

export async function cdp(tabId, method, params = {}) {
  if (!hasDebugger()) throw new Error(`Trusted input and debugger features are ${NO_DEBUGGER}.`);
  if (!attached.has(tabId)) {
    try {
      await api.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      throw new Error('Could not attach the debugger to this tab (close DevTools on it if open): ' + e.message);
    }
    attached.add(tabId);
  }
  return api.debugger.sendCommand({ tabId }, method, params);
}

export async function detachAll() {
  for (const tabId of [...attached]) {
    attached.delete(tabId);
    try {
      await api.debugger.detach({ tabId });
    } catch {}
  }
}

export async function cdpClick(tabId, x, y, count = 1) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= count; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
  }
}

export const cdpInsertText = (tabId, text) => cdp(tabId, 'Input.insertText', { text });

const KEYS = {
  Enter: ['Enter', 13, '\r'],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  Home: ['Home', 36],
  End: ['End', 35],
  ' ': ['Space', 32, ' '],
  Insert: ['Insert', 45],
};
for (let i = 1; i <= 12; i++) KEYS['F' + i] = ['F' + i, 111 + i];

export async function cdpKey(tabId, key, mods = {}) {
  const k = KEYS[key];
  const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
  const vk = k ? k[1] : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
  const code = k ? k[0] : /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : /^\d$/.test(key) ? 'Digit' + key : '';
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  const text = k ? k[2] : key.length === 1 && !mods.ctrl && !mods.meta && !mods.alt ? key : undefined;
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function cdpEval(tabId, code) {
  const run = (expression) => cdp(tabId, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  let r = await run(`(async () => (${code}\n))()`);
  if (r.exceptionDetails && /SyntaxError/.test(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '')) {
    r = await run(`(async () => { ${code}\n})()`);
  }
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Script error' };
  }
  const v = r.result?.value;
  return { result: v === undefined ? 'undefined' : typeof v === 'string' ? v : JSON.stringify(v, null, 2) };
}

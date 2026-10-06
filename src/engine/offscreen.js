// Chrome: the engine's offscreen document. Browser APIs go through the service worker (api in rpc mode), which
// is pinged while jobs run so it cannot idle out in the middle of one.
import { api, TO_HOST } from '../host/api.js';
import { startEngine } from './engine.js';

startEngine({
  api,
  keepAlive: () => chrome.runtime.sendMessage({ to: TO_HOST, op: 'keepalive' }).catch(() => {}),
});

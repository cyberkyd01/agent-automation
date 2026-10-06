// Firefox: the engine runs in the extension's background page, which has the browser APIs itself (api in
// direct mode). That page is also the "host": it answers the panel's ensureEngine message and opens the panel
// from the toolbar button and from notification clicks.
//
// It is an event page: Firefox suspends it after 30 s without extension API calls from it. Open runtime ports
// (a connected sidebar) and fetches (a model's answer streaming in) do not count, so it calls a cheap API every
// 20 s while a job runs (the engine's keepAlive) and while a panel is connected.
import { api, TO_HOST } from '../host/api.js';
import { PORT_NAME, startEngine } from './engine.js';

const ext = globalThis.browser ?? globalThis.chrome;
const PING_MS = 20000;
const ping = () => ext.runtime.getPlatformInfo().catch(() => {});

ext.runtime.onMessage.addListener((msg) => {
  if (msg?.to === TO_HOST && msg.op === 'ensureEngine') return Promise.resolve({ ok: true });
});

// Opening the sidebar needs the user action of the click, so it happens right in the listener.
ext.action?.onClicked.addListener(() => ext.sidebarAction?.toggle?.());

// Firefox does not count a notification click as a user action, so it refuses to open the sidebar from one.
// The panel then opens in a tab (it works the same there), or an open panel tab comes to the front.
async function showPanel() {
  try {
    await ext.sidebarAction.open();
    return;
  } catch {}
  const url = ext.runtime.getURL('sidepanel.html');
  const tab = (await ext.tabs.query({}).catch(() => [])).find((t) => t.url === url);
  if (!tab) {
    await ext.tabs.create({ url });
    return;
  }
  await ext.tabs.update(tab.id, { active: true });
  await ext.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

ext.notifications?.onClicked.addListener((id) => {
  if (typeof id !== 'string' || !id.startsWith('aa|')) return;
  showPanel().catch((e) => console.warn('Could not open the panel', e));
  ext.notifications.clear(id);
});

// Stay awake while a panel is connected; otherwise Firefox would restart the engine under it every 30 s.
const panels = new Set();
let panelTimer = 0;
ext.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  panels.add(port);
  panelTimer ||= setInterval(ping, PING_MS);
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    if (!panels.size) {
      clearInterval(panelTimer);
      panelTimer = 0;
    }
  });
});

startEngine({ api, keepAlive: ping });

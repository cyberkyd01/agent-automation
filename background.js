// The agent itself lives in the side panel (it stays alive while the panel is open,
// unlike this service worker). All we do here is open the panel from the toolbar icon.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

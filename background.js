const api = globalThis.browser || chrome;
api.browserAction.onClicked.addListener(tab => {
  try {
    const r = api.tabs.sendMessage(tab.id, { type: "toggle" });
    if (r && r.catch) r.catch(() => {});
  } catch (e) {}
});

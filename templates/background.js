/* global browser, chrome */
// __DISPLAY_NAME__ — background (event page).
// Owns settings in storage.local and answers messages from the popup and
// content scripts. Every message is { type, ...fields } and gets a reply.

const API = typeof browser !== "undefined" ? browser : chrome;

const DEFAULTS = {
  enabled: true
};

// Defaults are applied on read; storage may be empty or hold garbage.
async function loadSettings() {
  const data = await API.storage.local.get(DEFAULTS);
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULTS.enabled
  };
}

async function saveSettings(settings) {
  await API.storage.local.set(settings);
}

async function handleGetState() {
  return loadSettings();
}

async function handleSetEnabled(value) {
  const settings = await loadSettings();
  settings.enabled = Boolean(value);
  await saveSettings(settings);
  return settings;
}

API.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = async () => {
    if (!message || !message.type) {
      return { ok: false, error: "Invalid message" };
    }
    switch (message.type) {
      case "getState":
        return handleGetState();
      case "setEnabled":
        return handleSetEnabled(message.value);
      default:
        return { ok: false, error: "Unknown message" };
    }
  };
  handler()
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : "Error" }));
  return true;
});

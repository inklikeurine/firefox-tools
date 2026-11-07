/* global browser, chrome */
// __DISPLAY_NAME__ — content script.
// Runs on the pages listed in manifest.json → content_scripts.matches.
// Idempotent: a second injection (reload, SPA navigation) must not act twice.

const API = typeof browser !== "undefined" ? browser : chrome;
const MARK = "data-__NAME__";

function apply(enabled) {
  const root = document.documentElement;
  if (root.getAttribute(MARK) === (enabled ? "on" : "off")) {
    return;
  }
  root.setAttribute(MARK, enabled ? "on" : "off");
  // Do the actual work here.
}

API.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ ok: false, error: "Invalid message" });
    return false;
  }
  switch (message.type) {
    case "apply":
      apply(Boolean(message.enabled));
      sendResponse({ ok: true, enabled: Boolean(message.enabled) });
      return false;
    case "getState":
      sendResponse({ ok: true, mark: document.documentElement.getAttribute(MARK) });
      return false;
    default:
      sendResponse({ ok: false, error: "Unknown message" });
      return false;
  }
});

API.runtime
  .sendMessage({ type: "getState" })
  .then((state) => apply(Boolean(state && state.enabled)))
  .catch(() => apply(true));

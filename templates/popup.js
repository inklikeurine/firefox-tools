/* global browser, chrome */
// __DISPLAY_NAME__ — popup. Reads state from the background, writes changes back.

const API = typeof browser !== "undefined" ? browser : chrome;

const elements = {
  toggle: document.getElementById("enabledToggle"),
  status: document.getElementById("statusText")
};

function render(state) {
  const enabled = Boolean(state && state.enabled);
  elements.toggle.checked = enabled;
  elements.status.textContent = enabled ? "On" : "Off";
}

async function init() {
  const state = await API.runtime.sendMessage({ type: "getState" });
  render(state);
  elements.toggle.addEventListener("change", async () => {
    const next = await API.runtime.sendMessage({ type: "setEnabled", value: elements.toggle.checked });
    render(next);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    elements.status.textContent = err && err.message ? err.message : "Error";
  });
});

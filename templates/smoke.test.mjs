// Smoke test: the background script loads under the browser.* shim and
// answers getState with defaults. Extend with real suites as logic lands.
import { T, loadScript, makeBrowserShim } from '../../harness/lib.mjs';

const shim = makeBrowserShim({ tabs: [{ id: 1, url: 'https://example.com/', active: true }] });
loadScript(T.extFile('background.js'), { browser: shim.browser });

T.runAsync('background registers a message listener', async () => {
  T.eq(shim.listeners.message.length, 1, 'one onMessage listener');
});

T.runAsync('getState returns defaults on empty storage', async () => {
  const r = await shim.sendToBackground({ type: 'getState' });
  T.eq(r, { enabled: true }, 'defaults');
});

T.runAsync('unknown message is answered, not dropped', async () => {
  const r = await shim.sendToBackground({ type: 'nope' });
  T.eq(r.ok, false, 'ok:false');
});

await T.exit();

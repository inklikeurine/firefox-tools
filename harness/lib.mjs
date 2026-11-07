// Assertion library and `browser.*` shim for headless tests of extension
// scripts. A test file is a plain Node script:
//
//   import { T, loadScript, makeBrowserShim } from '../../harness/lib.mjs';
//   const shim = makeBrowserShim({ tabs: [{ id: 1, url: 'https://a.test/', active: true }] });
//   const ctx = loadScript(T.extFile('background.js'), { browser: shim.browser });
//   T.runAsync('getState defaults', async () => {
//     const r = await shim.sendToBackground({ type: 'getState', tabId: 1 });
//     T.eq(r.boostPercent, 100, 'default boost');
//   });
//   await T.exit();
//
// run.mjs invokes each suite as `node <suite> <extDir> <harnessDir> <testsDir>`.
// A suite exits 0 when every test passed; T.skip() counts but never fails.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const [extDir, harnessDir, testsDir] = process.argv.slice(2);

const results = [];
let pending = Promise.resolve();

function record(name, ok, msg) {
  results.push({ name, ok, msg });
  console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${name}${msg ? `: ${msg}` : ''}`);
}

export const T = {
  extDir, harnessDir, testsDir,
  extFile: (rel) => path.join(extDir, rel),
  fixture: (rel) => fs.readFileSync(path.join(testsDir, 'fixtures', rel), 'utf8'),
  fixtureJson: (rel) => JSON.parse(fs.readFileSync(path.join(testsDir, 'fixtures', rel), 'utf8')),

  run(name, fn) {
    pending = pending.then(() => {
      try { fn(); record(name, true); } catch (e) { record(name, false, e.message); }
    });
  },
  runAsync(name, fn, ms = 10000) {
    pending = pending.then(async () => {
      let timer;
      try {
        await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms); })]);
        record(name, true);
      } catch (e) { record(name, false, e.message); }
      // A test that finished must not keep the suite alive until its deadline.
      finally { clearTimeout(timer); }
    });
  },
  skip(name, why) { pending = pending.then(() => record(name, null, why)); },

  eq(actual, expected, msg = '') {
    // A DOM node serialises to "{}", so any two would compare equal: nodes
    // are compared by identity.
    const isNode = (v) => Boolean(v) && typeof v === 'object' && typeof v.nodeType === 'number';
    if (isNode(actual) || isNode(expected)) {
      const name = (v) => (isNode(v) ? `<${(v.tagName || v.nodeName || '?').toLowerCase()}${v.id ? `#${v.id}` : ''}> "${String(v.textContent || '').trim().slice(0, 40)}"` : JSON.stringify(v));
      if (actual !== expected) throw new Error(`${msg}${msg ? ': ' : ''}expected ${name(expected)}, got ${name(actual)}`);
      return;
    }
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${msg}${msg ? ': ' : ''}expected ${b}, got ${a}`);
  },
  ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); },
  notOk(v, msg = 'expected falsy') { if (v) throw new Error(msg); },
  close(actual, expected, eps = 1e-6, msg = '') { if (Math.abs(actual - expected) > eps) throw new Error(`${msg}${msg ? ': ' : ''}expected ≈${expected}, got ${actual}`); },
  throws(fn, msg = 'expected a throw') { let threw = false; try { fn(); } catch { threw = true; } if (!threw) throw new Error(msg); },
  async rejects(p, msg = 'expected a rejection') { try { await p; } catch { return; } throw new Error(msg); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

  async exit() {
    await pending;
    const failed = results.filter((r) => r.ok === false).length;
    const passed = results.filter((r) => r.ok === true).length;
    const skipped = results.filter((r) => r.ok === null).length;
    console.log(`--- ${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed ? 1 : 0);
  },
};

/**
 * Run a plain (non-module) extension script in a fresh VM context with the
 * given globals. Top-level `function` and `var` declarations become
 * properties of the returned context; `const`/`let` do not (reach state
 * through the message handlers instead, like the real extension does).
 */
export function loadScript(file, globals = {}) {
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, Promise, Math, JSON, Number, String, Boolean, Array, Object, Map, Set, WeakMap, WeakSet, Error, TypeError, RangeError, Date, RegExp, Symbol, Reflect, Proxy, structuredClone,
    ...globals,
  };
  sandbox.globalThis = sandbox;
  if (!('self' in sandbox)) sandbox.self = sandbox;
  if (!('window' in sandbox) && globals.document) sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx;
}

/**
 * An in-memory `browser.*` shim covering what small extensions use. Records
 * every call in `calls` for assertions. Message listeners registered by the
 * script are reachable through sendToBackground()/sendToContent().
 */
export function makeBrowserShim({ tabs = [], storage = {}, currentWindowId = 1 } = {}) {
  const calls = [];
  const rec = (api, args) => calls.push({ api, args });
  const listeners = { message: [], activated: [], updated: [], removed: [], headers: [], installed: [], startup: [], command: [], actionClicked: [] };
  const evt = (key) => ({
    addListener: (fn, ...rest) => { listeners[key].push({ fn, rest }); },
    removeListener: (fn) => { listeners[key] = listeners[key].filter((l) => l.fn !== fn); },
    hasListener: (fn) => listeners[key].some((l) => l.fn === fn),
  });
  const tabList = tabs.map((t) => ({ windowId: currentWindowId, active: false, title: '', ...t }));
  const contentHandlers = new Map(); // "tabId:frameId" -> fn(message, sender, sendResponse)
  const frameKey = (tabId, frameId) => `${tabId}:${frameId ?? 0}`;
  const sessionStore = {};
  const store = { ...storage };
  let lastError = null;

  const callListener = (l, message, sender) => new Promise((resolve) => {
    let settled = false;
    const sendResponse = (v) => { if (!settled) { settled = true; resolve(v); } };
    const r = l.fn(message, sender, sendResponse);
    if (r && typeof r.then === 'function') r.then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
    else if (r !== true) setTimeout(() => sendResponse(undefined), 0);
  });

  const browser = {
    runtime: {
      onMessage: evt('message'),
      onInstalled: evt('installed'),
      onStartup: evt('startup'),
      get lastError() { return lastError; },
      sendMessage: (message) => { rec('runtime.sendMessage', [message]); const l = listeners.message[0]; return l ? callListener(l, message, { id: 'self' }) : Promise.reject(new Error('no listener')); },
      getURL: (p) => `moz-extension://00000000-0000-4000-8000-000000000000/${String(p).replace(/^\//, '')}`,
      getManifest: () => ({}),
    },
    storage: {
      local: {
        get: async (keys) => {
          rec('storage.local.get', [keys]);
          if (keys == null) return { ...store };
          if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
          if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
          const out = {};
          for (const [k, def] of Object.entries(keys)) out[k] = k in store ? store[k] : def;
          return out;
        },
        set: async (obj) => { rec('storage.local.set', [obj]); Object.assign(store, structuredClone(obj)); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
        clear: async () => { for (const k of Object.keys(store)) delete store[k]; },
      },
      onChanged: evt('storageChanged'),
      session: {
        get: async (keys) => {
          rec('storage.session.get', [keys]);
          if (keys == null) return { ...sessionStore };
          if (typeof keys === 'string') return keys in sessionStore ? { [keys]: sessionStore[keys] } : {};
          if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in sessionStore).map((k) => [k, sessionStore[k]]));
          const out = {};
          for (const [k, def] of Object.entries(keys)) out[k] = k in sessionStore ? sessionStore[k] : def;
          return out;
        },
        set: async (obj) => { rec('storage.session.set', [obj]); Object.assign(sessionStore, structuredClone(obj)); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete sessionStore[k]; },
        clear: async () => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; },
      },
    },
    tabs: {
      onActivated: evt('activated'), onUpdated: evt('updated'), onRemoved: evt('removed'),
      query: async (q = {}) => {
        rec('tabs.query', [q]);
        return tabList.filter((t) => (q.active === undefined || t.active === q.active) && (!q.currentWindow || t.windowId === currentWindowId) && (q.url === undefined || [].concat(q.url).some((u) => matchPattern(u, t.url))));
      },
      get: async (id) => { rec('tabs.get', [id]); const t = tabList.find((x) => x.id === id); if (!t) throw new Error(`Invalid tab ID: ${id}`); return t; },
      sendMessage: (tabId, message, options) => {
        rec('tabs.sendMessage', options === undefined ? [tabId, message] : [tabId, message, options]);
        const frameId = options && typeof options.frameId === 'number' ? options.frameId : 0;
        const h = contentHandlers.get(frameKey(tabId, frameId));
        if (!h) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        return callListener({ fn: h }, message, { tab: tabList.find((t) => t.id === tabId), frameId });
      },
      create: async (props) => { rec('tabs.create', [props]); const t = { id: Math.max(0, ...tabList.map((x) => x.id)) + 1, windowId: currentWindowId, active: props.active !== false, url: props.url, title: '' }; tabList.push(t); return t; },
      update: async (id, props) => { rec('tabs.update', [id, props]); const t = tabList.find((x) => x.id === id); Object.assign(t, props); if (props.active) for (const o of tabList) o.active = o === t; return t; },
      remove: async (id) => { rec('tabs.remove', [id]); const i = tabList.findIndex((x) => x.id === id); if (i >= 0) tabList.splice(i, 1); },
    },
    webRequest: { onHeadersReceived: evt('headers'), onBeforeRequest: evt('beforeRequest'), onBeforeSendHeaders: evt('beforeSendHeaders') },
    browserAction: { onClicked: evt('actionClicked'), setBadgeText: async (d) => rec('browserAction.setBadgeText', [d]), setBadgeBackgroundColor: async (d) => rec('browserAction.setBadgeBackgroundColor', [d]), setTitle: async (d) => rec('browserAction.setTitle', [d]), setIcon: async (d) => rec('browserAction.setIcon', [d]) },
    commands: { onCommand: evt('command') },
  };
  browser.action = browser.browserAction;
  if (!listeners.storageChanged) listeners.storageChanged = [];
  if (!listeners.beforeRequest) listeners.beforeRequest = [];
  if (!listeners.beforeSendHeaders) listeners.beforeSendHeaders = [];

  return {
    browser, calls, listeners, tabs: tabList, store,
    /** Deliver a message to the background's onMessage listener; resolves with its response. */
    sendToBackground: (message, sender = { tab: tabList[0], id: 'popup' }) => { const l = listeners.message[0]; if (!l) throw new Error('no runtime.onMessage listener registered'); return callListener(l, message, sender); },
    /** Register a content-script handler for a tab (frame 0 unless given) so tabs.sendMessage(tabId, …, {frameId}) reaches it. */
    attachContent: (tabId, fn, frameId = 0) => contentHandlers.set(frameKey(tabId, frameId), fn),
    /** Fire storage.onChanged the way Firefox would after a storage.local.set. */
    changeStorage: (changes, area = 'local') => Promise.all(listeners.storageChanged.map((l) => l.fn(changes, area))),
    sessionStore,
    /** Fire tab events the way Firefox would. */
    activateTab: (tabId) => { for (const t of tabList) t.active = t.id === tabId; return Promise.all(listeners.activated.map((l) => l.fn({ tabId, windowId: currentWindowId }))); },
    updateTab: (tabId, changeInfo) => { const t = tabList.find((x) => x.id === tabId); if (changeInfo.url) t.url = changeInfo.url; return Promise.all(listeners.updated.map((l) => l.fn(tabId, changeInfo, t))); },
    removeTab: (tabId) => { const i = tabList.findIndex((x) => x.id === tabId); if (i >= 0) tabList.splice(i, 1); return Promise.all(listeners.removed.map((l) => l.fn(tabId, { windowId: currentWindowId, isWindowClosing: false }))); },
    /** Run every registered onHeadersReceived listener over a fake response. */
    headersReceived: (details) => listeners.headers.map((l) => l.fn(details)),
    setLastError: (e) => { lastError = e; },
    callsTo: (api) => calls.filter((c) => c.api === api),
  };
}

// Match-pattern matcher good enough for tests: scheme://host/path with * wildcards.
export function matchPattern(pattern, url) {
  if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file|data):/.test(url);
  const m = /^(\*|https?|wss?|ftp|file):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(pattern);
  if (!m) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const scheme = m[1] === '*' ? /^https?:$/.test(u.protocol) : u.protocol === `${m[1]}:`;
  if (!scheme) return false;
  const host = m[2] ?? '';
  const hostOk = host === '*' || (host.startsWith('*.') ? (u.hostname === host.slice(2) || u.hostname.endsWith(host.slice(1))) : u.hostname === host);
  if (!hostOk) return false;
  const re = new RegExp(`^${m[3].split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(u.pathname + u.search);
}

/** A tiny DOM stand-in for content-script tests: a document with media elements. */
export function makeDocumentShim({ location = 'https://page.test/watch', elements = [] } = {}) {
  const els = elements.map((e) => makeMediaElement(e));
  const document = {
    querySelectorAll: (sel) => (/audio|video/.test(sel) ? els : []),
    querySelector: (sel) => (/audio|video/.test(sel) ? els[0] ?? null : null),
    getElementById: () => null,
    documentElement: { setAttribute() {}, getAttribute: () => null, dataset: {} },
    body: { appendChild() {}, dataset: {} },
    addEventListener() {}, removeEventListener() {},
    createElement: (tag) => ({ tagName: tag.toUpperCase(), style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {}, addEventListener() {} }),
    readyState: 'complete',
  };
  const loc = new URL(location);
  return { document, location: { href: loc.href, origin: loc.origin, hostname: loc.hostname, pathname: loc.pathname }, elements: els, addElement: (e) => { const el = makeMediaElement(e); els.push(el); return el; } };
}

// `page`: the element's page-side object (what `wrappedJSObject` gives a
// Firefox content script); absent unless given, as outside Firefox.
export function makeMediaElement({ src = '', srcObject = null, readyState = 4, paused = true, ended = false, currentTime = 0, page } = {}) {
  const listeners = {};
  const el = {
    src, currentSrc: src, srcObject, readyState, paused, ended, currentTime, crossOrigin: null, loads: 0, plays: 0,
    ...(page ? { wrappedJSObject: page } : {}),
    addEventListener: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
    removeEventListener() {},
    dispatch: (ev) => { for (const fn of listeners[ev] ?? []) fn({ type: ev }); listeners[ev] = []; },
    load() { el.loads += 1; },
    play() { el.plays += 1; el.paused = false; return Promise.resolve(); },
    pause() { el.paused = true; },
  };
  return el;
}

/** A fake Web Audio graph that records what the script does to it. */
export function makeAudioContextShim() {
  const log = [];
  const param = (name) => { const p = { value: 0 }; p.setTargetAtTime = (v, t, c) => { p.value = v; log.push({ param: name, value: v }); }; return p; };
  const node = (kind) => ({ kind, connect: (to) => { log.push({ connect: kind, to: to.kind ?? 'destination' }); } });
  const instances = [];
  class AudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = { kind: 'destination' };
      this.sources = [];
      this.nodes = [];
      instances.push(this);
    }
    get [Symbol.toStringTag]() { return 'AudioContext'; }
    resume() { this.state = 'running'; log.push({ resume: true }); return Promise.resolve(); }
    close() { this.state = 'closed'; log.push({ close: true }); return Promise.resolve(); }
    createGain() { const g = node('gain'); g.gain = param('gain'); this.nodes.push(g); return g; }
    createWaveShaper() { const w = node('shaper'); w.curve = null; w.oversample = 'none'; this.nodes.push(w); return w; }
    createDynamicsCompressor() { const c = node('compressor'); for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) c[k] = param(k); this.nodes.push(c); return c; }
    createMediaElementSource(el) {
      if (el.__failAttach) throw new Error('InvalidStateError: element already connected');
      const s = node('source'); s.element = el; this.sources.push(s); log.push({ source: el.src || '[srcObject]' }); return s;
    }
  }
  return { AudioContext, log, instances };
}

/**
 * Run several plain scripts in ONE VM context, like the `js` list of a single
 * content_scripts entry (they share a global). Returns the context.
 */
export function loadScripts(files, globals = {}) {
  const ctx = loadScript(files[0], globals);
  for (const f of files.slice(1)) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
  return ctx;
}

/**
 * A jsdom window wired like a content-script world, for scripts that need a
 * real DOM (selectors, focus, events, MutationObserver). jsdom has no layout,
 * so an element's rect comes from its data-rect="left,top,width,height"
 * attribute (no attribute → zero rect → invisible). The same fixture pages
 * serve the live check, where an inline script positions [data-rect]
 * elements absolutely so real layout matches. Stubs: scrollIntoView (records
 * the last target), matchMedia (no reduced motion), scrollBy. jsdom's
 * "not implemented: navigation" errors are collected, not printed.
 *
 *   const dom = makeDom({ html, url: 'https://watch.example/browse', browser: shim.browser });
 *   dom.runScripts([T.extFile('lib/settings.js'), T.extFile('content/page.js')]);
 *   dom.key('ArrowRight');            // keydown on the active element, bubbles to window
 */
export function makeDom({ html = '<!doctype html><html><body></body></html>', url = 'https://page.test/', browser = undefined, viewport = { width: 1280, height: 900 } } = {}) {
  const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');
  const notImplemented = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (/not implemented/i.test(e?.message ?? '')) notImplemented.push(e.message); else console.error(e?.stack ?? e); });
  for (const level of ['error', 'warn', 'info', 'log', 'debug']) vc.on(level, (...a) => console[level === 'log' ? 'log' : level](...a));
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: vc });
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: viewport.width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: viewport.height, configurable: true });
  const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  win.Element.prototype.getBoundingClientRect = function () {
    const r = this.getAttribute?.('data-rect');
    if (!r) return { ...zero };
    const [left, top, width, height] = r.split(',').map(Number);
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  };
  win.Element.prototype.scrollIntoView = function () { win.__scrolledInto = this; };
  win.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.scrollBy = () => {};
  if (browser) win.browser = browser;
  const ctx = dom.getInternalVMContext();
  const runScripts = (files) => { for (const f of [].concat(files)) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }); return win; };
  const key = (k, init = {}, target = null) => {
    const e = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    (target ?? win.document.activeElement ?? win.document.body).dispatchEvent(e);
    return e;
  };
  return { dom, window: win, document: win.document, runScripts, key, notImplemented, setRect: (el, rect) => el.setAttribute('data-rect', rect.join(',')) };
}

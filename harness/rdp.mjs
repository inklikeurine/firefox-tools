// Minimal client for the Firefox Remote Debugging Protocol — the TCP protocol
// behind about:debugging and `web-ext run`. Zero dependencies.
//
// Wire format: "<byteLength>:<json>". Requests carry `to: <actor>`; replies
// carry `from: <actor>` and no `type`; unsolicited events carry `from` and a
// `type`. Only one request per actor is in flight at a time here (that is how
// the protocol is meant to be used and how web-ext does it).
//
// The length prefix counts BYTES, not characters — extension descriptions
// contain non-ASCII text, so parse with Buffers (learned 2026-09-20).

import net from 'node:net';

const EVENT_TYPES = new Set([
  'addonListChanged', 'tabListChanged', 'evaluationResult',
  'target-available-form', 'target-destroyed-form',
  'resources-available-array', 'resources-updated-array', 'resources-destroyed-array',
  'frameUpdate', 'tabNavigated', 'newSource', 'documentEvent', 'networkEvent', 'networkEventUpdate',
]);

export function connect(port, { host = '127.0.0.1', timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let buf = Buffer.alloc(0);
    const pending = new Map(); // actor -> [resolver]
    const listeners = new Set();
    let closed = false;

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const colon = buf.indexOf(0x3a);
        if (colon < 0) return;
        const len = Number(buf.subarray(0, colon).toString('latin1'));
        if (!Number.isFinite(len)) { sock.destroy(new Error('bad RDP frame')); return; }
        if (buf.length < colon + 1 + len) return;
        let msg;
        try { msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString('utf8')); }
        catch (e) { sock.destroy(new Error(`bad RDP JSON: ${e.message}`)); return; }
        buf = buf.subarray(colon + 1 + len);
        if (msg.type && EVENT_TYPES.has(msg.type)) { for (const l of listeners) l(msg); continue; }
        const q = pending.get(msg.from);
        if (q && q.length) q.shift()(msg);
        else for (const l of listeners) l(msg);
      }
    });
    sock.on('error', (e) => { if (!closed) reject(e); for (const l of listeners) l({ type: 'socket-error', error: String(e) }); });
    sock.on('close', () => { closed = true; for (const l of listeners) l({ type: 'socket-closed' }); });

    const api = {
      /** Subscribe to unsolicited events; returns an unsubscribe function. */
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      /** Send a request to an actor and await its reply. Rejects on `error` replies or timeout. */
      request(to, packet, ms = timeout) {
        return new Promise((res, rej) => {
          if (closed) return rej(new Error('RDP connection closed'));
          if (!pending.has(to)) pending.set(to, []);
          const t = setTimeout(() => rej(new Error(`RDP timeout after ${ms} ms: ${packet.type} → ${to}`)), ms);
          pending.get(to).push((m) => {
            clearTimeout(t);
            if (m.error) rej(new Error(`${packet.type} → ${to}: ${m.error}: ${m.message ?? ''}`));
            else res(m);
          });
          const body = JSON.stringify({ to, ...packet });
          sock.write(`${Buffer.byteLength(body)}:${body}`);
        });
      },
      /** Resolve with the first event matching `pred`, or reject after `ms`. */
      waitFor(pred, ms, label = 'event') {
        return new Promise((res, rej) => {
          const t = setTimeout(() => { off(); rej(new Error(`timeout after ${ms} ms waiting for ${label}`)); }, ms);
          const off = api.on((m) => { if (pred(m)) { clearTimeout(t); off(); res(m); } });
        });
      },
      close() { closed = true; sock.end(); },
    };
    // Firefox greets with a packet from "root"; that is our connect signal.
    pending.set('root', [() => resolve(api)]);
  });
}

/** Connect, retrying while Firefox is still opening the port. */
export async function connectWithRetry(port, { tries = 40, delay = 250 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await connect(port); } catch (e) { last = e; await new Promise((r) => setTimeout(r, delay)); }
  }
  throw new Error(`could not connect to Firefox debugger on port ${port}: ${last?.message}`);
}

/** Install a folder as a temporary add-on. Returns the add-on id Firefox reports. */
export async function installTemporaryAddon(rdp, addonPath) {
  const root = await rdp.request('root', { type: 'getRoot' });
  if (!root.addonsActor) throw new Error('getRoot returned no addonsActor');
  const res = await rdp.request(root.addonsActor, { type: 'installTemporaryAddon', addonPath, openDevTools: false }, 30000);
  return res.addon?.id;
}

/** The descriptor for an installed add-on (has .actor, .manifestURL, .temporarilyInstalled …). */
export async function findAddon(rdp, id) {
  const list = await rdp.request('root', { type: 'listAddons' }, 15000);
  return (list.addons ?? []).find((a) => a.id === id) ?? null;
}

/**
 * Attach to an add-on: returns a watcher that reports its frame targets
 * (background page, popup/options tabs) and its console/error resources.
 * `onTarget(form)` fires for each target; `onResource(kind, item)` per resource.
 */
export async function watchAddon(rdp, descriptor, { onTarget, onResource }) {
  const w = await rdp.request(descriptor.actor, { type: 'getWatcher', isServerTargetSwitchingEnabled: true, isPopupDebuggingEnabled: false }, 15000);
  // Targets arrive from the watcher; resources (console-message, error-message)
  // arrive from the *target* actor that produced them (server-side target
  // switching, Firefox 155). Accept both, keyed on the targets we have seen.
  const targetActors = new Set();
  const off = rdp.on((m) => {
    if (m.type === 'target-available-form' && m.from === w.actor) { targetActors.add(m.target.actor); onTarget?.(m.target); return; }
    if (m.type !== 'resources-available-array') return;
    if (m.from !== w.actor && !targetActors.has(m.from)) return;
    for (const [kind, items] of m.array) for (const it of items) onResource?.(kind, it);
  });
  await rdp.request(w.actor, { type: 'watchResources', resourceTypes: ['console-message', 'error-message'] }, 15000);
  await rdp.request(w.actor, { type: 'watchTargets', targetType: 'frame' }, 15000);
  return { actor: w.actor, traits: w.traits, stop: off };
}

/**
 * Evaluate `code` (the body of an async function; use `return`) inside an
 * extension page via its console actor. Returns the JSON-decoded value.
 * Throws with the exception message if the code throws or rejects.
 */
export async function evaluateIn(rdp, consoleActor, code, ms = 20000) {
  const reply = rdp.waitFor((m) => m.type === 'evaluationResult' && m.from === consoleActor, ms, 'evaluationResult');
  const text = `(async () => { const __v = await (async () => { ${code}\n })(); return JSON.stringify(__v === undefined ? null : __v); })()`;
  await rdp.request(consoleActor, { type: 'evaluateJSAsync', text, mapped: { await: true } }, ms);
  const r = await reply;
  if (r.exception !== null && r.exception !== undefined) {
    const msg = r.exceptionMessage || r.exception?.preview?.message || JSON.stringify(r.exception).slice(0, 300);
    throw new Error(String(msg));
  }
  if (typeof r.result === 'string') return JSON.parse(r.result);
  if (r.result && typeof r.result === 'object' && r.result.type === 'undefined') return undefined;
  return r.result; // an object grip we did not expect
}

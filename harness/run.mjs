#!/usr/bin/env node
// Test runner for one extension: headless suites and/or a live check in a
// real headless Firefox. Writes _workshop/out/<name>/result.json — the evidence
// check.mjs demands before an "Automated Test" tick.
//
//   node ../_workshop/harness/run.mjs <name> [--spec] [--tests] [--live] [options]
//
//   --spec               use _workshop/review/<name>/harness.json (default when
//                        neither --tests nor --live is given); CLI flags win
//   --tests              run _workshop/tests/<name>/*.test.mjs under node
//   --suite <n>          only the suite whose file name contains <n>
//   --live               install into headless Firefox and drive it (below)
//   --fixture <n>        serve _workshop/fixtures/<name>/<n>.html as the page
//   --url <u>            the URL the fixture is served at (default
//                        https://fixture.test/<n>.html); with no fixture, a
//                        real URL to load (network allowed)
//   --wait <ms>          settle time after the page loads (default 800)
//   --route <url>=<f>…   also serve _workshop/fixtures/<name>/<f>.html at <url>
//                        (exact match, else prefix); its origin may load
//                        assets from the fixture folder. In harness.json:
//                        "routes": { "<url>": "<f>" }. For cross-origin
//                        iframes and for pages the evals navigate to.
//   --eval <expr>…       evaluated in the BACKGROUND page; must be === true;
//                        `await` allowed; `__harness.fixtureTabId` is the tab.
//                        "sleep <s>" and "press <Key>" (a real key press) are pseudo-evals
//   --page-eval <expr>…  evaluated in the fixture page (main world)
//   --popup-eval <expr>… evaluated in the popup, opened in a tab
//   --options-eval <e>…  evaluated in the options page, opened in a tab
//   --screenshot         screenshot the fixture page (off by default)
//   --viewport <W>x<H>   the fixture page's window size (default 1280x900);
//                        in harness.json: "viewport": "2560x1314"
//   (harness.json only)  "prefs": { "<firefox pref>": value, … } for the run;
//                        HARNESS_PREFS='{…}' in the environment adds more
//   (harness.json only)  "logins": [{ "origin": "https://fixture.test",
//                        "username": "…", "password": "…" }] — saved logins put
//                        in the throwaway profile before the page loads, so
//                        Firefox's own password filling runs (made-up values only)
//   --headed             show the browser (needs DISPLAY)
//   --timeout <ms>       per-step timeout (default 20000)
//
// What --live does, and all it does, is written up in AGENTS.md → Live check
// and _workshop/notes/harness.md. It never touches the user's Firefox profile.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  GROUP_ROOT, WORKSHOP, ID_SUFFIX, readManifest, treeSha256, extensionPages, exists, findFolder,
} from '../tools/lib/extension.mjs';
import { connectWithRetry, installTemporaryAddon, findAddon, watchAddon, evaluateIn } from './rdp.mjs';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { evals: [], pageEvals: [], popupEvals: [], optionsEvals: [], routes: {}, prefs: {}, logins: [] };
let name = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
  switch (a) {
    case '--spec': opts.spec = true; break;
    case '--tests': opts.tests = true; break;
    case '--live': opts.live = true; break;
    case '--suite': opts.suite = next(); break;
    case '--fixture': opts.fixture = next(); break;
    case '--url': opts.url = next(); break;
    case '--wait': opts.wait = Number(next()); break;
    case '--route': { const v = next(); const eq = v.lastIndexOf('='); if (eq <= 0) usage('--route needs <url>=<fixture>'); opts.routes[v.slice(0, eq)] = v.slice(eq + 1); break; }
    case '--eval': opts.evals.push(next()); break;
    case '--page-eval': opts.pageEvals.push(next()); break;
    case '--popup-eval': opts.popupEvals.push(next()); break;
    case '--options-eval': opts.optionsEvals.push(next()); break;
    case '--screenshot': opts.screenshot = true; break;
    case '--viewport': opts.viewport = next(); break;
    case '--headed': opts.headed = true; break;
    case '--timeout': opts.timeout = Number(next()); break;
    default:
      if (a.startsWith('--')) usage(`unknown option ${a}`);
      if (name) usage('only one extension name');
      name = a;
  }
}
function usage(msg) {
  console.error(`run.mjs: ${msg}\nusage: node ../_workshop/harness/run.mjs <name> [--spec] [--tests] [--live] [--fixture n] [--url u] [--eval expr]... [--popup-eval expr]... [--screenshot] [--viewport WxH] [--headed]`);
  process.exit(2);
}
if (!name) usage('extension name required');
const found = findFolder(name);   // ~/src/firefox/<name>/, or _workshop/<name>/ for a dev tool
if (!found || found.kind !== 'extension') usage(`no extension repo named ${name} (looked in ${GROUP_ROOT} and ${WORKSHOP})`);
const extDir = found.dir;
const parsed = readManifest(extDir);
if (!parsed.ok) { console.error(`run.mjs: ${parsed.error}`); process.exit(1); }
const manifest = parsed.manifest;
const extId = manifest.browser_specific_settings?.gecko?.id ?? `${name}${ID_SUFFIX}`;

if (!opts.tests && !opts.live) opts.spec = true;
let specRel = null;
if (opts.spec) {
  const sp = path.join(WORKSHOP, 'review', name, 'harness.json');
  specRel = path.relative(GROUP_ROOT, sp);
  if (!exists(sp)) usage(`--spec: ${specRel} does not exist`);
  const spec = JSON.parse(fs.readFileSync(sp, 'utf8'));
  if (opts.tests === undefined && opts.live === undefined) { opts.tests = spec.tests !== false; opts.live = spec.live !== false; }
  for (const k of ['fixture', 'url', 'wait', 'timeout', 'screenshot', 'viewport']) if (opts[k] === undefined && spec[k] != null) opts[k] = spec[k];
  for (const k of ['evals', 'pageEvals', 'popupEvals', 'optionsEvals']) if (opts[k].length === 0 && Array.isArray(spec[k])) opts[k] = spec[k];
  if (Object.keys(opts.routes).length === 0 && spec.routes && typeof spec.routes === 'object') opts.routes = { ...spec.routes };
  if (spec.prefs && typeof spec.prefs === 'object') opts.prefs = { ...spec.prefs };
  if (Array.isArray(spec.logins)) opts.logins = spec.logins.map((l) => ({ origin: String(l.origin), username: String(l.username), password: String(l.password) }));
}
opts.wait ??= 800;
opts.timeout ??= 20000;
opts.screenshot ??= false;
opts.viewport ??= '1280x900';
const viewportMatch = /^(\d{2,5})x(\d{2,5})$/.exec(String(opts.viewport));
if (!viewportMatch) usage('--viewport needs <W>x<H>, e.g. 2560x1314');
const viewport = { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) };

const outDir = path.join(WORKSHOP, 'out', name);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
const result = {
  extension: name, version: manifest.version, extId, treeSha256: treeSha256(extDir), spec: specRel,
  date: new Date().toISOString(), pass: false,
  tests: { ran: false, pass: null, suites: [] },
  live: { ran: false, pass: null },
};

if (opts.tests) {
  const testsDir = path.join(WORKSHOP, 'tests', name);
  const harnessDir = path.join(WORKSHOP, 'harness');
  const files = exists(testsDir) ? fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs') && (!opts.suite || f.includes(opts.suite))).sort() : [];
  const log = [];
  result.tests.ran = true;
  if (!files.length) { log.push(`no suites in ${path.relative(GROUP_ROOT, testsDir)}`); result.tests.pass = false; result.tests.error = 'no suites'; }
  for (const f of files) {
    const t0 = Date.now();
    const res = spawnSync(process.execPath, [path.join(testsDir, f), extDir, harnessDir, testsDir], { encoding: 'utf8', timeout: 60000 });
    const ms = Date.now() - t0;
    const pass = res.status === 0;
    result.tests.suites.push({ file: f, pass, ms });
    log.push(`=== ${f} (${ms} ms) ${pass ? 'PASS' : `FAIL exit ${res.status}`}`, res.stdout.trimEnd(), res.stderr.trimEnd());
  }
  if (result.tests.pass === null) result.tests.pass = result.tests.suites.every((s) => s.pass);
  fs.writeFileSync(path.join(outDir, 'tests.log'), log.filter(Boolean).join('\n') + '\n');
  for (const s of result.tests.suites) console.log(`tests: ${s.pass ? 'PASS' : 'FAIL'} ${s.file} (${s.ms} ms)`);
  if (result.tests.error) console.log(`tests: ${result.tests.error}`);
}

// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------
if (opts.live) await live();

result.pass = (!opts.tests || result.tests.pass === true) && (!opts.live || result.live.pass === true);
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`artifacts: ${path.relative(GROUP_ROOT, outDir)}/`);
console.log(result.pass ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(result.pass ? 0 : 1);

async function live() {
  const L = result.live;
  L.ran = true;
  L.errors = []; L.warnings = []; L.evals = []; L.pageEvals = []; L.popup = null; L.options = null;
  const lines = [];
  const log = (s) => { lines.push(`${stamp()} ${s}`); };
  const fail = (s) => { L.errors.push(s); log(`ERROR ${s}`); };

  let playwright;
  try { playwright = createRequire(path.join(WORKSHOP, 'package.json'))('playwright'); }
  catch { fail('playwright is not installed; run `npm install` in _workshop/'); return finish(); }
  const { firefox } = playwright;

  // fixture
  let fixtureHtml = null;
  let url = opts.url ?? null;
  const fixtureDir = path.join(WORKSHOP, 'fixtures', name);
  if (opts.fixture) {
    const fp = path.join(fixtureDir, opts.fixture.endsWith('.html') ? opts.fixture : `${opts.fixture}.html`);
    if (!exists(fp)) { fail(`fixture not found: ${path.relative(GROUP_ROOT, fp)}`); return finish(); }
    fixtureHtml = fs.readFileSync(fp, 'utf8');
    url ??= `https://fixture.test/${path.basename(fp)}`;
  }
  if (!url) { fail('no --fixture or --url; the live check needs a page to open'); return finish(); }
  L.fixture = opts.fixture ?? null; L.url = url;
  const routes = Object.entries(opts.routes).map(([k, f]) => [k, path.join(fixtureDir, f.endsWith('.html') ? f : `${f}.html`)]);
  for (const [k, f] of routes) if (!exists(f)) { fail(`route ${k}: fixture not found: ${path.relative(GROUP_ROOT, f)}`); return finish(); }
  const routeOrigins = new Set(routes.map(([k]) => { try { return new URL(k).origin; } catch { return null; } }).filter(Boolean));
  L.routes = routes.map(([k]) => k);

  const UUID = '7a1d2c3e-0000-4000-8000-00000000f00d';
  const port = await freePort();
  const pages = extensionPages(manifest);
  const hasBackground = Boolean(manifest.background);
  const downloadDir = path.join(outDir, 'downloads');
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  let browser = null; let rdp = null;
  try {
    browser = await firefox.launch({
      headless: !opts.headed,
      args: ['-start-debugger-server', String(port)],
      firefoxUserPrefs: {
        'devtools.debugger.remote-enabled': true,
        'devtools.debugger.prompt-connection': false,
        'devtools.chrome.enabled': true,
        'xpinstall.signatures.required': false,
        'extensions.webextensions.uuids': JSON.stringify({ [extId]: UUID }),
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        // The profile is thrown away but the downloads folder is not: without
        // these, an extension's downloads land in the owner's real ~/Downloads.
        'browser.download.folderList': 2,
        'browser.download.dir': downloadDir,
        'browser.download.useDownloadDir': true,
        'browser.download.alwaysOpenPanel': false,
        // Saved logins ("logins") only fill when Firefox's password manager is on.
        ...(opts.logins.length ? { 'signon.rememberSignons': true, 'signon.autofillForms': true } : {}),
        // Firefox prefs from harness.json ("prefs"), then from HARNESS_PREFS
        // (JSON) for a one-off run. Playwright's Firefox turns site isolation
        // and the back-forward cache off; real Firefox has both on.
        ...opts.prefs,
        ...(() => { try { return JSON.parse(process.env.HARNESS_PREFS || '{}'); } catch { return {}; } })(),
      },
    });
    log(`firefox launched (debugger port ${port})`);
    rdp = await connectWithRetry(port);
    log('rdp connected');

    // Saved logins ("logins" in harness.json): added through the parent
    // process's chrome console (devtools.chrome.enabled), so the throwaway
    // profile holds them and Firefox's own password filling runs.
    if (opts.logins.length) {
      try {
        const proc = await rdp.request('root', { type: 'getProcess', id: 0 });
        const t = await rdp.request(proc.processDescriptor.actor, { type: 'getTarget' }, 20000);
        const n = await evaluateIn(rdp, (t.process || t).consoleActor, `
          for (const l of ${JSON.stringify(opts.logins)}) {
            const li = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
            li.init(l.origin, l.origin, null, l.username, l.password, "", "");
            await Services.logins.addLoginAsync(li);
          }
          return (await Services.logins.getAllLogins()).length;`);
        log(`saved logins added: ${n}`);
      } catch (e) { fail(`saved logins could not be added: ${e.message}`); return finish(); }
    }

    // install
    let installedId;
    try { installedId = await installTemporaryAddon(rdp, extDir); }
    catch (e) { fail(`install failed: ${e.message}`); return finish(); }
    L.installed = installedId === extId;
    if (!L.installed) fail(`installed id ${installedId} != manifest id ${extId}`);
    log(`installed ${installedId}`);

    // attach: targets + resources
    const targets = [];
    const targetSeen = new Set();
    const desc = await findAddon(rdp, extId);
    if (!desc) { fail('add-on not listed after install'); return finish(); }
    L.manifestURL = desc.manifestURL;
    const watcher = await watchAddon(rdp, desc, {
      onTarget: (t) => { if (targetSeen.has(t.actor)) return; targetSeen.add(t.actor); targets.push(t); log(`target ${t.targetType} ${t.url}`); },
      onResource: (kind, it) => {
        if (kind === 'error-message') {
          const pe = it.pageError ?? {};
          const src = `${pe.sourceName ?? '?'}:${pe.lineNumber ?? '?'}`;
          const line = `${pe.errorMessage ?? JSON.stringify(it).slice(0, 200)} (${src})`;
          if (pe.warning || pe.info) { L.warnings.push(line); log(`warning-resource ${line}`); }
          else fail(`extension error: ${line}`);
        } else if (kind === 'console-message') {
          const args = (it.arguments ?? []).map((a) => (typeof a === 'object' ? JSON.stringify(a).slice(0, 200) : String(a))).join(' ');
          log(`console.${it.level} ${args}`);
          if (it.level === 'error') fail(`extension console.error: ${args}`);
        }
      },
    });
    log(`watching (traits: frame=${watcher.traits?.frame})`);

    const isBackgroundUrl = (u) => u.startsWith('moz-extension://') && (/_generated_background_page\.html$/.test(u) || (pages.background && u.endsWith(`/${pages.background}`)));
    let bg = null;
    if (hasBackground) {
      const t0 = Date.now();
      while (!bg && Date.now() - t0 < opts.timeout) { bg = targets.find((t) => isBackgroundUrl(t.url)) ?? null; if (!bg) await sleep(100); }
      L.backgroundUp = Boolean(bg);
      if (!bg) fail(`background page did not appear within ${opts.timeout} ms (targets: ${targets.map((t) => t.url).join(', ') || 'none'})`);
      else log(`background up: ${bg.url}`);
    } else {
      L.backgroundUp = null;
      log('manifest has no background; background evals, popup and options checks are skipped');
    }

    // page
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    context.setDefaultTimeout(opts.timeout);
    context.setDefaultNavigationTimeout(opts.timeout);
    if (fixtureHtml) {
      const base = new URL(url);
      await context.route('**/*', (route) => {
        const req = route.request();
        const u = new URL(req.url());
        if (req.url() === url) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml });
        // A routed page is served to a page load, and to the page's own fetch
        // of it (Leanback reads Dropout 24/7's stream page that way).
        const asPage = ['document', 'fetch', 'xhr'].includes(req.resourceType());
        const r = asPage ? (routes.find(([k]) => req.url() === k) ?? routes.find(([k]) => req.url().startsWith(k))) : null;
        if (r) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(r[1], 'utf8') });
        if (u.origin === base.origin || routeOrigins.has(u.origin)) {
          const asset = path.join(fixtureDir, path.basename(u.pathname));
          if (u.pathname.endsWith('/tone.wav')) return route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() });
          if (exists(asset) && path.basename(u.pathname) !== path.basename(url)) return route.fulfill({ status: 200, contentType: contentTypeOf(asset), body: fs.readFileSync(asset) });
        }
        return route.abort();
      });
    }
    const page = await context.newPage();
    page.on('console', (m) => log(`[page] console.${m.type()}: ${m.text().slice(0, 300)}`));
    page.on('pageerror', (e) => {
      const text = String(e?.stack || e);
      const ours = text.includes('moz-extension://');
      log(`[page] pageerror${ours ? ' (extension)' : ''}: ${text.split('\n')[0]}`);
      if (ours) fail(`content script error on the page: ${text.split('\n')[0]}`);
    });
    try { await page.goto(url, { waitUntil: 'load' }); log(`page loaded ${url}`); }
    catch (e) { fail(`page.goto failed: ${e.message.split('\n')[0]}`); }
    await sleep(opts.wait);
    L.pageLoaded = page.url() === url || page.url().startsWith(url);

    // background evals
    if (bg) {
      const fxTab = await evaluateIn(rdp, bg.consoleActor, `const tabs = await browser.tabs.query({}); const t = tabs.find(x => x.url === ${JSON.stringify(url)}) ?? tabs.find(x => x.active); globalThis.__harness = { fixtureTabId: t ? t.id : null, fixtureUrl: ${JSON.stringify(url)}, name: ${JSON.stringify(name)} }; return globalThis.__harness;`).catch((e) => { fail(`harness setup eval failed: ${e.message}`); return null; });
      if (fxTab) log(`fixture tab id ${fxTab.fixtureTabId}`);
      for (const expr of opts.evals) {
        const s = /^sleep\s+(\d+(\.\d+)?)$/.exec(expr.trim());
        if (s) { await sleep(Number(s[1]) * 1000); log(`sleep ${s[1]}s`); continue; }
        // A real key press, sent by Firefox to whatever has the keyboard focus
        // (the page, the player's frame, or nothing) — unlike page:action.
        const k = /^press\s+(\S+)$/.exec(expr.trim());
        if (k) {
          try { await page.keyboard.press(k[1]); log(`press ${k[1]}`); }
          catch (e) { fail(`press ${k[1]} failed: ${e.message.split('\n')[0]}`); }
          continue;
        }
        let value, ok;
        try { value = await evaluateIn(rdp, bg.consoleActor, `return (${expr});`, opts.timeout); ok = value === true; }
        catch (e) { value = `threw: ${e.message.split('\n')[0]}`; ok = false; }
        L.evals.push({ expr, ok, value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
        log(`eval ${ok ? 'PASS' : 'FAIL'}: ${expr} => ${L.evals.at(-1).value}`);
        if (!ok) fail(`eval not true: ${expr}`);
      }
    } else if (opts.evals.length) {
      fail(`${opts.evals.length} background eval(s) given but no background page to run them in`);
    }

    // page evals (main world of the fixture)
    for (const expr of opts.pageEvals) {
      let value, ok;
      try { value = await page.evaluate(`(async () => (${expr}))()`); ok = value === true; }
      catch (e) { value = `threw: ${e.message.split('\n')[0]}`; ok = false; }
      L.pageEvals.push({ expr, ok, value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
      log(`page-eval ${ok ? 'PASS' : 'FAIL'}: ${expr} => ${L.pageEvals.at(-1).value}`);
      if (!ok) fail(`page eval not true: ${expr}`);
    }

    // popup / options pages, opened as tabs from the background
    for (const [kind, file, evals] of [['popup', pages.popup, opts.popupEvals], ['options', pages.options, opts.optionsEvals]]) {
      if (!file) { if (evals.length) fail(`${kind} evals given but the manifest has no ${kind} page`); continue; }
      if (!bg) { L[kind] = { opened: false, skipped: 'no background page to open it from' }; continue; }
      const rec = { file, opened: false, evals: [] };
      L[kind] = rec;
      try {
        const ready = rdp.waitFor((m) => m.type === 'target-available-form' && m.target?.url?.endsWith(`/${file}`), opts.timeout, `${kind} target`);
        await evaluateIn(rdp, bg.consoleActor, `await browser.tabs.create({ url: browser.runtime.getURL(${JSON.stringify(file)}), active: false }); return true;`);
        const t = (await ready).target;
        await sleep(opts.wait);
        rec.opened = true;
        log(`${kind} opened: ${t.url}`);
        const generic = ['document.readyState === "complete"', 'document.body !== null && document.body.children.length > 0'];
        for (const expr of [...generic, ...evals]) {
          let value, ok;
          try { value = await evaluateIn(rdp, t.consoleActor, `return (${expr});`, opts.timeout); ok = value === true; }
          catch (e) { value = `threw: ${e.message.split('\n')[0]}`; ok = false; }
          rec.evals.push({ expr, ok, value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
          log(`${kind}-eval ${ok ? 'PASS' : 'FAIL'}: ${expr} => ${rec.evals.at(-1).value}`);
          if (!ok) fail(`${kind} eval not true: ${expr}`);
        }
      } catch (e) { fail(`${kind} page: ${e.message.split('\n')[0]}`); }
    }

    await sleep(300); // let late errors arrive
    if (opts.screenshot) {
      await page.screenshot({ path: path.join(outDir, 'page.png') }).then(() => log('screenshot page.png')).catch((e) => log(`screenshot failed: ${e.message.split('\n')[0]}`));
    }
    watcher.stop();
  } catch (e) {
    fail(`live check crashed: ${e.stack?.split('\n').slice(0, 2).join(' | ') ?? e}`);
  } finally {
    try { rdp?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
  return finish();

  function finish() {
    L.pass = L.errors.length === 0 && L.installed === true && (L.backgroundUp !== false);
    fs.writeFileSync(path.join(outDir, 'live.log'), lines.join('\n') + '\n');
    for (const l of lines) console.log(l);
    console.log('---');
    console.log(`${name} v${manifest.version} (${extId})`);
    console.log(`target: ${opts.fixture ? `fixture ${opts.fixture} as ` : ''}${url ?? '(none)'}`);
    for (const e of L.errors) console.log(`error: ${e}`);
    for (const w of L.warnings) console.log(`warning: ${w}`);
    console.log(`live: ${L.pass ? 'PASS' : 'FAIL'} — installed=${L.installed} background=${L.backgroundUp} evals=${L.evals.filter((x) => x.ok).length}/${L.evals.length} popup=${L.popup?.opened ?? 'n/a'} options=${L.options?.opened ?? 'n/a'}`);
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

function contentTypeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain' }[ext] ?? 'application/octet-stream';
}

// 0.5 s of silence, 8 kHz mono 8-bit PCM — a real media source with no file on disk.
function silentWav() {
  const samples = 4000;
  const header = Buffer.alloc(44);
  const data = Buffer.alloc(samples, 128);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write('data', 36); header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, data]);
}

// Shared constants and helpers for the Firefox extension workshop.
// Zero dependencies. Imported by tools/check.mjs, tools/new-extension.mjs,
// tools/on-edit.mjs and harness/run.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Layout (AGENTS.md → "Layout"): the workshop is ~/src/firefox/_workshop/ and
// every extension is its own git repo beside it, ~/src/firefox/<name>/, whose
// root is the extension folder plus the repo files. Development-only
// extensions (dev tools) are private repos nested inside the workshop,
// ~/src/firefox/_workshop/<name>/, ignored by the workshop's own git.
// _workshop/tools/lib/extension.mjs → the workshop is two levels up.
export const WORKSHOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GROUP_ROOT = path.resolve(WORKSHOP, '..');

export const OWNER = 'inklikeurine';
export const REPO_PREFIX = 'firefox-';        // extension <name> lives in github.com/<OWNER>/firefox-<name>
export const repoName = (name) => `${REPO_PREFIX}${name}`;
export const repoUrl = (name) => `https://github.com/${OWNER}/${repoName(name)}`;
export const sourceUrl = repoUrl;            // the README "Source" link
export const issuesUrl = (name) => `${repoUrl(name)}/issues`;

export const ID_SUFFIX = '@inklikeurine.dev';
export const MIN_FIREFOX = '140.0';
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const GECKO_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*@inklikeurine\.dev$/;

// Folders in the group root that are never extension repos.
export const NOT_EXTENSIONS = new Set(['_workshop', 'node_modules']);

// Repo-level entries at an extension repo's root. Like DOC_ENTRIES they are
// never shipped and never part of the tree hash; unlike them they are
// required (AGENTS.md → "Required repo files").
export const REPO_ENTRIES = new Set(['AGENTS.md', 'CLAUDE.md', 'UNLICENSE', '.gitignore', '.claude', '.github', '.git']);

// Files/folders inside an extension folder that are documentation, not
// shipped code. Changing only these never bumps `version`, and they are
// excluded from the tree hash the harness records.
export const DOC_ENTRIES = new Set(['README.md', 'CHANGELOG.md', 'docs']);
export const IGNORED_ENTRIES = new Set(['web-ext-artifacts', '.DS_Store', 'Thumbs.db']);

export const exists = (p) => fs.existsSync(p);
export const isDir = (p) => exists(p) && fs.statSync(p).isDirectory();
export const read = (p) => fs.readFileSync(p, 'utf8');
export const rel = (p) => path.relative(GROUP_ROOT, p) || '.';

const folder = (dir, kind, devTool) => ({ name: path.basename(dir), dir, kind, devTool, label: rel(dir) });

/** Every extension repo (or spec folder) beside the workshop, plus the dev-tool
 *  extensions inside it, sorted by name. */
export function discoverFolders() {
  const out = [];
  for (const ent of fs.readdirSync(GROUP_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory() || NOT_EXTENSIONS.has(ent.name) || ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const dir = path.join(GROUP_ROOT, ent.name);
    out.push(folder(dir, exists(path.join(dir, 'manifest.json')) ? 'extension' : 'spec', false));
  }
  for (const ent of fs.readdirSync(WORKSHOP, { withFileTypes: true })) {
    const dir = path.join(WORKSHOP, ent.name);
    if (ent.isDirectory() && exists(path.join(dir, '.git')) && exists(path.join(dir, 'manifest.json'))) out.push(folder(dir, 'extension', true));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One folder by name, or undefined. */
export const findFolder = (name) => discoverFolders().find((f) => f.name === name);

/** The line an extension repo's AGENTS.md uses to import the workshop rules. */
export const agentsImport = (f) => (f.devTool ? '@../AGENTS.md' : '@../_workshop/AGENTS.md');

export function readManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!exists(p)) return { ok: false, error: 'manifest.json is missing' };
  try {
    return { ok: true, manifest: JSON.parse(read(p)) };
  } catch (e) {
    return { ok: false, error: `manifest.json is not valid JSON: ${e.message}` };
  }
}

/** Relative paths of every shipped file (docs and build output excluded), sorted. */
export function shippedFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (IGNORED_ENTRIES.has(ent.name)) continue;
      if (prefix === '' && (DOC_ENTRIES.has(ent.name) || REPO_ENTRIES.has(ent.name))) continue;
      const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), relPath);
      else out.push(relPath);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** sha256 over (path, content) of every shipped file — the identity of what gets installed. */
export function treeSha256(dir) {
  const h = createHash('sha256');
  for (const f of shippedFiles(dir)) {
    h.update(f).update('\0').update(fs.readFileSync(path.join(dir, f))).update('\0');
  }
  return h.digest('hex');
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Every file path a manifest references, with the key it came from. */
export function manifestReferences(m) {
  const refs = [];
  const add = (key, v) => { if (typeof v === 'string' && v && !/^https?:/.test(v)) refs.push({ key, file: v.replace(/^\//, '').split(/[?#]/)[0] }); };
  for (const [size, file] of Object.entries(m.icons ?? {})) add(`icons.${size}`, file);
  const bg = m.background ?? {};
  for (const s of bg.scripts ?? []) add('background.scripts', s);
  add('background.page', bg.page);
  add('background.service_worker', bg.service_worker);
  (m.content_scripts ?? []).forEach((cs, i) => {
    for (const s of cs.js ?? []) add(`content_scripts[${i}].js`, s);
    for (const s of cs.css ?? []) add(`content_scripts[${i}].css`, s);
  });
  for (const actionKey of ['browser_action', 'action', 'page_action', 'sidebar_action']) {
    const a = m[actionKey];
    if (!a) continue;
    add(`${actionKey}.default_popup`, a.default_popup);
    add(`${actionKey}.default_panel`, a.default_panel);
    if (typeof a.default_icon === 'string') add(`${actionKey}.default_icon`, a.default_icon);
    else for (const [size, file] of Object.entries(a.default_icon ?? {})) add(`${actionKey}.default_icon.${size}`, file);
  }
  add('options_ui.page', m.options_ui?.page);
  add('options_page', m.options_page);
  add('devtools_page', m.devtools_page);
  for (const w of m.web_accessible_resources ?? []) {
    if (typeof w === 'string') { if (!/[*]/.test(w)) add('web_accessible_resources', w); }
    else for (const r of w.resources ?? []) if (!/[*]/.test(r)) add('web_accessible_resources', r);
  }
  return refs;
}

/** Permission strings the README must explain. */
export function declaredPermissions(m) {
  const set = new Set();
  for (const k of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
    for (const p of m[k] ?? []) set.add(p);
  }
  return [...set];
}

/** HTML pages the extension ships (popup/options/background page), deduplicated. */
export function extensionPages(m) {
  const pages = {};
  const popup = (m.browser_action ?? m.action)?.default_popup;
  if (popup) pages.popup = popup;
  const options = m.options_ui?.page ?? m.options_page;
  if (options) pages.options = options;
  if (m.background?.page) pages.background = m.background.page;
  return pages;
}

/** The `<script src>` and `<link href>` targets inside an HTML file. */
export function htmlReferences(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) out.push({ kind: 'script', file: m[1] });
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) out.push({ kind: 'link', file: m[1] });
  return out.filter((r) => !/^(https?:|data:|moz-extension:)/.test(r.file));
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

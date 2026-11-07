#!/usr/bin/env node
// Validator for every mechanical rule in an extension's AGENTS.md.
//
//   node ../firefox-tools/tools/check.mjs [--no-lint] [--quiet] [<name>…]
//
// Checks every extension repo beside firefox-tools (~/src/firefox/<name>/)
// and, when the maintainer's private workshop is present, every dev-tool
// extension inside it (~/src/firefox/_workshop/<name>/).
//
// Prints one line per finding, "path: rule: message", and exits 1 if any
// finding is an error. Warnings never fail the run.
//   --no-lint     skip `web-ext lint` (slow-ish); never use before declaring done
//   --quiet       print errors only
//   <name>        check only these extensions

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  GROUP_ROOT, TOOLS, ID_SUFFIX, MIN_FIREFOX, NAME_RE, VERSION_RE, GECKO_ID_RE, REPO_ENTRIES,
  NOT_EXTENSIONS, exists, isDir, read, discoverFolders, readManifest, manifestReferences, declaredPermissions,
  extensionPages, htmlReferences, compareVersions, sourceUrl, isShippedPath, testsDirOf,
} from './lib/extension.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const only = new Set(argv.filter((a) => !a.startsWith('--')));
// --no-journal is accepted and ignored: the journal is retired (the pull
// request carries the verification report now).
const LINT = !flags.has('--no-lint');
const QUIET = flags.has('--quiet');

const findings = [];
const error = (file, rule, msg) => findings.push({ level: 'error', file, rule, msg });
const warn = (file, rule, msg) => findings.push({ level: 'warning', file, rule, msg });

const UNLICENSE_TEXT = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org/>
`;

const README_SECTIONS = [
  ['What it does', /^##\s+what it does\s*$/im],
  ['Installation', /^##\s+install(ation)?\s*$/im],
  ['Usage', /^##\s+usage\s*$/im],
  ['Permissions', /^##\s+permissions\s*$/im],
  ['Known limitations', /^##\s+known limitations\s*$/im],
  ['AI-generated', /^##\s+ai-generated\s*$/im],
  ['License', /^##\s+licen[sc]e\s*$/im],
];

// ---------------------------------------------------------------------------
// The group folder and each extension's repo files
// ---------------------------------------------------------------------------

function checkGroup() {
  for (const ent of fs.readdirSync(GROUP_ROOT, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || NOT_EXTENSIONS.has(ent.name)) continue;
    if (!ent.isDirectory()) warn(ent.name, 'layout', `stray file in ${GROUP_ROOT}; only extension repos, firefox-tools/ and _workshop/ belong here`);
  }
}

function checkRepoFiles(f) {
  const at = (...p) => path.join(f.dir, ...p);
  const r = (x) => `${f.label}/${x}`;
  for (const x of ['AGENTS.md', 'README.md', 'UNLICENSE', 'CLAUDE.md', '.gitignore']) {
    if (!exists(at(x))) error(r(x), 'repo-files', 'required file is missing');
  }
  if (!isDir(at('.git'))) error(f.label, 'repo-files', 'not a git repository; every extension is its own repo');
  if (exists(at('AGENTS.md'))) {
    const agents = read(at('AGENTS.md'));
    if (/__(NAME|DISPLAY_NAME|DESCRIPTION|ID)__/.test(agents)) error(r('AGENTS.md'), 'placeholder', 'template placeholder (__X__) left in file');
    if (!f.devTool && /^@\.\.\/_workshop\/AGENTS\.md\s*$/m.test(agents)) warn(r('AGENTS.md'), 'repo-files', 'old-style AGENTS.md that imports the private workshop; replace it with firefox-tools/templates/repo/AGENTS.md');
  }
  if (exists(at('CLAUDE.md')) && read(at('CLAUDE.md')).trim() !== '@AGENTS.md') error(r('CLAUDE.md'), 'claude-md', 'must contain exactly "@AGENTS.md"');
  if (exists(at('UNLICENSE'))) {
    const norm = (x) => x.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
    if (norm(read(at('UNLICENSE'))) !== norm(UNLICENSE_TEXT)) error(r('UNLICENSE'), 'unlicense-verbatim', 'text differs from the canonical Unlicense');
  }
  if (exists(at('LICENSE'))) error(r('LICENSE'), 'unlicense-name', 'the license file is named UNLICENSE; remove LICENSE');
  if (exists(at('.gitignore'))) {
    const g = read(at('.gitignore'));
    for (const want of ['web-ext-artifacts/', '*.xpi', '*.zip', 'node_modules/']) {
      if (!g.split('\n').some((l) => l.trim() === want)) error(r('.gitignore'), 'gitignore', `must contain the line "${want}"`);
    }
  }
  if (!exists(at('.claude', 'settings.json'))) error(r('.claude/settings.json'), 'repo-files', 'hook + permissions file is required and committed (copy firefox-tools/templates/repo/claude-settings.json)');
  else {
    try {
      const st = JSON.parse(read(at('.claude', 'settings.json')));
      if (!JSON.stringify(st.hooks ?? {}).includes('on-edit.mjs')) error(r('.claude/settings.json'), 'hook', 'PostToolUse hook must run firefox-tools/tools/on-edit.mjs');
    } catch (e) { error(r('.claude/settings.json'), 'hook', `not valid JSON: ${e.message}`); }
  }
  // CI: the full checks workflow (checks.yml), or the older lint-only one.
  const ci = ['checks.yml', 'lint.yml'].map((w) => at('.github', 'workflows', w)).find(exists);
  if (!ci) error(r('.github/workflows/'), 'ci', 'a checks workflow is required (copy firefox-tools/templates/repo/lint.yml)');
  else if (!/web-ext lint|check\.mjs/.test(read(ci))) error(r(`.github/workflows/${path.basename(ci)}`), 'ci', 'workflow must run web-ext lint or check.mjs');
  for (const x of ['package.json', 'package-lock.json', '.eslintrc', '.eslintrc.json', 'eslint.config.js', '.prettierrc', 'tsconfig.json', 'web-ext-config.js', 'web-ext-config.mjs']) {
    if (exists(at(x))) error(r(x), 'no-tooling-at-root', 'AGENTS.md forbids build/lint config in an extension repo; tooling lives in firefox-tools/');
  }
}

// ---------------------------------------------------------------------------
// Folder walk
// ---------------------------------------------------------------------------

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (prefix === '' && REPO_ENTRIES.has(ent.name)) continue;   // repo files are checked by checkRepoFiles
    const r = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push({ rel: r, dir: true }, ...walkFiles(path.join(dir, ent.name), r));
    else out.push({ rel: r, dir: false });
  }
  return out;
}

function checkFolderCommon(f) {
  if (!NAME_RE.test(f.name)) error(f.name, 'folder-name', 'must be lowercase letters, digits and hyphens');
  if (/^firefox-|-extension$|-addon$/.test(f.name)) error(f.label, 'folder-name', 'drop the firefox-/-extension/-addon affix; the GitHub repo name adds firefox-');
  for (const e of walkFiles(f.dir)) {
    const p = `${f.label}/${e.rel}`;
    const base = path.basename(e.rel);
    if (e.dir && ['node_modules', '.git'].includes(base)) error(p, 'layout', `${base} does not belong inside an extension folder`);
    if (e.dir && base === 'web-ext-artifacts') warn(p, 'layout', 'build output present; it is gitignored but should not be committed');
    if (!e.dir && /\.(zip|xpi)$/.test(base)) error(p, 'layout', 'archives do not belong in the source folder');
    if (!e.dir && ['package.json', 'package-lock.json', 'tsconfig.json'].includes(base)) error(p, 'layout', 'no tooling config inside an extension folder');
    if (!e.dir && /^\.(DS_Store)$|^Thumbs\.db$/.test(base)) warn(p, 'layout', 'OS noise file');
  }
  if (!exists(path.join(f.dir, 'README.md'))) error(`${f.label}/README.md`, 'layout', 'missing README.md');
  if (!isDir(path.join(f.dir, 'docs'))) error(`${f.label}/docs`, 'layout', 'missing docs/ folder');
  else {
    if (!exists(path.join(f.dir, 'docs', 'README.md'))) error(`${f.label}/docs/README.md`, 'layout', 'docs/ needs an index README.md');
    if (!exists(path.join(f.dir, 'docs', 'spec.md'))) error(`${f.label}/docs/spec.md`, 'layout', 'docs/spec.md (the product spec) is required');
  }
  if (fs.readdirSync(f.dir).includes('agents.md')) error(`${f.label}/agents.md`, 'layout', 'lowercase agents.md is retired; the spec lives in docs/spec.md, the rules in AGENTS.md');
}

function checkSpecFolder(f) {
  checkFolderCommon(f);
  for (const e of walkFiles(f.dir)) {
    if (!e.dir && /\.(js|mjs|cjs|html|css|json)$/.test(e.rel) && !e.rel.startsWith('docs/')) {
      error(`${f.label}/${e.rel}`, 'spec-folder', 'a folder without manifest.json is a spec folder and holds no code; add the manifest together with the code');
    }
  }
  const md = exists(path.join(f.dir, 'README.md')) ? read(path.join(f.dir, 'README.md')) : '';
  if (md && !/spec(ification)? only|no code yet/i.test(md)) warn(`${f.label}/README.md`, 'spec-folder', 'README should say this is a specification with no code yet');
}

// ---------------------------------------------------------------------------
// Extension folder
// ---------------------------------------------------------------------------

function checkExtension(f) {
  checkRepoFiles(f);
  checkFolderCommon(f);
  const mrel = `${f.label}/manifest.json`;
  const parsed = readManifest(f.dir);
  if (!parsed.ok) { error(mrel, 'manifest', parsed.error); return null; }
  const m = parsed.manifest;
  checkManifest(f, mrel, m);
  checkReferencedFiles(f, mrel, m);
  checkScripts(f, m);
  checkHtmlPages(f, m);
  if (!exists(path.join(f.dir, 'CHANGELOG.md'))) error(`${f.label}/CHANGELOG.md`, 'layout', 'missing CHANGELOG.md');
  else checkChangelog(f, m);
  if (exists(path.join(f.dir, 'README.md'))) checkReadme(f, m);
  if (!isDir(path.join(f.dir, 'icons'))) error(`${f.label}/icons`, 'layout', 'missing icons/ folder');
  checkTests(f);
  checkVersion(f, m);
  if (LINT) lint(f);
  return m;
}

function checkManifest(f, file, m) {
  const mv = m.manifest_version;
  if (mv !== 2 && mv !== 3) error(file, 'manifest', `manifest_version must be 2 or 3 (got ${JSON.stringify(mv)})`);
  if (mv === 2 && (m.action || m.host_permissions)) error(file, 'manifest', 'MV2 manifest uses MV3 keys (action / host_permissions)');
  if (mv === 3 && (m.browser_action || m.background?.persistent !== undefined)) error(file, 'manifest', 'MV3 manifest uses MV2 keys (browser_action / background.persistent)');
  for (const k of ['name', 'version', 'description']) {
    if (typeof m[k] !== 'string' || !m[k].trim()) error(file, 'manifest', `missing "${k}"`);
  }
  if (typeof m.name === 'string' && m.name !== m.name.trim()) error(file, 'manifest', 'name has leading/trailing whitespace');
  if (typeof m.description === 'string' && /[^\x20-\x7e]/.test(m.description)) warn(file, 'manifest', 'description contains non-ASCII characters');
  if (typeof m.version === 'string' && !VERSION_RE.test(m.version)) error(file, 'manifest', `version "${m.version}" must be MAJOR.MINOR.PATCH`);
  const gecko = m.browser_specific_settings?.gecko;
  if (!gecko) error(file, 'manifest', 'missing browser_specific_settings.gecko');
  else {
    if (gecko.id !== `${f.name}${ID_SUFFIX}`) error(file, 'manifest', `gecko.id must be "${f.name}${ID_SUFFIX}" (got ${JSON.stringify(gecko.id)})`);
    else if (!GECKO_ID_RE.test(gecko.id)) error(file, 'manifest', 'gecko.id has an unexpected shape');
    if (gecko.strict_min_version !== MIN_FIREFOX) error(file, 'manifest', `gecko.strict_min_version must be "${MIN_FIREFOX}" (got ${JSON.stringify(gecko.strict_min_version)})`);
    const dcp = gecko.data_collection_permissions;
    if (!dcp || !Array.isArray(dcp.required) || dcp.required.length === 0) error(file, 'manifest', 'gecko.data_collection_permissions.required must be a non-empty array (["none"] when nothing is collected)');
    if (gecko.update_url) error(file, 'manifest', 'update_url is never set; distribution is AMO or temporary load');
  }
  const android = m.browser_specific_settings?.gecko_android;
  if (!android?.strict_min_version) error(file, 'manifest', 'gecko_android.strict_min_version is required ("142.0"); without it web-ext lint rejects data_collection_permissions');
  else if (compareVersions(android.strict_min_version, '142.0') < 0) error(file, 'manifest', `gecko_android.strict_min_version must be at least 142.0 (got ${android.strict_min_version})`);
  if (m.applications) error(file, 'manifest', '"applications" is the legacy name; use browser_specific_settings');
  if (!m.icons || !Object.keys(m.icons).length) error(file, 'manifest', 'icons must list at least one size');
  else if (!m.icons['48']) warn(file, 'manifest', 'icons should include a 48 entry');
  const csp = typeof m.content_security_policy === 'string' ? m.content_security_policy : JSON.stringify(m.content_security_policy ?? '');
  if (/unsafe-eval|https?:\/\//.test(csp)) error(file, 'manifest', 'content_security_policy may only tighten the default; no unsafe-eval or remote sources');
  if (m.background && mv === 2 && m.background.persistent !== false) {
    const arch = path.join(f.dir, 'docs', 'architecture.md');
    const justified = exists(arch) && /persistent/i.test(read(arch)) && /why persistent|persistent[^.]*because|session state/i.test(read(arch));
    if (!justified) warn(file, 'manifest', 'background.persistent is not false; an event page is preferred unless docs/architecture.md says why ("Why persistent: …")');
  }
  if (m.background?.service_worker && !m.background.scripts) warn(file, 'manifest', 'Firefox runs MV3 backgrounds from background.scripts, not service_worker');
  (m.content_scripts ?? []).forEach((cs, i) => {
    if (!Array.isArray(cs.matches) || !cs.matches.length) error(file, 'manifest', `content_scripts[${i}] has no matches`);
    if (!Array.isArray(cs.js) && !Array.isArray(cs.css)) error(file, 'manifest', `content_scripts[${i}] has neither js nor css`);
  });
  const action = m.browser_action ?? m.action;
  if (action && !action.default_title) warn(file, 'manifest', 'action should set default_title');
}

function checkReferencedFiles(f, file, m) {
  for (const r of manifestReferences(m)) {
    if (!exists(path.join(f.dir, r.file))) error(file, 'manifest-files', `${r.key} references "${r.file}" which does not exist`);
  }
}

function checkScripts(f, m) {
  const files = walkFiles(f.dir).filter((e) => !e.dir && isShippedPath(e.rel));
  for (const e of files) {
    const p = path.join(f.dir, e.rel);
    const prel = `${f.label}/${e.rel}`;
    if (/\.(js|mjs)$/.test(e.rel)) {
      const src = read(p);
      const isModule = /^\s*(import|export)\b/m.test(src);
      let res;
      if (isModule) {
        const tmp = path.join(os.tmpdir(), `check-${process.pid}-${path.basename(e.rel)}.mjs`);
        fs.writeFileSync(tmp, src);
        res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
        fs.rmSync(tmp, { force: true });
      } else {
        res = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      }
      if (res.status !== 0) error(prel, 'syntax', (res.stderr || 'node --check failed').trim().split('\n').slice(0, 3).join(' | '));
      if (src.length && !src.endsWith('\n')) warn(prel, 'style', 'file does not end with a newline');
      if (/\beval\s*\(/.test(src)) error(prel, 'dangerous', 'eval() is forbidden (AMO rejects it)');
      if (/\bnew\s+Function\s*\(/.test(src)) error(prel, 'dangerous', 'new Function() is forbidden');
      for (const mm of src.matchAll(/\.innerHTML\s*=\s*([^;\n]+)/g)) {
        const rhs = mm[1].trim();
        const literal = /^(["'])(?:(?!\1).)*\1$/.test(rhs) || (/^`[^`]*`$/.test(rhs) && !/\$\{/.test(rhs)) || rhs === '""' || rhs === "''";
        if (!literal) error(prel, 'dangerous', `innerHTML assigned a non-literal value: ${rhs.slice(0, 40)}`);
      }
      if (/\bconsole\.log\s*\(/.test(src)) warn(prel, 'style', 'console.log left in; use console.warn/error with a [name] prefix, or remove');
      if (/__(NAME|DISPLAY_NAME|DESCRIPTION|ID)__/.test(src)) error(prel, 'placeholder', 'template placeholder (__X__) left in file');
    }
    if (/\.(html|json|css)$/.test(e.rel) && /__(NAME|DISPLAY_NAME|DESCRIPTION|ID)__/.test(read(p))) error(prel, 'placeholder', 'template placeholder (__X__) left in file');
  }
}

function checkHtmlPages(f, m) {
  const htmlFiles = walkFiles(f.dir).filter((e) => !e.dir && /\.html?$/.test(e.rel) && isShippedPath(e.rel));
  for (const e of htmlFiles) {
    const prel = `${f.label}/${e.rel}`;
    const html = read(path.join(f.dir, e.rel));
    for (const mm of html.matchAll(/<script\b([^>]*)>/gi)) {
      if (!/\bsrc\s*=/.test(mm[1])) error(prel, 'inline-script', 'inline <script> blocks are blocked by the extension CSP and rejected by AMO; use <script src>');
      if (/\bsrc\s*=\s*["']https?:/.test(mm[1])) error(prel, 'remote-script', 'remote scripts are forbidden');
    }
    if (/\bon(click|load|change|input|submit|error)\s*=/i.test(html)) error(prel, 'inline-script', 'inline event handlers (onclick=…) are blocked by the extension CSP; use addEventListener');
    for (const r of htmlReferences(html)) {
      const target = path.join(path.dirname(path.join(f.dir, e.rel)), r.file.split(/[?#]/)[0]);
      if (!exists(target)) error(prel, 'html-files', `${r.kind} references "${r.file}" which does not exist`);
    }
  }
  // Popup/options pages named in the manifest must be html
  for (const [kind, file] of Object.entries(extensionPages(m))) {
    if (!/\.html?$/.test(file)) error(`${f.label}/manifest.json`, 'manifest', `${kind} page "${file}" should be an .html file`);
  }
}

function checkChangelog(f, m) {
  const p = path.join(f.dir, 'CHANGELOG.md');
  const prel = `${f.label}/CHANGELOG.md`;
  const md = read(p);
  const heads = [...md.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/gm)];
  const anyHeads = [...md.matchAll(/^##\s+/gm)];
  if (anyHeads.length && heads.length !== anyHeads.length) error(prel, 'changelog', 'every "## " heading must be "## [x.y.z] — YYYY-MM-DD"');
  if (!heads.length) { error(prel, 'changelog', 'no version entries'); return; }
  if (heads[0][1] !== m.version) error(prel, 'changelog', `newest entry is [${heads[0][1]}] but manifest version is ${m.version}; add an entry (or fix the order — newest first)`);
  if (!heads.some((h) => h[1] === m.version)) error(prel, 'changelog', `no entry for version ${m.version}`);
  for (let i = 1; i < heads.length; i++) {
    if (compareVersions(heads[i][1], heads[i - 1][1]) >= 0) { error(prel, 'changelog', `entries are not newest-first around [${heads[i][1]}]`); break; }
  }
  if (/__(NAME|DISPLAY_NAME|DESCRIPTION|ID)__/.test(md)) error(prel, 'placeholder', 'template placeholder left in file');
}

function checkReadme(f, m) {
  const p = path.join(f.dir, 'README.md');
  const prel = `${f.label}/README.md`;
  const md = read(p);
  if (/__(NAME|DISPLAY_NAME|DESCRIPTION|ID)__/.test(md)) error(prel, 'placeholder', 'template placeholder (__X__) left in file');
  if (/<!--[\s\S]*?-->/.test(md)) warn(prel, 'placeholder', 'HTML comment left in README (template guidance?)');
  const h1 = /^#\s+(.+?)\s*$/m.exec(md);
  if (!h1) error(prel, 'readme-sections', 'missing title (# heading)');
  else if (m.name && h1[1].trim() !== m.name.trim()) error(prel, 'readme-sections', `title "${h1[1].trim()}" differs from manifest name "${m.name}"`);
  const positions = [];
  for (const [label, re] of README_SECTIONS) {
    const mm = re.exec(md);
    if (!mm) error(prel, 'readme-sections', `missing "## ${label}" section`);
    else positions.push([label, mm.index]);
  }
  for (let i = 1; i < positions.length; i++) {
    if (positions[i][1] < positions[i - 1][1]) { warn(prel, 'readme-sections', `sections out of the required order (at "${positions[i][0]}")`); break; }
  }
  if (!md.includes(sourceUrl(f.name))) error(prel, 'install-link', `Installation section must include the Source link ${sourceUrl(f.name)}`);
  if (!/about:debugging/.test(md)) error(prel, 'install-link', 'Installation must describe the about:debugging temporary load');
  if (!/at\s+(your|the user'?s)\s+own\s+risk/i.test(md)) error(prel, 'ai-generated', 'AI-generated section must say the extension is used at the user\'s own risk');
  if (!/\]\(UNLICENSE\)/.test(md)) error(prel, 'license', 'License section must link to (UNLICENSE), the file at this repo\'s root');
  if (/\((\.\.\/)+UNLICENSE\)|\(\.?\/?LICENSE\)/.test(md)) error(prel, 'license', 'stale license link; the file is UNLICENSE at this repo\'s root');

  // Permissions section must name every declared permission and speak to data collection.
  const secStart = md.search(/^##\s+permissions\s*$/im);
  if (secStart >= 0) {
    const after = md.slice(secStart);
    const next = after.slice(1).search(/^##\s+[^#]/m);
    const section = next < 0 ? after : after.slice(0, next + 1);
    for (const perm of declaredPermissions(m)) {
      if (!section.includes(perm)) error(prel, 'permissions', `permission "${perm}" is declared in the manifest but not explained in the Permissions section`);
    }
    for (const cs of m.content_scripts ?? []) for (const pat of cs.matches ?? []) {
      if (!section.includes(pat) && !/content script/i.test(section)) warn(prel, 'permissions', `content script match "${pat}" is not mentioned in the Permissions section`);
    }
    if (!/data collection|collects? (no|nothing)|nothing leaves the browser|no data/i.test(section)) error(prel, 'permissions', 'Permissions section must say what data_collection_permissions declares (usually: none, nothing leaves the browser)');
    if (/all_frames/.test(JSON.stringify(m.content_scripts ?? [])) && !/all_frames|frames?/i.test(section)) warn(prel, 'permissions', 'content script uses all_frames; say why in the Permissions section');
  }
  if (!/firefox/i.test(md)) error(prel, 'firefox-only', 'must mention Firefox');
}

// tests/: the suites, the hand-made test pages and the live-check settings.
// The pull request checks run them; here we only make sure they are there and
// wired to this layout.
function checkTests(f) {
  const t = testsDirOf(f.dir);
  const tr = `${f.label}/tests`;
  if (!isDir(t)) { error(tr, 'tests', 'missing tests/ folder (the test suites, test pages and harness.json); start from firefox-tools/templates/smoke.test.mjs'); return; }
  const suites = fs.readdirSync(t).filter((x) => x.endsWith('.test.mjs'));
  if (!suites.length) error(tr, 'tests', 'no test suites (tests/*.test.mjs)');
  for (const x of suites) {
    const src = read(path.join(t, x));
    if (/from\s+['"](\.\.\/)+harness\/lib\.mjs['"]/.test(src)) error(`${tr}/${x}`, 'tests', 'imports the old workshop harness; import ../../firefox-tools/harness/lib.mjs');
    if (/harnessDir,\s*'\.\.',\s*'fixtures'/.test(src)) error(`${tr}/${x}`, 'tests', 'reads test pages from the old workshop; use path.join(T.testsDir, \'fixtures\', …) or T.fixture(…)');
  }
  const hp = path.join(t, 'harness.json');
  if (!exists(hp)) { error(`${tr}/harness.json`, 'tests', 'missing live-check settings (copy firefox-tools/templates/harness.json)'); return; }
  let spec;
  try { spec = JSON.parse(read(hp)); } catch (e) { error(`${tr}/harness.json`, 'tests', `not valid JSON: ${e.message}`); return; }
  const pages = [spec.fixture, ...Object.values(spec.routes ?? {})].filter((x) => typeof x === 'string');
  for (const pg of new Set(pages)) {
    if (!exists(path.join(t, 'fixtures', `${pg}.html`))) error(`${tr}/harness.json`, 'tests', `names test page "${pg}" but tests/fixtures/${pg}.html does not exist`);
  }
}

// The version is bumped once, in the release pull request, not with each
// change. All we check here is that it never goes backwards: Firefox never
// downgrades, and Mozilla signs each version only once. The last release is
// the highest local `v<x.y.z>` tag (`git fetch --tags` brings them here).
function checkVersion(f, m) {
  const file = `${f.label}/manifest.json`;
  if (!m.version || !VERSION_RE.test(m.version)) return;
  const tags = spawnSync('git', ['tag', '--list', 'v*'], { cwd: f.dir, encoding: 'utf8' });
  const releases = (tags.stdout || '').split('\n').map((x) => x.trim()).filter((x) => /^v\d+\.\d+\.\d+$/.test(x)).map((x) => x.slice(1));
  if (!releases.length) return;
  const last = releases.sort(compareVersions).pop();
  if (compareVersions(m.version, last) < 0) error(file, 'version', `version ${m.version} is lower than the last release, ${last}; Firefox never downgrades`);
}

function findWebExt() {
  const local = path.join(TOOLS, 'node_modules', '.bin', 'web-ext');
  if (exists(local)) return local;
  const which = spawnSync('sh', ['-c', 'command -v web-ext'], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() : null;
}

function lint(f) {
  const bin = findWebExt();
  if (!bin) { warn(`${f.label}`, 'lint', 'web-ext not found; run `npm install --prefix ../firefox-tools` (or install it globally). Lint NOT run'); return; }
  const ignore = [...[...REPO_ENTRIES].filter((e) => !e.startsWith('.')), 'tests/**'];   // web-ext already skips dotfiles
  const res = spawnSync(bin, ['lint', '--source-dir', f.dir, '--output', 'json', '--warnings-as-errors', '--ignore-files', ...ignore], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let out;
  try { out = JSON.parse(res.stdout); } catch { error(`${f.label}`, 'lint', `web-ext lint produced no JSON (exit ${res.status}): ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' | ')}`); return; }
  for (const it of out.errors ?? []) error(`${f.label}/${it.file ?? 'manifest.json'}`, 'lint', `${it.code}: ${it.message}${it.line ? ` (line ${it.line})` : ''}`);
  for (const it of out.warnings ?? []) error(`${f.label}/${it.file ?? 'manifest.json'}`, 'lint', `${it.code}: ${it.message}${it.line ? ` (line ${it.line})` : ''} [warning; CI treats it as an error]`);
  for (const it of out.notices ?? []) warn(`${f.label}/${it.file ?? 'manifest.json'}`, 'lint', `${it.code}: ${it.message}`);
}

// ---------------------------------------------------------------------------

const folders = discoverFolders();
const targets = only.size ? folders.filter((x) => only.has(x.name)) : folders;
for (const n of only) if (!folders.some((x) => x.name === n)) error(n, 'args', 'no such extension');
if (!only.size) checkGroup();
for (const fo of targets) (fo.kind === 'extension' ? checkExtension : checkSpecFolder)(fo);

findings.sort((a, b) => (a.level === b.level ? a.file.localeCompare(b.file) : a.level === 'error' ? -1 : 1));
for (const x of findings) {
  if (QUIET && x.level === 'warning') continue;
  console.log(`${x.file}: ${x.level === 'warning' ? 'warning: ' : ''}${x.rule}: ${x.msg}`);
}
const errors = findings.filter((x) => x.level === 'error').length;
const warnings = findings.length - errors;
const ext = targets.filter((x) => x.kind === 'extension').length;
const spec = targets.filter((x) => x.kind === 'spec').length;
if (!QUIET || errors) console.log(`${ext} extension(s) + ${spec} spec folder(s) checked, ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);

#!/usr/bin/env node
// Scaffold a new extension repo from firefox-tools/templates: ~/src/firefox/<name>/
// with the extension files, the repo files, tests/ (a smoke test, a test page
// and harness.json) and a fresh `git init`; then run the validator on it.
//
//   node ../firefox-tools/tools/new-extension.mjs <name> "<description>" [--name "Display Name"] [--promote]
//
// The code, the README prose and docs/spec.md are still yours to write.
// Creating the GitHub repository is not done here: ask the owner first.
// --promote turns an existing spec folder (README + docs/, no manifest) into
// an extension: it adds the code files but keeps the folder's README and docs.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GROUP_ROOT, TOOLS, PRIVATE_WORKSHOP, NAME_RE, ID_SUFFIX, NOT_EXTENSIONS, exists, isDir, today, repoName } from './lib/extension.mjs';

const argv = process.argv.slice(2);
let displayName = null;
const nameIdx = argv.indexOf('--name');
if (nameIdx >= 0) { displayName = argv[nameIdx + 1]; argv.splice(nameIdx, 2); }
const promote = argv.includes('--promote');
if (promote) argv.splice(argv.indexOf('--promote'), 1);
const [name, description] = argv;

function die(msg) { console.error(`new-extension: ${msg}`); process.exit(2); }
if (!name || !description) die('usage: new-extension.mjs <name> "<description>" [--name "Display Name"] [--promote]');
if (!NAME_RE.test(name)) die(`name "${name}" must be lowercase letters, digits and hyphens`);
if (/^firefox-|-extension$|-addon$/.test(name)) die('drop the firefox-/-extension/-addon affix');
if (NOT_EXTENSIONS.has(name) || name.startsWith('.') || name.startsWith('_')) die('that is not an extension folder');

const dir = path.join(GROUP_ROOT, name);
if (exists(path.join(dir, 'manifest.json'))) die(`${name}/ already has a manifest.json`);
if (exists(dir) && !promote) die(`${name}/ exists; pass --promote if it is a spec folder to turn into an extension`);
if (promote && !exists(dir)) die(`--promote: ${name}/ does not exist`);

const tpl = path.join(TOOLS, 'templates');
const humanName = displayName ?? name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const fill = (s) => s
  .replaceAll('__DISPLAY_NAME__', humanName)
  .replaceAll('__DESCRIPTION__', description.replace(/\.$/, ''))
  .replaceAll('__NAME__', name)
  .replaceAll('__ID__', `${name}${ID_SUFFIX}`)
  .replaceAll('__DATE__', today());
const copy = (from, to, { skipIfExists = false } = {}) => {
  if (skipIfExists && exists(to)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, fill(fs.readFileSync(path.join(tpl, from), 'utf8')));
  return true;
};

// 1–2. folder + code + docs
fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
fs.mkdirSync(path.join(dir, 'icons'), { recursive: true });
for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'CHANGELOG.md']) copy(f, path.join(dir, f));
copy('icons/icon.svg', path.join(dir, 'icons', 'icon.svg'));
copy('README.md', path.join(dir, 'README.md'), { skipIfExists: promote });
copy('docs/README.md', path.join(dir, 'docs', 'README.md'), { skipIfExists: promote });
copy('docs/spec.md', path.join(dir, 'docs', 'spec.md'), { skipIfExists: promote });

// 3–4. tests: a smoke test, a test page and the live-check settings
copy('smoke.test.mjs', path.join(dir, 'tests', 'smoke.test.mjs'), { skipIfExists: true });
copy('fixture.html', path.join(dir, 'tests', 'fixtures', 'index.html'), { skipIfExists: true });
copy('harness.json', path.join(dir, 'tests', 'harness.json'), { skipIfExists: true });
// The maintainer's private notes, only when the private workshop is here.
if (isDir(path.join(PRIVATE_WORKSHOP, 'notes'))) {
  fs.mkdirSync(path.join(PRIVATE_WORKSHOP, 'notes', 'extensions'), { recursive: true });
  const note = path.join(PRIVATE_WORKSHOP, 'notes', 'extensions', `${name}.md`);
  if (!exists(note)) fs.writeFileSync(note, `# ${humanName} — notes\n\n## ${today()}\n\n- Scaffolded from firefox-tools/templates${promote ? ' (promoted from a spec folder)' : ''}.\n`);
}

// Repo files: AGENTS.md (the rules); CI checks every push and pull request.
copy('repo/AGENTS.md', path.join(dir, 'AGENTS.md'), { skipIfExists: promote });
copy('repo/CLAUDE.md', path.join(dir, 'CLAUDE.md'), { skipIfExists: promote });
copy('repo/gitignore', path.join(dir, '.gitignore'), { skipIfExists: promote });
copy('repo/claude-settings.json', path.join(dir, '.claude', 'settings.json'), { skipIfExists: promote });
copy('repo/lint.yml', path.join(dir, '.github', 'workflows', 'lint.yml'), { skipIfExists: promote });
copy('UNLICENSE', path.join(dir, 'UNLICENSE'), { skipIfExists: promote });
if (!exists(path.join(dir, '.git'))) {
  const g = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
  if (g.status !== 0) console.error(`new-extension: warning: git init failed; run it by hand in ${dir}`);
}

console.log(`created ${name}/ (git repo: manifest, background, content, popup, docs, icons, tests, AGENTS.md, CLAUDE.md, UNLICENSE, .gitignore, .claude/, .github/)`);
console.log('next: replace the *://example.com/* match, write the code, fill README.md and docs/spec.md, then run the harness and the validator');
console.log(`GitHub (only after the owner agrees): cd ${dir} && gh repo create inklikeurine/${repoName(name)} --public --source . --push`);
const res = spawnSync(process.execPath, [path.join(TOOLS, 'tools', 'check.mjs'), name], { stdio: 'inherit' });
process.exit(res.status ?? 1);

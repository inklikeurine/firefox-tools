#!/usr/bin/env node
// "Your new tests must fail without your change": runs a pull request's new
// or changed test suites against the base branch's code. At least one of them
// must fail there; if none do, they don't test the change.
//
//   node ../firefox-tools/tools/fail-first.mjs <name> <base-sha>
//
// Run from the extension's folder, with the pull request checked out.
// Environment: PR_LABELS (a JSON array of label names).
//
// This runs the pull request's test code, so it belongs in checks.yml (on
// pull_request, with no secrets), never in guards.yml.
//
// Nothing to prove, so it passes, when:
//   - no shipped file changed (docs, tests or repo files only)
//   - the only shipped change is manifest.json's version (a release)
//   - the maintainer added the `no-test-needed` label (e.g. a clean-up that
//     changes no behaviour)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GROUP_ROOT, TOOLS, findFolder, isShippedPath } from './lib/extension.mjs';

const [name, base] = process.argv.slice(2);
if (!name || !base) { console.error('usage: fail-first.mjs <name> <base-sha>'); process.exit(2); }
const labels = new Set(JSON.parse(process.env.PR_LABELS || '[]'));
const f = findFolder(name);
if (!f) { console.error(`fail-first: no extension named ${name} in ${GROUP_ROOT}`); process.exit(2); }

function git(...args) {
  const r = spawnSync('git', args, { cwd: f.dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}
const lines = (s) => s.split('\n').filter(Boolean);
const report = (text, code) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## New tests fail without the change\n\n${text}\n`);
  process.exit(code);
};

const from = git('merge-base', base, 'HEAD').trim();
const changes = lines(git('diff', '--no-renames', '--name-status', from, 'HEAD')).map((l) => {
  const [status, file] = l.split('\t');
  return { status: status[0], file };
});

const shipped = changes.filter((c) => isShippedPath(c.file));
if (!shipped.length) report('PASS  No shipped code changed, so there is no change for a test to prove.', 0);

if (shipped.length === 1 && shipped[0].file === 'manifest.json' && shipped[0].status === 'M') {
  try {
    const before = JSON.parse(git('show', `${from}:manifest.json`));
    const after = JSON.parse(fs.readFileSync(path.join(f.dir, 'manifest.json'), 'utf8'));
    delete before.version; delete after.version;
    if (JSON.stringify(before) === JSON.stringify(after)) report('PASS  Only the version in manifest.json changed (a release), so there is nothing for a test to prove.', 0);
  } catch { /* fall through to the real check */ }
}

if (labels.has('no-test-needed')) report('ALLOWED  The maintainer added `no-test-needed`, so this change doesn\'t need a test that fails without it.', 0);

const suites = changes
  .filter((c) => (c.status === 'A' || c.status === 'M') && /^tests\/[^/]+\.test\.mjs$/.test(c.file))
  .map((c) => path.basename(c.file));
if (!suites.length) {
  report([
    'FAIL  This pull request changes shipped code but adds or changes no test suite (tests/*.test.mjs).',
    '  Add a test that fails without your change. If the change really can\'t have one (a clean-up that changes no behaviour, say),',
    '  explain why in the pull request; the maintainer can allow it with the `no-test-needed` label.',
  ].join('\n'), 1);
}

// The base branch's code, with this pull request's tests/ dropped in. It sits
// beside firefox-tools so the suites' ../../firefox-tools/ imports still work.
const tmp = path.join(GROUP_ROOT, `.fail-first-${name}`);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
let results;
try {
  const tar = spawnSync('git', ['archive', '--format=tar', from], { cwd: f.dir, maxBuffer: 1024 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`git archive failed: ${tar.stderr}`);
  const x = spawnSync('tar', ['-x', '-C', tmp], { input: tar.stdout });
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
  fs.rmSync(path.join(tmp, 'tests'), { recursive: true, force: true });
  fs.cpSync(path.join(f.dir, 'tests'), path.join(tmp, 'tests'), { recursive: true });
  const harnessDir = path.join(TOOLS, 'harness');
  results = suites.map((s) => {
    const r = spawnSync(process.execPath, [path.join(tmp, 'tests', s), tmp, harnessDir, path.join(tmp, 'tests')], { encoding: 'utf8', timeout: 60000 });
    const summary = (r.stdout.match(/^--- .*$/m) ?? [`exit ${r.status}`])[0].replace(/^--- /, '');
    return { suite: s, fails: r.status !== 0, summary };
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const out = results.map((r) => `  - ${r.suite} on the base branch's code: ${r.fails ? 'fails' : 'passes'} (${r.summary})`);
if (results.some((r) => r.fails)) report(['PASS  At least one new or changed test fails without this change, so it tests the change.', ...out].join('\n'), 0);
report([
  'FAIL  None of this pull request\'s new or changed tests fail on the base branch\'s code, so they don\'t test the change.',
  ...out,
  '  Add a test that fails without your change. If the change really can\'t have one, explain why in the pull request;',
  '  the maintainer can allow it with the `no-test-needed` label.',
].join('\n'), 1);

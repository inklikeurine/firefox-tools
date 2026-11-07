#!/usr/bin/env node
// Pull request guards. They only READ the change and never run its code, so
// they are safe to run from the base branch's own workflow (guards.yml, on
// pull_request_target), where a pull request cannot switch them off.
//
//   node ../firefox-tools/tools/pr-guards.mjs <base-sha>
//
// Run from the extension's folder, with the pull request checked out.
// Environment: PR_LABELS (a JSON array of label names), PR_AUTHOR (a login).
//
// Fails when the pull request does one of these without the maintainer's label:
//   tests-changed   removes or edits an existing line in tests/ (adding is fine)
//   new-access      adds a permission or a content-script match, changes the
//                   content security policy, or adds a web address (a host)
//                   the shipped code didn't contain before
//   rules-changed   changes .github/, .claude/, AGENTS.md or CLAUDE.md: the
//                   files that control the checks and the maintainer's AI
//                   tools (Dependabot's updates to .github/ are allowed)

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isShippedPath } from './lib/extension.mjs';

const base = process.argv[2];
if (!base) { console.error('usage: pr-guards.mjs <base-sha>'); process.exit(2); }
const labels = new Set(JSON.parse(process.env.PR_LABELS || '[]'));
const author = process.env.PR_AUTHOR || '';

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}
const lines = (s) => s.split('\n').filter(Boolean);
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };

// Compare against where the pull request branched off, so changes that landed
// on the base branch since then don't count against it.
const from = git('merge-base', base, 'HEAD').trim();
const changes = lines(git('diff', '--no-renames', '--name-status', from, 'HEAD')).map((l) => {
  const [status, file] = l.split('\t');
  return { status: status[0], file };
});
const numstat = new Map(lines(git('diff', '--no-renames', '--numstat', from, 'HEAD')).map((l) => {
  const [added, removed, file] = l.split('\t');
  return [file, { added, removed }];
}));

const problems = [];   // { label, title, items[], fix }

// --- tests-changed ----------------------------------------------------------
{
  const items = [];
  for (const c of changes) {
    if (!c.file.startsWith('tests/')) continue;
    if (c.status === 'D') items.push(`${c.file}: removed`);
    else if (c.status === 'M' || c.status === 'T') {
      const n = numstat.get(c.file);
      if (!n || n.removed === '-') items.push(`${c.file}: changed`);
      else if (Number(n.removed) > 0) items.push(`${c.file}: ${n.removed} existing line(s) removed or edited`);
    }
  }
  if (items.length) problems.push({
    label: 'tests-changed',
    title: 'Existing tests were changed',
    items,
    fix: 'Pull requests may add tests but not edit or remove existing ones, so a test can\'t be bent to fit broken code. If an existing test really is wrong, explain why in the pull request; the maintainer can allow it with the `tests-changed` label.',
  });
}

// --- new-access -------------------------------------------------------------
{
  const items = [];
  const baseManifestText = tryGit('show', `${from}:manifest.json`);
  const headManifestText = fs.existsSync('manifest.json') ? fs.readFileSync('manifest.json', 'utf8') : null;
  let bm = null, hm = null;
  try { bm = baseManifestText ? JSON.parse(baseManifestText) : null; } catch { /* unreadable before: compare against nothing */ }
  try { hm = headManifestText ? JSON.parse(headManifestText) : null; } catch { items.push('manifest.json is not valid JSON'); }
  if (hm) {
    const asSet = (m, k) => new Set((m?.[k] ?? []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
    for (const k of ['permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions']) {
      const before = asSet(bm, k);
      for (const p of asSet(hm, k)) if (!before.has(p)) items.push(`manifest.json ${k}: adds "${p}"`);
    }
    const matches = (m) => new Set((m?.content_scripts ?? []).flatMap((cs) => cs.matches ?? []));
    const beforeMatches = matches(bm);
    for (const p of matches(hm)) if (!beforeMatches.has(p)) items.push(`manifest.json content_scripts: runs on a new page pattern "${p}"`);
    if (JSON.stringify(bm?.content_security_policy ?? null) !== JSON.stringify(hm.content_security_policy ?? null)) {
      items.push('manifest.json content_security_policy: changed');
    }
  }

  // Web addresses: hosts named in shipped files now, that weren't before.
  const HOST = /\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
  const hostsIn = (ref) => {
    const hosts = new Map();   // host -> first file
    for (const file of lines(git('ls-tree', '-r', '--name-only', ref))) {
      if (!isShippedPath(file)) continue;
      const text = tryGit('show', `${ref}:${file}`);
      if (text == null || text.length > 2 * 1024 * 1024) continue;
      for (const m of text.matchAll(HOST)) {
        const h = m[1].toLowerCase();
        if (!hosts.has(h)) hosts.set(h, file);
      }
    }
    return hosts;
  };
  const before = hostsIn(from);
  for (const [h, file] of hostsIn('HEAD')) if (!before.has(h)) items.push(`${file}: new web address ${h}`);

  if (items.length) problems.push({
    label: 'new-access',
    title: 'New permissions or web addresses',
    items,
    fix: 'New permissions, pages the extension runs on, and web addresses it talks to are where code that steals data would show up, so each needs the maintainer\'s OK. Explain in the pull request what it\'s for; the maintainer can allow it with the `new-access` label.',
  });
}

// --- rules-changed ----------------------------------------------------------
{
  const isRules = (f) => f.startsWith('.github/') || f.startsWith('.claude/') || f === 'AGENTS.md' || f === 'CLAUDE.md';
  const items = changes
    .filter((c) => isRules(c.file))
    .filter((c) => !(author === 'dependabot[bot]' && c.file.startsWith('.github/')))
    .map((c) => `${c.file}: ${{ A: 'added', D: 'removed' }[c.status] ?? 'changed'}`);
  if (items.length) problems.push({
    label: 'rules-changed',
    title: 'Files that control the checks or the maintainer\'s AI tools',
    items,
    fix: 'These files decide what the checks do (.github/) and what AI tools do with this repository (.claude/, AGENTS.md, CLAUDE.md); a change to .claude/settings.json can even run commands on the maintainer\'s computer. The maintainer can allow a change with the `rules-changed` label.',
  });
}

// --- report -------------------------------------------------------------------
const out = [];
const blocking = problems.filter((p) => !labels.has(p.label));
for (const p of problems) {
  const allowed = labels.has(p.label);
  out.push(`${allowed ? 'ALLOWED' : 'FAIL'}  ${p.title}${allowed ? ` (the maintainer added \`${p.label}\`)` : ''}`);
  for (const i of p.items) out.push(`  - ${i}`);
  if (!allowed) out.push(`  ${p.fix}`);
  out.push('');
}
if (!problems.length) out.push('PASS  No existing tests changed, no new permissions or web addresses, no rule files changed.');
const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Pull request guards\n\n\`\`\`\n${text}\n\`\`\`\n`);
process.exit(blocking.length ? 1 : 0);

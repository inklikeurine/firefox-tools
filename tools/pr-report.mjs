#!/usr/bin/env node
// The checks' report for a pull request, in plain words: what failed, where,
// and what to do. The workflows save it, and report.yml posts it as one
// comment on the pull request, updated on every run.
//
//   node ../firefox-tools/tools/pr-report.mjs <name> checks|guards
//
// Run from the extension's folder. It reads what the steps left in
// ../firefox-tools/out/<name>/: check.log (the validator), result.json and
// tests.log (tests and live check), fail-first.log, guards.log; and each
// step's outcome from the environment (success, failure, skipped, cancelled):
//   checks: OUTCOME_SETUP, OUTCOME_VALIDATE, OUTCOME_TESTS, OUTCOME_FAILFIRST
//   guards: OUTCOME_GUARDS
// RUN_URL, when set, is linked at the end.
//
// Writes report.md (the comment) and status (PASS or FAIL) into
// ../firefox-tools/out/<name>/report/. It only reads files, so it is safe in
// either workflow. It never fails the job itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [name, kind] = process.argv.slice(2);
if (!name || !['checks', 'guards'].includes(kind)) {
  console.error('usage: pr-report.mjs <name> checks|guards');
  process.exit(2);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', name);
const MAX_ITEMS = 15;
const read = (f) => { try { return fs.readFileSync(path.join(OUT, f), 'utf8'); } catch { return ''; } };
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
const outcome = (k) => process.env[`OUTCOME_${k}`] || 'skipped';
const clip = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
// Text from a log goes in as text: no markdown, no mentions, no HTML.
const plain = (s) => clip(String(s).replace(/\r/g, ''), 600).replace(/[`*_<>[\]|]/g, (c) => `\\${c}`).replace(/@/g, '@​');
const list = (items) => {
  const shown = items.slice(0, MAX_ITEMS).map((x) => `- ${x}`);
  if (items.length > MAX_ITEMS) shown.push(`- …and ${items.length - MAX_ITEMS} more (open the check's log for all of them)`);
  return shown.join('\n');
};

// A tool's own words (fail-first, the guards), quoted as they are.
const quote = (text) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 40).map((l) => `> ${plain(l)}`).join('\n');

const sections = [];
let failed = 0;

function section(title, ok, body) {
  if (!ok) failed += 1;
  sections.push(`#### ${ok ? '✅' : '❌'} ${title}${body ? `\n\n${body}` : ''}`);
}

if (kind === 'checks') {
  if (outcome('SETUP') !== 'success') {
    section('The checks could not start', false,
      "Installing the shared tools or Firefox failed, so nothing was checked. That is almost always GitHub's side: open the pull request's Checks tab and press **Re-run**.");
  } else {
    // The validator: "path: rule: message" per finding, then a summary line.
    const v = outcome('VALIDATE');
    const lines = read('check.log').split('\n').map((l) => l.trim()).filter((l) => l && !/checked, \d+ error/.test(l));
    const errors = lines.filter((l) => !/warning/i.test(l));
    const warnings = lines.filter((l) => /warning/i.test(l));
    if (v === 'success') {
      section('Validate (the code checker)', true, warnings.length ? `Passed, with things worth a look:\n${list(warnings.map(plain))}` : '');
    } else {
      section('Validate (the code checker)', false,
        `It found ${errors.length || 'a'} problem${errors.length === 1 ? '' : 's'} in the code itself (each is a file, then what is wrong):\n${list((errors.length ? errors : ['see the log']).map(plain))}`);
    }
    // Tests and the live check.
    const result = json('result.json');
    const t = outcome('TESTS');
    if (t === 'skipped' || !result) {
      section('Tests and live check', t === 'success', t === 'success' ? '' : 'They did not run, or left no results. Open the check\'s log.');
    } else {
      const fails = read('tests.log').split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => plain(l.slice(5)));
      const crashed = (result.tests && result.tests.suites || []).filter((s) => !s.pass).map((s) => s.file);
      const testsOk = !result.tests || result.tests.pass !== false;
      const lead = 'Each line is a test that failed, then what it expected and what it got:';
      section('Tests', testsOk && fails.length === 0,
        testsOk && fails.length === 0 ? '' : `${lead}\n${list(fails.length ? fails : crashed.map((f) => `${plain(f)} stopped with an error before it finished`))}`);
      const live = result.live || {};
      const liveErrors = (live.errors || []).map((e) => {
        const m = /^step "(.+?)" failed at check (\d+) of (\d+)/.exec(String(e));
        return m ? `**${plain(m[1])}**: check ${m[2]} of ${m[3]} failed` : plain(e);
      });
      const liveOk = live.pass !== false && liveErrors.length === 0;
      section('Live check in a hidden Firefox', liveOk,
        liveOk ? '' : `Each line is a step that failed (where in the extension, then which check):\n${list(liveErrors.length ? liveErrors : ['see the log'])}`);
    }
    // New tests must fail without the change (pull requests only).
    const f = outcome('FAILFIRST');
    if (f !== 'skipped') {
      const text = read('fail-first.log').trim();
      section('New tests fail without the change', f === 'success',
        f === 'success' ? (/PASSES/.test(text) ? `Passed. Some new tests pass without the change too, so the pull request should say why each is needed:\n${list(text.split('\n').filter((l) => /PASSES/.test(l)).map((l) => plain(l.replace(/^\s*PASSES\s*/, ''))))}` : '')
          : (text ? quote(text) : 'See the log.'));
    }
  }
} else {
  const g = outcome('GUARDS');
  const text = read('guards.log').trim();
  section('Guards (the rules a pull request needs a label to break)', g === 'success',
    g === 'success' ? '' : (text ? quote(text) : 'See the log.'));
}

const title = kind === 'checks' ? 'Checks' : 'Guards';
const head = failed
  ? `### ❌ ${title}: ${failed} problem${failed === 1 ? '' : 's'}`
  : `### ✅ ${title}: all passed`;
const runUrl = process.env.RUN_URL ? `\n\n[The full log](${process.env.RUN_URL})` : '';
const body = `${head}\n\n${sections.join('\n\n')}${runUrl}\n`;
fs.mkdirSync(path.join(OUT, 'report'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'report', 'report.md'), body);
fs.writeFileSync(path.join(OUT, 'report', 'status'), failed ? 'FAIL\n' : 'PASS\n');
console.log(body);

#!/usr/bin/env node
// Claude Code PostToolUse hook: after an Edit/Write/Bash that touches an
// extension repo or a journal, run the validator and feed any errors back to
// the model. Wired up in each extension repo's .claude/settings.json
// (committed); the settings file guards on this script existing, so a clone
// without the workshop simply has no hook. Silent on success.
//
// Scope: the extensions whose repos the edit touched; else the one the
// session was opened in ($CLAUDE_PROJECT_DIR).
//
// Reads the hook payload from stdin; exit 2 makes Claude Code show stderr to
// the model, any other exit code is ignored.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { WORKSHOP, discoverFolders } from './lib/extension.mjs';

let payload = {};
try { payload = JSON.parse(await new Response(process.stdin).text() || '{}'); } catch { process.exit(0); }

const input = payload.tool_input ?? {};
const touched = [input.file_path, input.command, input.notebook_path].filter(Boolean).join('\n');
if (!touched) process.exit(0);

// Which extensions did this edit touch? Absolute paths name the repo folder;
// a relative path or a bare repo-file name falls back to the session's repo.
const folders = discoverFolders().filter((f) => f.kind === 'extension');
const inside = (f) => touched.includes(f.dir + path.sep) || touched.includes(`${f.dir}"`) || touched.includes(`${f.dir}'`);
let names = folders.filter(inside).map((f) => f.name);
const journal = /review\/([^/\s"']+)\/journal\.md/.exec(touched);
if (journal && folders.some((f) => f.name === journal[1])) names.push(journal[1]);
const repoFileTouch = /(^|[\s/"'])(README\.md|CHANGELOG\.md|AGENTS\.md|CLAUDE\.md|UNLICENSE|\.gitignore|manifest\.json|\.claude\/settings\.json|\.github\/workflows\/lint\.yml|[\w./-]+\.(js|mjs|html|css|json))\b/.test(touched);
if (!names.length && repoFileTouch) {
  const project = process.env.CLAUDE_PROJECT_DIR ? path.resolve(process.env.CLAUDE_PROJECT_DIR) : null;
  const own = folders.find((f) => f.dir === project);
  if (own) names = [own.name];
}
names = [...new Set(names)];
if (!names.length) process.exit(0);

// Journal edits get the full check (that is when the evidence rules matter);
// code edits get --no-journal so an in-progress change is not nagged about
// its report yet. Lint runs either way — the hook has a 60 s budget.
const args = [path.join(WORKSHOP, 'tools', 'check.mjs'), '--quiet'];
if (!journal) args.push('--no-journal');
args.push(...names);
const res = spawnSync(process.execPath, args, { cwd: WORKSHOP, encoding: 'utf8' });
if (res.status === 0) process.exit(0);
process.stderr.write(`check.mjs found errors after editing:\n${res.stdout}${res.stderr}`);
process.exit(2);

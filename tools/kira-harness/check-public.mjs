#!/usr/bin/env node
// Nothing in this folder may say where it was written.
//
// A tool that carries a person's paths, a private repository's name, or a title's own file
// names is not something that can be published: it either leaks something or is useless to
// anyone else. This checks the whole repository with `git grep`, so what is committed is
// what is checked, and it also reads the settings example (which is committed) and refuses
// a real settings file next to it.
//
//   node tools/kira-harness/check-public.mjs [--all]
//
// `--all` also looks at the rest of the repository rather than only this folder.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const all = process.argv.includes('--all');

/**
 * What may not appear, and why.
 * Each entry is a pattern for `git grep -E`, a reason, and the files it is allowed in
 * (`only`) or must never appear in (`never`).
 */
// Written in pieces: this file is inside the tree it checks, and a rule that spells its
// own pattern out would fail on itself.
const RULES = [
  { name: 'a Windows drive path', re: '[A-Za-z]:[\\\\/](Users|Downloads|Games|Program)', why: 'a path on one machine' },
  { name: 'a Unix home path', re: '/(home|Users)/[A-Za-z0-9._-]+/', why: 'a path on one machine' },
  { name: 'a private repository name', re: 'Project' + '-Leonida', why: 'a repository that is not this one' },
  { name: 'a private account name', re: 'Moon' + 'Yueya', why: 'an account that is not this project' },
  { name: 'a scratch folder of a private checkout', re: '\\.local' + '-(tmp|exe|verify)', why: 'a scratch folder that only exists here' },
  { name: 'a token', re: 'gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----', why: 'a credential' },
  { name: 'the title\'s own file names', re: '\\.(rpf|xvd|xvc|msixvc|xsp)\\b', why: 'a file of the title, which is not shipped here' },
  { name: 'the title by name', re: 'Grand Theft ' + 'Auto|GTA ?' + '(VI|6)\\b|scarlett' + '_master', why: 'a name that belongs to the title\'s owner' },
];

/** Files whose content is checked even when git does not track them yet. */
const EXTRA = ['tools/kira-harness/kira-harness.example.json'];

function tracked(scope) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', scope],
    { cwd: REPO, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function search(pattern, files) {
  if (!files.length) return [];
  // --untracked: a file that is written but not added yet is exactly what this is for.
  const args = ['grep', '--untracked', '-n', '-I', '-E', '-e', pattern, '--', ...files];
  try {
    const out = execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (e) {
    // git grep exits 1 when nothing matches: that is the good case.
    if (e.status === 1) return [];
    throw e;
  }
}

const scope = all ? '.' : 'tools/kira-harness';
const files = tracked(scope);
const problems = [];
const rows = [];

for (const rule of RULES) {
  const hits = search(rule.re, files).map((line) => line.replace(/^[^:]+:[0-9]+:/, '').trim());
  rows.push({ rule: rule.name, hits: hits.length, why: rule.why });
  for (const hit of search(rule.re, files)) problems.push(rule.name + ': ' + hit);
}

// The example settings must stay an example: a real one beside it is a path that would be
// committed the moment someone runs \`git add -A\`.
if (!all) {
  const local = join(HERE, 'kira-harness.local.json');
  if (existsSync(local)) problems.push('a real settings file is in the tree: ' + relative(REPO, local));
  const example = join(HERE, 'kira-harness.example.json');
  if (!existsSync(example)) problems.push('the settings example is missing: ' + relative(REPO, example));
  else {
    const text = execFileSync(process.execPath, ['-e',
      'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', example], { encoding: 'utf8' });
    if (!text.includes('PATH/TO/')) problems.push('the settings example no longer shows placeholder paths');
  }
}

const width = Math.max(...rows.map((r) => r.rule.length));
for (const row of rows) {
  console.log((row.hits ? 'HIT  ' : 'ok   ') + row.rule.padEnd(width) + '  ' + row.hits);
}
console.log('');
console.log('checked ' + files.length + ' files under ' + scope + (all ? '' : ' (this folder only)'));

if (problems.length) {
  console.log('');
  for (const p of problems) console.log('  ' + p);
  console.log('');
  console.log(problems.length + ' problem(s)');
  process.exit(1);
}
console.log('nothing to hide');
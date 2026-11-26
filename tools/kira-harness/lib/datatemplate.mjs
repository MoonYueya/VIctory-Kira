// A save folder that has already been through the title's first setup, copied in fresh
// for every run.
//
// Why a copy and not key presses: the first setup is a run of pages (language, narration,
// brightness, finish, the account picker, the legal notices) that a blind schedule has to
// hit on the second, and a schedule that drifts spends the whole run on the account
// picker. A data folder that has been through it starts at the start screen, where the
// keys left to press are one or two.
//
// Two rules: the template is **read only** — its digest is taken before and after the
// copy and the copy fails if it changed — and every run copies again, so a folder a
// previous run wrote into is never reused.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Every file below `root`, with its size. */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else out.push({ path, bytes: st.size });
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A folder's fingerprint: how many files, how many bytes, and one hash over the shape. */
export function digestTree(root) {
  const files = listFiles(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const f of files) {
    bytes += f.bytes;
    hash.update(relative(root, f.path).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(String(f.bytes));
    hash.update('\0');
  }
  return {
    files: files.length,
    bytes,
    digest: hash.digest('hex'),
    paths: files.map((f) => relative(root, f.path).replace(/\\/g, '/')),
  };
}

/**
 * Copy the template into a run's data folder.
 * @param {string} template the read-only template
 * @param {string} into the folder this run is given
 * @param {{fresh?: boolean, log?: Function}} [opts] `fresh` (the default) empties `into` first
 * @returns {{copied: number, bytes: number, template: object, target: object}}
 */
export function copyTemplate(template, into, { fresh = true, log = () => {} } = {}) {
  if (!existsSync(template)) throw new Error('the save template is not there: ' + template);
  const before = digestTree(template);
  if (!before.files) throw new Error('the save template is empty: ' + template);
  if (fresh && existsSync(into)) rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  let copied = 0;
  let bytes = 0;
  for (const f of listFiles(template)) {
    const dst = join(into, relative(template, f.path));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(f.path, dst);
    copied++;
    bytes += f.bytes;
  }
  const after = digestTree(template);
  if (after.digest !== before.digest) {
    throw new Error('the copy changed the template (its digest moved): ' + template);
  }
  const target = digestTree(into);
  log('save data: ' + copied + ' files / ' + (bytes / 1024).toFixed(1) + ' KB copied into this run');
  log('  template ' + before.digest.slice(0, 16) + '… (same before and after), copy ' +
    target.digest.slice(0, 16) + '…');
  return { copied, bytes, template: before, target };
}

/** What a folder has that the template does not, and the other way round. */
export function sameAsTemplate(template, dir) {
  const a = digestTree(template);
  const b = digestTree(dir);
  return {
    same: a.digest === b.digest,
    added: b.paths.filter((p) => !a.paths.includes(p)),
    missing: a.paths.filter((p) => !b.paths.includes(p)),
  };
}

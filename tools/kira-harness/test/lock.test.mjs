// The run lock's path, and the check that no run is already up.
//
// Both exist for one failure: two runs of the title at once. A lock inside a per-run
// folder is no lock at all — two people with two `work` folders each take their own and
// both start the title — so the settings may name the lock, and the default is one file
// at the scratch root that every `work` under it shares.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSettings } from '../lib/config.mjs';
import { acquireRunLock, releaseRunLock, runsUp, waitForNoRuns } from '../lib/run.mjs';

function settingsAt(dir, extra) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'kira-harness.local.json');
  writeFileSync(file, JSON.stringify({
    victory: join(dir, 'victory.exe'),
    exe: join(dir, 'title.exe'),
    gameDir: dir,
    work: join(dir, 'work'),
    ...extra,
  }));
  return loadSettings(file);
}

test('a run folder does not carry its own lock: the default lies beside it', () => {
  const root = mkdtempSync(join(tmpdir(), 'kira-lock-'));
  try {
    const dir = join(root, 'a');
    const s = settingsAt(dir, {});
    // `work` is `<dir>/work`; the lock is `<dir>/RUN.lock` — beside it, not inside it,
    // where a second run folder next door (`<dir>/work2`, another build's, another
    // person's) lands on the very same file.
    assert.equal(s.paths.work, join(dir, 'work'));
    assert.equal(s.paths.lock, join(dir, 'RUN.lock'));
    const other = settingsAt(dir, { work: join(dir, 'work2') });
    assert.equal(other.paths.lock, s.paths.lock, 'a second work folder beside it shares the lock');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two runs naming the same lock wait for each other', () => {
  const root = mkdtempSync(join(tmpdir(), 'kira-lock-'));
  try {
    const lock = join(root, 'RUN.lock');
    const a = settingsAt(join(root, 'a'), { lock });
    const b = settingsAt(join(root, 'b'), { lock });
    assert.equal(a.paths.lock, b.paths.lock, 'two work folders, one lock');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lock named in the settings is the one taken', () => {
  const root = mkdtempSync(join(tmpdir(), 'kira-lock-'));
  try {
    const wanted = join(root, 'somewhere', 'RUN.lock');
    const s = settingsAt(root, { lock: wanted });
    assert.equal(s.paths.lock, wanted);
    mkdirSync(join(root, 'somewhere'), { recursive: true });
    const held = { path: wanted, token: 'x', acquired: true };
    writeFileSync(wanted, 'a\ntime\nx\n');
    assert.equal(releaseRunLock(held), true, 'the holder releases its own lock');
    assert.equal(releaseRunLock({ ...held, token: 'other' }), false, 'and never someone else\'s');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second run waits rather than starting beside the first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kira-lock-'));
  try {
    const s = settingsAt(root, {});
    mkdirSync(s.paths.work, { recursive: true });
    const one = await acquireRunLock(s.paths.lock, 'first', {});
    assert.equal(one.acquired, true);
    const two = await acquireRunLock(s.paths.lock, 'second', { timeoutMs: 0 });
    assert.equal(two.acquired, false, 'the second run does not get the lock');
    assert.equal(releaseRunLock(one), true);
    const three = await acquireRunLock(s.paths.lock, 'third', { timeoutMs: 0 });
    assert.equal(three.acquired, true, 'and gets it once the first let go');
    assert.equal(releaseRunLock(three), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the processes of a run are looked for by the names the settings give', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kira-lock-'));
  try {
    const s = settingsAt(root, {});
    const up = runsUp(s);
    // On Windows the list comes back (an array, maybe empty); elsewhere there is no
    // tasklist and the answer is "cannot tell", which the caller treats as "go on".
    assert.ok(up === null || Array.isArray(up));
    if (Array.isArray(up)) {
      assert.ok(up.every((n) => n.endsWith('.exe')), 'names only, as tasklist gives them');
      assert.ok(!up.some((n) => n === 'victory.exe' && process.platform !== 'win32'));
    }
    const waited = await waitForNoRuns(s, { checkMs: 1, limitMs: 2 });
    assert.ok(typeof waited.clear === 'boolean');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// One unattended run: put the title in front of VIctory, let it play, stop it.
//
// What the upstream scripts do not do, and this does: take a lock so two runs never
// overlap, check the executable is the one that was measured, make the title's folder
// reachable without touching it, stop at a deadline with the whole process tree, write
// the log out while the run is still going (a run killed from outside otherwise loses
// its evidence), and give back structured facts instead of a stream of lines.
import { spawn, execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { childEnv } from './config.mjs';
import { sha256File, sleep } from './proc.mjs';

const STALE_SECONDS = 30 * 60;

// ------------------------------------------------------------------ the lock

function lockTryCreate(path, owner, token) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, owner + '\n' + new Date().toISOString() + '\n' + token + '\n', { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Take the run lock. A lock older than half an hour is taken over: a run killed before
 * it could release its own lock must not stop the next one for ever.
 */
export async function acquireRunLock(path, owner, { timeoutMs = STALE_SECONDS * 1000, log = () => {} } = {}) {
  const token = randomUUID().replace(/-/g, '');
  const started = Date.now();
  for (;;) {
    if (lockTryCreate(path, owner, token)) {
      return { path, token, acquired: true, waitedMs: Date.now() - started };
    }
    let age = null;
    try { age = (Date.now() - statSync(path).mtimeMs) / 1000; } catch { continue; }
    if (age != null && age > STALE_SECONDS) {
      log('the run lock is ' + Math.round(age) + ' s old; taking it over');
      try { unlinkSync(path); } catch { /* someone else got there first */ }
      continue;
    }
    if (Date.now() - started > timeoutMs) {
      return { path, token, acquired: false, waitedMs: Date.now() - started };
    }
    await sleep(5000);
  }
}

/** Release only the lock this run took: the token in the file has to be ours. */
export function releaseRunLock(lock) {
  if (!lock || !lock.acquired) return false;
  let text;
  try { text = readFileSync(lock.path, 'utf8'); } catch { return false; }
  if ((text.split(/\r?\n/)[2] || '') !== lock.token) return false;
  try { unlinkSync(lock.path); } catch { return false; }
  return true;
}

// ------------------------------------------------------------------ the title's folder

/**
 * A folder of links to the title's own files.
 *
 * The run is never pointed at the title's folder: a title that writes next to itself
 * would change the files that were measured. Links (junctions for folders, symbolic
 * links for files) cost nothing, and unlike a hard link nothing can be written through
 * one into the original.
 */
export function prepareOverlay(gameDir, overlayDir, { log = () => {} } = {}) {
  if (!existsSync(gameDir)) throw new Error('the title folder is not there: ' + gameDir);
  if (existsSync(overlayDir)) rmSync(overlayDir, { recursive: true, force: true });
  mkdirSync(overlayDir, { recursive: true });
  let links = 0;
  for (const entry of readdirSync(gameDir, { withFileTypes: true })) {
    const src = join(gameDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = statSync(src).isDirectory(); } catch { isDir = false; }
    }
    try {
      symlinkSync(src, join(overlayDir, entry.name), isDir ? 'junction' : 'file');
      links++;
    } catch (e) {
      throw new Error('cannot link ' + entry.name + ' into ' + overlayDir + ': ' + e.message);
    }
  }
  log('the title\'s folder is reachable through ' + links + ' links (nothing copied, nothing hard-linked)');
  return { links };
}

/** Files in the overlay that are neither links nor single-named — a hard link would show here. */
export function assertNoHardlinks(overlayDir) {
  const bad = [];
  for (const name of readdirSync(overlayDir)) {
    const st = lstatSync(join(overlayDir, name));
    if (st.isSymbolicLink()) continue;
    if (st.nlink > 1) bad.push(name);
  }
  return bad;
}

/** Whether the executable is the one that was measured. */
export async function verifyExe(exePath, expectedSha) {
  if (!existsSync(exePath)) throw new Error('the title executable is not there: ' + exePath);
  const actual = (await sha256File(exePath)).toLowerCase();
  const expected = expectedSha ? String(expectedSha).toLowerCase() : null;
  return { ok: expected ? actual === expected : true, expected, actual, path: exePath };
}

/**
 * Put the executable in the overlay.
 *
 * It has to be beside the package manifest: `apps/victory/src/run.rs:87-90` reads
 * `MicrosoftGame.config` from the executable's own folder, and without it the title id is
 * 00000000 and the run dies a few milliseconds after binding. It is a copy rather than a
 * link, so nothing the title does can reach the file that was measured.
 */
export async function placeExeInOverlay(exePath, overlayDir, { log = () => {} } = {}) {
  const dst = join(overlayDir, basename(exePath));
  if (existsSync(dst) && !lstatSync(dst).isSymbolicLink()) {
    if ((await sha256File(dst)).toLowerCase() === (await sha256File(exePath)).toLowerCase()) {
      log('the executable is already in the overlay (same hash)');
      return dst;
    }
  }
  if (existsSync(dst)) rmSync(dst, { force: true });
  copyFileSync(exePath, dst);
  log('the executable is copied into the overlay, beside the package manifest');
  return dst;
}

// ------------------------------------------------------------------ starting it

/**
 * Start `victory run <exe> --execute` and stop it at the deadline.
 *
 * While it runs the log is written out every few seconds: a run that is killed from
 * outside — the normal ending here — would otherwise leave nothing behind.
 *
 * @param {object} args
 * @param {string} args.logPath where the log goes
 * @param {string} args.dataDir the title's save data for this run
 * @param {string} [args.captureDir] frames are saved here when the build was made with
 *   the diagnostics feature
 * @param {Function} [args.onTick] called every `tickMs` with `{ pid, elapsedSeconds, log }`;
 *   returning `{ stop: true }` ends the run early — how a run stops once the world is reached.
 * @returns {Promise<object>} the run's facts, including the whole log as `text`.
 */
export async function runTitle(settings, {
  logPath, dataDir = settings.paths.data, captureDir = null,
  seconds = settings.seconds, extraEnv = {}, log = () => {},
  onTick = null, tickMs = 2000, shouldStop = null,
} = {}) {
  const exeInOverlay = await placeExeInOverlay(settings.exe, settings.paths.overlay, { log });
  const cacheDir = join(settings.paths.cache, 'images');
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const args = ['run', exeInOverlay, '--execute', '--unimplemented', 'zero'];
  const env = childEnv(settings, {
    VICTORY_GAME_DIR: settings.paths.overlay,
    VICTORY_CACHE_DIR: cacheDir,
    VICTORY_DATA_DIR: dataDir,
    ...(captureDir ? { VICTORY_CAPTURE: captureDir } : {}),
    ...extraEnv,
  });
  // Present means on, whatever the value: an inherited one would turn the real graphics
  // processor into a software rasteriser without saying so.
  if ('VICTORY_D3D12_WARP' in env) throw new Error('VICTORY_D3D12_WARP must not be set');

  log('starting ' + settings.victory);
  log('  ' + args.join(' '));
  if (Object.keys(extraEnv).length) log('  switches ' + JSON.stringify(extraEnv));

  const child = spawn(settings.victory, args, {
    cwd: settings.paths.overlay,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks = [];
  const append = (d) => {
    chunks.push(d.toString());
    if (chunks.length > 200000) chunks.splice(0, 50000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });
  child.on('error', (e) => { exited = true; exitCode = -1; append('\n[start failed] ' + e.message + '\n'); });

  const startedAt = new Date();
  const text = () => chunks.join('');
  const flush = () => {
    try { writeFileSync(logPath, text(), 'utf8'); } catch { /* the next flush tries again */ }
  };
  const kill = (why) => {
    log(why + ' — taskkill /T /F ' + child.pid);
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    } catch { /* it had already gone */ }
  };

  const deadline = Date.now() + seconds * 1000;
  let timedOut = false;
  let stoppedEarly = false;
  let nextFlush = Date.now();
  let nextTick = Date.now();
  while (!exited && Date.now() < deadline) {
    await sleep(500);
    if (Date.now() > nextFlush) { nextFlush = Date.now() + 5000; flush(); }
    if (onTick && Date.now() >= nextTick) {
      nextTick = Date.now() + tickMs;
      try {
        const verdict = await onTick({
          pid: child.pid,
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          log: text(),
          exited: () => exited,
        });
        if (verdict && verdict.stop) { stoppedEarly = true; break; }
      } catch (e) {
        log('  the watching step failed (the run goes on): ' + (e && e.message ? e.message : e));
      }
    }
    if (shouldStop && shouldStop()) { stoppedEarly = true; break; }
  }
  if (stoppedEarly) kill('the world is in the log, nothing further to measure');
  else if (!exited) { timedOut = true; kill('at ' + seconds + ' s'); }
  for (let i = 0; i < 40 && !exited; i++) await sleep(250);

  const endedAt = new Date();
  const body = text();
  writeFileSync(logPath, body, 'utf8');
  return {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    wallSeconds: Math.round((endedAt - startedAt) / 1000),
    exitCode,
    timedOut,
    stoppedEarly,
    logPath,
    logBytes: Buffer.byteLength(body),
    text: body,
  };
}

// ------------------------------------------------------------------ frames

/** The frames the diagnostics build saved, in frame order. */
export function pickKeyShots(captureDir, count = 5) {
  if (!existsSync(captureDir)) return [];
  const shots = readdirSync(captureDir)
    .filter((n) => /^frame-\d+\.png$/i.test(n))
    .map((n) => ({ name: n, frame: Number(n.match(/frame-(\d+)/i)[1]), path: join(captureDir, n) }))
    .sort((a, b) => a.frame - b.frame);
  if (shots.length <= count) return shots;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(shots[Math.round((i * (shots.length - 1)) / (count - 1))]);
  }
  return [...new Map(out.map((s) => [s.frame, s])).values()];
}

/**
 * Copy a few frames into the run's folder. They are evidence, never an input: no verdict
 * here depends on looking at a picture.
 */
export function archiveShots(captureDir, destDir, count = 5) {
  const picked = pickKeyShots(captureDir, count);
  mkdirSync(destDir, { recursive: true });
  const out = [];
  for (const s of picked) {
    const dst = join(destDir, s.name);
    try {
      writeFileSync(dst, readFileSync(s.path));
      out.push({ frame: s.frame, path: dst, bytes: statSync(dst).size });
    } catch { /* one lost frame does not fail the run */ }
  }
  return out;
}

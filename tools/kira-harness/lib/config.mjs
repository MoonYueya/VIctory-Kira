// Settings for the unattended runs, and the rule about where scratch files go.
//
// Nothing here is a fact about the person running it: every path comes from a settings
// file, so the same scripts work on another machine without editing them.
//
// The settings file is `kira-harness.local.json` beside this folder (not committed; see
// .gitignore). `kira-harness.example.json` is the shape to copy.
//
// Paths may be absolute, or start with `~/` (the folder this folder is in), or be
// relative to the folder the settings file is in.
import { existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This folder (`tools/kira-harness`); the file is one level down, in `lib/`. */
export const HARNESS = resolve(HERE, '..');

/** The repository this folder belongs to, worked out from where it sits. */
export const REPO = resolve(HERE, '..', '..', '..');

export const SETTINGS_NAME = 'kira-harness.local.json';
export const EXAMPLE_NAME = 'kira-harness.example.json';

/** The settings, read or with an error that says what to write. */
export function loadSettings(explicit) {
  const path = explicit ? resolve(explicit) : join(HARNESS, SETTINGS_NAME);
  if (!existsSync(path)) {
    throw new Error(
      'no settings at ' + path + '\n' +
      'Copy ' + join(HARNESS, EXAMPLE_NAME) + ' to ' + join(HARNESS, SETTINGS_NAME) +
      ' and fill in your paths.');
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error('cannot read ' + path + ': ' + e.message);
  }
  const base = dirname(path);
  const expand = (p) => {
    if (p == null || p === '') return null;
    const text = String(p).replace(/^~[\\/]/, HERE.replace(/\\/g, '/') + '/');
    return isAbsolute(text) ? resolve(text) : resolve(base, text);
  };
  const need = (key, value) => {
    if (!value) throw new Error('settings: "' + key + '" is missing in ' + path);
    return value;
  };
  const settings = {
    path,
    base,
    /** `victory.exe` of a diagnostics build (scripted keys need that feature). */
    victory: need('victory', expand(raw.victory)),
    /** The title's executable. */
    exe: need('exe', expand(raw.exe)),
    /** Its SHA-256, or null to accept whatever is there. */
    exeSha256: raw.exeSha256 || null,
    /** The title's install folder: the run is given a link farm of it, never the folder itself. */
    gameDir: need('gameDir', expand(raw.gameDir)),
    /** Where runs, links, logs, caches and copied save data go. */
    work: need('work', expand(raw.work)),
    /** A save-data folder that has already been through the title's first setup. */
    dataTemplate: expand(raw.dataTemplate),
    /** How long a run may last, in seconds. */
    seconds: Number(raw.seconds || 180),
    /** Extra key presses to compile into `VICTORY_KEYS`, in seconds after the start. */
    keys: Array.isArray(raw.keys) ? raw.keys : [],
    /** Set no key presses at all. */
    noKeys: raw.noKeys === true,
    /** Stop the run as soon as the log shows a world frame instead of waiting it out. */
    stopOnWorld: raw.stopOnWorld !== false,
  };
  const paths = {
    work: settings.work,
    home: join(settings.work, 'home'),
    temp: join(settings.work, 'temp'),
    runs: join(settings.work, 'runs'),
    overlay: join(settings.work, 'overlay'),
    cache: join(settings.work, 'cache'),
    data: join(settings.work, 'data'),
    lock: join(settings.work, 'RUN.lock'),
  };
  return { ...settings, paths };
}

/** A run's own folder: `<work>/runs/<id>`. */
export function runDir(settings, id) {
  return join(settings.paths.runs, String(id).replace(/[^A-Za-z0-9_.-]/g, '_'));
}

export function ensureDirs(settings) {
  const made = [];
  for (const key of ['work', 'home', 'temp', 'runs', 'overlay', 'cache', 'data']) {
    const dir = settings.paths[key];
    if (!existsSync(dir)) made.push(dir);
    mkdirSync(dir, { recursive: true });
  }
  return made;
}

/**
 * The environment every child process gets.
 *
 * Inherited first, then: the `VICTORY_*` switches are dropped (a build with the
 * diagnostics feature reads `VICTORY_D3D12_WARP` as "present means on", whatever its
 * value, so an inherited one would quietly swap a real graphics processor for a
 * software rasteriser), and the folders that would otherwise land on the system drive
 * are pointed at `work`.
 *
 * `APPDATA` is left alone: tools that keep credentials there (the GitHub CLI) stop
 * working when it moves, and they only read.
 */
export function childEnv(settings, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^VICTORY_/i.test(k)) continue;
    env[k] = v;
  }
  env.HOME = settings.paths.home;
  env.USERPROFILE = settings.paths.home;
  env.TEMP = settings.paths.temp;
  env.TMP = settings.paths.temp;
  env.TMPDIR = settings.paths.temp;
  env.CARGO_TERM_COLOR = 'never';
  env.RUST_BACKTRACE = '1';
  return { ...env, ...extra };
}

/** Free bytes where `dir` is, or null when the volume cannot be asked. */
export function freeBytes(dir) {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export function gb(bytes) {
  return bytes == null ? null : Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/**
 * Stop before writing anything large when the volume is nearly full: a run that fills
 * the disk takes the whole machine with it, and the log that would explain it is the
 * thing that cannot be written.
 */
export function assertDiskSpace(settings, { floorGb = 15, where = 'start' } = {}) {
  const free = freeBytes(settings.work);
  if (free == null) return { free: null, gb: null, ok: true };
  if (free < floorGb * 1024 ** 3) {
    throw new Error('only ' + gb(free) + ' GB free at ' + settings.work + ' (floor ' + floorGb +
      ' GB, ' + where + '): stopping before anything large is written');
  }
  return { free, gb: gb(free), ok: true };
}
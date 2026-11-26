// What a run's log says. Pure functions: no files are read, so the rules below can be
// checked against a written-down log in a test.
//
// The one rule that matters — is the title in the world? — is "a frame line with fewer
// than 5 frames a second". That line is printed by `crates/victory-gpu/src/host.rs:8717`
// once a second and needs no screenshot: a menu holds 30-60, the world falls to a few.
// `draws/frame` on the same line is reported and **not** used to decide: a world scene
// that only draws ten times a frame is slow, not absent.

const FPS_RE = /(\d+\.\d+) fps, (\d+\.\d+) ms\/frame \(([\d.]+) preparing: copies ([\d.]+) ms ([\d.]+) MB, textures ([\d.]+) ms ([\d.]+) MB; ([\d.]+) on the GPU; ([\d.]+) copying back ([\d.]+) MB\), (\d+) draws\/frame, dropped (\d+) without a host pipeline \((\d+) being made\) and (\d+) indirect/;
const PRESENT_RE = /frame presented[^]*?\bframe=(\d+) draws=(\d+) drawn=(\d+) dispatches=(\d+) dispatched=(\d+)/;
const SAVED_RE = /frame saved path=(.+)$/;
const NOTRANS_RE = /shader does not translate; its pipelines' draws are dropped stage=(\S+) hash=(\S+) error=(.*)$/;
const SLOW_RE = /slow host submission ms=(\d+) lists=(\d+)/;
const PACKAGE_RE = /file opened path="([^"]+)"/;
/** Below this many frames a second, the title is drawing a scene rather than a menu. */
export const WORLD_FPS = 5;

/** A world frame that draws at least this often is a rendered scene, not a loading screen. */
export const RENDER_DRAWS = 100;

const CRASH_PATTERNS = [
  ['device removed', /device removed/i],
  ['0x887a0005', /0x887a0005/i],
  ['TDR', /\bTDR\b/],
  ['GPU hang', /GPU hang/i],
  ['panic', /\bpanicked at\b|\bpanic:/i],
  ['access violation', /access violation/i],
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function median(list) {
  if (!list.length) return null;
  const sorted = list.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(v, places = 1) {
  if (v == null) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function maxOf(list) { return list.length ? Math.max(...list) : null; }
function minOf(list) { return list.length ? Math.min(...list) : null; }

/** An error message with its addresses taken out, so "the same gap at another offset" groups. */
export function normalizeError(message) {
  return String(message || '').replace(/0x[0-9a-fA-F]+/g, '0x?').replace(/\s+/g, ' ').trim();
}

/**
 * Read a whole log.
 * @param {string} text the log, ANSI colours and all
 * @returns {object} the counts and the world verdict
 */
export function parseLog(text) {
  const lines = String(text || '').split(/\r?\n/);

  const frames = [];
  const presents = [];
  const saved = [];
  const notTranslated = [];
  const slow = [];
  const packages = new Set();
  let indirectPrepareFailed = 0;
  let translated = 0;
  const crashes = new Map(CRASH_PATTERNS.map(([name]) => [name, 0]));

  for (const raw of lines) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    if (!line) continue;

    if (line.includes(' fps, ') && line.includes('ms/frame')) {
      const m = line.match(FPS_RE);
      if (m) {
        frames.push({
          fps: num(m[1]), ms: num(m[2]),
          prepareMs: num(m[3]), copyMs: num(m[4]), copyMB: num(m[5]),
          textureMs: num(m[6]), textureMB: num(m[7]),
          gpuMs: num(m[8]), backMs: num(m[9]), backMB: num(m[10]),
          draws: num(m[11]), dropped: num(m[12]), beingMade: num(m[13]), indirect: num(m[14]),
        });
      }
      continue;
    }

    if (line.includes('frame presented')) {
      const m = line.match(PRESENT_RE);
      if (m) {
        presents.push({
          frame: num(m[1]), draws: num(m[2]), drawn: num(m[3]),
          dispatches: num(m[4]), dispatched: num(m[5]),
        });
      }
      continue;
    }

    if (line.includes('frame saved path=')) {
      const m = line.match(SAVED_RE);
      if (m) saved.push(m[1].trim());
      continue;
    }

    if (line.includes('does not translate')) {
      const m = line.match(NOTRANS_RE);
      if (m) {
        notTranslated.push({
          stage: m[1].replace(/^"|"$/g, ''), hash: m[2], error: m[3], errorKey: normalizeError(m[3]),
        });
      }
      continue;
    }

    if (line.includes('slow host submission')) {
      const m = line.match(SLOW_RE);
      if (m) slow.push({ ms: num(m[1]), lists: num(m[2]) });
      continue;
    }

    if (line.includes('file opened path=')) {
      const m = line.match(PACKAGE_RE);
      if (m) packages.add(m[1]);
    }

    if (/indirect kind \d+: prepare failed/.test(line)) indirectPrepareFailed++;
    if (line.includes('shader translated')) translated++;

    for (const [name, re] of CRASH_PATTERNS) {
      if (re.test(line)) crashes.set(name, crashes.get(name) + 1);
    }
  }

  // ---- world, and everything else ----
  const world = frames.filter((f) => f.fps != null && f.fps < WORLD_FPS);
  const menu = frames.filter((f) => f.fps != null && f.fps >= WORLD_FPS);
  const values = (rows, key) => rows.map((r) => r[key]).filter((v) => v != null);
  // A world frame that draws little is a loading screen inside the world section; the
  // two are a factor of ten apart, so the split is not delicate. Reported, not decided on.
  const renderRows = world.filter((r) => (r.draws || 0) >= RENDER_DRAWS);
  const droppingRows = world.filter((r) => (r.dropped || 0) > 0);

  const byStage = {};
  for (const r of notTranslated) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  // Grouped by the address-free form: the same gap reported at two offsets is one gap.
  const errorTally = new Map();
  for (const r of notTranslated) {
    const cur = errorTally.get(r.errorKey) || { count: 0, error: r.error, stages: new Set(), hashes: [] };
    cur.count++;
    cur.stages.add(r.stage);
    if (cur.hashes.length < 3 && !cur.hashes.includes(r.hash)) cur.hashes.push(r.hash);
    errorTally.set(r.errorKey, cur);
  }
  const topErrors = [...errorTally.entries()]
    .map(([key, v]) => ({ key, error: v.error, count: v.count, stages: [...v.stages].sort(), hashes: v.hashes }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const crashCounts = Object.fromEntries(crashes);
  const deviceRemoved = (crashCounts['device removed'] || 0) + (crashCounts['0x887a0005'] || 0)
    + (crashCounts['TDR'] || 0) + (crashCounts['GPU hang'] || 0);
  return {
    lineCount: lines.length,
    presents: {
      count: presents.length,
      maxFrame: presents.length ? maxOf(presents.map((p) => p.frame)) : null,
      last: presents.length ? presents[presents.length - 1] : null,
      totalDrawn: presents.length ? presents[presents.length - 1].drawn : 0,
      totalDispatched: presents.length ? presents[presents.length - 1].dispatched : 0,
      framesSaved: saved.length,
    },
    fps: {
      samples: frames.length,
      worldSamples: world.length,
      menuSamples: menu.length,
      menuBestFps: round(maxOf(values(menu, 'fps'))),
      menuBestMs: round(minOf(values(menu, 'ms'))),
      worldWorstFps: round(minOf(values(world, 'fps'))),
      worldWorstMs: round(maxOf(values(world, 'ms'))),
      worldBestFps: round(maxOf(values(world, 'fps'))),
      worldMedianMs: round(median(values(world, 'ms'))),
      worldPreparePeakMs: round(maxOf(values(world, 'prepareMs'))),
      worldGpuPeakMs: round(maxOf(values(world, 'gpuMs'))),
      /** The verdict: a frame line below {@link WORLD_FPS} existed. */
      enteredWorld: world.length > 0,
      /** World frames that draw less than {@link RENDER_DRAWS}: reported, never decisive. */
      slowButLowDrawRows: world.length - renderRows.length,
    },
    worldDrops: {
      rowsWithDrops: droppingRows.length,
      droppedPeak: maxOf(values(world, 'dropped')),
      droppedMedianDropping: round(median(values(droppingRows, 'dropped'))),
      indirectPeak: maxOf(values(world, 'indirect')),
      indirectMin: minOf(values(world, 'indirect')),
      indirectMedianDropping: round(median(values(droppingRows, 'indirect'))),
      indirectPrepareFailed,
      renderRows: renderRows.length,
      renderDrawsMedian: round(median(values(renderRows, 'draws'))),
      renderDrawsPeak: maxOf(values(renderRows, 'draws')),
      renderDroppedMedian: round(median(values(renderRows, 'dropped'))),
      renderDroppedPeak: maxOf(values(renderRows, 'dropped')),
      renderIndirectMedian: round(median(values(renderRows, 'indirect'))),
      renderWorstMs: round(maxOf(values(renderRows, 'ms'))),
      menuDroppedTotal: menu.reduce((a, r) => a + (r.dropped || 0), 0),
    },
    shaders: {
      notTranslated: notTranslated.length,
      translated,
      byStage,
      distinctErrors: errorTally.size,
      topErrors,
    },
    gpu: {
      slowSubmissions: slow.length,
      slowestMs: maxOf(slow.map((s) => s.ms)),
      deviceRemoved,
      crashes: crashCounts,
    },
    packages: [...packages].sort(),
  };
}

/** Seconds from the first log line to the first presented frame, when the lines are stamped. */
export function timeToFirstFrame(text) {
  const stamp = (line) => {
    const m = String(line).match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
    return m ? Date.parse(m[1]) : null;
  };
  let first = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = stamp(line);
    if (at == null) continue;
    if (first == null) first = at;
    if (line.includes('frame presented')) return round((at - first) / 1000, 2);
  }
  return null;
}

/** Whether the log already shows the world: the cheap check a running run is stopped by. */
export function reachedWorld(text) {
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.includes(' fps, ') || !raw.includes('ms/frame')) continue;
    const m = raw.match(FPS_RE);
    if (m && num(m[1]) != null && num(m[1]) < WORLD_FPS) return true;
  }
  return false;
}
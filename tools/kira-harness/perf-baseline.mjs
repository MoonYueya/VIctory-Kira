#!/usr/bin/env node
// Baseline table from a run's log.
//
//   node tools/kira-harness/perf-baseline.mjs --log <run.log> [--json <out.json>]
//
// Every number below is read off lines VIctory already prints, once a second:
// the frame line (crates/victory-gpu/src/host.rs, "fps, ... ms/frame"), the
// card's clock line beside it ("the card's clock per frame"), the submitter
// lines in copystat.rs ("submitted Nx/frame"), the memory line and the
// optional category line (VICTORY_MEMORY_CATEGORIES, copystat.rs). Nothing is
// estimated and nothing is decided here: a number that was not printed is null.
//
// The world section is "a frame line under 5 frames a second", the same rule
// the rest of the harness uses. Rows are bucketed by draws/frame, because the
// runs reach different depths and that is what a world frame costs.
import { readFileSync, writeFileSync } from 'node:fs';

const WORLD_FPS = 5;
const BUCKETS = [
  ['under 500', (d) => d < 500],
  ['500-1500', (d) => d >= 500 && d < 1500],
  ['1500-3000', (d) => d >= 1500 && d < 3000],
  ['3000 and up', (d) => d >= 3000],
];

function usage(why) {
  if (why) console.error(why);
  console.error('usage: node perf-baseline.mjs --log <run.log> [--json <out.json>]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let logPath = null;
let jsonPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--log') logPath = argv[++i];
  else if (argv[i] === '--json') jsonPath = argv[++i];
  else usage('unknown argument: ' + argv[i]);
}
if (!logPath) usage('--log is required');

const strip = (l) => l.replace(/\u001b\[[0-9;]*m/g, '');
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const nums = (text) => (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

function stats(list) {
  const v = list.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null, median: null, p90: null, max: null };
  const s = v.slice().sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const p90 = s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const r = (x) => (x == null ? null : Math.round(x * 100) / 100);
  return { n: v.length, mean: r(mean), median: r(median), p90: r(p90), max: r(s[s.length - 1]) };
}

// ---------------------------------------------------------------- the lines
const FRAME = /([\d.]+) fps, ([\d.]+) ms\/frame \(([\d.]+) preparing: copies ([\d.]+) ms ([\d.]+) MB, textures ([\d.]+) ms ([\d.]+) MB; ([\d.]+) on the GPU; ([\d.]+) copying back ([\d.]+) MB\), (\d+) draws\/frame, dropped (\d+) without a host pipeline \((\d+) being made\) and (\d+) indirect/;
const CLOCK = /nothing of ours queued ([\d.]+) ms \(the card about (\d+)% busy by this count\), ([\d.]+) ms of that while the submitting thread was working \(the card idle behind us\), the rest while the title had not submitted; the submitting thread stood waiting for the card ([\d.]+) ms/;
const SUBMIT = /submitted ([\d.]+)x\/frame: between its submissions ([\d.-]+) ms \(running ([\d.]+) ms user \+ ([\d.]+) ms kernel; ([\d.]+) ms in list calls\), in them running ([\d.]+) ms user \+ ([\d.]+) ms kernel, ([\d.]+) ms waiting for the submission lock/;
const RECORD = /recording per frame \((\d+) frames\): (\d+) list calls ([\d.]+) ms \(all recording threads\); ([\d.]+) ms waiting for pipelines; dynamic slots: (\d+) tables asked, (\d+) refused, ([\d.]+) ms searching/;
const VIDEOMEM = /the card's own: budget (\d+) MB, in use (\d+) MB, (\d+) MB could still be reserved, (\d+) MB reserved; the PC's shared with the card: budget (\d+) MB, in use (\d+) MB/;
const PROC = /process: private ([\d,]+) MB, working set ([\d,]+) MB|private ([\d,]+) MB of ([\d,]+) MB/;
const QUEUE = /textures picked by index: (\d+) uploaded so far \((\d+) MB\), (\d+) waiting, (\d+) passed over unmapped/;
const CATS = /memory by category \(VICTORY_MEMORY_CATEGORIES=1, approximate and overlapping, not a sum\): (.+)$/;
// The VRAM ledger (crates/victory-gpu/src/vram.rs, VICTORY_VRAM_LEDGER=1): one line,
// "name 123 MB/45" per class, the account and the unaccounted rest.
const LEDGER = /vram ledger \(VICTORY_VRAM_LEDGER=1\), live, MB\/things: (.+)$/;

// ---------------------------------------------------------------- reading
const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
const frames = [];
const clocks = [];
const submits = [];
const records = [];
const videomem = [];
const cats = [];
const ledgers = [];
let notTranslated = 0;
let translated = 0;
let deviceRemoved = 0;
let pipelineMade = 0;
let pipelineLoaded = 0;
let lines_ = 0;

for (const raw of lines) {
  const line = strip(raw);
  if (!line.trim()) continue;
  lines_++;
  if (line.includes('ms/frame')) {
    const m = FRAME.exec(line);
    if (m) {
      frames.push({
        at: line.slice(0, 27).trim(), fps: num(m[1]), ms: num(m[2]),
        prepareMs: num(m[3]), copyMs: num(m[4]), copyMB: num(m[5]),
        textureMs: num(m[6]), textureMB: num(m[7]), gpuMs: num(m[8]),
        backMs: num(m[9]), backMB: num(m[10]), draws: num(m[11]),
        dropped: num(m[12]), beingMade: num(m[13]), indirect: num(m[14]),
      });
      const q = QUEUE.exec(line);
      if (q) Object.assign(frames[frames.length - 1], {
        uploaded: num(q[1]), uploadedMB: num(q[2]), waiting: num(q[3]), away: num(q[4]),
      });
      continue;
    }
  }
  if (line.includes("card's clock per frame")) {
    const m = CLOCK.exec(line);
    if (m) clocks.push({ at: line.slice(0, 27).trim(), idleMs: num(m[1]), busyPct: num(m[2]), idleBehindMs: num(m[3]), stoodMs: num(m[4]) });
    continue;
  }
  if (line.includes('x/frame: between its submissions')) {
    const m = SUBMIT.exec(line);
    if (m) submits.push({
      at: line.slice(0, 24).trim(), perFrame: num(m[1]), betweenMs: num(m[2]),
      userMs: num(m[3]), kernelMs: num(m[4]), listMs: num(m[5]),
      inUserMs: num(m[6]), inKernelMs: num(m[7]), lockMs: num(m[8]),
    });
    continue;
  }
  if (line.includes('recording per frame (')) {
    const m = RECORD.exec(line);
    if (m) records.push({
      at: line.slice(0, 24).trim(), frames: num(m[1]), listCalls: num(m[2]), listMs: num(m[3]),
      pipelineWaitMs: num(m[4]), tablesAsked: num(m[5]), tablesRefused: num(m[6]), searchMs: num(m[7]),
    });
    continue;
  }
  if (line.includes('with the memory line')) {
    const m = VIDEOMEM.exec(line);
    if (m) videomem.push({
      at: line.slice(0, 24).trim(), localBudgetMB: num(m[1]), localUsedMB: num(m[2]),
      sharedBudgetMB: num(m[5]), sharedUsedMB: num(m[6]),
    });
    continue;
  }
  if (line.includes('vram ledger')) {
    const m = LEDGER.exec(line);
    if (m) {
      const fields = {};
      for (const part of m[1].split('; ')) {
        const mm = /^(.+?) (-?[\d.]+) MB\/(\d+)$/.exec(part.trim());
        if (mm) fields[mm[1].trim()] = { mb: Number(mm[2]), count: Number(mm[3]) };
      }
      ledgers.push({ at: line.slice(0, 24).trim(), fields });
    }
    continue;
  }
  if (line.includes('memory by category')) {
    const m = CATS.exec(line);
    if (m) {
      const fields = {};
      for (const part of m[1].split(', ')) {
        const mm = /^(.+) (-?\d+(?:\.\d+)?) MB$/.exec(part.trim());
        if (mm) fields[mm[1]] = Number(mm[2]);
      }
      cats.push({ at: line.slice(0, 24).trim(), fields });
    }
    continue;
  }
  if (line.includes('does not translate')) notTranslated++;
  if (line.includes('shader translated')) translated++;
  if (/device removed/i.test(line) || /0x887a0005/i.test(line)) deviceRemoved++;
  const lib = /host pipeline library saved bytes=(\d+) early=(\d+) made=(\d+) loaded=(\d+)/.exec(line);
  if (lib) { pipelineMade += Number(lib[3]); pipelineLoaded += Number(lib[4]); }
}

// ---------------------------------------------------------------- the world
const world = frames.filter((f) => f.fps != null && f.fps < WORLD_FPS);
// The clock line is printed once a second as well; keep the ones inside the
// world section by time, because it carries no draws count of its own.
const worldFrom = world.length ? world[0].at : null;
const inWorld = (row) => (worldFrom == null ? false : row.at >= worldFrom);
const worldClocks = clocks.filter(inWorld);
const worldSubmits = submits.filter(inWorld);
const worldRecords = records.filter(inWorld);
const worldVideo = videomem.filter(inWorld);
const worldCats = cats.filter(inWorld);
const worldLedgers = ledgers.filter(inWorld);

// The frame line covers the seconds since the previous one, and the card's clock
// line is printed once a second: a frame line is paired with the average of the
// clock lines inside its own window, which is the same stretch of time.
const clockWindows = new Map();
{
  let since = [];
  const byAt = new Map();
  for (const raw of lines) {
    const line = strip(raw);
    const at = line.slice(0, 27).trim();
    if (line.includes("card's clock per frame")) {
      const m = CLOCK.exec(line);
      if (m) since.push({ idleMs: num(m[1]), busyPct: num(m[2]), idleBehindMs: num(m[3]), stoodMs: num(m[4]) });
      continue;
    }
    if (line.includes('ms/frame') && FRAME.test(line)) {
      byAt.set(at, since);
      since = [];
    }
  }
  const mean = (rows, k) => (rows.length ? rows.reduce((a, b) => a + b[k], 0) / rows.length : null);
  for (const [at, rows] of byAt) {
    clockWindows.set(at, {
      idleMs: mean(rows, 'idleMs'), busyPct: mean(rows, 'busyPct'),
      idleBehindMs: mean(rows, 'idleBehindMs'), stoodMs: mean(rows, 'stoodMs'),
    });
  }
}
const worldPairs = world.map((f) => ({ frame: f, clock: clockWindows.get(f.at) || null }));

function bucketTable(rows, pick) {
  const table = {};
  for (const [name, test] of BUCKETS) {
    const sel = rows.filter((r) => r.frame.draws != null && test(r.frame.draws));
    table[name] = pick(sel);
  }
  return table;
}

const perBucket = bucketTable(worldPairs, (sel) => ({
  frames: stats(sel.map((r) => r.frame.ms)),
  prepare: stats(sel.map((r) => r.frame.prepareMs)),
  copy: stats(sel.map((r) => r.frame.copyMs)),
  texture: stats(sel.map((r) => r.frame.textureMs)),
  gpu: stats(sel.map((r) => r.frame.gpuMs)),
  back: stats(sel.map((r) => r.frame.backMs)),
  copyMB: stats(sel.map((r) => r.frame.copyMB)),
  textureMB: stats(sel.map((r) => r.frame.textureMB)),
  idle: stats(sel.map((r) => (r.clock ? r.clock.idleMs : null))),
  busyPct: stats(sel.map((r) => (r.clock ? r.clock.busyPct : null))),
  idleBehind: stats(sel.map((r) => (r.clock ? r.clock.idleBehindMs : null))),
  stood: stats(sel.map((r) => (r.clock ? r.clock.stoodMs : null))),
  draws: stats(sel.map((r) => r.frame.draws)),
  dropped: stats(sel.map((r) => r.frame.dropped)),
  indirect: stats(sel.map((r) => r.frame.indirect)),
  waiting: stats(sel.map((r) => r.frame.waiting)),
  away: stats(sel.map((r) => r.frame.away)),
}));

const report = {
  log: logPath,
  lines: lines_,
  seconds: frames.length,
  world: {
    frames: world.length,
    from: worldFrom,
    to: world.length ? world[world.length - 1].at : null,
    ms: stats(world.map((f) => f.ms)),
    fps: stats(world.map((f) => f.fps)),
    all: {
      prepare: stats(world.map((f) => f.prepareMs)),
      copy: stats(world.map((f) => f.copyMs)),
      texture: stats(world.map((f) => f.textureMs)),
      gpu: stats(world.map((f) => f.gpuMs)),
      back: stats(world.map((f) => f.backMs)),
      copyMB: stats(world.map((f) => f.copyMB)),
      textureMB: stats(world.map((f) => f.textureMB)),
      draws: stats(world.map((f) => f.draws)),
      dropped: stats(world.map((f) => f.dropped)),
      beingMade: stats(world.map((f) => f.beingMade)),
      indirect: stats(world.map((f) => f.indirect)),
      uploaded: stats(world.map((f) => f.uploaded)),
      uploadedMB: stats(world.map((f) => f.uploadedMB)),
      waiting: stats(world.map((f) => f.waiting)),
      away: stats(world.map((f) => f.away)),
      idle: stats(worldClocks.map((c) => c.idleMs)),
      busyPct: stats(worldClocks.map((c) => c.busyPct)),
      idleBehind: stats(worldClocks.map((c) => c.idleBehindMs)),
      stood: stats(worldClocks.map((c) => c.stoodMs)),
    },
    clocks: worldClocks.length,
    submits: {
      rows: worldSubmits.length,
      perFrame: stats(worldSubmits.map((s) => s.perFrame)),
      between: stats(worldSubmits.map((s) => s.betweenMs)),
      user: stats(worldSubmits.map((s) => s.userMs)),
      kernel: stats(worldSubmits.map((s) => s.kernelMs)),
      list: stats(worldSubmits.map((s) => s.listMs)),
      inUser: stats(worldSubmits.map((s) => s.inUserMs)),
      inKernel: stats(worldSubmits.map((s) => s.inKernelMs)),
      lock: stats(worldSubmits.map((s) => s.lockMs)),
    },
    recording: {
      rows: worldRecords.length,
      listCalls: stats(worldRecords.map((r) => r.listCalls)),
      listMs: stats(worldRecords.map((r) => r.listMs)),
      pipelineWaitMs: stats(worldRecords.map((r) => r.pipelineWaitMs)),
      tablesAsked: stats(worldRecords.map((r) => r.tablesAsked)),
      tablesRefused: stats(worldRecords.map((r) => r.tablesRefused)),
      searchMs: stats(worldRecords.map((r) => r.searchMs)),
    },
    vram: {
      rows: worldVideo.length,
      budgetMB: stats(worldVideo.map((v) => v.localBudgetMB)),
      usedMB: stats(worldVideo.map((v) => v.localUsedMB)),
      sharedBudgetMB: stats(worldVideo.map((v) => v.sharedBudgetMB)),
      sharedUsedMB: stats(worldVideo.map((v) => v.sharedUsedMB)),
    },
    buckets: perBucket,
  },
  vram: {
    rows: worldLedgers.length,
    // Every class the ledger prints, median and peak over the world section.
    classes: (() => {
      const names = new Map();
      for (const row of worldLedgers) {
        for (const [k, v] of Object.entries(row.fields)) {
          if (!names.has(k)) names.set(k, []);
          names.get(k).push(v.mb);
        }
      }
      return Object.fromEntries([...names].map(([k, list]) => [k, stats(list)]));
    })(),
    first: worldLedgers.length ? worldLedgers[0].fields : null,
    last: worldLedgers.length ? worldLedgers[worldLedgers.length - 1].fields : null,
  },
  memory: {
    rows: cats.length,
    last: cats.length ? cats[cats.length - 1].fields : null,
    first: cats.length ? cats[0].fields : null,
  },
  shaders: { translated, notTranslated },
  pipelineLibrary: { made: pipelineMade, loaded: pipelineLoaded },
  faults: { deviceRemoved },
};

const r = (x) => (x == null ? '—' : x);
const line = (name, s) => '| ' + name + ' | ' + r(s.mean) + ' | ' + r(s.median) + ' | ' + r(s.p90) + ' | ' + s.n + ' |';

const out = [];
out.push('## World section: ' + world.length + ' frame lines, ' + r(worldFrom) + ' to ' + r(world.length ? world[world.length - 1].at : null));
out.push('');
out.push('| metric (ms unless said) | mean | median | P90 | n |');
out.push('|---|---|---|---|---|');
for (const [k, s] of Object.entries(report.world.all)) out.push(line(k, s));
out.push('');
out.push('### By draws per frame (the same metric, bucketed)');
for (const [name] of BUCKETS) {
  const b = report.world.buckets[name];
  out.push('');
  out.push('**' + name + '** — ' + b.frames.n + ' frames');
  out.push('');
  out.push('| metric | mean | median | P90 | n |');
  out.push('|---|---|---|---|---|');
  for (const [k, s] of Object.entries(b)) {
    if (k === 'frames') continue;
    out.push(line(k, s));
  }
}
out.push('');
out.push('### Recording and submission');
out.push('');
out.push('| metric | mean | median | P90 | n |');
out.push('|---|---|---|---|---|');
for (const [k, s] of Object.entries(report.world.submits)) { if (k !== 'rows') out.push(line('submit ' + k, s)); }
for (const [k, s] of Object.entries(report.world.recording)) { if (k !== 'rows') out.push(line('record ' + k, s)); }
for (const [k, s] of Object.entries(report.world.vram)) { if (k !== 'rows') out.push(line('vram ' + k, s)); }
out.push('');
out.push('### Shaders, pipelines, faults');
out.push('');
out.push('- shaders translated ' + translated + ', not translated ' + notTranslated);
out.push('- pipeline library made ' + pipelineMade + ', loaded ' + pipelineLoaded);
out.push('- device removals ' + deviceRemoved);
if (report.vram.rows) {
  out.push('');
  out.push('### VRAM ledger, world section (' + report.vram.rows + ' lines, ' +
    (report.vram.classes['in use, as the system counts it'] || {}).n + ' with the system\'s own count)');
  out.push('');
  out.push('| what holds it | median MB | peak MB | n |');
  out.push('|---|---|---|---|');
  for (const [k, s] of Object.entries(report.vram.classes)) out.push('| ' + k + ' | ' + r(s.median) + ' | ' + r(s.max) + ' | ' + s.n + ' |');
}
if (report.memory.last) {
  out.push('');
  out.push('### Memory by category, last line in the world section');
  out.push('');
  for (const [k, v] of Object.entries(report.memory.last)) out.push('- ' + k + ': ' + v + ' MB');
}

const text = out.join('\n');
console.log(text);
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

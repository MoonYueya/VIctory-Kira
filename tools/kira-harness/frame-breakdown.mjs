#!/usr/bin/env node
// Where a frame's wall clock goes, from a run's log: a table per thread and stage.
//
//   node tools/kira-harness/frame-breakdown.mjs --log <run.log> [--json <out.json>] [--cpuprof <file>]
//
// Every number is read off lines VIctory already prints, plus the two the CPU
// profiler writes (`VICTORY_CPUPROF`, crates/victory-loader/src/cpuprof.rs):
// nothing is estimated, and a number that was not printed is null.
//
// The frame line (host.rs) gives ms/frame and what of it was preparing, copying
// back and on the GPU. It does NOT split the preparing between threads, and it
// says nothing about the stretch before the first list call — the title's own
// thinking time. Three lines fill that in:
//
//   frame account per frame  (copystat.rs)  present -> first list call -> first
//       submission -> present: the frame's own chain, plus the process's user
//       and kernel time on every thread;
//   the card's clock per frame (host.rs)    idle behind us, idle while the
//       title had not submitted, and how long the submitting thread stood;
//   recording per frame (copystat.rs)       list calls, their total time, and
//       the wait for pipelines.
//
// The unaccounted rest is what is left after those, and it is reported as it is
// rather than spread over the stages.
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
  console.error('usage: node frame-breakdown.mjs --log <run.log> [--json <out>] [--cpuprof <file>]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let logPath = null;
let jsonPath = null;
let cpuprofPath = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--log') logPath = argv[++i];
  else if (a === '--json') jsonPath = argv[++i];
  else if (a === '--cpuprof') cpuprofPath = argv[++i];
  else usage('unknown argument: ' + a);
}
if (!logPath) usage('--log is required');

const strip = (l) => l.replace(/\u001b\[[0-9;]*m/g, '');
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function stats(list) {
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
const FRAME = /([\d.]+) fps, ([\d.]+) ms\/frame \(([\d.]+) preparing: copies ([\d.]+) ms ([\d.]+) MB, textures ([\d.]+) ms ([\d.]+) MB; ([\d.]+) on the GPU; ([\d.]+) copying back ([\d.]+) MB\), (\d+) draws\/frame/;
const CLOCK = /nothing of ours queued ([\d.]+) ms \(the card about (\d+)% busy by this count\), ([\d.]+) ms of that while the submitting thread was working \(the card idle behind us\), the rest while the title had not submitted; the submitting thread stood waiting for the card ([\d.]+) ms/;
const ACCOUNT = /after a present ([\d.]+) ms until the first list call and ([\d.]+) ms until the first submission; ([\d.]+) ms from the last submission to the present call; lists reset in ([\d.]+) ms; the process ran (\d+) ms user \+ (\d+) ms kernel on all threads/;
const RECORD = /recording per frame \((\d+) frames\): (\d+) list calls ([\d.]+) ms \(all recording threads\); ([\d.]+) ms waiting for pipelines/;
const SUBMIT = /submitted ([\d.]+)x\/frame: between its submissions ([\d.-]+) ms \(running ([\d.]+) ms user \+ ([\d.]+) ms kernel; ([\d.]+) ms in list calls\), in them running ([\d.]+) ms user \+ ([\d.]+) ms kernel, ([\d.]+) ms waiting for the submission lock/;
const PROC = /process: private ([\d,]+) MB, working set ([\d,]+) MB|private ([\d,]+) MB of ([\d,]+) MB/;

const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
const frames = [];
const clocks = [];
const accounts = [];
const records = [];
const submits = [];
for (const raw of lines) {
  const line = strip(raw);
  if (!line.trim()) continue;
  const at = line.slice(0, 27).trim();
  if (line.includes('ms/frame') && FRAME.test(line)) {
    const m = FRAME.exec(line);
    frames.push({
      at, fps: num(m[1]), ms: num(m[2]), prepareMs: num(m[3]), copyMs: num(m[4]),
      copyMB: num(m[5]), textureMs: num(m[6]), textureMB: num(m[7]), gpuMs: num(m[8]),
      backMs: num(m[9]), backMB: num(m[10]), draws: num(m[11]),
    });
    continue;
  }
  if (line.includes("card's clock per frame")) {
    const m = CLOCK.exec(line);
    if (m) clocks.push({ at, idleMs: num(m[1]), busyPct: num(m[2]), idleBehindMs: num(m[3]), stoodMs: num(m[4]) });
    continue;
  }
  if (line.includes('frame account per frame')) {
    const m = ACCOUNT.exec(line);
    if (m) accounts.push({
      at, untilListMs: num(m[1]), untilSubmitMs: num(m[2]), tailMs: num(m[3]),
      resetMs: num(m[4]), userMs: num(m[5]), kernelMs: num(m[6]),
    });
    continue;
  }
  if (line.includes('recording per frame (')) {
    const m = RECORD.exec(line);
    if (m) records.push({
      at, frames: num(m[1]), listCalls: num(m[2]), listMs: num(m[3]), pipelineWaitMs: num(m[4]),
    });
    continue;
  }
  if (line.includes('x/frame: between its submissions')) {
    const m = SUBMIT.exec(line);
    if (m) submits.push({
      at, perFrame: num(m[1]), betweenMs: num(m[2]), userMs: num(m[3]), kernelMs: num(m[4]),
      listMs: num(m[5]), inUserMs: num(m[6]), inKernelMs: num(m[7]), lockMs: num(m[8]),
    });
    continue;
  }
}

// The clock and the account are printed inside the second a frame line covers:
// a frame is paired with the mean of those rows since the frame line before.
function windows(rows) {
  const out = new Map();
  let since = [];
  for (const raw of lines) {
    const line = strip(raw);
    const at = line.slice(0, 27).trim();
    const seen = rows.find((r) => r.at === at && !out.has(at));
    if (seen) { since.push(seen); continue; }
    if (line.includes('ms/frame') && FRAME.test(line)) {
      out.set(at, since);
      since = [];
    }
  }
  return out;
}
const meanOf = (rows, k) => (rows.length ? rows.reduce((a, b) => a + (b[k] ?? 0), 0) / rows.length : null);
const clockWin = windows(clocks);
const accountWin = windows(accounts);

// ---------------------------------------------------------------- the world
const world = frames.filter((f) => f.fps != null && f.fps < WORLD_FPS);
const worldFrom = world.length ? world[0].at : null;
const inWorld = (row) => worldFrom != null && row.at >= worldFrom;

// A frame line covers the second(s) since the one before. The account and the
// clock are averages over the same stretch, so a frame's own numbers are theirs.
const worldFrames = world.map((f) => {
  const cs = clockWin.get(f.at) || [];
  const as = accountWin.get(f.at) || [];
  const untilList = meanOf(as, 'untilListMs');
  const untilSubmit = meanOf(as, 'untilSubmitMs');
  const tail = meanOf(as, 'tailMs');
  const reset = meanOf(as, 'resetMs');
  return {
    ...f,
    idleMs: meanOf(cs, 'idleMs'),
    busyPct: meanOf(cs, 'busyPct'),
    idleBehindMs: meanOf(cs, 'idleBehindMs'),
    stoodMs: meanOf(cs, 'stoodMs'),
    untilListMs: untilList,
    untilSubmitMs: untilSubmit,
    tailMs: tail,
    resetMs: reset,
    // What the title did between its last present and its first list call: it
    // is not in the preparing count (that starts at the submission).
    titleGapMs: untilList,
    // Its own chain: the last submission to the next present call.
    submitToPresentMs: tail,
  };
});

// A frame is one present to the next, and its parts have to be a partition of
// that, not a pile: `untilSubmit` already contains `untilList` (the title's
// first list call comes before its first submission), so only the stretch
// between the two is the second part. The counters are reset at the present,
// so `tail` closes this frame and `untilSubmit` opens the next: together with
// the submission's own stages they cover the frame once.
function breakdown(f) {
  const parts = {
    // The title, from its present to its first list call: its own thinking time.
    titleBeforeListMs: f.untilListMs,
    // Its recording, until the first submission of the frame.
    titleListsToSubmitMs: f.untilListMs == null || f.untilSubmitMs == null ? null : Math.max(0, f.untilSubmitMs - f.untilListMs),
    // The submitting thread's own work, and its wait for the card.
    listsResetMs: f.resetMs,
    preparingMs: f.prepareMs,
    onTheGpuMs: f.gpuMs,
    copyingBackMs: f.backMs,
    // The last submission to the present call that ends the frame.
    submitToPresentMs: f.tailMs,
  };
  const known = Object.values(parts).reduce((a, b) => a + (b ?? 0), 0);
  const rest = f.ms == null ? null : Math.max(0, f.ms - known);
  return { parts, known: known || null, rest };
}

const breakdowns = worldFrames.map(breakdown);
const report = {
  log: logPath,
  world: {
    frames: worldFrames.length,
    from: worldFrom,
    to: worldFrames.length ? worldFrames[worldFrames.length - 1].at : null,
    ms: stats(worldFrames.map((f) => f.ms)),
    draws: stats(worldFrames.map((f) => f.draws)),
    stages: {
      titleBeforeListMs: stats(breakdowns.map((b) => b.parts.titleBeforeListMs)),
      titleListsToSubmitMs: stats(breakdowns.map((b) => b.parts.titleListsToSubmitMs)),
      listsResetMs: stats(breakdowns.map((b) => b.parts.listsResetMs)),
      preparingMs: stats(breakdowns.map((b) => b.parts.preparingMs)),
      onTheGpuMs: stats(breakdowns.map((b) => b.parts.onTheGpuMs)),
      copyingBackMs: stats(breakdowns.map((b) => b.parts.copyingBackMs)),
      submitToPresentMs: stats(breakdowns.map((b) => b.parts.submitToPresentMs)),
      restMs: stats(breakdowns.map((b) => b.rest)),
    },
    card: {
      idleMs: stats(worldFrames.map((f) => f.idleMs)),
      idleBehindMs: stats(worldFrames.map((f) => f.idleBehindMs)),
      busyPct: stats(worldFrames.map((f) => f.busyPct)),
      stoodMs: stats(worldFrames.map((f) => f.stoodMs)),
    },
    submit: {
      rows: submits.filter(inWorld).length,
      lockMs: stats(submits.filter(inWorld).map((s) => s.lockMs)),
      betweenMs: stats(submits.filter(inWorld).map((s) => s.betweenMs)),
    },
    record: {
      rows: records.filter(inWorld).length,
      listCalls: stats(records.filter(inWorld).map((r) => r.listCalls)),
      listMs: stats(records.filter(inWorld).map((r) => r.listMs)),
      pipelineWaitMs: stats(records.filter(inWorld).map((r) => r.pipelineWaitMs)),
    },
    buckets: Object.fromEntries(BUCKETS.map(([name, test]) => {
      const sel = worldFrames.filter((f) => f.draws != null && test(f.draws));
      const bs = sel.map(breakdown);
      return [name, {
        frames: sel.length,
        ms: stats(sel.map((f) => f.ms)),
        draws: stats(sel.map((f) => f.draws)),
        stages: Object.fromEntries(Object.keys(bs[0]?.parts || {}).map((k) => [k, stats(bs.map((b) => b.parts[k]))])),
        restMs: stats(bs.map((b) => b.rest)),
      }];
    })),
  },
};

// ---------------------------------------------------------------- the profiler
// `VICTORY_CPUPROF` writes: a span, the process's counters, one line per thread
// and one per stack sample. Threads are ranked by what they ran, and each
// thread's own samples say where.
function readCpuprof(path) {
  const text = readFileSync(path, 'utf8').split(/\r?\n/);
  const threads = [];
  const stacks = new Map();
  let span = null;
  let cpu = null;
  for (const line of text) {
    if (!line) continue;
    if (line.startsWith('span ')) {
      const [, s, ms] = line.split(' ');
      span = { seconds: Number(s), ms: Number(ms) };
      continue;
    }
    if (line.startsWith('cpu ')) {
      const [, total, user, kernel] = line.split(' ').map(Number);
      cpu = { totalMs: total, userMs: user, kernelMs: kernel };
      continue;
    }
    if (line.startsWith('thread ')) {
      const rest = line.slice(7);
      const first = rest.split(' ');
      const id = Number(first[0]);
      const ms = Number(first[1]);
      const samples = Number(first[2]);
      // The name may hold spaces; the start address is the last field.
      const tail = rest.slice(first[0].length + first[1].length + first[2].length + 3);
      const cut = tail.lastIndexOf(' ');
      threads.push({ id, ms, samples, name: cut > 0 ? tail.slice(0, cut) : '', start: cut > 0 ? tail.slice(cut + 1) : '' });
      continue;
    }
    if (line.startsWith('stack ')) {
      const rest = line.slice(6);
      const parts = rest.split(' ');
      const id = Number(parts[0]);
      const phase = Number(parts[1]);
      const count = Number(parts[2]);
      const frames = rest.slice(parts[0].length + parts[1].length + parts[2].length + 3).split(';').filter(Boolean);
      if (!stacks.has(id)) stacks.set(id, []);
      stacks.get(id).push({ phase, count, frames });
    }
  }
  threads.sort((a, b) => b.ms - a.ms);
  return { span, cpu, threads, stacks };
}

if (cpuprofPath) {
  const p = readCpuprof(cpuprofPath);
  // The busiest frame in the thread's own samples: the innermost frame that is
  // not a wait, as the profile wrote them innermost first.
  const busiest = (id) => {
    const rows = p.stacks.get(id) || [];
    const byFrame = new Map();
    for (const row of rows) {
      const top = row.frames[0];
      if (!top) continue;
      byFrame.set(top, (byFrame.get(top) || 0) + row.count);
    }
    const total = [...byFrame.values()].reduce((a, b) => a + b, 0) || 1;
    return [...byFrame.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([frame, n]) => ({ frame, samples: n, share: Math.round((n / total) * 1000) / 10 }));
  };
  report.profiler = {
    span: p.span,
    process: p.cpu,
    threads: p.threads.map((t) => ({
      ...t,
      // What of the process's own processor time this thread was.
      share: p.cpu && p.cpu.totalMs ? Math.round((t.ms / p.cpu.totalMs) * 1000) / 10 : null,
      busiest: busiest(t.id),
    })),
  };
}

if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------- the table
const r = (x) => (x == null ? '—' : x);
const pct = (a, b) => (a == null || b == null || b === 0 ? null : Math.round((a / b) * 1000) / 10);
const line = (name, s) => '| ' + name + ' | ' + r(s.median) + ' | ' + r(s.p90) + ' | ' + r(s.mean) + ' | ' + s.n + ' |';
const out = [];
const ms = report.world.ms.median;
out.push('## World section: ' + report.world.frames + ' frame lines, ' + r(report.world.from) + ' to ' + r(report.world.to));
out.push('');
out.push('### Where a frame goes (median/P90/mean ms per frame, and share of the median frame)');
out.push('');
out.push('| stage | median | P90 | mean | n | share of median frame |');
out.push('|---|---|---|---|---|---|');
for (const [k, s] of Object.entries(report.world.stages)) {
  out.push('| ' + k + ' | ' + r(s.median) + ' | ' + r(s.p90) + ' | ' + r(s.mean) + ' | ' + s.n + ' | ' + (pct(s.median, ms) ?? '—') + '% |');
}
out.push('| **frame** | **' + r(report.world.ms.median) + '** | **' + r(report.world.ms.p90) + '** | **' + r(report.world.ms.mean) + '** | ' + report.world.ms.n + ' | 100% |');
out.push('');
out.push('### The card');
out.push('');
out.push('| metric | median | P90 | mean | n |');
out.push('|---|---|---|---|---|');
for (const [k, s] of Object.entries(report.world.card)) out.push(line(k, s));
out.push('');
out.push('### Recording and submission');
out.push('');
out.push('| metric | median | P90 | mean | n |');
out.push('|---|---|---|---|---|');
for (const [k, s] of Object.entries(report.world.submit)) { if (k !== 'rows') out.push(line('submit ' + k, s)); }
for (const [k, s] of Object.entries(report.world.record)) { if (k !== 'rows') out.push(line('record ' + k, s)); }
out.push('');
out.push('### By draws per frame');
out.push('');
out.push('| draws | frames | frame ms | title before list | title lists | lists reset | preparing | on the GPU | copying back | submit to present | rest |');
out.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const [name, b] of Object.entries(report.world.buckets)) {
  const g = (k) => r(b.stages[k]?.median);
  out.push('| ' + name + ' | ' + b.frames + ' | ' + r(b.ms.median) + ' | ' + g('titleBeforeListMs') + ' | ' + g('titleListsToSubmitMs') + ' | ' + g('listsResetMs') + ' | ' + g('preparingMs') + ' | ' + g('onTheGpuMs') + ' | ' + g('copyingBackMs') + ' | ' + g('submitToPresentMs') + ' | ' + r(b.restMs.median) + ' |');
}
if (report.profiler) {
  out.push('');
  out.push('### Threads, by the processor time they ran (' + r(report.profiler.span?.seconds) + ' s of world)');
  out.push('');
  out.push('| thread | name | ran ms | share of the process | samples | busiest frame |');
  out.push('|---|---|---|---|---|---|');
  for (const t of report.profiler.threads.slice(0, 20)) {
    const top = t.busiest[0];
    out.push('| ' + t.id + ' | ' + (t.name || t.start || '—') + ' | ' + t.ms + ' | ' + (t.share ?? '—') + '% | ' + t.samples + ' | ' + (top ? top.frame + ' (' + top.share + '%)' : '—') + ' |');
  }
  out.push('');
  out.push('process, all threads: ' + (report.profiler.process ? report.profiler.process.totalMs + ' ms (' + report.profiler.process.userMs + ' user + ' + report.profiler.process.kernelMs + ' kernel) over ' + r(report.profiler.span?.seconds) + ' s' : 'not printed'));
}
console.log(out.join('\n'));

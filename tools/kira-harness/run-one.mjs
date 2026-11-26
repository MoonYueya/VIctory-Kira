#!/usr/bin/env node
// One unattended run of the title, start to a result file.
//
//   node tools/kira-harness/run-one.mjs --id <name> [--seconds N] [--env K=V,...]
//        [--commit <hash>] [--settings <file>] [--no-stop-on-world]
//
// What it does, in order: read the settings, check there is room on the volume, check the
// executable is the one expected, link the title's folder into a work folder, copy the
// save template in fresh, compile the key presses, take the run lock, play until the
// deadline or until the log shows the world, parse the log, copy a few frames out, write
// `result.json` and `summary.txt`, release the lock.
//
// Nothing is pushed, nothing is posted, and the title's own folder is never written to.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDiskSpace, ensureDirs, gb, loadSettings, runDir } from './lib/config.mjs';
import {
  acquireRunLock, archiveShots, prepareOverlay, releaseRunLock, runTitle, verifyExe, waitForNoRuns,
} from './lib/run.mjs';
import { parseLog, reachedWorld } from './lib/logparse.mjs';
import { copyTemplate } from './lib/datatemplate.mjs';
import { compile, counts, describe, toKeys } from './lib/schedule.mjs';
import { buildRecord, summarize, toJson } from './lib/report.mjs';

function usage(why) {
  if (why) console.error(why);
  console.error('usage: node run-one.mjs --id <name> [--seconds N] [--env K=V,...] [--commit <hash>] ' +
    '[--settings <file>] [--no-stop-on-world]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const opt = { id: null, seconds: null, env: {}, commit: '', settings: null, stopOnWorld: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--id') opt.id = next();
  else if (a === '--seconds') opt.seconds = Number(next());
  else if (a === '--commit') opt.commit = next();
  else if (a === '--settings') opt.settings = next();
  else if (a === '--no-stop-on-world') opt.stopOnWorld = false;
  else if (a === '--env') {
    for (const pair of String(next()).split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) opt.env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  } else usage('unknown argument: ' + a);
}
if (!opt.id) usage('--id is required');

const settings = loadSettings(opt.settings);
if (opt.seconds) settings.seconds = opt.seconds;
const stopOnWorld = opt.stopOnWorld == null ? settings.stopOnWorld : opt.stopOnWorld;

const dir = runDir(settings, opt.id);
mkdirSync(dir, { recursive: true });
const log = (m) => console.log(m);

assertDiskSpace(settings, { where: 'run-one ' + opt.id });
ensureDirs(settings);

const exe = await verifyExe(settings.exe, settings.exeSha256);
if (!exe.ok) throw new Error('the executable is not the one expected: ' + exe.actual);
log('the executable is the one expected (' + exe.actual.slice(0, 16) + '…)');

const overlay = prepareOverlay(settings.gameDir, settings.paths.overlay, { log });
log('free space ' + gb(assertDiskSpace(settings).free) + ' GB');

const dataDir = join(settings.paths.data, String(opt.id).replace(/[^A-Za-z0-9_.-]/g, '_'));
let template = null;
if (settings.dataTemplate) {
  const copy = copyTemplate(settings.dataTemplate, dataDir, { log });
  template = { files: copy.template.files, bytes: copy.template.bytes, digest: copy.template.digest };
} else {
  log('no save template is set: the run starts at the title\'s first setup');
}

// Made before the run starts: the layer writes a frame into it and says so in the log
// when it cannot, which is one line per frame for a folder that was never made.
const captureDir = join(dir, 'shots-raw');
mkdirSync(captureDir, { recursive: true });
// The settings' own switches first, then the command line's: a run inherits the
// configuration and overrides only what it is testing.
const switches = { ...settings.env, ...opt.env };
if (!settings.noKeys) {
  const events = compile(settings.keys);
  if (events.length) {
    switches.VICTORY_KEYS = toKeys(events);
    log('key presses: ' + describe(events));
    log('  as VICTORY_KEYS, ' + JSON.stringify(counts(events)));
  }
}

// Nothing of a run is up before the lock is asked for, and nothing is up after it was
// taken: the second look is what a lock shared with someone else's settings cannot do.
const before = await waitForNoRuns(settings, { log });
if (!before.clear) {
  console.error('a run of the title is up and did not go away; not starting a second one');
  process.exit(1);
}

const lock = await acquireRunLock(settings.paths.lock, 'kira-harness/' + opt.id, { log });
if (!lock.acquired) {
  console.error('the run lock could not be taken; another run is going');
  process.exit(1);
}
const again = await waitForNoRuns(settings, { log });
if (!again.clear) {
  releaseRunLock(lock);
  console.error('a run of the title is up beside this one; letting the lock go');
  process.exit(1);
}
let run;
try {
  run = await runTitle(settings, {
    logPath: join(dir, 'run.log'),
    dataDir,
    captureDir,
    seconds: settings.seconds,
    extraEnv: switches,
    log,
    onTick: stopOnWorld ? ({ log: text }) => ({ stop: reachedWorld(text) }) : null,
  });
  const parsed = parseLog(run.text);
  const shots = archiveShots(captureDir, join(dir, 'shots'), 5);
  const record = buildRecord(run, parsed, {
    id: opt.id, commit: opt.commit, switches, seconds: settings.seconds,
    exe: exe.actual, template, shots,
  });
  writeFileSync(join(dir, 'result.json'), toJson(record), 'utf8');
  const lines = summarize(record);
  writeFileSync(join(dir, 'summary.txt'), lines.join('\n') + '\n', 'utf8');
  for (const line of lines) console.log(line);
  console.log('RESULT ' + JSON.stringify({
    wall: record.wallSeconds,
    exit: record.exitCode,
    timedOut: record.timedOut,
    stoppedEarly: record.stoppedEarly,
    enteredWorld: parsed.fps.enteredWorld,
    worldSamples: parsed.fps.worldSamples,
    worldWorstMs: parsed.fps.worldWorstMs,
    renderDrawsMedian: parsed.worldDrops.renderDrawsMedian,
    renderDroppedMedian: parsed.worldDrops.renderDroppedMedian,
    notTranslated: parsed.shaders.notTranslated,
    deviceRemoved: parsed.gpu.deviceRemoved,
    shots: shots.length,
    result: join(dir, 'result.json'),
  }));
} finally {
  log('lock released: ' + releaseRunLock(lock));
}

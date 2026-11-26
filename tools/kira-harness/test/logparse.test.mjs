// The log rules, against the lines the title really prints.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeError, parseLog, reachedWorld, timeToFirstFrame, WORLD_FPS } from '../lib/logparse.mjs';

// The title prints one decimal place (`{ms:.1}` in host.rs), so a test line has to as well.
const one = (v) => Number(v).toFixed(1);
const FRAME = (fps, ms, draws, dropped, making, indirect) =>
  one(fps) + ' fps, ' + one(ms) + ' ms/frame (48.1 preparing: copies 10.2 ms 3.7 MB, textures 7.1 ms 1.2 MB; ' +
  '41.0 on the GPU; 12.0 copying back 0.4 MB), ' + draws + ' draws/frame, dropped ' + dropped +
  ' without a host pipeline (' + making + ' being made) and ' + indirect + ' indirect; heap buffers 0.0 passes ' +
  '0.0 ms;                  texture slots written so far: 12 placed, 3 of objects; textures picked by index: ' +
  '4 uploaded so far (2 MB), 1 waiting, 0 passed over unmapped; depth textures with                  unordered ' +
  'access: 0 made, bound as depth 0x, cleared as depth 0x,                  unordered views refused 0x; buffer ' +
  'views left null as the host would refuse them: 0';

test('a menu holds more than five frames a second, so it is not the world', () => {
  const log = FRAME(58.3, 17.2, 0, 0, 0, 0) + '\n' + FRAME(44.0, 22.7, 0, 0, 0, 0) + '\n';
  const parsed = parseLog(log);
  assert.equal(parsed.fps.samples, 2);
  assert.equal(parsed.fps.worldSamples, 0);
  assert.equal(parsed.fps.enteredWorld, false);
  assert.equal(parsed.fps.menuBestFps, 58.3);
});

test('one frame line under five frames a second is the world', () => {
  const log = FRAME(58.3, 17.2, 0, 0, 0, 0) + '\n' + FRAME(1.7, 577.0, 3571, 1386, 12, 1839) + '\n';
  const parsed = parseLog(log);
  assert.equal(parsed.fps.enteredWorld, true);
  assert.equal(parsed.fps.worldSamples, 1);
  assert.equal(parsed.fps.worldWorstMs, 577);
  assert.equal(parsed.fps.worldBestFps, 1.7);
});

test('draws per frame never decides the world: ten draws at 1.4 fps is still the world', () => {
  const parsed = parseLog(FRAME(1.4, 700.0, 10, 0, 0, 0) + '\n');
  assert.equal(parsed.fps.enteredWorld, true);
  assert.equal(parsed.fps.slowButLowDrawRows, 1);
  assert.equal(parsed.worldDrops.renderRows, 0);
});

test('exactly five frames a second is the menu, not the world', () => {
  const parsed = parseLog(FRAME(WORLD_FPS, 200.0, 900, 0, 0, 0) + '\n');
  assert.equal(parsed.fps.enteredWorld, false);
});

test('the two sorts of dropped draws are counted apart', () => {
  const log = [
    FRAME(1.7, 577.0, 3571, 1386, 900, 1839),
    FRAME(2.1, 480.0, 2200, 825, 0, 907),
    FRAME(40.0, 25.0, 0, 12, 0, 0),
  ].join('\n') + '\n';
  const parsed = parseLog(log);
  assert.equal(parsed.worldDrops.rowsWithDrops, 2);
  assert.equal(parsed.worldDrops.renderDroppedPeak, 1386);
  assert.equal(parsed.worldDrops.renderIndirectMedian, 1373);
  assert.equal(parsed.worldDrops.menuDroppedTotal, 12);
});

test('a missing number stays null instead of becoming zero', () => {
  const parsed = parseLog('nothing here\n');
  assert.equal(parsed.fps.worldWorstMs, null);
  assert.equal(parsed.fps.worldMedianMs, null);
  assert.equal(parsed.worldDrops.renderDroppedMedian, null);
  assert.equal(parsed.fps.enteredWorld, false);
});

test('presents, saved frames and packages are read out', () => {
  const log = [
    '2026-11-26T10:00:00.100000Z  INFO victory_gpu::queue: frame presented (since the last line: draws ' +
      'and dispatches, and those run on the host) frame=3178 draws=3571 drawn=9321 dispatches=12 dispatched=40',
    '2026-11-26T10:00:01.100000Z  INFO victory_gpu::capture: frame saved path=C:/x/frame-3178.png',
    '2026-11-26T10:00:02.100000Z  INFO victory_hle::modules::dstorage: dstorage: file opened ' +
      'path="G:\\pack\\volume00.dat" iid="x"',
  ].join('\n');
  const parsed = parseLog(log);
  assert.equal(parsed.presents.count, 1);
  assert.equal(parsed.presents.maxFrame, 3178);
  assert.equal(parsed.presents.totalDrawn, 9321);
  assert.equal(parsed.presents.framesSaved, 1);
  assert.deepEqual(parsed.packages, ['G:\\pack\\volume00.dat']);
  assert.equal(timeToFirstFrame(log), 0);
});

test('the same shader gap at another address is one gap', () => {
  const one = 'shader does not translate; its pipelines\' draws are dropped stage="pixel" hash=abc ' +
    'error=failed at 0x7ff612340000 with code 5';
  const two = 'shader does not translate; its pipelines\' draws are dropped stage="pixel" hash=def ' +
    'error=failed at 0x7ff699990000 with code 5';
  const parsed = parseLog(one + '\n' + two + '\n');
  assert.equal(parsed.shaders.notTranslated, 2);
  assert.equal(parsed.shaders.distinctErrors, 1);
  assert.equal(parsed.shaders.topErrors[0].count, 2);
  assert.equal(normalizeError('a 0xBEEF b'), 'a 0x? b');
});

test('a device removal and a panic are told apart', () => {
  const parsed = parseLog([
    'ERROR victory_gpu::device: device removed: 0x887a0005',
    'thread main panicked at crates/x/src/y.rs:12',
  ].join('\n') + '\n');
  assert.equal(parsed.gpu.deviceRemoved, 2);
  assert.equal(parsed.gpu.crashes.panic, 1);
});

test('a run in progress can be asked whether the world has arrived yet', () => {
  assert.equal(reachedWorld(FRAME(52.0, 19.2, 0, 0, 0, 0)), false);
  assert.equal(reachedWorld(FRAME(3.9, 256.0, 1200, 0, 0, 0)), true);
  assert.equal(reachedWorld(''), false);
});
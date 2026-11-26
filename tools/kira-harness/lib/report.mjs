// One run, written down: a JSON file with everything a second run would need to be
// compared with it, and a few lines for a person.
//
// The rule from the measurements this comes from: a number that was not read is `null`,
// never an estimate, and the world verdict is never taken from a picture.

/**
 * @param {object} run what `runTitle` gave back
 * @param {object} parsed what `parseLog` gave back
 * @param {object} context id, commit, switches, settings
 * @returns {object} the record, ready to write
 */
export function buildRecord(run, parsed, context = {}) {
  return {
    id: context.id ?? null,
    commit: context.commit ?? null,
    switches: context.switches ?? {},
    seconds: context.seconds ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    wallSeconds: run.wallSeconds,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    stoppedEarly: run.stoppedEarly ?? false,
    logPath: run.logPath,
    logBytes: run.logBytes,
    exe: context.exe ?? null,
    template: context.template ?? null,
    parsed,
    shots: context.shots ?? [],
  };
}

/** The record's headline numbers, one line each. */
export function summarize(record) {
  const p = record.parsed || {};
  const f = p.fps || {};
  const d = p.worldDrops || {};
  const s = p.shaders || {};
  const g = p.gpu || {};
  return [
    'run          ' + (record.id ?? '?') + '  wall ' + record.wallSeconds + ' s  exit ' +
      record.exitCode + (record.timedOut ? '  (stopped at its deadline)' : '') +
      (record.stoppedEarly ? '  (stopped once the world was in the log)' : ''),
    'world        ' + (f.enteredWorld ? 'reached' : 'not reached') + '  frames ' +
      (f.worldSamples ?? 0) + '  worst ' + (f.worldWorstMs ?? '—') + ' ms  median ' +
      (f.worldMedianMs ?? '—') + ' ms',
    'menu         best ' + (f.menuBestFps ?? '—') + ' fps',
    'draws        world median ' + (d.renderDrawsMedian ?? '—') + '  peak ' + (d.renderDrawsPeak ?? '—'),
    'dropped      median ' + (d.renderDroppedMedian ?? '—') + '  peak ' + (d.renderDroppedPeak ?? '—') +
      '  indirect half ' + (d.renderIndirectMedian ?? '—') + '  (a dropped indirect is permanent)',
    'shaders      ' + (s.translated ?? 0) + ' translated, ' + (s.notTranslated ?? 0) + ' not' +
      ((s.distinctErrors ?? 0) ? ', ' + s.distinctErrors + ' distinct reasons' : ''),
    'faults       ' + (g.deviceRemoved ?? 0) + ' device removals, panics ' + ((g.crashes || {}).panic ?? 0),
  ];
}

/** The record as the small JSON file a later run can be compared with. */
export function toJson(record) {
  return JSON.stringify(record, null, 2);
}

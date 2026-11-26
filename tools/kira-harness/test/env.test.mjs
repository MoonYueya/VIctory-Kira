// The settings' own switches, and why they are a map rather than a string.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSettings } from '../lib/config.mjs';

function settingsWith(extra) {
  const root = mkdtempSync(join(tmpdir(), 'kira-env-'));
  const path = join(root, 'kira-harness.local.json');
  writeFileSync(path, JSON.stringify({
    victory: 'v.exe', exe: 't.exe', gameDir: 'g', work: join(root, 'work'), ...extra,
  }));
  return { root, loaded: loadSettings(path) };
}

test('a switch whose value holds commas survives the settings file', () => {
  // `--env` splits on commas, so `VICTORY_CPUPROF=420,840,25,f.txt` cannot be
  // written on the command line at all. The settings map carries it whole.
  const { root, loaded } = settingsWith({
    env: { VICTORY_CPUPROF: '420,840,25,F:/a b/c.txt', VICTORY_MEMORY_CATEGORIES: 1 },
  });
  try {
    assert.equal(loaded.env.VICTORY_CPUPROF, '420,840,25,F:/a b/c.txt');
    // A number becomes the text the environment would have had.
    assert.equal(loaded.env.VICTORY_MEMORY_CATEGORIES, '1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings without switches have none rather than something made up', () => {
  const { root, loaded } = settingsWith({});
  try {
    assert.deepEqual(loaded.env, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a list where the map belongs is not read as switches', () => {
  // `env: ["A=1"]` is a shape somebody may write by mistake; it is not a map.
  const { root, loaded } = settingsWith({ env: ['A=1'] });
  try {
    assert.deepEqual(loaded.env, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The key list, checked against what the title's input module accepts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, counts, describe, isValidKey, KEY_HOLD, toKeys } from '../lib/schedule.mjs';

test('a press becomes seconds and a key, and a letter becomes a capital', () => {
  const events = compile([{ at: 20, keys: ['enter'] }, { at: 33, keys: ['a'] }]);
  assert.equal(toKeys(events), '20:Enter,33:A');
});

test('the title takes the eight named keys and single letters and digits', () => {
  for (const key of ['Enter', 'Esc', 'Tab', 'Back', 'Up', 'Down', 'Left', 'Right', 'a', 'Z', '7']) {
    assert.equal(isValidKey(key), true, key);
  }
  for (const key of ['Space', 'F1', '', null, 'enter', 'Enterr', '!']) {
    assert.equal(isValidKey(key), false, String(key));
  }
});

test('a key it would ignore is an error, not a silent gap', () => {
  assert.throws(() => compile([{ at: 5, keys: ['Space'] }]), /no such key/);
});

test('two presses of one key closer together than the hold become one, not a long press', () => {
  const events = compile([{ at: 10, keys: ['Enter'] }, { at: 10.1, keys: ['Enter'] }, { at: 12, keys: ['Enter'] }]);
  assert.equal(events.length, 2);
  assert.equal(toKeys(events), '10:Enter,12:Enter');
});

test('two different keys at the same moment are both kept', () => {
  const events = compile([{ at: 10, keys: ['Y'] }, { at: 10, keys: ['Down'] }]);
  assert.equal(toKeys(events), '10:Y,10:Down');
});

test('presses come out in order whatever order they went in', () => {
  const events = compile([{ at: 90, keys: ['Enter'] }, { at: 20, keys: ['Enter'] }]);
  assert.deepEqual(events.map((e) => e.at), [20, 90]);
});

test('a negative time is clamped to the start, never wrapped around', () => {
  const events = compile([{ at: -3, keys: ['Enter'] }]);
  assert.equal(toKeys(events), '0:Enter');
});

test('the hold time is the title\'s, not a choice', () => {
  assert.equal(KEY_HOLD, 0.2);
});

test('the list can be read back as a sentence and as counts', () => {
  const events = compile([{ at: 10, keys: ['Enter'] }, { at: 20, keys: ['Down'] }, { at: 30, keys: ['Enter'] }]);
  assert.deepEqual(counts(events), { Enter: 2, Down: 1 });
  assert.equal(describe(events), '10s Enter | 20s Down | 30s Enter');
});

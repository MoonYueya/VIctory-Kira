// The first setup's key presses, compiled into `VICTORY_KEYS`.
//
// The channel, and why it is this one: `VICTORY_KEYS` is read inside the process
// (`crates/victory-hle/src/modules/gameinput.rs:1248-1285`), so the keys arrive without
// the window having to be in front and without anything being typed into whatever the
// person at the machine is doing. The alternative, sending input to the desktop, takes
// the focus and types into other programs — the opposite of an unattended run.
//
// What the channel can say: `<seconds>:<key>` holds that key for 0.2 s that long after
// the first read of input, and `<from>-<to>:<key>` holds it the whole time. A key is a
// letter, a digit, or Enter, Esc, Tab, Back, Up, Down, Left, Right.
//
// The presses below are a **prior**: nobody knows which page is on screen, only when each
// page has been seen to appear. Two presses of the same key closer together than the hold
// time become one long press, so every gap is kept above it.

/** The keys `VICTORY_KEYS` understands, spelled as it spells them. */
export const KEYS = ['Enter', 'Esc', 'Tab', 'Back', 'Up', 'Down', 'Left', 'Right'];

/** How long one press lasts. Not adjustable: it is what the title's input module does. */
export const KEY_HOLD = 0.2;

/** The smallest gap between two presses of the same key, in seconds. */
export const ACTION_GAP = 1.4;

/**
 * Where the presses start counting from, in seconds. The title reads the list once, at
 * its first look at the input devices, which is about two seconds after it starts.
 */
export const ORIGIN_OFFSET = 0;

/** A key is valid when the title would accept it, in the spelling the title uses. */
export function isValidKey(key) {
  return typeof key === 'string' && (KEYS.includes(key) ||
    (key.length === 1 && /[A-Za-z0-9]/.test(key)));
}

/** The title's own spelling of a key: `enter` becomes `Enter`, `a` becomes `A`. */
export function canonicalKey(key) {
  if (typeof key !== 'string') return key;
  const named = KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
  if (named) return named;
  return key.length === 1 && /[A-Za-z0-9]/.test(key) ? key.toUpperCase() : key;
}

/**
 * A list of presses, checked and sorted.
 *
 * @param {{at: number, keys: string[]}[]} events
 * @returns {{at: number, keys: string[]}[]} ascending, with presses of the same key too
 *   close together dropped rather than merged into one long press
 */
export function compile(events) {
  const out = [];
  const lastAt = new Map();
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const at = round(Math.max(0, Number(event.at) || 0));
    const keys = [];
    for (const key of event.keys || []) {
      const name = canonicalKey(key);
      if (!isValidKey(name)) throw new Error('the title takes no such key: ' + JSON.stringify(key));
      const previous = lastAt.get(name);
      if (previous != null && at - previous < KEY_HOLD + 0.01) continue;
      keys.push(name);
    }
    if (!keys.length) continue;
    for (const key of keys) lastAt.set(key, at);
    out.push({ at, keys });
  }
  return out;
}

/**
 * The presses, as the `VICTORY_KEYS` string.
 * @param {{at: number, keys: string[]}[]} events
 * @param {{origin?: number}} [opts] `origin` shifts every press earlier by that many seconds
 */
export function toKeys(events, { origin = ORIGIN_OFFSET } = {}) {
  const parts = [];
  for (const event of compile(events)) {
    const at = round(Math.max(0, event.at - origin));
    for (const key of event.keys) parts.push(at + ':' + key);
  }
  return parts.join(',');
}

/** How many times each key is pressed. */
export function counts(events) {
  const out = {};
  for (const event of events) {
    for (const key of event.keys) out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** A line for the log: `20s Enter | 32s Down | …`. */
export function describe(events) {
  return events.map((e) => e.at + 's ' + e.keys.join('+')).join(' | ');
}

function round(x) {
  return Math.round(x * 10) / 10;
}
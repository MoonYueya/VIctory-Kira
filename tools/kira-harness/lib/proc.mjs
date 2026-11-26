// Child processes: start one, collect its output, and the few file helpers the rest uses.
//
// Every child gets `childEnv` from config.mjs (no inherited `VICTORY_*`, no scratch files
// on the system drive) and no new console window.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { childEnv } from './config.mjs';

/**
 * Run a command to its end. Never throws: gives `{ code, stdout, stderr, ms, killedByTimeout }`
 * so callers can decide.
 */
export function run(settings, cmd, args, opts = {}) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env || childEnv(settings, opts.extraEnv),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        try { child.kill('SIGKILL'); } catch { /* it had already gone */ }
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); if (opts.onStdout) opts.onStdout(d.toString()); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (opts.onStderr) opts.onStderr(d.toString()); });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + '\n' + e.message, ms: Date.now() - started, killedByTimeout });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      done({ code: code == null ? -1 : code, stdout, stderr, ms: Date.now() - started, killedByTimeout });
    });
  });
}

/** The same, but a non-zero exit is an error whose message carries the last lines of output. */
export async function runOk(settings, cmd, args, opts = {}) {
  const r = await run(settings, cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(cmd + ' ' + args.join(' ') + ' failed (code ' + r.code + ')\n' + tail(r.stderr || r.stdout, 12));
  }
  return r;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** SHA-256 of a file, read in pieces so a large one is never held in memory. */
export function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => done(hash.digest('hex')));
    stream.on('error', fail);
  });
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** A JSON file, or `fallback` when it is missing or half written. */
export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** The last `n` lines, so a report does not grow a whole log. */
export function tail(text, n = 40) {
  return String(text || '').trim().split(/\r?\n/).slice(-n).join('\n');
}

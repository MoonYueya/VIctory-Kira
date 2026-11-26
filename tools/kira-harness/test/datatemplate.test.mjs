// The save template: copied in, never written through.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyTemplate, digestTree, listFiles, sameAsTemplate } from '../lib/datatemplate.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kira-dt-'));
  mkdirSync(join(root, 'template', '7952987A', 'saves'), { recursive: true });
  writeFileSync(join(root, 'template', '7952987A', 'saves', 'slot0'), 'save');
  writeFileSync(join(root, 'template', 'settings.bin'), 'settings');
  return root;
}

test('the template is copied and its digest is the same afterwards', () => {
  const root = fixture();
  try {
    const template = join(root, 'template');
    const before = digestTree(template);
    const into = join(root, 'run');
    const out = copyTemplate(template, into, { log: () => {} });
    assert.equal(out.copied, 2);
    assert.equal(out.bytes, before.bytes);
    assert.equal(digestTree(template).digest, before.digest);
    assert.equal(digestTree(into).digest, before.digest);
    assert.equal(readFileSync(join(into, '7952987A', 'saves', 'slot0'), 'utf8'), 'save');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a copy starts clean: the last run\'s writes are not carried in', () => {
  const root = fixture();
  try {
    const template = join(root, 'template');
    const into = join(root, 'run');
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, 'left-over.bin'), 'from the last run');
    copyTemplate(template, into, { log: () => {} });
    assert.equal(sameAsTemplate(template, into).same, true);
    assert.deepEqual(sameAsTemplate(template, into).added, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an empty or absent template is an error, not an empty run', () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'empty'), { recursive: true });
    assert.throws(() => copyTemplate(join(root, 'empty'), join(root, 'a'), { log: () => {} }), /empty/);
    assert.throws(() => copyTemplate(join(root, 'nope'), join(root, 'b'), { log: () => {} }), /not there/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a folder is listed by path, in one order, however the disk gives it back', () => {
  const root = fixture();
  try {
    const files = listFiles(join(root, 'template'));
    assert.deepEqual(files.map((f) => f.path.replace(root, '').replace(/\\/g, '/')),
      ['/template/7952987A/saves/slot0', '/template/settings.bin']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function checkFixture(change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'gsb-artifact-lock-'));
  const bundle = '/* fixture runtime */\n';
  const helper = '/* fixture headless helper */\n';
  const identity = { name: 'governed-second-brain', version: '1.2.0' };
  const lock = {
    stack: {
      plugin: identity,
      govern: {
        commit: 'a'.repeat(40),
        bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        qmdCommandHelperSha256: createHash('sha256').update(helper).digest('hex'),
      },
    },
  };
  const json = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
  try {
    for (const path of ['smoke', 'plugin-runtime', '.claude-plugin']) {
      mkdirSync(join(root, path));
    }
    copyFileSync(new URL('./check-lock.mjs', import.meta.url), join(root, 'smoke/check-lock.mjs'));
    writeFileSync(join(root, 'plugin-runtime/governed-brain.cjs'), bundle);
    writeFileSync(join(root, 'plugin-runtime/qmd-command.cjs'), helper);
    json('package.json', identity);
    json('.claude-plugin/plugin.json', identity);
    json('.claude-plugin/marketplace.json', { plugins: [identity] });
    json('.mcp.json', { mcpServers: { 'governed-brain': identity } });
    change({ root, lock, json });
    json('gsb.lock.json', lock);
    return spawnSync(process.execPath, [join(root, 'smoke/check-lock.mjs')], {
      encoding: 'utf8',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts matching manifests and bundle bytes', () => {
  const result = checkFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCK OK/);
});

for (const [name, change] of [
  ['changed bundle bytes', ({ root }) => {
    writeFileSync(join(root, 'plugin-runtime/governed-brain.cjs'), 'changed');
  }],
  ['missing bundle', ({ root }) => rmSync(join(root, 'plugin-runtime/governed-brain.cjs'))],
  ['changed helper bytes', ({ root }) => writeFileSync(join(root, 'plugin-runtime/qmd-command.cjs'), 'changed')],
  ['missing helper', ({ root }) => rmSync(join(root, 'plugin-runtime/qmd-command.cjs'))],
  ['missing helper hash', ({ lock }) => delete lock.stack.govern.qmdCommandHelperSha256],
  ['missing bundle hash', ({ lock }) => delete lock.stack.govern.bundleSha256],
  ['missing registrar revision', ({ lock }) => delete lock.stack.govern.commit],
  ['abbreviated registrar revision', ({ lock }) => {
    lock.stack.govern.commit = '1af2ef4';
  }],
  ['malformed registrar revision', ({ lock }) => {
    lock.stack.govern.commit = 'z'.repeat(40);
  }],
  ['non-string registrar revision', ({ lock }) => {
    lock.stack.govern.commit = ['a'.repeat(40)];
  }],
  ['plugin version drift', ({ lock }) => {
    lock.stack.plugin = { ...lock.stack.plugin, version: '1.1.0' };
  }],
]) {
  test(`rejects ${name}`, () => {
    const result = checkFixture(change);
    assert.notEqual(result.status, 0, result.stdout);
  });
}

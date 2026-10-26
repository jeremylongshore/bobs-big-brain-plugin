import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/review.mjs', import.meta.url));

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'bbb-review-cli-'));
  const home = join(root, 'home');
  const base = join(root, 'brain');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(base, { mode: 0o700 });
  const marker = join(root, 'native-attempts.jsonl');
  const guard = join(root, 'guard.cjs');
  writeFileSync(
    guard,
    `
const Module = require('node:module');
const fs = require('node:fs');
const original = Module._load;
Module._load = function (request, ...args) {
  if (['better-sqlite3', 'fs-ext', 'sqlite-vec'].includes(request) || request.endsWith('local-review.cjs')) {
    fs.appendFileSync(process.env.BBB_REVIEW_TEST_MARKER, JSON.stringify({ request }) + '\\n');
    throw new Error('fixture deliberately denies native/review helper loading');
  }
  return original.call(this, request, ...args);
};
`,
  );
  const execute = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        TMPDIR: root,
        TEAMKB_BASE_PATH: base,
        TEAMKB_TENANT_ID: 'cli-boundary-fixture',
        NODE_OPTIONS: `--require=${guard}`,
        BBB_REVIEW_TEST_MARKER: marker,
        ...extra,
      },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 32 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    return result;
  };
  try {
    run({ base, home, marker, execute });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('review help needs neither native modules nor the generated helper', () =>
  fixture(({ execute, marker }) => {
    const result = execute(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No general policy-flag approval override/);
    assert.equal(existsSync(marker), false);
  }));

test('effective team environment refuses before native/helper loading', () =>
  fixture(({ execute, base, marker }) => {
    writeFileSync(join(base, 'teamkb.db'), 'fixture database sentinel');
    const result = execute(['list'], { TEAMKB_API_URL: 'https://review-fixture.example.invalid' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'team_mode_refused');
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(base, 'teamkb.db'), 'utf8'), 'fixture database sentinel');
  }));

test('requested base controls team-file refusal rather than an unrelated default brain', () =>
  fixture(({ execute, base, home, marker }) => {
    writeFileSync(join(base, 'team.json'), '{ fixture deliberately malformed');
    const result = execute(['list']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'team_mode_refused');
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(home, '.teamkb')), false);
    rmSync(join(base, 'team.json'));
    mkdirSync(join(home, '.teamkb'));
    writeFileSync(join(home, '.teamkb', 'team.json'), '{}');
    const unrelated = execute(['list']);
    assert.equal(unrelated.status, 1);
    assert.equal(JSON.parse(unrelated.stdout).code, 'existing_store_required');
    assert.equal(existsSync(marker), false);
  }));

test('missing store refuses without creating a database or loading natives', () =>
  fixture(({ execute, base, marker }) => {
    const result = execute(['list']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'existing_store_required');
    assert.equal(existsSync(join(base, 'teamkb.db')), false);
    assert.equal(existsSync(join(base, '.write.lock')), false);
    assert.equal(existsSync(marker), false);
  }));

test('invalid command arguments refuse before touching native/helper modules', () =>
  fixture(({ execute, marker }) => {
    for (const args of [
      ['list', '--base', ''],
      ['list', '--tenant', ''],
      ['list', '--limit', '101'],
      ['list', '--role', 'member'],
      ['reject', '--candidate', 'not-a-uuid'],
      [
        'resolve-hold',
        '--candidate',
        '00000000-0000-4000-8000-000000000001',
        '--actor',
        'fixture',
        '--reason',
        'Reviewed.',
        '--resolution',
        'release',
      ],
    ]) {
      const result = execute(args);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).code, 'invalid_arguments');
    }
    assert.equal(existsSync(marker), false);
  }));

test('unavailable native dependency reports setup guidance without loading the review helper', () =>
  fixture(({ execute, base, marker }) => {
    writeFileSync(join(base, 'teamkb.db'), 'fixture database sentinel');
    const result = execute(['list']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'native_dependencies_missing');
    const attempts = readFileSync(marker, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(attempts, [{ request: 'better-sqlite3' }]);
    assert.equal(readFileSync(join(base, 'teamkb.db'), 'utf8'), 'fixture database sentinel');
  }));

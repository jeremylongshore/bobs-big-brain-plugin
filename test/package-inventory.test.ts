import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));
const runtimeFiles = [
  'plugin-runtime/bootstrap.cjs',
  'plugin-runtime/governed-brain.cjs',
  'plugin-runtime/qmd-command.cjs',
  'plugin-runtime/package.json',
  'plugin-runtime/package-lock.json',
];

test('npm pack includes the runtime entry files without provisioned dependencies', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gsb-pack-inventory-'));
  const fixture = join(scratch, 'package');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  try {
    for (const dir of ['package', 'home', 'cache', 'tmp', 'output']) {
      mkdirSync(join(scratch, dir));
    }
    const manifest: { files: string[] } = JSON.parse(
      readFileSync(join(source, 'package.json'), 'utf8'),
    );
    write(
      join(fixture, 'package.json'),
      JSON.stringify({
        name: 'bbb-private-pack-fixture',
        version: '0.0.0',
        files: manifest.files,
      }),
    );
    for (const path of manifest.files) {
      if (existsSync(join(source, path)) && statSync(join(source, path)).isDirectory()) {
        write(join(fixture, path, 'public-fixture.txt'), 'public fixture\n');
      } else {
        write(join(fixture, path), 'public fixture\n');
      }
    }
    for (const path of runtimeFiles) {
      write(join(fixture, path), path.endsWith('.json') ? '{}\n' : '// synthetic runtime\n');
    }
    write(
      join(fixture, 'plugin-runtime/node_modules/private-native/package.json'),
      '{"name":"private-native","version":"0.0.0"}\n',
    );
    write(
      join(fixture, 'plugin-runtime/node_modules/private-native/sentinel.node'),
      'synthetic bytes; never loaded\n',
    );
    write(join(fixture, 'private-sentinel.txt'), 'must not ship\n');
    write(join(scratch, 'user.npmrc'), '');
    write(join(scratch, 'global.npmrc'), '');
    const { stdout } = await execute(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'pack',
        '--ignore-scripts',
        '--offline',
        '--json',
        '--pack-destination',
        join(scratch, 'output'),
      ],
      {
        cwd: fixture,
        env: {
          ...process.env,
          HOME: join(scratch, 'home'),
          TMPDIR: join(scratch, 'tmp'),
          npm_config_cache: join(scratch, 'cache'),
          npm_config_userconfig: join(scratch, 'user.npmrc'),
          npm_config_globalconfig: join(scratch, 'global.npmrc'),
          npm_config_update_notifier: 'false',
        },
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const parsed = JSON.parse(stdout);
    const packs: { name: string; files: { path: string }[] }[] = Array.isArray(parsed)
      ? parsed
      : Object.values(parsed);
    assert.equal(packs.length, 1);
    assert.equal(packs[0].name, 'bbb-private-pack-fixture');
    const paths = packs[0].files.map((file) => file.path);
    assert.deepEqual(
      paths.filter((path) => path.startsWith('plugin-runtime/')).sort(),
      [...runtimeFiles].sort(),
    );
    assert.ok(paths.includes('package.json'));
    assert.ok(paths.includes('gsb.lock.json'));
    assert.ok(paths.includes('README.md'));
    assert.ok(paths.includes('bin/public-fixture.txt'));
    assert.ok(!paths.includes('private-sentinel.txt'));
    assert.ok(!paths.some((path) => path.split('/').includes('node_modules')));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 25_000);

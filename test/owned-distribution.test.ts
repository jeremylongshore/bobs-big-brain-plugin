import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOwnedDistribution } from '../scripts/prepare-owned-distribution.mjs';

const roots: string[] = [];
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function put(path: string, bytes: string, mode = 0o644) {
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}
function repository(root: string) {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
    [
      '-c',
      'user.name=Synthetic fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'synthetic fixture',
    ],
  ])
    execFileSync('/usr/bin/git', ['-C', root, ...args], { env, stdio: 'pipe', timeout: 10_000 });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-distribution-test-'));
  roots.push(root);
  const sourceRoot = join(root, 'plugin');
  const registrar = join(root, 'bobs-big-brain-registrar');
  const candidate = join(root, 'candidate');
  const output = join(root, 'distribution');
  const control = join(root, 'verifier-control');
  const calls = join(root, 'verifier-calls.jsonl');
  const runtime = join(sourceRoot, 'plugin-runtime');
  for (const path of [
    runtime,
    join(sourceRoot, 'bin'),
    join(registrar, 'packages/qmd-runtime/lib'),
    candidate,
  ])
    mkdirSync(path, { recursive: true });
  const runtimeFiles = [
    'bootstrap.cjs',
    'governed-brain.cjs',
    'qmd-command.cjs',
    'package.json',
    'package-lock.json',
  ];
  for (const name of runtimeFiles)
    put(join(runtime, name), name.endsWith('.json') ? '{}\n' : `// synthetic ${name}\n`);
  put(join(sourceRoot, 'README.md'), 'synthetic distribution fixture\n');
  put(join(sourceRoot, 'gsb.lock.json'), '{"synthetic":true}\n');
  put(join(sourceRoot, 'bin/init.mjs'), '#!/usr/bin/env node\n// no execution\n', 0o755);
  put(join(sourceRoot, '.gitignore'), 'node_modules/\n');
  put(
    join(sourceRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'bbb-synthetic-distribution-fixture',
        version: '1.0.0',
        files: [
          'bin',
          'README.md',
          'gsb.lock.json',
          ...runtimeFiles.map((name) => `plugin-runtime/${name}`),
        ],
        scripts: { prepack: 'exit 77' },
      },
      null,
      2,
    ) + '\n',
  );
  // Actual npm pack must exclude this provisioned-looking contamination.
  mkdirSync(join(runtime, 'node_modules/native-fixture'), { recursive: true });
  put(
    join(runtime, 'node_modules/native-fixture/addon.node'),
    'synthetic contamination; never loaded',
  );
  chmodSync(candidate, 0o700);
  const payload = 'synthetic candidate bytes; no native execution\n';
  put(join(candidate, 'payload.txt'), payload);
  symlinkSync('payload.txt', join(candidate, 'relative-link'));
  const manifest = {
    schema: 'synthetic-test-only',
    inventory: {
      bytes: Buffer.byteLength(payload),
      entries: {
        '': { kind: 'directory', mode: 0o700 },
        'payload.txt': { sha256: sha256(payload), mode: 0o644 },
        'relative-link': { target: 'payload.txt' },
      },
    },
    sourceSnapshot: { base: 'synthetic-only', uncommittedCandidate: true },
    sourceFiles: { 'synthetic-stub': 'not-eight-real-source-bindings' },
    platform: { synthetic: true },
    nodeAbi: 'test-only',
  };
  put(join(candidate, 'runtime-manifest.json'), JSON.stringify(manifest) + '\n');
  // Independent explicit fake DEV verifier. These tests prove pack/path and
  // delegation behavior, not the real Registrar graph/inventory algorithm.
  put(
    join(registrar, 'packages/qmd-runtime/lib/runtime-inventory.mjs'),
    `
import { appendFileSync, chmodSync, existsSync, readFileSync, readlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export function verifyRuntime(root) {
 appendFileSync(${JSON.stringify(calls)}, JSON.stringify(root)+'\\n');
 const mode=existsSync(${JSON.stringify(control)})?readFileSync(${JSON.stringify(control)},'utf8'):'';
 if(root!==${JSON.stringify(candidate)}&&mode==='mutate-source')writeFileSync(${JSON.stringify(join(sourceRoot, 'README.md'))},'changed during final verification\\n');
 if(root!==${JSON.stringify(candidate)}&&mode==='tamper-destination')writeFileSync(join(root,'payload.txt'),'tampered bytes\\n');
 const manifest=JSON.parse(readFileSync(join(root,'runtime-manifest.json'),'utf8'));
 if((lstatSync(root).mode&0o777)!==manifest.inventory.entries[''].mode)throw new Error('Synthetic verifier root mode mismatch');
 const bytes=readFileSync(join(root,'payload.txt'));
 if(createHash('sha256').update(bytes).digest('hex')!==manifest.inventory.entries['payload.txt'].sha256)throw new Error('Synthetic verifier payload digest mismatch');
 if((lstatSync(join(root,'payload.txt')).mode&0o777)!==manifest.inventory.entries['payload.txt'].mode)throw new Error('Synthetic verifier mode mismatch');
 if(readlinkSync(join(root,'relative-link'))!=='payload.txt')throw new Error('Synthetic verifier relative link changed');
 return {manifest,qmd:root};
}
`,
  );
  repository(sourceRoot);
  repository(registrar);
  const expectedManifestSha256 = sha256(readFileSync(join(candidate, 'runtime-manifest.json')));
  return {
    root,
    sourceRoot,
    registrar,
    candidate,
    output,
    control,
    calls,
    runtimeFiles,
    expectedManifestSha256,
  };
}
type Fixture = ReturnType<typeof fixture>;
function prepare(f: Fixture, output = f.output) {
  return prepareOwnedDistribution({
    sourceRoot: f.sourceRoot,
    candidate: f.candidate,
    expectedManifestSha256: f.expectedManifestSha256,
    output,
  });
}
function noAcceptedReceipt(f: Fixture) {
  expect(existsSync(join(f.output, 'distribution-receipt.json'))).toBe(false);
  expect(readFileSync(join(f.sourceRoot, 'README.md'), 'utf8')).toContain(
    'synthetic distribution fixture',
  );
}

describe('private owned distribution pack/path/delegation contract', () => {
  it('uses real offline pack, keeps a thin five-file runtime, and preserves relative links', async () => {
    const f = fixture();
    const result = await prepare(f);
    const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'));
    expect(receipt.plugin.files['bin/init.mjs'].mode).toBe(0o755);
    expect(lstatSync(join(f.output, 'plugin/bin/init.mjs')).mode & 0o777).toBe(0o755);
    for (const name of f.runtimeFiles) {
      expect(readFileSync(join(f.output, 'plugin/plugin-runtime', name))).toEqual(
        readFileSync(join(f.sourceRoot, 'plugin-runtime', name)),
      );
      expect(receipt.plugin.files[`plugin-runtime/${name}`].sha256).toBe(
        sha256(readFileSync(join(f.sourceRoot, 'plugin-runtime', name))),
      );
    }
    expect(
      Object.keys(receipt.plugin.files)
        .filter((name) => name.startsWith('plugin-runtime/'))
        .sort(),
    ).toEqual(f.runtimeFiles.map((name) => `plugin-runtime/${name}`).sort());
    expect(
      Object.keys(receipt.plugin.files).some(
        (name) => name.includes('node_modules') || name.endsWith('.node'),
      ),
    ).toBe(false);
    expect(existsSync(join(f.output, 'plugin/plugin-runtime/node_modules'))).toBe(false);
    expect(
      readFileSync(
        join(f.sourceRoot, 'plugin-runtime/node_modules/native-fixture/addon.node'),
        'utf8',
      ),
    ).toContain('synthetic contamination');
    expect(lstatSync(join(f.output, 'owned-qmd')).mode & 0o777).toBe(0o700);
    expect(readlinkSync(join(f.output, 'owned-qmd/relative-link'))).toBe('payload.txt');
    expect(readFileSync(join(f.output, 'owned-qmd/relative-link'))).toEqual(
      readFileSync(join(f.candidate, 'payload.txt')),
    );
    const calls = readFileSync(f.calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([f.candidate, join(f.output, 'owned-qmd'), f.candidate]);
    expect(receipt.verifier.repository.head).toMatch(/^[a-f0-9]{40}$/);
    expect(receipt.source.dirty).toBe('');
    expect(receipt.owned.historicalCandidate.sourceSnapshot).toEqual({
      base: 'synthetic-only',
      uncommittedCandidate: true,
    });
  }, 30_000);

  it('copies npm portable modes while preserving group-writable source files', async () => {
    const f = fixture();
    chmodSync(join(f.sourceRoot, 'README.md'), 0o664);
    chmodSync(join(f.sourceRoot, 'bin/init.mjs'), 0o775);
    await prepare(f);
    expect(lstatSync(join(f.output, 'plugin/README.md')).mode & 0o777).toBe(0o644);
    expect(lstatSync(join(f.output, 'plugin/bin/init.mjs')).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(f.sourceRoot, 'README.md')).mode & 0o777).toBe(0o664);
    expect(lstatSync(join(f.sourceRoot, 'bin/init.mjs')).mode & 0o777).toBe(0o775);
  }, 30_000);

  it('refuses existing output and preserves its sentinel', async () => {
    const f = fixture();
    mkdirSync(f.output);
    put(join(f.output, 'keep'), 'owned output sentinel');
    await expect(prepare(f)).rejects.toThrow(/fresh/);
    expect(readFileSync(join(f.output, 'keep'), 'utf8')).toBe('owned output sentinel');
    noAcceptedReceipt(f);
  });

  it('refuses source/candidate overlap and a symlink ancestor redirect into source', async () => {
    const f = fixture();
    const alias = join(f.root, 'source-alias');
    symlinkSync(f.sourceRoot, alias, 'dir');
    for (const output of [
      join(f.sourceRoot, 'new-output'),
      join(f.candidate, 'new-output'),
      f.root,
      join(alias, 'new-output'),
    ]) {
      await expect(prepare(f, output)).rejects.toThrow(/overlaps/);
      expect(
        existsSync(
          output.endsWith('new-output') ? output : join(output, 'distribution-receipt.json'),
        ),
      ).toBe(false);
    }
    noAcceptedReceipt(f);
  });

  it('refuses a dangling output ancestor without creating its missing tail', async () => {
    const f = fixture();
    const alias = join(f.root, 'dangling');
    symlinkSync(join(f.root, 'missing'), alias, 'dir');
    await expect(prepare(f, join(alias, 'new-output'))).rejects.toThrow(/Dangling/);
    expect(existsSync(join(f.root, 'missing'))).toBe(false);
    noAcceptedReceipt(f);
  });

  it('refuses an output ancestor node_modules before accepting a tuple', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'node_modules'));
    await expect(prepare(f)).rejects.toThrow(/Ancestor node_modules/);
    noAcceptedReceipt(f);
  });

  it('refuses wrong manifest digest before creating output', async () => {
    const f = fixture();
    await expect(
      prepareOwnedDistribution({ ...f, expectedManifestSha256: '0'.repeat(64) }),
    ).rejects.toThrow(/manifest digest/);
    expect(existsSync(f.output)).toBe(false);
    noAcceptedReceipt(f);
  });

  it('refuses unsupported source/archive mode with no success receipt', async () => {
    const f = fixture();
    chmodSync(join(f.sourceRoot, 'README.md'), 0o600);
    await expect(prepare(f)).rejects.toThrow(/source\/archive mode|source file\/mode mismatch/);
    noAcceptedReceipt(f);
  }, 30_000);

  it('delegates tampered source candidate rejection before pack', async () => {
    const f = fixture();
    put(join(f.candidate, 'payload.txt'), 'tampered source candidate');
    await expect(prepare(f)).rejects.toThrow(/Synthetic verifier payload digest/);
    expect(existsSync(f.output)).toBe(false);
    noAcceptedReceipt(f);
  });

  it('delegates candidate mode tampering without treating a matching manifest as trust', async () => {
    const f = fixture();
    chmodSync(join(f.candidate, 'payload.txt'), 0o600);
    await expect(prepare(f)).rejects.toThrow(/Synthetic verifier mode mismatch/);
    expect(existsSync(f.output)).toBe(false);
    noAcceptedReceipt(f);
  });

  it('delegates tampered destination rejection without a success receipt', async () => {
    const f = fixture();
    put(f.control, 'tamper-destination');
    await expect(prepare(f)).rejects.toThrow(/Synthetic verifier payload digest/);
    noAcceptedReceipt(f);
  }, 30_000);

  it('refuses source drift during final delegated verification instead of signing mixed bytes', async () => {
    const f = fixture();
    put(f.control, 'mutate-source');
    await expect(prepare(f)).rejects.toThrow(/Source or verifier changed/);
    expect(readFileSync(join(f.sourceRoot, 'README.md'), 'utf8')).toBe(
      'changed during final verification\n',
    );
    expect(existsSync(join(f.output, 'distribution-receipt.json'))).toBe(false);
    expect(readFileSync(join(f.output, 'plugin/README.md'), 'utf8')).toBe(
      'synthetic distribution fixture\n',
    );
  }, 30_000);
});

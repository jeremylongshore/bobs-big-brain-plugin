import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  canonicalizeExistingOrMissing,
  validateBrainTarget,
  revalidateBrainTarget,
} from '../bin/installer-paths.mjs';

const roots: string[] = [];
const installer = fileURLToPath(new URL('../bin/init.mjs', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-installer-paths-'));
  roots.push(root);
  const home = join(root, 'home');
  const inputFolder = join(home, 'input');
  const outside = join(root, 'outside');
  for (const path of [home, inputFolder, outside]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, 'keep.txt'), 'home sentinel');
  writeFileSync(join(inputFolder, 'source.md'), 'synthetic source');
  writeFileSync(join(outside, 'keep.txt'), 'outside sentinel');
  symlinkSync(home, join(home, 'home-alias'), 'dir');
  symlinkSync(outside, join(home, 'escape'), 'dir');
  symlinkSync(join(outside, 'missing'), join(home, 'dangling'), 'dir');
  return { root, home, inputFolder, outside };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installer target validation', () => {
  it('accepts default and nested missing targets without creating them', () => {
    const f = fixture();
    for (const base of [join(f.home, '.teamkb'), join(f.home, 'new', 'nested', 'brain')]) {
      const plan = validateBrainTarget({ ...f, base });
      expect(plan.basePath).toBe(base);
      expect(revalidateBrainTarget(plan)).toEqual(plan);
      expect(existsSync(base)).toBe(false);
    }
    expect(existsSync(join(f.home, 'new'))).toBe(false);
  });

  it('canonicalizes an internal alias and accepts a disjoint existing brain', () => {
    const f = fixture();
    const base = join(f.home, 'brain');
    mkdirSync(base);
    symlinkSync(base, join(f.home, 'brain-alias'), 'dir');
    const plan = validateBrainTarget({ ...f, base: join(f.home, 'brain-alias'), clean: true });
    expect(plan.basePath).toBe(base);
    expect(revalidateBrainTarget(plan)).toEqual(plan);
    expect(readFileSync(join(f.inputFolder, 'source.md'), 'utf8')).toBe('synthetic source');
  });

  it('canonicalizes an aliased HOME before requiring a proper descendant', () => {
    const f = fixture();
    const alias = join(f.root, 'home-spelling');
    symlinkSync(f.home, alias, 'dir');
    expect(validateBrainTarget({ ...f, home: alias, base: join(alias, 'new') }).basePath).toBe(
      join(f.home, 'new'),
    );
    expect(() => validateBrainTarget({ ...f, home: alias, base: f.home })).toThrow(
      /strict descendant/,
    );
  });

  it('refuses HOME, root, sibling prefixes and symlink escapes', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'home-sibling'));
    for (const base of [
      f.home,
      '/',
      join(f.home, 'home-alias'),
      join(f.root, 'home-sibling'),
      join(f.home, 'escape', 'new'),
    ]) {
      expect(() => validateBrainTarget({ ...f, base })).toThrow(/strict descendant/);
    }
    expect(existsSync(join(f.outside, 'new'))).toBe(false);
  });

  it('refuses dangling symlinks and existing file ancestors', () => {
    const f = fixture();
    expect(() => canonicalizeExistingOrMissing(join(f.home, 'dangling', 'new'))).toThrow();
    for (const base of [join(f.home, 'keep.txt'), join(f.home, 'keep.txt', 'new')]) {
      expect(() => validateBrainTarget({ ...f, base })).toThrow(/not a directory|ENOTDIR/i);
    }
  });

  it('refuses clean overlap in either direction, including aliases and missing tails', () => {
    const f = fixture();
    const nestedInput = join(f.inputFolder, 'nested');
    mkdirSync(nestedInput);
    symlinkSync(f.inputFolder, join(f.home, 'input-alias'), 'dir');
    for (const [base, inputFolder] of [
      [f.inputFolder, f.inputFolder],
      [f.inputFolder, nestedInput],
      [join(f.inputFolder, 'missing'), f.inputFolder],
      [join(f.home, 'input-alias'), nestedInput],
    ]) {
      expect(() => validateBrainTarget({ ...f, base, inputFolder, clean: true })).toThrow(
        /must not overlap/,
      );
    }
  });

  it('detects replacing an existing target at the same canonical path', () => {
    const f = fixture();
    const base = join(f.home, 'brain');
    mkdirSync(base);
    const plan = validateBrainTarget({ ...f, base, clean: true });
    renameSync(base, join(f.home, 'original-brain'));
    mkdirSync(base);
    expect(() => revalidateBrainTarget(plan)).toThrow(/changed after validation/);
  });

  it('detects replacing a missing target ancestor or redirecting an alias', () => {
    const f = fixture();
    const ancestor = join(f.home, 'new');
    mkdirSync(ancestor);
    const plan = validateBrainTarget({ ...f, base: join(ancestor, 'brain') });
    renameSync(ancestor, join(f.home, 'original-new'));
    mkdirSync(ancestor);
    expect(() => revalidateBrainTarget(plan)).toThrow(/changed after validation/);
    const alias = join(f.home, 'brain-alias');
    symlinkSync(ancestor, alias, 'dir');
    const throughAlias = validateBrainTarget({ ...f, base: join(alias, 'brain') });
    rmSync(alias);
    symlinkSync(f.outside, alias, 'dir');
    expect(() => revalidateBrainTarget(throughAlias)).toThrow(/strict descendant/);
  });
});

function guardedChild(f: ReturnType<typeof fixture>, argv: string[]) {
  const marker = join(f.root, 'side-effects.jsonl');
  const guard = join(f.root, 'guard.cjs');
  writeFileSync(
    guard,
    `
const fs = require('node:fs');
const cp = require('node:child_process');
const Module = require('node:module');
const record = fs.appendFileSync.bind(fs);
const refuse = (operation) => { record(${JSON.stringify(marker)}, JSON.stringify({operation})+'\\n'); throw new Error('fixture refused '+operation); };
fs.rmSync = () => refuse('clean');
for (const name of ['execFileSync','execSync','spawnSync','spawn','execFile','exec']) cp[name] = () => refuse('process:'+name);
const load = Module._load;
Module._load = function(name, ...args) {
  if (name.endsWith('.node') || /^(better-sqlite3|fs-ext|sqlite-vec)(\\/|$)/.test(name)) return refuse('native');
  return load.call(this,name,...args);
};
globalThis.fetch = () => refuse('fetch');
require('node:net').Socket.prototype.connect = () => refuse('socket');
Module.syncBuiltinESMExports();
`,
  );
  const result = spawnSync(process.execPath, ['--require', guard, ...argv], {
    cwd: f.root,
    env: { HOME: f.home, PATH: '/usr/bin:/bin', TMPDIR: f.root, COREPACK_ENABLE_NETWORK: '0' },
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  const attempts: { operation: string }[] = existsSync(marker)
    ? readFileSync(marker, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  return { result, attempts };
}

describe('actual installer refuses before side effects', () => {
  it('proves ESM named filesystem and process imports are guarded', () => {
    const f = fixture();
    const { result, attempts } = guardedChild(f, [
      '--input-type=module',
      '-e',
      `
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
try { rmSync(${JSON.stringify(f.home)}, { recursive: true }); } catch {}
try { execFileSync('npm', ['--version']); } catch {}
`,
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(attempts.map((a) => a.operation)).toEqual(['clean', 'process:execFileSync']);
    expect(readFileSync(join(f.home, 'keep.txt'), 'utf8')).toBe('home sentinel');
  });

  for (const kind of ['home', 'home-alias', 'sibling', 'escape', 'overlap', 'missing-overlap']) {
    it(`rejects ${kind} with no cleanup, native provisioning or process launch`, () => {
      const f = fixture();
      const sibling = join(f.root, 'home-sibling');
      mkdirSync(sibling);
      writeFileSync(join(sibling, 'keep.txt'), 'sibling sentinel');
      const targets: Record<string, string> = {
        home: f.home,
        'home-alias': join(f.home, 'home-alias'),
        sibling,
        escape: join(f.home, 'escape', 'new'),
        overlap: f.inputFolder,
        'missing-overlap': join(f.inputFolder, 'brain'),
      };
      const { result, attempts } = guardedChild(f, [
        installer,
        'init',
        f.inputFolder,
        '--base',
        targets[kind],
        '--clean',
        '--index-only',
        '--yes',
        '--no-register',
      ]);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        kind.includes('overlap') ? /must not overlap/ : /strict descendant/,
      );
      expect(attempts).toEqual([]);
      expect(readFileSync(join(f.home, 'keep.txt'), 'utf8')).toBe('home sentinel');
      expect(readFileSync(join(f.outside, 'keep.txt'), 'utf8')).toBe('outside sentinel');
      expect(readFileSync(join(sibling, 'keep.txt'), 'utf8')).toBe('sibling sentinel');
      expect(readFileSync(join(f.inputFolder, 'source.md'), 'utf8')).toBe('synthetic source');
      expect(existsSync(join(f.inputFolder, 'brain'))).toBe(false);
      expect(existsSync(join(f.outside, 'new'))).toBe(false);
    });
  }
});

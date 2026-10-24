import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateBrainTarget, revalidateBrainTarget } from '../bin/installer-paths.mjs';
import { prepareCleanBrain } from '../bin/installer-cleanup.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-cleanup-coordinator-'));
  roots.push(root);
  const home = join(root, 'home');
  const inputFolder = join(home, 'input');
  const base = join(home, 'brain');
  for (const path of [inputFolder, base]) mkdirSync(path, { recursive: true });
  writeFileSync(join(inputFolder, 'source.md'), 'input sentinel');
  writeFileSync(join(base, 'old.txt'), 'brain sentinel');
  return { root, home, inputFolder, base, clean: true };
}
describe('recoverable installer cleanup', () => {
  it('runs deterministic descriptor and recovery barriers through the shipped Python helper', () => {
    const output = execFileSync(
      '/usr/bin/python3',
      ['-I', '-S', '-B', fileURLToPath(new URL('./installer-cleanup.test.py', import.meta.url))],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output).toBe('');
  });
  it('retains the original identity and hands off a revalidated empty brain', () => {
    const f = fixture();
    const before = validateBrainTarget(f);
    const result = prepareCleanBrain(before);
    expect(result.status).toBe('retained');
    expect(readFileSync(join(result.backupPath!, 'old.txt'), 'utf8')).toBe('brain sentinel');
    expect(readdirSync(f.base)).toEqual([]);
    expect(revalidateBrainTarget(result.target)).toEqual(result.target);
    expect(result.target.identities.at(-1)?.inode).not.toBe(before.identities.at(-1)?.inode);
    expect(readFileSync(join(f.inputFolder, 'source.md'), 'utf8')).toBe('input sentinel');
  });
  it('does not create a missing target or its missing parents', () => {
    const f = fixture();
    const base = join(f.home, 'new', 'deep', 'brain');
    const result = prepareCleanBrain(validateBrainTarget({ ...f, base }));
    expect(result.status).toBe('absent');
    expect(result.backupPath).toBeNull();
    expect(existsSync(join(f.home, 'new'))).toBe(false);
    expect(readdirSync(f.home).sort()).toEqual(['brain', 'input']);
  });
  it('refuses changed targets and non-clean plans without moving data', () => {
    const f = fixture();
    expect(() => prepareCleanBrain(validateBrainTarget({ ...f, clean: false }))).toThrow(
      /explicitly validated/,
    );
    const plan = validateBrainTarget(f);
    renameSync(f.base, join(f.home, 'old-brain'));
    mkdirSync(f.base);
    writeFileSync(join(f.base, 'replacement'), 'replacement sentinel');
    expect(() => prepareCleanBrain(plan)).toThrow();
    expect(readFileSync(join(f.base, 'replacement'), 'utf8')).toBe('replacement sentinel');
    expect(readFileSync(join(f.home, 'old-brain', 'old.txt'), 'utf8')).toBe('brain sentinel');
    expect(readdirSync(f.home).some((name) => name.startsWith('.bbb-clean-'))).toBe(false);
  });
  it.each(['malformed', 'refused', 'unsafe-retained'])(
    'refuses a %s worker result before handoff',
    async (kind) => {
      const f = fixture();
      const copy = join(f.root, 'copied-bin');
      mkdirSync(copy);
      for (const name of ['installer-cleanup.mjs', 'installer-paths.mjs']) {
        copyFileSync(fileURLToPath(new URL(`../bin/${name}`, import.meta.url)), join(copy, name));
      }
      const response =
        kind === 'refused'
          ? {
              status: 'refused',
              reason: 'changed binding',
              recovery: 'retained',
              backupPath: join(f.root, 'moved-parent/.bbb-clean-fixture/original'),
            }
          : {
              status: 'retained',
              basePath: f.base,
              quarantinePath: f.inputFolder,
              backupPath: join(f.inputFolder, 'original'),
            };
      writeFileSync(
        join(copy, 'installer-cleanup.py'),
        kind === 'malformed'
          ? "print('invalid JSON')\n"
          : `print(${JSON.stringify(JSON.stringify(response))})\n`,
      );
      const coordinator = await import(pathToFileURL(join(copy, 'installer-cleanup.mjs')).href);
      expect(() => coordinator.prepareCleanBrain(validateBrainTarget(f))).toThrow(
        kind === 'malformed'
          ? /valid recovery result/
          : kind === 'refused'
            ? /moved-parent/
            : /invalid retained-backup location/,
      );
      expect(readFileSync(join(f.base, 'old.txt'), 'utf8')).toBe('brain sentinel');
      expect(readFileSync(join(f.inputFolder, 'source.md'), 'utf8')).toBe('input sentinel');
    },
  );
  it('isolates Python imports from inherited PYTHONPATH', () => {
    const f = fixture();
    const poison = join(f.root, 'poison');
    mkdirSync(poison);
    const marker = join(f.root, 'imported');
    writeFileSync(
      join(poison, 'ctypes.py'),
      `open(${JSON.stringify(marker)}, 'w').write('poison')\n`,
    );
    execFileSync('/usr/bin/python3', ['-S', '-B', '-c', 'import ctypes'], {
      env: { PYTHONPATH: poison },
    });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const previous = process.env.PYTHONPATH;
    try {
      process.env.PYTHONPATH = poison;
      expect(prepareCleanBrain(validateBrainTarget(f)).status).toBe('retained');
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = previous;
    }
  });
});

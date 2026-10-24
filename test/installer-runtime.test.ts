import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { QmdCommandProvenance } from '@qmd-team-intent-kb/qmd-adapter';
import {
  assertLocalInstallerMode,
  effectiveInstallerEnv,
  selectedQmdEnvironment,
  qmdAvailabilityOutcome,
  mcpRegistrationArgs,
  shellQuote,
} from '../bin/installer-runtime.mjs';
const require = createRequire(import.meta.url);
const bootstrap = require('../plugin-runtime/bootstrap.cjs');
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-installer-runtime-'));
  roots.push(root);
  const home = join(root, 'home');
  const runtime = join(root, 'plugin-runtime');
  mkdirSync(home);
  mkdirSync(runtime);
  return { root, home, runtime };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function owned(root: string): QmdCommandProvenance {
  return {
    source: 'owned',
    executable: '/node22',
    prefix: [join(root, 'bin/owned-qmd.mjs')],
    runtime: {
      declaredRoot: root,
      root,
      manifestSha256: 'a'.repeat(64),
      qmdVersion: '2.5.3',
      sdkVersion: '1.32.2',
      zodVersion: '4.6.7',
      nodeAbi: '127',
      lockSha256: 'b'.repeat(64),
      sourceSnapshot: {
        baseCommit: 'c'.repeat(40),
        uncommittedCandidate: true,
        sourceFilesSha256: 'd'.repeat(64),
      },
    },
  };
}
function checked(exitCode: number, provenance: QmdCommandProvenance | null = null, stdout = '') {
  return { result: { exitCode, stdout, stderr: 'selected fixture failure' }, provenance };
}

describe('effective local installer mode', () => {
  it('looks for team.json at the requested base, not an unrelated default brain', () => {
    const f = fixture();
    mkdirSync(join(f.home, '.teamkb'));
    writeFileSync(join(f.home, '.teamkb/team.json'), 'malformed default config');
    const base = join(f.home, 'new-brain');
    const env = effectiveInstallerEnv(
      { base, tenant: 'client' },
      { HOME: f.home, TEAMKB_HOME: join(f.home, '.teamkb') },
    );
    expect(env.TEAMKB_BASE_PATH).toBe(base);
    expect(env.TEAMKB_TENANT_ID).toBe('client');
    expect(() => assertLocalInstallerMode(env, bootstrap)).not.toThrow();
    expect(existsSync(base)).toBe(false);
  });

  it('refuses API team mode and any team.json at the requested base before parsing it', () => {
    const f = fixture();
    const base = join(f.home, 'brain');
    mkdirSync(base);
    const env = effectiveInstallerEnv(
      { base, tenant: 'client' },
      { HOME: f.home, TEAMKB_API_URL: 'https://team.invalid' },
    );
    expect(() => assertLocalInstallerMode(env, bootstrap)).toThrow(/Local init refuses/);
    delete env.TEAMKB_API_URL;
    writeFileSync(join(base, 'team.json'), 'malformed selected config');
    expect(() => assertLocalInstallerMode(env, bootstrap)).toThrow(/Local init refuses/);
  });
});

describe('selected qmd persistence and outcomes', () => {
  it('persists only the normalized owned pair and leaves a separate prefix untouched', () => {
    const f = fixture();
    const root = join(f.root, "owned runtime's prefix");
    mkdirSync(root);
    const env = selectedQmdEnvironment(owned(root), f.runtime);
    expect(Object.keys(env)).toEqual(['TEAMKB_QMD_RUNTIME']);
    expect(JSON.parse(env.TEAMKB_QMD_RUNTIME)).toEqual({ root, manifestSha256: 'a'.repeat(64) });
    expect(env.TEAMKB_QMD_BIN).toBeUndefined();
  });

  it('refuses persistence inside either lexical or symlinked native node_modules', () => {
    const f = fixture();
    const nm = join(f.runtime, 'node_modules');
    mkdirSync(nm);
    const nested = join(nm, 'owned');
    mkdirSync(nested);
    expect(() => selectedQmdEnvironment(owned(nested), f.runtime)).toThrow(/separate prefix/);
    rmSync(nm, { recursive: true });
    const outside = join(f.root, 'native-target');
    mkdirSync(outside);
    symlinkSync(outside, nm, 'dir');
    expect(() => selectedQmdEnvironment(owned(outside), f.runtime)).toThrow(/separate prefix/);
  });

  it('does not implicitly pin legacy discovery or persist a relative explicit command', () => {
    const f = fixture();
    for (const source of ['path', 'bun-default'] as const) {
      expect(
        selectedQmdEnvironment({ source, executable: '/legacy/qmd', prefix: [] }, f.runtime),
      ).toEqual({});
    }
    expect(selectedQmdEnvironment(null, f.runtime)).toEqual({});
    expect(() =>
      selectedQmdEnvironment(
        { source: 'explicit', executable: './literal', prefix: [] },
        f.runtime,
      ),
    ).toThrow(/relative explicit/);
  });

  it('normalizes a successful relative env pin before a later different-cwd launch', () => {
    const f = fixture();
    const tools = join(f.root, 'tools');
    mkdirSync(tools);
    symlinkSync(process.execPath, join(tools, 'node'));
    const selected = join(tools, 'qmd');
    writeFileSync(
      selected,
      '#!/usr/bin/env node\nprocess.stdout.write("selected owned fixture");\n',
    );
    chmodSync(selected, 0o700);
    const helper = new URL('../bin/installer-runtime.mjs', import.meta.url).href;
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { selectedQmdEnvironment } from ${JSON.stringify(helper)};
console.log(JSON.stringify(selectedQmdEnvironment({source:'env',executable:'tools/qmd',prefix:[]}, ${JSON.stringify(f.runtime)})));
`,
      ],
      {
        cwd: f.root,
        env: { HOME: f.home, PATH: tools },
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const env = JSON.parse(probe.stdout);
    expect(env.TEAMKB_QMD_BIN).toBe(selected);
    const elsewhere = join(f.root, 'elsewhere');
    mkdirSync(elsewhere);
    const run = spawnSync(env.TEAMKB_QMD_BIN, [], {
      cwd: elsewhere,
      env: { HOME: f.home, PATH: tools },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('selected owned fixture');
  });

  it('refuses failed declared choices but permits undeclared legacy degradation', () => {
    const f = fixture();
    expect(() => qmdAvailabilityOutcome(checked(127), { TEAMKB_QMD_RUNTIME: 'broken' })).toThrow(
      /before local capture/,
    );
    expect(() => qmdAvailabilityOutcome(checked(127), { TEAMKB_QMD_BIN: './broken' })).toThrow(
      /before local capture/,
    );
    expect(() => qmdAvailabilityOutcome(checked(124, owned(f.root)), {})).toThrow(
      /before local capture/,
    );
    expect(qmdAvailabilityOutcome(checked(127), {})).toMatchObject({ available: false });
  });

  it('does not validate an unused bad owned declaration when the explicit env pin succeeded', () => {
    const selected: QmdCommandProvenance = {
      source: 'env',
      executable: '/selected/qmd',
      prefix: [],
    };
    expect(
      qmdAvailabilityOutcome(checked(0, selected, 'qmd 2.5.3'), {
        TEAMKB_QMD_BIN: '/selected/qmd',
        TEAMKB_QMD_RUNTIME: 'broken unused declaration',
      }).available,
    ).toBe(true);
    expect(() => qmdAvailabilityOutcome(checked(0, selected, 'qmd 1.0.0'), {})).toThrow(/too old/);
  });

  it('reports the exit code when a timed-out version check printed a version but no stderr', () => {
    const f = fixture();
    const timedOut = {
      provenance: owned(f.root),
      result: { exitCode: 124, stdout: 'qmd 2.5.3\n', stderr: '' },
    };
    expect(() => qmdAvailabilityOutcome(timedOut, {})).toThrow(/exited with code 124/);
    expect(qmdAvailabilityOutcome({ ...timedOut, provenance: null }, {})).toMatchObject({
      available: false,
      reason: 'qmd availability exited with code 124',
    });
  });
});

describe('MCP registration and manual shell rendering', () => {
  it('routes bootstrap and exact selected env without credentials or shell retargeting', () => {
    const f = fixture();
    const args = {
      base: join(f.home, "brain's space"),
      tenant: "tenant's space",
      scope: 'user space',
      qmdEnvironment: {
        TEAMKB_QMD_RUNTIME: JSON.stringify({
          root: join(f.root, "owned's space"),
          manifestSha256: 'a'.repeat(64),
        }),
      },
    };
    const argv = mcpRegistrationArgs(args, join(f.runtime, "bootstrap's path.cjs"));
    expect(argv.slice(-3)).toEqual(['--', 'node', join(f.runtime, "bootstrap's path.cjs")]);
    expect(argv).toContain(`TEAMKB_BASE_PATH=${args.base}`);
    expect(argv).toContain(`TEAMKB_TENANT_ID=${args.tenant}`);
    expect(argv).toContain(`TEAMKB_QMD_RUNTIME=${args.qmdEnvironment.TEAMKB_QMD_RUNTIME}`);
    const rendered = spawnSync(
      '/bin/sh',
      ['-c', `printf '%s\\n' ${argv.map(shellQuote).join(' ')}`],
      { env: { HOME: f.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5_000 },
    );
    expect(rendered.status).toBe(0);
    expect(rendered.stdout.trimEnd().split('\n')).toEqual(argv);
  });
});

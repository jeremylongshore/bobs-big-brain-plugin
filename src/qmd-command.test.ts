import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, QmdCommandProvenance } from '@qmd-team-intent-kb/qmd-adapter';

interface State {
  executorOptions: Record<string, unknown>[];
  adapterOptions: Record<string, unknown>[];
  instances: object[];
  passedExecutors: object[];
  commands: string[][];
  result: CommandResult;
  provenance: QmdCommandProvenance | null;
}
const state = vi.hoisted<State>(() => ({
  executorOptions: [],
  adapterOptions: [],
  instances: [],
  passedExecutors: [],
  commands: [],
  result: { stdout: 'qmd 2.5.3', stderr: '', exitCode: 0 },
  provenance: null,
}));
const dense = vi.hoisted(() => ({ token: 'shared dense config' }));
vi.mock('@qmd-team-intent-kb/qmd-adapter', () => ({
  RealQmdExecutor: class {
    constructor(options: Record<string, unknown>) {
      state.executorOptions.push(options);
      state.instances.push(this);
    }
    async execute(args: string[]) {
      state.commands.push(args);
      return state.result;
    }
    get commandProvenance() {
      return state.provenance;
    }
  },
  QmdAdapter: class {
    constructor(options: Record<string, unknown>, executor: object) {
      state.adapterOptions.push(options);
      state.passedExecutors.push(executor);
    }
  },
  getDefaultDenseConfig: () => dense,
  getQmdTenantEnv: (tenantId: string, basePath: string) => ({
    INDEX_PATH: `${basePath}/${tenantId}/index.sqlite`,
    QMD_CONFIG_DIR: `${basePath}/${tenantId}/config`,
  }),
  withQmdTenantSelector: (args: string[]) => [...args, '--index', 'index'],
}));

beforeEach(() => {
  state.executorOptions = [];
  state.adapterOptions = [];
  state.instances = [];
  state.passedExecutors = [];
  state.commands = [];
  state.result = { stdout: 'qmd 2.5.3', stderr: '', exitCode: 0 };
  state.provenance = null;
});
afterEach(() => vi.restoreAllMocks());
const config = {
  tenantId: 'client tenant',
  basePath: '/private/nondefault-brain',
  exportDir: '/private/export',
};

describe('shared local qmd binding', () => {
  it('does not construct or execute anything on import', async () => {
    await import('./qmd-command.js');
    expect(state.executorOptions).toEqual([]);
    expect(state.adapterOptions).toEqual([]);
    expect(state.commands).toEqual([]);
  });

  it('binds the same base and tenant while preserving explicit options and dense defaults', async () => {
    const { createLocalQmdBinding } = await import('./qmd-command.js');
    const runtime = { root: '/separate/owned-prefix', manifestSha256: 'a'.repeat(64) };
    await createLocalQmdBinding({
      ...config,
      qmdBinary: './literal-executable',
      qmdRuntime: runtime,
    });
    expect(state.executorOptions).toEqual([
      {
        binary: './literal-executable',
        ownedRuntime: runtime,
        tenant: { id: config.tenantId, basePath: config.basePath },
      },
    ]);
    expect(state.adapterOptions).toEqual([{ ...config, dense }]);
    expect(state.passedExecutors).toEqual([state.instances[0]]);
    expect(state.commands).toEqual([]);
  });

  it('deducts elapsed loading time from the original five-second availability deadline', async () => {
    const { checkLocalQmd } = await import('./qmd-command.js');
    vi.spyOn(Date, 'now').mockReturnValue(1_200);
    const checked = await checkLocalQmd(config, 6_000);
    expect(state.executorOptions[0].timeout).toBe(4_800);
    expect(state.executorOptions[0].tenant).toBeUndefined();
    expect(state.executorOptions[0].env).toEqual({
      INDEX_PATH: `${config.basePath}/${config.tenantId}/index.sqlite`,
      QMD_CONFIG_DIR: `${config.basePath}/${config.tenantId}/config`,
    });
    expect(state.commands).toEqual([['--version', '--index', 'index']]);
    expect(checked.result).toBe(state.result);
  });

  it('refuses an exhausted deadline without creating an executor', async () => {
    const { checkLocalQmd } = await import('./qmd-command.js');
    vi.spyOn(Date, 'now').mockReturnValue(7_000);
    const checked = await checkLocalQmd(config, 6_000);
    expect(checked.result.exitCode).toBe(124);
    expect(state.executorOptions).toEqual([]);
    expect(state.commands).toEqual([]);
  });

  it('preserves the shared executor failure without running a legacy alternative', async () => {
    const { checkLocalQmd } = await import('./qmd-command.js');
    state.result = {
      stdout: '',
      stderr: 'Declared owned runtime refused; no fallback',
      exitCode: 127,
    };
    const checked = await checkLocalQmd(config);
    expect(checked.result).toBe(state.result);
    expect(checked.provenance).toBeNull();
    expect(state.executorOptions).toHaveLength(1);
    expect(state.commands).toEqual([['--version', '--index', 'index']]);
  });

  it('keeps owned provenance including source bindings without calling Node a qmd binary', async () => {
    const { createLocalQmdBinding, legacyQmdBinary } = await import('./qmd-command.js');
    const binding = await createLocalQmdBinding(config);
    state.provenance = {
      source: 'owned',
      executable: '/node22',
      prefix: ['/owned/bin/owned-qmd.mjs'],
      runtime: {
        declaredRoot: '/owned-alias',
        root: '/owned',
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
    expect(binding.provenance()).toBe(state.provenance);
    expect(legacyQmdBinary(binding.provenance())).toBeUndefined();
    expect(binding.provenance()?.runtime?.sourceSnapshot.uncommittedCandidate).toBe(true);
  });

  it('retains representable legacy receipts without re-resolving relative explicit commands', async () => {
    const { legacyQmdBinary } = await import('./qmd-command.js');
    expect(legacyQmdBinary({ source: 'env', executable: '/selected/qmd', prefix: [] })).toEqual({
      path: '/selected/qmd',
      source: 'env',
    });
    expect(
      legacyQmdBinary({ source: 'explicit', executable: './literal-qmd', prefix: [] }),
    ).toBeUndefined();
  });
});

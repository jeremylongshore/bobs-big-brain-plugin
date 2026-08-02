import { afterEach, describe, expect, it, vi } from 'vitest';

// CI intentionally removes the private Registrar sibling links before running
// this package's unit suite. The test only needs the base-path helper's
// contract, so keep that dependency boundary explicit and mock the helper.
vi.mock('@qmd-team-intent-kb/common', () => ({
  getTeamKbBasePath: () => process.env['TEAMKB_BASE_PATH']?.trim() || '/tmp/teamkb',
}));

import { resolveConfig, resolveQmdIndexPath } from './config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('local BYO-brain configuration', () => {
  it('derives a tenant-scoped qmd index below the configured brain root', () => {
    expect(resolveQmdIndexPath('/tmp/fork-brain', 'my-tenant')).toBe(
      '/tmp/fork-brain/qmd-index/my-tenant',
    );
  });

  it('resolves the complete local storage contract from explicit overrides', () => {
    vi.stubEnv('TEAMKB_BASE_PATH', '/tmp/fork-brain');
    vi.stubEnv('TEAMKB_TENANT_ID', 'my-tenant');
    vi.stubEnv('TEAMKB_EXPORT_DIR', '/tmp/fork-export');

    expect(resolveConfig()).toEqual({
      tenantId: 'my-tenant',
      basePath: '/tmp/fork-brain',
      spoolPath: '/tmp/fork-brain/spool',
      dbPath: '/tmp/fork-brain/teamkb.db',
      feedbackPath: '/tmp/fork-brain/feedback',
      exportDir: '/tmp/fork-export',
      qmdIndexPath: '/tmp/fork-brain/qmd-index/my-tenant',
    });
  });

  it('keeps the safe local defaults when tenant and export overrides are blank', () => {
    vi.stubEnv('TEAMKB_BASE_PATH', '/tmp/fork-brain');
    vi.stubEnv('TEAMKB_TENANT_ID', '   ');
    vi.stubEnv('TEAMKB_EXPORT_DIR', '   ');

    expect(resolveConfig()).toMatchObject({
      tenantId: 'local',
      basePath: '/tmp/fork-brain',
      exportDir: '/tmp/fork-brain/kb-export',
      qmdIndexPath: '/tmp/fork-brain/qmd-index/local',
    });
  });
});

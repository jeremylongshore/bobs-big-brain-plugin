import { join } from 'node:path';
import { getTeamKbBasePath } from '@qmd-team-intent-kb/common';

/**
 * Resolved configuration for the local governed brain.
 *
 * This is a single-user, local-first replica of the INTKB mcp-server config
 * resolution (which is not exported from its package). Differences from the
 * team server, by design:
 *   - tenantId defaults to "local" (the team server requires it and throws);
 *     a single owner collapses every repo/cwd to one brain.
 *   - role is always the owner ("admin"): local mode is a single trust domain,
 *     so write tools are always available. There is no server to re-enforce a
 *     role boundary, and there is no boundary to protect on a personal machine.
 *   - apiUrl/apiToken are intentionally absent: search runs in-process against
 *     the local qmd index, never over the network.
 */
export interface BrainConfig {
  tenantId: string;
  basePath: string;
  spoolPath: string;
  dbPath: string;
  feedbackPath: string;
  exportDir: string;
  /** Derived qmd registry/cache root for this brain's tenant. */
  qmdIndexPath: string;
}

/**
 * Resolve the qmd index root used by the Registrar adapter.
 *
 * qmd's registry and BM25 cache are isolated below this path through XDG
 * overrides. Keeping the derivation here makes the local BYO-brain contract
 * visible without introducing a second, plugin-only qmd path setting.
 */
export function resolveQmdIndexPath(basePath: string, tenantId: string): string {
  return join(basePath, 'qmd-index', tenantId);
}

export function resolveConfig(): BrainConfig {
  const tenantId = (process.env['TEAMKB_TENANT_ID'] ?? 'local').trim() || 'local';
  const basePath = getTeamKbBasePath();
  const envExport = process.env['TEAMKB_EXPORT_DIR']?.trim();
  return {
    tenantId,
    basePath,
    spoolPath: join(basePath, 'spool'),
    dbPath: join(basePath, 'teamkb.db'),
    feedbackPath: join(basePath, 'feedback'),
    exportDir: envExport && envExport.length > 0 ? envExport : join(basePath, 'kb-export'),
    qmdIndexPath: resolveQmdIndexPath(basePath, tenantId),
  };
}

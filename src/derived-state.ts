import { runExport } from '@qmd-team-intent-kb/git-exporter';
import type { MemoryRepository, ExportStateRepository } from '@qmd-team-intent-kb/store';
import type {
  ResolvedQmdBinary,
  QmdCommandProvenance,
  QmdError,
} from '@qmd-team-intent-kb/qmd-adapter';
import { createLocalQmdBinding, legacyQmdBinary } from './qmd-command.js';
import type { BrainConfig } from './config.js';

/** Real counts from one export reconcile pass. */
export interface ExportSummary {
  written: number;
  archived: number;
  removed: number;
  /** Files already correct and left untouched. */
  unchanged: number;
  /** Memories set aside (unmappable category / write failure), never silently dropped. */
  quarantined: number;
  /** Orphan removals refused by the mass-delete guard (empty/wrong DB protection). */
  removalBlocked?: { orphans: number; limit: number };
}

/** Compose a qmd failure into one line: the message, plus the stderr tail if any. */
function describeQmdError(error: QmdError): string {
  const tail = error.stderr?.trim().split('\n').slice(-3).join(' | ');
  return tail !== undefined && tail !== '' && error.code !== 'not_available'
    ? `${error.message}: ${tail}`
    : error.message;
}

export interface DerivedSummary {
  exported: number;
  export?: ExportSummary;
  exportError?: string;
  indexUpdated: boolean;
  indexError?: string;
  qmdBinary?: ResolvedQmdBinary;
  qmdCommand?: QmdCommandProvenance;
}

/** Reconcile derived files/indexes only; never ingest or govern pending candidates.
 * Call under the existing brain write lock. Errors are reported independently of
 * any preceding committed disposition; this function does not roll it back.
 */
export async function refreshDerivedState(
  config: BrainConfig,
  deps: { memoryRepo: MemoryRepository; exportStateRepo: ExportStateRepository },
): Promise<DerivedSummary> {
  const { memoryRepo, exportStateRepo } = deps;
  // 3. RECONCILE the markdown tree with the DB (file generation only). Not an
  //    incremental "export what was just promoted": lifecycle changes made
  //    outside a promotion (curator batch-transition, brain_transition) never
  //    produce a promotion, so an incremental pass reported `exported: 0` and
  //    left archived/superseded memories sitting in their active directories.
  //    Reconcile converges the whole tree on the DB (write, archive-move, remove
  //    stale) and is content-compared, so it is idempotent and crash-repairing.
  let exported = 0;
  let exportSummary: ExportSummary | undefined;
  let exportError: string | undefined;
  try {
    const ex = await runExport(
      memoryRepo,
      exportStateRepo,
      {
        outputDir: config.exportDir,
        targetId: 'kb-export-default',
        tenantId: config.tenantId,
        reconcile: true,
      },
      () => new Date().toISOString(),
    );
    exportSummary = {
      written: ex.written.length,
      archived: ex.archived.length,
      removed: ex.removed.length,
      unchanged: ex.unchanged,
      quarantined: ex.quarantined.length,
      ...(ex.removalBlocked !== undefined ? { removalBlocked: ex.removalBlocked } : {}),
    };
    exported = exportSummary.written + exportSummary.archived + exportSummary.removed;
  } catch (e) {
    exportError = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[govern] export failed: ${exportError}\n`);
  }

  // 4. Refresh through the shared command route. A declared owned artifact
  // stays selected; no legacy pre-resolution can pin over its Node prefix.
  // Governance/export/audit still complete when the refresh fails.
  let indexUpdated = false;
  let indexError: string | undefined;
  let qmdCommand: QmdCommandProvenance | undefined;
  let qmdBinary: ResolvedQmdBinary | undefined;
  try {
    const binding = await createLocalQmdBinding(config);
    try {
      const ensure = await binding.adapter.ensureCollections();
      if (!ensure.ok) throw new Error(describeQmdError(ensure.error));
      const upd = await binding.adapter.update();
      if (!upd.ok) throw new Error(describeQmdError(upd.error));
      indexUpdated = true;
    } finally {
      qmdCommand = binding.provenance() ?? undefined;
      qmdBinary = legacyQmdBinary(qmdCommand ?? null);
    }
  } catch (e) {
    indexError = e instanceof Error ? e.message : String(e);
  }

  return {
    exported,
    ...(exportSummary !== undefined ? { export: exportSummary } : {}),
    ...(exportError !== undefined ? { exportError } : {}),
    indexUpdated,
    indexError,
    ...(qmdBinary !== undefined ? { qmdBinary } : {}),
    ...(qmdCommand !== undefined ? { qmdCommand } : {}),
  };
}

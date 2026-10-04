/**
 * Human-facing message for one local-mode brain_govern result.
 * Pure string formatting — no DB, no qmd packages (CI-safe).
 *
 * Empty-spool / empty-inbox all-zeros used to look like a silent failure
 * ("Governed 0 inbox candidate(s)…"). Callers need to know that is the
 * healthy idle state, not a stuck pipeline. But "idle" must not hide real
 * work: a lifecycle change (batch-transition) produces no inbox activity yet
 * still moves files in the export tree, so export changes break idleness.
 */
export interface GovernMessageInput {
  ingested: number;
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  quarantined: number;
  skipped: number;
  indexUpdated: boolean;
  /** Files the export reconcile changed (written + archived + removed). */
  exported?: number;
  /** Per-operation export counts. */
  export?: {
    written: number;
    archived: number;
    removed: number;
    unchanged: number;
    quarantined: number;
    removalBlocked?: { orphans: number; limit: number };
  };
  exportError?: string;
  /** Why the index was not refreshed (missing qmd carries the fix). */
  indexError?: string;
}

/** True only when the inbox did nothing AND the export tree needed no changes. */
export function isIdle(s: GovernMessageInput): boolean {
  return (
    s.ingested === 0 &&
    s.processed === 0 &&
    s.promoted === 0 &&
    s.rejected === 0 &&
    s.flagged === 0 &&
    s.duplicates === 0 &&
    s.quarantined === 0 &&
    s.skipped === 0 &&
    (s.exported ?? 0) === 0
  );
}

/** One sentence on the export reconcile, or '' when there is nothing to say. */
function exportSentence(s: GovernMessageInput): string {
  const parts: string[] = [];
  if (s.exportError !== undefined) {
    parts.push(` Export FAILED: ${s.exportError}.`);
  } else if (s.export !== undefined) {
    const e = s.export;
    if (e.written + e.archived + e.removed > 0) {
      parts.push(
        ` Export reconciled: ${e.written} written, ${e.archived} archived, ${e.removed} removed (${e.unchanged} unchanged).`,
      );
    }
    if (e.quarantined > 0) {
      parts.push(` ${e.quarantined} memory(ies) could not be exported and were set aside.`);
    }
    if (e.removalBlocked !== undefined) {
      parts.push(
        ` Refused to remove ${e.removalBlocked.orphans} orphan export file(s) (over the safety cap of ${e.removalBlocked.limit}); check the brain DB is the right one.`,
      );
    }
  }
  return parts.join('');
}

/** One sentence on the index refresh, or '' when it succeeded. */
function indexSentence(s: GovernMessageInput): string {
  if (s.indexUpdated) return '';
  return s.indexError !== undefined && s.indexError !== ''
    ? ` Search index NOT refreshed: ${s.indexError}`
    : ' Search index not refreshed — install qmd 2.x (on PATH, ~/.bun/bin, or TEAMKB_QMD_BIN) and re-run brain_govern to make new memories searchable.';
}

export function formatGovernMessage(s: GovernMessageInput): string {
  if (isIdle(s)) {
    return (
      'Nothing to govern — spool and inbox are empty (not a failure). ' +
      'Capture something first with /brain-save (or brain_capture), then run brain_govern again.' +
      exportSentence(s) +
      indexSentence(s)
    );
  }

  const parts = [
    `${s.promoted} promoted`,
    `${s.quarantined} quarantined`,
    `${s.rejected} rejected`,
    `${s.duplicates} duplicate`,
    `${s.flagged} flagged`,
  ];
  if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
  return (
    `Governed ${s.processed} inbox candidate(s) (${s.ingested} newly ingested): ${parts.join(', ')}.` +
    exportSentence(s) +
    indexSentence(s)
  );
}

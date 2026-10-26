/**
 * Human-facing message for one local-mode brain_govern result.
 * Pure string formatting — no DB, no qmd packages (CI-safe).
 *
 * Counters describe this pass, not an exhaustive spool/inbox census. Refusals
 * and unavailable intake must not look like a healthy no-op. Lifecycle changes
 * also produce no inbox activity while moving files in the export tree.
 */
export interface GovernMessageInput {
  ingested: number;
  /** Structural view of the canonical summary keeps this formatter CI-safe. */
  intake: {
    disclosureRejectedCandidates: number;
    tamperedFiles: number;
    admissionRejectedFiles: number;
  } | null;
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  quarantined: number;
  skipped: number;
  /** Candidates put on a bounded human-escalation hold this run (K6). */
  held?: number;
  /** Would-be holds refused because the hold queue is full; left unpromoted. */
  holdCapBlocked?: number;
  /** Holds closed UNPROMOTED this run because their expiry elapsed. */
  holdsExpired?: number;
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

/** No observed intake refusals, inbox activity or export changes in this pass. */
export function isIdle(s: GovernMessageInput): boolean {
  return (
    s.intake !== null &&
    s.intake.disclosureRejectedCandidates === 0 &&
    s.intake.tamperedFiles === 0 &&
    s.intake.admissionRejectedFiles === 0 &&
    s.ingested === 0 &&
    s.processed === 0 &&
    s.promoted === 0 &&
    s.rejected === 0 &&
    s.flagged === 0 &&
    s.duplicates === 0 &&
    s.quarantined === 0 &&
    s.skipped === 0 &&
    (s.held ?? 0) === 0 &&
    (s.holdsExpired ?? 0) === 0 &&
    (s.exported ?? 0) === 0
  );
}

function intakeSentence(s: GovernMessageInput): string {
  if (s.intake === null) {
    return ' Spool intake failed; intake counts are unavailable. Other inbox work may still have completed.';
  }
  const i = s.intake;
  if (i.disclosureRejectedCandidates + i.tamperedFiles + i.admissionRejectedFiles === 0) return '';
  return ` Spool intake observed ${i.disclosureRejectedCandidates} disclosure-refused candidate(s), ${i.tamperedFiles} tampered file(s), and ${i.admissionRejectedFiles} admission-refused file(s). These counts are separate from inbox decisions; retained raw input may still contain refused content.`;
}

/** One sentence on the human-escalation hold queue, or '' when nothing happened. */
function holdSentence(s: GovernMessageInput): string {
  const parts: string[] = [];
  if ((s.held ?? 0) > 0) {
    parts.push(
      ` ${s.held} candidate(s) are on hold for a person to resolve (curator-cli holds list); they were neither promoted nor dropped.`,
    );
  }
  if ((s.holdCapBlocked ?? 0) > 0) {
    parts.push(
      ` ${s.holdCapBlocked} more need human review but the hold queue is full; they were left in the inbox, unpromoted.`,
    );
  }
  if ((s.holdsExpired ?? 0) > 0) {
    parts.push(` ${s.holdsExpired} hold(s) expired unresolved and were closed without promotion.`);
  }
  return parts.join('');
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
      'No intake refusals, inbox activity or export changes were observed in this pass. ' +
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
  if ((s.held ?? 0) > 0) parts.push(`${s.held} held`);
  return (
    `Governed ${s.processed} inbox candidate(s) (${s.ingested} newly ingested): ${parts.join(', ')}.` +
    intakeSentence(s) +
    holdSentence(s) +
    exportSentence(s) +
    indexSentence(s)
  );
}

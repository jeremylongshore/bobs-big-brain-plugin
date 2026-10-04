import { describe, expect, it } from 'vitest';
import { formatGovernMessage, isIdle } from './govern-message.js';

const zeros = {
  ingested: 0,
  processed: 0,
  promoted: 0,
  rejected: 0,
  flagged: 0,
  duplicates: 0,
  quarantined: 0,
  skipped: 0,
  indexUpdated: true,
};

describe('formatGovernMessage', () => {
  it('idle all-zeros is not a failure — names empty spool/inbox and next step', () => {
    const msg = formatGovernMessage(zeros);
    expect(msg).toMatch(/not a failure/i);
    expect(msg).toMatch(/empty/i);
    expect(msg).toMatch(/brain_capture|\/brain-save/);
    expect(msg).not.toMatch(/^Governed 0 inbox/);
  });

  it('idle with missing index still mentions qmd', () => {
    const msg = formatGovernMessage({ ...zeros, indexUpdated: false });
    expect(msg).toMatch(/qmd/i);
  });

  it('non-idle keeps the counts summary', () => {
    const msg = formatGovernMessage({
      ingested: 2,
      processed: 3,
      promoted: 1,
      rejected: 1,
      flagged: 0,
      duplicates: 1,
      quarantined: 0,
      skipped: 0,
      indexUpdated: true,
    });
    expect(msg).toMatch(/^Governed 3 inbox candidate/);
    expect(msg).toContain('2 newly ingested');
    expect(msg).toContain('1 promoted');
    expect(msg).toContain('1 rejected');
    expect(msg).toContain('1 duplicate');
  });

  it('includes skipped when > 0', () => {
    const msg = formatGovernMessage({
      ingested: 0,
      processed: 1,
      promoted: 0,
      rejected: 0,
      flagged: 0,
      duplicates: 0,
      quarantined: 0,
      skipped: 1,
      indexUpdated: true,
    });
    expect(msg).toContain('1 skipped');
    expect(msg).not.toMatch(/not a failure/i);
  });
});

describe('formatGovernMessage — export reconcile + index reason', () => {
  const exp = { written: 0, archived: 3, removed: 1, unchanged: 40, quarantined: 0 };

  it('a lifecycle-only run (no inbox activity) is NOT reported as idle', () => {
    const s = { ...zeros, exported: 4, export: exp };
    expect(isIdle(s)).toBe(false);
    const msg = formatGovernMessage(s);
    expect(msg).not.toMatch(/Nothing to govern/);
    expect(msg).toContain('Export reconciled: 0 written, 3 archived, 1 removed (40 unchanged).');
  });

  it('idle with a clean, unchanged export stays idle and adds no export noise', () => {
    const s = { ...zeros, exported: 0, export: { ...exp, archived: 0, removed: 0 } };
    expect(isIdle(s)).toBe(true);
    expect(formatGovernMessage(s)).not.toMatch(/Export reconciled/);
  });

  it('reports quarantined export rows and a refused mass-delete', () => {
    const msg = formatGovernMessage({
      ...zeros,
      exported: 1,
      export: {
        ...exp,
        quarantined: 2,
        removalBlocked: { orphans: 90, limit: 50 },
      },
    });
    expect(msg).toContain('2 memory(ies) could not be exported');
    expect(msg).toContain('Refused to remove 90 orphan export file(s)');
    expect(msg).toContain('safety cap of 50');
  });

  it('an export failure is loud, even when otherwise idle', () => {
    const msg = formatGovernMessage({ ...zeros, exportError: 'EACCES: permission denied' });
    expect(msg).toContain('Export FAILED: EACCES: permission denied');
  });

  it('surfaces the actionable index error verbatim instead of a generic hint', () => {
    const reason = 'qmd binary not found (searched: PATH, /h/.bun/bin/qmd). Set TEAMKB_QMD_BIN=...';
    const msg = formatGovernMessage({ ...zeros, indexUpdated: false, indexError: reason });
    expect(msg).toContain(`Search index NOT refreshed: ${reason}`);
  });

  it('falls back to the generic install hint only when no reason was recorded', () => {
    const msg = formatGovernMessage({ ...zeros, indexUpdated: false });
    expect(msg).toContain('TEAMKB_QMD_BIN');
    expect(msg).toContain('~/.bun/bin');
  });

  it('no index sentence at all when the index refreshed', () => {
    expect(formatGovernMessage({ ...zeros, indexUpdated: true })).not.toMatch(/index/i);
  });
});

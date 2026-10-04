import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ingestFromSpool,
  Curator,
  expireHolds,
  holdLimitsFromEnv,
} from '@qmd-team-intent-kb/curator';
import { runExport } from '@qmd-team-intent-kb/git-exporter';
import { computeContentHash, loadOrCreateOriginSecret } from '@qmd-team-intent-kb/common';
import { AuditEvent } from '@qmd-team-intent-kb/schema';
import type { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  createDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  ExportStateRepository,
} from '@qmd-team-intent-kb/store';
import {
  getDefaultDenseConfig,
  QmdAdapter,
  resolveQmdBinary,
  type ResolvedQmdBinary,
} from '@qmd-team-intent-kb/qmd-adapter';
import type { QmdError } from '@qmd-team-intent-kb/qmd-adapter';
import type { BrainConfig } from './config.js';
import { seedDefaultPolicy } from './seed-policy.js';
import { anchorChainHead } from './anchor.js';
import { acquireWriteLock } from './write-lock.js';

/**
 * Fixed sentinel `memoryId` stamped on the batch-level `governed` sweep receipt
 * (B1). A sweep governs MANY candidates, so its receipt is not tied to one memory;
 * this constant marks the row as a sweep event and makes every sweep receipt
 * discoverable via `auditRepo.findByMemory(SWEEP_RECEIPT_MEMORY_ID)`. It is a
 * synthetic (never-a-real-memory) but structurally-valid UUID.
 */
const SWEEP_RECEIPT_MEMORY_ID = '00000000-0000-4000-8000-000000000b10';

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

/** One candidate's outcome in a sweep receipt — id + terminal outcome, NO content. */
interface SweepOutcome {
  candidateId: string;
  outcome:
    | 'promoted'
    | 'duplicate'
    | 'quarantined'
    | 'flagged'
    | 'rejected'
    | 'skipped'
    | 'held';
}

/**
 * Result of one in-process govern pass — what the deterministic pipeline did with
 * the whole inbox (freshly-spooled candidates PLUS any remote team-mode captures
 * sitting in the `candidates` table), plus whether the search index was refreshed.
 */
export interface GovernSummary {
  ingested: number;
  /** Number of inbox candidates the sweep examined this run. */
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  /** Member-authored candidates held back from auto-promotion for admin review. */
  quarantined: number;
  /** Candidates skipped by per-candidate error containment (never aborts the sweep). */
  skipped: number;
  /**
   * Candidates put on a bounded human-escalation hold (K6): an audience or
   * secret question the rules could detect but not decide. Neither promoted nor
   * dropped; a person resolves each one (`curator-cli holds`).
   */
  held: number;
  /** Would-be holds refused because the hold queue is full; left in the inbox, unpromoted. */
  holdCapBlocked: number;
  /** Holds closed UNPROMOTED this run because their expiry elapsed. */
  holdsExpired: number;
  /**
   * Files the export reconcile CHANGED this run (written + archived + removed).
   * Not "newly promoted": a lifecycle-only change (batch-transition) counts here.
   */
  exported: number;
  /** Per-operation breakdown of the export reconcile (absent only if it threw). */
  export?: ExportSummary;
  /** Why the export reconcile threw, if it did. */
  exportError?: string;
  indexUpdated: boolean;
  /** Actionable reason the index was not refreshed (missing qmd names the fix). */
  indexError?: string;
  /** The qmd binary that was used and how it was found. Absent if none resolved. */
  qmdBinary?: ResolvedQmdBinary;
  /** External anchor of the audit chain head (append-only log, git-committed). */
  anchored?: { chainHead: string; chainedRows: number; committed: boolean };
}

/**
 * Drive the deterministic govern pipeline once, in-process, with no daemon.
 *
 * This hand-wires the same sequence the edge-daemon runs per cycle — ingest the
 * spool → dedupe → policy → promote → export the markdown tree → refresh the qmd
 * index — but synchronously and on demand, pulling in only the curator,
 * git-exporter, qmd-adapter, and store packages (no daemon, no health server,
 * no pino). Promotion is where durable state and the SHA-256 hash-chained audit
 * event are written — the deterministic system DISPOSING of the model's
 * proposals. `runExport` is file-generation only (no git commit/push).
 *
 * Graceful degradation: if `qmd` is not on PATH, ingest/govern/promote/export
 * and the audit chain all still complete; only the index refresh fails (its
 * error is surfaced in `indexError`, and the new memory becomes searchable once
 * qmd is installed and govern is re-run).
 *
 * Concurrency: the ENTIRE pass (DB writes → export → qmd index → anchor append)
 * runs while holding the brain's exclusive `flock(2)` write lock on
 * `<base>/.write.lock` — THE SAME lock the cron backup/compile wrappers take via
 * `/usr/bin/flock`. This is what keeps an interactive govern from landing between
 * the 04:30 backup's `VACUUM INTO` and its `tar` (a false "TAMPER DETECTED" on
 * restore) and stops concurrent anchor appends from forking the anchor log. On
 * contention past the bounded wait it throws `WriteLockBusyError` — the tool
 * handler turns that into a clean, retryable result instead of hanging the MCP.
 */
export async function runGovern(config: BrainConfig): Promise<GovernSummary> {
  const lock = await acquireWriteLock(config.basePath);
  try {
    return await runGovernLocked(config);
  } finally {
    lock.release();
  }
}

/** The govern pass body, run under the already-held write lock (see runGovern). */
async function runGovernLocked(config: BrainConfig): Promise<GovernSummary> {
  const db = createDatabase({ path: config.dbPath });
  try {
    const candidateRepo = new CandidateRepository(db);
    const memoryRepo = new MemoryRepository(db);
    const policyRepo = new PolicyRepository(db);
    const auditRepo = new AuditRepository(db);
    const exportStateRepo = new ExportStateRepository(db);

    // 0. Seed the local default governance policy once (idempotent). Without it
    //    the Curator auto-approves every non-duplicate candidate; with it, local
    //    mode gets receipted rejections for secrets + too-short content. Best-effort:
    //    a seed failure (schema mismatch, read-only DB) must NOT crash the govern
    //    pass — degrade to the prior no-policy behavior.
    try {
      seedDefaultPolicy(policyRepo, config.tenantId);
    } catch (e) {
      process.stderr.write(
        `[governed-brain] default policy seed skipped: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }

    // 1. Ingest the spool → inbox candidates in SQLite. Archive each file after
    //    it is ingested (B1 idempotency): a re-run over unchanged input re-reads
    //    nothing, and the candidate findById dedup already blocks re-inserts.
    const ingestResult = await ingestFromSpool(candidateRepo, config.spoolPath, {
      archiveIngestedDir: join(config.spoolPath, 'ingested'),
    });
    const ingested = ingestResult.ok ? ingestResult.value.length : 0;

    // 2. Sweep the WHOLE inbox → govern it (B1, bead compile-then-govern-jfv.2.1).
    //    This is the marquee capture feature: freshly-spooled candidates AND remote
    //    team-mode brain_capture proposals (which POST to /api/candidates and land
    //    in the inbox with nothing else draining them) are governed in one pass.
    const curation = sweepInbox(config, { candidateRepo, memoryRepo, policyRepo, auditRepo });

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

    // 4. Refresh the qmd index. The binary is resolved explicitly (TEAMKB_QMD_BIN,
    //    PATH, ~/.bun/bin/qmd) because an MCP server's environment routinely lacks
    //    qmd on PATH; when it truly is absent the result carries the actionable
    //    reason instead of an opaque failure. Graceful degrade: everything above
    //    (govern, export, audit chain) has already completed.
    let indexUpdated = false;
    let indexError: string | undefined;
    let qmdBinary: ResolvedQmdBinary | undefined;
    try {
      qmdBinary = resolveQmdBinary();
      const adapter = new QmdAdapter({
        tenantId: config.tenantId,
        exportDir: config.exportDir,
        qmdBinary: qmdBinary.path,
        // Dense arm ON by default via the registrar's shared production seam
        // (#328); TEAMKB_DENSE_ENABLED=false is the emergency kill switch. This
        // site was the vps.1 drift class — the plugin bypasses the API, so
        // wiring the API alone would leave local mode lexical-only.
        dense: getDefaultDenseConfig(),
      });
      const ensure = await adapter.ensureCollections();
      if (!ensure.ok) throw new Error(describeQmdError(ensure.error));
      const upd = await adapter.update();
      if (!upd.ok) throw new Error(describeQmdError(upd.error));
      indexUpdated = true;
    } catch (e) {
      indexError = e instanceof Error ? e.message : String(e);
    }

    // 5. Anchor the chain head externally — snapshot to an append-only, hash-chained
    //    log and commit it to git (the tamper-evidence verifyAnchors checks against).
    //    Shared with brain_transition so every durable audit write re-anchors.
    const anchored = anchorChainHead(auditRepo, config.basePath, config.tenantId);
    if (!anchored) {
      process.stderr.write('[govern] anchor failed (best-effort; govern pass unaffected)\n');
    }

    return {
      ingested,
      processed: curation.processed,
      promoted: curation.promoted,
      rejected: curation.rejected,
      flagged: curation.flagged,
      duplicates: curation.duplicates,
      quarantined: curation.quarantined,
      skipped: curation.skipped,
      held: curation.held,
      holdCapBlocked: curation.holdCapBlocked,
      holdsExpired: curation.holdsExpired,
      exported,
      ...(exportSummary !== undefined ? { export: exportSummary } : {}),
      ...(exportError !== undefined ? { exportError } : {}),
      indexUpdated,
      indexError,
      ...(qmdBinary !== undefined ? { qmdBinary } : {}),
      anchored,
    };
  } finally {
    db.close();
  }
}

/** Repositories the inbox sweep operates over (all built on ONE db connection). */
interface SweepDeps {
  candidateRepo: CandidateRepository;
  memoryRepo: MemoryRepository;
  policyRepo: PolicyRepository;
  auditRepo: AuditRepository;
}

/** Aggregate counters + per-candidate outcomes produced by one inbox sweep. */
interface SweepResult {
  processed: number;
  promoted: number;
  rejected: number;
  flagged: number;
  duplicates: number;
  quarantined: number;
  skipped: number;
  held: number;
  holdCapBlocked: number;
  holdsExpired: number;
}

/**
 * Close every human-escalation hold whose expiry has elapsed (K6). Expiry is
 * the SAFE default: the candidate is stamped `rejected` with an `expired`
 * receipt and is never promoted. Best-effort: a failure here must not stop the
 * sweep (an overdue hold cannot be released in the meantime either way).
 */
function expireOverdueHolds(config: BrainConfig, deps: SweepDeps): number {
  try {
    return expireHolds(config.tenantId, deps).length;
  } catch (e) {
    process.stderr.write(
      `[govern:sweep] hold expiry skipped: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 0;
  }
}

/**
 * Drain and govern the ENTIRE pre-governance inbox for this tenant (B1, bead
 * compile-then-govern-jfv.2.1). The marker-based, DELETE-free auto-govern sweep.
 *
 * For every candidate in `status='inbox'` (freshly-spooled locals + remote
 * team-mode captures alike):
 *
 *   • MEMBER-authored (metadata.proposedByRole==='member', stamped server-side by
 *     R8) → NEVER auto-promoted. Marked `quarantined` (leaves the inbox, stays out
 *     of durable memory) for an admin digest-approve. Only admin/self-authored
 *     candidates flow through the promotion pipeline.
 *   • otherwise run the deterministic curator (tenant-scoped dedup → policy →
 *     promote). On the CurationResult:
 *       - promoted / duplicate → stamped to that terminal status; the row LEAVES
 *         the inbox (non-destructively — the row + its content survive).
 *       - held (K6) → an audience or secret question the rules can detect but not
 *         decide. The curator ALREADY stamped the row `quarantined` and wrote its
 *         `held` receipt in one transaction; the sweep only counts it. It leaves
 *         the inbox for a bounded hold that a person resolves.
 *       - flagged / rejected → LEFT in the inbox for human review. The review
 *         queue + the only copy of the content must survive, so the sweep never
 *         retires them. Per-candidate reject receipts are suppressed
 *         (`suppressRejectionReceipts`) so a candidate re-evaluated every night
 *         never grows the audit chain — the batch receipt below is the record.
 *
 * Every candidate is wrapped in its own try/catch: a single bad row is skipped +
 * counted, never aborting the drain (paired with the tolerant `findByStatus`
 * mapper, so even an unparseable row can't wedge the inbox forever).
 *
 * Emits exactly ONE batch-level `governed` audit receipt — but ONLY when ≥1
 * candidate actually LEFT the inbox this run (promoted / duplicate / quarantined).
 * That condition is what makes a re-run over unchanged input a genuine no-op: a
 * sweep that only re-encounters candidates already left in the inbox for review
 * writes nothing. The receipt records the per-candidate outcomes (ids + outcome),
 * never any content. Runs under the caller's flock + on the shared connection;
 * each promotion is atomic (R9) and the receipt is a single append.
 */
function sweepInbox(config: BrainConfig, deps: SweepDeps): SweepResult {
  const { candidateRepo, memoryRepo, policyRepo, auditRepo } = deps;
  // Close overdue holds first, so their slots are free for this run's holds.
  const holdsExpired = expireOverdueHolds(config, deps);
  const inbox = candidateRepo.findByStatus('inbox', config.tenantId);

  const res: SweepResult = {
    processed: inbox.length,
    promoted: 0,
    rejected: 0,
    flagged: 0,
    duplicates: 0,
    quarantined: 0,
    skipped: 0,
    held: 0,
    holdCapBlocked: 0,
    holdsExpired,
  };
  if (inbox.length === 0) return res;

  // H1 write-time provenance: verify origin-claiming candidates with the SAME
  // per-installation secret brain_capture mints with (~/.teamkb/origin-secret;
  // TEAMKB_ORIGIN_SECRET overrides). Best-effort resolution — an unreadable
  // secret must not wedge the sweep; origin-CLAIMING candidates then reject
  // fail-closed as `origin_token_unverifiable` while unattested ones flow.
  let originSecret: string | undefined;
  try {
    originSecret = loadOrCreateOriginSecret(config.basePath);
  } catch {
    originSecret = undefined;
  }
  const curator = new Curator(
    { candidateRepo, memoryRepo, policyRepo, auditRepo },
    {
      tenantId: config.tenantId,
      suppressRejectionReceipts: true,
      originSecret,
      // Hold bounds (K6): TEAMKB_HOLD_TTL_DAYS / TEAMKB_HOLD_MAX_ACTIVE, else defaults.
      holdLimits: holdLimitsFromEnv(),
    },
  );

  // Tenant-scoped intra-batch dedup set, extended as promotions land (mirrors
  // Curator.processBatch, but we drive processSingle per-candidate so each
  // candidate has its own error containment).
  const existingHashes = new Set(memoryRepo.getContentHashesByTenant(config.tenantId));
  const outcomes: SweepOutcome[] = [];
  // Marker flips for the receipt-LESS outcomes (quarantine / duplicate) are DEFERRED
  // and applied atomically WITH the batch receipt below (jfv.2.5b). A `promoted` flip
  // stays in-loop because its curated memory + its own 'promoted' receipt are already
  // one atomic write (R9). Deferring quarantine/duplicate means a failed batch receipt
  // rolls their flips back too — so those candidates stay `inbox` and are retried next
  // run, instead of leaving the inbox with NO on-chain record of why.
  const pendingFlips: Array<{ id: string; status: 'quarantined' | 'duplicate' }> = [];

  for (const candidate of inbox) {
    try {
      // Member-quarantine gate: a member's proposal must NOT auto-promote.
      if (isMemberAuthored(candidate)) {
        pendingFlips.push({ id: candidate.id, status: 'quarantined' });
        res.quarantined++;
        outcomes.push({ candidateId: candidate.id, outcome: 'quarantined' });
        continue;
      }

      const result = curator.processSingle(candidate, existingHashes);
      switch (result.outcome) {
        case 'promoted':
          candidateRepo.updateStatus(candidate.id, 'promoted', config.tenantId);
          existingHashes.add(computeContentHash(candidate.content));
          res.promoted++;
          outcomes.push({ candidateId: candidate.id, outcome: 'promoted' });
          break;
        case 'duplicate':
          pendingFlips.push({ id: candidate.id, status: 'duplicate' });
          res.duplicates++;
          outcomes.push({ candidateId: candidate.id, outcome: 'duplicate' });
          break;
        case 'held':
          // The curator stamped the row and wrote its `held` receipt atomically.
          res.held++;
          outcomes.push({ candidateId: candidate.id, outcome: 'held' });
          break;
        case 'flagged':
          // LEFT in the inbox for human review (row + content survive).
          res.flagged++;
          if (result.hold?.status === 'cap_reached') res.holdCapBlocked++;
          outcomes.push({ candidateId: candidate.id, outcome: 'flagged' });
          break;
        case 'rejected':
          // LEFT in the inbox for human review (row + content survive).
          res.rejected++;
          outcomes.push({ candidateId: candidate.id, outcome: 'rejected' });
          break;
      }
    } catch (e) {
      // Per-candidate containment: skip + count, never abort the whole sweep.
      res.skipped++;
      outcomes.push({ candidateId: candidate.id, outcome: 'skipped' });
      process.stderr.write(
        `[govern:sweep] skipped candidate ${candidate.id}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // ONE batch receipt — only when durable state changed (a candidate left the
  // inbox). A no-op sweep (only review-queue leftovers) writes nothing, keeping a
  // re-run idempotent. Content is NEVER included (ids + outcomes only).
  const leftInbox = res.promoted + res.duplicates + res.quarantined + res.held;
  if (leftInbox > 0) {
    // ATOMIC (jfv.2.5b): apply the deferred quarantine/duplicate marker flips AND
    // write the batch receipt in ONE transaction. Previously the receipt was a
    // swallow-on-failure append AFTER the flips had already autocommitted — so a
    // failed insert left those flips on the record-less. Now a failed receipt rolls
    // the flips back too (the candidates stay `inbox`, retried next run), and the
    // error is NOT swallowed: it propagates so runGovern surfaces it (the nightly
    // wrapper's fail-loud path alerts) rather than silently drifting. Promoted rows
    // already carry their own transactional 'promoted' receipt, so they persist.
    memoryRepo.connection.transaction((): void => {
      for (const flip of pendingFlips) {
        candidateRepo.updateStatus(flip.id, flip.status, config.tenantId);
      }
      auditRepo.insert(
        AuditEvent.parse({
          id: randomUUID(),
          action: 'governed',
          memoryId: SWEEP_RECEIPT_MEMORY_ID,
          tenantId: config.tenantId,
          actor: { type: 'system', id: 'auto-govern' },
          reason: `Auto-govern sweep: ${res.promoted} promoted, ${res.duplicates} duplicate, ${res.quarantined} quarantined, ${res.held} held, ${res.flagged} flagged, ${res.rejected} rejected, ${res.skipped} skipped`,
          details: {
            held: res.held,
            promoted: res.promoted,
            duplicates: res.duplicates,
            quarantined: res.quarantined,
            flagged: res.flagged,
            rejected: res.rejected,
            skipped: res.skipped,
            processed: res.processed,
            outcomes,
          },
          timestamp: new Date().toISOString(),
        }),
      );
    })();
  }

  return res;
}

/**
 * True when a candidate was proposed by a `member` token (R8 stamps
 * `metadata.proposedByRole` server-side at intake). Member-authored proposals are
 * quarantined rather than auto-promoted. Self-authored local captures and
 * admin-authored proposals have no `member` marker and flow through normally.
 */
function isMemberAuthored(candidate: MemoryCandidate): boolean {
  return candidate.metadata?.proposedByRole === 'member';
}

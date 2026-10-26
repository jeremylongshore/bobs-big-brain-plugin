/**
 * Local review coordinator. Import-inert local coordinator: no MCP server,
 * automatic approval, native installation, model call or runtime activation.
 * Identity/role/tenant are caller-bound declarations, not physical-human proof.
 * Lists are DB-read-only; SQLite can still maintain transient shared-memory state.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  isAudienceVisibleToRole,
  loadOriginSecret,
  resolveAudience,
} from '@qmd-team-intent-kb/common';
import {
  BRAINIGNORE_PATH_ENV,
  listActiveHolds,
  loadBrainignoreRuleset,
  rejectReviewedCandidate,
  resolveHold,
  type ReviewedRejectionRefusalCode,
  type ResolveHoldRefusalCode,
} from '@qmd-team-intent-kb/curator';
import {
  Audience,
  IsoDatetime,
  MemoryCategory as MemoryCategorySchema,
  Uuid,
  type Author,
  type MemoryCategory,
} from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CandidateRepository,
  ExportStateRepository,
  MemoryLinksRepository,
  MemoryRepository,
  PolicyRepository,
} from '@qmd-team-intent-kb/store';
import { anchorChainHead, type AnchorResult } from './anchor.js';
import { resolveConfig, type BrainConfig } from './config.js';
import { refreshDerivedState, type ExportSummary } from './derived-state.js';
import { resolveMode } from './mode.js';
import { loadTeamConfig } from './team-config.js';
import { acquireWriteLock } from './write-lock.js';

export const localReviewConfig = resolveConfig;

type ReviewRole = 'admin' | 'owner';
export interface ReviewQueueOptions {
  limit?: number;
  role?: string;
}
export interface PendingReviewItem {
  candidateId: string;
  status: 'inbox';
  category: MemoryCategory;
  audience: string;
}
export interface HeldReviewItem {
  candidateId: string;
  status: 'quarantined';
  category: MemoryCategory;
  audience: string;
  recommendedAudience?: string;
  triggers: string[];
  heldAt?: string;
  expiresAt?: string;
  expired?: boolean;
  metadataIncomplete: boolean;
}
export interface LocalReviewQueue {
  ok: true;
  pending: PendingReviewItem[];
  holds: HeldReviewItem[];
  limit: number;
  pendingHasMore: boolean;
  holdsHasMore: boolean;
}
interface ReviewIdentity {
  candidateId: string;
  actor: Author;
  role: string;
  reason: string;
}
export type LocalReviewRequest = ReviewIdentity &
  (
    | { operation: 'reject' }
    | {
        operation: 'resolve-hold';
        resolution: 'release' | 'reject';
        audience?: string;
        acknowledgeWider?: boolean;
      }
  );
export interface SafeDerivedSummary {
  exported: number;
  export?: ExportSummary;
  exportFailed: boolean;
  indexUpdated: boolean;
  indexFailed: boolean;
}
export interface LocalReviewResult {
  ok: boolean;
  committed: boolean;
  candidateId: string;
  disposition?: 'rejected' | 'released' | 'expired';
  code?: ReviewedRejectionRefusalCode | ResolveHoldRefusalCode;
  auditEventId?: string;
  memoryId?: string;
  audience?: string;
  anchored?: AnchorResult;
  anchorFailed?: boolean;
  derived?: SafeDerivedSummary;
  derivedFailed?: boolean;
}

/** Fixed diagnostics only: never forward a canonical error or source content. */
class LocalReviewError extends Error {
  constructor(
    readonly code:
      | 'local_only'
      | 'invalid_options'
      | 'invalid_request'
      | 'store_unavailable'
      | 'review_unavailable',
  ) {
    super(code);
    this.name = 'LocalReviewError';
  }
}
function assertLocal(config: BrainConfig): void {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TEAMKB_BASE_PATH: config.basePath };
    // Read the requested brain's config even when the direct helper bypasses the
    // CLI. A present/malformed team file refuses rather than becoming local.
    const team = loadTeamConfig(env);
    if (team.present || resolveMode(env.TEAMKB_API_URL).mode !== 'local') {
      throw new LocalReviewError('local_only');
    }
  } catch {
    throw new LocalReviewError('local_only');
  }
}
function reviewRole(role: string | undefined): ReviewRole {
  if (role === undefined || role === 'owner') return 'owner';
  if (role === 'admin') return 'admin';
  throw new LocalReviewError('invalid_options');
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}
/**
 * No schema initialization/migration or missing-file creation: the normal store
 * workflow must already have prepared this DB. No same-UID pathname sandbox or
 * atomic filesystem identity claim: witnesses reject observed substitutions.
 */
function openExisting(config: BrainConfig, readonly: boolean): Database.Database {
  if (!isAbsolute(config.dbPath)) throw new LocalReviewError('store_unavailable');
  let fd: number | undefined;
  let connection: Database.Database | undefined;
  try {
    fd = openSync(
      config.dbPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const witness = fstatSync(fd);
    if (!sameFile(witness, lstatSync(config.dbPath)))
      throw new LocalReviewError('store_unavailable');
    connection = new Database(config.dbPath, { readonly, fileMustExist: true });
    if (!sameFile(witness, lstatSync(config.dbPath)) || !sameFile(witness, fstatSync(fd))) {
      throw new LocalReviewError('store_unavailable');
    }
    if (!readonly) {
      connection.pragma('foreign_keys = ON');
      connection.pragma('busy_timeout = 5000');
    }
    return connection;
  } catch {
    connection?.close();
    throw new LocalReviewError('store_unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// Output vocabulary only, not a second hold-trigger evaluator. Unknown legacy
// strings are omitted instead of printing arbitrary audit details as prose.
const safeTriggers = new Set([
  'audience_narrowing_flag',
  'audience_above_proposer_clearance',
  'secret_scan_flag',
  'sensitivity_gate_flag',
]);

export function listLocalReview(
  config: BrainConfig,
  options: ReviewQueueOptions = {},
): LocalReviewQueue {
  assertLocal(config);
  const role = reviewRole(options.role);
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new LocalReviewError('invalid_options');
  const connection = openExisting(config, true);
  try {
    const candidateRepo = new CandidateRepository(connection);
    const memoryRepo = new MemoryRepository(connection);
    const auditRepo = new AuditRepository(connection);
    return connection
      .transaction(() => {
        // Existing canonical repositories materialize their scoped lists. This is
        // bounded OUTPUT, not a constant-memory/paginated store implementation.
        const pending = candidateRepo
          .findByStatus('inbox', config.tenantId)
          .filter(
            (candidate) =>
              isAudienceVisibleToRole(candidate.metadata.audience, role) &&
              !memoryRepo.existsForCandidate(candidate.id, config.tenantId),
          )
          .map((candidate): PendingReviewItem => ({
            candidateId: candidate.id,
            status: 'inbox',
            category: candidate.category,
            audience: resolveAudience(candidate.metadata.audience),
          }))
          .sort((a, b) =>
            a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0,
          );
        const holds = listActiveHolds(config.tenantId, { candidateRepo, memoryRepo, auditRepo })
          .filter((hold) => isAudienceVisibleToRole(hold.declaredAudience, role))
          .map((hold): HeldReviewItem => {
            const recommended = Audience.safeParse(hold.recommendedAudience);
            const heldAt = IsoDatetime.safeParse(hold.heldAt);
            const expiresAt = IsoDatetime.safeParse(hold.expiresAt);
            return {
              candidateId: hold.candidateId,
              status: 'quarantined',
              category: MemoryCategorySchema.parse(hold.category),
              audience: Audience.parse(hold.declaredAudience),
              ...(recommended.success ? { recommendedAudience: recommended.data } : {}),
              triggers: hold.triggers.filter((trigger) => safeTriggers.has(trigger)),
              ...(heldAt.success ? { heldAt: heldAt.data } : {}),
              ...(expiresAt.success ? { expiresAt: expiresAt.data, expired: hold.expired } : {}),
              metadataIncomplete: !recommended.success || !heldAt.success || !expiresAt.success,
            };
          });
        return {
          ok: true as const,
          pending: pending.slice(0, limit),
          holds: holds.slice(0, limit),
          limit,
          pendingHasMore: pending.length > limit,
          holdsHasMore: holds.length > limit,
        };
      })
      .deferred();
  } catch {
    throw new LocalReviewError('review_unavailable');
  } finally {
    connection.close();
  }
}

// Canonical resolveHold validates authority/audience/expiry before accessing
// release options. Memoize lazy reads so refused requests do not read the secret.
function releaseOptions(config: BrainConfig) {
  let originLoaded = false;
  let secret: string | undefined;
  let exclusions: ReturnType<typeof loadBrainignoreRuleset> | undefined;
  return {
    get originSecret() {
      if (!originLoaded) {
        originLoaded = true;
        try {
          secret = loadOriginSecret(config.basePath);
        } catch {
          secret = undefined;
        }
      }
      return secret;
    },
    get importExclusions() {
      exclusions ??= loadBrainignoreRuleset({
        path: process.env[BRAINIGNORE_PATH_ENV]?.trim() || join(config.basePath, 'brainignore'),
        onWarn: () => undefined,
      });
      return exclusions;
    },
  };
}

export async function reviewLocalCandidate(
  config: BrainConfig,
  request: LocalReviewRequest,
): Promise<LocalReviewResult> {
  assertLocal(config);
  if (
    !Uuid.safeParse(request.candidateId).success ||
    (request.operation !== 'reject' && request.operation !== 'resolve-hold')
  ) {
    throw new LocalReviewError('invalid_request');
  }
  const connection = openExisting(config, false);
  let lock: Awaited<ReturnType<typeof acquireWriteLock>> | undefined;
  try {
    lock = await acquireWriteLock(config.basePath);
    const candidateRepo = new CandidateRepository(connection);
    const memoryRepo = new MemoryRepository(connection);
    const auditRepo = new AuditRepository(connection);
    const policyRepo = new PolicyRepository(connection);
    const linksRepo = new MemoryLinksRepository(connection);
    const settled = connection
      .transaction(() => {
        const before = auditRepo.findChainTip();
        const beforeIds = new Set(
          auditRepo
            .findByMemoryAndTenant(request.candidateId, config.tenantId)
            .map((event) => event.id),
        );
        const outcome =
          request.operation === 'reject'
            ? rejectReviewedCandidate(
                {
                  candidateId: request.candidateId,
                  tenantId: config.tenantId,
                  actor: request.actor,
                  role: request.role,
                  reason: request.reason,
                },
                connection,
              )
            : resolveHold(
                {
                  candidateId: request.candidateId,
                  tenantId: config.tenantId,
                  actor: request.actor,
                  role: request.role,
                  reason: request.reason,
                  resolution: request.resolution,
                  ...(request.audience === undefined ? {} : { audience: request.audience }),
                  ...(request.acknowledgeWider === undefined
                    ? {}
                    : { acknowledgeWider: request.acknowledgeWider }),
                },
                { candidateRepo, memoryRepo, auditRepo, policyRepo, linksRepo },
                request.resolution === 'release' ? releaseOptions(config) : {},
              );
        const after = auditRepo.findChainTip();
        const committed = (after?.entryHash ?? null) !== (before?.entryHash ?? null);
        const expired = !outcome.ok && 'expiredNow' in outcome && outcome.expiredNow === true;
        // A successful canonical disposition or expiry must have actually appended
        // its receipt. No silent success if a DB trigger ignored the append.
        const events = auditRepo.findByMemoryAndTenant(request.candidateId, config.tenantId);
        let auditEventId: string | undefined;
        if (outcome.ok) {
          if (
            outcome.auditEventId === null ||
            !events.some((event) => event.id === outcome.auditEventId)
          ) {
            throw new LocalReviewError('review_unavailable');
          }
          auditEventId = outcome.auditEventId;
        } else if (expired) {
          auditEventId = events.find(
            (event) =>
              event.action === 'hold_resolved' &&
              event.details['resolution'] === 'expired' &&
              !beforeIds.has(event.id),
          )?.id;
          if (auditEventId === undefined) throw new LocalReviewError('review_unavailable');
        }
        if ((outcome.ok || expired) && !committed) throw new LocalReviewError('review_unavailable');
        if (!outcome.ok && !expired && committed) throw new LocalReviewError('review_unavailable');
        if (outcome.ok || expired) {
          const released =
            outcome.ok && 'resolution' in outcome && outcome.resolution === 'released';
          const current = candidateRepo.findById(request.candidateId);
          if (
            current?.tenantId !== config.tenantId ||
            current.status !== (released ? 'promoted' : 'rejected')
          ) {
            throw new LocalReviewError('review_unavailable');
          }
          if (released) {
            const memoryId =
              'memoryId' in outcome && typeof outcome.memoryId === 'string'
                ? outcome.memoryId
                : undefined;
            if (memoryId === undefined || !Uuid.safeParse(memoryId).success) {
              throw new LocalReviewError('review_unavailable');
            }
            const memory = memoryRepo.findById(memoryId);
            const promoted = auditRepo.findByMemoryAndTenant(memoryId, config.tenantId);
            if (
              memory?.tenantId !== config.tenantId ||
              memory.candidateId !== request.candidateId ||
              memory.lifecycle !== 'active' ||
              !promoted.some((event) => event.action === 'promoted')
            ) {
              throw new LocalReviewError('review_unavailable');
            }
          }
        }
        const result: LocalReviewResult = outcome.ok
          ? {
              ok: true,
              committed,
              candidateId: request.candidateId,
              disposition: 'resolution' in outcome ? outcome.resolution : 'rejected',
              ...(auditEventId === undefined ? {} : { auditEventId }),
              ...('memoryId' in outcome && outcome.memoryId !== undefined
                ? { memoryId: outcome.memoryId }
                : {}),
              ...('audience' in outcome && outcome.audience !== undefined
                ? { audience: outcome.audience }
                : {}),
            }
          : {
              ok: false,
              committed,
              candidateId: request.candidateId,
              code: outcome.code,
              ...(expired ? { disposition: 'expired' as const, auditEventId } : {}),
            };
        return result;
      })
      .immediate();
    if (!settled.committed) return settled;

    // The transaction has COMMITTED. Postprocessing failure cannot become a
    // rollback claim. Anchor even an expiredNow refusal; do not refresh no-ops.
    try {
      const anchored = anchorChainHead(auditRepo, config.basePath, config.tenantId);
      if (anchored === undefined) settled.anchorFailed = true;
      else settled.anchored = anchored;
    } catch {
      settled.anchorFailed = true;
    }
    try {
      const derived = await refreshDerivedState(config, {
        memoryRepo,
        exportStateRepo: new ExportStateRepository(connection),
      });
      settled.derived = {
        exported: derived.exported,
        ...(derived.export === undefined ? {} : { export: derived.export }),
        exportFailed: derived.exportError !== undefined,
        indexUpdated: derived.indexUpdated,
        indexFailed: derived.indexError !== undefined || !derived.indexUpdated,
      };
    } catch {
      settled.derivedFailed = true;
    }
    return settled;
  } catch {
    // No raw canonical error text. The CLI must report committed:null for a
    // thrown operation rather than infer rollback from a generic exception.
    throw new LocalReviewError('review_unavailable');
  } finally {
    try {
      connection.close();
    } finally {
      lock?.release();
    }
  }
}

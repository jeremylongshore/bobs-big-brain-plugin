/** node --test against the genuinely built local-review.cjs.
 * Requires LOCAL_REVIEW_TEST_ROOT naming the provisioned plugin checkout with
 * public paired Registrar package links/dist and Node-compatible native addons.
 * Canonical source APIs create fixtures; the generated helper performs writes.
 * No esbuild, source substitution, provisioning, model or actual qmd execution.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.LOCAL_REVIEW_TEST_ROOT) throw new Error('Explicit fixture checkout required');
const repo = resolve(process.env.LOCAL_REVIEW_TEST_ROOT);
const requireRepo = createRequire(join(repo, 'package.json'));
const moduleFromRepo = (name) => import(pathToFileURL(requireRepo.resolve(name)).href);
const work = mkdtempSync(join(tmpdir(), 'gsb-review-transactions-'));
const home = join(work, 'home');
const tools = join(work, 'tools');
mkdirSync(home, { mode: 0o700 });
mkdirSync(tools, { mode: 0o700 });
symlinkSync(realpathSync(process.execPath), join(tools, 'node'));
symlinkSync('/usr/bin/git', join(tools, 'git'));
const privateEnv = {
  HOME: home,
  TMPDIR: work,
  PATH: tools,
  TEAMKB_API_URL: '',
  TEAMKB_API_TOKEN: '',
  TEAMKB_DENSE_ENABLED: 'false',
  TEAMKB_QMD_BIN: join(work, 'missing-qmd'),
  TEAMKB_QMD_RUNTIME: '',
  TEAMKB_ORIGIN_SECRET: '',
  TEAMKB_BRAINIGNORE: join(work, 'absent-brainignore'),
  TEAMKB_HOME: home,
  TEAMKB_BASE_PATH: work,
  TEAMKB_TENANT_ID: 'review-transaction-fixture',
  GIT_CONFIG_NOSYSTEM: '1',
  DO_NOT_TRACK: '1',
  COREPACK_ENABLE_NETWORK: '0',
};
const saved = new Map(Object.keys(privateEnv).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(privateEnv)) process.env[key] = value;
after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(work, { recursive: true, force: true });
});
const {
  createDatabase,
  CandidateRepository,
  MemoryRepository,
  AuditRepository,
  PolicyRepository,
  verifyAuditChain,
} = await moduleFromRepo('@qmd-team-intent-kb/store');
const { MemoryCandidate } = await moduleFromRepo('@qmd-team-intent-kb/schema');
const { computeContentHash } = await moduleFromRepo('@qmd-team-intent-kb/common');
const { buildRecommendedPolicy } = await moduleFromRepo('@qmd-team-intent-kb/policy-engine');
const { Curator } = await moduleFromRepo('@qmd-team-intent-kb/curator');
const runtimeRequire = createRequire(join(repo, 'plugin-runtime/package.json'));
const RuntimeDatabase = runtimeRequire('better-sqlite3');
const helper = runtimeRequire('./local-review.cjs');
const tenant = privateEnv.TEAMKB_TENANT_ID;
const actor = { type: 'human', id: 'fixture-person' };
const reason = 'Synthetic reviewed disposition';
const now = () => new Date().toISOString();

function fixture(held = false) {
  const base = mkdtempSync(join(work, 'brain-'));
  // Initialize canonically, then use one SQLite native library for every live
  // connection. Independent linked/runtime libraries cannot share WAL caches.
  const initialized = createDatabase({ path: join(base, 'teamkb.db') });
  initialized.close();
  const db = new RuntimeDatabase(join(base, 'teamkb.db'), { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  const repos = {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    auditRepo: new AuditRepository(db),
    policyRepo: new PolicyRepository(db),
  };
  repos.policyRepo.insert(buildRecommendedPolicy(tenant, now()));
  const candidate = MemoryCandidate.parse({
    id: randomUUID(),
    status: 'inbox',
    source: 'mcp',
    title: held ? 'Synthetic contact review' : 'Synthetic pending review',
    content: held
      ? 'Contact fixture@example.invalid for invented release coordination and application documentation.'
      : 'Keep admission checks separate from model proposals and document the accepted boundaries of this invented private service.',
    category: held ? 'onboarding' : 'reference',
    trustLevel: 'medium',
    author: { type: 'ai', id: 'fixture' },
    tenantId: tenant,
    metadata: { filePaths: [], tags: [] },
    capturedAt: now(),
  });
  repos.candidateRepo.insert(candidate, computeContentHash(candidate.content));
  if (held) {
    const result = new Curator(repos, {
      tenantId: tenant,
      suppressRejectionReceipts: true,
    }).processSingle(candidate);
    assert.equal(result.outcome, 'held', 'Canonical fixture must actually enter a hold');
    assert.equal(repos.candidateRepo.findById(candidate.id).status, 'quarantined');
    assert.equal(
      repos.auditRepo
        .findByMemoryAndTenant(candidate.id, tenant)
        .filter((event) => event.action === 'held').length,
      1,
    );
  }
  const config = {
    tenantId: tenant,
    basePath: base,
    dbPath: join(base, 'teamkb.db'),
    spoolPath: join(base, 'spool'),
    feedbackPath: join(base, 'feedback'),
    exportDir: join(base, 'kb-export'),
    qmdIndexPath: join(base, 'qmd-index', tenant),
  };
  return {
    base,
    db,
    repos,
    candidate,
    config,
    close() {
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
function snapshot(f) {
  return Object.fromEntries(
    ['candidates', 'curated_memories', 'audit_events', 'governance_policies'].map((table) => [
      table,
      f.db
        .prepare(`SELECT * FROM ${table} ORDER BY ${table === 'audit_events' ? 'seq' : 'id'}`)
        .all(),
    ]),
  );
}
function request(f, operation, overrides = {}) {
  return {
    operation: operation === 'pending-reject' ? 'reject' : 'resolve-hold',
    candidateId: f.candidate.id,
    actor,
    role: 'owner',
    reason,
    ...(operation === 'hold-release' ? { resolution: 'release', audience: 'owner' } : {}),
    ...(operation === 'hold-reject' ? { resolution: 'reject' } : {}),
    ...overrides,
  };
}
function plant(f, operation, fault, actionOverride) {
  // IDs are canonical random UUIDs generated above, not caller-controlled SQL.
  const action = actionOverride ?? (operation === 'pending-reject' ? 'deleted' : 'hold_resolved');
  if (fault === 'status-ignore') {
    const status = operation === 'hold-release' ? 'promoted' : 'rejected';
    f.db.exec(`CREATE TRIGGER fixture_fault BEFORE UPDATE OF status ON candidates
      WHEN OLD.id = '${f.candidate.id}' AND NEW.status = '${status}'
      BEGIN SELECT RAISE(IGNORE); END;`);
  } else {
    f.db.exec(`CREATE TRIGGER fixture_fault BEFORE INSERT ON audit_events
      WHEN NEW.action = '${action}'
      BEGIN SELECT RAISE(${fault === 'receipt-ignore' ? 'IGNORE' : "ABORT, 'synthetic-trigger-private-marker'"}); END;`);
  }
}
for (const operation of ['pending-reject', 'hold-reject', 'hold-release']) {
  for (const fault of ['receipt-ignore', 'receipt-abort', 'status-ignore']) {
    test(
      `${operation}: ${fault} rolls back candidate, memory and complete audit rows`,
      { timeout: 20_000, concurrency: false },
      async () => {
        const f = fixture(operation !== 'pending-reject');
        try {
          const before = snapshot(f);
          const chainBefore = verifyAuditChain(f.repos.auditRepo);
          plant(f, operation, fault);
          await assert.rejects(
            helper.reviewLocalCandidate(f.config, request(f, operation)),
            (error) => {
              assert.equal(error.code, 'review_unavailable');
              assert.equal(error.message, 'review_unavailable');
              assert.ok(!String(error).includes('synthetic-trigger-private-marker'));
              return true;
            },
          );
          assert.deepEqual(snapshot(f), before);
          assert.deepEqual(verifyAuditChain(f.repos.auditRepo), chainBefore);
          assert.ok(!existsSync(join(f.base, 'audit')), 'Rolled-back call must not anchor');
          assert.ok(!existsSync(f.config.exportDir), 'Rolled-back call must not reconcile exports');
          // Removing ONLY the planted fault must allow this same actual helper
          // request to commit. This prevents unrelated native/setup errors from
          // masquerading as successful rollback controls.
          f.db.exec('DROP TRIGGER fixture_fault');
          const retry = await helper.reviewLocalCandidate(f.config, request(f, operation));
          assert.equal(retry.ok, true);
          assert.equal(retry.committed, true);
          assert.equal(
            f.repos.candidateRepo.findById(f.candidate.id).status,
            operation === 'hold-release' ? 'promoted' : 'rejected',
          );
          assert.ok(
            f.repos.auditRepo
              .findByMemoryAndTenant(f.candidate.id, tenant)
              .some((event) => event.id === retry.auditEventId),
          );
        } finally {
          f.close();
        }
      },
    );
  }
}
test(
  'hold release refuses an ignored promoted receipt even if hold resolution would append',
  { timeout: 20_000 },
  async () => {
    const f = fixture(true);
    try {
      const before = snapshot(f);
      plant(f, 'hold-release', 'receipt-ignore', 'promoted');
      await assert.rejects(helper.reviewLocalCandidate(f.config, request(f, 'hold-release')), {
        code: 'review_unavailable',
      });
      assert.deepEqual(snapshot(f), before);
      f.db.exec('DROP TRIGGER fixture_fault');
      const retry = await helper.reviewLocalCandidate(f.config, request(f, 'hold-release'));
      assert.equal(retry.ok, true);
      assert.equal(retry.committed, true);
      assert.ok(
        f.repos.auditRepo
          .findByMemoryAndTenant(retry.memoryId, tenant)
          .some((event) => event.action === 'promoted'),
      );
    } finally {
      f.close();
    }
  },
);

for (const [name, held, operation, overrides, expected] of [
  [
    'AI actor',
    false,
    'pending-reject',
    { actor: { type: 'ai', id: 'fixture-model' } },
    'not_human',
  ],
  ['member standing', false, 'pending-reject', { role: 'member' }, 'forbidden_role'],
  ['missing reason', false, 'pending-reject', { reason: '   ' }, 'missing_reason'],
  ['hold missing audience', true, 'hold-release', { audience: undefined }, 'missing_audience'],
  [
    'hold unacknowledged widening',
    true,
    'hold-release',
    { audience: 'tenant' },
    'wider_than_recommended',
  ],
  [
    'AI cannot resolve hold',
    true,
    'hold-reject',
    { actor: { type: 'ai', id: 'fixture-model' } },
    'not_human',
  ],
]) {
  test(
    `canonical refusal: ${name} leaves selected tables unchanged`,
    { timeout: 20_000, concurrency: false },
    async () => {
      const f = fixture(held);
      try {
        const before = snapshot(f);
        const result = await helper.reviewLocalCandidate(
          f.config,
          request(f, operation, overrides),
        );
        assert.equal(result.ok, false);
        assert.equal(result.committed, false);
        assert.equal(result.code, expected);
        assert.deepEqual(snapshot(f), before);
        assert.ok(!existsSync(join(f.base, 'audit')));
      } finally {
        f.close();
      }
    },
  );
}
test('foreign tenant cannot inspect or settle a known candidate', { timeout: 20_000 }, async () => {
  const f = fixture(true);
  try {
    const before = snapshot(f);
    const foreign = { ...f.config, tenantId: 'foreign-review-fixture' };
    const queue = helper.listLocalReview(foreign);
    assert.equal(queue.ok, true);
    assert.deepEqual(queue.pending, []);
    assert.deepEqual(queue.holds, []);
    const result = await helper.reviewLocalCandidate(foreign, request(f, 'hold-reject'));
    assert.equal(result.code, 'not_on_hold');
    assert.equal(result.committed, false);
    assert.deepEqual(snapshot(f), before);
  } finally {
    f.close();
  }
});

// Legacy malformed hold metadata projections intentionally omitted here: altering
// existing audit rows would invalidate a canonical fixture's chain. A separate
// narrowly labeled legacy-row fixture can test presentation without claiming
// those planted malformed audit bytes form a clean canonical history.

for (const failure of ['anchor', 'derived']) {
  test(
    `postcommit ${failure} failure retains the disposition and receipt`,
    { timeout: 20_000 },
    async () => {
      const f = fixture(false);
      try {
        if (failure === 'anchor') {
          writeFileSync(join(f.base, 'audit'), 'private fixture obstruction', {
            flag: 'wx',
            mode: 0o600,
          });
        } else {
          // Private schema fault affects only postcommit derived repository setup.
          f.db.exec('DROP TABLE export_state');
        }
        const result = await helper.reviewLocalCandidate(f.config, request(f, 'pending-reject'));
        assert.equal(result.ok, true);
        assert.equal(result.committed, true);
        assert.equal(f.repos.candidateRepo.findById(f.candidate.id).status, 'rejected');
        assert.ok(
          f.repos.auditRepo
            .findByMemoryAndTenant(f.candidate.id, tenant)
            .some((event) => event.id === result.auditEventId),
        );
        if (failure === 'anchor') assert.equal(result.anchorFailed, true);
        else assert.equal(result.derivedFailed, true);
        if (result.derived) assert.equal(result.derived.indexFailed, true);
        const before = snapshot(f);
        const repeated = await helper.reviewLocalCandidate(f.config, request(f, 'pending-reject'));
        assert.equal(repeated.committed, false);
        assert.equal(repeated.code, 'not_pending');
        assert.equal(repeated.derived, undefined);
        assert.deepEqual(snapshot(f), before);
      } finally {
        f.close();
      }
    },
  );
}

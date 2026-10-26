/**
 * Local-stack contract: real Curator, policy engine, SQLite and audit chain.
 * Only qmd refresh and anchoring are replaced: this suite neither launches a
 * retrieval binary nor claims bundled MCP/anchor coverage. The hosted local-stack
 * lane supplies the sibling Registrar; the dependency-free unit lane stays intact.
 */
import assert from 'node:assert/strict';
import { after, before, test, mock } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Curator } from '@qmd-team-intent-kb/curator';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { GovernancePolicy, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  createDatabase,
  CandidateRepository,
  PolicyRepository,
  AuditRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const tenantId = 'rejection-fixture';
let helperRoot;
let runGovern;

before(async () => {
  helperRoot = mkdtempSync(join(repo, 'scripts', '.govern-rejections-'));
  const outfile = join(helperRoot, 'govern.mjs');
  await build({
    entryPoints: [join(repo, 'src', 'govern.ts')],
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      {
        name: 'no-retrieval-or-anchor-side-effects',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(qmd-command|anchor)\.js$/ }, (args) => ({
            path: args.path,
            namespace: 'fixture-boundary',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture-boundary' }, (args) => ({
            contents: args.path.includes('anchor')
              ? 'export const anchorChainHead = () => undefined;'
              : 'export const createLocalQmdBinding = async () => { throw new Error("fixture: no qmd execution"); }; export const legacyQmdBinary = () => undefined;',
            loader: 'js',
          }));
        },
      },
    ],
  });
  ({ runGovern } = await import(pathToFileURL(outfile).href));
});
after(() => {
  if (helperRoot) rmSync(helperRoot, { recursive: true, force: true });
});

function fixture() {
  const basePath = mkdtempSync(join(tmpdir(), 'gsb-govern-rejections-'));
  const config = {
    tenantId,
    basePath,
    dbPath: join(basePath, 'teamkb.db'),
    spoolPath: join(basePath, 'spool'),
    feedbackPath: join(basePath, 'feedback'),
    exportDir: join(basePath, 'kb-export'),
    qmdIndexPath: join(basePath, 'qmd-index', tenantId),
  };
  mkdirSync(config.spoolPath);
  const db = createDatabase({ path: config.dbPath });
  const candidates = new CandidateRepository(db);
  const policies = new PolicyRepository(db);
  const audit = new AuditRepository(db);
  function insert(content, overrides = {}) {
    const candidate = MemoryCandidate.parse({
      id: randomUUID(),
      status: 'inbox',
      source: 'claude_session',
      content,
      title: 'Synthetic note',
      category: 'reference',
      trustLevel: 'low',
      author: { type: 'ai', id: 'fixture' },
      tenantId,
      capturedAt: new Date().toISOString(),
      ...overrides,
    });
    candidates.insert(candidate, computeContentHash(candidate.content));
    return candidate;
  }
  return {
    config,
    db,
    candidates,
    policies,
    audit,
    insert,
    close() {
      mock.restoreAll();
      db.close();
      rmSync(basePath, { recursive: true, force: true });
    },
  };
}

function assertClean(audit) {
  const result = verifyAuditChain(audit);
  assert.deepEqual(result.breaks, []);
  assert.equal(result.unverifiedRows, 0);
  assert.equal(result.cleanRows, audit.findAllChronological().length);
}

function rawSpool(f, contents) {
  const candidates = contents.map((content) =>
    MemoryCandidate.parse({
      id: randomUUID(),
      status: 'inbox',
      source: 'claude_session',
      content,
      title: 'Synthetic spool note',
      category: 'reference',
      trustLevel: 'low',
      author: { type: 'ai', id: 'fixture' },
      tenantId,
      capturedAt: new Date().toISOString(),
    }),
  );
  const source = join(f.config.spoolPath, 'spool-mixed.jsonl');
  const bytes = Buffer.from(
    candidates.map((candidate) => JSON.stringify(candidate)).join('\n') + '\n',
  );
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: '1',
      spoolFileSha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  );
  writeFileSync(source, bytes);
  writeFileSync(`${source}.manifest.json`, manifest);
  return { candidates, source, bytes, manifest };
}

const refusalMarkers = [
  'Synthetic disclosure fixture: SSN marker only; no identifying number.',
  'Synthetic disclosure fixture: salary keyword only; no person or amount.',
  'Synthetic disclosure fixture: -----BEGIN PRIVATE KEY----- marker only; no key material.',
];

test('mixed spool reports safe refusals, governs clean input and retains exact raw archive bytes', async () => {
  const f = fixture();
  try {
    const raw = rawSpool(f, [
      'Use bounded retry backoff for transient cache failures.',
      ...refusalMarkers,
    ]);
    const result = await runGovern(f.config);
    assert.deepEqual(result.intake, {
      ingestedCandidates: 1,
      disclosureRejectedCandidates: 3,
      disclosureCategories: { pii: 1, compensation: 1, secret: 1, other: 0 },
      tamperedFiles: 0,
      admissionRejectedFiles: 0,
    });
    assert.equal(result.ingested, 1);
    assert.equal(result.processed, 1);
    assert.equal(result.promoted, 1);
    for (const candidate of raw.candidates.slice(1)) {
      assert.equal(f.candidates.findById(candidate.id), null);
      assert.equal(
        f.db.prepare('SELECT COUNT(*) AS n FROM curated_memories WHERE id = ?').get(candidate.id).n,
        0,
      );
      assert.deepEqual(f.audit.findByMemory(candidate.id), []);
      assert.ok(!JSON.stringify(result).includes(candidate.id));
      assert.ok(!JSON.stringify(result).includes(candidate.content));
    }
    const archived = join(f.config.spoolPath, 'ingested', 'spool-mixed.jsonl');
    assert.deepEqual(readFileSync(archived), raw.bytes);
    assert.deepEqual(readFileSync(`${archived}.manifest.json`), raw.manifest);
    assert.equal(existsSync(raw.source), false);
    const before = f.audit.findAllChronological();
    const again = await runGovern(f.config);
    assert.equal(again.intake.ingestedCandidates, 0);
    assert.equal(again.intake.disclosureRejectedCandidates, 0);
    assert.equal(again.processed, 0);
    assert.deepEqual(f.audit.findAllChronological(), before);
    assertClean(f.audit);
  } finally {
    f.close();
  }
});

test('refusal-only spool produces counts without candidate, memory or audit rows', async () => {
  const f = fixture();
  try {
    rawSpool(f, refusalMarkers);
    const result = await runGovern(f.config);
    assert.equal(result.intake.disclosureRejectedCandidates, 3);
    assert.equal(result.ingested, 0);
    assert.equal(result.processed, 0);
    assert.equal(f.candidates.count(), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM curated_memories').get().n, 0);
    assert.deepEqual(f.audit.findAllChronological(), []);
  } finally {
    f.close();
  }
});

test('failed archive retains raw source and repeated refusals while inserted IDs stay deduplicated', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.config.spoolPath, 'ingested'), 'fixture: blocked archive directory');
    const raw = rawSpool(f, [
      'Use bounded retry backoff for transient cache failures.',
      ...refusalMarkers,
    ]);
    const first = await runGovern(f.config);
    const again = await runGovern(f.config);
    assert.equal(first.ingested, 1);
    assert.equal(again.ingested, 0);
    assert.equal(again.processed, 0);
    assert.equal(again.intake.disclosureRejectedCandidates, 3);
    assert.equal(f.candidates.count(), 1);
    assert.deepEqual(readFileSync(raw.source), raw.bytes);
    assert.deepEqual(readFileSync(`${raw.source}.manifest.json`), raw.manifest);
  } finally {
    f.close();
  }
});

test('failed intake has unavailable counts while existing inbox work still completes', async () => {
  const f = fixture();
  try {
    f.insert('Use bounded retry backoff for transient cache failures.');
    const blocked = join(f.config.basePath, 'not-a-spool-directory');
    writeFileSync(blocked, 'fixture');
    const result = await runGovern({ ...f.config, spoolPath: blocked });
    assert.equal(result.intake, null);
    assert.equal(result.ingested, 0);
    assert.equal(result.processed, 1);
    assert.equal(result.promoted, 1);
  } finally {
    f.close();
  }
});

test('unexpected insert failure propagates after earlier inserts instead of returning healthy zero counts', async () => {
  const f = fixture();
  try {
    const raw = rawSpool(f, [
      'Use bounded retry backoff for transient cache failures.',
      'Use bounded connection pools for storage operations.',
    ]);
    const original = CandidateRepository.prototype.insert;
    let calls = 0;
    mock.method(CandidateRepository.prototype, 'insert', function (...args) {
      if (++calls === 2) throw new Error('fixture-partial-intake-failure');
      return original.apply(this, args);
    });
    await assert.rejects(runGovern(f.config), /fixture-partial-intake-failure/);
    assert.equal(f.candidates.count(), 1);
    assert.ok(f.candidates.findById(raw.candidates[0].id));
    assert.deepEqual(readFileSync(raw.source), raw.bytes);
    assert.deepEqual(f.audit.findAllChronological(), []);
  } finally {
    f.close();
  }
});

function policy(f) {
  const now = new Date().toISOString();
  f.policies.insert(
    GovernancePolicy.parse({
      id: randomUUID(),
      name: 'mixed-fixture',
      tenantId,
      version: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      rules: [
        {
          id: 'length',
          type: 'content_length',
          action: 'reject',
          parameters: { min: 25 },
        },
        // A synthetic internal path gives a benign, deterministic hold trigger.
        // The canonical disclosure gate admits paths; this fixture policy flags
        // the classifier's internal tier without storing email/PII/credentials.
        {
          id: 'sensitivity',
          type: 'sensitivity_gate',
          action: 'flag',
          parameters: { blockedLevels: ['internal'] },
        },
        {
          id: 'audience',
          type: 'audience_narrowing',
          action: 'flag',
          parameters: {},
        },
        {
          id: 'sanitization',
          type: 'content_sanitization',
          action: 'flag',
          parameters: {},
        },
        {
          id: 'relevance',
          type: 'relevance_score',
          action: 'flag',
          parameters: { minimumScore: 0.99 },
        },
      ].map((rule, priority) => ({ ...rule, enabled: true, priority })),
    }),
  );
}

test('hard rejection retains content, receipts its real evaluation once, then becomes a no-op', async () => {
  const f = fixture();
  try {
    const candidate = f.insert('Too short');
    const summary = await runGovern(f.config);
    assert.equal(summary.rejected, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(f.candidates.findById(candidate.id).status, 'rejected');
    assert.equal(f.candidates.findById(candidate.id).content, candidate.content);
    const events = f.audit.findByMemory(candidate.id);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.action, 'deleted');
    assert.equal(event.memoryId, candidate.id);
    assert.equal(event.tenantId, tenantId);
    assert.deepEqual(event.actor, { type: 'system', id: 'curator' });
    const lengthRule = f.policies
      .findByTenant(tenantId)
      .find((policy) => policy.enabled)
      ?.rules.find((rule) => rule.enabled && rule.type === 'content_length');
    assert.ok(lengthRule);
    assert.ok(event.reason.includes(lengthRule.id));
    assert.equal(event.details.candidateId, candidate.id);
    assert.equal(event.details.outcome, 'rejected');
    assert.ok(
      event.details.evaluations.some(
        (evaluation) =>
          evaluation.ruleId === lengthRule.id &&
          evaluation.ruleType === 'content_length' &&
          evaluation.outcome === 'fail',
      ),
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM curated_memories').get().total, 0);
    assert.equal(
      f.audit.findAllChronological().filter((row) => row.action === 'governed').length,
      1,
    );
    assertClean(f.audit);
    const before = f.audit.findAllChronological();
    const second = await runGovern(f.config);
    assert.equal(second.processed, 0);
    assert.equal(second.rejected, 0);
    assert.deepEqual(f.audit.findAllChronological(), before);
  } finally {
    f.close();
  }
});

test('mixed sweep preserves review flags, human holds, member quarantine and other tenants', async () => {
  const f = fixture();
  try {
    policy(f);
    const rejected = f.insert('Tiny note');
    const flagged = f.insert('Use dependency injection for services throughout this application.');
    const held = f.insert(
      'Keep the synthetic notes under /home/synthetic-fixture/docs/ for this exercise.',
    );
    const member = f.insert('Member proposal requiring administrative review.', {
      metadata: { proposedByRole: 'member', filePaths: [], tags: [] },
    });
    const foreign = f.insert('Other note', { tenantId: 'other-tenant' });
    const result = await runGovern(f.config);
    assert.equal(result.processed, 4);
    assert.equal(result.rejected, 1);
    assert.equal(result.flagged, 1);
    assert.equal(result.held, 1);
    assert.equal(result.quarantined, 1);
    for (const [candidate, status] of [
      [rejected, 'rejected'],
      [flagged, 'inbox'],
      [held, 'quarantined'],
      [member, 'quarantined'],
      [foreign, 'inbox'],
    ]) {
      assert.equal(f.candidates.findById(candidate.id).status, status);
      assert.equal(f.candidates.findById(candidate.id).content, candidate.content);
    }
    assert.deepEqual(f.audit.findByMemory(flagged.id), []);
    assert.deepEqual(f.audit.findByMemory(foreign.id), []);
    const heldEvents = f.audit.findByMemory(held.id).filter((event) => event.action === 'held');
    assert.equal(heldEvents.length, 1);
    assert.ok(heldEvents[0].details.triggers.includes('sensitivity_gate_flag'));
    assert.ok(heldEvents[0].details.triggerRuleIds.includes('sensitivity'));
    assertClean(f.audit);
    const before = f.audit.findAllChronological();
    const second = await runGovern(f.config);
    assert.equal(second.processed, 1);
    assert.equal(second.flagged, 1);
    assert.deepEqual(f.audit.findAllChronological(), before);
  } finally {
    f.close();
  }
});

for (const failAction of ['deleted', 'governed']) {
  test(`${failAction} receipt failure rolls back rejection receipts and all deferred status flips`, async () => {
    const f = fixture();
    try {
      const first = f.insert('Short first');
      const second = f.insert('Short second');
      const member = f.insert('Member proposal for review.', {
        metadata: { proposedByRole: 'member', filePaths: [], tags: [] },
      });
      // Fail the final rejection in actual sweep order, so a prior append
      // must roll back regardless of same-millisecond capture ordering.
      const rejectionOrder = f.candidates
        .findByStatus('inbox', tenantId)
        .filter((candidate) => candidate.id !== member.id);
      const lastRejection = rejectionOrder.at(-1);
      const condition =
        failAction === 'deleted'
          ? `NEW.action = 'deleted' AND NEW.memory_id = '${lastRejection.id}'`
          : "NEW.action = 'governed'";
      f.db.exec(`CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON audit_events
        WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`);
      await assert.rejects(runGovern(f.config), /fixture receipt failure/);
      for (const candidate of [first, second, member]) {
        assert.equal(f.candidates.findById(candidate.id).status, 'inbox');
        assert.equal(f.candidates.findById(candidate.id).content, candidate.content);
      }
      assert.deepEqual(f.audit.findAllChronological(), []);
    } finally {
      f.close();
    }
  });
}

test('missing rejection pipeline evidence refuses settlement instead of dropping the receipt', async () => {
  const f = fixture();
  try {
    const candidate = f.insert('Tiny note');
    const original = Curator.prototype.processSingle;
    mock.method(Curator.prototype, 'processSingle', function (...args) {
      const result = original.apply(this, args);
      assert.equal(result.outcome, 'rejected');
      delete result.pipelineResult;
      return result;
    });
    await assert.rejects(runGovern(f.config), /missing pipeline evidence/);
    assert.equal(f.candidates.findById(candidate.id).status, 'inbox');
    assert.deepEqual(f.audit.findAllChronological(), []);
  } finally {
    f.close();
  }
});

for (const drift of ['status', 'tenant']) {
  test(`${drift} drift before settlement refuses without overwriting the changed row`, async () => {
    const f = fixture();
    try {
      const first = f.insert('Tiny first');
      const second = f.insert('Tiny second');
      const original = Curator.prototype.processSingle;
      mock.method(Curator.prototype, 'processSingle', function (...args) {
        const result = original.apply(this, args);
        if (args[0].id === second.id) {
          if (drift === 'status') f.candidates.updateStatus(second.id, 'duplicate', tenantId);
          else
            f.db
              .prepare('UPDATE candidates SET tenant_id = ? WHERE id = ?')
              .run('other-tenant', second.id);
        }
        return result;
      });
      await assert.rejects(runGovern(f.config), /settlement conflict/);
      assert.equal(f.candidates.findById(first.id).status, 'inbox');
      assert.equal(
        f.candidates.findById(second.id).status,
        drift === 'status' ? 'duplicate' : 'inbox',
      );
      assert.equal(
        f.candidates.findById(second.id).tenantId,
        drift === 'tenant' ? 'other-tenant' : tenantId,
      );
      assert.deepEqual(f.audit.findAllChronological(), []);
    } finally {
      f.close();
    }
  });
}

for (const drift of ['content', 'metadata']) {
  test(`${drift} snapshot drift refuses settlement and rolls back earlier pending rejections`, async () => {
    const f = fixture();
    try {
      f.insert('Tiny first');
      f.insert('Tiny second');
      const order = f.candidates.findByStatus('inbox', tenantId);
      const stable = order[0];
      const changed = order[1];
      const replacement =
        'Use dependency injection consistently throughout all application services.';
      const appended = [];
      const originalInsert = AuditRepository.prototype.insert;
      mock.method(AuditRepository.prototype, 'insert', function (event) {
        const result = originalInsert.call(this, event);
        appended.push({ action: event.action, memoryId: event.memoryId });
        return result;
      });
      const original = Curator.prototype.processSingle;
      mock.method(Curator.prototype, 'processSingle', function (...args) {
        const result = original.apply(this, args);
        assert.equal(result.outcome, 'rejected');
        if (args[0].id === changed.id) {
          if (drift === 'content') {
            assert.equal(
              f.candidates.updateContent(changed.id, tenantId, {
                content: replacement,
                title: changed.title,
              }),
              computeContentHash(replacement),
            );
          } else {
            const metadata = { ...changed.metadata, audience: 'owner' };
            f.db
              .prepare('UPDATE candidates SET metadata_json = ? WHERE id = ? AND tenant_id = ?')
              .run(JSON.stringify(metadata), changed.id, tenantId);
            // Also alter the original nested object after real evaluation. A
            // reference or shallow snapshot must not authorize this changed row.
            args[0].metadata.audience = 'owner';
          }
        }
        return result;
      });
      await assert.rejects(runGovern(f.config), /settlement conflict/);
      const current = f.candidates.findById(changed.id);
      assert.equal(current.status, 'inbox');
      assert.equal(current.tenantId, tenantId);
      assert.equal(current.content, drift === 'content' ? replacement : changed.content);
      assert.equal(current.metadata.audience, drift === 'metadata' ? 'owner' : undefined);
      assert.deepEqual(f.candidates.findById(stable.id), stable);
      // The earlier canonical append succeeded inside the transaction, but the
      // later conflict must roll back both its receipt and terminal status.
      assert.ok(
        appended.some((event) => event.action === 'deleted' && event.memoryId === stable.id),
      );
      assert.deepEqual(f.audit.findAllChronological(), []);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM curated_memories').get().total, 0);
    } finally {
      f.close();
    }
  });
}

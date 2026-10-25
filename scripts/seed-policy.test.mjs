/**
 * Fresh local-policy contracts for the provisioned local-stack lane.
 * Requires the paired public Registrar and compatible existing SQLite native
 * addon. No install, model, qmd, network or live-brain operation is performed.
 *
 * Public builder/registry define the policy; this test owns no rule template.
 * Direct Curator behavior is distinct from runGovern terminal settlement and
 * committed-bundle MCP proof. Enabled coverage is not ten decisions per input.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Curator } from '@qmd-team-intent-kb/curator';
import { computeContentHash } from '@qmd-team-intent-kb/common';
import { GovernancePolicy, MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  RULE_REGISTRY,
  RECOMMENDED_POLICY_RULES,
  buildRecommendedPolicy,
  findUncoveredRuleTypes,
  PolicyPipeline,
} from '@qmd-team-intent-kb/policy-engine';
import {
  createDatabase,
  CandidateRepository,
  MemoryRepository,
  PolicyRepository,
  AuditRepository,
  verifyAuditChain,
} from '@qmd-team-intent-kb/store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tenant = 'seed-fixture';
const fixedNow = '2026-10-25T12:00:00.000Z';
const longContent =
  'Use dependency injection consistently across application services and keep failure handling explicit in this invented fixture.';
let helperRoot;
let seedDefaultPolicy;

before(async () => {
  // Resolve public package imports from the checkout, not a /tmp parent.
  helperRoot = mkdtempSync(join(root, 'scripts', '.policy-seed-'));
  const output = join(helperRoot, 'seed-policy.mjs');
  await build({
    entryPoints: [join(root, 'src', 'seed-policy.ts')],
    outfile: output,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  ({ seedDefaultPolicy } = await import(pathToFileURL(output).href));
});
after(() => {
  if (helperRoot) rmSync(helperRoot, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'gsb-policy-seed-'));
  const db = createDatabase({ path: join(base, 'fixture.db') });
  const repos = {
    candidateRepo: new CandidateRepository(db),
    memoryRepo: new MemoryRepository(db),
    policyRepo: new PolicyRepository(db),
    auditRepo: new AuditRepository(db),
  };
  return {
    ...repos,
    db,
    rows: () => JSON.stringify(db.prepare('SELECT * FROM governance_policies ORDER BY id').all()),
    candidate(overrides = {}) {
      const candidate = MemoryCandidate.parse({
        id: randomUUID(),
        status: 'inbox',
        source: 'mcp',
        title: 'Synthetic policy fixture',
        content: longContent,
        category: 'reference',
        trustLevel: 'medium',
        author: { type: 'ai', id: 'fixture' },
        tenantId: tenant,
        metadata: { filePaths: [], tags: [] },
        capturedAt: fixedNow,
        ...overrides,
      });
      repos.candidateRepo.insert(candidate, computeContentHash(candidate.content));
      return candidate;
    },
    curate(candidate) {
      // Matching the plugin's suppressed evaluation receipts does not implement
      // its later rejection settlement; these cases assert returned outcomes.
      return new Curator(repos, {
        tenantId: tenant,
        suppressRejectionReceipts: true,
      }).processSingle(candidate);
    },
    close() {
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
function seeded(f) {
  assert.equal(seedDefaultPolicy(f.policyRepo, tenant), true);
  const policies = f.policyRepo.findByTenant(tenant);
  assert.equal(policies.length, 1);
  return policies[0];
}
function cleanChain(f) {
  const result = verifyAuditChain(f.auditRepo);
  assert.deepEqual(result.breaks, []);
  assert.equal(result.unverifiedRows, 0);
}

// Meaningful OLD counterexample: the old implementation persists only two
// enabled types and reports eight uncovered types, despite the registry's ten.
test('fresh seed persists the canonical recommended rules and covers the full current registry', () => {
  const f = fixture();
  try {
    const policy = seeded(f);
    assert.equal(policy.tenantId, tenant);
    assert.equal(policy.enabled, true);
    assert.equal(policy.version, 1);
    assert.deepEqual(policy.rules, RECOMMENDED_POLICY_RULES);
    assert.deepEqual(
      policy.rules
        .filter((rule) => rule.enabled)
        .map((rule) => rule.type)
        .sort(),
      Object.keys(RULE_REGISTRY).sort(),
    );
    assert.deepEqual(findUncoveredRuleTypes(policy), []);
    assert.equal(policy.rules.length, RECOMMENDED_POLICY_RULES.length);
    assert.equal(new Date(policy.createdAt).toISOString(), policy.createdAt);
    assert.equal(policy.updatedAt, policy.createdAt);
  } finally {
    f.close();
  }
});

test('repeated seeding preserves raw stored bytes, identity, timestamps and row count', () => {
  const f = fixture();
  try {
    const policy = seeded(f);
    const before = f.rows();
    assert.equal(seedDefaultPolicy(f.policyRepo, tenant), false);
    assert.equal(f.rows(), before);
    assert.deepEqual(f.policyRepo.findByTenant(tenant), [policy]);
  } finally {
    f.close();
  }
});

for (const existing of ['custom', 'disabled', 'legacy-two-rule']) {
  test(`preserves an existing ${existing} policy without a retrofit`, () => {
    const f = fixture();
    try {
      const recommended = buildRecommendedPolicy(tenant, fixedNow);
      const rules =
        existing === 'legacy-two-rule'
          ? recommended.rules.filter((rule) =>
              ['secret_detection', 'content_length'].includes(rule.type),
            )
          : existing === 'custom'
            ? recommended.rules
                .filter((rule) => rule.type === 'source_trust')
                .map((rule) => ({ ...rule, parameters: { minimumTrust: 'high' } }))
            : recommended.rules;
      const policy = GovernancePolicy.parse({
        ...recommended,
        name: `Existing ${existing}`,
        rules,
        enabled: existing !== 'disabled',
      });
      f.policyRepo.insert(policy);
      const before = f.rows();
      assert.equal(seedDefaultPolicy(f.policyRepo, tenant), false);
      assert.equal(f.rows(), before);
      assert.deepEqual(f.policyRepo.findByTenant(tenant), [policy]);
    } finally {
      f.close();
    }
  });
}

test('another tenant policy is preserved and does not suppress a fresh tenant seed', () => {
  const f = fixture();
  try {
    const foreign = buildRecommendedPolicy('foreign-fixture', fixedNow);
    f.policyRepo.insert(foreign);
    const foreignBefore = JSON.stringify(
      f.db.prepare('SELECT * FROM governance_policies WHERE tenant_id = ?').all('foreign-fixture'),
    );
    seeded(f);
    assert.equal(
      JSON.stringify(
        f.db
          .prepare('SELECT * FROM governance_policies WHERE tenant_id = ?')
          .all('foreign-fixture'),
      ),
      foreignBefore,
    );
    assert.deepEqual(f.policyRepo.findByTenant('foreign-fixture'), [foreign]);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM governance_policies').get().count, 2);
  } finally {
    f.close();
  }
});

test('a clean substantial interactive candidate still promotes through the actual seeded policy', () => {
  const f = fixture();
  try {
    seeded(f);
    const candidate = f.candidate();
    const result = f.curate(candidate);
    assert.equal(result.outcome, 'promoted');
    assert.ok(result.memoryId);
    assert.equal(f.memoryRepo.findById(result.memoryId).tenantId, tenant);
    assert.ok(
      f.auditRepo.findByMemory(result.memoryId).some((event) => event.action === 'promoted'),
    );
    cleanChain(f);
  } finally {
    f.close();
  }
});

test('the canonical short-content hard reject remains a real evaluated rejection', () => {
  const f = fixture();
  try {
    seeded(f);
    const candidate = f.candidate({ content: 'Tiny note' });
    const result = f.curate(candidate);
    assert.equal(result.outcome, 'rejected');
    const rule = RECOMMENDED_POLICY_RULES.find((item) => item.type === 'content_length');
    assert.equal(result.pipelineResult.rejectedBy, rule.id);
    assert.ok(
      result.pipelineResult.evaluations.some(
        (evaluation) => evaluation.ruleId === rule.id && evaluation.outcome === 'fail',
      ),
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM curated_memories').get().count, 0);
  } finally {
    f.close();
  }
});

test('a valid but low-relevance interactive note remains inbox review instead of auto-promotion', () => {
  const f = fixture();
  try {
    seeded(f);
    const candidate = f.candidate({ content: 'Keep concise fixture review notes.' });
    const result = f.curate(candidate);
    assert.equal(result.outcome, 'flagged');
    const rule = RECOMMENDED_POLICY_RULES.find((item) => item.type === 'relevance_score');
    assert.ok(result.pipelineResult.flaggedBy.includes(rule.id));
    assert.equal(f.candidateRepo.findById(candidate.id).status, 'inbox');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM curated_memories').get().count, 0);
  } finally {
    f.close();
  }
});

test('a synthetic reserved-domain contact triggers a real human hold without real personal data', () => {
  const f = fixture();
  try {
    seeded(f);
    // The canonical disclosure gate admits this invented reserved-domain email;
    // the sensitivity classifier still recognizes its email SHAPE. No real PII.
    const candidate = f.candidate({
      content:
        'Contact fixture@example.invalid for invented release coordination and application documentation.',
    });
    const result = f.curate(candidate);
    assert.equal(result.outcome, 'held');
    assert.equal(f.candidateRepo.findById(candidate.id).status, 'quarantined');
    assert.ok(result.hold.triggers.includes('sensitivity_gate_flag'));
    const events = f.auditRepo.findByMemory(candidate.id);
    assert.equal(events.filter((event) => event.action === 'held').length, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM curated_memories').get().count, 0);
    cleanChain(f);
  } finally {
    f.close();
  }
});

for (const [trustLevel, expected] of [
  ['low', 'promoted'],
  ['untrusted', 'flagged'],
]) {
  test(`actual seeded source-trust default gives ${expected} for ${trustLevel}`, () => {
    const f = fixture();
    try {
      seeded(f);
      const candidate = f.candidate({ trustLevel });
      const result = f.curate(candidate);
      assert.equal(result.outcome, expected);
      const rule = RECOMMENDED_POLICY_RULES.find((item) => item.type === 'source_trust');
      const evaluation = result.pipelineResult.evaluations.find((item) => item.ruleId === rule.id);
      assert.equal(evaluation.outcome, trustLevel === 'low' ? 'pass' : 'flag');
      if (expected === 'flagged')
        assert.equal(f.candidateRepo.findById(candidate.id).status, 'inbox');
    } finally {
      f.close();
    }
  });
}

test('the persisted tenant rule enforces explicit pipeline context without writing another tenant', () => {
  const f = fixture();
  try {
    const policy = seeded(f);
    const candidate = f.candidate();
    const pipeline = new PolicyPipeline(policy);
    const before = f.rows();
    assert.equal(pipeline.evaluate(candidate, { tenantId: tenant }).outcome, 'approved');
    const result = pipeline.evaluate(candidate, { tenantId: 'foreign-fixture' });
    const rule = RECOMMENDED_POLICY_RULES.find((item) => item.type === 'tenant_match');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.rejectedBy, rule.id);
    assert.deepEqual(f.policyRepo.findByTenant('foreign-fixture'), []);
    assert.equal(f.rows(), before);
    assert.equal(f.candidateRepo.findById(candidate.id).status, 'inbox');
    assert.deepEqual(f.auditRepo.findAllChronological(), []);
  } finally {
    f.close();
  }
});

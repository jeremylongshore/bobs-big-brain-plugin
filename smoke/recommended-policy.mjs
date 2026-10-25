#!/usr/bin/env node
/**
 * Committed-bundle recommended-policy regression, after a genuine rebuild.
 * An optional argument selects the plugin checkout for an isolated local run.
 * Actual committed MCP and runtime-local native SQLite; private invented data.
 * No source Registrar imports, native provisioning, qmd, models or live policy.
 * The companion node contract binds persisted rules to the public registry and
 * exact recommended template. Here ten enabled types is a coverage count, not
 * ten independent decisions per capture or a fail-closed seed-failure claim.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main() {
  const repo =
    process.argv[2] === undefined
      ? fileURLToPath(new URL('..', import.meta.url))
      : resolve(process.argv[2]);
  assert.ok(isAbsolute(repo));
  const runtime = join(repo, 'plugin-runtime', 'governed-brain.cjs');
  const clientRequire = createRequire(join(repo, 'package.json'));
  const { Client } = await import(
    pathToFileURL(clientRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(clientRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
  );
  const Database = createRequire(join(repo, 'plugin-runtime', 'package.json'))('better-sqlite3');
  const work = mkdtempSync(join(tmpdir(), 'gsb-recommended-policy-'));
  const base = join(work, 'brain');
  const home = join(work, 'home');
  const tools = join(work, 'tools');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(tools, { mode: 0o700 });
  symlinkSync(realpathSync(process.execPath), join(tools, 'node'));
  symlinkSync('/usr/bin/git', join(tools, 'git'));
  const tenant = 'recommended-policy-fixture';
  const deadline = Date.now() + 120_000;
  const cases = [];
  let phase = 'setup';
  let passed = false;
  let session;
  let finalProjection;
  const inspectedColumns = {
    governance_policies: [
      'id',
      'name',
      'tenant_id',
      'rules_json',
      'enabled',
      'version',
      'created_at',
      'updated_at',
    ],
    candidates: ['id', 'status', 'tenant_id', 'content_hash', 'category', 'trust_level'],
    curated_memories: ['id', 'candidate_id', 'tenant_id', 'lifecycle', 'content_hash', 'category'],
    audit_events: [
      'id',
      'action',
      'memory_id',
      'tenant_id',
      'actor_json',
      'reason',
      'details_json',
      'timestamp',
      'seq',
      'hash_version',
      'entry_hash',
      'prev_entry_hash',
    ],
  };
  function ensure(value, message = 'Fixture assertion failed') {
    assert.ok(value, message);
  }
  async function bounded(operation, milliseconds) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Fixture operation deadline')), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function budget() {
    const remaining = deadline - Date.now();
    ensure(remaining > 0, 'Fixture total deadline');
    return Math.min(20_000, remaining);
  }
  function view() {
    const path = join(base, 'teamkb.db');
    ensure(existsSync(path), 'Fixture database missing');
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      // These are exactly the inspected columns, not all database tables/fields.
      return Object.fromEntries(
        Object.entries(inspectedColumns).map(([table, columns]) => [
          table,
          db
            .prepare(
              `SELECT ${columns.join(',')} FROM ${table} ORDER BY ${table === 'audit_events' ? 'seq' : 'id'}`,
            )
            .all(),
        ]),
      );
    } finally {
      db.close();
    }
  }
  function candidateRow(state, id) {
    const rows = state.candidates.filter((row) => row.id === id);
    ensure(rows.length === 1, 'Candidate readback mismatch');
    ensure(rows[0].tenant_id === tenant, 'Candidate tenant mismatch');
    return rows[0];
  }
  function eventsFor(state, id) {
    return state.audit_events.filter((event) => event.memory_id === id);
  }
  function assertNoMemory(state, id) {
    ensure(
      !state.curated_memories.some((memory) => memory.candidate_id === id),
      'Unexpected curated memory',
    );
  }
  async function call(name, args = {}) {
    const result = await bounded(
      session.client.callTool({ name, arguments: args }, undefined, { timeout: budget() }),
      budget(),
    );
    ensure(!result.isError, 'Unexpected MCP protocol error');
    const text = result.content.find((item) => item.type === 'text')?.text;
    ensure(typeof text === 'string', 'Missing structured reply');
    const value = JSON.parse(text);
    ensure(value.ok === true, 'Tool reported failure');
    ensure(session.stderrBytes <= 128 * 1024, 'Fixture stderr bound');
    return value;
  }
  async function capture(args) {
    const result = await call('brain_capture', args);
    ensure(typeof result.candidateId === 'string', 'Capture identity missing');
    return result.candidateId;
  }
  function noNewDecisions(summary) {
    ensure(
      summary.promoted === 0 &&
        summary.rejected === 0 &&
        summary.held === 0 &&
        summary.quarantined === 0 &&
        summary.duplicates === 0 &&
        summary.skipped === 0,
      'Unexpected govern decision',
    );
  }
  function complete(name) {
    cases.push({ name, passed: true });
  }
  async function close() {
    const closeDeadline = Date.now() + 8_000;
    await bounded(session.client.close(), 6_000);
    // SDK close may resolve just after signaling SIGKILL. Await actual transport
    // close before own-root removal; never guess a PID or signal a reused group.
    while (!session.closed && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ensure(session.closed, 'Transport close not established');
  }
  try {
    const transport = new StdioClientTransport({
      command: realpathSync(process.execPath),
      args: [runtime],
      cwd: work,
      env: {
        PATH: tools,
        HOME: home,
        TMPDIR: work,
        LANG: 'C.UTF-8',
        TEAMKB_BASE_PATH: base,
        TEAMKB_TENANT_ID: tenant,
        TEAMKB_DENSE_ENABLED: 'false',
        TEAMKB_QMD_BIN: join(work, 'intentionally-missing-qmd'),
        TEAMKB_QMD_RUNTIME: '',
        TEAMKB_ORIGIN_SECRET: '',
        TEAMKB_API_URL: '',
        TEAMKB_API_TOKEN: '',
        GIT_CONFIG_NOSYSTEM: '1',
        DO_NOT_TRACK: '1',
        COREPACK_ENABLE_NETWORK: '0',
      },
      stderr: 'pipe',
    });
    session = {
      client: new Client(
        { name: 'recommended-policy-fixture', version: '1' },
        { capabilities: {} },
      ),
      transport,
      closed: false,
      stderrBytes: 0,
    };
    transport.stderr?.on('data', (chunk) => {
      session.stderrBytes += chunk.length;
    });
    await bounded(session.client.connect(transport), budget());
    const previousClose = transport.onclose;
    transport.onclose = () => {
      session.closed = true;
      previousClose?.();
    };
    const listed = await bounded(session.client.listTools(), budget());
    ensure(
      ['brain_capture', 'brain_govern', 'brain_audit_verify'].every((name) =>
        listed.tools.some((tool) => tool.name === name),
      ),
      'Required tool missing',
    );

    phase = 'fresh-empty-govern-seeds-complete-policy';
    const first = await call('brain_govern');
    ensure(first.processed === 0 && first.ingested === 0, 'Unexpected fresh inbox');
    noNewDecisions(first);
    const initial = view();
    ensure(initial.governance_policies.length === 1, 'Unexpected policy count');
    const policy = initial.governance_policies[0];
    const rules = JSON.parse(policy.rules_json);
    ensure(
      policy.enabled === 1 && policy.version === 1 && policy.tenant_id === tenant,
      'Policy identity mismatch',
    );
    ensure(
      rules.length === 10 && rules.every((rule) => rule.enabled === true),
      'Incomplete enabled policy',
    );
    ensure(new Set(rules.map((rule) => rule.type)).size === 10, 'Duplicate policy type');
    ensure(new Set(rules.map((rule) => rule.id)).size === 10, 'Duplicate policy rule ID');
    ensure(
      new Date(policy.created_at).toISOString() === policy.created_at &&
        policy.updated_at === policy.created_at,
      'Policy timestamps mismatch',
    );
    ensure(
      initial.candidates.length === 0 &&
        initial.curated_memories.length === 0 &&
        initial.audit_events.length === 0,
      'Unexpected fresh rows',
    );
    const lengthRule = rules.find((rule) => rule.type === 'content_length');
    ensure(lengthRule && lengthRule.action === 'reject', 'Configured length rule missing');
    complete(phase);

    phase = 'second-empty-govern-preserves-policy-bytes-and-identity';
    const second = await call('brain_govern');
    ensure(second.processed === 0 && second.ingested === 0, 'Unexpected second inbox');
    noNewDecisions(second);
    assert.deepEqual(view(), initial, 'Second empty govern changed inspected rows');
    complete(phase);

    phase = 'long-clean-interactive-capture-promotes';
    const promotedId = await capture({
      title: 'Synthetic deterministic boundary decision',
      category: 'decision',
      content:
        'Keep deterministic admission checks separate from model proposals and document accepted boundaries for each invented service in this private fixture.',
    });
    const promoted = await call('brain_govern');
    ensure(
      promoted.ingested === 1 &&
        promoted.promoted === 1 &&
        promoted.rejected === 0 &&
        promoted.flagged === 0 &&
        promoted.held === 0 &&
        promoted.skipped === 0,
      'Clean promotion failed',
    );
    let state = view();
    ensure(candidateRow(state, promotedId).status === 'promoted', 'Candidate not promoted');
    const memory = state.curated_memories.find((row) => row.candidate_id === promotedId);
    ensure(
      memory && memory.tenant_id === tenant && memory.lifecycle === 'active',
      'Promoted memory missing',
    );
    ensure(
      eventsFor(state, memory.id).filter((event) => event.action === 'promoted').length === 1,
      'Promotion receipt mismatch',
    );
    complete(phase);

    phase = 'short-capture-terminal-rejection-matches-configured-rule';
    const shortId = await capture({
      title: 'Synthetic short note',
      content: 'Tiny note',
      category: 'pattern',
    });
    const beforeShort = view();
    const short = await call('brain_govern');
    ensure(
      short.ingested === 1 &&
        short.rejected === 1 &&
        short.promoted === 0 &&
        short.flagged === 0 &&
        short.held === 0 &&
        short.skipped === 0,
      'Short rejection failed',
    );
    state = view();
    ensure(candidateRow(state, shortId).status === 'rejected', 'Short candidate not terminal');
    assertNoMemory(state, shortId);
    const deleted = eventsFor(state, shortId).filter((event) => event.action === 'deleted');
    ensure(deleted.length === 1, 'Canonical rejection count mismatch');
    const details = JSON.parse(deleted[0].details_json);
    ensure(
      deleted[0].tenant_id === tenant && deleted[0].reason === `Rejected by rule: ${lengthRule.id}`,
      'Configured rejection identity mismatch',
    );
    assert.deepEqual(
      JSON.parse(deleted[0].actor_json),
      { type: 'system', id: 'curator' },
      'Rejection actor mismatch',
    );
    ensure(
      details.candidateId === shortId && details.outcome === 'rejected',
      'Rejection details mismatch',
    );
    ensure(
      details.evaluations.some(
        (evaluation) =>
          evaluation.ruleId === lengthRule.id &&
          evaluation.ruleType === 'content_length' &&
          evaluation.outcome === 'fail',
      ),
      'Length evaluation missing',
    );
    const newShortEvents = state.audit_events.slice(beforeShort.audit_events.length);
    ensure(
      newShortEvents.length === 2 &&
        newShortEvents.filter((event) => event.action === 'governed').length === 1,
      'Rejection batch receipt mismatch',
    );
    complete(phase);

    phase = 'terminal-rejection-repeat-does-not-add-events';
    const afterShort = view();
    const repeatShort = await call('brain_govern');
    ensure(repeatShort.processed === 0 && repeatShort.ingested === 0, 'Rejected row reprocessed');
    noNewDecisions(repeatShort);
    assert.deepEqual(view(), afterShort, 'Repeated short rejection changed inspected rows');
    complete(phase);

    phase = 'low-relevance-interactive-note-remains-inbox-review';
    const flaggedId = await capture({
      title: 'Synthetic review note',
      content: 'Keep concise fixture review notes.',
      category: 'reference',
    });
    const beforeFlag = view();
    const flagged = await call('brain_govern');
    ensure(
      flagged.processed === 1 && flagged.ingested === 1 && flagged.flagged === 1,
      'Expected review flag missing',
    );
    noNewDecisions(flagged);
    state = view();
    ensure(candidateRow(state, flaggedId).status === 'inbox', 'Flagged row retired');
    assertNoMemory(state, flaggedId);
    assert.deepEqual(
      state.audit_events,
      beforeFlag.audit_events,
      'Review-only pass added decision receipt',
    );
    complete(phase);

    phase = 'reserved-domain-contact-enters-human-hold';
    const heldId = await capture({
      title: 'Synthetic contact review',
      category: 'onboarding',
      content:
        'Contact fixture@example.invalid for invented release coordination and application documentation.',
    });
    const beforeHold = view();
    const held = await call('brain_govern');
    // The earlier flagged candidate remains eligible for re-evaluation.
    ensure(
      held.processed === 2 &&
        held.ingested === 1 &&
        held.flagged === 1 &&
        held.held === 1 &&
        held.promoted === 0 &&
        held.rejected === 0 &&
        held.quarantined === 0 &&
        held.skipped === 0,
      'Human hold counts mismatch',
    );
    state = view();
    ensure(candidateRow(state, heldId).status === 'quarantined', 'Held row not quarantined');
    ensure(candidateRow(state, flaggedId).status === 'inbox', 'Review row changed');
    assertNoMemory(state, heldId);
    const heldEvents = eventsFor(state, heldId).filter((event) => event.action === 'held');
    ensure(heldEvents.length === 1, 'Hold receipt count mismatch');
    const holdDetails = JSON.parse(heldEvents[0].details_json);
    ensure(
      heldEvents[0].tenant_id === tenant && holdDetails.candidateId === heldId,
      'Hold identity mismatch',
    );
    ensure(
      holdDetails.triggers.includes('sensitivity_gate_flag') &&
        holdDetails.triggers.includes('audience_narrowing_flag'),
      'Canonical hold triggers missing',
    );
    for (const type of ['sensitivity_gate', 'audience_narrowing']) {
      const rule = rules.find((item) => item.type === type);
      ensure(
        rule && holdDetails.triggerRuleIds.includes(rule.id),
        'Configured hold rule ID mismatch',
      );
    }
    const newHoldEvents = state.audit_events.slice(beforeHold.audit_events.length);
    ensure(
      newHoldEvents.length === 2 &&
        newHoldEvents.filter((event) => event.action === 'governed').length === 1,
      'Hold batch receipt mismatch',
    );
    complete(phase);

    phase = 'review-and-held-repeat-adds-no-decisions-or-receipts';
    const afterHold = view();
    const repeat = await call('brain_govern');
    ensure(
      repeat.processed === 1 && repeat.ingested === 0 && repeat.flagged === 1,
      'Review repeat counts mismatch',
    );
    noNewDecisions(repeat);
    assert.deepEqual(view(), afterHold, 'Review repeat changed inspected rows');
    ensure(
      candidateRow(afterHold, heldId).status === 'quarantined' &&
        candidateRow(afterHold, shortId).status === 'rejected',
      'Terminal state changed',
    );
    complete(phase);

    phase = 'real-chain-and-private-anchor-verify';
    const audit = await call('brain_audit_verify');
    ensure(
      audit.ok === true &&
        audit.anchorCount >= 1 &&
        audit.tamperSignatures === 0 &&
        audit.anchorBreaks === 0 &&
        audit.totalEvents === afterHold.audit_events.length,
      'Audit verification failed',
    );
    const final = view();
    assert.deepEqual(
      final.governance_policies,
      initial.governance_policies,
      'Policy changed during fixture',
    );
    finalProjection = {
      policy: {
        id: policy.id,
        tenantId: policy.tenant_id,
        enabled: policy.enabled,
        version: policy.version,
        createdAt: policy.created_at,
        updatedAt: policy.updated_at,
        rules: rules.map(({ id, type, action, enabled }) => ({ id, type, action, enabled })),
      },
      candidates: final.candidates.map(({ id, status, tenant_id, category, trust_level }) => ({
        id,
        status,
        tenantId: tenant_id,
        category,
        trustLevel: trust_level,
      })),
      memories: final.curated_memories.map(({ id, candidate_id, tenant_id, lifecycle }) => ({
        id,
        candidateId: candidate_id,
        tenantId: tenant_id,
        lifecycle,
      })),
      audit: final.audit_events.map(({ id, action, memory_id, tenant_id, seq, hash_version }) => ({
        id,
        action,
        memoryId: memory_id,
        tenantId: tenant_id,
        seq,
        hashVersion: hash_version,
      })),
    };
    complete(phase);
    passed = true;
  } catch {
    process.exitCode = 1; // Never log raw assertion values, tool replies or stderr.
  } finally {
    let closed = session === undefined;
    if (session) {
      try {
        await close();
        closed = true;
      } catch {
        process.exitCode = 1;
      }
    }
    if (closed) rmSync(work, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        passed: passed && closed,
        completedCases: cases.length,
        failedPhase: passed ? undefined : phase,
        clientClosureEstablished: closed,
        scratchRemoved: !existsSync(work),
        retainedScratch: closed ? undefined : work,
        inspectedColumns,
        finalProjection,
        scope: 'selected policy/candidate/memory/audit columns; not all DB or filesystem state',
        noActualQmd: true,
        denseEnabled: false,
        registryTemplateBinding: 'separate real-store node contract; no source SDK imported here',
        allTenDecisionsPerCaptureClaim: false,
        seedFailureFailClosedClaim: false,
        policyMigrationOrHumanApprovalToolAdded: false,
      }),
    );
  }
}
void main().catch(() => {
  process.exitCode = 1;
  console.log(JSON.stringify({ passed: false, failedPhase: 'setup-or-finalization' }));
});

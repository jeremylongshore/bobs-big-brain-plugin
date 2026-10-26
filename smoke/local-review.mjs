#!/usr/bin/env node
/** actual rebuilt MCP + thin local-review CLI against one private DB.
 * External client SDK resolves from the selected checkout; server/helper/native
 * dependencies resolve from its runtime. This is not a clean-install proof.
 * Selected DB columns and explicit export/anchor witnesses only; no live data,
 * actual qmd, model, provisioning, physical-human or whole-filesystem claim.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main() {
  const repo = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
  // Optional separate client checkout supports testing a copied runtime whose
  // package intentionally contains no client SDK or repository-root node_modules.
  const clientRepo = resolve(process.argv[3] || repo);
  const node = realpathSync(process.execPath);
  const requireClient = createRequire(join(clientRepo, 'package.json'));
  const { Client } = await import(
    pathToFileURL(requireClient.resolve('@modelcontextprotocol/sdk/client/index.js')).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(requireClient.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
  );
  const Database = createRequire(join(repo, 'plugin-runtime/package.json'))('better-sqlite3');
  const work = mkdtempSync(join(tmpdir(), 'gsb-local-review-'));
  const base = join(work, 'brain');
  const home = join(work, 'home');
  const tools = join(work, 'tools');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(tools, { mode: 0o700 });
  symlinkSync(node, join(tools, 'node'));
  symlinkSync('/usr/bin/git', join(tools, 'git'));
  const tenant = 'local-review-fixture';
  const actor = 'fixture-person';
  const reason = 'Synthetic person review';
  const clock = join(work, 'future-clock.cjs');
  // CLI-only wall clock offset. No audit-row mutation, waiting, or model clock.
  writeFileSync(
    clock,
    `const RealDate = Date; const offset = 31 * 86400000;
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
      static now() { return RealDate.now() + offset; }
    };`,
    { mode: 0o600, flag: 'wx' },
  );
  const env = {
    PATH: tools,
    HOME: home,
    TMPDIR: work,
    LANG: 'C.UTF-8',
    TEAMKB_BASE_PATH: base,
    TEAMKB_TENANT_ID: tenant,
    TEAMKB_DENSE_ENABLED: 'false',
    TEAMKB_QMD_BIN: join(work, 'missing-qmd'),
    TEAMKB_QMD_RUNTIME: '',
    TEAMKB_ORIGIN_SECRET: '',
    TEAMKB_API_URL: '',
    TEAMKB_API_TOKEN: '',
    GIT_CONFIG_NOSYSTEM: '1',
    DO_NOT_TRACK: '1',
    COREPACK_ENABLE_NETWORK: '0',
  };
  const deadline = Date.now() + 180_000;
  const cases = [];
  let phase = 'setup';
  let passed = false;
  let session;
  let activeCli = 0;
  let projection;
  let registrarMcpProjection;
  const inspectedColumns = {
    governance_policies: ['id', 'tenant_id', 'rules_json', 'enabled', 'created_at', 'updated_at'],
    candidates: [
      'id',
      'tenant_id',
      'status',
      'source',
      'author_json',
      'category',
      'content',
      'content_hash',
      'metadata_json',
    ],
    curated_memories: [
      'id',
      'candidate_id',
      'tenant_id',
      'lifecycle',
      'category',
      'content_hash',
      'metadata_json',
    ],
    audit_events: [
      'id',
      'memory_id',
      'tenant_id',
      'action',
      'actor_json',
      'reason',
      'details_json',
      'timestamp',
      'seq',
      'entry_hash',
      'prev_entry_hash',
    ],
  };
  const ensure = (value, message = 'Fixture assertion failed') => assert.ok(value, message);
  function budget() {
    const remaining = deadline - Date.now();
    ensure(remaining > 0, 'Fixture total deadline');
    return Math.min(25_000, remaining);
  }
  async function bounded(operation, ms) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Fixture operation deadline')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function view() {
    const db = new Database(join(base, 'teamkb.db'), { readonly: true, fileMustExist: true });
    try {
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
  const candidate = (state, id) => {
    const row = state.candidates.find((item) => item.id === id);
    ensure(row && row.tenant_id === tenant, 'Candidate identity mismatch');
    return row;
  };
  const events = (state, id) =>
    state.audit_events.filter((item) => item.memory_id === id && item.tenant_id === tenant);
  const complete = () => cases.push({ name: phase, passed: true });
  async function call(name, args = {}) {
    const reply = await bounded(
      session.client.callTool({ name, arguments: args }, undefined, { timeout: budget() }),
      budget(),
    );
    ensure(!reply.isError, 'MCP protocol failure');
    const text = reply.content.find((item) => item.type === 'text')?.text;
    ensure(typeof text === 'string', 'MCP structured reply missing');
    const result = JSON.parse(text);
    ensure(result.ok === true, 'MCP tool failure');
    return result;
  }
  async function capture(title, content, category) {
    const value = await call('brain_capture', { title, content, category });
    ensure(typeof value.candidateId === 'string', 'Capture identity missing');
    return value.candidateId;
  }
  async function cli(args, { future = false, expectedExit = 0, scopeTenant = tenant } = {}) {
    const argv = [
      ...(future ? ['--require', clock] : []),
      join(repo, 'bin/review.mjs'),
      ...args,
      '--base',
      base,
      '--tenant',
      scopeTenant,
    ];
    activeCli++;
    let stdout = '';
    let bytes = 0;
    let failed = false;
    let timer;
    // ChildProcess.kill addresses this still-owned, unreaped child handle; no
    // numeric negative-group signals or post-reap PID ownership inference.
    const child = spawn(node, argv, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await new Promise((resolveResult, reject) => {
      const stop = () => {
        failed = true;
        child.kill('SIGKILL');
      };
      timer = setTimeout(stop, budget());
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) stop();
        else stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) stop();
      });
      child.on('error', () => {
        failed = true;
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        activeCli--;
        if (failed || signal || code !== expectedExit)
          reject(new Error('CLI termination mismatch'));
        else {
          try {
            resolveResult(JSON.parse(stdout));
          } catch {
            reject(new Error('CLI structured reply missing'));
          }
        }
      });
    });
    return result;
  }
  const writeArgs = (operation, id, extra = []) => [
    operation,
    '--candidate',
    id,
    '--actor',
    actor,
    '--reason',
    reason,
    '--role',
    'owner',
    ...extra,
  ];
  function personReceipt(event, id, action) {
    ensure(
      event && event.memory_id === id && event.tenant_id === tenant && event.action === action,
      'Receipt scope mismatch',
    );
    assert.deepEqual(
      JSON.parse(event.actor_json),
      { type: 'human', id: actor },
      'Declared actor mismatch',
    );
    ensure(event.reason === reason, 'Receipt reason mismatch');
    ensure(Number.isInteger(event.seq) && event.entry_hash, 'Receipt chain fields missing');
  }
  async function unchangedRefusal(args, code, options = {}) {
    const before = view();
    const result = await cli(args, { ...options, expectedExit: 1 });
    ensure(
      !result.ok && result.committed === false && result.code === code,
      'Refusal shape mismatch',
    );
    assert.deepEqual(view(), before, 'Refusal changed inspected rows');
    return result;
  }
  try {
    const transport = new StdioClientTransport({
      command: node,
      args: [join(repo, 'plugin-runtime/governed-brain.cjs')],
      cwd: work,
      env,
      stderr: 'pipe',
    });
    session = {
      client: new Client({ name: 'local-review-fixture', version: '1' }, { capabilities: {} }),
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
    const toolsReply = await bounded(session.client.listTools(), budget());
    ensure(
      toolsReply.tools.length === 6 &&
        !toolsReply.tools.some((tool) => /review|approve|resolve/.test(tool.name)),
      'MCP authority surface changed',
    );

    phase = 'fresh-policy-and-clean-promotion';
    const first = await call('brain_govern');
    ensure(first.processed === 0, 'Fresh inbox not empty');
    const policy = view().governance_policies;
    ensure(policy.length === 1 && policy[0].enabled === 1, 'Fresh policy missing');
    const rules = JSON.parse(policy[0].rules_json);
    ensure(
      rules.length === 10 &&
        rules.every((rule) => rule.enabled) &&
        new Set(rules.map((rule) => rule.type)).size === 10,
      'Fresh policy coverage mismatch',
    );
    const cleanId = await capture(
      'Synthetic deterministic decision',
      'Keep admission checks separate from model proposals and document the accepted boundaries of this invented private service.',
      'decision',
    );
    ensure((await call('brain_govern')).promoted === 1, 'Clean promotion missing');
    const cleanMemory = view().curated_memories.find((row) => row.candidate_id === cleanId);
    ensure(cleanMemory?.lifecycle === 'active', 'Clean memory missing');
    complete();

    phase = 'registrar-mcp-envelope-refusal-and-person-rejection';
    // Seed the current Registrar MCP classification envelope into this private
    // store. The Registrar owns producer/spool compatibility tests; this fixture
    // tests the actual committed consumer bundle, not a live/producer capture.
    const proposalIds = {};
    const proposalDb = new Database(join(base, 'teamkb.db'), {
      fileMustExist: true,
    });
    try {
      for (const [kind, author, content] of [
        [
          'ai',
          { type: 'ai', id: 'mcp-server' },
          'When the synthetic fixture service retries a transient request, keep the retry limit in configuration and record the final outcome in a private diagnostic log.',
        ],
        [
          'operator',
          { type: 'human', id: 'fixture-person' },
          'The synthetic fixture service uses a separate verification queue for dependency updates so operators can inspect a change before enabling it.',
        ],
      ]) {
        const id = randomUUID();
        proposalIds[kind] = id;
        proposalDb
          .prepare(
            `INSERT INTO candidates (
          id, status, source, content, title, category, trust_level,
          author_json, tenant_id, metadata_json, pre_policy_flags_json,
          content_hash, captured_at
        ) VALUES (@id, 'inbox', 'mcp', @content, @title, 'reference', 'medium',
          @author, @tenant, @metadata, '{}', @hash, @at)`,
          )
          .run({
            id,
            content,
            title: `Synthetic ${kind} proposal`,
            author: JSON.stringify(author),
            tenant,
            metadata: JSON.stringify({ filePaths: [], tags: [] }),
            hash: createHash('sha256').update(content, 'utf8').digest('hex'),
            at: new Date().toISOString(),
          });
      }
    } finally {
      proposalDb.close();
    }
    const proposalGovern = await call('brain_govern');
    const proposalState = view();
    registrarMcpProjection = {
      promoted: proposalGovern.promoted,
      flagged: proposalGovern.flagged,
      aiStatus: candidate(proposalState, proposalIds.ai).status,
      aiMemoryPresent: proposalState.curated_memories.some(
        (row) => row.candidate_id === proposalIds.ai,
      ),
      operatorStatus: candidate(proposalState, proposalIds.operator).status,
      captureScope:
        'seeded equivalent envelope; no actual Registrar producer invocation',
    };
    ensure(
      registrarMcpProjection.aiStatus === 'inbox' &&
        !registrarMcpProjection.aiMemoryPresent,
      'Registrar MCP AI proposal was automatically admitted by the committed bundle',
    );
    ensure(
      proposalGovern.flagged === 1 &&
        proposalGovern.promoted === 1 &&
        registrarMcpProjection.operatorStatus === 'promoted',
      'MCP classification or operator control mismatch',
    );
    const beforeRetry = view();
    const retried = await call('brain_govern');
    ensure(
      retried.flagged === 1 && retried.promoted === 0,
      'Retry admitted review-pending proposal',
    );
    assert.deepEqual(
      view(),
      beforeRetry,
      'Review-only retry changed inspected rows or receipts',
    );
    const proposalList = await cli(['list']);
    ensure(
      proposalList.pending.some(
        (row) => row.candidateId === proposalIds.ai && row.status === 'inbox',
      ),
      'Review-pending MCP proposal missing from local person queue',
    );
    const rejectedProposal = await cli(writeArgs('reject', proposalIds.ai));
    ensure(
      rejectedProposal.ok &&
        rejectedProposal.committed &&
        rejectedProposal.disposition === 'rejected',
      'Person rejection of MCP proposal failed',
    );
    const rejectedProposalState = view();
    ensure(
      candidate(rejectedProposalState, proposalIds.ai).status === 'rejected' &&
        !rejectedProposalState.curated_memories.some(
          (row) => row.candidate_id === proposalIds.ai,
        ),
      'Rejected MCP proposal was admitted',
    );
    personReceipt(
      events(rejectedProposalState, proposalIds.ai).find(
        (event) => event.id === rejectedProposal.auditEventId,
      ),
      proposalIds.ai,
      'deleted',
    );
    registrarMcpProjection.personRejectionReceipted = true;
    complete();

    phase = 'pending-and-three-independent-human-holds';
    const flaggedContent = 'Keep concise fixture review notes.';
    const flaggedId = await capture('Synthetic pending review', flaggedContent, 'reference');
    ensure((await call('brain_govern')).flagged === 1, 'Pending flag missing');
    const holdIds = [];
    for (const [label, text] of [
      [
        'release',
        'Contact fixture@example.invalid for invented release coordination and application documentation.',
      ],
      [
        'reject',
        'Contact reviewer@example.invalid for fictional onboarding ownership and retained documentation.',
      ],
      [
        'expire',
        'Contact operator@example.invalid for synthetic incident onboarding and archive coordination.',
      ],
    ]) {
      const id = await capture(`Synthetic ${label} review`, text, 'onboarding');
      ensure((await call('brain_govern')).held === 1, 'Human hold missing');
      ensure(candidate(view(), id).status === 'quarantined', 'Held status missing');
      holdIds.push(id);
    }
    const [releaseId, rejectId, expireId] = holdIds;
    complete();

    phase = 'list-limits-sanitization-and-tenant-scope';
    const listed = await cli(['list', '--limit', '1']);
    ensure(
      listed.ok === true &&
        listed.pending.length === 1 &&
        listed.pending[0].candidateId === flaggedId &&
        listed.holds.length === 1 &&
        listed.holdsHasMore,
      'List limit mismatch',
    );
    const allowedPending = ['candidateId', 'status', 'category', 'audience'];
    const allowedHold = [
      ...allowedPending,
      'recommendedAudience',
      'triggers',
      'heldAt',
      'expiresAt',
      'expired',
      'metadataIncomplete',
    ];
    for (const item of listed.pending)
      ensure(
        Object.keys(item).every((key) => allowedPending.includes(key)),
        'Pending projection leak',
      );
    for (const item of listed.holds)
      ensure(
        Object.keys(item).every((key) => allowedHold.includes(key)),
        'Hold projection leak',
      );
    const encoded = JSON.stringify(listed);
    ensure(
      !encoded.includes(flaggedContent) &&
        !encoded.includes('@example.invalid') &&
        !encoded.includes('Synthetic'),
      'List contains fixture prose',
    );
    const foreign = await cli(['list'], { scopeTenant: 'unrelated-fixture-tenant' });
    ensure(
      foreign.ok && foreign.pending.length === 0 && foreign.holds.length === 0,
      'Foreign tenant list leak',
    );
    await unchangedRefusal(writeArgs('reject', flaggedId), 'not_found', {
      scopeTenant: 'unrelated-fixture-tenant',
    });
    complete();

    phase = 'person-reject-pending-retains-content-and-canonical-receipt';
    const beforeReject = view();
    const rejected = await cli(writeArgs('reject', flaggedId));
    ensure(
      rejected.ok && rejected.committed && rejected.disposition === 'rejected',
      'Pending rejection failed',
    );
    const afterReject = view();
    const pending = candidate(afterReject, flaggedId);
    ensure(
      pending.status === 'rejected' && pending.content === flaggedContent,
      'Rejected content retention mismatch',
    );
    ensure(
      !afterReject.curated_memories.some((row) => row.candidate_id === flaggedId),
      'Pending rejection promoted',
    );
    const receipt = events(afterReject, flaggedId).find(
      (event) => event.id === rejected.auditEventId,
    );
    personReceipt(receipt, flaggedId, 'deleted');
    ensure(JSON.parse(receipt.details_json).disposition === 'rejected', 'Disposition missing');
    ensure(
      afterReject.audit_events.length === beforeReject.audit_events.length + 1,
      'Unexpected rejection receipts',
    );
    await unchangedRefusal(writeArgs('reject', flaggedId), 'not_pending');
    complete();

    phase = 'missing-audience-and-unacknowledged-widening-refuse';
    // Thin CLI refuses missing audience before helper; canonical widening needs
    // explicit acknowledgment. Both preserve the selected inspected rows.
    await unchangedRefusal(
      writeArgs('resolve-hold', releaseId, ['--resolution', 'release']),
      'invalid_arguments',
    );
    await unchangedRefusal(
      writeArgs('resolve-hold', releaseId, ['--resolution', 'release', '--audience', 'tenant']),
      'wider_than_recommended',
    );
    complete();

    phase = 'eligible-person-release-and-repeat-noop';
    const beforeRelease = view();
    const released = await cli(
      writeArgs('resolve-hold', releaseId, ['--resolution', 'release', '--audience', 'owner']),
    );
    ensure(
      released.ok &&
        released.committed &&
        released.disposition === 'released' &&
        released.audience === 'owner',
      'Hold release failed',
    );
    const afterRelease = view();
    ensure(candidate(afterRelease, releaseId).status === 'promoted', 'Released status mismatch');
    const memory = afterRelease.curated_memories.find((row) => row.id === released.memoryId);
    ensure(
      memory &&
        memory.candidate_id === releaseId &&
        memory.tenant_id === tenant &&
        memory.lifecycle === 'active' &&
        JSON.parse(memory.metadata_json).audience === 'owner',
      'Released memory mismatch',
    );
    const releaseReceipt = events(afterRelease, releaseId).find(
      (event) => event.id === released.auditEventId,
    );
    personReceipt(releaseReceipt, releaseId, 'hold_resolved');
    ensure(
      JSON.parse(releaseReceipt.details_json).resolution === 'released',
      'Release resolution mismatch',
    );
    const priorIds = new Set(beforeRelease.audit_events.map((event) => event.id));
    ensure(
      events(afterRelease, memory.id).some(
        (event) => event.action === 'promoted' && !priorIds.has(event.id),
      ),
      'New promotion receipt missing',
    );
    await unchangedRefusal(
      writeArgs('resolve-hold', releaseId, ['--resolution', 'release', '--audience', 'owner']),
      'not_on_hold',
    );
    complete();

    phase = 'person-reject-another-held-candidate';
    const rejectedHold = await cli(writeArgs('resolve-hold', rejectId, ['--resolution', 'reject']));
    ensure(
      rejectedHold.ok && rejectedHold.committed && rejectedHold.disposition === 'rejected',
      'Hold rejection failed',
    );
    const after = view();
    ensure(candidate(after, rejectId).status === 'rejected', 'Held rejection status mismatch');
    const rejectedHoldReceipt = events(after, rejectId).find(
      (event) => event.id === rejectedHold.auditEventId,
    );
    personReceipt(rejectedHoldReceipt, rejectId, 'hold_resolved');
    ensure(
      JSON.parse(rejectedHoldReceipt.details_json).resolution === 'rejected',
      'Hold rejection resolution mismatch',
    );
    complete();

    phase = 'cli-only-future-clock-commits-expiry-refusal';
    const beforeExpiry = view();
    const expired = await cli(
      writeArgs('resolve-hold', expireId, ['--resolution', 'release', '--audience', 'owner']),
      { future: true, expectedExit: 1 },
    );
    ensure(
      !expired.ok &&
        expired.committed === true &&
        expired.disposition === 'expired' &&
        expired.code === 'hold_expired',
      'Committed expiry refusal mismatch',
    );
    const afterExpiry = view();
    ensure(candidate(afterExpiry, expireId).status === 'rejected', 'Expired status mismatch');
    const expiryReceipt = events(afterExpiry, expireId).find(
      (event) => event.id === expired.auditEventId,
    );
    ensure(
      expiryReceipt?.action === 'hold_resolved' &&
        JSON.parse(expiryReceipt.details_json).resolution === 'expired',
      'Canonical expiry receipt missing',
    );
    ensure(
      afterExpiry.audit_events.length === beforeExpiry.audit_events.length + 1 &&
        expired.anchored?.committed === true,
      'Expiry receipt or local anchor missing',
    );
    complete();

    phase = 'canonical-export-and-real-chain-with-nonempty-anchor';
    // Independently visible clean decision; restricted released contact may be
    // canonically excluded and is not used as the export-success denominator.
    const exported = join(base, 'kb-export', 'decisions', `${cleanMemory.id}.md`);
    ensure(
      existsSync(exported) && readFileSync(exported, 'utf8').includes(cleanMemory.id),
      'Clean derived export missing',
    );
    const audit = await call('brain_audit_verify');
    ensure(
      audit.ok &&
        audit.anchorCount >= 1 &&
        audit.anchorBreaks === 0 &&
        audit.tamperSignatures === 0 &&
        audit.totalEvents === view().audit_events.length,
      'Chain or anchor verification failed',
    );
    projection = {
      policyCount: 1,
      enabledRuleTypes: 10,
      pendingRetainedRejected: true,
      releasedMemoryId: released.memoryId,
      candidateIds: [cleanId, flaggedId, ...holdIds],
      auditEvents: view().audit_events.length,
      anchorCount: audit.anchorCount,
      inspectedColumns,
      noActualQmd: true,
      denseEnabled: false,
      physicalHumanProof: false,
      cleanInstallProof: false,
      dbScope: 'selected tables/columns; not all DB or filesystem state',
      expiryClock: 'CLI-only +31 days; no audit-row mutation',
    };
    complete();
    passed = true;
  } catch {
    process.exitCode = 1; // No raw replies, stderr, assertion values or fixture content.
  } finally {
    let closed = session === undefined;
    if (session) {
      try {
        await bounded(session.client.close(), 6_000);
        const until = Date.now() + 2_000;
        while (!session.closed && Date.now() < until)
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        closed = session.closed;
      } catch {
        closed = false;
      }
    }
    const cleanupSafe = closed && activeCli === 0;
    if (cleanupSafe) rmSync(work, { recursive: true, force: true });
    else process.exitCode = 1;
    console.log(
      JSON.stringify({
        passed: passed && cleanupSafe,
        cases,
        failedPhase: passed ? undefined : phase,
        clientClosureEstablished: closed,
        cliChildrenClosed: activeCli === 0,
        scratchRemoved: !existsSync(work),
        retainedScratch: cleanupSafe ? undefined : work,
        finalProjection: projection,
        registrarMcpProjection,
      }),
    );
  }
}
void main().catch(() => {
  process.exitCode = 1;
  console.log(JSON.stringify({ passed: false, failedPhase: 'setup-or-finalization' }));
});

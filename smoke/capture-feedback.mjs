#!/usr/bin/env node
/**
 * Committed-bundle capture disclosure feedback. Run after a genuine rebuild.
 * An optional argument selects the plugin checkout for a private local test.
 * Synthetic private fixtures; actual committed MCP/native closure, no source
 * Registrar imports, provisioning, qmd execution, models or live brain access.
 * External SDK imports belong to this test client, not the delivered server.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  const runtimeRequire = createRequire(join(repo, 'plugin-runtime', 'package.json'));
  const Database = runtimeRequire('better-sqlite3');
  const work = mkdtempSync(join(tmpdir(), 'gsb-capture-feedback-'));
  const tools = join(work, 'tools');
  mkdirSync(tools, { mode: 0o700 });
  symlinkSync(realpathSync(process.execPath), join(tools, 'node'));
  symlinkSync('/usr/bin/git', join(tools, 'git'));
  const aws = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  const pii = ['123', '45', '6789'].join('-');
  const compensation = 'The salary detail is synthetic.';
  const markers = [aws, pii, compensation];
  const clean = {
    title: 'Synthetic capture feedback decision',
    content:
      'Keep deterministic capture feedback separate from governed promotion in this invented private fixture.',
    category: 'decision',
    filePaths: ['fixtures/clean-note.md'],
  };
  const cases = [];
  const sessions = [];
  const deadline = Date.now() + 120_000;
  let phase = 'setup';
  let stateDifference;
  let passed = false;
  let closedAll = false;

  function ensure(value, message = 'Fixture assertion failed') {
    assert.ok(value, message); // Fixed messages only; never log assertion values.
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
  function inspectDb(base) {
    const path = join(base, 'teamkb.db');
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return {
        candidates: db.prepare('SELECT * FROM candidates ORDER BY id').all(),
        memories: db.prepare('SELECT * FROM curated_memories ORDER BY id').all(),
        audit: db.prepare('SELECT * FROM audit_events ORDER BY seq').all(),
      };
    } finally {
      db.close();
    }
  }
  function snapshot(base) {
    const database = inspectDb(base);
    const files = [];
    let totalBytes = 0;
    const walk = (path, relative) => {
      const stat = lstatSync(path);
      ensure(!stat.isSymbolicLink(), 'Unexpected fixture symlink');
      ensure(stat.isDirectory() || stat.isFile(), 'Unexpected fixture file type');
      ensure(files.length < 2_000, 'Fixture inventory count bound');
      const entry = {
        path: relative,
        mode: stat.mode & 0o777,
        inode: stat.ino,
        device: stat.dev,
        mtime: stat.mtimeMs,
        type: stat.isDirectory() ? 'directory' : 'file',
      };
      // SQLite's read-only inspection itself updates SHM mtime (the observer-
      // only stability control below detects this). Keep SHM bytes, identity,
      // mode and all rows in the three inspected tables exact; omit only that
      // volatile timestamp. Other database tables and unrecorded metadata are
      // outside this fixture's preservation evidence.
      if (relative === 'teamkb.db-shm') delete entry.mtime;
      if (stat.isFile()) {
        totalBytes += stat.size;
        ensure(
          stat.size <= 16 * 1024 ** 2 && totalBytes <= 64 * 1024 ** 2,
          'Fixture inventory byte bound',
        );
        entry.size = stat.size;
        entry.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      }
      files.push(entry);
      if (stat.isDirectory()) {
        for (const name of readdirSync(path).sort())
          walk(join(path, name), relative ? `${relative}/${name}` : name);
      }
    };
    if (existsSync(base)) walk(base, '');
    return { exists: existsSync(base), files, database };
  }
  function spoolFiles(base) {
    const spool = join(base, 'spool');
    if (!existsSync(spool)) return [];
    return readdirSync(spool)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => join(spool, name));
  }
  function assertNoMarker(text) {
    ensure(
      markers.every((marker) => !text.includes(marker)),
      'Refusal exposed fixture marker',
    );
  }
  async function start(name, tenantId) {
    const fixture = join(work, name);
    const home = join(fixture, 'home');
    const base = join(fixture, 'brain');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const transport = new StdioClientTransport({
      command: realpathSync(process.execPath),
      args: [runtime],
      cwd: fixture,
      env: {
        PATH: tools,
        HOME: home,
        TMPDIR: fixture,
        LANG: 'C.UTF-8',
        TEAMKB_BASE_PATH: base,
        TEAMKB_TENANT_ID: tenantId,
        TEAMKB_DENSE_ENABLED: 'false',
        TEAMKB_QMD_BIN: join(fixture, 'intentionally-missing-qmd'),
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
    const session = {
      transport,
      client: new Client({ name: 'capture-feedback-fixture', version: '1' }, { capabilities: {} }),
      base,
      tenantId,
      stderr: '',
      stderrBytes: 0,
      closed: false,
    };
    sessions.push(session);
    transport.stderr?.on('data', (chunk) => {
      session.stderrBytes += chunk.length;
      if (session.stderrBytes <= 128 * 1024) session.stderr += chunk.toString('utf8');
    });
    // Install before connect: the SDK attaches onclose during connect, so retain
    // its protocol listener afterward as well as our independent close witness.
    await bounded(session.client.connect(transport), budget());
    const previousClose = transport.onclose;
    transport.onclose = () => {
      session.closed = true;
      previousClose?.();
    };
    const listed = await bounded(session.client.listTools(), budget());
    ensure(
      listed.tools.some((tool) => tool.name === 'brain_capture'),
      'Missing capture tool',
    );
    const startupDeadline = Math.min(deadline, Date.now() + 2_000);
    while (
      !session.stderr.includes('(local, in-process, no network)') &&
      Date.now() < startupDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    ensure(
      session.stderr.includes('(local, in-process, no network)'),
      'Startup log barrier missing',
    );
    // Barrier response after initialization: preexisting startup configuration log
    // can contain the configured tenant. Claims cover request-era logging only.
    session.startupStderrBytes = session.stderrBytes;
    return session;
  }
  async function call(session, name, args = {}) {
    const result = await bounded(
      session.client.callTool({ name, arguments: args }, undefined, {
        timeout: budget(),
      }),
      budget(),
    );
    ensure(!result.isError, 'Unexpected MCP protocol error');
    const text = result.content.find((item) => item.type === 'text')?.text;
    ensure(typeof text === 'string', 'Missing structured tool reply');
    return { value: JSON.parse(text), text };
  }
  async function refuse(session, name, args, category) {
    phase = name;
    const before = snapshot(session.base);
    const observedAgain = snapshot(session.base);
    if (JSON.stringify(observedAgain) !== JSON.stringify(before)) {
      stateDifference = {
        observerOnly: true,
        databaseChanged: JSON.stringify(observedAgain.database) !== JSON.stringify(before.database),
        changedEntries: before.files
          .map((entry, index) => ({
            index,
            type: entry.type,
            kind: ['teamkb.db', 'teamkb.db-shm', 'teamkb.db-wal'].includes(entry.path)
              ? entry.path
              : 'other',
            fields: Object.keys(entry).filter(
              (key) => entry[key] !== observedAgain.files[index]?.[key],
            ),
          }))
          .filter((entry) => entry.fields.length),
      };
      throw new Error('Fixture observer is unstable before capture');
    }
    const stderrOffset = session.stderr.length;
    const reply = await call(session, 'brain_capture', args);
    ensure(reply.value.ok === false, 'Capture refusal missing');
    ensure(reply.value.error === 'capture-disclosure-rejected', 'Unexpected refusal code');
    ensure(reply.value.category === category, 'Unexpected refusal category');
    ensure(
      reply.value.message === 'Capture refused before writing to the spool.',
      'Unexpected refusal message',
    );
    ensure(!Object.hasOwn(reply.value, 'candidateId'), 'Refusal assigned candidate ID');
    assertNoMarker(reply.text);
    ensure(session.stderrBytes <= 128 * 1024, 'Fixture stderr bound');
    assertNoMarker(session.stderr.slice(stderrOffset));
    const after = snapshot(session.base);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      stateDifference = {
        databaseChanged: JSON.stringify(after.database) !== JSON.stringify(before.database),
        inventoryCountBefore: before.files.length,
        inventoryCountAfter: after.files.length,
        changedEntries: before.files
          .map((entry, index) => ({
            index,
            type: entry.type,
            fields: Object.keys(entry).filter((key) => entry[key] !== after.files[index]?.[key]),
          }))
          .filter((entry) => entry.fields.length),
      };
    }
    assert.deepEqual(after, before, 'Refusal changed private base state');
    cases.push({ name, passed: true });
  }
  async function close(session) {
    const closeDeadline = Date.now() + 8_000;
    await bounded(session.client.close(), 6_000);
    // SDK close can return immediately after SIGKILL. Await actual transport close
    // before deleting anything; do not guess PID/group ownership or kill siblings.
    while (!session.closed && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ensure(session.closed, 'Transport close not established');
  }

  try {
    const session = await start('ordinary', 'capture-fixture');
    const negatives = [
      ['content-secret', { ...clean, content: `Synthetic token ${aws}` }, 'secret'],
      ['title-secret', { ...clean, title: `Synthetic token ${aws}` }, 'secret'],
      ['file-path-secret', { ...clean, filePaths: [`fixtures/${aws}.md`] }, 'secret'],
      ['content-pii', { ...clean, content: `Synthetic identifier ${pii}` }, 'pii'],
      ['content-compensation', { ...clean, content: compensation }, 'compensation'],
    ];
    for (const [name, args, category] of negatives)
      await refuse(session, `pristine-${name}`, args, category);
    ensure(!existsSync(join(session.base, 'origin-secret')), 'Refusal created origin secret');
    ensure(spoolFiles(session.base).length === 0, 'Refusal created spool line');

    phase = 'clean-capture-origin-and-spool';
    const capture = await call(session, 'brain_capture', clean);
    ensure(
      capture.value.ok === true && typeof capture.value.candidateId === 'string',
      'Clean capture failed',
    );
    const files = spoolFiles(session.base);
    ensure(files.length === 1, 'Unexpected clean spool inventory');
    ensure((lstatSync(files[0]).mode & 0o777) === 0o600, 'Clean spool mode mismatch');
    const lines = readFileSync(files[0], 'utf8').trim().split('\n');
    ensure(lines.length === 1, 'Unexpected clean spool line count');
    const candidate = JSON.parse(lines[0]);
    ensure(
      candidate.schemaVersion === '1' && candidate.status === 'inbox' && candidate.source === 'mcp',
      'Clean candidate envelope mismatch',
    );
    ensure(
      candidate.id === capture.value.candidateId && candidate.tenantId === session.tenantId,
      'Clean candidate identity mismatch',
    );
    ensure(
      candidate.title === clean.title && candidate.content === clean.content,
      'Clean candidate text mismatch',
    );
    assert.deepEqual(
      candidate.metadata.filePaths,
      clean.filePaths,
      'Clean candidate metadata mismatch',
    );
    ensure(candidate.origin?.channel === 'local-mcp', 'Clean capture missing origin');
    const secretPath = join(session.base, 'origin-secret');
    ensure((lstatSync(secretPath).mode & 0o777) === 0o600, 'Origin secret mode mismatch');
    const secret = readFileSync(secretPath, 'utf8').trim();
    ensure(/^[0-9a-f]{64}$/.test(secret), 'Origin secret shape mismatch');
    const expected = createHmac('sha256', secret)
      .update([candidate.id, candidate.tenantId, candidate.capturedAt].join('\0'), 'utf8')
      .digest();
    ensure(/^[0-9a-f]{64}$/.test(candidate.origin.tokenHmac), 'Origin HMAC shape mismatch');
    ensure(
      timingSafeEqual(expected, Buffer.from(candidate.origin.tokenHmac, 'hex')),
      'Origin HMAC mismatch',
    );
    cases.push({ name: phase, passed: true });
    // Establish that refusal neither appends nor damages an existing clean spool.
    await refuse(session, 'preserves-existing-clean-spool', negatives[0][1], 'secret');

    phase = 'clean-govern-and-audit';
    const govern = (await call(session, 'brain_govern')).value;
    ensure(
      govern.ok === true && govern.ingested === 1 && govern.promoted === 1 && govern.rejected === 0,
      'Clean govern failed',
    );
    const db = inspectDb(session.base);
    ensure(
      db.candidates.length === 1 && db.candidates[0].status === 'promoted',
      'Clean candidate not promoted',
    );
    ensure(
      db.memories.length === 1 && db.memories[0].candidate_id === candidate.id,
      'Clean memory identity mismatch',
    );
    const audit = (await call(session, 'brain_audit_verify')).value;
    ensure(
      audit.ok === true &&
        audit.totalEvents > 0 &&
        audit.tamperSignatures === 0 &&
        audit.anchorBreaks === 0,
      'Clean audit failed',
    );
    cases.push({ name: phase, passed: true });
    for (const [name, args, category] of negatives)
      await refuse(session, `settled-${name}`, args, category);

    phase = 'raw-spool-intake-refusals-and-retention';
    const rawCandidates = [
      'Synthetic disclosure fixture: SSN marker only; no identifying number.',
      'Synthetic disclosure fixture: salary keyword only; no person or amount.',
      'Synthetic disclosure fixture: -----BEGIN PRIVATE KEY----- marker only; no key material.',
    ].map((content) => ({
      ...candidate,
      id: randomUUID(),
      content,
      origin: undefined,
    }));
    const rawBytes = Buffer.from(
      rawCandidates.map((item) => JSON.stringify(item)).join('\n') + '\n',
    );
    const rawPath = join(session.base, 'spool', 'spool-refusal-markers.jsonl');
    const manifestBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: '1',
        spoolFileSha256: createHash('sha256').update(rawBytes).digest('hex'),
      }),
    );
    writeFileSync(rawPath, rawBytes, { mode: 0o600 });
    writeFileSync(`${rawPath}.manifest.json`, manifestBytes, { mode: 0o600 });
    const beforeRaw = inspectDb(session.base);
    const refused = await call(session, 'brain_govern');
    ensure(
      refused.value.ok === true && refused.value.idle === false,
      'Refusal intake incorrectly idle',
    );
    assert.deepEqual(
      refused.value.intake,
      {
        ingestedCandidates: 0,
        disclosureRejectedCandidates: 3,
        disclosureCategories: { pii: 1, compensation: 1, secret: 1, other: 0 },
        tamperedFiles: 0,
        admissionRejectedFiles: 0,
      },
      'Safe intake count mismatch',
    );
    ensure(
      refused.value.message.includes('3 disclosure-refused candidate(s)'),
      'Refusal message missing',
    );
    for (const item of rawCandidates) {
      ensure(
        !refused.text.includes(item.id) && !refused.text.includes(item.content),
        'Intake reply exposed raw candidate',
      );
    }
    assert.deepEqual(inspectDb(session.base), beforeRaw, 'Refusal created stored rows or receipts');
    const archivedRaw = join(session.base, 'spool', 'ingested', 'spool-refusal-markers.jsonl');
    ensure(readFileSync(archivedRaw).equals(rawBytes), 'Raw archive byte mismatch');
    ensure(
      readFileSync(`${archivedRaw}.manifest.json`).equals(manifestBytes),
      'Raw sidecar byte mismatch',
    );
    ensure(!existsSync(rawPath), 'Raw source unexpectedly remains after successful archive');
    const observedAgain = (await call(session, 'brain_govern')).value;
    ensure(
      observedAgain.intake.disclosureRejectedCandidates === 0 && observedAgain.idle === true,
      'Archived input re-counted',
    );
    ensure(!observedAgain.message.includes('empty'), 'Idle claimed empty spool census');
    cases.push({ name: phase, passed: true });

    phase = 'unavailable-intake-is-not-idle';
    const spool = join(session.base, 'spool');
    renameSync(spool, join(session.base, 'retained-fixture-spool'));
    writeFileSync(spool, 'fixture: not a directory', { mode: 0o600 });
    const unavailable = (await call(session, 'brain_govern')).value;
    ensure(
      unavailable.ok === true && unavailable.intake === null && unavailable.idle === false,
      'Failed intake hidden as idle',
    );
    ensure(
      unavailable.message.includes('intake counts are unavailable'),
      'Unavailable intake message missing',
    );
    assert.deepEqual(inspectDb(session.base), beforeRaw, 'Failed intake changed stored rows');
    cases.push({ name: phase, passed: true });

    const tenantSession = await start('tenant-refusal', aws);
    await refuse(tenantSession, 'configured-tenant-secret', clean, 'secret');
    ensure(!existsSync(join(tenantSession.base, 'origin-secret')), 'Tenant refusal created secret');
    ensure(spoolFiles(tenantSession.base).length === 0, 'Tenant refusal created spool');
    passed = true;
  } catch {
    // No raw assertion values, response text, stderr, fixtures, secrets or HMACs
    // enter durable output. Detailed data remains only in the owned ephemeral tree.
    process.exitCode = 1;
  } finally {
    let closeFailed = false;
    for (const session of sessions) {
      try {
        await close(session);
      } catch {
        closeFailed = true;
      }
    }
    closedAll = !closeFailed && sessions.every((session) => session.closed);
    if (closedAll) rmSync(work, { recursive: true, force: true });
    else process.exitCode = 1; // Preserve files while any child ownership is uncertain.
    console.log(
      JSON.stringify({
        passed: passed && closedAll,
        completedCases: cases.length,
        failedPhase: passed ? undefined : phase,
        stateDifference,
        clientClosureEstablished: closedAll,
        scratchRemoved: !existsSync(work),
        retainedScratch: closedAll ? undefined : work,
        actualCommittedBundle: true,
        noActualQmd: true,
        denseEnabled: false,
        disclosureScope:
          'request-reply-and-request-era-stderr; configured-tenant-startup-log-excluded',
        durableRefusalReceiptClaim: false,
      }),
    );
  }
}

void main().catch(() => {
  process.exitCode = 1;
  console.log(JSON.stringify({ passed: false, failedPhase: 'setup-or-finalization' }));
});

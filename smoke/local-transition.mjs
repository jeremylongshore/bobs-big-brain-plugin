#!/usr/bin/env node
/**
 * Exercise the committed LOCAL MCP bundle, real SQLite and the real flock.
 * Private synthetic data only; qmd is deliberately missing, dense is disabled,
 * and the private anchor repository has no remote. No sibling Registrar imports.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = join(root, 'plugin-runtime', 'governed-brain.cjs');
// Load the same external native closure the delivered bundle uses.
const runtimeRequire = createRequire(join(root, 'plugin-runtime', 'package.json'));
const Database = runtimeRequire('better-sqlite3');
const work = mkdtempSync(join(tmpdir(), 'gsb-local-transition-'));
const base = join(work, 'brain');
const home = join(work, 'home');
const tools = join(work, 'tools');
mkdirSync(home);
mkdirSync(tools);
symlinkSync(process.execPath, join(tools, 'node'));
const databasePath = join(base, 'teamkb.db');
const anchorPath = join(base, 'audit', 'anchors.jsonl');
const cases = [];
let client;
let template;
let sequence = 0;
const id = () => `10000000-0000-5000-8000-${String(++sequence).padStart(12, '0')}`;

function inspect(fn) {
  const db = new Database(databasePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function seed(overrides = {}) {
  const memoryId = id();
  const content = `Synthetic transition fixture ${memoryId}: keep replacement decisions auditable.`;
  const row = {
    ...template,
    id: memoryId,
    candidate_id: memoryId,
    title: `Transition fixture ${memoryId}`,
    content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    lifecycle: 'active',
    supersession_json: null,
    ...overrides,
  };
  inspect((db) => {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO curated_memories (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    ).run(...columns.map((column) => row[column]));
  });
  return memoryId;
}

function snapshot() {
  return inspect((db) => ({
    memories: db.prepare('SELECT * FROM curated_memories ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM audit_events ORDER BY rowid').all(),
    anchors: existsSync(anchorPath) ? readFileSync(anchorPath, 'utf8') : '',
  }));
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20_000 });
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (result.isError) return { ok: false, error: text };
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

async function check(name, fn) {
  try {
    await fn();
    cases.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, passed: false });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [runtime],
    cwd: work,
    env: {
      PATH: tools,
      HOME: home,
      TMPDIR: work,
      TEAMKB_BASE_PATH: base,
      TEAMKB_TENANT_ID: 'local',
      TEAMKB_DENSE_ENABLED: 'false',
      TEAMKB_QMD_BIN: join(work, 'intentionally-missing-qmd'),
    },
    stderr: 'pipe',
  });
  // Bounded stderr is intentionally not copied into a durable report.
  let stderrBytes = 0;
  transport.stderr?.on('data', (chunk) => {
    stderrBytes += chunk.length;
  });
  client = new Client({ name: 'local-transition-fixture', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  const toolsList = await client.listTools();
  assert.ok(toolsList.tools.some((tool) => tool.name === 'brain_transition'));
  assert.equal(
    (
      await call('brain_capture', {
        title: 'Synthetic local transition seed',
        content:
          'This private invented decision provides a canonical promoted fixture for local transition tests.',
        category: 'decision',
      })
    ).ok,
    true,
  );
  const governed = await call('brain_govern');
  assert.equal(governed.ok, true);
  assert.equal(governed.promoted, 1);
  template = inspect((db) => db.prepare('SELECT * FROM curated_memories LIMIT 1').get());
  assert.ok(template);

  await check(
    'v5 supersession persists canonical link and matching audit after reopening',
    async () => {
      const source = seed();
      const replacement = seed();
      const reason = 'A newer synthetic decision replaces this one';
      const before = snapshot();
      const result = await call('brain_transition', {
        memoryId: source,
        to: 'superseded',
        supersededBy: replacement,
        reason,
        actor: 'fixture-owner',
      });
      assert.equal(result.ok, true);
      const after = snapshot();
      const memory = after.memories.find((row) => row.id === source);
      const event = after.audit.at(-1);
      assert.equal(memory.lifecycle, 'superseded');
      const link = JSON.parse(memory.supersession_json);
      assert.deepEqual(link, { supersededBy: replacement, reason, linkedAt: event.timestamp });
      assert.equal(memory.updated_at, event.timestamp);
      assert.equal(event.id, result.auditEventId);
      assert.equal(event.action, 'superseded');
      assert.equal(event.memory_id, source);
      assert.equal(event.tenant_id, 'local');
      assert.deepEqual(JSON.parse(event.actor_json), { type: 'human', id: 'fixture-owner' });
      assert.equal(event.reason, reason);
      assert.deepEqual(JSON.parse(event.details_json), {
        from: 'active',
        to: 'superseded',
        supersededBy: replacement,
      });
      assert.equal(after.audit.length, before.audit.length + 1);
      assert.equal(
        after.anchors.trim().split('\n').length,
        before.anchors.trim().split('\n').length + 1,
      );
      // A subsequent canonical repository read must accept the linked record.
      assert.equal(
        (
          await call('brain_transition', {
            memoryId: source,
            to: 'archived',
            reason: 'Archive replaced fixture',
          })
        ).ok,
        true,
      );
      const archived = snapshot().memories.find((row) => row.id === source);
      assert.equal(archived.lifecycle, 'archived');
      assert.deepEqual(JSON.parse(archived.supersession_json), link);
      assert.equal((await call('brain_audit_verify')).ok, true);
    },
  );

  for (const [name, target] of [
    ['missing replacement', () => undefined],
    ['nonexistent replacement', () => id()],
    ['self replacement', (source) => source],
    ['inactive replacement', () => seed({ lifecycle: 'archived' })],
    ['cross-tenant replacement', () => seed({ tenant_id: 'other-fixture-tenant' })],
    ['invalid replacement UUID', () => 'not-a-uuid'],
  ]) {
    await check(`${name} refuses without durable effects`, async () => {
      const source = seed();
      const supersededBy = target(source);
      const before = snapshot();
      const result = await call('brain_transition', {
        memoryId: source,
        to: 'superseded',
        reason: 'Refusal fixture',
        ...(supersededBy === undefined ? {} : { supersededBy }),
      });
      assert.equal(result.ok, false);
      assert.deepEqual(snapshot(), before);
    });
  }

  await check('audit failure rolls back state and link and appends no anchor', async () => {
    const source = seed();
    const replacement = seed();
    inspect((db) =>
      db.exec(
        "CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture audit rejection'); END",
      ),
    );
    try {
      const before = snapshot();
      const result = await call('brain_transition', {
        memoryId: source,
        to: 'superseded',
        supersededBy: replacement,
        reason: 'Rollback fixture',
      });
      assert.equal(result.ok, false);
      assert.deepEqual(snapshot(), before);
    } finally {
      inspect((db) => db.exec('DROP TRIGGER fixture_reject_audit'));
    }
  });

  await check('ordinary deprecation and archive retain canonical audit and anchors', async () => {
    const source = seed();
    let from = 'active';
    for (const to of ['deprecated', 'archived']) {
      const before = snapshot();
      const reason = `Ordinary ${to}`;
      const result = await call('brain_transition', {
        memoryId: source,
        to,
        reason,
      });
      assert.equal(result.ok, true);
      const after = snapshot();
      const memory = after.memories.find((row) => row.id === source);
      const event = after.audit.at(-1);
      assert.equal(memory.lifecycle, to);
      assert.equal(memory.supersession_json, null);
      assert.equal(after.audit.length, before.audit.length + 1);
      assert.equal(event.id, result.auditEventId);
      assert.equal(event.action, to === 'archived' ? 'archived' : 'demoted');
      assert.equal(event.memory_id, source);
      assert.equal(event.tenant_id, 'local');
      assert.equal(event.reason, reason);
      assert.deepEqual(JSON.parse(event.actor_json), { type: 'human', id: 'owner' });
      assert.deepEqual(JSON.parse(event.details_json), { from, to });
      assert.equal(memory.updated_at, event.timestamp);
      assert.equal(new Date(event.timestamp).toISOString(), event.timestamp);
      assert.equal(
        after.anchors.trim().split('\n').length,
        before.anchors.trim().split('\n').length + 1,
      );
      from = to;
    }
    assert.equal((await call('brain_audit_verify')).ok, true);
  });
  console.log(
    JSON.stringify({
      cases: cases.length,
      passed: cases.filter((item) => item.passed).length,
      failed: cases.filter((item) => !item.passed).length,
      stderrBytes,
      noActualQmd: true,
    }),
  );
  if (cases.some((item) => !item.passed)) process.exitCode = 1;
} finally {
  // SDK close awaits its owned transport shutdown before removing fixture files.
  await client?.close();
  rmSync(work, { recursive: true, force: true });
  assert.equal(existsSync(work), false);
}

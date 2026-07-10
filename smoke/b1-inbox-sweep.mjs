#!/usr/bin/env node
/**
 * B1 (bead compile-then-govern-jfv.2.1) — auto-govern the remote brain_capture
 * inbox. Full-chain, hermetic, ZERO-egress integration smoke for the marker-based
 * inbox sweep + the member-quarantine gate + idempotency.
 *
 * Drives the BUILT local MCP runtime (plugin-runtime/governed-brain.cjs) over a
 * real stdio MCP session against an isolated TEAMKB_BASE_PATH temp dir — it never
 * touches a real ~/.teamkb. It exercises BOTH capture paths in one pass:
 *
 *   • the REAL spool→table path (brain_capture writes a spool file; brain_govern
 *     ingests + governs it), AND
 *   • the REMOTE-capture path B1 is built for — team-mode brain_capture POSTs to
 *     /api/candidates and lands proposals directly in the `candidates` table with
 *     status='inbox'. There is no remote server in this hermetic smoke, so we
 *     SEED remote-shape rows directly into the throwaway `candidates` table (the
 *     exact shape the API writes), then drive brain_govern over MCP.
 *
 * Asserts the six B1 invariants:
 *   1. admin-authored candidate → promoted, marked 'promoted', searchable
 *   2. member-authored candidate → quarantined (NOT promoted)
 *   3. flagged/rejected candidate → KEPT in the inbox (review queue survives)
 *   4. duplicate candidate → marked 'duplicate'
 *   5. a batch-level 'governed' receipt is written
 *   6. a SECOND brain_govern is a no-op (idempotent) — no new memories, no new
 *      audit events, review-queue leftovers still in the inbox
 *
 * Seeding uses better-sqlite3 directly (the bundle's one external native dep, a
 * PROD dependency present in smoke.yml — no @qmd-team-intent-kb import needed).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = join(ROOT, 'plugin-runtime', 'governed-brain.cjs');
const BASE = mkdtempSync(join(tmpdir(), 'gsb-b1-'));
const DB = join(BASE, 'teamkb.db');
const TENANT = 'local';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed += 1;
};
const warn = (msg) => console.log(`⚠ ${msg}`);
const parse = (res) => JSON.parse(res.content[0].text);
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// The exact row the API's candidate-intake path writes (CandidateRepository.insert
// shape), seeded directly to model a remote team-mode capture.
function seedCandidate(db, { content, title, role, author, trust = 'medium', category = 'reference' }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO candidates (
       id, status, source, content, title, category, trust_level,
       author_json, tenant_id, metadata_json, pre_policy_flags_json,
       content_hash, captured_at
     ) VALUES (@id,'inbox','mcp',@content,@title,@category,@trust,
       @author,@tenant,@metadata,'{}',@hash,@at)`,
  ).run({
    id,
    content,
    title,
    category,
    trust,
    author: JSON.stringify({ type: 'human', id: author }),
    tenant: TENANT,
    metadata: JSON.stringify({ filePaths: [], tags: [], ...(role ? { proposedByRole: role } : {}) }),
    hash: sha256(content),
    at: new Date().toISOString(),
  });
  return id;
}

const statusOf = (db, id) => db.prepare('SELECT status FROM candidates WHERE id = ?').get(id)?.status;
const memoryExistsForContent = (db, content) =>
  db.prepare('SELECT COUNT(*) c FROM curated_memories WHERE content_hash = ?').get(sha256(content)).c > 0;
const auditCount = (db) => db.prepare('SELECT COUNT(*) c FROM audit_events').get().c;
const memoryCount = (db) => db.prepare('SELECT COUNT(*) c FROM curated_memories').get().c;
const governedReceipts = (db) =>
  db.prepare("SELECT COUNT(*) c FROM audit_events WHERE action = 'governed'").get().c;

// Distinctive, clean bodies (>25 chars so the length rule does not reject them).
const SPOOL_CONTENT = 'The nightly backup runs at 04:30 UTC after the borg job, then rsyncs off-host.';
const ADMIN_CONTENT = 'The team standup happens at 9am daily in the tailnet war room channel.';
const MEMBER_CONTENT = 'Members must file infra requests in the ops queue before Friday each week.';
const REJECT_CONTENT = 'too short to keep'; // < 25 chars → content_length rule rejects
const DUP_CONTENT = SPOOL_CONTENT; // duplicate of the already-promoted spool memory

const transport = new StdioClientTransport({
  command: 'node',
  args: [RUNTIME],
  env: { ...process.env, TEAMKB_BASE_PATH: BASE, TEAMKB_TENANT_ID: TENANT },
});
const client = new Client({ name: 'gsb-b1-smoke', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);

  // ── Phase 1: REAL spool→table path — capture + govern a self-authored local. ──
  const cap = parse(
    await client.callTool({
      name: 'brain_capture',
      arguments: { title: 'Backup schedule', content: SPOOL_CONTENT, category: 'reference' },
    }),
  );
  ok(cap.ok === true, 'brain_capture wrote the spool candidate (real spool path)');

  const gov1 = parse(await client.callTool({ name: 'brain_govern', arguments: {} }));
  ok(gov1.ok === true && gov1.promoted >= 1, `first govern promoted the spool candidate (promoted=${gov1.promoted})`);

  // The DB + schema (incl. migration 8) now exist — seed remote-shape candidates.
  let db = new Database(DB);
  const adminId = seedCandidate(db, { content: ADMIN_CONTENT, title: 'Standup', role: 'admin', author: 'jeremy' });
  const memberId = seedCandidate(db, { content: MEMBER_CONTENT, title: 'Infra tickets', role: 'member', author: 'ezekiel', trust: 'untrusted' });
  const rejectId = seedCandidate(db, { content: REJECT_CONTENT, title: 'Short', role: 'admin', author: 'jeremy' });
  const dupId = seedCandidate(db, { content: DUP_CONTENT, title: 'Backup dup', role: 'admin', author: 'jeremy' });
  db.close();
  ok(true, 'seeded 4 remote-shape candidates (admin, member, reject, dup) into the inbox');

  // ── Phase 2: the auto-govern sweep. ──
  const gov2 = parse(await client.callTool({ name: 'brain_govern', arguments: {} }));
  ok(gov2.ok === true, `sweep ran ok (${gov2.message})`);

  db = new Database(DB, { readonly: true });

  // (1) admin candidate → promoted + marked 'promoted' + a memory exists.
  ok(statusOf(db, adminId) === 'promoted', "admin candidate marked 'promoted'");
  ok(memoryExistsForContent(db, ADMIN_CONTENT), 'admin candidate content is now a curated memory');

  // (2) member candidate → quarantined, NOT promoted.
  ok(statusOf(db, memberId) === 'quarantined', "member candidate marked 'quarantined'");
  ok(!memoryExistsForContent(db, MEMBER_CONTENT), 'member candidate did NOT become a curated memory');

  // (3) rejected candidate → KEPT in the inbox (review queue survives).
  ok(statusOf(db, rejectId) === 'inbox', "rejected candidate KEPT in the inbox for review");

  // (4) duplicate candidate → marked 'duplicate'.
  ok(statusOf(db, dupId) === 'duplicate', "duplicate candidate marked 'duplicate'");

  // (5) a batch-level 'governed' receipt was written.
  ok(governedReceipts(db) >= 1, `a batch 'governed' receipt was written (count=${governedReceipts(db)})`);

  // Sweep counters agree with the seeded set.
  ok(
    gov2.promoted >= 1 && gov2.quarantined >= 1 && gov2.duplicates >= 1 && gov2.rejected >= 1,
    `sweep counts: promoted=${gov2.promoted} quarantined=${gov2.quarantined} duplicate=${gov2.duplicates} rejected=${gov2.rejected}`,
  );

  const memAfter = memoryCount(db);
  const auditAfter = auditCount(db);
  db.close();

  // Searchable — best-effort (only if qmd is on PATH in this runner).
  const sr = parse(
    await client.callTool({ name: 'brain_search', arguments: { query: 'standup tailnet war room', scope: 'all' } }),
  );
  if (sr.count >= 1) {
    ok(true, `admin memory is searchable — ${sr.count} cited hit(s), e.g. ${sr.results[0].citation}`);
  } else if (sr.note) {
    warn(`search skipped (qmd unavailable): ${sr.note}`);
  } else {
    ok(false, 'brain_search returned 0 hits with NO note — qmd ran but retrieval is empty');
  }

  // ── Phase 3: idempotency — a SECOND sweep over unchanged input is a no-op. ──
  const gov3 = parse(await client.callTool({ name: 'brain_govern', arguments: {} }));
  ok(
    gov3.promoted === 0 && gov3.quarantined === 0 && gov3.duplicates === 0,
    `second sweep governed nothing new (promoted=${gov3.promoted} quarantined=${gov3.quarantined} duplicate=${gov3.duplicates})`,
  );

  db = new Database(DB, { readonly: true });
  ok(memoryCount(db) === memAfter, `no new curated memories on re-run (${memAfter} → ${memoryCount(db)})`);
  ok(auditCount(db) === auditAfter, `no new audit events on re-run (${auditAfter} → ${auditCount(db)})`);
  ok(statusOf(db, rejectId) === 'inbox', 'rejected candidate STILL in the inbox after re-run');
  db.close();
} finally {
  await client.close().catch(() => {});
  rmSync(BASE, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nB1 SMOKE PASS' : `\nB1 SMOKE FAIL (${failed} check(s) failed)`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * brain_govern export RECONCILE + qmd resolution + brain_capture `subjects`
 * (beads compile-then-govern-39z.14 and 39z.4 follow-up) — hermetic, ZERO-egress
 * end-to-end smoke against the BUILT local runtime (plugin-runtime/governed-brain.cjs).
 *
 * Everything runs in a throwaway TEAMKB_BASE_PATH + HOME under the OS temp dir;
 * it never reads or writes a real ~/.teamkb or ~/.bun. qmd is faked with a
 * 2-line shell script, so no model, no network and no real index are involved.
 *
 * Invariants:
 *   A. missing qmd  -> govern still completes; `indexError` names what was searched
 *      and the fix (not the opaque "Failed to update index"); indexUpdated=false.
 *   B. subjects     -> a captured decision's `subjects` reach the promoted memory's
 *      metadata (spool -> ingest -> curator -> store); invalid/oversized subjects
 *      are rejected with a clear error and NOTHING is spooled.
 *   C. reconcile    -> a lifecycle-only change (brain_transition) is exported
 *      (`archived: 1`, `exported: 1`, memory moves to archive/) and the run is NOT
 *      reported as idle; the next run is a true no-op (`exported: 0`).
 *   D. crash repair -> a deleted file and a torn (truncated) file are rewritten by
 *      the next govern; the run after that is a no-op again.
 *   E. guard        -> >50 orphan export files are NOT mass-deleted (removalBlocked).
 *   F. qmd resolve  -> TEAMKB_QMD_BIN wins (source 'env', indexUpdated=true); a set-but-
 *      broken TEAMKB_QMD_BIN is a clear error; ~/.bun/bin/qmd is found with PATH bare.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = join(ROOT, 'plugin-runtime', 'governed-brain.cjs');
const WORK = mkdtempSync(join(tmpdir(), 'gsb-reconcile-'));
const BASE = join(WORK, 'brain');
const HOME = join(WORK, 'home'); // empty: no ~/.bun/bin/qmd unless a scenario plants one
const EXPORT = join(BASE, 'kb-export');
const DB = join(BASE, 'teamkb.db');
mkdirSync(HOME, { recursive: true });

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed += 1;
};
const parse = (res) => JSON.parse(res.content[0].text);
const spoolLines = () => {
  const dir = join(BASE, 'spool');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .reduce((n, f) => n + readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).length, 0);
};
const memories = () => {
  const db = new Database(DB, { readonly: true });
  try {
    return db.prepare('SELECT id, title, lifecycle, metadata_json FROM curated_memories').all();
  } finally {
    db.close();
  }
};
const byTitle = (t) => memories().find((m) => m.title === t);

// A fake qmd: succeeds at everything, prints a version for --version.
const fakeBin = join(WORK, 'fake-bin');
mkdirSync(fakeBin, { recursive: true });
const FAKE_QMD = join(fakeBin, 'qmd');
writeFileSync(FAKE_QMD, '#!/bin/sh\n[ "$1" = "--version" ] && echo "qmd 2.5.3"\nexit 0\n');
chmodSync(FAKE_QMD, 0o755);

/** Open a session with an explicit, minimal environment (PATH has node only). */
async function session(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [RUNTIME],
    env: {
      PATH: dirname(process.execPath),
      HOME,
      TEAMKB_BASE_PATH: BASE,
      TEAMKB_TENANT_ID: 'local',
      TEAMKB_DENSE_ENABLED: 'false',
      ...extraEnv,
    },
  });
  const client = new Client({ name: 'gsb-reconcile-smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    call: async (name, args = {}) => parse(await client.callTool({ name, arguments: args })),
    close: () => client.close().catch(() => {}),
  };
}

try {
  // ───────────── A + B: no qmd anywhere; capture with subjects ─────────────
  let s = await session();

  const bad9 = await s.call('brain_capture', {
    title: 'Too many subjects',
    content: 'This capture declares nine subjects and must be refused outright.',
    subjects: Array.from({ length: 9 }, (_, i) => `topic-${i}`),
  });
  ok(bad9.ok === false && /at most 8/.test(bad9.error), `9 subjects rejected clearly: ${bad9.error}`);
  const badSlug = await s.call('brain_capture', {
    title: 'Bad slug',
    content: 'This capture declares an invalid subject slug and must be refused.',
    subjects: ['Not A Slug'],
  });
  ok(
    badSlug.ok === false && /not a valid subject key/.test(badSlug.error),
    `invalid slug rejected clearly: ${badSlug.error}`,
  );
  ok(spoolLines() === 0, 'rejected captures wrote nothing to the spool');

  const capA = await s.call('brain_capture', {
    title: 'Hosting decision v1',
    content: 'We host the public sites on the old provider for now, pending the move.',
    category: 'decision',
    subjects: ['hosting.sites', 'deploy-pipeline', 'hosting.sites'],
  });
  const capB = await s.call('brain_capture', {
    title: 'Backup policy',
    content: 'Nightly encrypted backups go to the immutable offsite bucket and are restore-tested.',
    category: 'decision',
  });
  ok(capA.ok === true && capB.ok === true, 'valid captures accepted (with and without subjects)');
  ok(spoolLines() === 2, 'exactly the two valid captures were spooled');

  const g1 = await s.call('brain_govern');
  ok(g1.ok === true && g1.promoted === 2, `govern promoted ${g1.promoted}`);
  ok(g1.export?.written === 2 && g1.exported === 2, `export reconcile wrote 2 (exported=${g1.exported})`);
  ok(g1.indexUpdated === false, 'index not refreshed with no qmd available');
  ok(
    typeof g1.indexError === 'string' &&
      /qmd binary not found/.test(g1.indexError) &&
      g1.indexError.includes('TEAMKB_QMD_BIN') &&
      g1.indexError.includes(join(HOME, '.bun', 'bin', 'qmd')) &&
      !/^Failed to update index$/.test(g1.indexError),
    `A: indexError is actionable: "${String(g1.indexError).slice(0, 110)}..."`,
  );
  ok(/Search index NOT refreshed: qmd binary not found/.test(g1.message), 'A: message carries the reason');

  const memA = byTitle('Hosting decision v1');
  const memB = byTitle('Backup policy');
  ok(
    JSON.stringify(JSON.parse(memA.metadata_json).subjects) ===
      JSON.stringify(['hosting.sites', 'deploy-pipeline']),
    'B: subjects reached the promoted memory (de-duplicated, order kept)',
  );
  ok(JSON.parse(memB.metadata_json).subjects === undefined, 'B: no subjects key when none declared');
  ok(existsSync(join(EXPORT, 'decisions', `${memA.id}.md`)), 'memory exported to decisions/');

  // Subject-keyed supersession end to end: a later decision on the same subject.
  await s.call('brain_capture', {
    title: 'Hosting decision v2',
    content: 'We now host all public sites on the consolidated VPS behind a single ingress.',
    category: 'decision',
    subjects: ['hosting.sites'],
  });
  const g2 = await s.call('brain_govern');
  ok(g2.promoted === 1, `second decision promoted (${g2.promoted})`);
  ok(
    byTitle('Hosting decision v1').lifecycle === 'superseded',
    'B: the newer decision superseded the older one via the shared subject',
  );
  ok(byTitle('Backup policy').lifecycle === 'active', 'B: an unrelated decision stayed active');
  ok(
    existsSync(join(EXPORT, 'archive', `${memA.id}.md`)) &&
      !existsSync(join(EXPORT, 'decisions', `${memA.id}.md`)),
    'C: the superseded memory was moved to archive/ in the same govern run',
  );

  // ───────────── C: lifecycle-only change via brain_transition ─────────────
  const tr = await s.call('brain_transition', {
    memoryId: memB.id,
    to: 'archived',
    reason: 'smoke: lifecycle-only change with no promotion',
  });
  ok(tr.ok === true, 'brain_transition archived the memory');
  const g3 = await s.call('brain_govern');
  ok(
    g3.promoted === 0 && g3.processed === 0 && g3.export?.archived === 1 && g3.exported === 1,
    `C: lifecycle-only run reported exported=${g3.exported} archived=${g3.export?.archived} (was always 0)`,
  );
  ok(g3.idle === false && !/Nothing to govern/.test(g3.message), 'C: not reported as idle');
  ok(
    existsSync(join(EXPORT, 'archive', `${memB.id}.md`)) &&
      !existsSync(join(EXPORT, 'decisions', `${memB.id}.md`)),
    'C: archived memory moved out of decisions/',
  );
  const g4 = await s.call('brain_govern');
  ok(
    g4.exported === 0 && g4.export?.written === 0 && g4.export?.archived === 0 && g4.export?.removed === 0,
    'C: next run is a true no-op (idempotent)',
  );
  ok(g4.idle === true && g4.export?.unchanged >= 3, `C: idle again, ${g4.export?.unchanged} file(s) unchanged`);

  // ───────────── D: crash repair ─────────────
  const archivedA = join(EXPORT, 'archive', `${memA.id}.md`);
  const archivedB = join(EXPORT, 'archive', `${memB.id}.md`);
  const goodB = readFileSync(archivedB, 'utf8');
  rmSync(archivedA); // a file lost after the export watermark advanced
  truncateSync(archivedB, 30); // a torn write
  const g5 = await s.call('brain_govern');
  ok(g5.export?.written + g5.export?.archived === 2, `D: both damaged files rewritten (${JSON.stringify(g5.export)})`);
  ok(existsSync(archivedA) && readFileSync(archivedB, 'utf8') === goodB, 'D: contents restored byte-for-byte');
  const g6 = await s.call('brain_govern');
  ok(g6.exported === 0, 'D: no-op again after repair');

  // ───────────── E: mass-delete guard ─────────────
  mkdirSync(join(EXPORT, 'curated'), { recursive: true });
  for (let i = 0; i < 51; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    writeFileSync(join(EXPORT, 'curated', `${id}.md`), `---\nid: "${id}"\ntenant_id: "local"\n---\norphan\n`);
  }
  const g7 = await s.call('brain_govern');
  ok(
    g7.export?.removed === 0 && g7.export?.removalBlocked?.orphans === 51 && g7.export.removalBlocked.limit === 50,
    `E: 51 orphans NOT mass-deleted (${JSON.stringify(g7.export?.removalBlocked)})`,
  );
  ok(/Refused to remove 51 orphan/.test(g7.message), 'E: the refusal is in the message');
  ok(readdirSync(join(EXPORT, 'curated')).length === 51, 'E: all 51 files still on disk');
  // A foreign-tenant file is never touched, and a handful of own orphans are removed.
  for (let i = 5; i < 51; i++) {
    rmSync(join(EXPORT, 'curated', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}.md`));
  }
  const foreign = join(EXPORT, 'curated', 'ffffffff-ffff-4fff-8fff-ffffffffffff.md');
  writeFileSync(foreign, '---\nid: "x"\ntenant_id: "someone-else"\n---\n');
  const g8 = await s.call('brain_govern');
  ok(g8.export?.removed === 5 && existsSync(foreign), 'E: under the cap, own orphans removed; foreign tenant file kept');

  await s.close();

  // ───────────── F: qmd resolution ─────────────
  s = await session({ TEAMKB_QMD_BIN: join(WORK, 'does-not-exist') });
  const f1 = await s.call('brain_govern');
  ok(
    f1.indexUpdated === false && /TEAMKB_QMD_BIN is set to .* not an executable file/.test(f1.indexError),
    `F: a broken TEAMKB_QMD_BIN is a clear error, not a silent fallback`,
  );
  await s.close();

  s = await session({ TEAMKB_QMD_BIN: FAKE_QMD });
  const f2 = await s.call('brain_govern');
  ok(
    f2.indexUpdated === true && f2.indexError === undefined && f2.qmdBinary?.source === 'env' && f2.qmdBinary.path === FAKE_QMD,
    `F: TEAMKB_QMD_BIN used (source=${f2.qmdBinary?.source})`,
  );
  await s.close();

  const bunBin = join(HOME, '.bun', 'bin');
  mkdirSync(bunBin, { recursive: true });
  writeFileSync(join(bunBin, 'qmd'), readFileSync(FAKE_QMD));
  chmodSync(join(bunBin, 'qmd'), 0o755);
  s = await session(); // PATH is bare; only ~/.bun/bin/qmd can satisfy it
  const f3 = await s.call('brain_govern');
  ok(
    f3.indexUpdated === true && f3.qmdBinary?.source === 'bun-default',
    `F: ~/.bun/bin/qmd found with qmd absent from PATH (source=${f3.qmdBinary?.source})`,
  );
  await s.close();
} catch (e) {
  console.error(e);
  failed += 1;
} finally {
  rmSync(WORK, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nGOVERN-RECONCILE SMOKE PASS' : `\nGOVERN-RECONCILE SMOKE FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);

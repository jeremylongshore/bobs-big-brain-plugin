#!/usr/bin/env node
/**
 * Validate and run one synthetic golden-set fixture against the committed
 * local MCP runtime. This is deliberately zero-egress: the runtime is started
 * in local mode against a throwaway tenant and the runner never opens a
 * network client.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = join(ROOT, 'plugin-runtime', 'governed-brain.cjs');
const DEFAULT_FIXTURE = join(ROOT, 'contrib/golden-set/v1/synthetic-local-v1.json');
const CATEGORIES = new Set([
  'decision',
  'pattern',
  'convention',
  'architecture',
  'troubleshooting',
  'onboarding',
  'reference',
]);
const STATUSES = new Set(['promoted', 'inbox', 'duplicate']);
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const UNSAFE_RE =
  /(?:sk-[a-z0-9]|gh[pousr]_[a-z0-9]|akia[0-9a-z]{12,}|begin [a-z ]+private key|bearer\s+[a-z0-9._-]+|\/home\/|\/users\/|[a-z]:\\users\\|~\/\.teamkb|teamkb_api_key)/i;

const fixtureArg = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const fixturePath = fixtureArg ?? DEFAULT_FIXTURE;
const validateOnly = process.argv.includes('--validate-only');

function loadFixture(path) {
  if (!existsSync(path)) throw new Error(`fixture not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`fixture is not valid JSON: ${error.message}`);
  }
}

function validateFixture(fixture) {
  const errors = [];
  if (fixture?.format !== 'bobs-big-brain/golden-set/v1') {
    errors.push('format must be bobs-big-brain/golden-set/v1');
  }
  if (typeof fixture?.name !== 'string' || fixture.name.trim() === '') {
    errors.push('name must be a non-empty string');
  }
  if (typeof fixture?.description !== 'string' || fixture.description.trim() === '') {
    errors.push('description must be a non-empty string');
  }
  if (!Array.isArray(fixture?.cases) || fixture.cases.length < 1 || fixture.cases.length > 20) {
    errors.push('cases must contain between 1 and 20 entries');
    return errors;
  }

  const ids = new Set();
  for (const [index, item] of fixture.cases.entries()) {
    const label = `cases[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) {
      errors.push(`${label}.id must match ${ID_RE}`);
    } else if (ids.has(item.id)) {
      errors.push(`${label}.id is duplicated: ${item.id}`);
    } else {
      ids.add(item.id);
    }
    if (typeof item.title !== 'string' || item.title.trim() === '' || item.title.length > 120) {
      errors.push(`${label}.title must be 1-120 characters`);
    }
    if (typeof item.content !== 'string' || item.content.trim() === '' || item.content.length > 2000) {
      errors.push(`${label}.content must be 1-2000 characters`);
    }
    if (typeof item.category !== 'string' || !CATEGORIES.has(item.category)) {
      errors.push(`${label}.category must be one of ${[...CATEGORIES].join(', ')}`);
    }
    if (typeof item.expectedStatus !== 'string' || !STATUSES.has(item.expectedStatus)) {
      errors.push(`${label}.expectedStatus must be one of ${[...STATUSES].join(', ')}`);
    }
    if (UNSAFE_RE.test(`${item.title}\n${item.content}`)) {
      errors.push(`${label} contains a credential, private path, or team secret marker`);
    }
  }
  return errors;
}

function parseTool(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('MCP tool returned no text payload');
  return JSON.parse(text);
}

function candidateStatus(basePath, candidateId) {
  const db = new Database(join(basePath, 'teamkb.db'), { readonly: true });
  try {
    return db.prepare('SELECT status FROM candidates WHERE id = ?').get(candidateId)?.status;
  } finally {
    db.close();
  }
}

const fixture = loadFixture(fixturePath);
const validationErrors = validateFixture(fixture);
if (validationErrors.length > 0) {
  console.error(`GOLDEN SET INVALID: ${fixturePath}`);
  for (const error of validationErrors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`✓ validated ${fixture.cases.length} case(s): ${fixture.name}`);
if (validateOnly) process.exit(0);

const basePath = mkdtempSync(join(tmpdir(), 'bbb-golden-set-'));
const transport = new StdioClientTransport({
  command: 'node',
  args: [RUNTIME],
  env: { ...process.env, TEAMKB_BASE_PATH: basePath, TEAMKB_TENANT_ID: 'golden-set' },
});
const client = new Client({ name: 'bbb-golden-set', version: '0.0.0' }, { capabilities: {} });
let failures = 0;

try {
  await client.connect(transport);
  const status = parseTool(await client.callTool({ name: 'brain_status', arguments: {} }));
  if (typeof status.total !== 'number') {
    throw new Error('runtime did not return a local brain_status response');
  }
  console.log(`✓ local runtime booted in an isolated tenant (zero-egress path, total=${status.total})`);

  for (const item of fixture.cases) {
    const capture = parseTool(
      await client.callTool({
        name: 'brain_capture',
        arguments: { title: item.title, content: item.content, category: item.category },
      }),
    );
    const govern = parseTool(await client.callTool({ name: 'brain_govern', arguments: {} }));
    const actual = capture.ok ? candidateStatus(basePath, capture.candidateId) : 'capture-error';
    const matched = capture.ok && actual === item.expectedStatus;
    console.log(
      `${matched ? '✓' : '✗'} ${item.id}: expected=${item.expectedStatus} actual=${actual} ` +
        `(promoted=${govern.promoted ?? 0}, rejected=${govern.rejected ?? 0}, duplicate=${govern.duplicates ?? 0})`,
    );
    if (!matched) failures += 1;
  }
} finally {
  await client.close().catch(() => {});
  rmSync(basePath, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nGOLDEN SET PASS' : `\nGOLDEN SET FAIL (${failures} case(s))`);
process.exit(failures === 0 ? 0 : 1);

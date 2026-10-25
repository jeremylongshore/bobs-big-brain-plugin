/** Source-handler fault control; the shipped runtime is tested separately over MCP. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

test(
  'unexpected disclosure scanner faults refuse before origin or spool writes without echo',
  { timeout: 20_000 },
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'gsb-capture-fault-'));
    const helper = mkdtempSync(join(root, 'scripts', '.capture-feedback-'));
    const base = join(work, 'brain');
    mkdirSync(base);
    writeFileSync(join(base, 'existing-sentinel'), 'Private fixture retained unchanged.', {
      mode: 0o600,
    });
    const key = Symbol.for('bbb.capture.feedback.fault.fixture');
    const state = { handlers: new Map(), scans: 0, origins: 0, spools: 0, fault: null };
    assert.equal(globalThis[key], undefined);
    globalThis[key] = state;
    try {
      await build({
        entryPoints: [join(root, 'src', 'local-server.ts')],
        outfile: join(helper, 'server.mjs'),
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
        plugins: [
          {
            name: 'capture-fault-only',
            setup(builder) {
              builder.onResolve(
                {
                  filter:
                    /^(@qmd-team-intent-kb\/(common|claude-runtime)|@modelcontextprotocol\/sdk\/server\/mcp.js|\.\/config\.js)$/,
                },
                (args) => ({ path: args.path, namespace: 'capture-fault' }),
              );
              builder.onLoad({ filter: /.*/, namespace: 'capture-fault' }, (args) => {
                const stateExpression = `globalThis[Symbol.for('bbb.capture.feedback.fault.fixture')]`;
                let contents;
                if (args.path.endsWith('/common')) {
                  contents = `export * from ${JSON.stringify(require.resolve('@qmd-team-intent-kb/common'))};
                export function assertDisclosureClean() { const s=${stateExpression}; s.scans++; throw s.fault; }
                export function loadOrCreateOriginSecret() { ${stateExpression}.origins++; throw new Error('origin must not run'); }`;
                } else if (args.path.endsWith('/claude-runtime')) {
                  contents = `export async function writeToSpool() { ${stateExpression}.spools++; throw new Error('spool must not run'); }`;
                } else if (args.path === './config.js') {
                  const config = {
                    tenantId: 'local',
                    basePath: base,
                    dbPath: join(base, 'teamkb.db'),
                    spoolPath: join(base, 'spool'),
                    feedbackPath: join(base, 'feedback'),
                    exportDir: join(base, 'kb-export'),
                    qmdIndexPath: join(base, 'qmd-index', 'local'),
                  };
                  contents = `export const resolveConfig=()=>(${JSON.stringify(config)});`;
                } else {
                  contents = `export class McpServer { tool(name,...args) { ${stateExpression}.handlers.set(name,args.at(-1)); } }`;
                }
                return { contents, loader: 'js', resolveDir: root };
              });
            },
          },
        ],
      });
      await import(pathToFileURL(join(helper, 'server.mjs')).href);
      const capture = state.handlers.get('brain_capture');
      assert.equal(typeof capture, 'function');
      const originalStderrWrite = process.stderr.write;
      let requestStderr = '';
      process.stderr.write = function (chunk, encoding, callback) {
        requestStderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        assert.ok(requestStderr.length < 64 * 1024, 'Fixture stderr exceeded bound');
        const done = typeof encoding === 'function' ? encoding : callback;
        done?.();
        return true;
      };
      try {
        for (const fault of [
          new Error('private-synthetic-scanner-detail'),
          'private-synthetic-thrown-value',
        ]) {
          state.fault = fault;
          const response = await capture({
            title: 'Clean fixture',
            content: 'A clean invented fact whose scanner is intentionally unavailable.',
          });
          const result = JSON.parse(response.content[0].text);
          assert.deepEqual(result, {
            ok: false,
            error: 'capture-validation-unavailable',
            message: 'Capture refused before writing to the spool.',
          });
          assert.equal(result.candidateId, undefined);
          assert.equal(result.category, undefined);
        }
      } finally {
        process.stderr.write = originalStderrWrite;
      }
      assert.ok(!requestStderr.includes('private-synthetic-scanner-detail'));
      assert.ok(!requestStderr.includes('private-synthetic-thrown-value'));
      assert.equal(state.scans, 2);
      assert.equal(state.origins, 0);
      assert.equal(state.spools, 0);
      assert.deepEqual(readdirSync(base), ['existing-sentinel']);
      assert.equal(
        readFileSync(join(base, 'existing-sentinel'), 'utf8'),
        'Private fixture retained unchanged.',
      );
    } finally {
      delete globalThis[key];
      rmSync(helper, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  },
);

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const rootRequire = createRequire(new URL('../package.json', import.meta.url));
const sdkRequire = createRequire(rootRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
const expressRequire = createRequire(sdkRequire.resolve('express'));
const ajvRequire = createRequire(sdkRequire.resolve('ajv'));
const rateRequire = createRequire(sdkRequire.resolve('express-rate-limit'));
const minimatchRequire = createRequire(
  createRequire(rootRequire.resolve('eslint')).resolve('minimatch'),
);
const viteRequire = createRequire(createRequire(rootRequire.resolve('vitest')).resolve('vite'));
const postcssRequire = createRequire(viteRequire.resolve('postcss'));
const magicastRequire = createRequire(
  createRequire(rootRequire.resolve('@vitest/coverage-v8')).resolve('magicast'),
);
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-plugin-security-'));
  roots.push(root);
  const state = process.env.TEAMKB_TEST_SENTINEL_STATE;
  if (state) appendFileSync(state, JSON.stringify({ root }) + '\n');
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function child(entry: string, code: string) {
  const root = fixture();
  // These children execute only the selected JS function; they create no descendants.
  return spawnSync(process.execPath, ['-e', code, entry], {
    encoding: 'utf8',
    timeout: 1_500,
    killSignal: 'SIGKILL',
    cwd: root,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
      TMPDIR: root,
      PATH: dirname(process.execPath),
    },
  });
}
function exited(result: ReturnType<typeof child>) {
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

describe('selected plugin transitive security contracts', () => {
  it('does not trust arbitrary IPv4 clients through a short mapped IPv6 subnet', () => {
    const proxy = expressRequire('proxy-addr');
    expect(proxy.compile('::ffff:10.0.0.0/8')('203.0.113.9')).toBe(false);
    const req = {
      socket: { remoteAddress: '203.0.113.9' },
      headers: { 'x-forwarded-for': '192.0.2.99' },
    };
    expect(proxy(req, proxy.compile('::ffff:10.0.0.0/8'))).toBe('203.0.113.9');
    expect(proxy.compile('10.0.0.0/8')('10.2.3.4')).toBe(true);
    expect(proxy.compile('10.0.0.0/8')('203.0.113.9')).toBe(false);
  });

  it('keeps encoded URI schemes inert and preserves actual SDK Ajv local references', () => {
    const uri = ajvRequire('fast-uri');
    expect(uri.parse('%6Aavascript:alert(1)').error).toBeTruthy();
    expect(uri.normalize('%6Aavascript:alert(1)')).toBe('%6Aavascript:alert(1)');
    const Ajv = sdkRequire('ajv');
    const validate = new Ajv().compile({
      $defs: { value: { type: 'string' } },
      type: 'object',
      properties: { value: { $ref: '#/$defs/value' } },
      required: ['value'],
    });
    expect(validate({ value: 'valid' })).toBe(true);
    expect(validate({ value: 123 })).toBe(false);
    expect(uri.resolve('https://fixture.invalid/schema/root.json', './value.json')).toBe(
      'https://fixture.invalid/schema/value.json',
    );
  });

  it('rejects ambiguous leading-zero IPv4 and preserves rate-limit key behavior', () => {
    const address = rateRequire('ip-address');
    expect(() => new address.Address4('010.0.0.1')).toThrow();
    expect(new address.Address4('192.0.2.1').correctForm()).toBe('192.0.2.1');
    const rate = sdkRequire('express-rate-limit');
    expect(rate.ipKeyGenerator('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(rate.ipKeyGenerator('2001:db8:abcd:12ff::1', 56)).toBe('2001:db8:abcd:1200::/56');
  });

  it('bounds tiny nested brace input without a stack overflow and matches ordinary globs', () => {
    exited(
      child(
        minimatchRequire.resolve('brace-expansion'),
        `
      const { expand } = require(process.argv[1]);
      const result = expand('{'.repeat(3200) + 'a,b' + '}'.repeat(3200));
      if (!Array.isArray(result) || result.length > 4 || result.length === 0) process.exitCode = 1;
    `,
      ),
    );
    const minimatch = createRequire(rootRequire.resolve('eslint'))('minimatch');
    expect(minimatch.minimatch('file.ts', '*.{ts,js}')).toBe(true);
    expect(minimatch.minimatch('file.css', '*.{ts,js}')).toBe(false);
  });

  it('returns from zero-size custom NanoID generation and retains normal IDs', () => {
    exited(
      child(
        postcssRequire.resolve('nanoid'),
        `
      const n = require(process.argv[1]);
      if (n.customAlphabet('ab', 0)() !== '' || !/^[ab]{8}$/.test(n.customAlphabet('ab', 8)())) process.exitCode = 1;
    `,
      ),
    );
  });

  it('returns from negative non-secure NanoID generation', () => {
    exited(
      child(
        postcssRequire.resolve('nanoid/non-secure'),
        `
      const n = require(process.argv[1]);
      if (n.nanoid(-1) !== '' || n.nanoid(8).length !== 8) process.exitCode = 1;
    `,
      ),
    );
  });

  it('refuses invalid indexed source-map section offsets without a large mapping workload', () => {
    const { SourceMapConsumer } = magicastRequire('source-map-js');
    const map = { version: 3, sources: [], names: [], mappings: '' };
    expect(
      () =>
        new SourceMapConsumer({
          version: 3,
          sections: [{ offset: { line: 1.5, column: 0 }, map }],
        }),
    ).toThrow();
    const valid = new SourceMapConsumer({
      version: 3,
      sources: ['input.js'],
      names: [],
      mappings: 'AAAA',
    });
    expect(valid.originalPositionFor({ line: 1, column: 0 })).toMatchObject({
      source: 'input.js',
      line: 1,
      column: 0,
    });
  });

  it('keeps PostCSS previous maps inside the owned input directory', async () => {
    const root = fixture();
    const inputs = join(root, 'inputs');
    mkdirSync(inputs);
    const map = {
      version: 3,
      file: 'input.css',
      sources: ['original.css'],
      sourcesContent: ['PRIVATE_SYNTHETIC_CANARY'],
      names: [],
      mappings: 'AAAA',
    };
    writeFileSync(join(root, 'outside.map'), JSON.stringify(map));
    writeFileSync(
      join(inputs, 'inside.map'),
      JSON.stringify({ ...map, sourcesContent: ['LEGITIMATE_LOCAL_MAP'] }),
    );
    const postcss = viteRequire('postcss');
    const escaped = await postcss().process(
      'a { color: red }\n/*# sourceMappingURL=../outside.map */',
      { from: join(inputs, 'input.css'), to: join(inputs, 'output.css') },
    );
    expect(escaped.map?.toString() ?? '').not.toContain('PRIVATE_SYNTHETIC_CANARY');
    const valid = await postcss().process('a { color: red }\n/*# sourceMappingURL=inside.map */', {
      from: join(inputs, 'input.css'),
      to: join(inputs, 'output.css'),
    });
    expect(valid.map?.toString()).toContain('LEGITIMATE_LOCAL_MAP');
  });

  it('parses normal and rejects malformed JSON through the real Express/body-parser parent', async () => {
    const express = sdkRequire('express');
    const app = express();
    app.use(expressRequire('body-parser').json());
    app.post('/', (_req: unknown, res: { end: (text: string) => void }) => res.end('accepted'));
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No owned loopback address');
      const port = address.port;
      async function send(body: string) {
        return new Promise<number>((resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port,
              path: '/',
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode ?? 0));
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      }
      expect(await send('{"valid":true}')).toBe(200);
      expect(await send('{')).toBe(400);
    } finally {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    }
  });
});

import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const rootRequire = createRequire(new URL('../package.json', import.meta.url));
const sdkRequire = createRequire(rootRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
const expressRequire = createRequire(sdkRequire.resolve('express'));

describe('SDK-selected lower-severity dependency contracts', () => {
  it('enforces the tiny bracket-key comma limit and preserves ordinary query values', () => {
    const qs = expressRequire('qs');
    const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };
    expect(() => qs.parse('tag[]=a,b,c,d', options)).toThrow(RangeError);
    expect(qs.parse('tag=a&tag=b')).toEqual({ tag: ['a', 'b'] });
    const data = qs.parse('item[constructor][isBuffer]=value', { plainObjects: true });
    expect(qs.stringify(data)).toBe('item%5Bconstructor%5D%5BisBuffer%5D=value');
  });

  it('escapes a synthetic class value through actual Hono SSR', async () => {
    const { cx } = sdkRequire('hono/css');
    const { jsx } = sdkRequire('hono/jsx/jsx-runtime');
    const html = String(
      await jsx('div', {
        class: cx('base', '" data-synthetic="injected'),
        children: 'hello',
      }).toString(),
    );
    expect(html).not.toContain('data-synthetic="injected');
    expect(html).toContain('&quot;');
    const normal = String(
      await jsx('div', { class: cx('base', 'ordinary'), children: 'hello' }).toString(),
    );
    expect(normal).toMatch(/^<div class="[^"]*base ordinary">hello<\/div>$/);
  });

  it('serves a tiny owned loopback request through SDK-selected Hono and its Node adapter', async () => {
    // Compatibility only: this Linux fixture is not a Windows static-file exploit.
    const { Hono } = sdkRequire('hono');
    const { getRequestListener } = sdkRequire('@hono/node-server');
    const app = new Hono();
    app.get('/status', (context: { json: (body: unknown) => Response }) =>
      context.json({ ok: true }),
    );
    const server = createServer(getRequestListener(app.fetch));
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No owned loopback address');
      const port = address.port;
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/status', method: 'GET' }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (data: string) => {
            body += data;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(response).toEqual({ status: 200, body: '{"ok":true}' });
    } finally {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    }
  });
});

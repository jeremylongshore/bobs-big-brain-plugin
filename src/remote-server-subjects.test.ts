import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Team-mode `brain_capture` with `subjects` (subject-keyed supersession). The
 * handler is exercised through the exported `capture()` against a stubbed fetch;
 * the assertions are on the exact request body the server would receive.
 */
async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('./remote-server.js');
}

function payload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

interface Sent {
  metadata: Record<string, unknown>;
  [k: string]: unknown;
}

let box: string;
let sent: Sent[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'gsb-subjects-outbox-'));
  sent = [];
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Sent);
    return new Response(JSON.stringify({ intake: 'created' }), { status: 201 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  rmSync(box, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const env = () => ({
  TEAMKB_API_URL: 'http://brain:3847',
  TEAMKB_TENANT_ID: 't1',
  TEAMKB_OUTBOX_DIR: box,
});

describe('team brain_capture — subjects', () => {
  it('sends metadata.subjects (de-duplicated, ordered) in the POSTed candidate', async () => {
    const { capture } = await load(env());
    const out = payload(
      await capture('Hosting', 'We host on the VPS', 'decision', undefined, undefined, undefined, [
        'hosting.vps',
        'deploy-pipeline',
        'hosting.vps',
      ]),
    );
    expect(out['ok']).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.metadata['subjects']).toEqual(['hosting.vps', 'deploy-pipeline']);
    // The rest of the candidate is untouched.
    expect(sent[0]!.metadata['filePaths']).toEqual([]);
    expect(sent[0]!.metadata['tags']).toEqual([]);
  });

  it('backward compatible: no subjects -> the key is absent from the body (pre-subjects wire shape)', async () => {
    const { capture } = await load(env());
    await capture('T', 'plain capture body', undefined, undefined);
    await capture('T2', 'plain capture body 2', undefined, undefined, undefined, undefined, []);
    expect(sent).toHaveLength(2);
    for (const body of sent) expect('subjects' in body.metadata).toBe(false);
  });

  it('subjects do not change the derived candidate id (idempotent retry semantics preserved)', async () => {
    const { capture } = await load(env());
    const a = payload(await capture('T', 'same body', undefined, undefined));
    const b = payload(
      await capture('T', 'same body', undefined, undefined, undefined, undefined, ['x.y']),
    );
    expect(a['candidateId']).toBe(b['candidateId']);
  });

  it('rejects more than 8 subjects with a clear error and sends NOTHING', async () => {
    const { capture } = await load(env());
    const nine = Array.from({ length: 9 }, (_, i) => `s-${i}`);
    const out = payload(await capture('T', 'body', undefined, undefined, undefined, undefined, nine));
    expect(out['ok']).toBe(false);
    expect(String(out['error'])).toMatch(/at most 8/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readdirSync(box)).toHaveLength(0); // and nothing was queued to the outbox
  });

  it.each([['Bad Slug'], ['UPPER'], ['trailing.'], [''], ['x'.repeat(97)]])(
    'rejects the invalid slug %j with a clear error, sends nothing, queues nothing',
    async (bad) => {
      const { capture } = await load(env());
      const out = payload(
        await capture('T', 'body', undefined, undefined, undefined, undefined, ['ok.one', bad]),
      );
      expect(out['ok']).toBe(false);
      expect(String(out['error'])).toMatch(/not a valid subject key/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readdirSync(box)).toHaveLength(0);
    },
  );

  it('freezes subjects into the durable outbox when the API is unreachable, replayed verbatim', async () => {
    const { capture, drainOutbox } = await load(env());
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    const out = payload(
      await capture('T', 'offline body', 'decision', undefined, undefined, undefined, ['hosting.vps']),
    );
    expect(out['queued']).toBe(true);
    const file = readdirSync(box)[0]!;
    const frozen = JSON.parse(readFileSync(join(box, file), 'utf8')) as Sent;
    expect(frozen.metadata['subjects']).toEqual(['hosting.vps']);

    await drainOutbox();
    expect(sent.at(-1)!.metadata['subjects']).toEqual(['hosting.vps']);
  });

  it('with no API configured, still reports the unconfigured error first', async () => {
    const { capture } = await load({ TEAMKB_API_URL: '' });
    const out = payload(
      await capture('T', 'b', undefined, undefined, undefined, undefined, ['hosting.vps']),
    );
    expect(String(out['error'])).toMatch(/unconfigured/);
  });
});

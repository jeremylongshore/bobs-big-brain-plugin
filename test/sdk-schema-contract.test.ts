import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

async function withBoundedTool(
  exercise: (client: Client, handled: string[][]) => Promise<void>,
): Promise<void> {
  const handled: string[][] = [];
  const server = new McpServer({ name: 'plugin-schema-contract', version: '1.0.0' });
  const client = new Client({ name: 'plugin-schema-client', version: '1.0.0' });
  server.registerTool(
    'bounded_items',
    { inputSchema: { items: z.array(z.string()).max(2) } },
    async ({ items }) => {
      handled.push(items);
      return { content: [{ type: 'text', text: items.join('|') }] };
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await exercise(client, handled);
  } finally {
    try {
      await client.close();
    } finally {
      await server.close();
    }
  }
}

describe('selected plugin SDK and Zod v4 contract', () => {
  it('registers a bounded schema, lists its JSON Schema and executes a valid request', async () => {
    await withBoundedTool(async (client, handled) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: 'bounded_items',
        inputSchema: {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'string' }, maxItems: 2 } },
          required: ['items'],
        },
      });
      const result = await client.callTool({
        name: 'bounded_items',
        arguments: { items: ['first', 'second'] },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'first|second' }]);
      expect(handled).toEqual([['first', 'second']]);
    });
  });

  it('refuses oversized and invalid-element input before the handler and remains usable', async () => {
    await withBoundedTool(async (client, handled) => {
      const oversized = await client.callTool({
        name: 'bounded_items',
        arguments: { items: ['one', 'two', 'three'] },
      });
      expect(oversized.isError).toBe(true);
      expect(handled).toEqual([]);
      const invalid = await client.callTool({
        name: 'bounded_items',
        arguments: { items: [123] },
      });
      expect(invalid.isError).toBe(true);
      expect(handled).toEqual([]);
      const valid = await client.callTool({
        name: 'bounded_items',
        arguments: { items: ['after'] },
      });
      expect(valid.isError).not.toBe(true);
      expect(valid.content).toEqual([{ type: 'text', text: 'after' }]);
      expect(handled).toEqual([['after']]);
    });
  });
});

#!/usr/bin/env node
// Tiny MCP client wrapper for /teamkb-compile — drives the governed-brain
// stdio MCP server exactly the way the headless agent does, but from a shell
// session that doesn't have native MCP tool wiring.
//
// Usage:  node scripts/mcp-brain.cjs <tool-name> '<json-args>'
//        node scripts/mcp-brain.cjs --multi '<json>'    # send multiple calls in one session
// Output: pretty-printed JSON result on stdout (single) or JSONL on stdout (multi).

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { join } = require('node:path');

// Resolve the plugin root from this file's location (scripts/..) so the client
// works from any checkout; BBB_PLUGIN_ROOT still overrides it.
const PLUGIN = process.env.BBB_PLUGIN_ROOT || join(__dirname, '..');
const RUNTIME = join(PLUGIN, 'plugin-runtime', 'governed-brain.cjs');

(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [RUNTIME],
    env: { ...process.env, TEAMKB_TENANT_ID: process.env.TEAMKB_TENANT_ID || 'intent-solutions' },
    stderr: 'pipe',
  });

  const client = new Client(
    { name: 'teamkb-compile-shell', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  async function call(tool, args) {
    const res = await client.callTool({ name: tool, arguments: args || {} });
    const text = (res.content || []).map(b => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { ok: !res.isError, raw: res, parsed };
  }

  try {
    const argv = process.argv.slice(2);
    if (argv[0] === '--multi') {
      const arr = JSON.parse(argv[1]);
      for (const { tool, args } of arr) {
        const r = await call(tool, args);
        console.log(JSON.stringify({ tool, args, ok: r.ok, parsed: r.parsed }));
      }
    } else {
      const tool = argv[0];
      const args = argv[1] ? JSON.parse(argv[1]) : {};
      const r = await call(tool, args);
      if (r.parsed !== undefined) console.log(JSON.stringify(r.parsed, null, 2));
      else console.log(r.raw);
      if (!r.ok) process.exitCode = 2;
    }
  } finally {
    await client.close();
  }
})().catch(err => { console.error(err); process.exit(1); });

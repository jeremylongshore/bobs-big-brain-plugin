import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import type { QmdCommandProvenance } from '@qmd-team-intent-kb/qmd-adapter';

const source = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
interface Event {
  event: string;
  args?: string[];
  env?: Record<string, string>;
  options?: { basePath: string; tenantId: string };
  remaining?: number;
  pid?: number;
  startTicks?: string;
}
function owned(root: string): QmdCommandProvenance {
  return {
    source: 'owned',
    executable: process.execPath,
    prefix: [join(root, 'bin/owned-qmd.mjs')],
    runtime: {
      declaredRoot: root,
      root,
      manifestSha256: 'a'.repeat(64),
      qmdVersion: '2.5.3',
      sdkVersion: '1.32.2',
      zodVersion: '4.6.7',
      nodeAbi: '127',
      lockSha256: 'b'.repeat(64),
      sourceSnapshot: {
        baseCommit: 'c'.repeat(40),
        uncommittedCandidate: true,
        sourceFilesSha256: 'd'.repeat(64),
      },
    },
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-installer-cli-'));
  roots.push(root);
  const home = join(root, 'home');
  const copy = join(root, 'plugin');
  const runtime = join(copy, 'plugin-runtime');
  const bin = join(copy, 'bin');
  const input = join(home, 'input');
  const base = join(home, "brain's space");
  for (const dir of [home, bin, runtime, input, base, join(root, 'tools')])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(input, 'source.md'), 'synthetic input owned by installer test');
  writeFileSync(join(base, 'keep.txt'), 'existing brain sentinel');
  const pin = join(root, 'tools/qmd');
  writeFileSync(pin, '// never executed\n');
  chmodSync(pin, 0o700);
  let init = readFileSync(join(source, 'bin/init.mjs'), 'utf8');
  for (const spec of [
    '@modelcontextprotocol/sdk/client/index.js',
    '@modelcontextprotocol/sdk/client/stdio.js',
  ]) {
    const literal = `from '${spec}'`;
    expect(init.split(literal)).toHaveLength(2);
    init = init.replace(literal, `from '${pathToFileURL(require.resolve(spec)).href}'`);
  }
  writeFileSync(join(bin, 'init.mjs'), init);
  for (const file of ['installer-paths.mjs', 'installer-runtime.mjs'])
    copyFileSync(join(source, 'bin', file), join(bin, file));
  writeFileSync(
    join(runtime, 'governed-brain.cjs'),
    '// synthetic bundle existence sentinel; never loaded\n',
  );
  const trace = join(root, 'trace.jsonl');
  const log = `const fs=require('node:fs');const log=(v)=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(v)+'\\n');`;
  writeFileSync(
    join(runtime, 'bootstrap.cjs'),
    `${log}
const real=require(${JSON.stringify(join(source, 'plugin-runtime/bootstrap.cjs'))});
module.exports={...real,provisionNativeDependencies(){log({event:'provision'});}};
if(require.main===module)import('./server.mjs').catch(e=>{console.error(e);process.exit(1);});
`,
  );
  writeFileSync(
    join(runtime, 'qmd-command.cjs'),
    `${log}
log({event:'helper-import'});
exports.checkLocalQmd=async(options,deadline)=>{log({event:'availability',options,remaining:deadline-Date.now()});return JSON.parse(process.env.BBB_CHECKED);};
`,
  );
  const sdk = (spec: string) => pathToFileURL(require.resolve(spec)).href;
  writeFileSync(
    join(runtime, 'server.mjs'),
    `
import fs from 'node:fs';
import{McpServer}from ${JSON.stringify(sdk('@modelcontextprotocol/sdk/server/mcp.js'))};
import{StdioServerTransport}from ${JSON.stringify(sdk('@modelcontextprotocol/sdk/server/stdio.js'))};
import{z}from ${JSON.stringify(sdk('zod'))};
const log=(event)=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event,env:{TEAMKB_BASE_PATH:process.env.TEAMKB_BASE_PATH,TEAMKB_TENANT_ID:process.env.TEAMKB_TENANT_ID,TEAMKB_QMD_BIN:process.env.TEAMKB_QMD_BIN,TEAMKB_QMD_RUNTIME:process.env.TEAMKB_QMD_RUNTIME}})+'\\n');
const server=new McpServer({name:'private-fixture',version:'0.0.0'});
const answer=v=>({content:[{type:'text',text:JSON.stringify(v)}]});
server.tool('brain_capture',{title:z.string(),content:z.string(),category:z.string(),filePaths:z.array(z.string())},()=>{log('capture');return answer({ok:true,candidateId:'fixture'});});
server.tool('brain_govern',{},()=>{log('govern');return answer({ingested:1,promoted:1,rejected:0,duplicates:0,indexUpdated:true});});
server.tool('brain_status',{},()=>{log('status');return answer({total:1});});
await server.connect(new StdioServerTransport());
`,
  );
  const guard = join(root, 'guard.cjs');
  writeFileSync(
    guard,
    `${log}
const cp=require('node:child_process');const Module=require('node:module');
const fail=kind=>{log({event:'refused',kind});throw new Error('fixture refused '+kind);};
const realSpawn=cp.spawn;
cp.spawn=function(command,args,options){
 if(process.argv[1]===${JSON.stringify(join(bin, 'init.mjs'))}&&command==='node'&&args.length===1&&args[0]===${JSON.stringify(join(runtime, 'bootstrap.cjs'))}){const child=realSpawn.call(this,command,args,options);let startTicks;try{const stat=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');startTicks=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/)[19];}catch(error){if(error.code!=='ENOENT')throw error;}log({event:'child',pid:child.pid,startTicks,args,env:{TEAMKB_BASE_PATH:options.env.TEAMKB_BASE_PATH,TEAMKB_TENANT_ID:options.env.TEAMKB_TENANT_ID,TEAMKB_QMD_BIN:options.env.TEAMKB_QMD_BIN,TEAMKB_QMD_RUNTIME:options.env.TEAMKB_QMD_RUNTIME}});return child;}
 return fail('spawn');
};
cp.execFileSync=function(command,args){
 if(command==='claude'){log({event:'claude',args});return Buffer.from(args[0]==='--version'?'fixture Claude':'');}
 if(command==='node'&&args[0]===${JSON.stringify(join(root, 'fake-ico.cjs'))}){
  log({event:'fake-compile',args});
  if(args.includes('emit')){fs.mkdirSync(${JSON.stringify(join(base, 'ico-workspace/spool'))},{recursive:true});fs.writeFileSync(${JSON.stringify(join(base, 'ico-workspace/spool/spool-fixture.jsonl'))},'{}\\n');}
  return Buffer.alloc(0);
 }
 return fail('execFileSync');
};
for(const name of ['execSync','spawnSync','execFile','exec'])cp[name]=()=>fail(name);
const realRm=fs.rmSync;fs.rmSync=function(path,options){
 if(path===${JSON.stringify(join(base, 'ico-workspace'))})return realRm(path,options);
 return fail('clean');
};
const load=Module._load;Module._load=function(name,...args){if(name.endsWith('.node')||/^(better-sqlite3|fs-ext|sqlite-vec)(\\/|$)/.test(name))return fail('native');return load.call(this,name,...args);};
globalThis.fetch=()=>fail('fetch');require('node:net').Socket.prototype.connect=()=>fail('socket');Module.syncBuiltinESMExports();
`,
  );
  writeFileSync(join(root, 'fake-ico.cjs'), '// existence only; exec is intercepted\n');
  return { root, home, runtime, bin, input, base, pin, trace, guard };
}
async function run(
  f: ReturnType<typeof fixture>,
  selected: QmdCommandProvenance | null,
  extra: Record<string, string> = {},
  full = false,
  clean = false,
  exitCode = 0,
) {
  const child = spawn(
    process.execPath,
    [
      join(f.bin, 'init.mjs'),
      'init',
      f.input,
      '--base',
      f.base,
      '--tenant',
      "client's tenant",
      '--yes',
      ...(full ? [] : ['--index-only']),
      ...(clean ? ['--clean'] : []),
    ],
    {
      cwd: f.root,
      env: {
        HOME: f.home,
        PATH: '/usr/bin:/bin',
        TMPDIR: f.root,
        NODE_OPTIONS: `--require=${f.guard}`,
        COREPACK_ENABLE_NETWORK: '0',
        GSB_ICO_CLI: join(f.root, 'fake-ico.cjs'),
        BBB_CHECKED: JSON.stringify({
          result: {
            stdout: exitCode === 0 ? 'qmd 2.5.3' : '',
            stderr: 'declared selection failure',
            exitCode,
          },
          provenance: selected,
        }),
        ...extra,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const identity = (pid: number | undefined) => {
    if (!pid) return undefined;
    try {
      const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = text
        .slice(text.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      return { state: fields[0], startTicks: fields[19] };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const originalMain = identity(child.pid);
  const killOwned = () => {
    const currentMain = identity(child.pid);
    if (
      child.pid &&
      originalMain &&
      currentMain?.startTicks === originalMain.startTicks &&
      currentMain.state !== 'Z'
    ) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
      }
    }
    // A reaped leader no longer authorizes a negative-pgid signal. Only the
    // exact bootstrap child identities recorded at spawn remain eligible.
    const records: Event[] = existsSync(f.trace)
      ? readFileSync(f.trace, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
    for (const record of records) {
      if (record.event !== 'child' || !record.pid || !record.startTicks) continue;
      const current = identity(record.pid);
      if (current?.startTicks !== record.startTicks || current.state === 'Z') continue;
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
      }
    }
  };
  const terminal = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal }));
    },
  );
  const deadline = setTimeout(killOwned, 15_000);
  let outcome;
  try {
    outcome = await terminal;
  } finally {
    clearTimeout(deadline);
    killOwned();
  }
  const result = { ...outcome, stdout, stderr };
  const events: Event[] = existsSync(f.trace)
    ? readFileSync(f.trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  expect(result.signal).toBeNull();
  return { result, events };
}

describe('actual installer selection/bootstrap boundaries with synthetic MCP', () => {
  it('uses bootstrap, requested base and normalized successful env pin while ignoring an unused bad declaration', async () => {
    const f = fixture();
    mkdirSync(join(f.home, '.teamkb'));
    writeFileSync(join(f.home, '.teamkb/team.json'), 'unrelated broken team config');
    const { result, events } = await run(
      f,
      { source: 'env', executable: 'tools/qmd', prefix: [] },
      {
        TEAMKB_QMD_BIN: 'tools/qmd',
        TEAMKB_QMD_RUNTIME: 'unused broken declaration',
        TEAMKB_API_TOKEN: 'private-credential-canary',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(events.filter((e) => e.event === 'refused')).toEqual([]);
    expect(events.find((e) => e.event === 'availability')?.options).toMatchObject({
      basePath: f.base,
      tenantId: "client's tenant",
    });
    expect(events.find((e) => e.event === 'availability')?.remaining).toBeGreaterThan(0);
    expect(events.find((e) => e.event === 'availability')?.remaining).toBeLessThanOrEqual(5_000);
    expect(events.filter((e) => e.event === 'provision')).toHaveLength(1);
    const child = events.find((e) => e.event === 'child');
    expect(child?.args).toEqual([join(f.runtime, 'bootstrap.cjs')]);
    expect(child?.pid).toBeGreaterThan(0);
    expect(child?.startTicks).toMatch(/^\d+$/);
    expect(child?.env).toMatchObject({
      TEAMKB_BASE_PATH: f.base,
      TEAMKB_TENANT_ID: "client's tenant",
      TEAMKB_QMD_BIN: f.pin,
    });
    expect(
      events.filter((e) => ['capture', 'govern', 'status'].includes(e.event)).map((e) => e.event),
    ).toEqual(['capture', 'govern', 'status']);
    const registration = events.find(
      (e) => e.event === 'claude' && e.args?.[0] === 'mcp' && e.args[1] === 'add',
    );
    expect(registration?.args?.slice(-3)).toEqual(['--', 'node', join(f.runtime, 'bootstrap.cjs')]);
    expect(registration?.args).toContain(`TEAMKB_QMD_BIN=${f.pin}`);
    expect(JSON.stringify(registration)).not.toContain('private-credential-canary');
    expect(JSON.stringify(registration)).not.toContain('unused broken declaration');
  });

  it('routes the full-compile transport and paired owned persistence through bootstrap', async () => {
    const f = fixture();
    const root = join(f.root, 'separate-owned');
    mkdirSync(root);
    const { result, events } = await run(
      f,
      owned(root),
      {
        TEAMKB_QMD_RUNTIME: 'selected by fixture helper',
        DEEPSEEK_API_KEY: 'synthetic-not-a-credential',
      },
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(events.filter((e) => e.event === 'refused')).toEqual([]);
    expect(events.filter((e) => e.event === 'fake-compile')).toHaveLength(5);
    expect(events.find((e) => e.event === 'child')?.args).toEqual([
      join(f.runtime, 'bootstrap.cjs'),
    ]);
    const expected = JSON.stringify({ root, manifestSha256: 'a'.repeat(64) });
    expect(events.find((e) => e.event === 'child')?.env?.TEAMKB_QMD_RUNTIME).toBe(expected);
    const registration = events.find((e) => e.event === 'claude' && e.args?.[1] === 'add');
    expect(registration?.args).toContain(`TEAMKB_QMD_RUNTIME=${expected}`);
    expect(registration?.args?.some((a) => a.startsWith('TEAMKB_QMD_BIN='))).toBe(false);
    expect(events.filter((e) => e.event === 'capture')).toEqual([]);
    expect(
      events.filter((e) => ['govern', 'status'].includes(e.event)).map((e) => e.event),
    ).toEqual(['govern', 'status']);
  });

  for (const kind of ['api', 'team-file', 'failed-pin', 'failed-owned', 'forbidden-prefix']) {
    it(`refuses ${kind} before cleanup, provisioning, child launch or capture`, async () => {
      const f = fixture();
      let selected: QmdCommandProvenance | null = null;
      let exitCode = 0;
      const extra: Record<string, string> = {};
      if (kind === 'api') extra.TEAMKB_API_URL = 'https://team.invalid';
      if (kind === 'team-file')
        writeFileSync(join(f.base, 'team.json'), 'malformed selected team config');
      if (kind === 'failed-pin') {
        extra.TEAMKB_QMD_BIN = './broken';
        exitCode = 127;
      }
      if (kind === 'failed-owned') {
        extra.TEAMKB_QMD_RUNTIME = 'broken';
        exitCode = 127;
      }
      if (kind === 'forbidden-prefix') {
        const root = join(f.runtime, 'node_modules/owned');
        mkdirSync(root, { recursive: true });
        selected = owned(root);
        extra.TEAMKB_QMD_RUNTIME = 'fixture';
      }
      const { result, events } = await run(f, selected, extra, false, true, exitCode);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(
        kind === 'api' || kind === 'team-file'
          ? /Local init refuses/
          : kind === 'forbidden-prefix'
            ? /separate prefix/
            : /before local capture/,
      );
      expect(
        events.filter((e) =>
          ['provision', 'child', 'capture', 'refused', 'fake-compile', 'claude'].includes(e.event),
        ),
      ).toEqual([]);
      if (kind === 'api' || kind === 'team-file') expect(events).toEqual([]);
      expect(readFileSync(join(f.base, 'keep.txt'), 'utf8')).toBe('existing brain sentinel');
    });
  }
});

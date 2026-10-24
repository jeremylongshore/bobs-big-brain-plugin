#!/usr/bin/env node
// Development-workspace preparer only. No install, activation, purge or downloads.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const LIMIT = 2 * 1024 ** 3;
const TUPLE = [
  'bootstrap.cjs',
  'governed-brain.cjs',
  'qmd-command.cjs',
  'package.json',
  'package-lock.json',
];
/** @param {Uint8Array} bytes */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {string} message @returns {never} */
const fail = (message) => {
  throw new Error(message);
};
/** @param {string} path */
function fileHash(path) {
  const initial = lstatSync(path);
  if (!initial.isFile() || initial.size > LIMIT) fail('Hash input must be a bounded regular file');
  /** @param {import('node:fs').Stats} left @param {import('node:fs').Stats} right */
  const same = (left, right) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(initial, fstatSync(fd))) fail('Hash input changed before opening');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (bytes <= initial.size) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, initial.size + 1 - bytes), null);
      if (!size) break;
      bytes += size;
      if (bytes > initial.size) fail('Hash input grew while reading');
      digest.update(buffer.subarray(0, size));
    }
    if (bytes !== initial.size || !same(initial, fstatSync(fd)) || !same(initial, lstatSync(path)))
      fail('Hash input changed while reading');
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** @param {string} root @param {string} path */
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}
/** @param {string} path */
function prospective(path) {
  const missing = [];
  let anchor = resolve(path);
  for (;;) {
    try {
      const st = lstatSync(anchor);
      if (!st.isDirectory() && !st.isSymbolicLink()) fail('Output ancestor is not a directory');
      const actual = realpathSync(anchor);
      if (!lstatSync(actual).isDirectory()) fail('Output ancestor is not a directory');
      return { path: join(actual, ...missing), anchor: actual };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      // A dangling symlink is not a missing output ancestor.
      try {
        lstatSync(anchor);
        fail('Dangling output ancestor');
      } catch (again) {
        if (!(again instanceof Error) || !('code' in again) || again.code !== 'ENOENT') throw again;
      }
      const parent = dirname(anchor);
      if (parent === anchor) throw error;
      missing.unshift(basename(anchor));
      anchor = parent;
    }
  }
}
/** @param {string} name */
function memberPath(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    /[\r\n\\\0]/u.test(name) ||
    name.startsWith('/') ||
    name.split('/').some((p) => !p || p === '.' || p === '..')
  )
    fail('Unsafe package inventory member');
  return name;
}
/** @param {string} command @param {string[]} args @param {Omit<import('node:child_process').ExecFileSyncOptions, 'encoding'>} [options] */
function command(command, args, options = {}) {
  return execFileSync(command, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options });
}
/** @param {string} root @param {string[]} args */
function git(root, args) {
  return command('/usr/bin/git', ['-C', root, ...args]).toString('utf8');
}
/** @param {string} root */
function repositoryIdentity(root) {
  return {
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
    dirty: git(root, ['status', '--porcelain=v1', '-z']),
  };
}
/** @param {string} root */
function sourceSnapshot(root) {
  const names = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean)
    .sort();
  /** @type {Record<string, {sha256: string, bytes: number, mode: number}>} */
  const files = {};
  for (const name of names) {
    memberPath(name);
    const path = join(root, name);
    const st = lstatSync(path);
    if (!st.isFile()) fail('Source snapshot requires regular files: ' + name);
    files[name] = { sha256: fileHash(path), bytes: st.size, mode: st.mode & 0o777 };
  }
  return { ...repositoryIdentity(root), files };
}
/** @param {string} path */
function ancestorsWithoutModules(path) {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, 'node_modules')))
      fail('Ancestor node_modules defeats standalone preparation');
    if (dirname(current) === current) break;
  }
}
/** @param {string} text */
function tarMode(text) {
  if (!/^-[rwx-]{9}$/u.test(text)) fail('Archive contains non-regular or special-mode member');
  return [...text.slice(1)].reduce(
    (mode, char, index) => mode | (char === '-' ? 0 : 1 << (8 - index)),
    0,
  );
}

/** Prepare a source-bound private directory; failures retain incomplete output.
 * @param {{sourceRoot: string, candidate: string, expectedManifestSha256: string, output: string}} options
 */
export async function prepareOwnedDistribution({
  sourceRoot,
  candidate,
  expectedManifestSha256,
  output,
}) {
  sourceRoot = realpathSync(sourceRoot);
  candidate = realpathSync(candidate);
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256))
    fail('Expected manifest SHA256 must be explicit');
  const planned = prospective(output);
  output = planned.path;
  for (const input of [sourceRoot, candidate]) {
    if (inside(input, output) || inside(output, input)) fail('Output overlaps source or candidate');
  }
  ancestorsWithoutModules(output);
  if (existsSync(output)) fail('Output must be fresh');
  // Only an already-existing parent is accepted: the exclusive mkdir reserves one leaf.
  if (dirname(output) !== planned.anchor) fail('Output parent must already exist');
  const verifierPath = realpathSync(
    join(sourceRoot, '../bobs-big-brain-registrar/packages/qmd-runtime/lib/runtime-inventory.mjs'),
  );
  const verifierSha256 = fileHash(verifierPath);
  const verifierRepository = realpathSync(join(sourceRoot, '../bobs-big-brain-registrar'));
  const verifierRepositoryBefore = repositoryIdentity(verifierRepository);
  const { verifyRuntime } = await import(pathToFileURL(verifierPath).href);
  const before = sourceSnapshot(sourceRoot);
  // setup-node and version managers install npm in the selected Node prefix;
  // /usr/bin/npm may be absent or belong to a different Node installation.
  const nodeExecutable = realpathSync(process.execPath);
  const npmCli = realpathSync(
    resolve(dirname(nodeExecutable), '../lib/node_modules/npm/bin/npm-cli.js'),
  );
  const npmCliSha256 = fileHash(npmCli);
  const manifestPath = join(candidate, 'runtime-manifest.json');
  if (fileHash(manifestPath) !== expectedManifestSha256) fail('Candidate manifest digest mismatch');
  const verified = verifyRuntime(candidate);
  const candidateBinding = JSON.stringify(verified.manifest);
  if (verified.manifest.inventory.bytes > LIMIT) fail('Candidate exceeds byte budget');
  mkdirSync(output, { mode: 0o700 });
  const incomplete = join(output, 'INCOMPLETE.json');
  writeFileSync(
    incomplete,
    JSON.stringify({ status: 'incomplete', sourceRoot, candidate, expectedManifestSha256 }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const preparation = join(output, '.preparation');
  mkdirSync(preparation, { mode: 0o700 });
  for (const name of ['home', 'cache', 'tmp']) mkdirSync(join(preparation, name), { mode: 0o700 });
  for (const kind of ['user', 'global'])
    writeFileSync(join(preparation, kind + '.npmrc'), '', { flag: 'wx', mode: 0o600 });
  const env = {
    npm_config_userconfig: join(preparation, 'user.npmrc'),
    npm_config_globalconfig: join(preparation, 'global.npmrc'),
    PATH: dirname(nodeExecutable) + ':/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: join(preparation, 'home'),
    TMPDIR: join(preparation, 'tmp'),
    npm_config_cache: join(preparation, 'cache'),
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    COREPACK_ENABLE_NETWORK: '0',
    LC_ALL: 'C',
  };
  // No scripts; source-workspace Git/excludes behavior remains the caller's responsibility.
  const raw = command(
    nodeExecutable,
    [npmCli, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', preparation],
    { cwd: sourceRoot, env },
  );
  writeFileSync(join(preparation, 'pack-output.json'), raw, { flag: 'wx', mode: 0o600 });
  const parsed = JSON.parse(raw.toString('utf8'));
  const packages = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.files)
      ? [parsed]
      : parsed && typeof parsed === 'object'
        ? Object.values(parsed)
        : [];
  if (packages.length !== 1 || !Array.isArray(packages[0].files))
    fail('Expected exactly one packed package');
  const pack = packages[0];
  if (basename(pack.filename) !== pack.filename || !pack.filename.endsWith('.tgz'))
    fail('Unsafe pack filename');
  const archive = join(preparation, pack.filename);
  /** @type {Map<string, {path: string, size: number, mode: number}>} */
  const entries = new Map();
  const packageManifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
  const rawBins =
    typeof packageManifest.bin === 'string'
      ? [packageManifest.bin]
      : Object.values(packageManifest.bin ?? {});
  const packageBins = new Set(
    rawBins.map((name) => {
      if (typeof name !== 'string') fail('Package bin paths must be strings');
      return memberPath(name.replace(/^\.\//u, ''));
    }),
  );
  let totalBytes = verified.manifest.inventory.bytes;
  for (const item of pack.files) {
    const name = memberPath(item.path);
    if (entries.has(name) || !Number.isSafeInteger(item.size) || item.size < 0)
      fail('Duplicate or invalid pack entry');
    if (![0o644, 0o755].includes(item.mode))
      fail('Packed source/archive mode must be 0644 or 0755');
    if (
      name.split('/').includes('node_modules') ||
      name.split('/').includes('__pycache__') ||
      name.endsWith('.pyc') ||
      /\.(node|so|dll|dylib)$/u.test(name)
    )
      fail('Native/dependency payload forbidden in plugin pack');
    const source = join(sourceRoot, name);
    const st = lstatSync(source);
    // npm/pacote portable tar mode: owner rw, no group/other write, bins executable.
    const packedMode = ((st.mode & 0o777) | 0o600 | (packageBins.has(name) ? 0o111 : 0)) & ~0o22;
    if (
      !st.isFile() ||
      realpathSync(source) !== source ||
      st.size !== item.size ||
      (st.mode & 0o7000) !== 0 ||
      packedMode !== item.mode
    )
      fail('Packed source file/mode mismatch: ' + name);
    entries.set(name, item);
    totalBytes += item.size;
  }
  if (totalBytes > LIMIT) fail('Combined distribution exceeds byte budget');
  for (const name of [...TUPLE.map((name) => 'plugin-runtime/' + name), 'gsb.lock.json'])
    if (!entries.has(name)) fail('Missing required tuple member: ' + name);
  const listed = command('/usr/bin/tar', ['-tf', archive, '--quoting-style=literal'], {
    env,
  })
    .toString('utf8')
    .trimEnd()
    .split('\n');
  if (
    listed.length !== entries.size ||
    new Set(listed).size !== listed.length ||
    listed.some((name) => !name.startsWith('package/') || !entries.has(name.slice(8)))
  )
    fail('Tar members differ from generated pack inventory');
  const verbose = command(
    '/usr/bin/tar',
    ['-tvf', archive, '--numeric-owner', '--quoting-style=literal'],
    { env },
  )
    .toString('utf8')
    .trimEnd()
    .split('\n');
  if (verbose.length !== entries.size) fail('Tar metadata count mismatch');
  for (const line of verbose) {
    const match =
      /^([-a-z][rwxstST-]{9})\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.*)$/u.exec(line);
    if (!match || !match[3].startsWith('package/')) fail('Unsupported GNU tar metadata format');
    const item = entries.get(match[3].slice(8));
    if (!item || tarMode(match[1]) !== item.mode || Number(match[2]) !== item.size)
      fail('Tar mode/size mismatch');
  }
  const plugin = join(output, 'plugin');
  mkdirSync(plugin, { mode: 0o700 });
  /** @type {Record<string, {sha256: string, bytes: number, mode: number}>} */
  const packedHashes = {};
  for (const [name, item] of entries) {
    const bytes = command('/usr/bin/tar', ['-xOf', archive, '--', 'package/' + name], {
      env,
      maxBuffer: item.size + 1,
    });
    if (bytes.length !== item.size || hash(bytes) !== fileHash(join(sourceRoot, name)))
      fail('Tar/source bytes differ: ' + name);
    const destination = join(plugin, name);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { flag: 'wx', mode: item.mode });
    chmodSync(destination, item.mode);
    packedHashes[name] = { sha256: hash(bytes), bytes: bytes.length, mode: item.mode };
  }
  const owned = join(output, 'owned-qmd');
  cpSync(candidate, owned, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  // cpSync creates the destination root with the process umask; restore its
  // already-verified mode before asking the original verifier to compare it.
  const rootEntry = verified.manifest.inventory.entries[''];
  if (
    rootEntry?.kind !== 'directory' ||
    !Number.isInteger(rootEntry.mode) ||
    rootEntry.mode < 0 ||
    rootEntry.mode > 0o777
  )
    fail('Invalid verified runtime root mode');
  chmodSync(owned, rootEntry.mode);
  const destinationVerified = verifyRuntime(owned);
  if (
    JSON.stringify(destinationVerified.manifest) !== candidateBinding ||
    fileHash(join(owned, 'runtime-manifest.json')) !== expectedManifestSha256
  )
    fail('Relocated candidate identity changed');
  if (
    JSON.stringify(verifyRuntime(candidate).manifest) !== candidateBinding ||
    fileHash(manifestPath) !== expectedManifestSha256
  )
    fail('Source candidate changed');
  if (
    fileHash(npmCli) !== npmCliSha256 ||
    fileHash(verifierPath) !== verifierSha256 ||
    JSON.stringify(repositoryIdentity(verifierRepository)) !==
      JSON.stringify(verifierRepositoryBefore) ||
    JSON.stringify(sourceSnapshot(sourceRoot)) !== JSON.stringify(before)
  )
    fail('Source or verifier changed during preparation');
  const receipt = {
    schema: 'bbb-private-distribution/v1',
    scope:
      'Prepared directory only; no install, activation, native execution or portable compatibility/SLO proof',
    limits: [
      'Host platform and ABI are checked by the existing verifier; this is not a cross-platform artifact',
      'Payload byte policy and child output/deadlines do not hard-bound total disk use or synchronous hashing/copy time',
      'Fresh-directory/path checks are not confinement against hostile concurrent same-UID writers',
    ],
    source: before,
    verifier: {
      path: verifierPath,
      sha256: verifierSha256,
      repository: verifierRepositoryBefore,
      scope: 'Trusted sibling development prerequisite; not a delivered runtime dependency',
    },
    plugin: { relativePath: 'plugin', archiveSha256: fileHash(archive), files: packedHashes },
    owned: {
      relativePath: 'owned-qmd',
      manifestSha256: expectedManifestSha256,
      historicalCandidate: {
        sourceSnapshot: verified.manifest.sourceSnapshot,
        sourceFiles: verified.manifest.sourceFiles,
        meaning:
          'Historical base/uncommitted flag and eight source bindings retained unchanged; not relabeled as plugin or verifier HEAD',
      },
      platform: verified.manifest.platform,
      nodeAbi: verified.manifest.nodeAbi,
      inventory: {
        bytes: verified.manifest.inventory.bytes,
        entries: Object.keys(verified.manifest.inventory.entries).length,
      },
    },
    selection: { root: owned, manifestSha256: expectedManifestSha256 },
    preparation: '.preparation',
    totalPayloadBytes: totalBytes,
    node: { version: process.version, abi: process.versions.modules },
    packToolchain: { nodeExecutable, npmCli, npmCliSha256 },
  };
  renameSync(incomplete, join(preparation, 'initial-incomplete-record.json'));
  const temporary = join(output, '.receipt-pending.json');
  writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  // Exclusive publication: link fails if any success name already exists. Retain our pending file.
  const success = join(output, 'distribution-receipt.json');
  linkSync(temporary, success);
  return { output, receipt: success };
}

let direct = false;
try {
  direct =
    Boolean(process.argv[1]) &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* Import without a resolvable argv entry is inert. */
}
if (direct) {
  const { values } = parseArgs({
    options: {
      candidate: { type: 'string' },
      'expected-manifest-sha256': { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.candidate || !values['expected-manifest-sha256'] || !values.output)
    fail('Pass --candidate, --expected-manifest-sha256 and --output');
  const result = await prepareOwnedDistribution({
    sourceRoot: fileURLToPath(new URL('..', import.meta.url)),
    candidate: values.candidate,
    expectedManifestSha256: values['expected-manifest-sha256'],
    output: values.output,
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

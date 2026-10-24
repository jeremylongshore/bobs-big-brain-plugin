import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** @param {string} path */
function directoryIdentity(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) throw new Error(`Installer path is not a directory: ${path}`);
  return { path, device: stat.dev, inode: stat.ino };
}

/** Resolve an existing directory or a missing tail without creating anything.
 * @param {string} path
 */
export function canonicalizeExistingOrMissing(path) {
  let ancestor = resolve(path);
  const missing = [];
  while (true) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  // lstat sees dangling links: realpath must reject them rather than treating
  // their target as a missing directory that could later escape the home.
  const canonicalAncestor = realpathSync(ancestor);
  const identity = directoryIdentity(canonicalAncestor);
  return { path: join(canonicalAncestor, ...missing), ancestor: identity, missing };
}

/** @param {string} parent @param {string} child */
function strictlyWithin(parent, child) {
  const tail = relative(parent, child);
  return (
    tail !== '' &&
    tail !== '..' &&
    !tail.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(tail)
  );
}

/** Validate the target before consent, cleanup, provisioning or registration.
 * @param {{home: string, base: string, inputFolder: string, clean?: boolean}} options
 */
export function validateBrainTarget({ home, base, inputFolder, clean = false }) {
  const request = {
    home: resolve(home),
    base: resolve(base),
    inputFolder: resolve(inputFolder),
    clean,
  };
  const canonicalHome = realpathSync(request.home);
  const homeIdentity = directoryIdentity(canonicalHome);
  const canonicalInput = realpathSync(request.inputFolder);
  const inputIdentity = directoryIdentity(canonicalInput);
  const target = canonicalizeExistingOrMissing(request.base);
  if (!strictlyWithin(canonicalHome, target.path)) {
    throw new Error(
      'Brain directory must be a strict descendant of your home directory; HOME itself is refused.',
    );
  }
  if (
    clean &&
    (target.path === canonicalInput ||
      strictlyWithin(target.path, canonicalInput) ||
      strictlyWithin(canonicalInput, target.path))
  ) {
    throw new Error('--clean brain directory must not overlap the input folder.');
  }
  return {
    request,
    basePath: target.path,
    inputFolder: canonicalInput,
    identities: [homeIdentity, inputIdentity, target.ancestor],
    missing: target.missing,
  };
}

/** Detect path/identity changes while the installer waited for consent.
 * @param {ReturnType<typeof validateBrainTarget>} previous
 */
export function revalidateBrainTarget(previous) {
  const current = validateBrainTarget(previous.request);
  if (JSON.stringify(current) !== JSON.stringify(previous)) {
    throw new Error('Installer target changed after validation; rerun the installer.');
  }
  return current;
}

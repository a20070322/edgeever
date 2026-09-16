import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const source = join(packageRoot, 'skills', 'edgeever');
const marker = '.edgeever-install.json';
const owner = 'knowledge-workbench-edgeever-cli';
export const packageVersion = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version;

export function skillTargets(env = process.env, home = homedir()) {
  return {
    codex: join(env.CODEX_HOME || join(home, '.codex'), 'skills'),
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills'),
    kimi: join(env.KIMI_CODE_HOME || join(home, '.kimi-code'), 'skills'),
  };
}

const inspect = async path => {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// Include extra files and reject links so user changes are never silently lost.
async function fingerprint(root, relative = '') {
  const hashes = {};
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (path === marker) continue;
    if (entry.isSymbolicLink()) throw Error(`Skill contains a symbolic link: ${path}`);
    if (entry.isDirectory()) Object.assign(hashes, await fingerprint(root, path));
    else if (entry.isFile()) hashes[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
    else throw Error(`Unsupported skill file: ${path}`);
  }
  return hashes;
}
const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);

async function state(directory, bundled) {
  const info = await inspect(directory);
  if (!info) return { status: 'not-installed' };
  if (!info.isDirectory() || info.isSymbolicLink()) return { status: 'blocked', reason: 'Destination is not a regular directory' };
  const meta = await inspect(join(directory, marker));
  if (!meta || !meta.isFile() || meta.isSymbolicLink()) return { status: 'unmanaged' };
  let installed;
  try { installed = JSON.parse(await readFile(join(directory, marker), 'utf8')); }
  catch { return { status: 'unmanaged', reason: 'Invalid installation metadata' }; }
  if (installed.package !== owner || installed.schema !== 1) return { status: 'unmanaged' };
  let current;
  try { current = await fingerprint(directory); }
  catch (error) { return { status: 'blocked', reason: error.message }; }
  if (!same(current, installed.files)) return { status: 'modified', installedVersion: installed.version };
  return { status: installed.version === packageVersion && same(current, bundled) ? 'current' : 'outdated', installedVersion: installed.version };
}

async function apply(action, root, force, bundled) {
  const directory = join(root, 'edgeever');
  if (action === 'status') return { directory, ...(await state(directory, bundled)) };
  await mkdir(root, { recursive: true });
  const lock = join(root, '.edgeever-install.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error(`Skill installation is locked at ${lock}. Check that no installer is running before removing a stale lock.`);
    throw error;
  }
  let staging;
  let backup;
  let moved = false;
  try {
    const previous = await state(directory, bundled);
    if (previous.status === 'blocked') return { directory, ...previous };
    if (['modified', 'unmanaged'].includes(previous.status) && !force) {
      return { directory, ...previous, reason: 'Preserved local files. Review them; --force backs them up before replacement.' };
    }
    if (previous.status === 'current') return { directory, ...previous };
    if (action === 'install' && previous.status === 'outdated') return { directory, ...previous, reason: 'Use skill update to update an existing installation.' };
    if (action === 'update' && previous.status === 'not-installed') return { directory, ...previous, reason: 'Use skill install first.' };
    staging = await mkdtemp(join(root, '.edgeever-stage-'));
    await cp(source, staging, { recursive: true });
    await writeFile(join(staging, marker), JSON.stringify({ schema: 1, package: owner, version: packageVersion, files: bundled }, null, 2) + '\n');
    if (previous.status !== 'not-installed') {
      const backupRoot = join(dirname(root), '.edgeever-skill-backups');
      await mkdir(backupRoot, { recursive: true });
      backup = join(backupRoot, `edgeever-${Date.now()}-${randomUUID()}`);
      await rename(directory, backup);
      moved = true;
    }
    try { await rename(staging, directory); staging = undefined; }
    catch (error) { if (moved) { await rename(backup, directory); moved = false; } throw error; }
    return { directory, status: previous.status === 'not-installed' ? 'installed' : 'updated', installedVersion: packageVersion, ...(backup ? { backup } : {}) };
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}

export async function manageSkills(args) {
  const [action, ...rest] = args;
  if (!['install', 'status', 'update'].includes(action)) throw Error('Usage: edgeever skill install|status|update --target codex|claude|kimi|all [--force], or --dir <skills-directory>');
  let target, directory, force = false;
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    if (option === '--force') { force = true; continue; }
    if (!['--target', '--dir'].includes(option) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw Error(`Invalid skill option: ${option}`);
    const value = rest[++i];
    if (option === '--target') { if (target) throw Error('Duplicate --target'); target = value; }
    else { if (directory) throw Error('Duplicate --dir'); directory = value; }
  }
  if (target && directory) throw Error('Choose --target or --dir, not both');
  if (!target && !directory && action !== 'status') throw Error('Specify --target codex|claude|kimi|all or --dir <skills-directory>');
  if (force && action === 'status') throw Error('--force only applies to install or update');
  const targets = skillTargets();
  if (target && target !== 'all' && !Object.hasOwn(targets, target)) throw Error(`Unknown skill target: ${target}`);
  const selected = directory ? [['custom', resolve(directory)]] : target && target !== 'all' ? [[target, targets[target]]] : Object.entries(targets);
  const bundled = await fingerprint(source);
  const results = [];
  for (const [name, root] of selected) {
    try { results.push({ target: name, ...(await apply(action, resolve(root), force, bundled)) }); }
    catch (error) { results.push({ target: name, directory: join(resolve(root), 'edgeever'), status: 'error', reason: error.message }); }
  }
  return { version: packageVersion, results };
}

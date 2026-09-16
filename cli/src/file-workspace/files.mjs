import { createHash, randomUUID } from 'node:crypto';
import { lstat, link as hardLink, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, relative, sep, posix } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const safeName = value => {
  const s = String(value).normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').slice(0, 70) || 'untitled';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) ? `_${s}` : s;
};
export const part = (name, id) => `${safeName(name)}--${hash(id).slice(0, 16)}`;

// Reject symlinks in every component, including the workspace and private state.
export async function safePath(root, file = '') {
  const target = resolve(root, file);
  const rel = relative(resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw Error('Path escapes workspace');
  let cursor = resolve(root);
  const pieces = ['', ...rel.split(sep).filter(Boolean)];
  for (const piece of pieces) {
    if (piece) cursor = resolve(cursor, piece);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw Error(`Symlink is not allowed: ${cursor}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
export async function read(root, file) {
  try { return await readFile(await safePath(root, file), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function atomic(root, file, value) {
  const target = await safePath(root, file);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  try { await safePath(root, file); await rename(temp, target); }
  catch (e) { await unlink(temp).catch(() => {}); throw e; }
}
// Publish without overwriting a file created by an editor during synchronization.
export async function installFile(root, path, content, expected, id) {
  const target = await safePath(root, path);
  await mkdir(dirname(target), { recursive: true });
  let backup;
  if (expected !== null) {
    backup = await safePath(root, `.edgeever/history/${hash(id)}/${randomUUID()}.md`);
    await mkdir(dirname(backup), { recursive: true });
    try { await rename(target, backup); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    if (!(await readFile(backup)).equals(Buffer.from(expected))) {
      await hardLink(backup, target).catch(e => { if (e.code !== 'EEXIST') throw e; });
      return false;
    }
  }
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try { await safePath(root, path); await hardLink(temp, target); return true; }
  catch (e) {
    if (backup) await hardLink(backup, target).catch(() => {});
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally { await unlink(temp); }
}

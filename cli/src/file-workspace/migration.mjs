import { randomUUID } from 'node:crypto';
import { mkdir, rename, link as hardLink, rmdir, unlink } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { read, atomic, hash, safePath, installFile } from './files.mjs';
import { encodeNote } from './metadata.mjs';
import { availablePath } from './layout.mjs';
import { relocateAttachments } from './attachments.mjs';

const journalPath = '.edgeever/migration-v3.json';
export async function migrateWorkspace(root, state, { dryRun = false } = {}) {
  let journal = await read(root, journalPath);
  if (state.version === 3 && !journal) return { status: 'current', version: 3 };
  if (journal) journal = JSON.parse(journal);
  else {
    const backup = `.edgeever/migrations/v3-${randomUUID()}`;
    const next = structuredClone(state); next.version = 3; next.notebookPaths = {};
    const files = [], folders = new Map(), reserved = new Set();
    async function folder(old) {
      if (!old || old === '.') return '';
      if (folders.has(old)) return folders.get(old);
      const parent = await folder(posix.dirname(old));
      const desired = posix.join(parent, posix.basename(old).replace(/--[a-f\d]{16}$/i, ''));
      // Existing folders are left alone; use a distinct name if needed.
      const target = await availablePath(root, desired, reserved, true);
      folders.set(old, target); return target;
    }
    for (const [id, entry] of Object.entries(state.entries)) {
      const raw = await read(root, entry.path);
      if (raw === null) throw Error(`Cannot migrate missing local file: ${entry.path}`);
      const parent = await folder(posix.dirname(entry.path));
      const name = posix.basename(entry.path).replace(/--[a-f\d]{16}(?=\.md$)/i, '');
      const target = await availablePath(root, posix.join(parent, name), reserved);
      const body = await relocateAttachments(root, raw, entry.path, target);
      const base = await relocateAttachments(root, entry.base, entry.path, target);
      const nextEntry = { ...entry, path: target, base, hash: hash(base), serverBase: entry.serverBase ?? entry.base, serverHash: entry.serverHash ?? entry.hash };
      next.entries[id] = nextEntry; next.notebookPaths[entry.notebookId] = parent;
      files.push({ id, from: entry.path, to: target, before: raw, after: encodeNote(body, id) });
    }
    journal = { backup, state: next, previousState: state, files };
    if (!dryRun) {
      await atomic(root, `${backup}/state.json`, JSON.stringify(state, null, 2));
      // Snapshot every original before the first visible file change.
      for (const file of files) await atomic(root, `${backup}/files/${hash(file.id)}.md`, file.before);
      await atomic(root, journalPath, JSON.stringify(journal, null, 2));
    }
  }
  const result = { status: dryRun ? 'would-migrate' : 'migrated', version: 3, backup: journal.backup, files: journal.files.map(({ id, from, to }) => ({ id, from, to })) };
  if (dryRun) return result;
  // Resume the same saved plan after interruption; never overwrite an edited destination.
  for (const file of journal.files) {
    const from = await read(root, file.from), to = await read(root, file.to);
    if (from !== null && from !== file.before) throw Error(`Migration source changed: ${file.from}. Original backup: ${journal.backup}`);
    if (to !== null && to !== file.after) throw Error(`Migration destination changed: ${file.to}. Original backup: ${journal.backup}`);
    if (to === null && !await installFile(root, file.to, file.after, null, file.id)) throw Error(`Migration destination appeared: ${file.to}`);
    if (from !== null) {
      const retired = await safePath(root, `${journal.backup}/retired/${hash(file.id)}.md`);
      await mkdir(dirname(retired), { recursive: true });
      await rename(await safePath(root, file.from), retired);
      if (await read(root, `${journal.backup}/retired/${hash(file.id)}.md`) !== file.before) {
        await hardLink(retired, await safePath(root, file.from)).catch(() => {});
        throw Error(`Local file changed during migration: ${file.from}; preserved at ${retired}`);
      }
    }
  }
  await atomic(root, '.edgeever/state.json', JSON.stringify(journal.state, null, 2) + '\n');
  await unlink(await safePath(root, journalPath));
  for (const file of journal.files) {
    let dir = posix.dirname(file.from);
    while (dir && dir !== '.') {
      try { await rmdir(await safePath(root, dir)); } catch { break; }
      dir = posix.dirname(dir);
    }
  }
  return result;
}

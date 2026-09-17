import { randomUUID } from 'node:crypto';
import { mkdir, rename, link, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { read, safePath, atomic, installFile } from './files.mjs';

export const moveJournal = '.edgeever/pending-move.json';
// Resume before scanning IDs: an interrupted move can temporarily have no visible
// source, or both source/destination. Keep original bytes in history permanently.
export async function resumeMove(root, state, save) {
  const raw = await read(root, moveJournal);
  if (!raw) return;
  const plan = JSON.parse(raw);
  const source = await read(root, plan.from), destination = await read(root, plan.to);
  let backup = await read(root, plan.backup);
  if (destination !== null && destination !== plan.after) throw Error(`Move destination changed: ${plan.to}; recovery retained in ${moveJournal}`);
  if (backup === null) {
    if (source !== plan.before) throw Error(`Move source changed: ${plan.from}; recovery retained in ${moveJournal}`);
    await mkdir(await safePath(root, posix.dirname(plan.backup)), { recursive: true });
    await rename(await safePath(root, plan.from), await safePath(root, plan.backup));
    backup = await read(root, plan.backup);
    if (backup !== plan.before) {
      await link(await safePath(root, plan.backup), await safePath(root, plan.from)).catch(() => {});
      throw Error(`File edited during move; preserved at ${plan.backup}`);
    }
  } else if (backup !== plan.before || source !== null) {
    throw Error(`Move source changed or reappeared: ${plan.from}; backup retained at ${plan.backup}`);
  }
  if (destination === null && !await installFile(root, plan.to, plan.after, null, plan.id)) throw Error(`Move destination appeared: ${plan.to}`);
  state.notebookPaths = plan.notebookPaths;
  state.entries[plan.id] = plan.entry;
  await save(root, state);
  await unlink(await safePath(root, moveJournal));
}

export async function moveNote(root, state, plan, save) {
  if (await read(root, plan.to) !== null) throw Error(`Move destination occupied: ${plan.to}`);
  plan.notebookPaths = state.notebookPaths;
  plan.backup = `.edgeever/history/moves/${randomUUID()}.md`;
  await atomic(root, moveJournal, JSON.stringify(plan, null, 2));
  await resumeMove(root, state, save);
}

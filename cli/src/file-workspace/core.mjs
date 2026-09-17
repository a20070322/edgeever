import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import { hash, safeName, safePath, read, atomic, installFile } from './files.mjs';
export { hash, safePath } from './files.mjs';
import { attachmentContext, normalizeRemote, relocateAttachments } from './attachments.mjs';

import { decodeNote, encodeNote } from './metadata.mjs';
import { scanNotes, availablePath, notebookDirectory } from './layout.mjs';
import { migrateWorkspace } from './migration.mjs';
import { moveNote, resumeMove, moveJournal } from './moves.mjs';
import { mergeText, hasConflictMarkers } from './merge.mjs';

async function locked(root, fn) {
  await safePath(root);
  await mkdir(await safePath(root, '.edgeever'), { recursive: true, mode: 0o700 });
  const path = await safePath(root, '.edgeever/lock');
  const lock = await open(path, 'wx', 0o600).catch(e => { if (e.code === 'EEXIST') throw Error('Workspace is locked. If a previous process crashed, verify it exited before removing .edgeever/lock.'); throw e; });
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await fn(); }
  finally { await lock.close(); await unlink(path); }
}
async function load(root) {
  const text = await read(root, '.edgeever/state.json');
  if (!text) throw Error('Not linked. Run workspace link first.');
  const state = JSON.parse(text);
  if (![1, 2, 3].includes(state.version) || !state.entries || !state.scope) throw Error('Unsupported workspace state');
  return state;
}
const save = async (root, state) => {
  if (state.version === 1) {
    const old = await read(root, '.edgeever/state.json');
    if (old && !await read(root, '.edgeever/state-v1.backup.json')) await atomic(root, '.edgeever/state-v1.backup.json', old);
    state.version = 2;
  }
  return atomic(root, '.edgeever/state.json', JSON.stringify(state, null, 2) + '\n');
};
export function selectNotebooks(notebooks, scope) {
  const map = new Map(notebooks.map(n => [n.id, n]));
  for (const id of [...scope.include, ...scope.exclude]) if (!map.has(id)) throw Error(`Notebook not found: ${id}`);
  const descends = (id, roots, recursive) => {
    const seen = new Set();
    while (id && !seen.has(id)) {
      if (roots.includes(id)) return true;
      seen.add(id); id = recursive ? map.get(id)?.parentId : null;
    }
    return false;
  };
  return new Set(notebooks.filter(n => (scope.all || descends(n.id, scope.include, scope.recursive)) && !descends(n.id, scope.exclude, true)).map(n => n.id));
}
async function identity(client, state) {
  const info = await client.request('/api/v1/file-workspace');
  if (info.protocolVersion !== 1 || info.atomicRevisionWrites !== true || info.attachmentSync !== true) throw Error('Server lacks atomic file-workspace/attachment support; upgrade before syncing.');
  if (state && (state.url !== client.baseUrl || state.workspaceId !== info.workspaceId)) throw Error('Server/workspace mismatch. Refusing to mix accounts.');
  return info;
}
export async function link(root, client, scope, replace = false) {
  return locked(root, async () => {
    const info = await identity(client);
    if (!scope.all && !scope.include.length) throw Error('Choose --all or --notebooks id1,id2');
    if (scope.all && scope.include.length) throw Error('--all and --notebooks are mutually exclusive');
    const { notebooks } = await client.request('/api/v1/notebooks');
    const selected = selectNotebooks(notebooks, scope);
    let state;
    if (await read(root, '.edgeever/state.json')) {
      if (!replace) throw Error('Already linked. Use --replace-scope to change selection without deleting files.');
      state = await load(root); await identity(client, state); await requireV3(root, state);
    } else state = { version: 3, url: client.baseUrl, workspaceId: info.workspaceId, entries: {} };
    state.scope = scope;
    await save(root, state);
    return { linked: true, notebooks: selected.size, directory: resolve(root), next: 'workspace sync' };
  });
}
async function requireV3(root, state, allowPendingMove = false) {
  if (!allowPendingMove && await read(root, moveJournal)) throw Error("Pending move: run workspace sync to resume first");
  if (state.version !== 3 || await read(root, '.edgeever/migration-v3.json')) throw Error('Run workspace migrate first (use --dry-run to preview); old files and baselines will be backed up.');
}
async function localStatus(root, state) {
  if (await read(root, moveJournal)) return [{ status: 'move-recovery-required', next: 'workspace sync' }];
  if (state.version !== 3 || await read(root, '.edgeever/migration-v3.json')) return [{ status: 'migration-required', version: state.version }];
  const scan = await scanNotes(root, state);
  const results = [...scan.problems];
  for (const [id, entry] of Object.entries(state.entries)) {
    if (scan.blocked.has(id)) continue;
    const note = scan.ids.get(id)?.[0];
    if (!note) continue;
    let name = 'clean';
    try {
      const body = await relocateAttachments(root, note.body, entry.path, note.path, true);
      const planned = await attachmentContext(root, { baseUrl: state.url }, state, async () => {}, true).prepare(body, note.path, id);
      if (planned.content !== await normalizeRemote(entry.serverBase ?? entry.base, state.url)) name = 'modified';
      else if (note.path !== entry.path) name = 'moved';
    } catch { name = 'attachment-error'; }
    if (state.conflicts?.[id]) name = 'conflict';
    results.push({ id, path: note.path, status: name, ...(note.path !== entry.path ? { previousPath: entry.path } : {}) });
  }
  return results;
}
export const status = async root => localStatus(root, await load(root));

export async function migrate(root, client, options = {}) {
  return locked(root, async () => {
    const state = await load(root); await identity(client, state);
    return migrateWorkspace(root, state, options);
  });
}

async function locate(root, state, scan, id, dryRun) {
  const entry = state.entries[id], note = scan.ids.get(id)?.[0];
  if (!entry || !note || scan.blocked.has(id)) throw Error('Cannot locate a unique bound memo');
  let body = note.body;
  if (note.path !== entry.path) {
    body = await relocateAttachments(root, body, entry.path, note.path, true);
    const base = await relocateAttachments(root, entry.base, entry.path, note.path);
    // Validate rebased attachment links before committing the new mapping.
    await attachmentContext(root, { baseUrl: state.url }, state, async () => {}, true).prepare(body, note.path, id);
    if (!dryRun && body !== note.body && !await installFile(root, note.path, encodeNote(body, id), note.raw, id)) throw Error('Local file changed while repairing moved attachment links');
    entry.localPathOverride = true;
    entry.path = note.path; entry.base = base; entry.hash = hash(base);
    if (!dryRun) await save(root, state);
  }
  return { body, raw: body === note.body ? note.raw : encodeNote(body, id), path: note.path };
}
async function snapshot(client, selected) {
  const memos = new Map();
  for (const notebookId of selected) {
    let cursor; const seen = new Set();
    do {
      const params = new URLSearchParams({ notebookId, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const page = await client.request(`/api/v1/memos?${params}`);
      for (const memo of page.memos) if (selected.has(memo.notebookId)) memos.set(memo.id, memo);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw Error('Repeated pagination cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return memos;
}
const isDiagram = body => /edgeever.diagram|edgeever-diagram/i.test(body);

export async function sync(root, client, { dryRun = false, pullOnly = false, autoMerge = false } = {}) {
  return locked(root, async () => {
    const state = await load(root); await identity(client, state); await requireV3(root, state, true);
    if (await read(root, moveJournal)) {
      if (dryRun) throw Error('Pending move: run workspace sync without --dry-run to resume');
      await resumeMove(root, state, save);
    }
    const scan = await scanNotes(root, state);
    const moves = new Map();
    const attachments = attachmentContext(root, client, state, () => save(root,state), dryRun);
    const { notebooks } = await client.request('/api/v1/notebooks');
    const selected = selectNotebooks(notebooks, state.scope);
    const remote = await snapshot(client, selected);
    const results = [...scan.problems];
    const reserved = new Set();
    // Out-of-scope and remote-deleted notes are retained, never uploaded or deleted.
    for (const [id, entry] of Object.entries(state.entries)) if (!remote.has(id)) results.push({ id, path: entry.path, status: 'outside-snapshot-retained' });
    for (const id of remote.keys()) {
      if (scan.blocked.has(id)) continue;
      const { memo } = await client.request(`/api/v1/memos/${encodeURIComponent(id)}`);
      if (!selected.has(memo.notebookId) || memo.isDeleted) continue;
      let entry = state.entries[id];
      let path, local, localRaw;
      if (entry) {
        try {
          const located = await locate(root, state, scan, id, dryRun);
          path = located.path; local = located.body; localRaw = located.raw;
          // v0.3 may already have updated notebookId while retaining the old path.
          // Reconcile managed directories too; preserve explicit local relocation.
          const managed = !entry.localPathOverride && (memo.notebookId !== entry.notebookId || Object.values(state.notebookPaths || {}).includes(posix.dirname(path)));
          if (managed) {
            const directory = await notebookDirectory(root, memo.notebookId, notebooks, state, reserved);
            if (directory !== posix.dirname(path)) {
              const target = await availablePath(root, posix.join(directory, posix.basename(path)), reserved);
              const body = await relocateAttachments(root, local, path, target);
              const base = await relocateAttachments(root, entry.base, path, target);
              await attachments.prepare(body, target, id);
              const nextEntry = { ...entry, path: target, notebookId: memo.notebookId, base, hash: hash(base) };
              const after = encodeNote(body, id);
              if (!dryRun) await moveNote(root, state, { id, from: path, to: target, before: localRaw, after, entry: nextEntry }, save);
              moves.set(id, { from: path, to: target });
              state.entries[id] = nextEntry; entry = nextEntry;
              path = target; local = body; localRaw = after;
            }
          }
        } catch (error) {
          // Never start another move while a saved plan needs recovery.
          if (await read(root, moveJournal)) throw error;
          results.push({ id, path: entry.path, status: 'attachment-error', error: error.message }); continue;
        }
      } else {
        const directory = await notebookDirectory(root, memo.notebookId, notebooks, state, reserved);
        path = await availablePath(root, posix.join(directory, `${safeName(memo.title || 'untitled')}.md`), reserved);
        localRaw = await read(root, path); local = null;
        if (localRaw !== null) { results.push({ id, path, status: 'path-occupied' }); continue; }
      }
      const remoteBody = memo.contentMarkdown;
      if (typeof remoteBody !== 'string' || !Number.isInteger(memo.revision)) throw Error('Invalid memo response');
      // Refuse a reserved server metadata key before downloading or uploading attachments.
      try { encodeNote(remoteBody, id); } catch (error) { results.push({ id, path, status: 'metadata-error', error: error.message }); continue; }
      let planned;
      try { planned = entry ? await attachments.prepare(local,path,id) : null; }
      catch (error) { results.push({ id, path, status: 'attachment-error', error: error.message }); continue; }
      const baseline = entry ? await normalizeRemote(entry.serverBase ?? entry.base, client.baseUrl) : null;
      const normalizedRemote = await normalizeRemote(remoteBody,client.baseUrl);
      let localChanged = entry && (hash(local) !== entry.hash || planned.content !== baseline);
      let remoteChanged = entry && (memo.revision !== entry.revision || hash(remoteBody) !== (entry.serverHash ?? entry.hash));
      const record = (body, revision, serverBody) => { state.entries[id] = { ...(entry?.localPathOverride ? { localPathOverride: true } : {}), path, notebookId: memo.notebookId, revision, hash: hash(body), base: body, serverHash:hash(serverBody),serverBase:serverBody }; };
      if (entry && hasConflictMarkers(local)) { results.push({ id, path, status: 'unresolved-markers' }); continue; }
      if (state.conflicts?.[id]) { results.push({ id, path, status: 'conflict', ...state.conflicts[id], next: 'Edit draft, then resolve --continue; or resolve --use merge to refresh' }); continue; }
      if (autoMerge && localChanged && remoteChanged && planned.content !== normalizedRemote && !isDiagram(remoteBody)) {
        const projected = await attachments.project(remoteBody, path, { preferRemote: true });
        const merged = mergeText(entry.base, local, projected);
        if (!merged.conflicts && !planned.pending && !hasConflictMarkers(merged.content)) {
          if (dryRun) { results.push({ id, path, status: pullOnly ? 'would-merge-local' : 'would-merge-push' }); continue; }
          const raw = encodeNote(merged.content, id);
          if (!await installFile(root, path, raw, localRaw, id)) { results.push({ id, path, status: 'local-changed-during-sync' }); continue; }
          // Persist the remote baseline, not the merged body: a retry must still
          // see an unsent local edit if upload fails or the process stops.
          entry = { ...entry, revision: memo.revision, base: projected, hash: hash(projected), serverBase: remoteBody, serverHash: hash(remoteBody) };
          state.entries[id] = entry; await save(root, state);
          local = merged.content; localRaw = raw; planned = await attachments.prepare(local, path, id);
          localChanged = true; remoteChanged = false;
          if (pullOnly) { results.push({ id, path, status: 'merged-local' }); continue; }
        }
      }
      if (localChanged && planned.content !== normalizedRemote) {
        if (remoteChanged || isDiagram(remoteBody)) {
          const conflictPath = `.edgeever/conflicts/${hash(id)}/${memo.revision}-${hash(remoteBody).slice(0, 16)}.remote.md`;
          let draft;
          if (!dryRun) {
            await atomic(root, conflictPath, remoteBody);
            if (!isDiagram(remoteBody)) draft = await createConflict(root, state, attachments, id, memo, localRaw, planned);
          }
          results.push({ id, path, status: isDiagram(remoteBody) ? 'diagram-read-only' : 'conflict', remoteCopy: conflictPath, ...draft });
          continue;
        }
        if (pullOnly) { results.push({ id, path, status: 'modified' }); continue; }
        if (!dryRun) {
          // A session binds the API write to the version observed here.
          const { editSession } = await client.request(`/api/v1/memos/${encodeURIComponent(id)}/edit-sessions`, { method: 'POST' });
          if (editSession.baseRevision !== entry.revision || editSession.baseContentHash !== memo.contentHash) {
            results.push({ id, path, status: 'conflict' }); continue;
          }
          try {
            const submitted = await attachments.prepare(local,path,id,true);
            const { memo: updated } = await client.request(`/api/v1/memos/${encodeURIComponent(id)}`, { method: 'PATCH', body: {
              contentMarkdown: submitted.content, expectedRevision: entry.revision,
              expectedContentHash: editSession.baseContentHash, editSessionId: editSession.id,
            } });
            record(local, updated.revision, updated.contentMarkdown); await save(root, state);
          } catch (e) {
            if ([409, 428].includes(e.status)) { results.push({ id, path, status: 'conflict', error: e.message }); continue; }
            throw e;
          }
        }
        results.push({ id, path, status: dryRun ? 'would-push' : 'pushed' });
      } else {
        const projected = await attachments.project(remoteBody,path);
        const projectedRaw = encodeNote(projected, id);
        if (!dryRun) {
          if (localRaw !== projectedRaw) {
            // Preserve the actual file before replacing it, including a late local edit.
            const latest = await read(root, path);
            if (latest !== localRaw) { results.push({ id, path, status: 'local-changed-during-sync' }); continue; }
            if (!await installFile(root, path, projectedRaw, localRaw, id)) {
              results.push({ id, path, status: 'local-changed-during-sync' }); continue;
            }
          }
          record(projected, memo.revision, remoteBody); await save(root, state);
        }
        results.push({ id, path, status: localRaw === projectedRaw ? 'clean' : dryRun ? 'would-pull' : 'pulled' });
      }
    }
    return { dryRun, results: results.map(result => {
      const move = moves.get(result.id);
      return move ? { ...result, move, status: result.status === 'clean' ? (dryRun ? 'would-move' : 'moved') : result.status } : result;
    }) };
  });
}

// Drafts are independent from tracked files and are never overwritten by sync.
async function createConflict(root, state, attachments, id, memo, localRaw, planned, refresh = false) {
  state.conflicts ??= {};
  if (state.conflicts[id] && !refresh) return state.conflicts[id];
  const entry = state.entries[id];
  const remote = await attachments.project(memo.contentMarkdown, entry.path, { preferRemote: true });
  const local = decodeNote(localRaw).body;
  const merge = mergeText(entry.base, local, remote);
  const directory = `.edgeever/conflicts/${hash(id)}/${randomUUID()}`;
  const draft = `${directory}/merge.md`;
  const context = { path: entry.path, localRaw, localContent: planned.content, revision: memo.revision, remoteHash: hash(memo.contentMarkdown), notebookId: memo.notebookId, remote, serverBody: memo.contentMarkdown };
  for (const [name, body] of Object.entries({ 'base.md': entry.base, 'local.md': local, 'remote.md': remote, 'merge.md': merge.content, 'context.json': JSON.stringify(context, null, 2) })) await atomic(root, `${directory}/${name}`, body);
  const record = { draft, context: `${directory}/context.json`, overlaps: merge.conflicts, binaryPending: planned.pending > 0 };
  state.conflicts[id] = record; await save(root, state);
  return record;
}
export async function conflicts(root) {
  const state = await load(root);
  return Object.entries(state.conflicts || {}).map(([id, record]) => ({ id, path: state.entries[id]?.path, ...record }));
}
async function continueConflict(root, state, attachments, id, memo, localRaw) {
  const record = state.conflicts?.[id]; if (!record) throw Error('No active merge draft; run resolve --use merge');
  const context = JSON.parse(await read(root, record.context));
  const entry = state.entries[id];
  if (entry.path !== context.path || localRaw !== context.localRaw) throw Error('Local file changed since draft; run resolve --use merge to refresh (old draft is retained)');
  if (memo.revision !== context.revision || hash(memo.contentMarkdown) !== context.remoteHash || memo.notebookId !== context.notebookId) throw Error('Remote changed since draft; run resolve --use merge to refresh');
  const current = await attachments.prepare(decodeNote(localRaw).body, entry.path, id);
  if (current.content !== context.localContent) throw Error('Local attachment changed since draft; refresh the merge');
  const body = await read(root, record.draft);
  if (body === null || hasConflictMarkers(body)) throw Error('Missing draft or unresolved conflict markers');
  const raw = encodeNote(body, id); // Reject managed metadata accidentally pasted into a draft.
  await attachments.prepare(body, entry.path, id);
  if (!await installFile(root, entry.path, raw, localRaw, id)) throw Error('Local file changed during merge; history retained');
  state.entries[id] = { ...entry, revision: memo.revision, notebookId: memo.notebookId, base: context.remote, hash: hash(context.remote), serverBase: context.serverBody, serverHash: hash(context.serverBody) };
  delete state.conflicts[id]; await save(root, state);
  return { id, status: 'ready-to-push', path: entry.path, next: 'workspace sync' };
}

// Explicit resolution: preserve local text on "local", or adopt the newest remote
// on "remote". Neither option pushes; the next sync still checks server revision.
export async function resolveConflict(root, client, id, choice) {
  if (!['local', 'remote', 'merge', 'continue'].includes(choice)) throw Error('Choose --use local|remote|merge or --continue');
  return locked(root, async () => {
    const state = await load(root); await identity(client, state);
    await requireV3(root, state);
    const entry = state.entries[id]; if (!entry) throw Error('Memo is not tracked');
    const scan = await scanNotes(root, state);
    if (scan.blocked.has(id) && scan.blocked.get(id).status !== 'missing-local') throw Error(`Cannot resolve: ${scan.blocked.get(id).status}`);
    if (scan.ids.has(id)) await locate(root, state, scan, id, false);
    const { notebooks } = await client.request('/api/v1/notebooks');
    const selected = selectNotebooks(notebooks, state.scope);
    const { memo } = await client.request(`/api/v1/memos/${encodeURIComponent(id)}`);
    if (!selected.has(memo.notebookId) || memo.isDeleted) throw Error('Memo is no longer in selected scope');
    const local = await read(root, entry.path);
    if (choice !== 'remote' && local === null) throw Error('Local file missing');
    if (choice !== 'remote' && isDiagram(memo.contentMarkdown)) throw Error('Diagram content is read-only');
    const attachments = attachmentContext(root,client,state,()=>save(root,state));
    if (choice === 'merge') {
      const planned = await attachments.prepare(decodeNote(local).body, entry.path, id);
      return { id, status: 'merge-draft', ...await createConflict(root, state, attachments, id, memo, local, planned, true) };
    }
    if (choice === 'continue') return continueConflict(root, state, attachments, id, memo, local);
    if (choice === 'local' && hasConflictMarkers(decodeNote(local).body)) throw Error('Unresolved conflict markers');
    const projected = await attachments.project(memo.contentMarkdown,entry.path,{preferRemote:choice === "remote"});
    if (choice === 'remote' && !await installFile(root, entry.path, encodeNote(projected, id), local, id)) throw Error('Local file changed during resolution; preserved in history');
    if (choice === 'local') await atomic(root, `.edgeever/conflicts/${hash(id)}/${memo.revision}-${hash(memo.contentMarkdown).slice(0,16)}.remote.md`, memo.contentMarkdown);
    state.entries[id] = { ...entry, notebookId: memo.notebookId, revision: memo.revision, base: projected, hash: hash(projected),serverBase:memo.contentMarkdown,serverHash:hash(memo.contentMarkdown) };
    if (state.conflicts) delete state.conflicts[id];
    await save(root,state);
    return { id, choice, status: choice === 'local' ? 'ready-to-push' : 'resolved' };
  });
}

export async function uploads(root) {
  const state=await load(root);
  return Object.entries(state.uploads || {}).map(([key,value])=>({key,path:value.path,memoId:value.memoId,status:value.status,resourceId:value.resource?.id}));
}
// Explicit operator action after checking an uncertain request has finished.
// Preserve the original journal before authorizing a new upload attempt.
export async function retryUpload(root,client,key) {
  return locked(root,async()=>{
    const state=await load(root);await identity(client,state);
    const upload=state.uploads?.[key];
    if (!upload || upload.status!=='uploading') throw Error('Only an uncertain upload can be authorized for retry');
    await atomic(root,`.edgeever/history/upload-${hash(key)}-${randomUUID()}.json`,JSON.stringify(upload));
    upload.status='retry-authorized';await save(root,state);
    return {key,status:'retry-authorized',next:'Run sync after confirming the original request is no longer running'};
  });
}

// Explicit create/bind. Persist the intent before POST so a lost response never
// causes an automatic second create. --memo reconciles a user-confirmed receipt.
export async function importFile(root, client, { file, notebookId, title, memoId } = {}) {
  return locked(root, async () => {
    const state = await load(root); await identity(client, state); await requireV3(root, state);
    if (!file || !notebookId) throw Error('Import requires --file and --notebook');
    const { relative } = await import('node:path');
    const path = relative(resolve(root), resolve(root, file)).split('\\').join('/');
    if (!/\.md$/i.test(path) || path === '.edgeever' || path.startsWith('.edgeever/')) throw Error('Import requires a Markdown file outside .edgeever');
    await safePath(root, path);
    const diskRaw = await read(root, path); if (diskRaw === null) throw Error('Import file does not exist');
    const decoded = decodeNote(diskRaw);
    state.imports ??= {};
    const key = hash(path); let receipt = state.imports[key];
    if (Object.values(state.entries).some(e => e.path === path)) throw Error('File is tracked; use sync');
    if (decoded.id && (receipt?.memoId !== decoded.id || receipt?.hash !== hash(decoded.body))) throw Error('File has an unrecognized ID; cannot import');
    const raw = decoded.id ? decoded.body : diskRaw;
    const { notebooks } = await client.request('/api/v1/notebooks');
    if (!selectNotebooks(notebooks, state.scope).has(notebookId)) throw Error('Notebook is outside the linked scope');
    const plan = await attachmentContext(root, client, state, async () => {}, true).prepare(raw, path, 'import');
    if (plan.pending) throw Error('Import does not upload new local attachments. Import the text first, then add attachments and sync.');
    if (receipt && receipt.hash !== hash(raw)) throw Error('Import source changed after a create attempt; restore the original file before reconciling');
    if (memoId && receipt?.memoId && receipt.memoId !== memoId) throw Error('Specified memo does not match the saved create receipt');
    if (receipt?.notebookId && receipt.notebookId !== notebookId) throw Error('Import notebook does not match the saved intent');
    let memo;
    if (memoId || receipt?.memoId) {
      memo = (await client.request(`/api/v1/memos/${encodeURIComponent(memoId || receipt.memoId)}`)).memo;
    } else {
      if (receipt) throw Error('Create outcome uncertain. Check the server; rerun import with --memo <confirmed-id>. Do not blindly create again.');
      receipt = { path, hash: hash(raw), notebookId, title: title || posix.basename(path, posix.extname(path)), status: 'creating' };
      state.imports[key] = receipt; await save(root, state);
      try {
        memo = (await client.request('/api/v1/memos', { method: 'POST', body: { notebookId, title: receipt.title, contentMarkdown: plan.content } })).memo;
      } catch (error) {
        // Definitive validation/auth rejection cannot have created a note.
        if ([400,401,403,404,413,415,422,429].includes(error.status)) { delete state.imports[key]; await save(root, state); }
        throw error;
      }
      if (!memo?.id) throw Error('Create returned no memo ID; reconcile with --memo');
      receipt.memoId = memo.id; receipt.status = 'created'; await save(root, state);
    }
    if (memo.notebookId !== notebookId || memo.isDeleted || typeof memo.contentMarkdown !== 'string' || !Number.isInteger(memo.revision)) throw Error('Invalid memo receipt or notebook mismatch');
    if (state.entries[memo.id]) throw Error('Memo is already bound to another local file');
    if (await normalizeRemote(memo.contentMarkdown, client.baseUrl) !== plan.content) throw Error(`Memo ${memo.id} content differs from the import source; preserved both copies`);
    const scan = await scanNotes(root, state);
    if (scan.ids.get(memo.id)?.some(note => note.path !== path)) throw Error('Memo ID already appears in a local file');
    // Save the binding intent before touching the file, enabling interrupted-import recovery.
    state.imports[key] = { ...receipt, path, hash: hash(raw), notebookId, memoId: memo.id, status: 'created' };
    await save(root, state);
    if (!await installFile(root, path, encodeNote(raw, memo.id), diskRaw, memo.id)) throw Error(`Import source changed; remote memo ${memo.id} retained for reconciliation`);
    state.entries[memo.id] = { localPathOverride: true, path, notebookId, revision: memo.revision, base: raw, hash: hash(raw), serverBase: memo.contentMarkdown, serverHash: hash(memo.contentMarkdown) };
    state.imports[key].status = 'bound'; await save(root, state);
    return { id: memo.id, path, status: 'imported' };
  });
}

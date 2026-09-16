import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { resolve, posix } from 'node:path';
import { hash, part, safePath, read, atomic, installFile } from './files.mjs';
export { hash, safePath } from './files.mjs';
import { attachmentContext, normalizeRemote } from './attachments.mjs';

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
  if (![1, 2].includes(state.version) || !state.entries || !state.scope) throw Error('Unsupported workspace state');
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
      state = await load(root); await identity(client, state);
    } else state = { version: 1, url: client.baseUrl, workspaceId: info.workspaceId, entries: {} };
    state.scope = scope;
    await save(root, state);
    return { linked: true, notebooks: selected.size, directory: resolve(root), next: 'workspace sync' };
  });
}
async function localStatus(root, state) {
  const results = [];
  const tracked = new Set();
  for (const [id, entry] of Object.entries(state.entries)) {
    tracked.add(entry.path);
    const content = await read(root, entry.path);
    let stateName = content === null ? 'missing-local' : hash(content) !== entry.hash ? 'modified' : 'clean';
    if (content !== null) {
      try {
        const planned = await attachmentContext(root,{baseUrl:state.url},state,async()=>{},true).prepare(content,entry.path,id);
        if (planned.content !== await normalizeRemote(entry.serverBase ?? entry.base,state.url)) stateName = 'modified';
      } catch (e) { stateName = 'attachment-error'; }
    }
    results.push({ id, path: entry.path, status: stateName });
  }
  async function walk(dir = '') {
    for (const item of await readdir(await safePath(root, dir), { withFileTypes: true })) {
      if (item.name === '.edgeever') continue;
      const path = posix.join(dir, item.name);
      if (item.isSymbolicLink()) throw Error(`Symlink is not allowed: ${path}`);
      if (item.isDirectory()) await walk(path);
      else if (/\.md$/i.test(path) && !tracked.has(path)) results.push({ path, status: 'untracked' });
    }
  }
  await walk(); return results;
}
export const status = async root => localStatus(root, await load(root));

function notebookPath(id, notebooks) {
  const map = new Map(notebooks.map(n => [n.id, n]));
  const parts = [], seen = new Set();
  while (id && map.has(id)) {
    if (seen.has(id)) throw Error('Notebook cycle');
    seen.add(id); const n = map.get(id); parts.unshift(part(n.name, id)); id = n.parentId;
  }
  return parts.join('/');
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

export async function sync(root, client, { dryRun = false, pullOnly = false } = {}) {
  return locked(root, async () => {
    const state = await load(root); await identity(client, state);
    const attachments = attachmentContext(root, client, state, () => save(root,state), dryRun);
    const { notebooks } = await client.request('/api/v1/notebooks');
    const selected = selectNotebooks(notebooks, state.scope);
    const remote = await snapshot(client, selected);
    const results = [];
    // Out-of-scope and remote-deleted notes are retained, never uploaded or deleted.
    for (const [id, entry] of Object.entries(state.entries)) if (!remote.has(id)) results.push({ id, path: entry.path, status: 'outside-snapshot-retained' });
    for (const id of remote.keys()) {
      const { memo } = await client.request(`/api/v1/memos/${encodeURIComponent(id)}`);
      if (!selected.has(memo.notebookId) || memo.isDeleted) continue;
      let entry = state.entries[id];
      const path = entry?.path ?? posix.join(notebookPath(memo.notebookId, notebooks), `${part(memo.title || 'untitled', id)}.md`);
      const local = await read(root, path);
      if (!entry && local !== null) { results.push({ id, path, status: 'path-occupied' }); continue; }
      if (entry && local === null) { results.push({ id, path, status: 'missing-local' }); continue; }
      const remoteBody = memo.contentMarkdown;
      if (typeof remoteBody !== 'string' || !Number.isInteger(memo.revision)) throw Error('Invalid memo response');
      const planned = entry ? await attachments.prepare(local,path,id) : null;
      const baseline = entry ? await normalizeRemote(entry.serverBase ?? entry.base, client.baseUrl) : null;
      const normalizedRemote = await normalizeRemote(remoteBody,client.baseUrl);
      const localChanged = entry && (hash(local) !== entry.hash || planned.content !== baseline);
      const remoteChanged = entry && (memo.revision !== entry.revision || hash(remoteBody) !== (entry.serverHash ?? entry.hash));
      const record = (body, revision, serverBody) => { state.entries[id] = { path, notebookId: memo.notebookId, revision, hash: hash(body), base: body, serverHash:hash(serverBody),serverBase:serverBody }; };
      if (localChanged && planned.content !== normalizedRemote) {
        if (remoteChanged || isDiagram(remoteBody)) {
          const conflictPath = `.edgeever/conflicts/${hash(id)}/${memo.revision}-${hash(remoteBody).slice(0, 16)}.remote.md`;
          if (!dryRun) await atomic(root, conflictPath, remoteBody);
          results.push({ id, path, status: isDiagram(remoteBody) ? 'diagram-read-only' : 'conflict', remoteCopy: conflictPath });
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
        if (!dryRun) {
          if (local !== projected) {
            // Preserve the actual file before replacing it, including a late local edit.
            const latest = await read(root, path);
            if (latest !== local) { results.push({ id, path, status: 'local-changed-during-sync' }); continue; }
            if (!await installFile(root, path, projected, local, id)) {
              results.push({ id, path, status: 'local-changed-during-sync' }); continue;
            }
          }
          record(projected, memo.revision, remoteBody); await save(root, state);
        }
        results.push({ id, path, status: local === projected ? 'clean' : dryRun ? 'would-pull' : 'pulled' });
      }
    }
    return { dryRun, results };
  });
}

// Explicit resolution: preserve local text on "local", or adopt the newest remote
// on "remote". Neither option pushes; the next sync still checks server revision.
export async function resolveConflict(root, client, id, choice) {
  if (!['local', 'remote'].includes(choice)) throw Error('--use must be local or remote');
  return locked(root, async () => {
    const state = await load(root); await identity(client, state);
    const entry = state.entries[id]; if (!entry) throw Error('Memo is not tracked');
    const { notebooks } = await client.request('/api/v1/notebooks');
    const selected = selectNotebooks(notebooks, state.scope);
    const { memo } = await client.request(`/api/v1/memos/${encodeURIComponent(id)}`);
    if (!selected.has(memo.notebookId) || memo.isDeleted) throw Error('Memo is no longer in selected scope');
    const local = await read(root, entry.path);
    if (choice === 'local' && local === null) throw Error('Local file missing');
    if (choice === 'local' && isDiagram(memo.contentMarkdown)) throw Error('Diagram content is read-only');
    const attachments = attachmentContext(root,client,state,()=>save(root,state));
    const projected = await attachments.project(memo.contentMarkdown,entry.path,{preferRemote:choice === "remote"});
    if (choice === 'remote' && !await installFile(root, entry.path, projected, local, id)) throw Error('Local file changed during resolution; preserved in history');
    if (choice === 'local') await atomic(root, `.edgeever/conflicts/${hash(id)}/${memo.revision}-${hash(memo.contentMarkdown).slice(0,16)}.remote.md`, memo.contentMarkdown);
    state.entries[id] = { ...entry, notebookId: memo.notebookId, revision: memo.revision, base: projected, hash: hash(projected),serverBase:memo.contentMarkdown,serverHash:hash(memo.contentMarkdown) };
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

import { mkdir, open, unlink } from 'node:fs/promises';
import { hash, read, atomic, safePath } from './file-workspace/files.mjs';

export async function createNotebook(client, options, journalDirectory) {
  const { name, path, parent, parents = false, dryRun = false, retryUncertain = false } = options;
  if (!!name === !!path) throw Error('Choose exactly one of --name or --path');
  if (parents && !path) throw Error('--parents requires --path');
  const segments = path ? path.split('/').map(s => s.trim()) : [name.trim()];
  if (segments.some(s => !s || s === '.' || s === '..' || s.length > 80 || /[\x00-\x1f]/.test(s))) throw Error('Each name must be 1–80 characters; empty, dot and control-character path segments are invalid');
  if (parent !== undefined && !parent.trim()) throw Error('--parent requires an ID');
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const key = hash(client.baseUrl), lockPath = await safePath(journalDirectory, `${key}.lock`);
  const lock = await open(lockPath, 'wx', 0o600).catch(e => { if(e.code === 'EEXIST') throw Error('Notebook creation is locked; verify the previous process exited before removing its lock'); throw e; });
  const journal = `${key}.json`, steps = [];
  let pending;
  try {
    pending = JSON.parse(await read(journalDirectory, journal) || 'null');
    let { notebooks } = await client.request('/api/v1/notebooks');
    if (parent && !notebooks.some(n => n.id === parent)) throw Error('Parent notebook not found');
    let parentId = parent || null;
    // Preflight all existing ancestors before any write.
    let probe = parentId;
    for (let i = 0; i < segments.length; i++) {
      const matches = notebooks.filter(n => (n.parentId ?? null) === probe && n.name === segments[i]);
      if(matches.length > 1) throw Error(`Ambiguous notebook: ${segments[i]}; select a specific --parent ID`);
      if(!matches.length) {
        if(!parents && i < segments.length - 1) throw Error(`Missing ancestor: ${segments[i]}; use --parents`);
        break;
      }
      probe = matches[0].id;
    }
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (!dryRun) ({ notebooks } = await client.request('/api/v1/notebooks'));
      const matches = parentId?.startsWith('planned:') ? [] : notebooks.filter(n => (n.parentId ?? null) === parentId && n.name === segment);
      if (matches.length > 1) throw Error(`Ambiguous notebook: ${segment}; use an explicit ID`);
      if (matches.length === 1) {
        if (!dryRun && pending?.parentId === parentId && pending.name === segment) { await atomic(journalDirectory, journal, 'null'); pending = null; }
        const notebook = matches[0];steps.push({ status: 'reused', id: notebook.id, name: segment, parentId });parentId = notebook.id;continue;
      }
      if (!parents && index < segments.length - 1) throw Error(`Missing ancestor: ${segment}; use --parents`);
      if (pending) {
        if (!dryRun && retryUncertain && pending.parentId === parentId && pending.name === segment) {
          await atomic(journalDirectory, `${key}.${Date.now()}.previous.json`, JSON.stringify(pending));
          await atomic(journalDirectory, journal, 'null');pending = null;
        } else return { status: 'uncertain', steps, pending, journal: await safePath(journalDirectory, journal), message: 'A previous create may still complete. Inspect the server before retrying; --retry-uncertain is only for a confirmed failed request.' };
      }
      if (dryRun) { steps.push({ status: 'would-create', name: segment, parentId: parentId?.startsWith('planned:') ? null : parentId, parentPath: segments.slice(0,index).join('/') }); parentId = `planned:${index}`;continue; }
      pending = { name: segment, parentId };
      await atomic(journalDirectory, journal, JSON.stringify(pending));
      let notebook;
      try {
        ({ notebook } = await client.request('/api/v1/notebooks', { method: 'POST', body: pending }));
        if (!notebook?.id || notebook.name !== segment || (notebook.parentId ?? null) !== parentId) throw Error('Invalid create response');
      } catch(error) {
        if ([400,401,403,404,413,415,422,429].includes(error.status)) { await atomic(journalDirectory, journal, 'null'); pending = null;throw error; }
        return { status: 'uncertain', steps, pending, journal: await safePath(journalDirectory, journal), message: 'Create outcome uncertain. Inspect notebooks and rerun to reuse a visible unique result; do not blindly create again.' };
      }
      steps.push({ status: 'created', id: notebook.id, name: segment, parentId });
      parentId = notebook.id;await atomic(journalDirectory, journal, 'null');pending = null;
    }
    return { status: dryRun ? 'preview' : 'complete', notebookId: parentId?.startsWith('planned:') ? null : parentId, steps };
  } catch(error) { return { status: 'failed', steps, message: error.message }; }
  finally { await lock.close(); await unlink(lockPath); }
}

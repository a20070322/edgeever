import { readdir, rmdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { safePath } from './files.mjs';

// notebooks must be the full workspace list, never the selected sync subset.
export async function cleanupDirectories(root, state, notebooks, dryRun = false, vacatedPaths = new Set()) {
  const live = new Set(notebooks.map(n => n.id));
  const mappings = Object.entries(state.notebookPaths || {});
  const livePaths = new Set(mappings.filter(([id]) => live.has(id)).map(([,path]) => path));
  const removed = new Set(), results = [];
  for (const [id, path] of mappings.filter(([id]) => !live.has(id)).sort((a,b) => b[1].split('/').length - a[1].split('/').length)) {
    if (!path || posix.normalize(path) !== path || path === '.' || path.startsWith('/') || path.split('/').includes('..') || path.split('/').includes('.edgeever')) throw Error('Invalid managed notebook directory');
    if (livePaths.has(path)) { results.push({ notebookId:id, path, status:'directory-retained-shared' }); continue; }
    const target = await safePath(root,path);
    let children;
    try { children = await readdir(target); }
    catch(e) { if(e.code !== 'ENOENT') throw e; if(!dryRun) delete state.notebookPaths[id]; removed.add(path); continue; }
    if (children.some(name => !removed.has(posix.join(path,name)) && !(dryRun && vacatedPaths.has(posix.join(path,name))))) { results.push({notebookId:id,path,status:'directory-retained-not-empty'}); continue; }
    if (!dryRun) {
      try { await rmdir(target); }
      catch(e) {
        if(['ENOTEMPTY','EEXIST'].includes(e.code)) { results.push({notebookId:id,path,status:'directory-retained-not-empty'}); continue; }
        if(e.code !== 'ENOENT') throw e;
      }
      delete state.notebookPaths[id];
    }
    removed.add(path);
    results.push({notebookId:id,path,status:dryRun ? 'would-remove-directory' : 'directory-removed'});
  }
  return results;
}

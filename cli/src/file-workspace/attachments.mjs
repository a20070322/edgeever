import { parser } from '@lezer/markdown';
import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { hash, safeName, safePath, installFile } from './files.mjs';

const LIMIT = 100 * 1024 * 1024;
export function markdownUrls(body) {
  const urls = [];
  parser.parse(body).iterate({ enter(node) {
    if (node.name === 'URL') {
      let from = node.from, to = node.to;
      if (body[from] === '<' && body[to - 1] === '>') { from++; to--; }
      urls.push({ from, to, url: body.slice(from, to).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1') });
    }
  } });
  return urls;
}
async function transform(body, fn) {
  const replacements = [];
  for (const ref of markdownUrls(body)) replacements.push({ ...ref, next: await fn(ref.url) });
  for (const ref of replacements.reverse()) if (ref.next !== ref.url) body = body.slice(0, ref.from) + ref.next + body.slice(ref.to);
  return body;
}
export function remoteResource(url, baseUrl) {
  let parsed;
  try { parsed = new URL(url, `${baseUrl}/`); } catch { return null; }
  if (parsed.origin !== new URL(baseUrl).origin) return null;
  const match = parsed.pathname.match(/^\/api\/v1\/resources\/([\w-]+)\/blob$/);
  return match ? { id: match[1], fragment: parsed.hash } : null;
}
export const normalizeRemote = (body, baseUrl) => transform(body, url => {
  const ref = remoteResource(url, baseUrl);
  return ref ? `/api/v1/resources/${ref.id}/blob${ref.fragment}` : url;
});
function localReference(url, notePath) {
  if (/^(?:https?:|mailto:|data:|#|\/\/)/i.test(url)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('/') || url.includes('\\')) throw Error(`Unsupported attachment path: ${url}`);
  const split = url.indexOf('#'), fragment = split >= 0 ? url.slice(split) : '';
  const path = decodeURIComponent(split >= 0 ? url.slice(0, split) : url);
  // Existing Markdown note links are not treated as binary attachments.
  if (/\.md$/i.test(path)) return null;
  return { path: posix.normalize(posix.join(posix.dirname(notePath), path)), fragment };
}
const mime = name => ({ png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',pdf:'application/pdf' })[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

export function attachmentContext(root, client, state, persist, dryRun = false) {
  state.resources ??= {};
  state.uploads ??= {};
  const metadata = new Map();
  async function bytes(path) {
    const file = await safePath(root,path);
    const info = await stat(file);
    if (!info.isFile() || info.size > LIMIT) throw Error(`Attachment must be a regular file <=100 MiB: ${path}`);
    const value = await readFile(file);
    if (value.length > LIMIT) throw Error(`Attachment exceeds 100 MiB: ${path}`);
    return value;
  }
  async function getResource(id) {
    if (!metadata.has(id)) metadata.set(id, (await client.request(`/api/v1/resources/${encodeURIComponent(id)}`)).resource);
    const r=metadata.get(id);
    if (r.id !== id || !/^[a-f\d]{64}$/i.test(r.sha256 || '') || (!Number.isSafeInteger(r.byteSize) || r.byteSize < 0 || r.byteSize > LIMIT)) throw Error('Invalid or oversized attachment metadata');
    return r;
  }
  function remember(path, resource, checksum) {
    state.resources[hash(`${path}\0${checksum}`)] = { path, sha256:checksum, resourceId:resource.id, url:`/api/v1/resources/${resource.id}/blob`, memoId:resource.memoId, filename:resource.filename };
  }
  async function project(body, notePath, { preferRemote = false } = {}) {
    return transform(body, async url => {
      const ref=remoteResource(url,client.baseUrl); if (!ref) return url;
      const r=await getResource(ref.id);
      const existing=Object.values(state.resources).reverse().find(x=>x.resourceId===r.id && x.sha256===r.sha256);
      let path=existing?.path ?? `attachments/${r.id}/${r.sha256.slice(0,16)}-${safeName(r.filename || r.id)}`;
      let target=await safePath(root,path);
      let local;
      try { local=await bytes(path); } catch(e) { if(e.code !== 'ENOENT') throw e; }
      if (preferRemote && local && hash(local)!==r.sha256) {
        path=`attachments/${r.id}/remote-${r.sha256}-${safeName(r.filename || r.id)}`;
        target=await safePath(root,path);
        try { local=await bytes(path); } catch(e) { if(e.code !== 'ENOENT') throw e; local=null; }
        if (local && hash(local)!==r.sha256) throw Error(`Remote resolution path occupied: ${path}`);
      }
      if (!existing && local && hash(local)!==r.sha256) throw Error(`Untracked attachment path is occupied: ${path}`);
      // Never overwrite a modified local attachment. Its old mapping makes it
      // detectable as a new upload even when Markdown itself has not changed.
      if (!local && !dryRun) {
        const value=await client.downloadResource(r.id, LIMIT);
        if (value.length !== r.byteSize || hash(value)!==r.sha256) throw Error(`Attachment integrity mismatch: ${r.id}`);
        // Keep user-created files in a concurrent path creation race.
        try { await stat(target); throw Error(`Attachment path appeared during download: ${path}`); }
        catch(e) { if(e.code !== 'ENOENT') throw e; }
        if (!await installFile(root,path,value,null,r.id)) throw Error(`Attachment path changed during download: ${path}`);
      }
      remember(path,r,r.sha256);
      return posix.relative(posix.dirname(notePath),path).split('/').map(x=>encodeURIComponent(x)).join('/')+ref.fragment;
    });
  }
  async function prepare(body,notePath,memoId,upload = false) {
    const plan=[];
    // Validate every local file before any upload (missing files, symlinks, size).
    for (const ref of markdownUrls(body)) {
      const remote=remoteResource(ref.url,client.baseUrl); if(remote) continue;
      const local=localReference(ref.url,notePath); if(!local) continue;
      const value=await bytes(local.path), checksum=hash(value);
      const mapped=state.resources[hash(`${local.path}\0${checksum}`)];
      plan.push({ ...ref, ...local, value, checksum, mapped });
    }
    const converted=new Map(); let pending=0;
    for (const file of plan) {
      if (file.mapped) { converted.set(file.url,file.mapped.url+file.fragment); continue; }
      pending++;
      if (!upload) { converted.set(file.url,`edgeever-pending:${file.checksum}${file.fragment}`); continue; }
      const key=hash(`${memoId}\0${file.path}\0${file.checksum}`);
      let resource=state.uploads[key]?.resource;
      if (!resource) {
        // Search the exact memo and bytes before retrying an uncertain upload.
        // This also recovers a response lost before its receipt was persisted.
        const filename=posix.basename(file.path);
        const { resources }=await client.request(`/api/v1/memos/${encodeURIComponent(memoId)}/resources`);
        resource=resources.find(r=>r.sha256===file.checksum && r.filename===filename && r.byteSize===file.value.length);
        if (!resource) {
          if (state.uploads[key]?.status === 'uploading') throw Error(`Upload outcome uncertain for ${file.path}; retry later to reconcile the server receipt. Do not blindly repeat the upload.`);
          state.uploads[key]={ path:file.path,sha256:file.checksum,memoId,status:'uploading' }; await persist();
          try { resource=(await client.uploadResource(memoId,file.value,filename,mime(filename))).resource; }
          catch (e) {
            if ([400,401,403,404,413,415,422,429].includes(e.status)) { state.uploads[key].status='rejected'; await persist(); }
            throw e;
          }
        }
        if (resource.sha256!==file.checksum || resource.memoId!==memoId) throw Error('Upload receipt mismatch');
        state.uploads[key]={ path:file.path,sha256:file.checksum,memoId,status:'uploaded',resource }; await persist();
      }
      remember(file.path,resource,file.checksum); await persist();
      converted.set(file.url,`/api/v1/resources/${resource.id}/blob${file.fragment}`);
    }
    const content=await transform(body,url=> {
      const ref=remoteResource(url,client.baseUrl);
      return converted.get(url) ?? (ref ? `/api/v1/resources/${ref.id}/blob${ref.fragment}` : url);
    });
    return { content,pending };
  }
  return { project,prepare };
}

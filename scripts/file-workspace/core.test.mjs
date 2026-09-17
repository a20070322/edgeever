import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { globSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile as rawReadFile, writeFile as rawWriteFile, rm, symlink, mkdir, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchEdgeEverApp } from '../../apps/api/src/index.ts';
import { createSelfHostedStorageAdapter } from '../../apps/api/src/self-hosted-storage-adapter.ts';
import { updateMemoRecord, getMemoDetail } from '../../apps/api/src/memo-service.ts';
import { resourceTransport } from './http.mjs';
import { markdownUrls } from './attachments.mjs';
import { link, sync, status, selectNotebooks, hash, resolveConflict, retryUpload, uploads, migrate, importFile, conflicts } from './core.mjs';

import { decodeNote, encodeNote } from '../../cli/src/file-workspace/metadata.mjs';
// Existing behavior tests operate on the body; raw metadata is asserted separately below.
async function readFile(path, encoding) {
  const value = await rawReadFile(path, encoding);
  return typeof value === 'string' && String(path).endsWith('.md') ? decodeNote(value).body : value;
}
async function writeFile(path, value) {
  if (typeof value === 'string' && String(path).endsWith('.md')) {
    try { const { id } = decodeNote(await rawReadFile(path, 'utf8')); if (id) value = encodeNote(value, id); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return rawWriteFile(path, value);
}
let root, sqlite, storage, client;
const scope = { all: false, include: ['nb_parent'], exclude: [], recursive: true };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'edgeever-workspace-test-'));
  sqlite = new Database(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of globSync('migrations/*.sql').sort()) sqlite.exec(readFileSync(file, 'utf8'));
  storage = createSelfHostedStorageAdapter(sqlite, join(root, '.blobs'));
  sqlite.run("INSERT INTO users (id,username,password_hash) VALUES ('usr_test','tester','unused')");
  sqlite.run("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ('ws_default','usr_test','owner')");
  for (const [id, parent, name] of [['nb_parent',null,'项目'],['nb_child','nb_parent','纪要'],['nb_private','nb_parent','私密'],['nb_other',null,'其他']]) {
    sqlite.run('INSERT INTO notebooks(id,workspace_id,parent_id,name) VALUES (?, ?, ?, ?)', [id,'ws_default',parent,name]);
  }
  sqlite.run('INSERT INTO api_tokens(id,workspace_id,name,token_hash,scopes_json) VALUES(?,?,?,?,?)',
    ['tok_test','ws_default','test',hash('test-token'),JSON.stringify(['read:memos','write:memos','read:notebooks','write:notebooks','read:resources','write:resources'])]);
  client = { baseUrl: 'http://test.local', ...resourceTransport('http://test.local','test-token',(url,init)=>fetchEdgeEverApp(new Request(url,init),{storage},{waitUntil(){},passThroughOnException(){}})), request: async (path, init = {}) => {
    const res = await fetchEdgeEverApp(new Request(`http://test.local${path}`, {
      method: init.method || 'GET', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }), { storage }, { waitUntil() {}, passThroughOnException() {} });
    const data = await res.json();
    if (!res.ok) throw Object.assign(Error(JSON.stringify(data)), { status: res.status });
    return data;
  } };
});
afterEach(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });
const create = async (body = '原文\n', notebookId = 'nb_child') => (await client.request('/api/v1/memos', { method: 'POST', body: { notebookId, title: '纪要', contentMarkdown: body } })).memo;
const state = async () => JSON.parse(await readFile(join(root, '.edgeever/state.json'), 'utf8'));
const editRemote = async (memo, text) => updateMemoRecord(storage.db, 'ws_default', memo.id, { contentMarkdown: text, expectedRevision: memo.revision }, { actorType: 'user', actorId: 'usr_test' }, 'test');

test('real API smoke: link, pull, local edit, dry run, push, restart and search', async () => {
  const memo = await create(); await link(root, client, scope); await sync(root, client);
  const path = join(root, (await state()).entries[memo.id].path);
  expect(await readFile(path, 'utf8')).toBe('原文\n');
  await writeFile(path, '支付重构新纪要\n');
  expect((await status(root))[0].status).toBe('modified');
  expect((await sync(root, client, { dryRun: true })).results[0].status).toBe('would-push');
  expect((await getMemoDetail(storage.db, 'ws_default', memo.id)).contentMarkdown).toBe('原文\n');
  expect((await sync(root, client)).results[0].status).toBe('pushed');
  expect((await client.request('/api/v1/memos?q=支付重构')).memos.map(m => m.id)).toContain(memo.id);
  expect((await sync(root, client)).results[0].status).toBe('clean');
});

test('selection: overlapping parents deduplicate, exclusions win, shallow and all', async () => {
  const { notebooks } = await client.request('/api/v1/notebooks');
  expect([...selectNotebooks(notebooks, { ...scope, include: ['nb_parent','nb_child'], exclude: ['nb_private'] })].sort()).toEqual(['nb_child','nb_parent']);
  expect([...selectNotebooks(notebooks, { ...scope, recursive: false })]).toEqual(['nb_parent']);
  expect(selectNotebooks(notebooks, { ...scope, all: true, include: [], exclude: ['nb_parent'] }).has('nb_child')).toBe(false);
  expect(() => selectNotebooks(notebooks, { ...scope, include: ['missing'] })).toThrow();
});

test('combined scope excludes private and includes independent notebook', async () => {
  await create('one', 'nb_child'); await create('two', 'nb_other'); await create('secret','nb_private');
  await link(root, client, { ...scope, include: ['nb_parent','nb_other'], exclude: ['nb_private'] });
  expect((await sync(root, client)).results.length).toBe(2);
});

test('remote-only change is pulled, previous file retained in history', async () => {
  const memo = await create(); await link(root, client, scope); await sync(root, client);
  await editRemote(memo, '服务端新内容');
  expect((await sync(root, client)).results[0].status).toBe('pulled');
  expect(await readFile(join(root,(await state()).entries[memo.id].path),'utf8')).toBe('服务端新内容');
});

test('both sides changed: preserve local and remote conflict copy, do not advance baseline', async () => {
  const memo = await create(); await link(root, client, scope); await sync(root, client);
  const entry = (await state()).entries[memo.id]; await writeFile(join(root,entry.path), '本地修改');
  await editRemote(memo,'远端修改');
  const result = (await sync(root,client)).results[0]; expect(result.status).toBe('conflict');
  expect(await readFile(join(root,result.remoteCopy),'utf8')).toBe('远端修改');
  expect(await readFile(join(root,entry.path),'utf8')).toBe('本地修改');
  expect((await state()).entries[memo.id].revision).toBe(memo.revision);
});

test('lost response recovery: equal local/remote content reconciles without another write', async () => {
  const memo = await create(); await link(root,client,scope); await sync(root,client);
  await writeFile(join(root,(await state()).entries[memo.id].path), '同一修改'); await editRemote(memo,'同一修改');
  expect((await sync(root,client)).results[0].status).toBe('clean');
  expect((await state()).entries[memo.id].revision).toBe(memo.revision+1);
});

test('missing local file never deletes remote; scope removal preserves local edits', async () => {
  const memo = await create(); await link(root,client,scope); await sync(root,client);
  const entry = (await state()).entries[memo.id]; await rm(join(root,entry.path));
  expect((await sync(root,client)).results[0].status).toBe('missing-local');
  expect(await getMemoDetail(storage.db,'ws_default',memo.id)).not.toBeNull();
  await rawWriteFile(join(root,entry.path),encodeNote('保留',memo.id));
  await link(root,client,{ ...scope, include:['nb_other'] },true);
  expect((await sync(root,client)).results[0].status).toBe('outside-snapshot-retained');
  expect(await readFile(join(root,entry.path),'utf8')).toBe('保留');
});

test('pull-only leaves modified file unpushed', async () => {
  const memo = await create(); await link(root,client,scope); await sync(root,client);
  await writeFile(join(root,(await state()).entries[memo.id].path),'local');
  expect((await sync(root,client,{pullOnly:true})).results[0].status).toBe('modified');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('原文\n');
});

test('reject other server, old capability, symlink, traversal and overlapping process lock', async () => {
  const memo = await create(); await link(root,client,scope); await sync(root,client);
  await expect(sync(root,{ ...client, baseUrl:'http://other' })).rejects.toThrow('mismatch');
  await expect(sync(root,{ ...client, request: async () => ({ protocolVersion:0 }) })).rejects.toThrow('upgrade');
  const entry=(await state()).entries[memo.id]; await rm(join(root,entry.path));
  await symlink('/etc/hosts',join(root,entry.path)); await expect(sync(root,client)).rejects.toThrow('Symlink');
  await rm(join(root,entry.path));
  const data=await state(); data.entries[memo.id].path='../escape.md'; await writeFile(join(root,'.edgeever/state.json'),JSON.stringify(data));
  await expect(status(root)).rejects.toThrow('escapes');
  await writeFile(join(root,'.edgeever/lock'),'{}'); await expect(sync(root,client)).rejects.toThrow('locked');
});

test('1w-character note: local one-line edit passes actual API without losing body', async () => {
  const body = '讨论内容'.repeat(2500)+'\n周五上线\n'; const memo=await create(body);
  await link(root,client,scope); await sync(root,client);
  const changed=body.replace('周五上线','周一上线'); await writeFile(join(root,(await state()).entries[memo.id].path),changed);
  expect((await sync(root,client)).results[0].status).toBe('pushed');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe(changed);
});

test('concurrent writes to an existing schema: exactly one commits, no loser metadata/audit/index', async () => {
  const memo=await create('旧版本数据');
  const before=sqlite.query("SELECT count(*) AS n FROM audit_events WHERE action='memo.update'").get().n;
  const actor={actorType:'user',actorId:'usr_test'};
  const results=await Promise.all(['甲','乙'].map(name=>updateMemoRecord(storage.db,'ws_default',memo.id,{expectedRevision:memo.revision,title:name,contentMarkdown:`${name}的新内容`},actor,name)));
  expect(results.filter(r=>r.error==='revision_conflict')).toHaveLength(1);
  const current=await getMemoDetail(storage.db,'ws_default',memo.id);
  expect(current.revision).toBe(memo.revision+1); expect(current.contentMarkdown).toBe(`${current.title}的新内容`);
  expect(sqlite.query("SELECT count(*) AS n FROM audit_events WHERE action='memo.update'").get().n).toBe(before+1);
  expect(sqlite.query('SELECT title FROM memo_search_documents WHERE memo_id=?').get(memo.id).title).toBe(current.title);
});


test('explicit conflict resolution can keep local then push, or adopt remote', async () => {
  const memo=await create(); await link(root,client,scope); await sync(root,client);
  const path=join(root,(await state()).entries[memo.id].path); await writeFile(path,'local'); await editRemote(memo,'remote');
  await resolveConflict(root,client,memo.id,'local');
  expect((await sync(root,client)).results[0].status).toBe('pushed');
  await writeFile(path,'another edit'); await resolveConflict(root,client,memo.id,'remote');
  expect(await readFile(path,'utf8')).toBe('local');
  expect((await status(root))[0].status).toBe('clean');
});

test('conflict at API write after session is detected; no accidental local overwrite', async () => {
  const memo=await create(); await link(root,client,scope); await sync(root,client);
  const path=join(root,(await state()).entries[memo.id].path); await writeFile(path,'local');
  const racing={...client, request:async(path,init)=>{
    if(init?.method==='PATCH') await editRemote(memo,'competitor');
    return client.request(path,init);
  }};
  expect((await sync(root,racing)).results[0].status).toBe('conflict');
  expect(await readFile(path,'utf8')).toBe('local');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('competitor');
});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
const pdf=Buffer.from('%PDF-1.4\nattachment test\n%%EOF');
const resourceCount=()=>sqlite.query('SELECT count(*) n FROM resources').get().n;
const fileFor=async memo=>(await state()).entries[memo.id].path;
const refFile=(notePath,url)=>join(root,join(notePath,'..',decodeURIComponent(url.split('#')[0])));

async function attach(memo,bytes,name,type) {
  return (await client.uploadResource(memo.id,bytes,name,type)).resource;
}

test('download PNG/PDF with auth, relative links and separate fingerprints; second sync stays clean',async()=>{
  const memo=await create();
  const image=await attach(memo,png,'示意 图.png','image/png');
  const doc=await attach(memo,pdf,'方案.pdf','application/pdf');
  const text=`![图](${image.url}?signature=temporary)\n[PDF](${doc.url}#page=2)\n\n\`![example](${image.url})\`\n`;
  await editRemote(memo,text); await link(root,client,scope); await sync(root,client);
  const entry=(await state()).entries[memo.id], local=await readFile(join(root,entry.path),'utf8');
  const refs=markdownUrls(local);
  expect(refs).toHaveLength(2); expect(local).toContain('attachments/');
  expect(await readFile(refFile(entry.path,refs[0].url))).toEqual(png);
  expect(await readFile(refFile(entry.path,refs[1].url))).toEqual(pdf);
  expect(entry.hash).not.toBe(entry.serverHash); expect(entry.serverBase).toBe(text);
  expect((await sync(root,client)).results[0].status).toBe('clean');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe(text);
});

test('upload new local file and reference definition without changing local Markdown; no duplicate upload',async()=>{
  const memo=await create(); await link(root,client,scope); await sync(root,client);
  const path=await fileFor(memo); await mkdir(join(root,'attachments'),{recursive:true}); await writeFile(join(root,'attachments','方案 (1).pdf'),pdf);
  const url=relativeTo(path,'attachments/方案 (1).pdf');
  const body=`[方案][p]\n\n[p]: <${url}> "说明"\n\n\`[not a file](missing.pdf)\`\n`;
  await writeFile(join(root,path),body);
  const before=resourceCount(); expect((await sync(root,client,{dryRun:true})).results[0].status).toBe('would-push'); expect(resourceCount()).toBe(before);
  expect((await sync(root,client)).results[0].status).toBe('pushed'); expect(resourceCount()).toBe(before+1);
  const remote=await getMemoDetail(storage.db,'ws_default',memo.id); expect(remote.contentMarkdown).toContain('/api/v1/resources/'); expect(remote.contentMarkdown).not.toContain('方案%20');
  expect(await readFile(join(root,path),'utf8')).toBe(body);
  expect((await sync(root,client)).results[0].status).toBe('clean'); expect(resourceCount()).toBe(before+1);
});
function relativeTo(note,path) { return join(note,'..').split('/').filter(Boolean).map(()=> '..').join('/')+'/'+path.split('/').map(encodeURIComponent).join('/'); }

test('binary-only change uploads a new ID, preserves original remote resource and local path',async()=>{
  const memo=await create(), r=await attach(memo,pdf,'same.pdf','application/pdf');
  await editRemote(memo,`[doc](${r.url})`); await link(root,client,scope); await sync(root,client);
  const path=await fileFor(memo),body=await readFile(join(root,path),'utf8');
  const file=refFile(path,markdownUrls(body)[0].url); await writeFile(file,Buffer.from('%PDF-1.4\nnew version'));
  expect((await status(root))[0].status).toBe('modified');
  expect((await sync(root,client)).results[0].status).toBe('pushed');
  expect(resourceCount()).toBe(2); const remote=await getMemoDetail(storage.db,'ws_default',memo.id); expect(remote.contentMarkdown).not.toContain(r.id);
  expect(await readFile(join(root,path),'utf8')).toBe(body);
  expect(await client.downloadResource(r.id,10000)).toEqual(pdf);
});

test('upload succeeded but note PATCH failed: durable receipt avoids duplicate on retry',async()=>{
  const memo=await create(); await link(root,client,scope); await sync(root,client);
  const path=await fileFor(memo); await writeFile(join(root,'new.pdf'),pdf); await writeFile(join(root,path),`[doc](${relativeTo(path,'new.pdf')})`);
  const failing={...client,request:async(path,init)=>{if(init?.method==='PATCH') throw Object.assign(Error('unavailable'),{status:503}); return client.request(path,init);}};
  await expect(sync(root,failing)).rejects.toThrow('unavailable'); expect(resourceCount()).toBe(1);
  expect(Object.values((await state()).uploads)[0].status).toBe('uploaded');
  expect((await sync(root,client)).results[0].status).toBe('pushed'); expect(resourceCount()).toBe(1);
});

test('upload response lost before receipt is saved: scoped hash lookup recovers',async()=>{
  const memo=await create(); await link(root,client,scope); await sync(root,client);
  const path=await fileFor(memo); await writeFile(join(root,'new.pdf'),pdf); await writeFile(join(root,path),`[doc](${relativeTo(path,'new.pdf')})`);
  const failing={...client,uploadResource:async(...args)=>{await client.uploadResource(...args);throw Error('connection lost');}};
  await expect(sync(root,failing)).rejects.toThrow('connection lost'); expect(resourceCount()).toBe(1);
  expect((await sync(root,client)).results[0].status).toBe('pushed'); expect(resourceCount()).toBe(1);
});

test('missing file, traversal and symlink block save; removing reference never deletes resource',async()=>{
  const memo=await create(); await link(root,client,scope); await sync(root,client); const path=await fileFor(memo);
  await writeFile(join(root,path),'[doc](missing.pdf)'); expect((await sync(root,client)).results[0].status).toBe('attachment-error'); expect(resourceCount()).toBe(0);
  await writeFile(join(root,path),'[doc](../../../../etc/hosts)'); expect((await sync(root,client)).results[0].error).toContain('escapes');
  await symlink('/etc/hosts',join(root,'leak.pdf')); await writeFile(join(root,path),`[doc](${relativeTo(path,'leak.pdf')})`); await expect(sync(root,client)).rejects.toThrow('Symlink');
  await rm(join(root,'leak.pdf')); await writeFile(join(root,'good.pdf'),pdf); await writeFile(join(root,path),`[doc](${relativeTo(path,'good.pdf')})`); await sync(root,client);
  await writeFile(join(root,path),'no attachment now'); await sync(root,client); expect(resourceCount()).toBe(1);
});

test('old v1 state with raw links upgrades without a spurious remote write',async()=>{
  const memo=await create(),r=await attach(memo,pdf,'old.pdf','application/pdf'); await editRemote(memo,`[doc](${r.url})`);
  await link(root,client,scope); await sync(root,client);
  const s=await state(),entry=s.entries[memo.id]; const remote=await getMemoDetail(storage.db,'ws_default',memo.id);
  s.version=1;delete s.resources;delete s.uploads;delete entry.serverBase;delete entry.serverHash;entry.base=remote.contentMarkdown;entry.hash=hash(entry.base);
  await rawWriteFile(join(root,entry.path),entry.base);await writeFile(join(root,'.edgeever/state.json'),JSON.stringify(s));
  await expect(sync(root,client)).rejects.toThrow('migrate');await migrate(root,client);await sync(root,client);expect((await state()).version).toBe(3);
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).revision).toBe(remote.revision);
});

test('corrupt download never installs a file or commits a note baseline',async()=>{
  const memo=await create(),r=await attach(memo,pdf,'bad.pdf','application/pdf'); await editRemote(memo,`[doc](${r.url})`);await link(root,client,scope);
  await expect(sync(root,{...client,downloadResource:async()=>Buffer.from('bad')})).rejects.toThrow('integrity');
  expect((await state()).entries[memo.id]).toBeUndefined();
});

test('same-name attachments remain distinct and external URLs are never fetched',async()=>{
  const memo=await create(),a=await attach(memo,pdf,'same.pdf','application/pdf'),b=await attach(memo,Buffer.from('%PDF-second'),'same.pdf','application/pdf');
  await editRemote(memo,`[a](${a.url}) [b](${b.url}) ![ext](https://other.example/api/v1/resources/secret/blob)`);
  await link(root,client,scope);const ids=[];await sync(root,{...client,downloadResource:async(id,max)=>{ids.push(id);return client.downloadResource(id,max);}});
  expect(ids.sort()).toEqual([a.id,b.id].sort());
  const body=await readFile(join(root,await fileFor(memo)),'utf8'),refs=markdownUrls(body);expect(refs[0].url).not.toBe(refs[1].url);
  expect(refs[2].url).toBe('https://other.example/api/v1/resources/secret/blob');
});

test('resource read scopes and workspace boundary enforced on metadata and memo listing',async()=>{
  const memo=await create(),a=await attach(memo,pdf,'private.pdf','application/pdf');
  sqlite.run("UPDATE api_tokens SET scopes_json=? WHERE id='tok_test'",[JSON.stringify(['read:memos','read:notebooks','write:memos'])]);
  await expect(client.request(`/api/v1/resources/${a.id}`)).rejects.toMatchObject({status:403});
  await expect(client.request(`/api/v1/memos/${memo.id}/resources`)).rejects.toMatchObject({status:403});
  sqlite.run("INSERT INTO workspaces(id,name,is_personal) VALUES('ws_else','Else',1)");
  sqlite.run("UPDATE api_tokens SET workspace_id='ws_else',scopes_json=? WHERE id='tok_test'",[JSON.stringify(['read:resources'])]);
  await expect(client.request(`/api/v1/resources/${a.id}`)).rejects.toMatchObject({status:404});
  await expect(client.request(`/api/v1/memos/${memo.id}/resources`)).rejects.toMatchObject({status:404});
});

test('uncertain upload not yet visible is not blindly repeated',async()=>{
  const memo=await create();await link(root,client,scope);await sync(root,client);const path=await fileFor(memo);
  await writeFile(join(root,'pending.pdf'),pdf);await writeFile(join(root,path),`[doc](${relativeTo(path,'pending.pdf')})`);
  await expect(sync(root,{...client,uploadResource:async()=>{throw Error('network unknown');}})).rejects.toThrow('network unknown');
  await expect(sync(root,client)).rejects.toThrow('outcome uncertain');expect(resourceCount()).toBe(0);
});


test('remote conflict resolution preserves edited binary separately and adopts remote bytes',async()=>{
  const memo=await create(),r=await attach(memo,pdf,'a.pdf','application/pdf');await editRemote(memo,`[doc](${r.url})`);
  await link(root,client,scope);await sync(root,client);const path=await fileFor(memo),body=await readFile(join(root,path),'utf8');
  const file=refFile(path,markdownUrls(body)[0].url);await writeFile(file,'local binary edit');
  const remote=await getMemoDetail(storage.db,'ws_default',memo.id);await editRemote(remote,remote.contentMarkdown+' remote text');
  expect((await sync(root,client)).results[0].status).toBe('conflict');
  await resolveConflict(root,client,memo.id,'remote');
  const resolved=await readFile(join(root,path),'utf8');expect(await readFile(refFile(path,markdownUrls(resolved)[0].url))).toEqual(pdf);
  expect(await readFile(file,'utf8')).toBe('local binary edit');expect((await sync(root,client)).results[0].status).toBe('clean');
});

test('operator can explicitly authorize retry after a confirmed unsuccessful upload',async()=>{
  const memo=await create();await link(root,client,scope);await sync(root,client);const path=await fileFor(memo);
  await writeFile(join(root,'pending.pdf'),pdf);await writeFile(join(root,path),`[doc](${relativeTo(path,'pending.pdf')})`);
  await expect(sync(root,{...client,uploadResource:async()=>{throw Error('unknown');}})).rejects.toThrow();
  const [pending]=await uploads(root);await retryUpload(root,client,pending.key);
  expect((await sync(root,client)).results[0].status).toBe('pushed');expect(resourceCount()).toBe(1);
});

test('v3 files keep readable names and preserve user front matter through real API edits', async () => {
  const body='---\ntitle: User title\nlabels: [one, two]\n---\n# Hello\n';
  const memo=await create(body);await link(root,client,scope);await sync(root,client);
  const entry=(await state()).entries[memo.id];
  expect(entry.path).toBe('项目/纪要/纪要.md');
  const raw=await rawReadFile(join(root,entry.path),'utf8');expect(decodeNote(raw)).toEqual({id:memo.id,body});
  await rawWriteFile(join(root,entry.path),raw.replace('# Hello','# Edited'));
  expect((await sync(root,client)).results[0].status).toBe('pushed');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe(body.replace('# Hello','# Edited'));
});

test('duplicate IDs, missing ID and foreign IDs cannot overwrite remote notes', async () => {
  const memo=await create();await link(root,client,scope);await sync(root,client);const path=await fileFor(memo);
  const raw=await rawReadFile(join(root,path),'utf8');await rawWriteFile(join(root,'copy.md'),raw.replace('原文','copy changed'));
  expect((await sync(root,client)).results.some(r=>r.status==='duplicate-id')).toBe(true);
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).revision).toBe(memo.revision);
  await rm(join(root,'copy.md'));await rawWriteFile(join(root,path),'no metadata');
  expect((await sync(root,client)).results[0].status).toBe('identity-mismatch');
  await rawWriteFile(join(root,path),encodeNote('foreign content','memo_unknown'));
  expect((await sync(root,client)).results.some(r=>r.status==='unbound-id')).toBe(true);
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('原文\n');
});

test('moved note rebinds by ID and repairs relative attachment links without a server write',async()=>{
  const memo=await create(),resource=await attach(memo,pdf,'move.pdf','application/pdf');await editRemote(memo,`[file](${resource.url})`);
  const remote=await getMemoDetail(storage.db,'ws_default',memo.id);await link(root,client,scope);await sync(root,client);
  const before=await fileFor(memo);await rename(join(root,before),join(root,'renamed.md'));
  expect((await status(root)).find(r=>r.id===memo.id).status).toBe('moved');
  expect((await sync(root,client)).results.find(r=>r.id===memo.id).status).toBe('clean');
  expect((await state()).entries[memo.id].path).toBe('renamed.md');
  const body=await readFile(join(root,'renamed.md'),'utf8');expect(await readFile(refFile('renamed.md',markdownUrls(body)[0].url))).toEqual(pdf);
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).revision).toBe(remote.revision);expect(resourceCount()).toBe(1);
});

test('same titles and case-insensitive path collisions preserve existing user files',async()=>{
  const first=await create('one'),second=await create('two');await link(root,client,scope);await sync(root,client);
  const entries=(await state()).entries;
  expect(entries[first.id].path).not.toBe(entries[second.id].path);
  expect(Object.values(entries).map(e=>e.path).sort()).toEqual(['项目/纪要/纪要 (2).md','项目/纪要/纪要.md']);
});

test('v2 migration backs up local edits and baseline, dry-run writes nothing and collisions are retained',async()=>{
  const memo=await create('baseline');await link(root,client,scope);await sync(root,client);
  const s=await state(),entry=s.entries[memo.id];const old=`项目--${hash('nb_parent').slice(0,16)}/纪要--${hash('nb_child').slice(0,16)}/纪要--${hash(memo.id).slice(0,16)}.md`;
  await mkdir(join(root,old.slice(0,old.lastIndexOf('/'))),{recursive:true});await rawWriteFile(join(root,old),'local edit');
  await rm(join(root,entry.path));entry.path=old;s.version=2;delete s.notebookPaths;await writeFile(join(root,'.edgeever/state.json'),JSON.stringify(s));
  await rawWriteFile(join(root,'项目/纪要/纪要.md'),'untracked user file');
  const preview=await migrate(root,client,{dryRun:true});expect(preview.status).toBe('would-migrate');expect((await state()).version).toBe(2);expect(await readFile(join(root,old),'utf8')).toBe('local edit');
  const result=await migrate(root,client);const current=await state();expect(current.version).toBe(3);expect(current.entries[memo.id].revision).toBe(entry.revision);
  expect(await readFile(join(root,'项目/纪要/纪要.md'),'utf8')).toBe('untracked user file');
  expect(await rawReadFile(join(root,result.backup,`files/${hash(memo.id)}.md`),'utf8')).toBe('local edit');
  expect(decodeNote(await rawReadFile(join(root,current.entries[memo.id].path),'utf8')).id).toBe(memo.id);
  expect((await sync(root,client)).results.find(r=>r.id===memo.id).status).toBe('pushed');expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('local edit');
});

test('explicit import creates once, preserves the filename and recovers a lost response with --memo',async()=>{
  await link(root,client,scope);await rawWriteFile(join(root,'260924.md'),'# New iteration\n');
  const before=sqlite.query('select count(*) n from memos').get().n;let created;
  const lost={...client,request:async(path,init)=>{const data=await client.request(path,init);if(path==='/api/v1/memos'&&init?.method==='POST'){created=data.memo;throw Error('response lost');}return data;}};
  await expect(importFile(root,lost,{file:'260924.md',notebookId:'nb_child'})).rejects.toThrow('response lost');
  await expect(importFile(root,client,{file:'260924.md',notebookId:'nb_child'})).rejects.toThrow('uncertain');
  expect(sqlite.query('select count(*) n from memos').get().n).toBe(before+1);
  const result=await importFile(root,client,{file:'260924.md',notebookId:'nb_child',memoId:created.id});expect(result.status).toBe('imported');
  expect(decodeNote(await rawReadFile(join(root,'260924.md'),'utf8'))).toEqual({id:created.id,body:'# New iteration\n'});
  expect((await sync(root,client)).results.find(r=>r.id===created.id).status).toBe('clean');
  expect(sqlite.query('select count(*) n from memos').get().n).toBe(before+1);
});

test('migration resumes a saved partial plan without duplicating or losing source data',async()=>{
  const memo=await create('baseline');await link(root,client,scope);await sync(root,client);
  const old=await state();old.version=2;delete old.notebookPaths;
  const from=old.entries[memo.id].path,to='resumed.md',before='baseline',after=encodeNote(before,memo.id);
  await rawWriteFile(join(root,from),before);
  const next=structuredClone(old);next.version=3;next.entries[memo.id].path=to;
  const journal={backup:'.edgeever/migrations/resume-test',previousState:old,state:next,files:[{id:memo.id,from,to,before,after}]};
  await writeFile(join(root,'.edgeever/state.json'),JSON.stringify(old));await writeFile(join(root,'.edgeever/migration-v3.json'),JSON.stringify(journal));
  await rawWriteFile(join(root,to),after); // Destination published before the interrupted process retired source.
  const resumed=await migrate(root,client);expect(resumed.status).toBe('migrated');expect((await state()).entries[memo.id].path).toBe(to);
  await expect(rawReadFile(join(root,from))).rejects.toMatchObject({code:'ENOENT'});
  expect(decodeNote(await rawReadFile(join(root,to),'utf8'))).toEqual({id:memo.id,body:before});
  expect((await sync(root,client)).results[0].status).toBe('clean');
});

test('migration interruption refuses edited destination and preserves all copies',async()=>{
  const memo=await create('baseline');await link(root,client,scope);await sync(root,client);const old=await state();old.version=2;
  const from=old.entries[memo.id].path;await rawWriteFile(join(root,from),'baseline');
  await writeFile(join(root,'.edgeever/state.json'),JSON.stringify(old));
  await writeFile(join(root,'.edgeever/migration-v3.json'),JSON.stringify({backup:'.edgeever/migrations/interrupted',state:{...old,version:3},files:[{id:memo.id,from,to:'occupied.md',before:'baseline',after:encodeNote('baseline',memo.id)}]}));
  await rawWriteFile(join(root,'occupied.md'),'late user edit');await expect(migrate(root,client)).rejects.toThrow('destination changed');
  expect(await rawReadFile(join(root,from),'utf8')).toBe('baseline');expect(await rawReadFile(join(root,'occupied.md'),'utf8')).toBe('late user edit');expect((await state()).version).toBe(2);
});

test('import resumes a created receipt even if metadata was written before state binding',async()=>{
  await link(root,client,scope);await rawWriteFile(join(root,'resume.md'),'receipt body');let created;const before=sqlite.query('select count(*) n from memos').get().n;
  const lost={...client,request:async(path,init)=>{const data=await client.request(path,init);if(path==='/api/v1/memos'&&init?.method==='POST'){created=data.memo;throw Error('lost');}return data;}};
  await expect(importFile(root,lost,{file:'resume.md',notebookId:'nb_child'})).rejects.toThrow();
  const s=await state();s.imports[hash('resume.md')].memoId=created.id;s.imports[hash('resume.md')].status='created';
  await writeFile(join(root,'.edgeever/state.json'),JSON.stringify(s));await rawWriteFile(join(root,'resume.md'),encodeNote('receipt body',created.id));
  expect((await importFile(root,client,{file:'resume.md',notebookId:'nb_child'})).id).toBe(created.id);
  expect(sqlite.query('select count(*) n from memos').get().n).toBe(before+1);
});

test('migrating an existing attachment workspace preserves links and does not upload again',async()=>{
  const memo=await create(),resource=await attach(memo,pdf,'baseline.pdf','application/pdf');await editRemote(memo,`[file](${resource.url})`);
  await link(root,client,scope);await sync(root,client);const s=await state(),entry=s.entries[memo.id];
  const current=await getMemoDetail(storage.db,'ws_default',memo.id);s.version=2;delete s.notebookPaths;
  await rawWriteFile(join(root,entry.path),decodeNote(await rawReadFile(join(root,entry.path),'utf8')).body);
  await writeFile(join(root,'.edgeever/state.json'),JSON.stringify(s));await migrate(root,client);
  expect((await sync(root,client)).results.find(r=>r.id===memo.id).status).toBe('clean');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).revision).toBe(current.revision);expect(resourceCount()).toBe(1);
  const path=(await state()).entries[memo.id].path,body=await readFile(join(root,path),'utf8');expect(await readFile(refFile(path,markdownUrls(body)[0].url))).toEqual(pdf);
});

test('remote notebook move reconciles old v3 clean state and dry-run changes no files', async () => {
  const memo = await create(); await link(root,client,scope); await sync(root,client);
  const before = await state(), old = before.entries[memo.id].path;
  sqlite.run('UPDATE memos SET notebook_id=? WHERE id=?',['nb_private',memo.id]);
  // Reproduce 0.3.0: clean sync already advanced notebookId, but not the path.
  before.entries[memo.id].notebookId='nb_private';
  await rawWriteFile(join(root,'.edgeever/state.json'),JSON.stringify(before));
  const preview = (await sync(root,client,{dryRun:true,pullOnly:true})).results.find(r=>r.id===memo.id);
  expect(preview.status).toBe('would-move'); expect(preview.move.to).toBe('项目/私密/纪要.md');
  expect(await state()).toEqual(before); expect(await readFile(join(root,old),'utf8')).toBe('原文\n');
  const result=(await sync(root,client,{pullOnly:true})).results.find(r=>r.id===memo.id);
  expect(result.status).toBe('moved'); expect((await state()).entries[memo.id].path).toBe(preview.move.to);
  await expect(rawReadFile(join(root,old))).rejects.toThrow();
  expect((await sync(root,client)).results.find(r=>r.id===memo.id).status).toBe('clean');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).revision).toBe(memo.revision);
});

test('remote move preserves local edits and avoids occupied target', async () => {
  const memo=await create();await link(root,client,scope);await sync(root,client);
  // Allocate the destination notebook directory through another tracked note.
  await create('neighbor','nb_private');await sync(root,client);
  const old=(await state()).entries[memo.id].path;
  await writeFile(join(root,old),'本地未上传');
  sqlite.run('UPDATE memos SET notebook_id=? WHERE id=?',['nb_private',memo.id]);
  const result=(await sync(root,client,{pullOnly:true})).results.find(r=>r.id===memo.id);
  expect(result.status).toBe('modified');expect(result.move.to).toBe('项目/私密/纪要 (2).md');
  expect(await readFile(join(root,result.path),'utf8')).toBe('本地未上传');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('原文\n');
  expect((await sync(root,client)).results.find(r=>r.id===memo.id).status).toBe('pushed');
});

test('remote move rebases attachment links and retains conflict baselines', async () => {
  const memo=await create(), resource=await attach(memo,pdf,'remote-move.pdf','application/pdf');
  await editRemote(memo,`[file](${resource.url})`);await link(root,client,scope);await sync(root,client);
  const old=(await state()).entries[memo.id];
  sqlite.run("INSERT INTO notebooks(id,workspace_id,parent_id,name) VALUES ('nb_deep','ws_default','nb_private','260924')");
  sqlite.run('UPDATE memos SET notebook_id=? WHERE id=?',['nb_deep',memo.id]);
  const moved=(await sync(root,client)).results.find(r=>r.id===memo.id);
  expect(moved.status).toBe('moved');expect(moved.path).toBe('项目/私密/260924/纪要.md');
  expect(await readFile(join(root,moved.path),'utf8')).toContain('../../../attachments/');
  expect((await status(root)).find(r=>r.id===memo.id).status).toBe('clean');
  expect((await state()).entries[memo.id].revision).toBe(old.revision);
  await writeFile(join(root,moved.path),'本地修改');
  const current=await getMemoDetail(storage.db,'ws_default',memo.id);await editRemote(current,'远端修改');
  sqlite.run('UPDATE memos SET notebook_id=? WHERE id=?',['nb_child',memo.id]);
  const conflict=(await sync(root,client)).results.find(r=>r.id===memo.id);
  expect(conflict.status).toBe('conflict');expect(await readFile(join(root,conflict.path),'utf8')).toBe('本地修改');
  expect((await state()).entries[memo.id].revision).toBe(old.revision);
});

test('manual local path override survives remote move and outside-scope notes stay put',async()=>{
  const memo=await create();await link(root,client,scope);await sync(root,client);
  const old=(await state()).entries[memo.id].path;
  await rename(join(root,old),join(root,'我的文件.md'));await sync(root,client);
  sqlite.run('UPDATE memos SET notebook_id=? WHERE id=?',['nb_private',memo.id]);
  await sync(root,client);expect((await state()).entries[memo.id].path).toBe('我的文件.md');
  sqlite.run('UPDATE memos SET notebook_id=? WHERE id=?',['nb_other',memo.id]);
  expect((await sync(root,client)).results.find(r=>r.id===memo.id).status).toBe('outside-snapshot-retained');
  expect(await readFile(join(root,'我的文件.md'),'utf8')).toBe('原文\n');
});

test('interrupted remote move resumes from history without duplicate IDs',async()=>{
  const memo=await create();await link(root,client,scope);await sync(root,client);
  const s=await state(),entry=s.entries[memo.id],before=await rawReadFile(join(root,entry.path),'utf8');
  const to='项目/私密/纪要.md',backup='.edgeever/history/moves/interrupted.md';
  sqlite.run('UPDATE memos SET notebook_id=? WHERE id=?',['nb_private',memo.id]);
  const plan={id:memo.id,from:entry.path,to,before,after:before,backup,notebookPaths:{...s.notebookPaths,nb_private:'项目/私密'},entry:{...entry,path:to,notebookId:'nb_private'}};
  await rawWriteFile(join(root,'.edgeever/pending-move.json'),JSON.stringify(plan));
  await mkdir(join(root,'.edgeever/history/moves'),{recursive:true});await rename(join(root,entry.path),join(root,backup));
  expect((await status(root))[0].status).toBe('move-recovery-required');
  await sync(root,client);expect((await state()).entries[memo.id].path).toBe(to);
  expect((await status(root)).find(r=>r.id===memo.id).status).toBe('clean');
  expect(await rawReadFile(join(root,backup),'utf8')).toBe(before);
});

test('interrupted move refuses edited destination and retains source backup',async()=>{
  const memo=await create();await link(root,client,scope);await sync(root,client);
  const s=await state(),entry=s.entries[memo.id],before=await rawReadFile(join(root,entry.path),'utf8');
  const to='target.md',backup='.edgeever/history/moves/interrupted.md';
  await rawWriteFile(join(root,'.edgeever/pending-move.json'),JSON.stringify({id:memo.id,from:entry.path,to,before,after:before,backup,notebookPaths:s.notebookPaths,entry:{...entry,path:to}}));
  await mkdir(join(root,'.edgeever/history/moves'),{recursive:true});await rename(join(root,entry.path),join(root,backup));
  await rawWriteFile(join(root,to),'编辑器新内容');
  await expect(sync(root,client)).rejects.toThrow('Move destination changed');
  expect(await rawReadFile(join(root,to),'utf8')).toBe('编辑器新内容');
  expect(await rawReadFile(join(root,backup),'utf8')).toBe(before);
  expect(await state()).toEqual(s);
});

const mergeBase='first\n\nmiddle\n\nlast\n';
const mergeLocal='LOCAL\n\nmiddle\n\nlast\n';
const mergeRemote='first\n\nmiddle\n\nREMOTE\n';
const mergeExpected='LOCAL\n\nmiddle\n\nREMOTE\n';
async function mergeFixture(local=mergeLocal, remote=mergeRemote) {
  const memo=await create(mergeBase);await link(root,client,scope);await sync(root,client);
  const entry=(await state()).entries[memo.id];await writeFile(join(root,entry.path),local);await editRemote(memo,remote);
  return {memo,entry};
}
test('auto merge dry-run is read-only and pull-only preserves an unsent merged edit',async()=>{
  const {memo,entry}=await mergeFixture();const before=await state();
  const preview=(await sync(root,client,{autoMerge:true,dryRun:true})).results[0];
  expect(preview.status).toBe('would-merge-push');expect(await state()).toEqual(before);
  expect(await readFile(join(root,entry.path),'utf8')).toBe(mergeLocal);
  expect((await sync(root,client,{autoMerge:true,pullOnly:true})).results[0].status).toBe('merged-local');
  expect(await readFile(join(root,entry.path),'utf8')).toBe(mergeExpected);
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe(mergeRemote);
  expect((await status(root))[0].status).toBe('modified');
  expect((await sync(root,client)).results[0].status).toBe('pushed');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe(mergeExpected);
});
test('auto merge pushes merged content with current revision and keeps retry safe after rejection',async()=>{
  const {memo,entry}=await mergeFixture();let reject=true;
  const guarded={...client,request:async(path,init)=>{
    if(init?.method==='PATCH'&&reject){reject=false;throw Object.assign(Error('race'),{status:409});}
    return client.request(path,init);
  }};
  expect((await sync(root,guarded,{autoMerge:true})).results[0].status).toBe('conflict');
  expect(await readFile(join(root,entry.path),'utf8')).toBe(mergeExpected);
  expect((await status(root))[0].status).toBe('modified');
  expect((await sync(root,client,{autoMerge:true})).results[0].status).toBe('pushed');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe(mergeExpected);
});
test('overlap creates stable editable draft; continue refuses markers then accepts human result',async()=>{
  const {memo,entry}=await mergeFixture('LOCAL\n','REMOTE\n');
  const result=(await sync(root,client,{autoMerge:true})).results[0];expect(result.status).toBe('conflict');
  expect(await readFile(join(root,entry.path),'utf8')).toBe('LOCAL\n');
  expect((await conflicts(root))[0].draft).toBe(result.draft);
  await expect(resolveConflict(root,client,memo.id,'continue')).rejects.toThrow('markers');
  await rawWriteFile(join(root,result.draft),'Human merged\n');
  expect((await sync(root,client,{autoMerge:true})).results[0].draft).toBe(result.draft);
  expect(await rawReadFile(join(root,result.draft),'utf8')).toBe('Human merged\n');
  expect((await resolveConflict(root,client,memo.id,'continue')).status).toBe('ready-to-push');
  expect(await conflicts(root)).toEqual([]);
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('REMOTE\n');
  await sync(root,client);expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('Human merged\n');
});
test('human confirmation refuses changed remote or local; refreshing retains old draft',async()=>{
  const {memo,entry}=await mergeFixture('LOCAL\n','REMOTE\n');
  const first=await resolveConflict(root,client,memo.id,'merge');await rawWriteFile(join(root,first.draft),'human work');
  await editRemote(await getMemoDetail(storage.db,'ws_default',memo.id),'new remote');
  await expect(resolveConflict(root,client,memo.id,'continue')).rejects.toThrow('Remote changed');
  const next=await resolveConflict(root,client,memo.id,'merge');expect(next.draft).not.toBe(first.draft);
  expect(await rawReadFile(join(root,first.draft),'utf8')).toBe('human work');
  await rawWriteFile(join(root,next.draft),'final');await writeFile(join(root,entry.path),'new local');
  await expect(resolveConflict(root,client,memo.id,'continue')).rejects.toThrow('Local file changed');
});
test('sync and use-local cannot upload conflict markers in tracked text',async()=>{
  const memo=await create();await link(root,client,scope);await sync(root,client);
  await writeFile(join(root,(await state()).entries[memo.id].path),'<<<<<<< LOCAL\nx\n=======\ny\n>>>>>>> REMOTE\n');
  expect((await sync(root,client)).results[0].status).toBe('unresolved-markers');
  await expect(resolveConflict(root,client,memo.id,'local')).rejects.toThrow('markers');
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('原文\n');
});
test('pending binary edits require human resolution and attachment changes invalidate draft',async()=>{
  const memo=await create(),resource=await attach(memo,pdf,'merge.pdf','application/pdf');
  await editRemote(memo,`[file](${resource.url})\n\nold`);await link(root,client,scope);await sync(root,client);
  const entry=(await state()).entries[memo.id], resourcePath=Object.values((await state()).resources)[0].path;
  await rawWriteFile(join(root,resourcePath),Buffer.from('modified binary'));
  await editRemote(await getMemoDetail(storage.db,'ws_default',memo.id),`[file](${resource.url})\n\nremote`);
  const result=(await sync(root,client,{autoMerge:true})).results[0];
  expect(result.status).toBe('conflict');expect(result.binaryPending).toBe(true);
  await rawWriteFile(join(root,result.draft),'chosen text');await rawWriteFile(join(root,resourcePath),Buffer.from('modified again'));
  await expect(resolveConflict(root,client,memo.id,'continue')).rejects.toThrow('attachment changed');
  expect((await state()).entries[memo.id].revision).toBe(entry.revision);
});

test('auto merge refuses a new remote edit after merge before upload',async()=>{
  const {memo,entry}=await mergeFixture();let changed=false;
  const racing={...client,request:async(path,init)=>{
    if(path.endsWith('/edit-sessions')&&!changed){changed=true;await editRemote(await getMemoDetail(storage.db,'ws_default',memo.id),'new concurrent edit');}
    return client.request(path,init);
  }};
  expect((await sync(root,racing,{autoMerge:true})).results[0].status).toBe('conflict');
  expect(await readFile(join(root,entry.path),'utf8')).toBe(mergeExpected);
  expect((await getMemoDetail(storage.db,'ws_default',memo.id)).contentMarkdown).toBe('new concurrent edit');
  expect((await sync(root,client,{autoMerge:true})).results[0].status).toBe('conflict');
});
test('human resolution refuses a remote notebook move even without content revision change',async()=>{
  const {memo}=await mergeFixture('LOCAL','REMOTE');
  const draft=await resolveConflict(root,client,memo.id,'merge');await rawWriteFile(join(root,draft.draft),'merged');
  sqlite.run('UPDATE memos SET notebook_id=? WHERE id=?',['nb_private',memo.id]);
  await expect(resolveConflict(root,client,memo.id,'continue')).rejects.toThrow('Remote changed');
});

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { globSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchEdgeEverApp } from '../../apps/api/src/index.ts';
import { createSelfHostedStorageAdapter } from '../../apps/api/src/self-hosted-storage-adapter.ts';
import { updateMemoRecord, getMemoDetail } from '../../apps/api/src/memo-service.ts';
import { resourceTransport } from './http.mjs';
import { markdownUrls } from './attachments.mjs';
import { link, sync, status, selectNotebooks, hash, resolveConflict, retryUpload, uploads } from './core.mjs';

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
  await writeFile(join(root,entry.path),'保留');
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
  await writeFile(join(root,path),'[doc](missing.pdf)'); await expect(sync(root,client)).rejects.toThrow(); expect(resourceCount()).toBe(0);
  await writeFile(join(root,path),'[doc](../../../../etc/hosts)'); await expect(sync(root,client)).rejects.toThrow('escapes');
  await symlink('/etc/hosts',join(root,'leak.pdf')); await writeFile(join(root,path),`[doc](${relativeTo(path,'leak.pdf')})`); await expect(sync(root,client)).rejects.toThrow('Symlink');
  await rm(join(root,'leak.pdf')); await writeFile(join(root,'good.pdf'),pdf); await writeFile(join(root,path),`[doc](${relativeTo(path,'good.pdf')})`); await sync(root,client);
  await writeFile(join(root,path),'no attachment now'); await sync(root,client); expect(resourceCount()).toBe(1);
});

test('old v1 state with raw links upgrades without a spurious remote write',async()=>{
  const memo=await create(),r=await attach(memo,pdf,'old.pdf','application/pdf'); await editRemote(memo,`[doc](${r.url})`);
  await link(root,client,scope); await sync(root,client);
  const s=await state(),entry=s.entries[memo.id]; const remote=await getMemoDetail(storage.db,'ws_default',memo.id);
  s.version=1;delete s.resources;delete s.uploads;delete entry.serverBase;delete entry.serverHash;entry.base=remote.contentMarkdown;entry.hash=hash(entry.base);
  await writeFile(join(root,entry.path),entry.base);await writeFile(join(root,'.edgeever/state.json'),JSON.stringify(s));
  expect((await sync(root,client)).results[0].status).toBe('pulled');expect((await state()).version).toBe(2);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotebook } from '../src/notebooks.mjs';
async function fixture(fn) {
 const root=await mkdtemp(join(tmpdir(),'eev-notebooks-'));const rows=[{id:'root',name:'IDSO',parentId:null}];let posts=0,mode='ok';
 const client={baseUrl:'http://fixture',request:async(p,init)=>{
  if(!init)return {notebooks:rows}; posts++;
  if(mode==='denied'||(mode==='second-denied'&&posts===2))throw Object.assign(Error('Forbidden'),{status:403});
  if(mode==='lost-before')throw Error('Disconnected');
  const notebook={id:`nb_${posts}`,...init.body};rows.push(notebook);
  if(mode==='lost-after')throw Error('Disconnected');return {notebook};
 }};
 try{await fn({rows,run:o=>createNotebook(client,o,root),posts:()=>posts,mode:m=>mode=m});}finally{await rm(root,{recursive:true,force:true});}
}
test('recursive preview, creation and repeat reuse with final ID',()=>fixture(async f=>{
 const options={path:'开发迭代/260924',parent:'root',parents:true};
 const preview=await f.run({...options,dryRun:true});assert.equal(preview.status,'preview');assert.equal(f.posts(),0);assert.equal(preview.steps.length,2);
 const result=await f.run(options);assert.equal(result.notebookId,'nb_2');assert.equal(f.posts(),2);
 assert.deepEqual((await f.run(options)).steps.map(s=>s.status),['reused','reused']);assert.equal(f.posts(),2);
}));
test('ambiguous or missing ancestor and invalid segments write nothing',()=>fixture(async f=>{
 assert.equal((await f.run({path:'missing/leaf',parent:'root'})).status,'failed');
 f.rows.push({id:'a',name:'dup',parentId:'root'},{id:'b',name:'dup',parentId:'root'});
 assert.equal((await f.run({path:'dup/leaf',parent:'root',parents:true})).status,'failed');
 for(const path of ['a//b','../b','a/','/a','a/'.repeat(90)])await assert.rejects(f.run({path,parents:true}));
 assert.equal(f.posts(),0);
}));
test('lost successful response is reconciled by name without another POST',()=>fixture(async f=>{
 const o={name:'created',parent:'root'};f.mode('lost-after');assert.equal((await f.run(o)).status,'uncertain');
 f.mode('ok');assert.equal((await f.run(o)).steps[0].status,'reused');assert.equal(f.posts(),1);
}));
test('uncertain invisible result is never retried without explicit authorization',()=>fixture(async f=>{
 const o={name:'maybe',parent:'root'};f.mode('lost-before');assert.equal((await f.run(o)).status,'uncertain');
 f.mode('ok');assert.equal((await f.run(o)).status,'uncertain');assert.equal(f.posts(),1);
 assert.equal((await f.run({...o,retryUncertain:true})).status,'complete');assert.equal(f.posts(),2);
}));
test('permission failures report progress and are not treated as uncertain creates',()=>fixture(async f=>{
 f.mode('denied');assert.equal((await f.run({name:'no',parent:'root'})).status,'failed');
 f.mode('ok');assert.equal((await f.run({name:'no',parent:'root'})).status,'complete');
}));

test('partial failure retains completed ancestors and a retry reuses them',()=>fixture(async f=>{
 const o={path:'first/second',parent:'root',parents:true};f.mode('second-denied');
 const result=await f.run(o);assert.equal(result.status,'failed');assert.equal(result.steps.length,1);
 f.mode('ok');const retry=await f.run(o);assert.equal(retry.status,'complete');
 assert.deepEqual(retry.steps.map(s=>s.status),['reused','created']);assert.equal(f.rows.filter(n=>n.name==='first').length,1);
}));

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHttpApp } from '../src/http-app.js';
import { callableNames } from '../src/callables.js';
import { serverConfig, trustedOrigin, validateBuild, validateHostedCredential } from '../src/server-config.js';
import { collectSnapshot, verifySnapshot } from '../src/backup.js';
let server, base, now = Date.now();
before(async () => {
  const dist = await mkdtemp(join(tmpdir(), 'pos-http-'));
  await Promise.all([writeFile(join(dist,'index.html'),'<h1>Test fixture</h1>'),writeFile(join(dist,'404.html'),'<h1>Missing</h1>'),writeFile(join(dist,'.env'),'not-public')]);
  const handlers=Object.fromEntries(callableNames.map(name=>[name,(req,res)=>{ if(req.body?.data?.throwError) throw new Error('sensitive-provider-detail'); res.status(401).json({error:{status:'UNAUTHENTICATED'}}); }]));
  server=createHttpApp({handlers,origins:['https://pos.example.test'],distPath:dist,requestsPerMinute:20,clock:()=>now}).listen(0,'127.0.0.1'); await once(server,'listening'); base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{ if(server) await new Promise(resolve=>server.close(resolve)); });
const post=(path,body='{"data":{}}',headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
test('host preserves auth, rejects foreign origins and never serves frontend for unknown APIs',async()=>{
  assert.equal((await post('/api/checkout')).status,401);
  assert.equal((await post('/api/checkout',undefined,{Origin:'https://attacker.example.test'})).status,403);
  assert.equal((await post('/api/unknown')).status,404);
  assert.equal((await fetch(base+'/api/checkout')).status,405);
});
test('host bounds JSON and returns curated parser errors',async()=>{
  const bad=await post('/api/checkout','{broken'); assert.equal(bad.status,400); assert.equal((await bad.json()).error.message,'Invalid JSON request.');
  assert.equal((await post('/api/checkout',JSON.stringify({data:'x'.repeat(512001)}))).status,413);
});
test('host serves real pages with security headers and keeps private files inaccessible',async()=>{
  const home=await fetch(base); assert.equal(home.status,200); assert.equal(home.headers.get('X-Powered-By'),null); assert.equal(home.headers.get('Cache-Control'),'no-store'); assert.match(home.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
  for(const path of ['/.env','/firebase-service-account.json','/functions/src/server.js','/%2e%2e/%2e%2e/.env']) { const r=await fetch(base+path); assert.equal(r.status,404); assert.doesNotMatch(await r.text(),/not-public/); }
  assert.deepEqual(await (await fetch(base+'/health')).json(),{status:'ok'});
});
test('host hides unexpected errors and throttles pre-auth traffic',async()=>{
  const failure=await post('/api/checkout','{"data":{"throwError":true}}'); assert.equal(failure.status,500); assert.doesNotMatch(await failure.text(),/sensitive-provider-detail|stack/);
  let last; for(let i=0;i<21;i++)last=await post('/api/checkout'); assert.equal(last.status,429); assert.ok(last.headers.get('Retry-After')); now+=60000; assert.equal((await post('/api/checkout')).status,401);
});
test('host config rejects unsafe origins, project confusion and emulator or credential mistakes',()=>{
  const env={POS_PROJECT_ID:'test-pos',RENDER:'true',RENDER_EXTERNAL_URL:'https://pos.onrender.com',GOOGLE_APPLICATION_CREDENTIALS:'/etc/secrets/key.json'};
  assert.equal(serverConfig(env).host,'0.0.0.0'); assert.equal(serverConfig(env).allowRefunds,false);
  for(const override of [{POS_PROJECT_ID:''},{VITE_FIREBASE_PROJECT_ID:'other-pos'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'},{VITE_USE_FIREBASE_EMULATORS:'true'},{PORT:'bad'},{GOOGLE_APPLICATION_CREDENTIALS:''},{RENDER_EXTERNAL_URL:'http://pos.onrender.com'}])assert.throws(()=>serverConfig({...env,...override}));
  for(const origin of ['*','http://pos.example.test','https://pos.example.test/path','https://person:password@pos.example.test','https://*.example.test'])assert.throws(()=>trustedOrigin(origin));
  assert.equal(serverConfig({POS_PROJECT_ID:'test-pos'}).host,'127.0.0.1'); assert.throws(()=>validateBuild({projectId:'test-pos'},{projectId:'other-pos',emulators:false})); assert.throws(()=>validateHostedCredential({projectId:'test-pos'},{type:'authorized_user'}));
});
test('backup traverses missing parents with one read time and preserves exact Firestore values',async()=>{
  const root='projects/test-pos/databases/(default)/documents', readTime='2026-11-27T10:00:00.000Z'; const fields={large:{integerValue:'9223372036854775807'},bytes:{bytesValue:'AAEC'},when:{timestampValue:'2026-11-27T09:00:00.123456Z'}}; const seen=[];
  const snapshot=await collectSnapshot({projectId:'test-pos',readTime,request:async(path,method,body)=>{
    seen.push([path,method,body]);
    if(path===root+':listCollectionIds')return body.pageToken?{}:{collectionIds:['parents'],nextPageToken:'page2'};
    if(path.startsWith(root+'/parents?'))return path.includes('pageToken=')?{}:{documents:[{name:root+'/parents/missing'}],nextPageToken:'docs2'};
    if(path===root+'/parents/missing:listCollectionIds')return {collectionIds:['children']};
    if(path.startsWith(root+'/parents/missing/children?'))return {documents:[{name:root+'/parents/missing/children/kept',fields,updateTime:readTime}]}; return {};
  }});
  assert.equal(snapshot.documents.length,1); assert.deepEqual(snapshot.documents[0].fields,fields); assert.equal(verifySnapshot(snapshot,'test-pos').documents,1);
  assert.ok(seen.every(([path,method,body])=>method==='POST'?body.readTime===readTime:new URL('https://example.test/'+path).searchParams.get('readTime')===readTime));
  snapshot.documents[0].fields.large.integerValue='1'; assert.throws(()=>verifySnapshot(snapshot,'test-pos'));
});
test('backup rejects foreign records and refuses oversized output',async()=>{
 const root='projects/test-pos/databases/(default)/documents'; const request=async path=>path.endsWith(':listCollectionIds')?{collectionIds:['items']}:{documents:[{name:'projects/other-pos/databases/(default)/documents/items/x',updateTime:'2026-11-27T10:00:00Z'}]};
 await assert.rejects(collectSnapshot({projectId:'test-pos',readTime:'2026-11-27T10:00:00Z',request}));
 await assert.rejects(collectSnapshot({projectId:'test-pos',readTime:'2026-11-27T10:00:00Z',maximumBytes:1,request:async path=>path===root+':listCollectionIds'?{collectionIds:['items']}:{documents:[{name:root+'/items/x',fields:{x:{stringValue:'large'}},updateTime:'2026-11-27T10:00:00Z'}]}}));
});

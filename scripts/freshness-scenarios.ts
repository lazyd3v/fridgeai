// Opt-in integration audit. Run ONLY on Pi with FRIDGE_TEST_DIR pointing to a snapshot directory.
// Never opens the live database; every scenario restores a separate snapshot copy.
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createStore, type Store, type Item } from '../server/store.ts';
import { resolveProduct, resolveWithLuna, processFreshnessRecording, initialFreshness, localDate, type Resolver, type ProductEvent } from '../server/freshness.ts';
import { observeDoorVideoUrl, toMovements, type DoorEvents } from '../server/door-ai.ts';
const root = resolve(process.env.FRIDGE_TEST_DIR ?? '/INVALID');
assert.ok(root.startsWith('/home/roman/fridge-data/test-runs/'), 'Use an isolated Pi test directory');
const snapshot = join(root, 'snapshot.sqlite');
const hash = () => createHash('sha256').update(readFileSync(snapshot)).digest('hex');
const originalHash = hash();
const results: { name: string; status: string; detail?: unknown; error?: string }[] = [];
const signal = () => AbortSignal.timeout(60_000);
const at = '2026-10-24T12:00:00+02:00';
const forbidden: Resolver = async () => { throw new Error('Unexpected LLM call'); };
const fixedDate: Resolver = async input => ({ resolution: input.fixedMatch?.resolution ?? 'new', productId: input.fixedMatch?.productId ?? null, product: input.observedProduct.product, expirationDate: '2026-10-29' });
function save() { writeFileSync(join(root, 'scenario-results.json'), JSON.stringify({ snapshotSha256: originalHash, results }, null, 2)); }
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { const detail = await fn(); results.push({ name, status: 'PASS', detail }); console.log('PASS', name, detail === undefined ? '' : JSON.stringify(detail)); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); results.push({ name, status: 'FAIL', error: message }); console.log('FAIL', name, message); }
  save();
}
let seq = 0;
function restored(clean = true) {
 const path = join(root, `scenario-${++seq}.sqlite`); copyFileSync(snapshot, path);
 if (clean) { const db = new DatabaseSync(path); db.exec('DELETE FROM recording_events; DELETE FROM recordings; DELETE FROM inventory_log; DELETE FROM items;'); db.close(); }
 return { path, store: createStore(path) };
}
function recording(store: Store, path: string, id: string, when = at) {
 store.createRecording(id, '/synthetic-scenario.mp4');
 const db = new DatabaseSync(path); db.prepare('UPDATE recordings SET createdAt=? WHERE id=?').run(when,id); db.close();
 store.setRecording(id, 'processing');
}
function seed(store: Store, path: string, name: string, date = '2026-10-30') {
 const item = store.addItem(name,1); store.correctFreshness(item.id,{expirationDate:date});
 const db = new DatabaseSync(path); db.prepare('UPDATE items SET createdAt=? WHERE id=?').run(at,item.id); db.close(); return item.id;
}
async function movement(store: Store,path: string,id: string,name: string,direction: 'added'|'removed',when=at,resolver: Resolver=forbidden,date: string|null=null) {
 recording(store,path,id,when); await processFreshnessRecording(store,id,[{name,direction,quantity:1,expirationDate:date}],signal(),resolver);
}
function packageAt(store: Store,id: string) { return store.listPackages().find(i=>i.id===id)!; }
function returnFixture(name='Eggs'): Item {
 return {id:'9e9ea643-dc41-4e20-8a63-afaa23d6c101',name,quantity:1,createdAt:'2026-10-20T10:00:00Z',freshness:{...initialFreshness(),needsEstimate:false,state:'taken_out',removedAt:at,deadline:'2026-10-24T15:00:00+02:00',expirationDate:'2026-10-30'}};
}

await check('Snapshot restores exactly after disposable mutation',()=>{
 const {path,store}=restored(false); const baseline=store.listPackages(); store.addItem('SNAPSHOT TEST',1); store.close();
 for(const suffix of ['', '-wal','-shm']) if(existsSync(path+suffix)) unlinkSync(path+suffix);
 copyFileSync(snapshot,path); const reopened=createStore(path); try {assert.deepEqual(reopened.listPackages(),baseline);return {preservedProducts:baseline.length};}finally{reopened.close();}
});
await check('New exact date requires no model call',async()=>{
 const {path,store}=restored(); try{await movement(store,path,'add','Potatoes','added',at,forbidden,'2026-11-02');const item=store.listItems()[0];assert.equal(item.freshness!.expirationDate,'2026-11-02');assert.equal(item.freshness!.needsEstimate,false);}finally{store.close();}
});
await check('Same title already inside creates another package',async()=>{
 const {path,store}=restored();try{const old=seed(store,path,'Eggs');await movement(store,path,'add','Eggs','added',at,forbidden,'2026-11-02');assert.equal(store.listItems().length,2);assert.equal(packageAt(store,old).freshness!.expirationDate,'2026-10-30');}finally{store.close();}
});
await check('Return before deadline preserves identity and date',async()=>{
 const {path,store}=restored();try{const id=seed(store,path,'Eggs');await movement(store,path,'out',' eggs ','removed');await movement(store,path,'back','EGGS','added','2026-10-24T12:30:00+02:00');assert.equal(store.listItems()[0].id,id);assert.equal(packageAt(store,id).freshness!.expirationDate,'2026-10-30');}finally{store.close();}
});
await check('Three-hour boundary and restart persistence',async()=>{
 const fixture=restored();let store=fixture.store;try{const id=seed(store,fixture.path,'Eggs');await movement(store,fixture.path,'out','Eggs','removed');store.close();store=createStore(fixture.path);store.expireTakenOut('2026-10-24T12:59:59.999Z');assert.equal(packageAt(store,id).freshness!.state,'taken_out');store.expireTakenOut('2026-10-24T13:00:00.000Z');assert.equal(packageAt(store,id).freshness!.finishReason,'timeout');}finally{store.close();}
});
await check('Explicit finish excludes the old package from new matching',async()=>{
 const {path,store}=restored();try{const id=seed(store,path,'Eggs');await movement(store,path,'out','Eggs','removed');store.removeItem(id,'agent');await movement(store,path,'new','Eggs','added','2026-10-24T12:30:00+02:00',forbidden,'2026-11-02');assert.notEqual(store.listItems()[0].id,id);assert.equal(packageAt(store,id).freshness!.finishReason,'explicit');}finally{store.close();}
});
await check('Repeated use preserves first inferred opening timestamp',async()=>{
 const {path,store}=restored();try{const id=seed(store,path,'Sour cream');await movement(store,path,'out','Sour cream','removed');await movement(store,path,'back','Sour cream','added','2026-10-24T12:30:00+02:00',fixedDate);const opened=packageAt(store,id).freshness!.openedAt;await movement(store,path,'out2','Sour cream','removed','2026-10-24T13:00:00+02:00');await movement(store,path,'back2','Sour cream','added','2026-10-24T13:30:00+02:00');assert.equal(packageAt(store,id).freshness!.openedAt,opened);assert.equal(packageAt(store,id).freshness!.expirationDate,'2026-10-29');}finally{store.close();}
});
await check('Explicit opening date stays confirmed after return',async()=>{
 const item=returnFixture('Sour cream');item.freshness!.openedAt='2026-10-23';item.freshness!.possiblyOpened=false;
 const r=await resolveProduct([item],{product:'Sour cream',action:'added',expirationDate:null},at,signal(),fixedDate);
 assert.equal(r.freshness.openedAt,'2026-10-23');assert.equal(r.freshness.possiblyOpened,false,'Confirmed opening date became only possibly opened');
});
await check('Semantic return records first possible opening',async()=>{
 const item=returnFixture('Sour cream 200 g');
 const r=await resolveProduct([item],{product:'cream tub',action:'added',expirationDate:null},at,signal(),async()=>({resolution:'existing',productId:item.id,product:item.name,expirationDate:'2026-10-27'}));
 assert.equal(r.freshness.openedAt,item.freshness!.removedAt,'LLM-matched return lost opening anchor');
});
await check('Date conflict retains existing date and supplied evidence',async()=>{
 const item=returnFixture();const r=await resolveProduct([item],{product:'Eggs',action:'added',expirationDate:'2026-11-10'},at,signal(),forbidden);assert.equal(r.freshness.expirationDate,'2026-10-30');assert.match(r.freshness.conflict!,/2026-11-10/);
});
await check('Provider failure saves identified addition with pending estimate',async()=>{
 const {path,store}=restored();try{await movement(store,path,'add','Bananas','added',at,forbidden);assert.equal(store.listItems().length,1);assert.equal(store.listItems()[0].freshness!.needsEstimate,true);}finally{store.close();}
});
await check('Unknown identity on removal cannot mutate inventory',async()=>{
 const {path,store}=restored();try{seed(store,path,'Eggs');const before=store.listPackages();await assert.rejects(movement(store,path,'remove','Mystery packet','removed',at,async()=>({resolution:'uncertain',productId:null,product:'Mystery packet',expirationDate:null})));assert.deepEqual(store.listPackages(),before);}finally{store.close();}
});
await check('Same-session out/back survives recording replay',async()=>{
 const {path,store}=restored();try{const id=seed(store,path,'Eggs');recording(store,path,'cycle');const events=[{name:'Eggs',direction:'removed' as const,quantity:1},{name:'Eggs',direction:'added' as const,quantity:1}];await processFreshnessRecording(store,'cycle',events,signal(),forbidden);await processFreshnessRecording(store,'cycle',events,signal(),forbidden);assert.equal(store.listPackages().length,1);assert.equal(store.listItems()[0].id,id);}finally{store.close();}
});
await check('Snapshot historical failures reproduce queue blocking',()=>{
 const {store}=restored(false);try{assert.equal(store.nextRecording()?.status,'failed');return {nextRecording:store.nextRecording()?.id,status:store.nextRecording()?.status};}finally{store.close();}
});
await check('Unknown legacy age is not reset by migration',()=>{
 const {store}=restored(false);try{assert.ok(store.listPackages().every(i=>i.freshness?.legacy && i.freshness.expirationDate===null));}finally{store.close();}
});

// Real provider checks: one product per request, no test doubles.
for (const [phrase, expected] of [['3 days from today','2026-10-27'],['3 days','2026-10-27'],['tomorrow','2026-10-25'],['3 days after opening',null]] as const) {
 await check(`Live Luna date: ${phrase}`,async()=>{
  const r=await resolveWithLuna({recordingDate:'2026-10-24',recordingTimestamp:at,timezone:'Europe/Paris',inventory:[],observedProduct:{product:'Sour cream',action:'added',expirationDate:phrase},fixedMatch:{resolution:'new',productId:null}},signal());
  assert.equal(r.expirationDate,expected);return r;
 });
}
await check('Live Luna estimate for new bananas',async()=>{
 const r=await resolveProduct([],{product:'Bananas',action:'added',expirationDate:null},at,signal());assert.equal(r.result.resolution,'new');assert.ok(r.freshness.expirationDate);assert.equal(r.freshness.needsEstimate,false);return r.result;
});
await check('Live Luna late addition restores or preserves uncertainty',async()=>{
 const item=returnFixture('Eggs');item.freshness!.state='finished';item.freshness!.finishReason='timeout';
 const r=await resolveProduct([item],{product:'Eggs',action:'added',expirationDate:null},'2026-10-24T16:00:00+02:00',signal());assert.ok(['existing','uncertain'].includes(r.result.resolution), JSON.stringify(r.result));if(r.result.resolution==='existing')assert.equal(r.result.productId,item.id);assert.equal(r.freshness.expirationDate,'2026-10-30');return r.result;
});
await check('Live Luna ambiguity does not invent package identity',async()=>{
 const a=returnFixture('Sour cream'),b={...a,id:'cc8b3bbf-e0b6-4f2b-aecc-cb06fb4508ad',freshness:{...a.freshness!,expirationDate:'2026-11-01'}};
 const r=await resolveProduct([a,b],{product:'Sour cream',action:'added',expirationDate:null},at,signal());assert.equal(r.result.resolution,'uncertain');assert.equal(r.freshness.dateSource,'provisional');return r.result;
});
await check('Live Luna resolves month-only dates to approved month start',async()=>{
 const r=await resolveWithLuna({recordingDate:'2026-10-24',recordingTimestamp:at,timezone:'Europe/Paris',inventory:[],observedProduct:{product:'Cheese',action:'added',expirationDate:'July 2027'},fixedMatch:{resolution:'new',productId:null}},signal());
 // User-approved convention: retain original wording, resolve to month start.
 assert.equal(r.expirationDate,'2027-07-01');return r;
});

const videos = JSON.parse(readFileSync(join(root,'video-inputs.json'),'utf8')) as {label:string;url:string}[];
const videoResults: Record<string,DoorEvents> = {};
await Promise.all(videos.map(video=>check(`Qwen video observation: ${video.label}`,async()=>{
 const {store}=restored(false);
 try { const observed=await observeDoorVideoUrl(video.url,store.listItems(),AbortSignal.timeout(180_000));videoResults[video.label]=observed;writeFileSync(join(root,`video-${video.label}.json`),JSON.stringify(observed,null,2));assert.ok(observed.events.length,'No products observed');return observed; }
 finally{store.close();}
})));
for(const label of Object.keys(videoResults)) await check(`Actual video events applied to restored snapshot: ${label}`,async()=>{
 const {store,path}=restored(false);try{const observed=videoResults[label];recording(store,path,`video-${label}`,'2026-10-24T22:05:00+02:00');await processFreshnessRecording(store,`video-${label}`,toMovements(observed).movements,AbortSignal.timeout(300_000));return {events:observed.events,packages:store.listPackages().map(i=>({id:i.id,name:i.name,state:i.freshness!.state,date:i.freshness!.expirationDate,source:i.freshness!.dateSource,pending:i.freshness!.needsEstimate}))};}finally{store.close();}
});
await check('Read-only snapshot was never modified',()=>assert.equal(hash(),originalHash));
save();console.log('SUMMARY',JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,resultsFile:join(root,'scenario-results.json')}));

process.exitCode = results.some(result => result.status === "FAIL") ? 1 : 0;

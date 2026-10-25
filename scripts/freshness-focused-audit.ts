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
const signal = () => AbortSignal.timeout(120_000);
const at = '2026-10-24T12:00:00+02:00';
const forbidden: Resolver = async () => { throw new Error('Unexpected LLM call'); };
const fixedDate: Resolver = async input => ({ resolution: input.fixedMatch?.resolution ?? 'new', productId: input.fixedMatch?.productId ?? null, product: input.observedProduct.product, expirationDate: '2026-10-29' });
function save() { writeFileSync(join(root, process.env.RESULT_FILE || 'scenario-results.json'), JSON.stringify({ snapshotSha256: originalHash, results }, null, 2)); }
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  if(process.env.CHECK_FILTER && !name.includes(process.env.CHECK_FILTER)) return;
  try { const detail = await fn(); results.push({ name, status: 'PASS', detail }); console.log('PASS', name, detail === undefined ? '' : JSON.stringify(detail)); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); results.push({ name, status: 'FAIL', error: message }); console.log('FAIL', name, message); }
  save();
}
let seq = 0;
function restored(clean = true) {
 const path = join(root, `${process.env.DB_PREFIX || "scenario"}-${++seq}.sqlite`); copyFileSync(snapshot, path);
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

// All writes go to disposable copies of the captured snapshot.
await check('Late return after three-hour timeout preserves package and date',async()=>{
 const {path,store}=restored();try{
 const id=seed(store,path,'Eggs');const created=packageAt(store,id).createdAt;
 await movement(store,path,'out','Eggs','removed');store.expireTakenOut('2026-10-24T14:00:00Z');
 assert.equal(packageAt(store,id).freshness!.finishReason,'timeout');
 await movement(store,path,'back','Eggs','added','2026-10-24T16:00:00+02:00');
 const item=store.listItems()[0];assert.equal(item.id,id);assert.equal(item.createdAt,created);
 assert.equal(item.freshness!.expirationDate,'2026-10-30');assert.equal(store.listPackages().length,1);return item;
 }finally{store.close();}
});
for(const semantic of [false,true]) await check(`Confirmed opening survives ${semantic?'semantic':'exact'} return (live Luna)`,async()=>{
 const {path,store}=restored();try{
 const id=seed(store,path,'Sour cream');store.correctFreshness(id,{openedAt:'2026-10-23'});
 await movement(store,path,'out','Sour cream','removed',at,resolveWithLuna);
 await movement(store,path,'back',semantic?'cream tub':'Sour cream','added','2026-10-24T12:30:00+02:00',resolveWithLuna);
 const item=store.listItems()[0];assert.equal(item.id,id);assert.equal(item.freshness!.openedAt,'2026-10-23');
 assert.equal(item.freshness!.possiblyOpened,false);assert.ok(item.freshness!.expirationDate!<='2026-10-30');return item;
 }finally{store.close();}
});
await check('Semantic return infers opening once and repeated use preserves it (live Luna)',async()=>{
 const {path,store}=restored();try{
 const id=seed(store,path,'Sour cream 200 g');await movement(store,path,'out','Sour cream 200 g','removed');
 await movement(store,path,'back','cream tub','added','2026-10-24T12:30:00+02:00',resolveWithLuna);
 const first=packageAt(store,id);assert.equal(first.freshness!.openedAt,at);assert.equal(first.freshness!.possiblyOpened,true);
 await movement(store,path,'out2',first.name,'removed','2026-10-24T13:00:00+02:00',resolveWithLuna);
 await movement(store,path,'back2',first.name,'added','2026-10-24T13:30:00+02:00',resolveWithLuna);
 const last=packageAt(store,id);assert.equal(last.freshness!.openedAt,at);assert.equal(store.listPackages().length,1);return last;
 }finally{store.close();}
});
for(let trial=1;trial<=2;trial++) await check(`July 2027 persists as July 1 (live Luna), trial ${trial}`,async()=>{
 const {path,store}=restored();try{await movement(store,path,'add','Cheese','added',at,resolveWithLuna,'July 2027');
 const item=store.listItems()[0];assert.equal(item.freshness!.expirationDate,'2027-07-01');assert.equal(item.freshness!.dateSource,'supplied');return item;}finally{store.close();}
});

const {diagnosticPrompt,parseDiagnosticEvents}=await import('./door-audit-diagnostics.ts');
const {normalizeDoorObservation}=await import('../server/door-normalize.ts');
for(let trial=1;trial<=2;trial++) await check(`Real addition video with juice absent, trial ${trial}`,async()=>{
 const {path,store}=restored(false);try{
 const db=new DatabaseSync(path);db.exec("DELETE FROM items WHERE lower(name) LIKE '%juice%' OR lower(coalesce(notes,'')) LIKE '%juice%';");db.close();
 const inventory=store.listItems();assert.ok(!JSON.stringify(inventory).toLowerCase().includes('juice'));
 writeFileSync(join(root,`absent-juice-${trial}-context.json`),JSON.stringify(inventory.map(({name,notes})=>({name,notes})),null,2));
 const video='data:video/mp4;base64,'+readFileSync('/home/roman/fridge-data/test-runs/gemini-20261024/second.mp4').toString('base64');
 let rawOutput='';let diagnostics:unknown;
 const request:typeof fetch=async(url,init)=>{const body=JSON.parse(init!.body as string);body.messages[0].content+=diagnosticPrompt;return fetch(url,{...init,body:JSON.stringify(body)});};
 const observed=await observeDoorVideoUrl(video,inventory,AbortSignal.timeout(240_000),request,undefined,undefined,async(raw,signal)=>{
 rawOutput=raw;let value=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));if(Array.isArray(value))value={events:value};
 const parsed=parseDiagnosticEvents(JSON.stringify(value));diagnostics=parsed.diagnostics;return normalizeDoorObservation(JSON.stringify(parsed.observed),signal);
 });
 writeFileSync(join(root,`absent-juice-${trial}-observed.json`),JSON.stringify({rawOutput,diagnostics,observed},null,2));
 const juice=observed.events.find(e=>/juice/i.test(e.product));assert.ok(juice,'Video did not identify juice');assert.equal(juice.action,'added');
 assert.equal(observed.events.length,3);assert.ok(observed.events.every(e=>e.action==='added'));
 assert.ok(observed.events.some(e=>/potato/i.test(e.product)));assert.ok(observed.events.some(e=>/cheese/i.test(e.product)));
 recording(store,path,'video','2026-10-24T20:07:31Z');await processFreshnessRecording(store,'video',toMovements(observed).movements,AbortSignal.timeout(240_000));
 const item=store.listItems().find(i=>/juice/i.test(i.name));assert.ok(item);assert.ok(!inventory.some(i=>i.id===item.id));
 assert.equal(item.freshness!.dateSource,'estimated');assert.ok(item.freshness!.expirationDate!>'2026-10-24');assert.equal(item.freshness!.openedAt,null);assert.equal(item.freshness!.needsEstimate,false);
 return {observed,juice:item,added:store.listItems().filter(i=>!inventory.some(old=>old.id===i.id))};
 }finally{store.close();}
});
await check('Backend-only juice addition with empty inventory (synthetic observation, live Luna)',async()=>{
 const {path,store}=restored();try{
 await movement(store,path,'juice','Juice','added',at,resolveWithLuna);
 const added=store.listItems()[0];assert.ok(added);assert.equal(added.freshness!.dateSource,'estimated');
 assert.ok(added.freshness!.expirationDate!>'2026-10-24');assert.equal(added.freshness!.needsEstimate,false);assert.equal(added.freshness!.openedAt,null);
 await movement(store,path,'out','Juice','removed');store.expireTakenOut('2026-10-24T14:00:00Z');
 await movement(store,path,'back','Juice','added','2026-10-24T16:00:00+02:00',resolveWithLuna);
 const back=store.listItems()[0];assert.equal(back.id,added.id);assert.equal(back.freshness!.openedAt,at);
 assert.equal(back.freshness!.possiblyOpened,true);assert.ok(back.freshness!.expirationDate!<=added.freshness!.expirationDate!);
 return {added,returned:back};
 }finally{store.close();}
});
await check('Snapshot unchanged' ,()=>assert.equal(hash(),originalHash));
save();console.log('SUMMARY',JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length}));
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;

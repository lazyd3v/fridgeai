// Opt-in Pi-only audit. All writes go to a restored snapshot, never the live database.
import { readFileSync,writeFileSync,copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { observeDoorVideoUrl,toMovements } from '../server/door-ai.ts';
import { normalizeDoorObservation } from '../server/door-normalize.ts';
import { initialFreshness,resolveProduct,processFreshnessRecording } from '../server/freshness.ts';
const root=process.env.FRIDGE_TEST_DIR!;assert.ok(root.startsWith('/home/roman/fridge-data/test-runs/formatter-retest-'));
const previous='/home/roman/fridge-data/test-runs/freshness-20261024-220940';
const videos=JSON.parse(readFileSync(join(previous,'video-inputs.json'),'utf8'));
const diagnostics=JSON.parse(readFileSync(join(previous,'video-diagnostics.json'),'utf8'));
const results:unknown[]=[];
async function check(name:string,fn:()=>Promise<unknown>){try{const detail=await fn();results.push({name,status:'PASS',detail});console.log('PASS',name,JSON.stringify(detail));}catch(e){results.push({name,status:'FAIL',error:e instanceof Error?e.message:String(e)});console.log('FAIL',name,e instanceof Error?e.message:String(e));}writeFileSync(join(root,'formatter-results.json'),JSON.stringify(results,null,2));}
await check('Original failing Qwen array converts without changing observations',async()=>{const raw=diagnostics.find((r:any)=>r.video==='first'&&r.mode==='baseline-repeat').evidence.choices[0].message.content;const result=await normalizeDoorObservation(raw,AbortSignal.timeout(90000));assert.deepEqual(result.events,JSON.parse(raw));return result;});
await check('Month-only date is preserved by formatter',async()=>{const events=[{product:'Cheese',action:'added',expirationDate:'July 2027'}];const result=await normalizeDoorObservation(JSON.stringify(events),AbortSignal.timeout(90000));assert.deepEqual(result.events,events);return result;});
for(let attempt=1;attempt<=2;attempt++)for(const video of videos){
 await check(`Video ${video.label}, attempt ${attempt}: Qwen → Luna → validation`,async()=>{
  const path=join(root,`video-${video.label}-${attempt}.sqlite`);copyFileSync(join(root,'snapshot.sqlite'),path);const store=createStore(path);
  let raw:string|undefined;let normalizerCalls=0;
  try{
   const observed=await observeDoorVideoUrl(video.url,store.listItems(),AbortSignal.timeout(240000),fetch,undefined,async(text,signal)=>{raw=text;normalizerCalls++;return normalizeDoorObservation(text,signal);});
   assert.equal(normalizerCalls,1);
   const result:any={raw,observed,normalizerCalls};
   writeFileSync(join(root,`video-${video.label}-${attempt}.json`),JSON.stringify(result,null,2));
   const id=`test-${video.label}-${attempt}`;store.createRecording(id,'/isolated-test.mp4');const db=new DatabaseSync(path);db.prepare('UPDATE recordings SET createdAt=? WHERE id=?').run(video.label==='first'?'2026-10-24T20:05:31Z':'2026-10-24T20:07:31Z',id);db.close();store.setRecording(id,'processing');
   try{await processFreshnessRecording(store,id,toMovements(observed).movements,AbortSignal.timeout(240000));result.application='applied to disposable copy';}catch(e){result.application='blocked safely';result.applicationError=e instanceof Error?e.message:String(e);}
   result.packages=store.listPackages().length;return result;
  }finally{store.close();}
 });
}
const fixture=()=>({id:'9e9ea643-dc41-4e20-8a63-afaa23d6c101',name:'Sour cream',quantity:1,createdAt:'2026-10-20T10:00:00Z',freshness:{...initialFreshness(),needsEstimate:false,state:'taken_out' as const,removedAt:'2026-10-24T12:00:00+02:00',deadline:'2026-10-24T15:00:00+02:00',expirationDate:'2026-10-30'}});
await check('Confirmed opening history remains confirmed',async()=>{const item=fixture();item.freshness.openedAt='2026-10-23';const r=await resolveProduct([item],{product:item.name,action:'added',expirationDate:null},'2026-10-24T12:30:00+02:00',AbortSignal.timeout(90000),async()=>({resolution:'existing',productId:item.id,product:item.name,expirationDate:'2026-10-29'}));assert.equal(r.freshness.possiblyOpened,false);});
await check('Semantic match retains an opening anchor',async()=>{const item=fixture();const r=await resolveProduct([item],{product:'cream tub',action:'added',expirationDate:null},'2026-10-24T12:30:00+02:00',AbortSignal.timeout(90000),async()=>({resolution:'existing',productId:item.id,product:item.name,expirationDate:'2026-10-29'}));assert.equal(r.freshness.openedAt,item.freshness.removedAt);});
await check('Live late return does not silently become a new purchase',async()=>{const item={...fixture(),name:'Eggs',freshness:{...fixture().freshness,state:'finished' as const,finishReason:'timeout' as const}};const r=await resolveProduct([item],{product:'Eggs',action:'added',expirationDate:null},'2026-10-24T16:00:00+02:00',AbortSignal.timeout(90000));writeFileSync(join(root,'late-return.json'),JSON.stringify(r,null,2));assert.notEqual(r.result.resolution,'new');return r;});
console.log('DONE');

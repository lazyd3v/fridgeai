// Real agent calls against an isolated restored snapshot; never touches the live inventory.
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.ts';
import { createAgentLoop } from '../server/agent.ts';
import { resolveProduct, initialFreshness, resolveWithLuna } from '../server/freshness.ts';
const root=process.env.FRIDGE_TEST_DIR!;assert.ok(root.startsWith('/home/roman/fridge-data/test-runs/'));
const path=join(root,'conversation.sqlite');copyFileSync(join(root,'snapshot.sqlite'),path);
const db=new DatabaseSync(path);db.exec('DELETE FROM items; DELETE FROM recordings; DELETE FROM recording_events; DELETE FROM inventory_log;');db.close();
const store=createStore(path);const milk=store.addItem('Milk',1);store.addItem('Eggs',1);
const run=createAgentLoop({getInventory:store.listItems,getPackages:store.listPackages,getStatus:()=>({test:true}),addItem:store.addItem,removeItem:id=>store.removeItem(id,'agent'),correctFreshness:(id,patch)=>store.correctFreshness(id,patch,'agent'),updateItem:store.updateItem});
const results:unknown[]=[];
async function check(name:string,fn:()=>Promise<unknown>){try{const detail=await fn();results.push({name,status:'PASS',detail});console.log('PASS',name,JSON.stringify(detail));}catch(e){results.push({name,status:'FAIL',error:e instanceof Error?e.message:String(e)});console.log('FAIL',name,e instanceof Error?e.message:String(e));}writeFileSync(join(root,'conversation-results.json'),JSON.stringify(results,null,2));}
try{
await check('Real conversation sets milk expiration date',async()=>{const reply=await run('Set the expiration date of the milk to November 2, 2026.');assert.equal(store.listItems().find(i=>i.id===milk.id)!.freshness!.expirationDate,'2026-11-02');assert.ok(reply.toolCalls.includes('set_product_date'));return {text:reply.output,toolCalls:reply.toolCalls};});
await check('Real conversation sets opening date independently',async()=>{const reply=await run('I opened the milk on October 23, 2026. Save its opening date.');const f=store.listItems().find(i=>i.id===milk.id)!.freshness!;assert.equal(f.openedAt,'2026-10-23');assert.equal(f.expirationDate,'2026-11-02');return {text:reply.output,toolCalls:reply.toolCalls};});
await check('Real conversation explicitly clears a date',async()=>{const reply=await run('Clear the milk expiration date; it is unknown. Keep its opening date.');const f=store.listItems().find(i=>i.id===milk.id)!.freshness!;assert.equal(f.expirationDate,null);assert.equal(f.openedAt,'2026-10-23');return {text:reply.output,toolCalls:reply.toolCalls};});
await check('Real conversation finishes a taken-out product',async()=>{const eggs=store.listItems().find(i=>i.name==='Eggs')!;const sql=new DatabaseSync(path);sql.prepare('UPDATE items SET freshness=? WHERE id=?').run(JSON.stringify({...eggs.freshness,state:'taken_out',removedAt:'2026-10-24T20:00:00Z',deadline:'2026-10-24T23:00:00Z'}),eggs.id);sql.close();const reply=await run('I finished the eggs I took out. Mark that package finished.');assert.equal(store.listPackages().find(i=>i.id===eggs.id)!.freshness!.finishReason,'explicit');return {text:reply.output,toolCalls:reply.toolCalls};});
for(const [stamp,phrase,expected] of [['2026-10-24T23:30:00Z','tomorrow','2026-10-26'],['2026-12-31T12:00:00+01:00','3 days from today','2027-01-03']] as const){await check(`Live date boundary ${stamp}`,async()=>{const result=await resolveProduct([],{product:'Rice',action:'added',expirationDate:phrase},stamp,AbortSignal.timeout(60000));assert.equal(result.freshness.expirationDate,expected);return result.result;});}
await check('After-opening duration with known opening date',async()=>{const item={id:milk.id,name:'Milk',quantity:1,createdAt:'2026-10-20T10:00:00Z',freshness:{...initialFreshness(),openedAt:'2026-10-23',needsEstimate:false,state:'taken_out' as const,removedAt:'2026-10-24T12:00:00+02:00',deadline:'2026-10-24T15:00:00+02:00'}};const r=await resolveProduct([item],{product:'Milk',action:'added',expirationDate:'3 days after opening'},'2026-10-24T12:30:00+02:00',AbortSignal.timeout(60000));assert.equal(r.freshness.expirationDate,'2026-10-26');return r.result;});
}finally{store.close();}

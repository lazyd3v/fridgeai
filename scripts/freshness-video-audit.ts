// Diagnostic only: compare the deployed Qwen request with explicit audio / strict JSON.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { observeDoorVideoUrl, doorEventsSchema } from '../server/door-ai.ts';
import { createStore } from '../server/store.ts';
import { resolveProduct, initialFreshness, resolveWithLuna } from '../server/freshness.ts';
const root=process.env.FRIDGE_TEST_DIR!;
assert.ok(root.startsWith('/home/roman/fridge-data/test-runs/'));
const videos=JSON.parse(readFileSync(join(root,'video-inputs.json'),'utf8'));
const inventoryDb=createStore(join(root,'scenario-1.sqlite')); const inventory=inventoryDb.listItems(); inventoryDb.close();
const results: unknown[]=[];
for(const video of videos){
 execFileSync('ffmpeg',['-v','error','-y','-i',join(root,video.label+'.mp4'),'-vn','-ac','1','-ar','16000',join(root,video.label+'.wav')]);
 execFileSync('ffmpeg',['-v','error','-y','-i',join(root,video.label+'.mp4'),'-vf','fps=1/4,scale=320:-1,tile=3x2','-frames:v','1',join(root,video.label+'-frames.jpg')]);
 for(const mode of ['baseline-repeat','explicit-audio','explicit-audio-strict']){
  let evidence: unknown;
  const request: typeof fetch=async(url,options)=>{
   const body=JSON.parse(options!.body as string);
   if(mode!=='baseline-repeat')body.messages[1].content.push({type:'input_audio',input_audio:{data:readFileSync(join(root,video.label+'.wav')).toString('base64'),format:'wav'}});
   if(mode==='explicit-audio-strict')body.response_format={type:'json_schema',json_schema:{name:'door_events',strict:true,schema:z.toJSONSchema(doorEventsSchema)}};
   const response=await fetch(url,{...options,body:JSON.stringify(body)});
   if(response.ok){const raw=await response.clone().json();evidence={model:raw.model,provider:raw.provider,choices:raw.choices,usage:raw.usage};}
   else evidence={httpStatus:response.status};
   return response;
  };
  try{const observed=await observeDoorVideoUrl(video.url,inventory,AbortSignal.timeout(180000),request);results.push({video:video.label,mode,status:'parsed',observed,evidence});console.log(JSON.stringify({video:video.label,mode,observed}));}
  catch(error){results.push({video:video.label,mode,status:'failed',error:error instanceof Error?error.message:String(error),evidence});console.log(JSON.stringify({video:video.label,mode,error:error instanceof Error?error.message:String(error)}));}
  writeFileSync(join(root,'video-diagnostics.json'),JSON.stringify(results,null,2));
 }
}
// Observe late-return ambiguity without imposing an unsupported identity expectation.
const old={id:'9e9ea643-dc41-4e20-8a63-afaa23d6c101',name:'Eggs',quantity:1,createdAt:'2026-10-20T10:00:00Z',freshness:{...initialFreshness(),needsEstimate:false,state:'finished' as const,finishReason:'timeout' as const,removedAt:'2026-10-24T12:00:00+02:00',deadline:'2026-10-24T15:00:00+02:00',expirationDate:'2026-10-30'}};
let lateRaw:unknown;
const late=await resolveProduct([old],{product:'Eggs',action:'added',expirationDate:null},'2026-10-24T16:00:00+02:00',AbortSignal.timeout(60000),async(input,signal)=>{lateRaw=await resolveWithLuna(input,signal);return lateRaw as Awaited<ReturnType<typeof resolveWithLuna>>;});
writeFileSync(join(root,'late-return-diagnostic.json'),JSON.stringify({raw:lateRaw,result:late},null,2));console.log('LATE_RETURN',JSON.stringify(late));

import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { doorEventsSchema } from '../server/door-normalize.ts';
const root='/home/roman/fridge-data/test-runs/gemini-20261024';
const schema=z.toJSONSchema(doorEventsSchema);delete schema.$schema;
const results=[];
for(const mode of ['text-full-schema','video-no-schema','video-simple-schema']) {
 const body:any={model:'google/gemini-3.8-flash',max_tokens:4096,messages:[{role:'user',content:mode.startsWith('text')?'Return an empty events array.':[{type:'video_url',video_url:{url:'data:video/mp4;base64,'+readFileSync(root+'/second.mp4').toString('base64')},processing:'static'},{type:'text',text:'Describe the transferred products and any spoken expiration date.'}]}]};
 if(mode!=='video-no-schema')body.response_format={type:'json_schema',json_schema:{name:'probe',strict:true,schema:mode.startsWith('text')?schema:{type:'object',properties:{description:{type:'string'}},required:['description'],additionalProperties:false}}};
 const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const d=await r.json();const result={mode,status:r.status,content:d.choices?.[0]?.message?.content,error:d.error};results.push(result);console.log(JSON.stringify(result));writeFileSync(root+'/probes.json',JSON.stringify(results,null,2));
}

// Pi-only comparison: reads a snapshot; never writes production inventory.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.ts';
import { observeDoorVideoUrl } from '../server/door-ai.ts';
import { doorEventsSchema, normalizeDoorObservation } from '../server/door-normalize.ts';
import { DOOR_OBSERVATION_PROMPT } from '../server/door-prompt.ts';
import { diagnosticPrompt, parseDiagnosticEvents } from './door-audit-diagnostics.ts';

const root = process.env.FRIDGE_TEST_DIR!;
assert.ok(root?.startsWith('/home/roman/fridge-data/test-runs/gemini-'));
const fixtures = root;
const store = createStore(join(root, 'snapshot.sqlite'));
const inventory = store.listItems();
store.close();
const results: unknown[] = [];
// Default to the revision-two configuration that passed all four fixture trials.
const model = process.env.AUDIT_MODEL || 'qwen/qwen3.8-omni-flash';
assert.ok(['google/gemini-3.8-flash', 'qwen/qwen3.8-omni-flash', 'qwen/qwen3.8-flash'].includes(model));
const isQwen = model === 'qwen/qwen3.8-omni-flash';
const isGemini = model.startsWith('google/');
const thinkingEffort = process.env.THINKING_EFFORT || 'medium';
assert.ok(['low', 'medium', 'high'].includes(thinkingEffort));
const withDiagnostics = (process.env.OBSERVATION_NOTES ?? '1') === '1';
const notesPrompt = model === 'qwen/qwen3.8-flash'
  ? diagnosticPrompt.replace('Indicate when a detail comes from speech.', 'Audio is unavailable; never describe spoken information.')
  : diagnosticPrompt;
const prompt = DOOR_OBSERVATION_PROMPT + (withDiagnostics ? notesPrompt : '');
writeFileSync(join(root, `${process.env.RESULT_NAME || 'prompt-v1'}-prompt.txt`), prompt);
async function runTrial(attempt: number, label: string) {
    const start = Date.now();
    let evidence: any;
    let diagnostics: unknown;
    let rawOutput: string | undefined;
    let formatterUsage: unknown;
    try {
      const url = `data:video/mp4;base64,${readFileSync(join(fixtures, `${label}.mp4`)).toString('base64')}`;
      const request: typeof fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body));
        body.model = model;
        body.messages[0].content = prompt;
        if ((process.env.INCLUDE_NOTES ?? '1') === '1') {
          const context = body.messages[1].content.find((part: any) => part.type === 'text');
          const value = JSON.parse(context.text);
          value.knownInventory = inventory.map(({ name, notes }) => ({ name, notes: notes ?? null }));
          context.text = JSON.stringify(value);
          writeFileSync(join(root, `${process.env.RESULT_NAME || 'prompt-v1'}-context.json`), JSON.stringify(value, null, 2));
        }
        if (isGemini && process.env.VIDEO_MODE) {
          assert.ok(['agentic','static'].includes(process.env.VIDEO_MODE));
          body.messages[1].content[0].processing = process.env.VIDEO_MODE;
        }
        if (process.env.DETAIL_FRAMES === '1') {
          body.messages[1].content.push({type:'text',text:'The following images are higher-detail frames from the SAME video at 6, 10, 14, and 18 seconds. Use them to identify the carried items; use the video for movement and audio. They are not additional transfers.'});
          for (const second of [6,10,14,18]) body.messages[1].content.push({type:'image_url',image_url:{url:'data:image/jpeg;base64,'+readFileSync(join(root,`${label}-${second}.jpg`)).toString('base64'),detail:'high'}});
        }
        if (process.env.NO_INVENTORY === '1') {
          const context = body.messages[1].content.find((part: any) => part.type === 'text');
          context.text = JSON.stringify({ task: 'Identify additions and removals during this door session.', knownInventory: [] });
        }
        body.reasoning = { effort: thinkingEffort };
        // Use Gemini's nullable type union; enforce length limits locally below.
        const schema = {type:'object',properties:{events:{type:'array',items:{
          type:'object',properties:{product:{type:'string'},action:{type:'string',enum:['added','removed']},
            expirationDate:{type:['string','null']}},required:['product','action','expirationDate'],additionalProperties:false,
        }}},required:['events'],additionalProperties:false};
        if (withDiagnostics) {
          const fields = ['notes'];
          Object.assign(schema.properties.events.items.properties,
            Object.fromEntries(fields.map(field => [field, { type: ['string', 'null'] }])));
          schema.properties.events.items.required.push(...fields);
        }
        body.provider = { require_parameters: true };
        body.response_format = { type: 'json_schema', json_schema: {
          name: 'door_events', strict: true, schema,
        } };
        if (isQwen) {
          body.reasoning = { enabled: false }; // Match the deployed Qwen observer.
          delete body.response_format;
          delete body.provider;
        }
        const response = await fetch(input, { ...init, body: JSON.stringify(body) });
        evidence = await response.clone().json();
        return response;
      };
      const observed = await observeDoorVideoUrl(url, inventory, AbortSignal.timeout(240000), request,
        process.env.OPENROUTER_API_KEY!, undefined, async raw => {
          rawOutput = raw;
          if (isQwen) {
            // Preserve notes mechanically; Luna structures the core event contract.
            // Reject unparseable observations rather than fabricate descriptions.
            const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
            const wrapped = JSON.stringify(Array.isArray(value) ? { events: value } : value);
            const parsed = parseDiagnosticEvents(wrapped);
            diagnostics = parsed.diagnostics;
            return normalizeDoorObservation(JSON.stringify(parsed.observed), AbortSignal.timeout(90000), async (input, init) => {
              const response = await fetch(input, init);
              formatterUsage = (await response.clone().json()).usage;
              return response;
            });
          }
          if (!withDiagnostics) return doorEventsSchema.parse(JSON.parse(raw));
          const parsed = parseDiagnosticEvents(raw);
          diagnostics = parsed.diagnostics;
          return parsed.observed;
        });
      const result = { label, attempt, schemaValid: true, elapsedMs: Date.now() - start,
        observed, diagnostics, rawOutput, formatterUsage, model: evidence.model, provider: evidence.provider, usage: evidence.usage,
        requestedMode: isGemini ? process.env.VIDEO_MODE || 'default' : 'provider default',
        requestedThinking: isQwen ? 'disabled (deployed Qwen setting)' : thinkingEffort,
        reasoningDetailTypes: (evidence.choices?.[0]?.message?.reasoning_details || []).map((d: any) => d.type) };
      results.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      const result = { label, attempt, schemaValid: false, elapsedMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error), evidence: evidence ? {
          model: evidence.model, provider: evidence.provider, usage: evidence.usage,
          error: evidence.error,
          choices: evidence.choices?.map((choice: any) => ({ finish_reason: choice.finish_reason, error: choice.error, content: choice.message?.content })),
        } : undefined };
      results.push(result);
      console.log(JSON.stringify(result));
    }
    writeFileSync(join(root, `${process.env.RESULT_NAME || 'prompt-v1'}-results.json`), JSON.stringify(results, null, 2));
}
const trials = Array.from({ length: Number(process.env.TRIALS || 2) }, (_, i) =>
  ['first', 'second'].map(label => ({ attempt: i + 1, label }))).flat();
if (process.env.PARALLEL_TRIALS === '1') {
  await Promise.all(trials.map(({ attempt, label }) => runTrial(attempt, label)));
} else {
  for (const { attempt, label } of trials) await runTrial(attempt, label);
}

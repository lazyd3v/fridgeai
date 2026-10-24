import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { HttpAgent } from '@ag-ui/client';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { createChat } from './chat.ts';
import { createAgUiBridge } from './agui.ts';
import type { RunStreamEvent } from '@openai/agents';

test('AG-UI client consumes streamed text and tools; replay never repeats writes', async () => {
  let runs = 0;
  const chat = createChat(':memory:', async (prompt, history, emit) => {
    runs++;
    assert.equal(history.length, 0);
    assert.equal(prompt, 'What is in my fridge?');
    emit?.({ type: 'run_item_stream_event', name: 'tool_called', item: { type: 'tool_call_item', rawItem: { type: 'function_call', callId: 'read-1', name: 'get_inventory', arguments: '{}' } } } as RunStreamEvent);
    emit?.({ type: 'run_item_stream_event', name: 'tool_output', item: { type: 'tool_call_output_item', rawItem: { type: 'function_call_result', callId: 'read-1', name: 'get_inventory', output: '[]', status: 'completed' } } } as RunStreamEvent);
    emit?.({ type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'Your fridge ' } } as RunStreamEvent);
    emit?.({ type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'is empty.' } } as RunStreamEvent);
    return { output: 'Your fridge is empty.', history: [], toolCalls: ['get_inventory'] };
  });
  const app = express(); app.use(express.json()); app.use(chat.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const thread = await (await fetch(`${base}/threads`, { method: 'POST' })).json();
    const message = { id: 'user-1', role: 'user' as const, content: 'What is in my fridge?' };
    const agent = new HttpAgent({ url: `${base}/threads/${thread.id}/run`, threadId: thread.id, initialMessages: [message] });
    const events: BaseEvent[] = [];
    agent.subscribe({ onEvent: ({ event }) => { events.push(event); } });
    await agent.runAgent();
    assert.ok(events.some(event => event.type === EventType.TOOL_CALL_RESULT));
    assert.equal(events.filter(event => event.type === EventType.TEXT_MESSAGE_CONTENT).length, 2);
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
    for (const event of events) assert.equal(EventSchemas.safeParse(event).success, true, event.type);
    assert.match(JSON.stringify(agent.messages), /Your fridge is empty/);
    const replay = new HttpAgent({ url: `${base}/threads/${thread.id}/run`, threadId: thread.id, initialMessages: [message] });
    await replay.runAgent(); assert.equal(runs, 1);
    assert.match(JSON.stringify(replay.messages), /Your fridge is empty/);
    const invalid = await fetch(`${base}/threads/${thread.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 'wrong', runId: 'run', messages: [message], tools: [], context: [] }) });
    assert.equal(invalid.status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); chat.close(); }
});

test('bridge keeps reasoning out of the UI and closes text messages', () => {
  const events: BaseEvent[] = [];
  const bridge = createAgUiBridge(event => events.push(event));
  bridge.event({ type: 'run_item_stream_event', name: 'reasoning_item_created', item: { type: 'reasoning_item', rawItem: { type: 'reasoning', content: [] } } } as unknown as RunStreamEvent);
  bridge.finish('Hello');
  assert.equal(events.length, 3);
  assert.equal(events[0].type, EventType.TEXT_MESSAGE_START);
  assert.equal(events[2].type, EventType.TEXT_MESSAGE_END);
});

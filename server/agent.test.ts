import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner, Usage, type Model, type ModelRequest, type ModelResponse } from '@openai/agents';
import { AGENT_MODEL, createFridgeAgent } from './agent.ts';
import { createStore } from './store.ts';

test('SDK loop executes a tool, feeds the result back, and returns a final answer', async () => {
  const store = createStore(':memory:');
  const calls: string[] = [];
  let turns = 0;
  const model: Model = {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      turns++;
      if (turns === 1) return { usage: new Usage(), output: [{ type: 'function_call', callId: 'add-apples', name: 'add_inventory_item', arguments: JSON.stringify({ name: 'Apples', quantity: 2 }), status: 'completed' }] };
      assert.match(JSON.stringify(request.input), /function_call_result/);
      assert.match(JSON.stringify(request.input), /Apples/);
      return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Added two apples.' }] }] };
    },
    async *getStreamedResponse() { throw new Error('Streaming not used'); },
  };
  try {
    assert.equal(AGENT_MODEL, 'gpt-6-luna');
    const agent = createFridgeAgent({ getInventory: store.listItems, addItem: store.addItem, getStatus: () => ({ door: 'closed' }) }, calls, model);
    const result = await new Runner({ tracingDisabled: true }).run(agent, 'Add two apples.', { maxTurns: 8 });
    assert.equal(result.finalOutput, 'Added two apples.');
    assert.equal(turns, 2);
    assert.deepEqual(calls, ['add_inventory_item']);
    assert.equal(store.listItems()[0].quantity, 2);
  } finally { store.close(); }
});

test('scan tool returns observations without inventory writes', async () => {
  let writes = 0;
  let turns = 0;
  const calls: string[] = [];
  const model: Model = {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      if (++turns === 1) return { usage: new Usage(), output: [{ type: 'function_call', callId: 'scan', name: 'scan_initial_inventory', arguments: JSON.stringify({ videoId: '5ab681ea-f603-43c9-b3bd-0dd3af1108e8' }), status: 'completed' }] };
      assert.match(JSON.stringify(request.input), /processing/);
      return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Scan started.' }] }] };
    },
    async *getStreamedResponse() { throw new Error('Streaming not used'); },
  };
  const agent = createFridgeAgent({ getInventory: () => [], getStatus: () => ({}), addItem: () => { writes++; }, scanInitialInventory: () => ({ scanId: 'test', status: 'processing' }), getInitialScan: () => ({ items: [] }) }, calls, model);
  await new Runner({ tracingDisabled: true }).run(agent, 'Scan the uploaded video only.');
  assert.equal(writes, 0);
  assert.deepEqual(calls, ['scan_initial_inventory']);
});

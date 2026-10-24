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

test('SDK edits and removes inventory with an audit trail', async () => {
  const store = createStore(':memory:');
  const item = store.addItem('Apples', 4, 'green', 'apple');
  let turn = 0;
  const model: Model = {
    async getResponse(): Promise<ModelResponse> {
      const output: ModelResponse['output'] = ++turn === 1
        ? [{ type: 'function_call', callId: 'update', name: 'update_inventory_item', arguments: JSON.stringify({ id: item.id, name: 'Apples', quantity: 2, notes: 'green' }), status: 'completed' }]
        : turn === 2 ? [{ type: 'function_call', callId: 'remove', name: 'remove_inventory_item', arguments: JSON.stringify({ id: item.id }), status: 'completed' }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }];
      return { usage: new Usage(), output };
    },
    async *getStreamedResponse() { throw new Error('unused'); },
  };
  try {
    const calls: string[] = [];
    await new Runner({ tracingDisabled: true }).run(createFridgeAgent({ getInventory: store.listItems, getStatus: () => ({}), addItem: store.addItem, updateItem: store.updateItem, removeItem: id => store.removeItem(id, 'agent') }, calls, model), 'Update then remove the apples.');
    assert.deepEqual(calls, ['update_inventory_item', 'remove_inventory_item']);
    assert.deepEqual(store.listItems(), []);
    const log = store.listLog();
    assert.equal(log[0].source, 'agent');
    assert.equal(JSON.parse(String(log[1].afterJson)).quantity, 2);
    assert.equal(JSON.parse(String(log[1].afterJson)).icon, 'apple');
    assert.throws(() => store.updateItem(item.id, 'Apples', 1, null), /no longer exists/);
  } finally { store.close(); }
});

test('conversation date tool sets and explicitly clears dates while preserving other fields', async () => {
  const store = createStore(':memory:');
  const item = store.addItem('Milk', 1);
  store.correctFreshness(item.id, { openedAt: '2026-10-24' });
  let turn = 0;
  const model: Model = {
    async getResponse(): Promise<ModelResponse> {
      turn++;
      return { usage: new Usage(), output: turn <= 2
        ? [{ type: 'function_call', callId: `date-${turn}`, name: 'set_product_date', arguments: JSON.stringify({ id: item.id, field: 'expirationDate', date: turn === 1 ? '2026-11-02' : null }), status: 'completed' }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }] };
    },
    async *getStreamedResponse() { throw new Error('unused'); },
  };
  try {
    const calls: string[] = [];
    const agent = createFridgeAgent({ getInventory: store.listItems, getStatus: () => ({}), addItem: store.addItem, getPackages: store.listPackages, correctFreshness: (id, patch) => store.correctFreshness(id, patch, 'agent') }, calls, model);
    await new Runner({ tracingDisabled: true }).run(agent, 'Set the milk expiration to November 2, 2026, then clear it.');
    assert.deepEqual(calls, ['set_product_date', 'set_product_date']);
    assert.equal(store.listItems()[0].freshness!.expirationDate, null);
    assert.equal(store.listItems()[0].freshness!.openedAt, '2026-10-24');
    assert.equal(store.listLog()[0].source, 'agent');
    assert.equal(JSON.parse(String(store.listLog()[1].afterJson)).freshness.expirationDate, '2026-11-02');
  } finally { store.close(); }
});

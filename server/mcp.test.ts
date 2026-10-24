import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createFridgeMcpRouter } from './mcp.ts';
import { createStore } from './store.ts';

test('MCP exposes exactly one read-only tool and reads fresh inventory', async () => {
  const store = createStore(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/mcp', createFridgeMcpRouter(store.listItems));
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`);
  const client = new Client({ name: 'fridge-test', version: '1.0.0' });
  let storeClosed = false;
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['get_fridge_contents']);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    const read = async () => await client.callTool({ name: 'get_fridge_contents', arguments: {} }) as CallToolResult;
    assert.deepEqual((await read()).structuredContent?.items, []);
    const milk = store.addItem('Milk', 2, 'Blue cap', 'milk_bottle');
    const result = await read();
    assert.deepEqual(result.structuredContent?.items, [milk]);
    assert.equal(result.structuredContent?.source, 'saved_inventory');
    assert.ok(Number.isFinite(Date.parse(result.structuredContent?.retrievedAt as string)));
    assert.deepEqual(JSON.parse((result.content as { text: string }[])[0].text), result.structuredContent);
    assert.equal(store.listItems().length, 1);
    store.removeItem(milk.id);
    assert.deepEqual((await read()).structuredContent?.items, []);
    assert.equal((await client.callTool({ name: 'add_inventory_item', arguments: { name: 'Eggs' } })).isError, true);
    for (const method of ['GET', 'DELETE']) assert.equal((await fetch(url, { method })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
    store.close();
    storeClosed = true;
    const failed = await read();
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.content, [{ type: 'text', text: 'Could not read the saved fridge inventory.' }]);
  } finally {
    await client.close();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    if (!storeClosed) store.close();
  }
});

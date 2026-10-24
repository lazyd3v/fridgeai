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

test('MCP date tools edit and clear dates with validation and audit history', async () => {
  const store = createStore(':memory:');
  const item = store.addItem('Milk', 1);
  const app = express(); app.use(express.json()); app.use('/mcp', createFridgeMcpRouter(store.listItems, store));
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const url = new URL(`http://127.0.0.1:${(listener.address() as { port: number }).port}/mcp`);
  const client = new Client({ name: 'date-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['get_fridge_contents', 'get_package_history', 'set_product_date']);
    assert.equal(tools.find(t => t.name === 'set_product_date')!.annotations?.readOnlyHint, false);
    const edit = (field: string, date: string | null, id = item.id) => client.callTool({ name: 'set_product_date', arguments: { id, field, date } });
    assert.notEqual((await edit('expirationDate', '2026-11-02')).isError, true);
    assert.notEqual((await edit('openedAt', '2026-10-24')).isError, true);
    assert.equal(store.listItems()[0].freshness!.expirationDate, '2026-11-02');
    assert.equal(store.listItems()[0].freshness!.openedAt, '2026-10-24');
    assert.equal(store.listLog()[0].source, 'mcp');
    const count = store.listLog().length;
    for (const date of ['2026-02-30', 'tomorrow', '']) assert.equal((await edit('expirationDate', date)).isError, true);
    assert.equal((await edit('createdAt', '2026-10-24')).isError, true);
    assert.equal((await edit('expirationDate', null, '00000000-0000-4000-8000-000000000000')).isError, true);
    assert.equal(store.listLog().length, count);
    await edit('expirationDate', null);
    assert.equal(store.listItems()[0].freshness!.expirationDate, null);
    assert.equal(store.listItems()[0].freshness!.openedAt, '2026-10-24');
    await edit('openedAt', null);
    assert.equal(store.listItems()[0].freshness!.openedAt, null);
    store.removeItem(item.id);
    const history = await client.callTool({ name: 'get_package_history', arguments: {} }) as CallToolResult;
    assert.equal((history.structuredContent?.packages as { id: string }[])[0].id, item.id);
    assert.notEqual((await edit('expirationDate', '2026-11-01')).isError, true);
    assert.equal(store.listItems().length, 0, 'date edits do not restore finished packages');
  } finally { await client.close(); await new Promise<void>(resolve => listener.close(() => resolve())); store.close(); }
});

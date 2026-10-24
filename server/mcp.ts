import { productDateSchema, productDateDescription } from './date-tools.ts';
import { localDate, TIMEZONE } from './freshness.ts';
import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { createStore } from './store.ts';

export function createFridgeMcpRouter(listItems: ReturnType<typeof createStore>['listItems'], dates?: Pick<ReturnType<typeof createStore>, 'listPackages' | 'correctFreshness'>) {
  const router = Router();
  router.use((req, res, next) => {
    // Non-browser MCP clients omit Origin. Reject untrusted browser origins.
    const origin = req.get('origin');
    if (origin && !['http://fridgeai.local:3000', 'http://127.0.0.1:3002', 'http://localhost:3002'].includes(origin)) {
      res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed.' } });
      return;
    }
    next();
  });
  router.post('/', async (req, res, next) => {
    // Each stateless request gets its own protocol server and transport.
    const server = new McpServer({ name: 'fridge-ai', version: '0.1.0' });
    server.registerTool('get_fridge_contents', {
      title: "What's currently in my fridge",
      description: 'Read the current saved fridge inventory, including quantities and notes. This is recorded inventory, not a live camera observation. Does not scan or modify the fridge.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => {
      try {
        const result = { items: listItems(), retrievedAt: new Date().toISOString(), source: 'saved_inventory', localDate: localDate(new Date().toISOString()), timezone: TIMEZONE };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Could not read the saved fridge inventory.' }] };
      }
    });
    if (dates) {
      server.registerTool('get_package_history', {
        description: 'Read saved package IDs and freshness history, including taken-out and finished products. Use to identify a package before editing dates; only in_fridge items are available ingredients.',
        inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async () => {
        try {
          const result = { packages: dates.listPackages(), localDate: localDate(new Date().toISOString()), timezone: TIMEZONE };
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        } catch { return { isError: true, content: [{ type: 'text', text: 'Could not read package history.' }] }; }
      });
      server.registerTool('set_product_date', {
        title: 'Edit a product date', description: productDateDescription,
        inputSchema: productDateSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async input => {
        try {
          const { id, field, date } = productDateSchema.parse(input);
          const item = dates.correctFreshness(id, { [field]: date }, 'mcp');
          const result = { item };
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        } catch { return { isError: true, content: [{ type: 'text', text: 'Could not edit the date. Use a known package ID and a valid YYYY-MM-DD date, or null to clear it.' }] }; }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await server.close().catch(() => {});
      if (!res.headersSent) next(error);
    }
  });
  router.all('/', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } });
  });
  return router;
}

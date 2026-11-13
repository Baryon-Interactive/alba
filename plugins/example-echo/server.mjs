// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), with one tool, `echo`. No packages needed.
// Copy this plugin folder to start a tool of your own; a real tool usually starts its service's own MCP server instead.
import { createInterface } from 'node:readline';

const tools = [{
  name: 'echo',
  description: 'Returns the text it is given.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}, {
  // A quote tool: Alba calls it before a paid operation and books this amount on the order's quote.
  name: 'echo_price',
  description: 'Prices an echo: one credit per started 100 characters.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}];
const price = text => Math.max(1, Math.ceil(String(text ?? '').length / 100));

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (id === undefined) return;                 // a notification (e.g. notifications/initialized) needs no answer
  if (method === 'initialize') send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'example-echo', version: '1.0.0' } } });
  else if (method === 'tools/list') send({ id, result: { tools } });
  else if (method === 'tools/call' && params?.name === 'echo') send({ id, result: { content: [{ type: 'text', text: String(params.arguments?.text ?? '') }] } });
  else if (method === 'tools/call' && params?.name === 'echo_price') { const amount = price(params.arguments?.text); send({ id, result: { content: [{ type: 'text', text: JSON.stringify({ amount }) }], structuredContent: { amount } } }); }
  else if (method === 'ping') send({ id, result: {} });
  else send({ id, error: { code: -32601, message: `unknown method ${method}${params?.name ? ` (${params.name})` : ''}` } });
});

// The Model Context Protocol, the small part Nordle needs: JSON-RPC 2.0 messages, one per line over stdio, with tools.
// A message handler that takes one parsed message and returns the reply (or null when none is due).

import Ajv from 'ajv/dist/2020.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ajv = new Ajv({ allErrors: true, strict: false });

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

/**
 * @param {{tools:Array, serverInfo:{name:string,version:string}, instructions?:string}} opts
 * A tool is {name, description, inputSchema, annotations?, handler(args)}; the handler returns
 * {text?, json?, images?: [{base64, mime}], isError?}.
 */
export function createMcpHandler({ tools, serverInfo, instructions }) {
  const byName = new Map();
  for (const t of tools) byName.set(t.name, { ...t, validate: ajv.compile(t.inputSchema) });

  const render = (r) => {
    const content = [];
    if (r.text) content.push({ type: 'text', text: r.text });
    if (r.json !== undefined) content.push({ type: 'text', text: typeof r.json === 'string' ? r.json : JSON.stringify(r.json, null, 2) });
    for (const img of r.images ?? []) content.push({ type: 'image', data: img.base64, mimeType: img.mime });
    if (!content.length) content.push({ type: 'text', text: 'Done.' });
    return { content, ...(r.isError ? { isError: true } : {}) };
  };

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return msg?.id !== undefined ? fail(msg.id, -32600, 'Invalid request') : null;
    if (msg.method === undefined) return null; // a response to something we never asked
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params?.protocolVersion;
          const version = SUPPORTED.includes(asked) ? asked : (typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : SUPPORTED[0]);
          return ok(msg.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo, ...(instructions ? { instructions } : {}) });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
          return null;
        case 'ping':
          return isRequest ? ok(msg.id, {}) : null;
        case 'tools/list':
          return ok(msg.id, { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
        case 'tools/call': {
          const tool = byName.get(msg.params?.name);
          if (!tool) return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
          const args = msg.params?.arguments ?? {};
          if (!tool.validate(args)) {
            const problems = tool.validate.errors.map((e) => `${e.instancePath || 'arguments'} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ''}`).join('; ');
            return ok(msg.id, render({ isError: true, text: `The arguments are not right: ${problems}` }));
          }
          let r;
          try { r = await tool.handler(args); } catch (e) { r = { isError: true, text: e?.message ?? String(e) }; }
          return ok(msg.id, render(r));
        }
        default:
          return isRequest ? fail(msg.id, -32601, `Method not found: ${msg.method}`) : null;
      }
    } catch (e) {
      return isRequest ? fail(msg.id, -32603, e?.message ?? 'Internal error') : null;
    }
  };
}

/** Read newline-delimited JSON-RPC from `input` and write replies to `output`. Returns when input ends. */
export async function serveStdio(handle, input = process.stdin, output = process.stdout) {
  let buffer = '';
  const pending = new Set();
  const send = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  const onLine = (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send(fail(null, -32700, 'Parse error')); return; }
    const p = handle(msg).then((reply) => { if (reply) send(reply); }).finally(() => pending.delete(p));
    pending.add(p);
  };
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) { onLine(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
  });
  await new Promise((resolve) => input.on('end', resolve));
  if (buffer.trim()) onLine(buffer);
  await Promise.all([...pending]);
}

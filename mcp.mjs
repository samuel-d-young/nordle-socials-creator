#!/usr/bin/env node
// Nordle's MCP server, for Claude Code and other MCP clients:  claude mcp add nordle -- node /path/to/nordle/mcp.mjs
// It talks to the Nordle editor server (and starts it if it is not running). Everything it prints on stdout is protocol, so
// anything for a person goes to stderr.

import { createMcpHandler, serveStdio } from './src/mcp/protocol.mjs';
import { createTools } from './src/mcp/tools.mjs';
import { NordleClient } from './src/mcp/client.mjs';

const INSTRUCTIONS = [
  'Nordle is a local editor for social posts (graphics and carousels). You and the owner edit the same documents.',
  'Start with nordle_get_guide once, then nordle_list_projects, nordle_get_brand and nordle_get_doc.',
  'After every meaningful edit look at the result with nordle_render, and run nordle_check before saying you are done.',
  'The owner sets how far you may go (suggest, review or apply) and can lock layers; tool results tell you what happened. Never work around a lock.',
  'Never invent facts, prices, statistics or quotes.',
].join(' ');

const client = new NordleClient();
const handle = createMcpHandler({
  tools: createTools(client),
  serverInfo: { name: 'nordle', version: '0.1.0' },
  instructions: INSTRUCTIONS,
});

process.on('uncaughtException', (e) => { console.error(`nordle mcp: ${e.stack ?? e}`); });
process.on('unhandledRejection', (e) => { console.error(`nordle mcp: ${e?.stack ?? e}`); });

await serveStdio(handle);

#!/usr/bin/env node
// BreakWall MCP server over stdio. Do not register it from here; see README for the config snippet.
// stdout carries only the protocol: anything that would print there goes to stderr instead.
console.log = (...a) => console.error(...a);
console.info = console.log;
console.debug = console.log;

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { connect } = await import('../src/graph.js');
const { createServer } = await import('../src/mcp.js');

const driver = connect(); // lazy: no connection is made until the first tool call
const server = createServer({ driver });
await server.connect(new StdioServerTransport());

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } catch {}
  try {
    await driver.close();
  } catch {}
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);

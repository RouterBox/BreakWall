// Minimal hand-written JSON-RPC client for the BreakWall MCP server over stdio (no SDK client on purpose:
// it checks the wire format). Shuts the server down by closing its stdin; never kills it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/breakwall-mcp.js', import.meta.url));

export function startServer(env = {}) {
  const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const stdoutLines = [];
  let stderr = '';
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // recorded in stdoutLines; the test asserts every line parses
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const request = (method, params, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  return {
    child,
    stdoutLines,
    stderr: () => stderr,
    request,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    async initialize() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bw-smoke', version: '0' } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return r;
    },
    call: (name, args) => request('tools/call', { name, arguments: args }),
    /** Close stdin and wait for the server to exit by itself. */
    async shutdown(timeoutMs = 15000) {
      child.stdin.end();
      return Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('server did not exit after stdin closed')), timeoutMs))]);
    },
  };
}

export const textOf = (resp) => resp.result.content[0].text;
export const jsonOf = (resp) => JSON.parse(textOf(resp));

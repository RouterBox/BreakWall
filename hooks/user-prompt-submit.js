#!/usr/bin/env node
// BreakWall ambient mode: a read-only Claude Code UserPromptSubmit hook. See README "Ambient hook" and PLAN items 48-51.
// Contract: exit 0 always; stdout is either one JSON line ({hookSpecificOutput:{additionalContext}}) or empty;
// stderr is empty unless BREAKWALL_HOOK_DEBUG=1; hard stop before one second.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runHook } from '../src/hook.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARD_STOP_MS = 950; // measured from process start
const debug = process.env.BREAKWALL_HOOK_DEBUG === '1';

const stop = setTimeout(() => process.exit(0), Math.round(Math.max(100, HARD_STOP_MS - process.uptime() * 1000)));

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

try {
  const input = await readStdin();
  const left = Math.round(Math.max(100, HARD_STOP_MS - process.uptime() * 1000 - 50));
  const { output, reason } = await runHook(input, { repoRoot: REPO, deadlineMs: left });
  if (debug) process.stderr.write(`breakwall hook: ${reason}\n`);
  clearTimeout(stop);
  if (output) process.stdout.write(output + '\n', () => process.exit(0));
  else process.exit(0);
} catch {
  process.exit(0);
}

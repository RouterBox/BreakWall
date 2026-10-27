// `breakwall hook-test`: pipes sample hook stdin JSON into hooks/user-prompt-submit.js as a child process and checks
// output shape, latency and silence on failure. Failure is simulated without touching any container: a wrong port,
// bad credentials, and a local listener (ephemeral port, started and closed here) that accepts and never answers.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK = join(ROOT, 'hooks', 'user-prompt-submit.js');
export const SAMPLE_PROMPT = 'How is detection of whether the agent pursued or dismissed a flash supposed to work?';
export const LATENCY_BUDGET_MS = 1000;

/** Run the hook script once. Resolves { code, stdout, stderr, ms, timedOut }. */
export function runHookProcess(input, { env = {}, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const guard = setTimeout(() => {
      timedOut = true;
      child.kill(); // only the child this function started
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr, ms: Math.round(performance.now() - t0), timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export const hookInput = (cwd, prompt, session = 'hook-test') => JSON.stringify({ session_id: session, cwd, hook_event_name: 'UserPromptSubmit', prompt });

/** A listener that accepts connections and never answers. Returns { port, close }. */
export function startBlackHole() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.on('error', () => {});
      s.on('close', () => sockets.delete(s));
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) }));
  });
}

export function shapeProblems(r, { maxChars }) {
  const bad = [];
  if (r.code !== 0) bad.push(`exit ${r.code}`);
  if (r.stderr) bad.push(`stderr not empty: ${r.stderr.slice(0, 80)}`);
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    bad.push('stdout is not one JSON document');
  }
  if (j) {
    const keys = Object.keys(j);
    if (keys.join() !== 'hookSpecificOutput') bad.push(`unexpected top-level keys ${keys.join()}`);
    const h = j.hookSpecificOutput || {};
    if (h.hookEventName !== 'UserPromptSubmit') bad.push('hookEventName is not UserPromptSubmit');
    if (typeof h.additionalContext !== 'string' || !h.additionalContext.trim()) bad.push('additionalContext is empty');
    else {
      if (h.additionalContext.length > maxChars) bad.push(`additionalContext is ${h.additionalContext.length} chars, over the cap ${maxChars}`);
      if (!/bw:[^:\s]+:/.test(h.additionalContext)) bad.push('no bw: citation in the context');
    }
  }
  if (r.stdout.trim().split('\n').length !== 1) bad.push('stdout is more than one line');
  return bad;
}

const silentProblems = (r) => {
  const bad = [];
  if (r.code !== 0) bad.push(`exit ${r.code}${r.timedOut ? ' (killed after timeout)' : ''}`);
  if (r.stdout !== '') bad.push(`stdout not empty: ${r.stdout.slice(0, 80)}`);
  if (r.stderr !== '') bad.push(`stderr not empty: ${r.stderr.slice(0, 80)}`);
  return bad;
};

/** Returns [{ name, pass, ms, detail }]. */
export async function runHookTest({ corpus = 'undertow-fixture', prompt = SAMPLE_PROMPT, log = () => {} } = {}) {
  const results = [];
  const proj = mkdtempSync(join(tmpdir(), 'bw-hooktest-'));
  const bare = mkdtempSync(join(tmpdir(), 'bw-hooktest-bare-'));
  const off = mkdtempSync(join(tmpdir(), 'bw-hooktest-off-'));
  const state = mkdtempSync(join(tmpdir(), 'bw-hooktest-state-'));
  writeFileSync(join(proj, '.breakwall.json'), JSON.stringify({ corpus }));
  writeFileSync(join(off, '.breakwall.json'), JSON.stringify({ corpus, ambient: false }));
  const baseEnv = { BREAKWALL_HOOK_STATE_DIR: state };
  const maxChars = 400 * 4;
  const session = `hooktest-${Date.now()}`;

  const add = (name, r, problems, budget = LATENCY_BUDGET_MS, extra = '') => {
    const bad = [...problems];
    if (r.ms > budget) bad.push(`took ${r.ms} ms, budget ${budget} ms`);
    const res = { name, pass: bad.length === 0, ms: r.ms, detail: bad.length ? bad.join('; ') : extra };
    results.push(res);
    log(res);
  };
  const silent = async (name, input, env = {}, budget = LATENCY_BUDGET_MS) => {
    const r = await runHookProcess(input, { env: { ...baseEnv, ...env } });
    add(name, r, silentProblems(r), budget, 'exit 0, empty stdout and stderr');
  };

  try {
    // 1. The happy path, then habituation: the same section is not injected twice in one session.
    const first = await runHookProcess(hookInput(proj, prompt, session), { env: baseEnv });
    const p1 = shapeProblems(first, { maxChars });
    add('injects a cited, capped context for an on-topic prompt', first, p1, LATENCY_BUDGET_MS, p1.length ? '' : `${JSON.parse(first.stdout).hookSpecificOutput.additionalContext.length} chars, exit 0, one JSON line`);
    const second = await runHookProcess(hookInput(proj, prompt, session), { env: baseEnv });
    add('same section is not injected again in the same session', second, silentProblems(second), LATENCY_BUDGET_MS, 'silent on the repeat');

    // 2. Everything that must stay quiet.
    await silent('opt-in: no .breakwall.json in the project -> silent', hookInput(bare, prompt, 'hooktest-b'));
    await silent('marker with ambient:false -> silent', hookInput(off, prompt, 'hooktest-c'));
    await silent('short prompt -> silent', hookInput(proj, 'ok thanks', 'hooktest-d'));
    await silent('slash command -> silent', hookInput(proj, '/compact keep the recent decisions about the graph', 'hooktest-e'));
    await silent('off-topic prompt (below the BM25 gate) -> silent', hookInput(proj, 'Make the table on the pricing page responsive so it scrolls horizontally on phones', 'hooktest-f'));
    await silent('garbage stdin -> silent', 'this is not json {{{');
    await silent('empty stdin -> silent', '');
    await silent('other hook event -> silent', JSON.stringify({ hook_event_name: 'Stop', cwd: proj, prompt }));

    // 3. Simulated outages. No container is touched.
    await silent('Neo4j down (wrong port) -> silent', hookInput(proj, prompt, 'hooktest-g'), { BREAKWALL_NEO4J_HTTP: 'http://127.0.0.1:1' });
    await silent('Neo4j rejects credentials -> silent', hookInput(proj, prompt, 'hooktest-h'), { NEO4J_PASSWORD: 'definitely-wrong' });
    const hole = await startBlackHole();
    try {
      await silent(`Neo4j accepts but never answers (127.0.0.1:${hole.port}) -> silent before the hard stop`, hookInput(proj, prompt, 'hooktest-i'), { BREAKWALL_NEO4J_HTTP: `http://127.0.0.1:${hole.port}` }, 1100);
    } finally {
      await hole.close();
    }
  } finally {
    for (const d of [proj, bare, off, state]) rmSync(d, { recursive: true, force: true });
  }
  return results;
}

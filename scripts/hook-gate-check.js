// Measures the ambient hook's gate (plan item 49) the way the hook itself applies it: the 24 eval questions plus a
// set of off-topic prompts, each run through runHook() against the live index. Prints how often it injects, and
// whether the injected top hit is a gold section. Read-only. usage: node scripts/hook-gate-check.js [--write <file>]
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook } from '../src/hook.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(ROOT, 'eval', 'questions.json'))) {
  console.error('eval/questions.json is local-only and absent; this script needs it and the undertow-fixture index (see eval/README.md)');
  process.exit(1);
}
const qs =JSON.parse(readFileSync(join(ROOT, 'eval', 'questions.json'), 'utf8')).questions;

const OFF_TOPIC = [
  'Fix the failing Android emulator build and push the branch when the gradle task is green again',
  'Write a regex that matches ISO dates inside a log line and returns the year month and day groups',
  'Why does my React component re-render every time the parent state changes, even with useMemo?',
  'Add a dark mode toggle to the settings page and persist the choice in local storage',
  'Summarize the last three commits and draft a pull request description for the reviewers',
  'The nightly job that syncs the database tables keeps timing out after about thirty seconds, what should I check',
  'Can you rename the variable x to count across this file and make sure the tests still pass',
  'Which port does the print server use and how do I restart the service safely',
  'Draft an email to the venue asking when the catering setup is scheduled for next month',
  'Explain how the python asyncio event loop schedules tasks and when a coroutine yields control',
  'Make the table on the pricing page responsive so it scrolls horizontally on phones',
  'Please review this diff for security problems, especially anything touching authentication',
];

const proj = mkdtempSync(join(tmpdir(), 'bw-gate-'));
writeFileSync(join(proj, '.breakwall.json'), JSON.stringify({ corpus: 'undertow-fixture' }));
const stateDir = mkdtempSync(join(tmpdir(), 'bw-gate-state-'));
const env = { ...process.env, BREAKWALL_HOOK_STATE_DIR: stateDir };

async function one(prompt) {
  const t0 = performance.now();
  const r = await runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: proj, prompt }), { repoRoot: ROOT, env, deadlineMs: 5000 });
  return { ...r, ms: Math.round(performance.now() - t0) };
}

const lines = [];
const out = (s) => (console.log(s), lines.push(s));
let ans = 0, ansInj = 0, ansInjGold = 0, ansTop1Gold = 0, un = 0, unInj = 0, off = 0, offInj = 0;
const times = [];
for (const q of qs) {
  const r = await one(q.question);
  times.push(r.ms);
  const gold = (q.gold || []).map((g) => `${g.file}#${g.heading_path}`);
  const injected = r.reason === 'injected';
  const goldHit = injected && r.hits.some((h) => gold.some((g) => g.startsWith(h.path + '#') && g.endsWith(h.headingPath)));
  const top1Gold = injected && gold.some((g) => g.startsWith(r.hits[0].path + '#') && g.endsWith(r.hits[0].headingPath));
  if (q.answerable === false) { un++; if (injected) unInj++; } else { ans++; if (injected) ansInj++; if (goldHit) ansInjGold++; if (top1Gold) ansTop1Gold++; }
  out(`${q.id} ${q.answerable === false ? 'UNANSWERABLE' : 'answerable  '} top bm25 ${r.top == null ? '-' : r.top.toFixed(2).padStart(6)}  ${injected ? 'INJECT (' + r.hits.length + ' hit, top1 gold: ' + top1Gold + ')' : 'silent'}`);
}
for (const p of OFF_TOPIC) {
  const r = await one(p);
  times.push(r.ms);
  off++;
  if (r.reason === 'injected') offInj++;
  out(`off-topic     top bm25 ${r.top == null ? '-' : r.top.toFixed(2).padStart(6)}  ${r.reason === 'injected' ? 'INJECT ' + r.hits[0].path + ' | ' + r.hits[0].headingPath : 'silent'}   "${p.slice(0, 60)}"`);
}
out('');
out(`answerable: injected ${ansInj}/${ans}; of those the injected hits include a gold section in ${ansInjGold}, top-1 is gold in ${ansTop1Gold}`);
out(`unanswerable: injected ${unInj}/${un}`);
out(`off-topic: injected ${offInj}/${off}`);
out(`in-process query time (fetch + format, no node start): median ${times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)]} ms, max ${Math.max(...times)} ms`);
rmSync(proj, { recursive: true, force: true });
rmSync(stateDir, { recursive: true, force: true });
const wi = process.argv.indexOf('--write');
if (wi !== -1) writeFileSync(process.argv[wi + 1], lines.join('\n') + '\n');

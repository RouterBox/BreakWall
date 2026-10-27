// M5: citations, the ambient hook (pure core, the real script as a child process, silent failure and latency bounds),
// and the staleness report. Pure tests first; DB tests use a test-* corpus with a stub embedder and are skipped loudly
// when breakwall-neo4j is not reachable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, cpSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { loadCorpus } from '../src/scan.js';
import { connect, indexCorpus, wipe, dumpCorpus, digest } from '../src/graph.js';
import { DIMS } from '../src/embed.js';
import { formatCitation, parseCitation, judgeCitation } from '../src/cite.js';
import { findMarker, skipPrompt, buildContext, runHook, HOOK_DEFAULTS, MARKER } from '../src/hook.js';
import { runHookProcess, hookInput, startBlackHole, shapeProblems } from '../src/hooktest.js';
import { buildStale, toolStale, touchTimes, formatStale } from '../src/stale.js';
import { toolCite, toolCiteCheck } from '../src/tools.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sample = fileURLToPath(new URL('./data/sample-corpus', import.meta.url));
const NAME = `test-m5-${process.pid}`;
const tmpDirs = [];
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
let driver;
let skip = false;

before(async () => {
  driver = connect();
  try {
    await driver.getServerInfo();
  } catch (e) {
    skip = `Neo4j not reachable: ${e.message}`;
    console.warn('SKIPPING M5 DB tests -', skip);
  }
});
after(async () => {
  if (!skip) await wipe(driver, NAME);
  await driver.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function stubEmbedder() {
  return {
    model: 'stub-model',
    dims: DIMS,
    async embed(texts) {
      return texts.map((t) => {
        const v = Array.from({ length: DIMS }, (_, i) => createHash('sha256').update(`${t}|${i}`).digest().readInt16LE(0) / 32768);
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      });
    },
  };
}

// ---------------------------------------------------------------- citations (pure)

test('citation: format and parse round-trip, including # and @ inside the heading and a missing commit', () => {
  const c = { corpus: 'undertow-fixture', path: 'docs/KEEPER.md', headingPath: 'The Keeper > Role @ home #1', commit: 'bd7f35ff6b604a4ae04a4d652568138e1a2cccc3' };
  const s = formatCitation(c);
  assert.equal(s, 'bw:undertow-fixture:docs/KEEPER.md#The Keeper > Role @ home #1@bd7f35ff');
  assert.deepEqual(parseCitation(s), { ...c, commit: 'bd7f35ff' });
  assert.equal(formatCitation({ corpus: 'c', path: 'a.md', headingPath: '', commit: null }), 'bw:c:a.md');
  assert.deepEqual(parseCitation('bw:c:a.md'), { corpus: 'c', path: 'a.md', headingPath: '', commit: null });
  assert.deepEqual(parseCitation('bw:c:a.md#H > J'), { corpus: 'c', path: 'a.md', headingPath: 'H > J', commit: null });
  assert.equal(formatCitation({ corpus: 'c', path: 'a.md', headingPath: ['A', 'B'] }), 'bw:c:a.md#A > B');
  assert.throws(() => parseCitation('https://example.com'), /not a BreakWall citation/);
  assert.throws(() => formatCitation({ path: 'a.md' }), /corpus/);
});

test('citation: judging against the index (ok, changed, heading-missing, deleted, unknown)', () => {
  const cited = { corpus: 'c', path: 'a.md', headingPath: 'A', commit: 'abcdef12' };
  const cur = { docExists: true, deleted: false, sectionExists: true, commit: 'abcdef1234567890' };
  assert.equal(judgeCitation(cited, cur).status, 'ok');
  assert.equal(judgeCitation(cited, { ...cur, commit: '99999999aaaa' }).status, 'changed');
  assert.equal(judgeCitation(cited, { ...cur, sectionExists: false }).status, 'heading-missing');
  assert.equal(judgeCitation(cited, { ...cur, deleted: true }).status, 'deleted');
  assert.equal(judgeCitation(cited, { ...cur, docExists: false }).status, 'unknown');
  assert.equal(judgeCitation({ ...cited, commit: null }, { ...cur, commit: 'ffff' }).status, 'ok', 'no commit cited: nothing to compare');
});

// ---------------------------------------------------------------- hook core (pure)

test('hook: the light core must not import the driver, the embedder or the graph module', () => {
  for (const f of ['src/hook.js', 'hooks/user-prompt-submit.js', 'src/luceneq.js', 'src/cite.js']) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    const imports = [...text.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    for (const i of imports) assert.ok(!/neo4j-driver|embed|graph|search|tools|xenova|dotenv/i.test(i), `${f} imports ${i}`);
  }
});

test('hook: opt-in marker is found in the folder or a parent; invalid or missing means not opted in', () => {
  const root = mk('bw-marker-');
  const deep = join(root, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });
  assert.equal(findMarker(deep), null);
  writeFileSync(join(root, MARKER), JSON.stringify({ corpus: 'x', limit: 2 }));
  assert.equal(findMarker(deep).config.corpus, 'x');
  assert.equal(findMarker(deep, 2), null, 'too far up for a 2-level search');
  writeFileSync(join(root, 'a', MARKER), '{ not json');
  assert.equal(findMarker(deep), null, 'the nearest marker is invalid: off, no fallthrough to a parent');
});

test('hook: short prompts, slash commands and empty prompts are skipped', () => {
  const cfg = HOOK_DEFAULTS;
  assert.equal(skipPrompt('ok thanks', cfg), 'short prompt');
  assert.equal(skipPrompt('yes please do that now ok', cfg), null);
  assert.equal(skipPrompt('/compact keep everything about the graph model', cfg), 'slash command');
  assert.equal(skipPrompt('   ', cfg), 'empty prompt');
  assert.equal(skipPrompt('a b c', cfg), 'short prompt');
});

const row = (id, score, extra = {}) => ({ sectionId: id, path: `${id}.md`, headingPath: `H ${id}`, startLine: 1, endLine: 9, text: `# H\n${'word '.repeat(200)}`, commit: 'abcdef1234', score, status: null, newer: [], ...extra });

test('hook: BM25 gate applies to every hit, chunks collapse to sections, already-seen sections are dropped', () => {
  const cfg = { ...HOOK_DEFAULTS };
  const rows = [row('a', 12), row('a', 11.5), row('b', 10), row('c', 9.5), row('d', 3)];
  const r = buildContext(rows, { corpus: 'k', cfg });
  assert.deepEqual(r.hits.map((h) => h.sectionId), ['a', 'b', 'c'], 'a once, d below the gate');
  assert.match(r.text, /bw:k:a\.md#H a@abcdef12/);
  const seen = buildContext(rows, { corpus: 'k', cfg, seen: new Set(['a', 'b']) });
  assert.deepEqual(seen.hits.map((h) => h.sectionId), ['c']);
  assert.equal(buildContext(rows, { corpus: 'k', cfg, seen: new Set(['a', 'b', 'c']) }).text, null);
  assert.equal(buildContext([row('z', 9.0)], { corpus: 'k', cfg }).text, null, 'below 9.341');
  assert.equal(buildContext([row('z', 9.0)], { corpus: 'k', cfg: { ...cfg, minBm25: 5 } }).hits.length, 1, 'the marker can lower the gate');
});

test('hook: injected text never exceeds the token cap (characters / 4), whatever the settings', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`s${i}`, 20 - i, { text: 'long text '.repeat(500) }));
  for (const maxTokens of [50, 120, 400, 1000]) {
    const r = buildContext(rows, { corpus: 'k', cfg: { ...HOOK_DEFAULTS, maxTokens, limit: 5 } });
    if (r.text) assert.ok(r.text.length <= maxTokens * 4, `${r.text.length} > ${maxTokens * 4}`);
  }
  const r = buildContext(rows, { corpus: 'k', cfg: { ...HOOK_DEFAULTS, maxTokens: 400, limit: 5 } });
  assert.ok(r.hits.length >= 1 && r.hits.length <= 5);
});

test('hook: a superseded document is labelled, not hidden', () => {
  const r = buildContext([row('a', 15, { newer: ['docs/auth-v2.md'] })], { corpus: 'k', cfg: HOOK_DEFAULTS });
  assert.match(r.text, /\[SUPERSEDED by docs\/auth-v2\.md\]/);
});

test('hook: runHook with a stub fetch gives exactly the hook JSON; every failure gives no output', async () => {
  const proj = mk('bw-hook-');
  writeFileSync(join(proj, MARKER), JSON.stringify({ corpus: 'k', minBm25: 1 }));
  const data = { fields: ['sectionId', 'path', 'headingPath', 'startLine', 'endLine', 'text', 'commit', 'score', 'status', 'newer'], values: [['s1', 'a.md', 'A', 3, 9, '# A\nthe verbatim text of the section', 'abcdef1234', 12.5, null, []]] };
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ data }) });
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: proj, prompt: 'what does the section say about verbatim text please' });
  const env = { BREAKWALL_HOOK_STATE_DIR: mk('bw-state-') };
  const r = await runHook(input, { repoRoot: ROOT, env, fetchImpl: ok });
  assert.equal(r.reason, 'injected');
  const j = JSON.parse(r.output);
  assert.deepEqual(Object.keys(j), ['hookSpecificOutput']);
  assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(j.hookSpecificOutput.additionalContext, /the verbatim text of the section/);

  const quiet = async (fetchImpl, inp = input) => (await runHook(inp, { repoRoot: ROOT, env: { BREAKWALL_HOOK_STATE_DIR: mk('bw-state-') }, fetchImpl })).output;
  assert.equal(await quiet(async () => { throw new TypeError('fetch failed'); }), null, 'connection refused');
  assert.equal(await quiet(async () => ({ ok: false, status: 401, json: async () => ({}) })), null, 'bad credentials');
  assert.equal(await quiet(async () => ({ ok: true, status: 200, json: async () => ({ weird: true }) })), null, 'unexpected body');
  assert.equal(await quiet(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })), null, 'unparseable body');
  assert.equal(await quiet(ok, 'not json'), null);
  assert.equal(await quiet(ok, JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: proj, prompt: 'hi' })), null, 'short prompt, fetch never needed');
  assert.equal((await runHook(input, { repoRoot: ROOT, env: { ...env, BREAKWALL_AMBIENT: '0' }, fetchImpl: ok })).output, null, 'BREAKWALL_AMBIENT=0 switches it off');
});

test('hook: a request that never completes is abandoned at the deadline', async () => {
  const proj = mk('bw-hook-');
  writeFileSync(join(proj, MARKER), JSON.stringify({ corpus: 'k' }));
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const t0 = performance.now();
  const r = await runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: proj, prompt: 'a prompt long enough to be searched for' }), { repoRoot: ROOT, env: { BREAKWALL_HOOK_STATE_DIR: mk('bw-state-') }, fetchImpl: hang, deadlineMs: 80 });
  const ms = performance.now() - t0;
  assert.equal(r.output, null);
  assert.match(r.reason, /timeout/);
  assert.ok(ms < 400, `took ${ms} ms`);
});

test('hook: habituation state is per session and a repeat is silent', async () => {
  const proj = mk('bw-hook-');
  writeFileSync(join(proj, MARKER), JSON.stringify({ corpus: 'k', minBm25: 1 }));
  const data = { fields: ['sectionId', 'path', 'headingPath', 'startLine', 'endLine', 'text', 'commit', 'score', 'status', 'newer'], values: [['s1', 'a.md', 'A', 3, 9, '# A\ntext', 'abcdef1234', 12.5, null, []]] };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data }) });
  const env = { BREAKWALL_HOOK_STATE_DIR: mk('bw-state-') };
  const go = (session) => runHook(JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', cwd: proj, prompt: 'a prompt long enough to be searched for' }), { repoRoot: ROOT, env, fetchImpl });
  assert.equal((await go('s-1')).reason, 'injected');
  assert.equal((await go('s-1')).output, null, 'same section, same session');
  assert.equal((await go('s-2')).reason, 'injected', 'a different session starts fresh');
  assert.equal((await go('../../evil')).reason, 'injected', 'an unsafe session id disables state instead of escaping the directory');
  assert.equal((await go('../../evil')).reason, 'injected');
});

// ---------------------------------------------------------------- the real script as a child process (no database needed)

test('hook script: silent exit 0 for no marker, garbage stdin, a dead port and bad URL', async () => {
  const bare = mk('bw-bare-');
  const proj = mk('bw-proj-');
  writeFileSync(join(proj, MARKER), JSON.stringify({ corpus: 'whatever' }));
  const prompt = 'How is detection of whether the agent pursued or dismissed a flash supposed to work?';
  const cases = [
    ['no marker', hookInput(bare, prompt), {}],
    ['garbage', 'not json', {}],
    ['empty', '', {}],
    ['dead port', hookInput(proj, prompt), { BREAKWALL_NEO4J_HTTP: 'http://127.0.0.1:1' }],
    ['not a url', hookInput(proj, prompt), { BREAKWALL_NEO4J_HTTP: 'banana' }],
  ];
  for (const [name, input, env] of cases) {
    const r = await runHookProcess(input, { env: { BREAKWALL_HOOK_STATE_DIR: mk('bw-state-'), ...env } });
    assert.equal(r.code, 0, `${name}: exit`);
    assert.equal(r.stdout, '', `${name}: stdout`);
    assert.equal(r.stderr, '', `${name}: stderr`);
    assert.ok(r.ms < 1000, `${name}: ${r.ms} ms`);
  }
});

test('hook script: a server that accepts and never answers is cut off before one second, silently', async () => {
  const proj = mk('bw-proj-');
  writeFileSync(join(proj, MARKER), JSON.stringify({ corpus: 'whatever' }));
  const hole = await startBlackHole();
  try {
    const r = await runHookProcess(hookInput(proj, 'How is detection of whether the agent pursued or dismissed a flash supposed to work?'), { env: { BREAKWALL_HOOK_STATE_DIR: mk('bw-state-'), BREAKWALL_NEO4J_HTTP: `http://127.0.0.1:${hole.port}` } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.ok(!r.timedOut);
    assert.ok(r.ms < 1150, `took ${r.ms} ms; the hard stop is 950 ms from process start`);
    assert.ok(r.ms > 300, 'it did wait for the server rather than giving up at once');
  } finally {
    await hole.close();
  }
});

test('hook script: debug mode explains the silence on stderr, and only then', async () => {
  const bare = mk('bw-bare-');
  const r = await runHookProcess(hookInput(bare, 'a prompt that is long enough to search'), { env: { BREAKWALL_HOOK_DEBUG: '1', BREAKWALL_HOOK_STATE_DIR: mk('bw-state-') } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /not opted in/);
});

test('hook-test harness: shape checker accepts the real shape and rejects the usual mistakes', () => {
  const good = { code: 0, stderr: '', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x bw:c:a.md#H@abc1234' } }) + '\n' };
  assert.deepEqual(shapeProblems(good, { maxChars: 1600 }), []);
  assert.ok(shapeProblems({ ...good, stdout: 'plain text\n' }, { maxChars: 1600 }).length);
  assert.ok(shapeProblems({ ...good, code: 2 }, { maxChars: 1600 }).length);
  assert.ok(shapeProblems(good, { maxChars: 5 }).some((p) => /cap/.test(p)));
  assert.ok(shapeProblems({ ...good, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'bw:c:a' } }) }, { maxChars: 99 }).some((p) => /hookEventName/.test(p)));
});

// ---------------------------------------------------------------- stale (pure)

test('stale: the four lists from plain inputs', () => {
  const DAY = 864e5;
  const now = Date.UTC(2026, 9, 27);
  const r = buildStale({
    now,
    days: 90,
    recentDays: 14,
    indexed: new Map([['a.md', { hash: 'h1' }], ['b.md', { hash: 'h2' }], ['gone.md', { hash: 'h3' }], ['tomb.md', { hash: 'h4', deleted: true }]]),
    disk: new Map([['a.md', { hash: 'h1' }], ['b.md', { hash: 'CHANGED' }], ['new.md', { hash: 'n' }]]),
    sectionDiff: new Map([['b.md', [{ headingPath: 'B > x', change: 'changed' }]]]),
    supersessions: [{ older: 'old.md', newers: ['z.md', 'a.md'] }],
    links: [{ from: 'a.md', to: 'old.md' }, { from: 'a.md', to: 'fresh.md' }, { from: 'stale-src.md', to: 'old.md' }, { from: 'a.md', to: 'a.md' }],
    touched: new Map([['a.md', { at: now - 2 * DAY, by: 'git' }], ['old.md', { at: now - 200 * DAY, by: 'git' }], ['fresh.md', { at: now - 10 * DAY, by: 'git' }], ['stale-src.md', { at: now - 300 * DAY, by: 'mtime' }]]),
    claims: [{ rule: 'count-mismatch', path: 'a.md', line: 3, message: 'says "9 daemons" ...' }],
  });
  assert.deepEqual(r.changedSinceIndex.map((c) => `${c.kind}:${c.path}`), ['changed:b.md', 'removed:gone.md', 'added:new.md'], 'tombstoned documents are not reported as removed');
  assert.deepEqual(r.changedSinceIndex[0].sections, [{ headingPath: 'B > x', change: 'changed' }]);
  assert.deepEqual(r.superseded, [{ path: 'old.md', supersededBy: ['a.md', 'z.md'] }]);
  assert.deepEqual(r.linkedFromRecentButUntouched, [{ path: 'old.md', daysSinceTouched: 200, touchedBy: 'git', linkedFromRecentlyChanged: ['a.md'] }], 'only links from recently changed docs count; fresh targets and self links do not');
  assert.equal(r.counts.claimsLintFlags, 1);
  assert.match(formatStale({ corpus: 'k', documents: 3, ...r }), /Superseded by a newer document: 1/);
});

test('stale: touch times come from one git log, with mtime as the fallback outside git', () => {
  const dir = mk('bw-git-');
  const run = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
  run('init', '-q');
  writeFileSync(join(dir, 'old.md'), '# old\n');
  run('add', '.');
  run('commit', '-q', '-m', 'old');
  const t = touchTimes(dir, ['old.md', 'uncommitted.md']);
  assert.equal(t.get('old.md').by, 'git');
  assert.equal(t.get('old.md').at, Date.UTC(2020, 0, 1));
  writeFileSync(join(dir, 'uncommitted.md'), '# new\n');
  const t2 = touchTimes(dir, ['old.md', 'uncommitted.md']);
  assert.equal(t2.get('uncommitted.md').by, 'mtime', 'files git does not know fall back to mtime');
  const nogit = mk('bw-nogit-');
  writeFileSync(join(nogit, 'x.md'), '# x\n');
  assert.equal(touchTimes(nogit, ['x.md']).get('x.md').by, 'mtime');
});

// ---------------------------------------------------------------- DB: cite, hook against a real index, stale

async function indexSample(dir) {
  return indexCorpus(driver, loadCorpus(dir, NAME), { embedder: stubEmbedder() });
}

test('db: cite and cite --check follow the index (ok, heading-missing, deleted, unknown)', async (t) => {
  if (skip) return t.skip(skip);
  const dir = mk('bw-cite-');
  cpSync(sample, dir, { recursive: true });
  await indexSample(dir);
  const c = await toolCite(driver, NAME, { ref: 'docs/auth-v2.md', heading: 'Token storage' });
  assert.match(c.citation, new RegExp(`^bw:${NAME}:docs/auth-v2\\.md#Authentication v2 > Token storage$`), 'no commit in a corpus outside git');
  assert.equal((await toolCiteCheck(driver, c.citation)).status, 'ok');
  assert.equal((await toolCiteCheck(driver, `bw:${NAME}:docs/auth-v2.md#No such > Heading`)).status, 'heading-missing');
  assert.equal((await toolCiteCheck(driver, `bw:${NAME}:docs/nope.md#x`)).status, 'unknown');
  await assert.rejects(() => toolCite(driver, NAME, { ref: 'docs/auth-v2.md', heading: 'zzz' }), /no section found/);
  rmSync(join(dir, 'docs', 'auth-v2.md'));
  await indexSample(dir);
  assert.equal((await toolCiteCheck(driver, c.citation)).status, 'deleted');
});

test('db: the real hook script, against a real index, injects cited text and labels a superseded document', async (t) => {
  if (skip) return t.skip(skip);
  const dir = mk('bw-hookdb-');
  cpSync(sample, dir, { recursive: true });
  await indexSample(dir);
  const proj = mk('bw-proj-');
  writeFileSync(join(proj, MARKER), JSON.stringify({ corpus: NAME, minBm25: 0, limit: 3 }));
  const env = { BREAKWALL_HOOK_STATE_DIR: mk('bw-state-') };
  const r = await runHookProcess(hookInput(proj, 'When does a sign in session expire after inactivity, and how are tokens stored?', 'db-1'), { env });
  assert.deepEqual(shapeProblems(r, { maxChars: HOOK_DEFAULTS.maxTokens * 4 }), []);
  assert.ok(r.ms < 1000, `${r.ms} ms`);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, new RegExp(`bw:${NAME}:docs/auth-v`));
  // a prompt that matches only the superseded v1
  const v1 = await runHookProcess(hookInput(proj, 'Passwords are verified with a password hash on sign in for the old authentication flow', 'db-2'), { env });
  if (v1.stdout) assert.match(JSON.parse(v1.stdout).hookSpecificOutput.additionalContext, /auth-v1\.md.*\[SUPERSEDED by docs\/auth-v2\.md\]|auth-v2\.md/s);
  // a gate raised above any score keeps it silent
  writeFileSync(join(proj, MARKER), JSON.stringify({ corpus: NAME, minBm25: 999 }));
  const none = await runHookProcess(hookInput(proj, 'When does a sign in session expire after inactivity, and how are tokens stored?', 'db-3'), { env });
  assert.equal(none.stdout, '');
  assert.equal(none.code, 0);
});

test('db: stale reports file changes by section, supersession, untouched-but-linked docs and lint claims, and writes nothing', async (t) => {
  if (skip) return t.skip(skip);
  const dir = mk('bw-stale-');
  cpSync(sample, dir, { recursive: true });
  await indexSample(dir);
  const clean = await toolStale(driver, NAME, {});
  assert.equal(clean.counts.changedSinceIndex, 0, 'a fresh index has nothing to refresh');
  assert.deepEqual(clean.superseded.map((s) => [s.path, s.supersededBy]), [['docs/auth-v1.md', ['docs/auth-v2.md']]]);

  // edit one section, add a file, delete one; age the design doc that auth-v2 links to
  writeFileSync(join(dir, 'docs', 'auth-v2.md'), readFileSync(join(dir, 'docs', 'auth-v2.md'), 'utf8').replace('30 minutes', '45 minutes'));
  writeFileSync(join(dir, 'docs', 'brand-new.md'), '# Brand new\n\nNot indexed yet.\n');
  rmSync(join(dir, 'docs', 'notes.md'));
  const old = new Date(Date.now() - 200 * 864e5);
  utimesSync(join(dir, 'work', 'WI-1', 'design.md'), old, old);
  const before = digest(JSON.stringify(await dumpCorpus(driver, NAME)));
  const r = await toolStale(driver, NAME, { days: 90, recentDays: 14 });
  const after = digest(JSON.stringify(await dumpCorpus(driver, NAME)));
  assert.equal(before, after, 'staleness is read-only: the graph is untouched');

  const kinds = Object.fromEntries(r.changedSinceIndex.map((c) => [c.path, c.kind]));
  assert.equal(kinds['docs/auth-v2.md'], 'changed');
  assert.equal(kinds['docs/brand-new.md'], 'added');
  assert.equal(kinds['docs/notes.md'], 'removed');
  const changedSections = r.changedSinceIndex.find((c) => c.path === 'docs/auth-v2.md').sections;
  assert.deepEqual(changedSections.map((s) => `${s.change}:${s.headingPath}`), ['changed:Authentication v2 > Overview'], 'only the section that differs');
  const un = r.linkedFromRecentButUntouched.find((u) => u.path === 'work/WI-1/design.md');
  assert.ok(un, 'design.md is 200 days old and linked from the freshly written auth-v2.md');
  assert.ok(un.linkedFromRecentlyChanged.includes('docs/auth-v2.md'));
  assert.ok(un.daysSinceTouched >= 199);
  assert.ok(Array.isArray(r.claimsLintFlags));
  assert.match(formatStale(r), /Source changed since the last index/);
});

// Plan item 57: the default search mode switch (A) and the vectors-per-corpus switch (B). Pure precedence and error tests
// first, then DB tests on a throwaway test-* corpus (skipped loudly when breakwall-neo4j is not reachable).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { loadCorpus } from '../src/scan.js';
import { connect, indexCorpus, wipe } from '../src/graph.js';
import { DIMS, embedStats, localEmbedder } from '../src/embed.js';
import { resolveVectors, resolveSearchMode, readSwitchConfig, vectorsForRoot, SwitchError } from '../src/switches.js';
import { toolSearch, toolStatus, ToolError } from '../src/tools.js';
import { runEval } from '../src/evalrun.js';
import { inferCorpus, inferStatus } from '../src/infer/index.js';
import { MARKER, HOOK_DEFAULTS } from '../src/hook.js';
import { runHookProcess, hookInput, shapeProblems } from '../src/hooktest.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sample = fileURLToPath(new URL('./data/sample-corpus', import.meta.url));
const NAME = `test-switches-${process.pid}`;
const tmpDirs = [];
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

// ---------- pure: switch B ----------

test('vectors switch: env beats breakwall.json beats built-in on', () => {
  assert.deepEqual(resolveVectors({ env: {}, config: {} }), { on: true, source: 'built-in' });
  assert.equal(resolveVectors({ env: {}, config: { vectors: false } }).on, false);
  assert.match(resolveVectors({ env: {}, config: { vectors: false } }).source, /breakwall\.json key "vectors"/);
  assert.deepEqual(resolveVectors({ env: { BREAKWALL_VECTORS: '1' }, config: { vectors: false } }), { on: true, source: 'env BREAKWALL_VECTORS' });
  assert.deepEqual(resolveVectors({ env: { BREAKWALL_VECTORS: '0' }, config: { vectors: true } }), { on: false, source: 'env BREAKWALL_VECTORS' });
  assert.equal(resolveVectors({ env: { BREAKWALL_VECTORS: '' }, config: { vectors: false } }).on, false, 'an empty env var is unset');
});

test('vectors switch: invalid values are errors naming their source', () => {
  assert.throws(() => resolveVectors({ env: { BREAKWALL_VECTORS: 'yes' } }), (e) => e instanceof SwitchError && /env BREAKWALL_VECTORS="yes"/.test(e.message));
  assert.throws(() => resolveVectors({ env: {}, config: { vectors: 'false' } }), /breakwall\.json key "vectors" is "false"; it must be true or false/);
});

// ---------- pure: switch A ----------

test('search mode switch: explicit beats env beats breakwall.json beats built-in hybrid', () => {
  const env = { BREAKWALL_SEARCH_MODE: 'vector' };
  const config = { mode: 'lexical' };
  assert.deepEqual(resolveSearchMode({ env: {}, config: {} }), { mode: 'hybrid', source: 'built-in' });
  assert.equal(resolveSearchMode({ env: {}, config }).mode, 'lexical');
  assert.match(resolveSearchMode({ env: {}, config }).source, /key "search\.mode"/);
  assert.deepEqual(resolveSearchMode({ env, config }), { mode: 'vector', source: 'env BREAKWALL_SEARCH_MODE' });
  assert.deepEqual(resolveSearchMode({ explicit: 'hybrid', env, config }), { mode: 'hybrid', source: 'explicit mode' });
});

test('search mode switch: an invalid value is an error naming its source, never a fallback', () => {
  assert.throws(() => resolveSearchMode({ explicit: 'fuzzy' }), /explicit mode is "fuzzy"/);
  assert.throws(() => resolveSearchMode({ env: { BREAKWALL_SEARCH_MODE: 'HYBRID' } }), /env BREAKWALL_SEARCH_MODE is "HYBRID"/);
  assert.throws(() => resolveSearchMode({ env: {}, config: { mode: 3 } }), /key "search\.mode" is 3/);
});

test('A and B interact: vectors off makes lexical the default and refuses hybrid / vector from any source', () => {
  const off = { on: false, source: 'env BREAKWALL_VECTORS' };
  assert.deepEqual(resolveSearchMode({ env: {}, config: {}, vectors: off }), { mode: 'lexical', source: 'built-in (vectors off)' });
  assert.equal(resolveSearchMode({ explicit: 'lexical', env: {}, vectors: off }).mode, 'lexical');
  assert.throws(() => resolveSearchMode({ explicit: 'hybrid', env: {}, vectors: off, corpus: 'k' }), /vectors are off for corpus k \(env BREAKWALL_VECTORS\); mode "hybrid" needs them/);
  assert.throws(() => resolveSearchMode({ env: { BREAKWALL_SEARCH_MODE: 'vector' }, vectors: off, corpus: 'k' }), /env BREAKWALL_SEARCH_MODE names search mode "vector", but vectors are off for corpus k \(env BREAKWALL_VECTORS\)/);
  assert.throws(() => resolveSearchMode({ env: {}, config: { mode: 'hybrid' }, vectors: off }), /key "search\.mode" names search mode "hybrid", but vectors are off/);
});

test('a half-embedded corpus refuses hybrid and vector, lexical still works', () => {
  const half = { vectors: { on: true, source: 'built-in' }, unembedded: 3, chunks: 10, corpus: 'k', env: {} };
  assert.throws(() => resolveSearchMode(half), /corpus k is half-embedded: 3 of 10 chunks/);
  assert.throws(() => resolveSearchMode({ ...half, explicit: 'vector' }), /half-embedded/);
  assert.equal(resolveSearchMode({ ...half, explicit: 'lexical' }).mode, 'lexical');
});

test('breakwall.json: search.mode and vectors are read; a bad shape is an error', () => {
  const dir = mk('bw-sw-');
  assert.deepEqual(readSwitchConfig(dir), { mode: undefined, vectors: undefined });
  writeFileSync(join(dir, 'breakwall.json'), JSON.stringify({ search: { mode: 'lexical' }, vectors: false, workItems: null }));
  assert.deepEqual(readSwitchConfig(dir), { mode: 'lexical', vectors: false });
  assert.deepEqual(vectorsForRoot(dir, {}), { on: false, source: `${join(dir, 'breakwall.json')} key "vectors"` });
  writeFileSync(join(dir, 'breakwall.json'), JSON.stringify({ search: 'lexical' }));
  assert.throws(() => readSwitchConfig(dir), /"search" must be an object/);
});

test('the ambient hook does not read either switch (item 49: lexical only)', () => {
  for (const f of ['src/hook.js', 'hooks/user-prompt-submit.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/switches|BREAKWALL_SEARCH_MODE|BREAKWALL_VECTORS/.test(src), f);
  }
});

// ---------- database tests ----------

let driver;
let skip = false;
before(async () => {
  driver = connect();
  try {
    await driver.getServerInfo();
  } catch (e) {
    skip = `Neo4j not reachable: ${e.message}`;
    console.warn('SKIPPING switches DB tests -', skip);
  }
});
after(async () => {
  if (!skip) await wipe(driver, NAME);
  await driver.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Deterministic fake embedder that counts what it is asked to embed; `fail` makes it throw instead. */
function stubEmbedder({ fail = false } = {}) {
  const e = {
    model: 'stub-model',
    dims: DIMS,
    texts: 0,
    async embed(texts) {
      if (fail) throw new Error('stub embedder: model unavailable');
      e.texts += texts.length;
      return texts.map((t) => {
        const v = Array.from({ length: DIMS }, (_, i) => createHash('sha256').update(`${t}|${i}`).digest().readInt16LE(0) / 32768);
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      });
    },
  };
  return e;
}
const setConfig = (dir, obj) => writeFileSync(join(dir, 'breakwall.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(sample, 'breakwall.json'), 'utf8')), ...obj }));
const chunkCounts = async () => {
  const s = driver.session();
  try {
    const r = (await s.run('MATCH (k:Chunk {corpus: $c}) RETURN count(k) AS n, count(k.embedding) AS e, count(k.embedHash) AS h', { c: NAME })).records[0];
    return { chunks: r.get('n'), embedded: r.get('e'), hashed: r.get('h') };
  } finally {
    await s.close();
  }
};
const statusOf = async () => (await toolStatus(driver)).corpora.find((c) => c.corpus === NAME);
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
const QUERY = 'When does a sign in session expire after inactivity, and how are tokens stored?';

test('db: vectors off: sync loads no model and writes no embedding; search defaults to lexical; status says why', async (t) => {
  if (skip) return t.skip(skip);
  const dir = mk('bw-sw-db-');
  cpSync(sample, dir, { recursive: true });
  setConfig(dir, { vectors: false });
  const loadsBefore = embedStats.loads;
  const callsBefore = embedStats.calls;
  // The real local embedder: switched off, it must not even be loaded.
  const st = await withEnv({ BREAKWALL_VECTORS: '' }, () => indexCorpus(driver, loadCorpus(dir, NAME), { embedder: localEmbedder() }));
  assert.equal(st.vectors.on, false);
  assert.equal(st.embedded, 0);
  assert.equal(embedStats.loads, loadsBefore, 'model not loaded');
  assert.equal(embedStats.calls, callsBefore, 'embedder not called');
  const c = await chunkCounts();
  assert.ok(c.chunks > 0);
  assert.equal(c.embedded, 0, 'no embedding property written');
  assert.equal(c.hashed, c.chunks, 'every chunk keeps an embedHash');
  assert.equal(st.unembedded, c.chunks);

  const never = stubEmbedder({ fail: true }); // search must not embed the query either
  const res = await withEnv({ BREAKWALL_SEARCH_MODE: '' }, () => toolSearch(driver, NAME, { query: QUERY, embedder: never }));
  assert.equal(res.mode, 'lexical');
  assert.equal(res.modeSource, 'built-in (vectors off)');
  assert.ok(res.results.length > 0 && res.results[0].citation.path.startsWith('docs/auth-v'));
  assert.equal(res.results[0].scores.cosine, null);
  await assert.rejects(toolSearch(driver, NAME, { query: QUERY, mode: 'hybrid', embedder: never }), (e) => e instanceof ToolError && /vectors are off for corpus/.test(e.message));
  await assert.rejects(withEnv({ BREAKWALL_SEARCH_MODE: 'vector' }, () => toolSearch(driver, NAME, { query: QUERY, embedder: never })), /env BREAKWALL_SEARCH_MODE names search mode "vector", but vectors are off/);

  const s = await statusOf();
  assert.equal(s.search.vectors, false);
  assert.match(s.search.vectorsSource, /breakwall\.json key "vectors"/);
  assert.equal(s.search.defaultMode, 'lexical');
  assert.equal(s.search.defaultModeSource, 'built-in (vectors off)');
  assert.equal(s.search.unembeddedChunks, c.chunks);

  const qfile = join(mk('bw-sw-q-'), 'questions.json'); // a stand-in: the real eval set is local-only (eval/README.md)
  writeFileSync(qfile, JSON.stringify({ status: 'test', questions: [] }));
  await assert.rejects(runEval({ driver, embedder: never, corpusName: NAME, corpusRoot: dir, questionsFile: qfile }), /needs vectors on/);
});

test('db: the hook still injects on a vectors-off corpus, whatever the search-mode switch says', async (t) => {
  if (skip) return t.skip(skip);
  const proj = mk('bw-sw-proj-');
  writeFileSync(join(proj, MARKER), JSON.stringify({ corpus: NAME, minBm25: 0, limit: 3 }));
  const r = await runHookProcess(hookInput(proj, QUERY, 'sw-1'), { env: { BREAKWALL_HOOK_STATE_DIR: mk('bw-sw-state-'), BREAKWALL_SEARCH_MODE: 'vector', BREAKWALL_VECTORS: '0' } });
  assert.deepEqual(shapeProblems(r, { maxChars: HOOK_DEFAULTS.maxTokens * 4 }), []);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, new RegExp(`bw:${NAME}:docs/auth-v`));
});

test('db: off keeps stored vectors, on embeds only what is missing; a failed sync leaves a half-embedded corpus that refuses hybrid', async (t) => {
  if (skip) return t.skip(skip);
  await wipe(driver, NAME);
  const dir = mk('bw-sw-db2-');
  cpSync(sample, dir, { recursive: true });
  const load = () => loadCorpus(dir, NAME);
  const emb = stubEmbedder();

  // On: everything embedded.
  setConfig(dir, { vectors: true });
  const first = await indexCorpus(driver, load(), { embedder: emb });
  const all = await chunkCounts();
  assert.equal(all.embedded, all.chunks);
  assert.equal(first.embedded, emb.texts);

  // Off, plus one edited section: stored vectors stay (reversible), the edited chunk gets none, nothing is embedded.
  setConfig(dir, { vectors: false });
  writeFileSync(join(dir, 'docs', 'notes.md'), readFileSync(join(dir, 'docs', 'notes.md'), 'utf8') + '\nOne more line written while vectors were off.\n');
  const textsBefore = emb.texts;
  const off = await indexCorpus(driver, load(), { embedder: emb });
  assert.equal(emb.texts, textsBefore, 'nothing embedded while off');
  assert.deepEqual(off.changes.changed, ['docs/notes.md']);
  const mid = await chunkCounts();
  assert.equal(mid.chunks - mid.embedded, 1, 'only the edited chunk lacks a vector');
  assert.equal((await statusOf()).search.unembeddedChunks, 1);
  await inferCorpus(driver, NAME); // built while a chunk had no vector: the similar pass saw less

  // On again, but the embedder fails mid-sync: the corpus says vectors on and still has an unembedded chunk.
  setConfig(dir, { vectors: true });
  await assert.rejects(indexCorpus(driver, load(), { embedder: stubEmbedder({ fail: true }) }), /model unavailable/);
  const s = await statusOf();
  assert.equal(s.search.vectors, true);
  assert.equal(s.search.unembeddedChunks, 1);
  assert.equal(s.search.defaultMode, null);
  assert.match(s.search.defaultModeError, /half-embedded: 1 of/);
  await assert.rejects(toolSearch(driver, NAME, { query: QUERY, embedder: emb }), /half-embedded/);
  assert.equal((await toolSearch(driver, NAME, { query: QUERY, mode: 'lexical', embedder: emb })).mode, 'lexical');

  // A working sync embeds exactly the missing chunk, rewrites no document, and hybrid is back.
  const fixed = await indexCorpus(driver, load(), { embedder: emb });
  assert.equal(fixed.embedded, 1);
  assert.equal(fixed.backfilled, 1);
  assert.equal(fixed.changes.changed.length + fixed.changes.added.length, 0, 'no document rewritten');
  const done = await chunkCounts();
  assert.equal(done.embedded, done.chunks);
  assert.equal((await inferStatus(driver, NAME)).fresh, false, 'the inferred layer built without that vector is stale now');
  const res = await withEnv({ BREAKWALL_SEARCH_MODE: '' }, () => toolSearch(driver, NAME, { query: QUERY, embedder: emb }));
  assert.deepEqual([res.mode, res.modeSource], ['hybrid', 'built-in']);
  const again = await indexCorpus(driver, load(), { embedder: emb });
  assert.equal(again.writes, 0, 'and a repeat sync is still zero writes');
});

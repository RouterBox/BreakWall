// Pure tests first (no database), then DB tests that need the breakwall-neo4j container (skipped loudly otherwise).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { loadCorpus } from '../src/scan.js';
import { connect, indexCorpus, wipe } from '../src/graph.js';
import { fuse, luceneQuery, rank, search, getSection, DEFAULTS } from '../src/search.js';
import { localEmbedder, DIMS, MODEL } from '../src/embed.js';
import { pickThreshold, scoreRanking, gateReport } from '../src/evalrun.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

test('RRF: weights, ranks and the formula', () => {
  const lists = { lexical: [{ id: 'a' }, { id: 'b' }], vector: [{ id: 'b' }, { id: 'c' }] };
  const r = fuse(lists, { weights: { lexical: 1, vector: 1 }, k: 60 });
  assert.deepEqual(r.map((x) => x.id), ['b', 'a', 'c']);
  assert.ok(Math.abs(r[0].fused - (1 / 62 + 1 / 61)) < 1e-12);
  assert.deepEqual(r[0].ranks, { lexical: 2, vector: 1 });
  const one = { lexical: [{ id: 'a' }], vector: [{ id: 'b' }] };
  assert.equal(fuse(one)[0].id, 'a', 'equal weights tie, id breaks it');
  assert.equal(fuse(one, { weights: { lexical: 1, vector: 3 } })[0].id, 'b');
  assert.equal(fuse(one, { weights: { lexical: 3, vector: 1 } })[0].id, 'a');
});

test('RRF: ties break by id, whatever the input order', () => {
  const a = fuse({ lexical: [{ id: 'z' }], vector: [{ id: 'm' }] });
  const b = fuse({ vector: [{ id: 'm' }], lexical: [{ id: 'z' }] });
  assert.deepEqual(a.map((x) => x.id), ['m', 'z']);
  assert.deepEqual(a, b);
});

test('lucene query keeps words only', () => {
  assert.equal(luceneQuery('What is "AND" (a:b) OR c*? Pre-warmed!'), 'what is and or pre warmed');
  assert.equal(luceneQuery('??? ! a'), '');
});

test('rank collapses chunks to sections and uses the best chunk', () => {
  const meta = new Map([
    ['s1~0', { id: 's1~0', sectionId: 's1', path: 'a.md', headingPath: 'A', startLine: 1, endLine: 3, text: 'x', commit: null, cosine: 0.5 }],
    ['s1~1', { id: 's1~1', sectionId: 's1', path: 'a.md', headingPath: 'A', startLine: 4, endLine: 6, text: 'y', commit: null, cosine: 0.4 }],
    ['s2~0', { id: 's2~0', sectionId: 's2', path: 'a.md', headingPath: 'B', startLine: 7, endLine: 9, text: 'z', commit: null, cosine: 0.3 }],
  ]);
  const cand = { lexical: [{ id: 's1~1', score: 3 }, { id: 's2~0', score: 2 }], vector: [{ id: 's1~0', score: 0.9 }], meta };
  const out = rank(cand, { mode: 'hybrid', limit: 10, weights: { lexical: 2, vector: 1 } });
  assert.deepEqual(out.map((r) => r.sectionId), ['s1', 's2']);
  assert.equal(out[0].chunkId, 's1~1', 'best fused chunk of the section is cited');
  assert.equal(out[0].scores.lexicalRank, 1);
  assert.equal(out[0].scores.vectorRank, null);
});

test('threshold picking and eval scoring', () => {
  const items = [0.9, 0.8, 0.7].map((s) => ({ answerable: true, score: s })).concat([0.3, 0.2].map((s) => ({ answerable: false, score: s })));
  const { t } = pickThreshold(items);
  assert.ok(t > 0.3 && t < 0.7);
  const g = gateReport(items);
  assert.equal(g.answerablePassed, 3);
  assert.equal(g.unanswerableRefused, 2);
  const q = { gold: [{ file: 'a.md', heading_path: 'G' }] };
  const m = scoreRanking([{ path: 'a.md', headingPath: 'X' }, { path: 'a.md', headingPath: 'G' }], q);
  assert.equal(m.rr, 0.5);
  assert.equal(m.hit5, true);
  assert.equal(m.top1, false);
});

// ---------- database tests ----------

const NAME = `test-search-${process.pid}`;
const fixture = fileURLToPath(new URL('../fixtures/sample-corpus', import.meta.url));
let driver;
let skip = false;
const tmpDirs = [];

before(async () => {
  driver = connect();
  try {
    await driver.getServerInfo();
  } catch (e) {
    skip = `Neo4j not reachable: ${e.message}`;
    console.warn('SKIPPING search DB tests -', skip);
  }
});
after(async () => {
  if (!skip) {
    await wipe(driver, NAME);
    await wipe(driver, NAME + '-tmp');
  }
  await driver.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Deterministic fake embedder that counts what it is asked to embed. */
function stubEmbedder() {
  const e = {
    model: 'stub-model',
    dims: DIMS,
    calls: 0,
    async embed(texts) {
      e.calls += texts.length;
      return texts.map((t) => {
        const v = Array.from({ length: DIMS }, (_, i) => createHash('sha256').update(`${t}|${i}`).digest().readInt16LE(0) / 32768);
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      });
    },
  };
  return e;
}

test('reindex with no changes embeds zero chunks; an edit re-embeds only the changed chunk', async (t) => {
  if (skip) return t.skip(skip);
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  tmpDirs.push(dir);
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} about topic${i} ` + 'filler '.repeat(25)).join('\n\n');
  writeFileSync(join(dir, 'a.md'), `# Alpha\n\nintro text\n\n## Short\n\nshort section body\n\n## Long\n\n${long}\n`);
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.md'), '# Beta\n\nbeta body about gardening\n');
  const emb = stubEmbedder();
  const corpus = () => loadCorpus(dir, NAME + '-tmp');

  const first = await indexCorpus(driver, corpus(), { embedder: emb });
  assert.ok(first.chunks > first.documents + 2, 'the long section was split into several chunks');
  assert.ok(first.embedded > 0);
  const callsAfterFirst = emb.calls;

  const again = await indexCorpus(driver, corpus(), { embedder: emb });
  assert.equal(again.embedded, 0, 'nothing changed -> nothing embedded');
  assert.equal(emb.calls, callsAfterFirst, 'the embedder was not even called');
  assert.equal(again.chunks, first.chunks);

  writeFileSync(join(dir, 'sub', 'b.md'), '# Beta\n\nbeta body about gardening and also tomatoes\n');
  const edited = await indexCorpus(driver, corpus(), { embedder: emb });
  assert.equal(edited.embedded, 1, 'one changed chunk -> one embedding');
  assert.equal(emb.calls, callsAfterFirst + 1);

  const s = driver.session();
  try {
    const r = await s.run(
      'MATCH (k:Chunk {corpus: $c}) RETURN count(k) AS n, count(k.embedding) AS e, collect(DISTINCT k.embedModel) AS models, size(collect(k.embedHash)) AS h',
      { c: NAME + '-tmp' },
    );
    assert.equal(r.records[0].get('n'), r.records[0].get('e'));
    assert.deepEqual(r.records[0].get('models'), ['stub-model']);
    const idx = await s.run('SHOW INDEXES YIELD name, type, state WHERE name IN ["chunk_text","chunk_embedding"] RETURN name, type, state ORDER BY name');
    assert.deepEqual(idx.records.map((x) => [x.get('name'), x.get('type'), x.get('state')]), [['chunk_embedding', 'VECTOR', 'ONLINE'], ['chunk_text', 'FULLTEXT', 'ONLINE']]);
  } finally {
    await s.close();
  }
});

const QUERIES = [
  'Why are uploaded timetables parsed by background workers instead of inside the upload request?',
  'In which order should the services be restarted after an outage?',
  'Which database holds the timetables and how is the connection configured?',
  'what is the capital of france',
];

test('search on the sample corpus: citations are real, ranking is identical across runs and across a wipe + reindex', async (t) => {
  if (skip) return t.skip(skip);
  const embedder = localEmbedder();
  const corpus = loadCorpus(fixture, NAME);
  await indexCorpus(driver, corpus, { embedder });

  const snapshot = async () => {
    const out = {};
    for (const q of QUERIES) for (const mode of ['lexical', 'vector', 'hybrid']) out[`${mode}:${q}`] = (await search(driver, NAME, q, { mode, limit: 10, embedder })).results;
    return out;
  };
  const a = await snapshot();
  const b = await snapshot();
  assert.deepEqual(a, b, 'two runs on the same index are identical, scores included');

  // Every cited line range reproduces the quoted text from the file.
  for (const rs of Object.values(a)) {
    for (const r of rs) {
      assert.ok(r.path && r.headingPath !== undefined && r.startLine <= r.endLine && r.snippet);
      assert.ok(r.scores.fused !== undefined && 'lexicalRank' in r.scores && 'vectorRank' in r.scores);
      const lines = readFileSync(join(fixture, r.path), 'utf8').split(/\r?\n/);
      assert.equal(lines.slice(r.startLine - 1, r.endLine).join('\n'), r.text);
    }
  }
  // A real answer: the ingest question finds the decision record in the top 3 of the hybrid ranking.
  const top3 = a[`hybrid:${QUERIES[0]}`].slice(0, 3).map((r) => `${r.path}#${r.headingPath}`);
  assert.ok(top3.some((h) => h.startsWith('decisions/0002-queue.md#')), top3.join(' | '));

  // Rebuild: wipe, reindex (re-embeds everything), same ranking.
  await wipe(driver, NAME);
  const re = await indexCorpus(driver, corpus, { embedder });
  assert.ok(re.embedded === re.chunks && re.reused === 0, 'a wiped index re-embeds everything');
  assert.deepEqual(Object.fromEntries(Object.entries(await snapshot()).map(([k, v]) => [k, v.map((r) => r.chunkId)])), Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.map((r) => r.chunkId)])), 'same ranking after wipe + reindex');

  const none = await search(driver, NAME, QUERIES[3], { mode: 'hybrid', limit: 3, embedder });
  assert.equal(none.answered, false, `off-topic query should fall under the no-answer threshold (cos ${none.gate.toFixed(3)} vs ${DEFAULTS.minCosine})`);
  assert.equal((await search(driver, NAME, QUERIES[0], { mode: 'hybrid', limit: 3, embedder })).answered, true);
  assert.equal(MODEL, embedder.model);
});

test('get returns an exact section by id, by path + heading, and by unique heading suffix', async (t) => {
  if (skip) return t.skip(skip);
  const full = 'Tidewater Architecture > Request flow';
  const byPath = await getSection(driver, NAME, 'docs/architecture.md', full);
  assert.equal(byPath.length, 1);
  const raw = readFileSync(join(fixture, 'docs/architecture.md'), 'utf8').split(/\r?\n/);
  assert.equal(byPath[0].text, raw.slice(byPath[0].startLine - 1, byPath[0].endLine).join('\n'));
  const byId = await getSection(driver, NAME, byPath[0].id);
  assert.equal(byId.length, 1);
  assert.equal(byId[0].text, byPath[0].text);
  const bySuffix = await getSection(driver, NAME, 'docs/architecture.md', 'request flow');
  assert.equal(bySuffix.length, 1);
  assert.equal((await getSection(driver, NAME, 'docs/NOPE.md')).length, 0);
});

test('BM25 scores do not depend on index history: another corpus coming and going leaves them unchanged', async (t) => {
  if (skip) return t.skip(skip);
  const embedder = localEmbedder();
  const q = 'timetable ingest queue workers retries';
  const lexical = async () => (await search(driver, NAME, q, { mode: 'lexical', limit: 20, embedder })).results.map((r) => [r.chunkId, r.scores.lexicalScore]);
  await wipe(driver, NAME + '-tmp'); // leftover from the zero-reembed test would change index-wide statistics
  const unchanged = await indexCorpus(driver, loadCorpus(fixture, NAME), { embedder });
  assert.equal(unchanged.skipped, unchanged.documents, 'nothing changed -> no document was rewritten');
  assert.equal(unchanged.embedded, 0);
  const before = await lexical();
  assert.ok(before.length > 0, 'the query matches the corpus');

  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'x.md'), '# X\n\ntimetable timetable ingest queue queue retries\n');
  const name = NAME + '-tmp';
  const emb = stubEmbedder();
  await indexCorpus(driver, loadCorpus(dir, name), { embedder: emb });
  writeFileSync(join(dir, 'x.md'), '# X\n\nworkers workers workers retries\n');
  await indexCorpus(driver, loadCorpus(dir, name), { embedder: emb });
  await wipe(driver, name);

  assert.deepEqual(await lexical(), before);
});

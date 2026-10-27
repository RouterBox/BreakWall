// Needs the breakwall-neo4j container (see README). Skipped, loudly, when it is not reachable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadCorpus } from '../src/scan.js';
import { connect, indexCorpus, wipe, dumpCorpus, rebuildCheck } from '../src/graph.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const NAME = `test-${process.pid}`; // never touches the real corpus names
const fixture = fileURLToPath(new URL('../fixtures/sample-corpus', import.meta.url));
let driver;
let skip = false;

before(async () => {
  driver = connect();
  try {
    await driver.getServerInfo();
  } catch (e) {
    skip = `Neo4j not reachable: ${e.message}`;
    console.warn('SKIPPING graph tests -', skip);
  }
});
after(async () => {
  if (!skip) await wipe(driver, NAME);
  await driver.close();
});

test('index writes documents, sections, structure and link edges with provenance', async (t) => {
  if (skip) return t.skip(skip);
  const corpus = loadCorpus(fixture, NAME);
  const stats = await indexCorpus(driver, corpus);
  assert.equal(stats.documents, corpus.docs.length);
  assert.equal(stats.sections, corpus.docs.reduce((n, d) => n + d.sections.length, 0));

  const s = driver.session();
  try {
    const sec = await s.run(
      `MATCH (x:Section {corpus: $c, path: 'docs/architecture.md', headingPath: 'Tidewater Architecture > Request flow'})
       RETURN x.startLine AS a, x.endLine AS b, x.hash AS h, x.text AS t, x.commit AS commit`,
      { c: NAME },
    );
    assert.equal(sec.records.length, 1);
    const r = sec.records[0];
    assert.ok(r.get('a') < r.get('b'));
    assert.match(r.get('h'), /^[0-9a-f]{64}$/);
    assert.ok(r.get('t').startsWith('## Request flow'));

    const edges = await s.run(
      'MATCH (a {corpus: $c})-[r]->() WHERE type(r) IN ["NEXT","LINKS_TO","CONTAINS"] RETURN type(r) AS t, collect(DISTINCT r.layer) AS layers, count(*) AS n',
      { c: NAME },
    );
    for (const e of edges.records) assert.deepEqual(e.get('layers'), ['deterministic'], e.get('t'));
    const types = edges.records.map((e) => e.get('t'));
    assert.ok(types.includes('NEXT') && types.includes('CONTAINS') && types.includes('LINKS_TO'));
  } finally {
    await s.close();
  }
});

test('re-indexing twice is idempotent', async (t) => {
  if (skip) return t.skip(skip);
  const corpus = loadCorpus(fixture, NAME);
  await indexCorpus(driver, corpus);
  const a = await dumpCorpus(driver, NAME);
  await indexCorpus(driver, corpus);
  assert.equal(await dumpCorpus(driver, NAME), a);
});

test('rebuild test: wipe, reindex, diff is identical (plan section 11)', async (t) => {
  if (skip) return t.skip(skip);
  const r = await rebuildCheck(driver, loadCorpus(fixture, NAME));
  assert.equal(r.wipedToEmpty, true);
  assert.equal(r.identical, true);
  assert.ok(r.nodes > 50 && r.rels > 50, `nodes ${r.nodes}, rels ${r.rels}`);
});

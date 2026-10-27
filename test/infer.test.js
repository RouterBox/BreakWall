// M4 inferred layer. Pure tests first (entities, similarity, Louvain, signals, trace, the decision rule),
// then DB tests against breakwall-neo4j (skipped loudly when it is not reachable) with a counting stub embedder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { loadCorpus } from '../src/scan.js';
import { connect, indexCorpus, wipe, dumpCorpus, rebuildCheck } from '../src/graph.js';
import { search } from '../src/search.js';
import { DIMS, embedStats } from '../src/embed.js';
import { canonKey, extractMentions, buildEntities, matchQuery, PARAMS } from '../src/infer/entities.js';
import { louvain, numberCommunities } from '../src/infer/communities.js';
import { similarEdges, sectionNeighbours } from '../src/infer/similar.js';
import { planSignals } from '../src/infer/signals.js';
import { shortestPath, resolveRef } from '../src/infer/trace.js';
import { inferCorpus, inferStatus, dumpInferred, readRun } from '../src/infer/index.js';
import { toolTrace, toolEntities, toolCommunities } from '../src/infer/tools.js';
import { toolStatus } from '../src/tools.js';
import { decide } from '../src/evalinferred.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

// ---------------------------------------------------------------- entities (pure)

test('canonical keys merge case, plural, separators and camel/snake forms; files and endpoints keep their own identity', () => {
  assert.equal(canonKey('Daemons'), canonKey('daemon'));
  assert.equal(canonKey('flashSummary'), 'flash summary');
  assert.equal(canonKey('flash_summary'), 'flash summary');
  assert.equal(canonKey('Flash Summary'), 'flash summary');
  assert.equal(canonKey('Cross-Agent'), canonKey('cross agent'));
  assert.equal(canonKey('Policies'), 'policy');
  assert.equal(canonKey('status'), 'status', 'a word ending in us is not de-pluralised');
  assert.equal(canonKey('docs/KEEPER.md', 'file'), canonKey('KEEPER.md', 'file'));
  assert.equal(canonKey('/undertow/Query/', 'endpoint'), '/undertow/query');
  assert.equal(canonKey('3030', 'port'), 'port 3030');
  assert.equal(canonKey('getUser()'), 'get user');
});

const sec = (id, text, startLine = 1, docId = 'd1') => ({ id, docId, startLine, text });

test('extraction methods, spans, and the fence and heading rules', () => {
  const text = [
    '## Heading With Title Case',
    'The `flashSummary` field and **Spider daemon** run on localhost:3030.',
    'Call POST /undertow/query then read docs/KEEPER.md. Set NEO4J_PASS.',
    '```bash',
    'curl http://localhost:3030/undertow/health',
    'Haiku Sonnet Opus',
    '```',
    'We ask Prowler and Janitor. Wonder runs later.',
  ].join('\n');
  const ms = extractMentions(sec('s', text, 10));
  const by = (key) => ms.filter((m) => m.key === key);
  assert.equal(by('flash summary')[0].method, 'backtick');
  assert.equal(by('flash summary')[0].type, 'identifier');
  assert.equal(by('spider daemon')[0].method, 'bold');
  assert.deepEqual(by('port 3030').map((m) => m.method), ['port', 'port'], 'once in prose, once inside the fence');
  assert.equal(by('/undertow/query')[0].method, 'endpoint');
  assert.equal(by('/undertow/health')[0].method, 'endpoint', 'endpoints are found inside fences too');
  assert.equal(by('keeper.md')[0].method, 'file');
  assert.equal(by('neo4j pass')[0].method, 'envvar');
  assert.equal(by('flash summary')[0].line, 11, 'line is the file line (section starts at 10)');
  assert.ok(by('prowler').length && by('janitor').length, 'capitalised names mid-sentence');
  assert.ok(!by('haiku sonnet opus').length, 'capitalised-name scanning skips fenced code');
  assert.ok(!ms.some((m) => /heading|title/.test(m.key)), 'title-case headings are not names');
  const wonder = by('wonder')[0];
  assert.equal(wonder.weak, true, 'a sentence-initial single capitalised word is weak');
});

test('entity table: frequency filters, weak mentions recovered, alias merging, explicit alias table, determinism', () => {
  const N = 30;
  const secs = [];
  for (let i = 0; i < N; i++) secs.push(sec(`s${i}`, `## S${i}\nFiller text number ${i} about nothing.`, 1, `d${i % 3}`));
  secs[0].text += '\nThe Spider daemon crawls. Also `ONLYONCE_THING` once.';
  secs[1].text += '\nSpider walks the graph. The `spider` is a daemon.';
  secs[2].text += '\nSpiders run at session end; Atlas Skills are separate.';
  secs[3].text += '\nAtlas Skills ship later.';
  for (const s of secs) s.text += '\nEveryone mentions Neo4j here.'; // in every section: too common
  secs[4].text += '\nWonder runs. And the Wonder daemon reads. Wonder again here: Wonder.';
  secs[5].text += '\nWonder again, mid sentence: ask Wonder.';
  const a = buildEntities(secs, { params: PARAMS });
  const keys = a.entities.map((e) => e.key);
  assert.ok(keys.includes('spider'), 'Spider/Spiders/spider merge into one entity');
  const spider = a.entities.find((e) => e.key === 'spider');
  assert.ok(spider.aliases.map((x) => x.surface).includes('Spiders') || spider.aliases.length >= 1);
  assert.ok(keys.includes('atlas skill'), 'multiword name, plural folded');
  assert.ok(!keys.includes('onlyonce thing'), 'one section only: dropped');
  assert.ok(!keys.includes('neo4j'), 'in every section: dropped as too common');
  assert.ok(a.dropped.rare >= 1 && a.dropped.common >= 1);
  assert.ok(keys.includes('wonder'));
  assert.ok(a.mentions.get('s4').some((m) => m.key === 'wonder'), 'weak sentence-initial Wonder counts once the entity exists');
  const m = a.mentions.get('s4').find((x) => x.key === 'wonder');
  assert.ok(m.spans.length >= 1 && m.spans[0].line >= 1 && m.methods.includes('name'));
  assert.ok(m.score > 0 && m.idf === wonder_idf(a));

  const aliased = buildEntities(secs, { aliasTable: { 'atlas skills': 'Wonder' } });
  assert.ok(!aliased.entities.some((e) => e.key === 'atlas skill'), 'explicit alias table merged it away');
  assert.ok(aliased.entities.find((e) => e.key === 'wonder').aliases.some((x) => /Atlas/.test(x.surface)));

  const b = buildEntities(secs, { params: PARAMS });
  assert.deepEqual(JSON.stringify([a.entities, [...a.mentions]]), JSON.stringify([b.entities, [...b.mentions]]), 'same input, identical output');
});
const wonder_idf = (a) => a.entities.find((e) => e.key === 'wonder').idf;

test('capitalised ordinary words that the corpus also uses in lower case are not entities', () => {
  const secs = [];
  for (let i = 0; i < 6; i++) secs.push(sec(`s${i}`, `risk is a word here and a risk is another, and the risk again.\n| Risk | Mitigation |`, 1, `d${i}`));
  secs.push(sec('t1', 'Prowler runs.\nAsk Prowler now.', 1, 'dx'), sec('t2', 'Use Prowler for search; ask Prowler.', 1, 'dy'), sec('t3', 'You may ask for it, ask again, and ask once more.', 1, 'dz'));
  const keys = buildEntities(secs).entities.map((e) => e.key);
  assert.ok(!keys.includes('risk'));
  assert.ok(keys.includes('prowler'), 'Ask Prowler at a sentence start is Prowler, because ask is an ordinary word here');
  assert.ok(!keys.includes('ask prowler'));
});

test('query matching finds entities by canonical n-gram, alias-aware', () => {
  const table = new Map([['spider', { key: 'spider', name: 'Spider', idf: 2 }], ['flash summary', { key: 'flash summary', name: 'flash_summary', idf: 3 }], ['keeper.md', { key: 'keeper.md', name: 'KEEPER.md', idf: 4 }], ['port 3030', { key: 'port 3030', name: 'port 3030', idf: 4 }]]);
  assert.deepEqual(matchQuery('Does the Spiders daemon use flashSummary?', table).map((e) => e.key), ['flash summary', 'spider']);
  assert.deepEqual(matchQuery('what is in docs/KEEPER.md on 3030', table).map((e) => e.key), ['keeper.md', 'port 3030']);
  assert.deepEqual(matchQuery('nothing relevant', table), []);
});

// ---------------------------------------------------------------- similarity and communities (pure)

const unit = (...xs) => {
  const v = Array.from({ length: 8 }, (_, i) => xs[i] ?? 0);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

test('similar-to: top-k across documents, threshold, no same-document pairs, stub sections skipped, deterministic', () => {
  const sections = [
    { id: 'a1', docId: 'A', bodyLen: 500 }, { id: 'a2', docId: 'A', bodyLen: 500 },
    { id: 'b1', docId: 'B', bodyLen: 500 }, { id: 'c1', docId: 'C', bodyLen: 500 },
    { id: 'd1', docId: 'D', bodyLen: 500 }, { id: 'stub', docId: 'E', bodyLen: 10 },
  ];
  const chunks = [
    { sectionId: 'a1', embedding: unit(1, 0.1) }, { sectionId: 'a2', embedding: unit(1, 0.05) },
    { sectionId: 'b1', embedding: unit(1, 0.2) }, { sectionId: 'c1', embedding: unit(0, 1) },
    { sectionId: 'd1', embedding: unit(0.9, 0.3) }, { sectionId: 'stub', embedding: unit(1, 0.1) },
  ];
  const r = similarEdges(sections, chunks, { k: 2, threshold: 0.9, minBodyChars: 120 });
  assert.equal(r.eligible, 5);
  const pairs = r.edges.map((e) => `${e.a}~${e.b}`);
  assert.ok(!pairs.includes('a1~a2'), 'same document never pairs');
  assert.ok(pairs.includes('a1~b1') && pairs.includes('a1~d1'));
  assert.ok(!pairs.some((p) => p.includes('stub') || p.includes('c1')), 'stub below the body minimum; c1 is orthogonal');
  assert.ok(r.edges.every((e) => e.a < e.b && e.score >= 0.9));
  assert.deepEqual(similarEdges(sections, chunks, { k: 2, threshold: 0.9, minBodyChars: 120 }), r);
  assert.deepEqual(similarEdges(sections, [...chunks].reverse(), { k: 2, threshold: 0.9, minBodyChars: 120 }), r, 'input order does not matter');
  const none = similarEdges(sections, chunks, { k: 1, threshold: 0.9999, minBodyChars: 120 });
  assert.equal(none.edges.length, 0);
  assert.equal(sectionNeighbours(sections, chunks).candidates.get('a1')[0].id, 'b1');
});

test('Louvain: finds the two cliques, same answer every time and for any input order', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const e = [];
  const clique = (xs) => xs.forEach((x, i) => xs.slice(i + 1).forEach((y) => e.push({ a: x, b: y, w: 1 })));
  clique(['a', 'b', 'c', 'd']);
  clique(['e', 'f', 'g', 'h']);
  e.push({ a: 'd', b: 'e', w: 0.1 });
  const r1 = louvain(ids, e);
  const part = (r) => numberCommunities(r.community).map((c) => c.members.join(''));
  assert.deepEqual(part(r1), ['abcd', 'efgh']);
  assert.ok(r1.modularity > 0.4);
  assert.deepEqual(part(louvain([...ids].reverse(), [...e].reverse())), part(r1));
  assert.deepEqual(louvain(ids, e), r1);
  assert.equal(numberCommunities(louvain(['x', 'y'], []).community).length, 0, 'singletons are not communities');
});

// ---------------------------------------------------------------- signals, trace, decision rule (pure)

const baseHits = ['s1', 's2', 's3', 's4', 's5'].map((id) => ({ sectionId: id }));
const idx = (over = {}) => ({
  present: true,
  similar: new Map([['s1', [{ id: 'x1', score: 0.9 }]], ['x1', [{ id: 's1', score: 0.9 }]]]),
  entityByKey: new Map([['spider', { key: 'spider', name: 'Spider', idf: 2 }]]),
  entitySections: new Map([['spider', [{ sectionId: 's4', score: 5, method: 'name' }, { sectionId: 'x2', score: 4, method: 'name' }]]]),
  mentions: new Map(),
  community: new Map([['s1', 1], ['s2', 1], ['s3', 1], ['s4', 2], ['s5', 2]]),
  communities: new Map(),
  ...over,
});

test('signals: no signal and no match leave the base order untouched; each signal moves what it should and says why', () => {
  const base = planSignals(baseHits, idx(), 'unrelated', {});
  assert.deepEqual(base.order.map((o) => o.sectionId), ['s1', 's2', 's3', 's4', 's5']);
  const ent = planSignals(baseHits, idx(), 'tell me about the Spider', { entity: true });
  assert.equal(ent.order[0].sectionId, 's4', 'an entity-matching section rises');
  assert.ok(ent.order.find((o) => o.sectionId === 's4').via[0].startsWith('mentions entity "Spider" (inferred'));
  assert.ok(ent.order.some((o) => o.sectionId === 'x2'), 'a section outside the base list can enter');
  assert.deepEqual(ent.detail.entityMatched, ['spider']);
  const sim = planSignals(baseHits, idx(), 'q', { similar: true });
  assert.ok(sim.order.find((o) => o.sectionId === 'x1').via[0].includes('similar-to (inferred'));
  const com = planSignals(baseHits, idx(), 'q', { community: true, params: { cap: 2, topN: 4, rrfK: 60, seeds: 3, weights: {}, depth: 50 } });
  assert.deepEqual(com.order.map((o) => o.sectionId), ['s1', 's2', 's4', 's5', 's3'], 'at most 2 per community in the top N, the rest pushed below');
  assert.deepEqual(planSignals(baseHits, idx(), 'q', { community: true }), planSignals(baseHits, idx(), 'q', { community: true }));
  assert.deepEqual(planSignals(baseHits, { present: false }, 'q', { similar: true, entity: true, community: true }).order.map((o) => o.sectionId), ['s1', 's2', 's3', 's4', 's5']);
});

test('trace: cheapest path, deterministic edges preferred by cost, layer filter, stable ties, reference resolution', () => {
  const g = { sections: new Map(), entities: new Map(), entityByKey: new Map(), docFirst: new Map(), edges: [], adj: new Map() };
  const S = (id, path, headingPath, ordinal = 0) => {
    const s = { kind: 'section', id, path, headingPath, ordinal, startLine: 1, endLine: 2 };
    g.sections.set(id, s);
    if (!g.docFirst.has(path)) g.docFirst.set(path, s);
  };
  S('A', 'a.md', 'A'); S('B', 'a.md', 'A > B', 1); S('C', 'b.md', 'C'); S('D', 'c.md', 'D');
  const E = { kind: 'entity', id: 'E', key: 'spider', name: 'Spider', type: 'name', aliases: [] };
  g.entities.set('E', E);
  g.entityByKey.set('spider', E);
  const add = (a, b, type, layer, cost, props = {}) => {
    const edge = { a, b, type, layer, props, cost };
    g.edges.push(edge);
    for (const [x, y, d] of [[a, b, 'forward'], [b, a, 'reverse']]) g.adj.set(x, [...(g.adj.get(x) || []), { to: y, edge, direction: d }]);
  };
  add('A', 'B', 'CONTAINS', 'deterministic', 1);
  add('B', 'C', 'LINKS_TO', 'deterministic', 1);
  add('A', 'E', 'MENTIONS_ENTITY', 'inferred', 2);
  add('E', 'D', 'MENTIONS_ENTITY', 'inferred', 2);
  add('C', 'D', 'SIMILAR_TO', 'inferred', 2.4, { score: 0.6 });
  const p = shortestPath(g, 'A', 'D', {});
  assert.deepEqual(p.hops.map((h) => h.to), ['E', 'D'], 'two inferred hops (cost 4) beat B,C,D (cost 4.4)');
  assert.equal(p.cost, 4);
  assert.deepEqual(shortestPath(g, 'A', 'D', { layers: 'deterministic' }), null, 'no deterministic path to D');
  assert.deepEqual(shortestPath(g, 'A', 'C', { layers: 'deterministic' }).hops.map((h) => h.edge.layer), ['deterministic', 'deterministic']);
  assert.equal(shortestPath(g, 'A', 'D', { maxHops: 1 }), null);
  assert.deepEqual(shortestPath(g, 'A', 'D', {}).hops.map((h) => h.from + h.to), p.hops.map((h) => h.from + h.to), 'repeatable');
  assert.equal(shortestPath(g, 'A', 'A', {}).hops.length, 0);

  assert.equal(resolveRef(g, 'A').id, 'A');
  assert.equal(resolveRef(g, 'a.md#B').id, 'B', 'path#heading suffix');
  assert.equal(resolveRef(g, 'b.md').id, 'C', 'a document path is its title section');
  assert.equal(resolveRef(g, 'Spiders').id, 'E', 'entity by alias-folded name');
  assert.equal(resolveRef(g, 'entity:spider').id, 'E');
  assert.throws(() => resolveRef(g, 'nothing like this'), /cannot resolve/);
  assert.throws(() => resolveRef(g, 'zzz.md#x'), /no document/);
});

test('decision rule (plan item 36): needs a gain, no loss of a question, and more wins than losses', () => {
  const base = { n: 19, recall5: 14 / 19, recall10: 16 / 19, mrr: 0.669, top1: 11 / 19 };
  const cfg = (o) => ({ ...base, ...o });
  assert.equal(decide(base, cfg({ recall10: 17 / 19 }), { better: 2, worse: 1 }).pass, true);
  assert.equal(decide(base, cfg({ mrr: 0.70 }), { better: 3, worse: 1 }).pass, true);
  assert.equal(decide(base, cfg({ recall10: 17 / 19, top1: 10 / 19 }), { better: 3, worse: 1 }).pass, false, 'loses a top-1 citation');
  assert.equal(decide(base, cfg({ recall10: 18 / 19 }), { better: 2, worse: 2 }).pass, false, 'not more wins than losses');
  assert.equal(decide(base, cfg({ mrr: 0.68 }), { better: 3, worse: 0 }).pass, false, 'gain below the noise floor');
  assert.equal(decide(base, base, { better: 0, worse: 0 }).pass, false);
});

// ---------------------------------------------------------------- database

const NAME = `test-infer-${process.pid}`;
let driver;
let skip = false;
const tmpDirs = [];

before(async () => {
  driver = connect();
  try {
    await driver.getServerInfo();
  } catch (e) {
    skip = `Neo4j not reachable: ${e.message}`;
    console.warn('SKIPPING infer DB tests -', skip);
  }
});
after(async () => {
  if (!skip) await wipe(driver, NAME);
  await driver.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Deterministic bag-of-words embedder: texts that share words are close. Counts what it is asked to embed. */
function bowEmbedder() {
  const e = {
    model: 'stub-bow',
    dims: DIMS,
    calls: 0,
    async embed(texts) {
      e.calls += texts.length;
      return texts.map((t) => {
        const v = new Array(DIMS).fill(0);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) || []) v[createHash('sha256').update(w).digest().readUInt16LE(0) % DIMS] += 1;
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
  return e;
}

const FILLER = 'This section describes how the daemon handles session tokens, expiry windows, retries and storage of hashed values so the behaviour stays predictable under load. ';
function corpusDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bw-infer-'));
  tmpDirs.push(dir);
  const w = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  w('a.md', `# Alpha\n\n## Spider\n\nThe Spider daemon walks the graph and writes edges. ${FILLER.repeat(2)}See [Beta](b.md#crawl). Config is in \`daemon-config.json\`.\n\n## Wonder\n\nWonder runs between turns and reads the transcript. ${FILLER}\n`);
  w('b.md', `# Beta\n\n## Crawl\n\nThe Spider daemon also crawls on a schedule. ${FILLER.repeat(2)}Uses \`daemon-config.json\` and POST /undertow/spider.\n\n## Keeper\n\nThe Keeper decides which sessions deserve memory, unrelated to the crawl entirely. Gatekeeping policy only here.\n`);
  w('c.md', `# Gamma\n\n## Notes\n\nWonder is mentioned here too. ${FILLER}\nOperators call POST /undertow/spider by hand.\n\n## Appendix\n\nNothing links here and nothing shared, just plain words about weather and trains and tea.\n`);
  return dir;
}

test('infer builds the layer, labels everything inferred, never touches the deterministic layer, and calls no embedder', async (t) => {
  if (skip) return t.skip(skip);
  const dir = corpusDir();
  const emb = bowEmbedder();
  await wipe(driver, NAME);
  const corpus = loadCorpus(dir, NAME);
  await indexCorpus(driver, corpus, { embedder: emb });
  const detBefore = await dumpCorpus(driver, NAME);
  const callsAfterIndex = emb.calls;
  const stats0 = { ...embedStats };

  const r = await inferCorpus(driver, NAME, { passes: ['similar', 'entities', 'communities'] });
  assert.equal(r.unchanged, false);
  assert.ok(r.counts.entities > 0 && r.counts.mentionEdges > 0 && r.counts.communities >= 1);
  assert.equal(emb.calls, callsAfterIndex, 'the stub embedder was not called by the inferred pass');
  assert.deepEqual(embedStats, stats0, 'the real embedder counters did not move either');
  assert.equal(await dumpCorpus(driver, NAME), detBefore, 'deterministic dump is byte-identical after infer');

  const s = driver.session();
  try {
    const rels = (await s.run("MATCH (a)-[r]->(b) WHERE (a.corpus = $c OR b.corpus = $c) AND type(r) IN ['SIMILAR_TO','MENTIONS_ENTITY','IN_COMMUNITY'] RETURN type(r) AS t, r.layer AS layer, r.method AS method, r.run AS run", { c: NAME })).records.map((x) => x.toObject());
    assert.ok(rels.length > 0 && rels.every((x) => x.layer === 'inferred' && x.method && x.run === r.run));
    const det = (await s.run("MATCH (a)-[r]->(b) WHERE a.corpus = $c AND r.layer = 'deterministic' RETURN DISTINCT type(r) AS t", { c: NAME })).records.map((x) => x.get('t'));
    assert.ok(!det.some((x) => ['SIMILAR_TO', 'MENTIONS_ENTITY', 'IN_COMMUNITY'].includes(x)), 'no inferred type among deterministic edges');
    const nodes = (await s.run("MATCH (n {corpus: $c}) WHERE n:Entity OR n:Community OR n:InferredRun RETURN n.layer AS layer", { c: NAME })).records.map((x) => x.get('layer'));
    assert.ok(nodes.length > 0 && nodes.every((l) => l === 'inferred'));
    const prov = (await s.run("MATCH (:Section)-[r:MENTIONS_ENTITY]->(e:Entity {key: 'spider'}) RETURN r.spans AS spans, r.methods AS methods", {})).records;
    assert.ok(prov.length >= 2);
    const spans = JSON.parse(prov[0].get('spans'));
    assert.ok(spans[0].line >= 1 && typeof spans[0].col === 'number' && spans[0].method, 'provenance: line, column, surface, method');
  } finally {
    await s.close();
  }
  const sim = await toolEntities(driver, NAME, { query: 'spider', aliases: true });
  assert.ok(sim.entities.find((e) => e.key === 'spider').aliases.length >= 1);
  const comm = await toolCommunities(driver, NAME, { members: true });
  assert.ok(comm.communities.length >= 1 && comm.communities[0].members.length >= 2);
});

test('reproducible: the same corpus gives identical edges, entities and communities, also after a wipe and rebuild', async (t) => {
  if (skip) return t.skip(skip);
  const dir = corpusDir();
  const emb = bowEmbedder();
  await wipe(driver, NAME);
  const corpus = loadCorpus(dir, NAME);
  await indexCorpus(driver, corpus, { embedder: emb });
  const a = await inferCorpus(driver, NAME, { force: true });
  const d1 = await dumpInferred(driver, NAME);
  const b = await inferCorpus(driver, NAME, { force: true });
  assert.equal(a.outputDigest, b.outputDigest);
  assert.equal(await dumpInferred(driver, NAME), d1, 'forced recomputation in place changes nothing');

  const rc = await rebuildCheck(driver, corpus, { embedder: emb, inferred: true });
  assert.equal(rc.identical, true, JSON.stringify(rc));
  assert.equal(rc.inferred.identical, true);
  assert.ok(rc.inferred.nodes > 0 && rc.inferred.rels > 0);
  assert.equal(await dumpInferred(driver, NAME), d1, 'wipe + sync + infer reproduces the same inferred layer');
  const plain = await rebuildCheck(driver, corpus, { embedder: emb });
  assert.equal(plain.digest, rc.digest, 'the deterministic digest does not depend on whether the inferred layer exists');
});

test('sync interplay: unchanged = zero writes; a change makes the layer stale and infer recomputes it whole', async (t) => {
  if (skip) return t.skip(skip);
  const dir = corpusDir();
  const emb = bowEmbedder();
  await wipe(driver, NAME);
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  await inferCorpus(driver, NAME, { force: true });
  assert.equal((await inferStatus(driver, NAME)).fresh, true);
  const again = await inferCorpus(driver, NAME);
  assert.equal(again.unchanged, true);
  assert.equal(again.writes, 0, 'nothing to do: zero graph writes');
  const statusFresh = (await toolStatus(driver)).corpora.find((c) => c.corpus === NAME).inferred;
  assert.equal(statusFresh.present, true);
  assert.equal(statusFresh.fresh, true);

  writeFileSync(join(dir, 'c.md'), `# Gamma\n\n## Notes\n\nThe Spider daemon is mentioned here now. ${FILLER}\n\n## Appendix\n\nNothing links here and nothing shared, just plain words about weather and trains and tea.\n`);
  const sync = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.deepEqual(sync.changes.changed, ['c.md']);
  const stale = await inferStatus(driver, NAME);
  assert.equal(stale.fresh, false, 'the layer knows it is stale');
  const rec = await inferCorpus(driver, NAME);
  assert.equal(rec.unchanged, false);
  assert.equal((await inferStatus(driver, NAME)).fresh, true);
  // the recomputed layer equals one built from scratch on the changed corpus
  const dump = await dumpInferred(driver, NAME);
  await wipe(driver, NAME);
  await wipe(driver, NAME);
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  await inferCorpus(driver, NAME);
  assert.equal(await dumpInferred(driver, NAME), dump);
});

test('search signals are opt-in, labelled inferred, and skipped with a note when the layer is missing', async (t) => {
  if (skip) return t.skip(skip);
  const dir = corpusDir();
  const emb = bowEmbedder();
  await wipe(driver, NAME);
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  const noLayer = await search(driver, NAME, 'Spider daemon', { embedder: emb, signals: { entity: true } });
  assert.deepEqual(noLayer.signals.applied, []);
  assert.match(noLayer.signals.note, /infer/);
  await inferCorpus(driver, NAME);
  const plain = await search(driver, NAME, 'Spider daemon', { embedder: emb, limit: 5 });
  assert.deepEqual(plain.signals.applied, [], 'off unless requested (defaults are off, see eval/results-m4.md)');
  assert.ok(plain.results.every((r) => !r.inferred));
  const ent = await search(driver, NAME, 'Spider daemon', { embedder: emb, limit: 5, signals: { entity: true } });
  assert.deepEqual(ent.signals.applied, ['entity']);
  const tagged = ent.results.filter((r) => r.inferred && r.inferred.via.some((v) => v.includes('mentions entity "Spider"')));
  assert.ok(tagged.length >= 2, 'sections mentioning Spider carry the inferred reason');
  assert.equal(ent.gate, plain.gate, 'the no-answer gate still looks at the base ranking');
  const all = await search(driver, NAME, 'Spider daemon', { embedder: emb, limit: 5, signals: { similar: true, entity: true, community: true } });
  assert.equal(JSON.stringify(all.results.map((r) => r.sectionId)), JSON.stringify((await search(driver, NAME, 'Spider daemon', { embedder: emb, limit: 5, signals: { similar: true, entity: true, community: true } })).results.map((r) => r.sectionId)), 'repeatable');
});

test('trace: hops carry edge, layer, method, score and provenance; deterministic-only path shown beside it', async (t) => {
  if (skip) return t.skip(skip);
  const dir = corpusDir();
  const emb = bowEmbedder();
  await wipe(driver, NAME);
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  await inferCorpus(driver, NAME);

  const linked = await toolTrace(driver, NAME, { from: 'a.md#Spider', to: 'b.md#Crawl' });
  assert.equal(linked.path.found, true);
  const h = linked.path.hops[0];
  assert.equal(h.edge.layer, 'deterministic');
  assert.equal(h.edge.type, 'LINKS_TO');
  assert.ok(h.edge.provenance.line >= 1 && h.edge.provenance.link);
  assert.equal(linked.path.usesInferred, false);

  const viaEntity = await toolTrace(driver, NAME, { from: 'a.md#Wonder', to: 'c.md#Notes' });
  assert.equal(viaEntity.path.found, true);
  assert.equal(viaEntity.path.usesInferred, true, 'Wonder sections are only connected through the entity (or similarity)');
  const inferredHop = viaEntity.path.hops.find((x) => x.edge.layer === 'inferred');
  assert.ok(inferredHop.edge.method && inferredHop.explanation.includes('inferred'));
  assert.ok(['MENTIONS_ENTITY', 'SIMILAR_TO'].includes(inferredHop.edge.type));
  assert.equal(viaEntity.deterministicOnly.found, false, 'the deterministic-only path is reported beside it');
  const detOnly = await toolTrace(driver, NAME, { from: 'a.md#Wonder', to: 'c.md#Notes', layers: 'deterministic' });
  assert.equal(detOnly.path.found, false);

  const toEntity = await toolTrace(driver, NAME, { from: 'a.md#Spider', to: 'entity:Spider' });
  assert.equal(toEntity.path.hops.length, 1);
  assert.equal(toEntity.path.hops[0].edge.type, 'MENTIONS_ENTITY');
  assert.ok(toEntity.path.hops[0].edge.score > 0 && toEntity.path.hops[0].edge.provenance.spans.length >= 1);
  await assert.rejects(toolTrace(driver, NAME, { from: 'a.md#Nope', to: 'b.md#Crawl' }), /no section/);
  await assert.rejects(toolTrace(driver, NAME, { from: 'a.md#Spider', to: 'b.md#Crawl', layers: 'sideways' }), /layers must be/);
  assert.equal(JSON.stringify(await toolTrace(driver, NAME, { from: 'a.md#Wonder', to: 'c.md#Notes' })), JSON.stringify(viaEntity), 'repeatable');
});

test('no model, no network: the inferred modules import nothing that could call out', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['entities', 'similar', 'communities', 'index', 'signals', 'trace', 'tools']) {
    const src = readFileSync(fileURLToPath(new URL(`../src/infer/${f}.js`, import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const i of imports) assert.ok(i.startsWith('.') || i.startsWith('node:') || i === 'neo4j-driver', `${f}.js imports ${i}`);
    assert.ok(!/fetch\(|XMLHttpRequest|https?:\/\/|embedder|localEmbedder|@xenova/.test(src.replace(/\/\/.*$/gm, '')), `${f}.js mentions a network or embedder call`);
  }
});

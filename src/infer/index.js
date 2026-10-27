// The inferred layer (M4): reads the deterministic graph, computes the passes in memory, and replaces the corpus'
// whole inferred layer in one transaction. Everything written here carries layer: 'inferred' (plan item 33).
// Nothing in this file calls an embedder or any network service.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEntities, PARAMS as ENTITY_PARAMS } from './entities.js';
import { similarEdges, SIMILAR } from './similar.js';
import { louvain, numberCommunities } from './communities.js';

export const PASSES = ['similar', 'entities', 'communities'];
export const COMMUNITY_PARAMS = { containsWeight: 1, linkWeight: 1, resolution: 1, minSize: 2, labelEntities: 3 };
export const VERSION = 1;

// The layer is a function of the corpus AND of the pass code, so the code is part of the input digest: change an
// extractor and the stored layer is stale, never silently reused.
const here = (f) => new URL(f, import.meta.url);
export const CODE_DIGEST = createHash('sha256')
  .update(['entities.js', 'similar.js', 'communities.js'].map((f) => readFileSync(here(f), 'utf8')).join('|'))
  .digest('hex')
  .slice(0, 16);

const sha = (t) => createHash('sha256').update(t).digest('hex');
const INFERRED_RELS = 'SIMILAR_TO|MENTIONS_ENTITY|IN_COMMUNITY';

async function rows(driver, query, params = {}) {
  const s = driver.session();
  try {
    return (await s.run(query, params)).records.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])));
  } finally {
    await s.close();
  }
}

const sumUpdates = (counters) => Object.values(counters.updates()).reduce((a, b) => a + b, 0);
const bodyLen = (text) => text.replace(/^#{1,6}\s.*\n?/, '').trim().length;

/** Optional explicit alias table: breakwall.json -> { "entities": { "aliases": { "wonder daemon": "Wonder" } } }. */
export function loadAliasTable(root) {
  if (!root || !existsSync(join(root, 'breakwall.json'))) return {};
  try {
    const a = JSON.parse(readFileSync(join(root, 'breakwall.json'), 'utf8'))?.entities?.aliases;
    return a && typeof a === 'object' && !Array.isArray(a) ? Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v === 'string')) : {};
  } catch {
    return {};
  }
}

/** Everything the passes need that is not a vector. Live (non-tombstoned) content only. */
export async function readInputs(driver, corpus) {
  const sections = await rows(
    driver,
    `MATCH (s:Section {corpus: $c}) WHERE s.deleted IS NULL
     RETURN s.id AS id, s.docId AS docId, s.path AS path, s.headingPath AS headingPath, s.level AS level, s.ordinal AS ordinal,
            s.startLine AS startLine, s.endLine AS endLine, s.text AS text, s.hash AS hash, s.commit AS commit ORDER BY s.id`,
    { c: corpus },
  );
  for (const s of sections) s.bodyLen = bodyLen(s.text);
  const chunks = await rows(driver, 'MATCH (k:Chunk {corpus: $c}) RETURN k.id AS id, k.sectionId AS sectionId, k.embedHash AS embedHash, k.embedding IS NULL AS unembedded ORDER BY k.id', { c: corpus });
  const contains = await rows(driver, 'MATCH (p:Section {corpus: $c})-[:CONTAINS]->(s:Section) WHERE p.deleted IS NULL AND s.deleted IS NULL RETURN p.id AS a, s.id AS b ORDER BY a, b', { c: corpus });
  const firstOfDoc = new Map(); // docId -> title section (lowest ordinal)
  for (const s of sections) if (!firstOfDoc.has(s.docId) || s.ordinal < firstOfDoc.get(s.docId).ordinal) firstOfDoc.set(s.docId, s);
  const rawLinks = await rows(
    driver,
    `MATCH (a:Section {corpus: $c})-[r:LINKS_TO]->(t) WHERE a.deleted IS NULL AND (t:Section OR t:Document) AND t.deleted IS NULL
     RETURN a.id AS a, t.id AS t, (t:Section) AS isSection ORDER BY a, t`,
    { c: corpus },
  );
  const links = rawLinks.map((l) => ({ a: l.a, b: l.isSection ? l.t : firstOfDoc.get(l.t)?.id })).filter((l) => l.b && l.a !== l.b);
  const root = (await rows(driver, 'MATCH (c:Corpus {id: $c}) RETURN c.root AS root', { c: corpus }))[0]?.root ?? null;
  return { sections, chunks, contains, links, aliasTable: loadAliasTable(root) };
}

export function defaultParams() {
  return { version: VERSION, code: CODE_DIGEST, similar: SIMILAR, entities: ENTITY_PARAMS, communities: COMMUNITY_PARAMS };
}

export function inputDigest(inputs, passes, params = defaultParams()) {
  // Chunks without a vector (vectors off, plan item 57) change what the similar pass sees, so they enter the digest;
  // the key is added only when there are some, which leaves the digest of a fully embedded corpus as it was.
  const unembedded = inputs.chunks.filter((k) => k.unembedded).map((k) => k.id);
  return sha(
    JSON.stringify({
      ...(unembedded.length ? { unembedded } : {}),
      passes: [...passes].sort(),
      params,
      sections: inputs.sections.map((s) => [s.id, s.docId, s.hash, s.startLine]),
      chunks: inputs.chunks.map((k) => [k.id, k.sectionId, k.embedHash]),
      contains: inputs.contains.map((x) => [x.a, x.b]),
      links: inputs.links.map((x) => [x.a, x.b]),
      aliases: Object.entries(inputs.aliasTable).sort(),
    }),
  );
}

/** Pure: inputs (+ vectors for the similar pass) in, passes out. */
export function computeInferred(inputs, passes, vectors, params = defaultParams()) {
  const want = new Set(passes);
  const out = { similar: null, entities: null, communities: null };
  if (want.has('similar')) {
    const chunks = vectors.map((k) => ({ sectionId: k.sectionId, embedding: k.embedding }));
    out.similar = similarEdges(inputs.sections.map((s) => ({ id: s.id, docId: s.docId, bodyLen: s.bodyLen })), chunks, params.similar);
  }
  if (want.has('entities')) out.entities = buildEntities(inputs.sections, { aliasTable: inputs.aliasTable, params: params.entities });
  if (want.has('communities')) {
    const p = params.communities;
    const w = new Map();
    const addEdge = (a, b, x) => {
      if (a === b) return;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      w.set(`${lo}\u0000${hi}`, (w.get(`${lo}\u0000${hi}`) || 0) + x);
    };
    for (const e of inputs.contains) addEdge(e.a, e.b, p.containsWeight);
    for (const e of inputs.links) addEdge(e.a, e.b, p.linkWeight);
    if (out.similar) for (const e of out.similar.edges) addEdge(e.a, e.b, e.score);
    const edges = [...w.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, x]) => {
      const [a, b] = k.split('\u0000');
      return { a, b, w: Math.round(x * 1e6) / 1e6 };
    });
    const res = louvain(inputs.sections.map((s) => s.id), edges, { resolution: p.resolution });
    const numbered = numberCommunities(res.community, p.minSize);
    const byId = new Map(inputs.sections.map((s) => [s.id, s]));
    const entityName = out.entities ? new Map(out.entities.entities.map((e) => [e.key, e.name])) : null;
    const communities = numbered.map((c) => {
      let label;
      if (out.entities) {
        const acc = new Map();
        for (const sid of c.members) for (const m of out.entities.mentions.get(sid) || []) acc.set(m.key, (acc.get(m.key) || 0) + m.score);
        label = [...acc.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, p.labelEntities).map(([k]) => entityName.get(k)).join(', ');
      }
      if (!label) {
        const docs = new Map();
        for (const sid of c.members) docs.set(byId.get(sid).path, (docs.get(byId.get(sid).path) || 0) + 1);
        label = [...docs.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
      }
      const docSet = new Set(c.members.map((m) => byId.get(m).docId));
      return { n: c.n, members: c.members, label, docs: docSet.size };
    });
    out.communities = { communities, modularity: res.modularity, levels: res.levels, graphEdges: edges.length, singletons: inputs.sections.length - communities.reduce((s, c) => s + c.members.length, 0) };
  }
  return out;
}

/** Hash of the computed layer itself, to compare two runs for equality. */
export function outputDigest(out) {
  return sha(
    JSON.stringify({
      similar: out.similar && out.similar.edges,
      entities: out.entities && { e: out.entities.entities, m: [...out.entities.mentions.entries()] },
      communities: out.communities && out.communities.communities.map((c) => [c.n, c.members, c.label]),
    }),
  );
}

async function readVectors(driver, corpus) {
  return rows(driver, 'MATCH (k:Chunk {corpus: $c}) WHERE k.embedding IS NOT NULL RETURN k.id AS id, k.sectionId AS sectionId, k.embedding AS embedding ORDER BY k.id', { c: corpus });
}

export async function readRun(driver, corpus) {
  const r = (await rows(driver, 'MATCH (r:InferredRun {id: $id}) RETURN properties(r) AS p', { id: `${corpus}:inferred-run` }))[0];
  return r ? r.p : null;
}

/** Compute and store the inferred layer. Zero graph writes when the inputs and parameters are unchanged. */
export async function inferCorpus(driver, corpus, { passes = PASSES, force = false, params = defaultParams(), log = () => {} } = {}) {
  const unknown = passes.filter((p) => !PASSES.includes(p));
  if (unknown.length) throw new Error(`unknown pass "${unknown[0]}"; passes: ${PASSES.join(', ')}`);
  const t0 = process.hrtime.bigint();
  const ms = () => Number((process.hrtime.bigint() - t0) / 1000000n);
  const inputs = await readInputs(driver, corpus);
  const digest = inputDigest(inputs, passes, params);
  const prev = await readRun(driver, corpus);
  if (!force && prev && prev.inputDigest === digest) {
    return { unchanged: true, writes: 0, run: digest.slice(0, 12), passes, ms: ms(), counts: JSON.parse(prev.counts) };
  }
  const vectors = passes.includes('similar') ? await readVectors(driver, corpus) : [];
  const tRead = ms();
  const out = computeInferred(inputs, passes, vectors, params);
  const tCompute = ms();
  const run = digest.slice(0, 12);
  const counts = {
    similarEdges: out.similar ? out.similar.edges.length : null,
    similarEligibleSections: out.similar ? out.similar.eligible : null,
    entities: out.entities ? out.entities.entities.length : null,
    mentionEdges: out.entities ? [...out.entities.mentions.values()].reduce((s, l) => s + l.length, 0) : null,
    communities: out.communities ? out.communities.communities.length : null,
    communityMemberships: out.communities ? out.communities.communities.reduce((s, c) => s + c.members.length, 0) : null,
    modularity: out.communities ? out.communities.modularity : null,
  };
  const oDigest = outputDigest(out);

  const session = driver.session();
  let writes = 0;
  const exec = async (tx, q, p) => {
    const r = await tx.run(q, p);
    writes += sumUpdates(r.summary.counters);
  };
  const tx = session.beginTransaction();
  try {
    await exec(tx, `MATCH (:Section {corpus: $c})-[r:${INFERRED_RELS}]->() DELETE r`, { c: corpus });
    await exec(tx, "MATCH (n {corpus: $c, layer: 'inferred'}) DETACH DELETE n", { c: corpus });
    await exec(
      tx,
      'CREATE (r:InferredRun {id: $id, corpus: $c, layer: "inferred", method: "run", run: $run, inputDigest: $d, outputDigest: $o, passes: $passes, params: $params, counts: $counts})',
      { id: `${corpus}:inferred-run`, c: corpus, run, d: digest, o: oDigest, passes: JSON.stringify([...passes].sort()), params: JSON.stringify(params), counts: JSON.stringify(counts) },
    );
    const base = { layer: 'inferred', run };
    if (out.similar) {
      await exec(
        tx,
        'UNWIND $rows AS r MATCH (a:Section {id: r.a}), (b:Section {id: r.b}) CREATE (a)-[x:SIMILAR_TO]->(b) SET x = r.props',
        { rows: out.similar.edges.map((e) => ({ a: e.a, b: e.b, props: { ...base, method: 'embedding-cosine-topk', score: e.score, k: params.similar.k, threshold: params.similar.threshold } })) },
      );
    }
    if (out.entities) {
      await exec(
        tx,
        'UNWIND $rows AS e CREATE (n:Entity) SET n = e',
        {
          rows: out.entities.entities.map((e) => ({
            ...base, id: `${corpus}:entity:${e.key}`, corpus, method: 'extract', key: e.key, name: e.name, type: e.type,
            aliases: JSON.stringify(e.aliases), sectionDf: e.sectionDf, docDf: e.docDf, idf: e.idf, mentions: e.mentions,
          })),
        },
      );
      const rowsM = [];
      for (const [sid, list] of out.entities.mentions) {
        for (const m of list) {
          rowsM.push({ s: sid, e: `${corpus}:entity:${m.key}`, props: { ...base, method: m.method, methods: m.methods.join(','), score: m.score, tf: m.tf, idf: m.idf, count: m.count, spans: JSON.stringify(m.spans) } });
        }
      }
      for (let i = 0; i < rowsM.length; i += 2000) {
        await exec(tx, 'UNWIND $rows AS r MATCH (s:Section {id: r.s}), (e:Entity {id: r.e}) CREATE (s)-[x:MENTIONS_ENTITY]->(e) SET x = r.props', { rows: rowsM.slice(i, i + 2000) });
      }
    }
    if (out.communities) {
      await exec(
        tx,
        'UNWIND $rows AS c CREATE (n:Community) SET n = c',
        { rows: out.communities.communities.map((c) => ({ ...base, id: `${corpus}:community:${c.n}`, corpus, method: 'louvain', n: c.n, size: c.members.length, docs: c.docs, label: c.label, modularity: out.communities.modularity })) },
      );
      const rowsC = out.communities.communities.flatMap((c) => c.members.map((s) => ({ s, c: `${corpus}:community:${c.n}` })));
      for (let i = 0; i < rowsC.length; i += 2000) {
        await exec(tx, 'UNWIND $rows AS r MATCH (s:Section {id: r.s}), (c:Community {id: r.c}) CREATE (s)-[x:IN_COMMUNITY]->(c) SET x = $props', { rows: rowsC.slice(i, i + 2000), props: { ...base, method: 'louvain' } });
      }
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    await session.close();
  }
  return { unchanged: false, writes, run, passes, counts, outputDigest: oDigest, ms: ms(), timing: { readMs: tRead, computeMs: tCompute - tRead, writeMs: ms() - tCompute }, dropped: out.entities ? out.entities.dropped : null };
}

/** Is the stored inferred layer still the function of the current deterministic graph? */
export async function inferStatus(driver, corpus) {
  const run = await readRun(driver, corpus);
  if (!run) return { present: false };
  const inputs = await readInputs(driver, corpus);
  const passes = JSON.parse(run.passes);
  const params = JSON.parse(run.params);
  const now = inputDigest(inputs, passes, params);
  const code = inputDigest(inputs, passes, defaultParams());
  return {
    present: true,
    fresh: now === run.inputDigest,
    paramsCurrent: code === now,
    run: run.run,
    passes,
    counts: JSON.parse(run.counts),
    outputDigest: run.outputDigest,
  };
}

/** Canonical text dump of one corpus' inferred layer, for the rebuild check and the reproducibility tests. */
export async function dumpInferred(driver, corpus) {
  const nodes = await rows(driver, "MATCH (n {corpus: $c, layer: 'inferred'}) RETURN labels(n) AS l, properties(n) AS p", { c: corpus });
  const rels = await rows(
    driver,
    "MATCH (a)-[r]->(b) WHERE r.layer = 'inferred' AND (a.corpus = $c OR b.corpus = $c) RETURN a.id AS a, type(r) AS t, b.id AS b, properties(r) AS p",
    { c: corpus },
  );
  const sorted = (o) => JSON.stringify(o, Object.keys(o).sort());
  const lines = [
    ...nodes.map((r) => `N ${r.l.sort().join(':')} ${sorted(r.p)}`),
    ...rels.map((r) => `R ${r.a} -${r.t}-> ${r.b} ${sorted(r.p)}`),
  ];
  return lines.sort().join('\n');
}

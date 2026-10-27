// Retrieval: BM25 (Neo4j full-text) + vector (Neo4j vector index), fused with reciprocal rank fusion.
// Everything after candidate retrieval is pure and deterministic: equal scores break ties by chunk id.
import neo4j from 'neo4j-driver';
import { cosine, localEmbedder } from './embed.js';
import { luceneQuery } from './luceneq.js';
import { loadInferredIndex, applySignals, SIGNAL_PARAMS } from './infer/signals.js';

export const DEFAULTS = {
  depth: 50, // candidates taken from each list
  rrfK: 60,
  weights: { lexical: 1, vector: 1 },
  // Provisional "no answer" gate on the top hit's cosine, picked from the eval set (eval/results-m2.md).
  // 0.41 = just under the lowest top-hit cosine of any answerable question (0.426); flags, never hides, results.
  minCosine: 0.41,
  // Inferred-layer retrieval signals (M4, plan items 35-36). Which are on by default is decided by eval/results-m4.md.
  signals: { similar: false, entity: false, community: false },
};

export { luceneQuery };

const idCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reciprocal rank fusion. lists: { name: [{ id }] } in rank order (best first).
 * fused(id) = sum over lists of weight / (k + rank), rank starting at 1.
 * Returns [{ id, fused, ranks: { name: rank|null } }] sorted by fused desc, then id asc.
 */
export function fuse(lists, { weights = DEFAULTS.weights, k = DEFAULTS.rrfK } = {}) {
  const names = Object.keys(lists).sort();
  const acc = new Map();
  for (const name of names) {
    lists[name].forEach((item, i) => {
      if (!acc.has(item.id)) acc.set(item.id, { id: item.id, fused: 0, ranks: Object.fromEntries(names.map((n) => [n, null])) });
      const e = acc.get(item.id);
      e.ranks[name] = i + 1;
      e.fused += (weights[name] ?? 1) / (k + i + 1);
    });
  }
  return [...acc.values()].sort((a, b) => b.fused - a.fused || idCmp(a.id, b.id));
}

async function run(driver, query, params) {
  const s = driver.session();
  try {
    return (await s.run(query, params)).records;
  } finally {
    await s.close();
  }
}

/**
 * Fetch both candidate lists plus the chunk metadata and exact cosine for every candidate.
 * vectors: false (a vectors-off corpus, plan item 57) skips the vector side entirely: the query is not embedded, the
 * model is not loaded, the vector list is empty and every cosine is null. Only lexical ranking is possible then.
 */
export async function candidates(driver, embedder, corpus, query, depth = DEFAULTS.depth, { vectors = true } = {}) {
  const nCorpora = (await run(driver, 'MATCH (c:Corpus) RETURN count(c) AS n', {}))[0].get('n');
  const pool = depth * Math.max(1, nCorpora) * 2; // indexes are shared by all corpora, filter after
  const qv = vectors ? (await embedder.embed([query]))[0] : null;

  const lq = luceneQuery(query);
  const lex = lq
    ? await run(
        driver,
        `CALL db.index.fulltext.queryNodes('chunk_text', $q, {limit: $pool}) YIELD node, score
         WHERE node.corpus = $c RETURN node.id AS id, score ORDER BY score DESC, id ASC LIMIT $depth`,
        { q: lq, pool: neo4j.int(pool), depth: neo4j.int(depth), c: corpus },
      )
    : [];
  const vec = !vectors ? [] : await run(
    driver,
    `CALL db.index.vector.queryNodes('chunk_embedding', $pool, $qv) YIELD node, score
     WHERE node.corpus = $c RETURN node.id AS id, score`,
    { qv, pool: neo4j.int(pool), c: corpus },
  );
  const lexical = lex.map((r) => ({ id: r.get('id'), score: r.get('score') }));
  // The index only proposes candidates (approximate search); order is decided by exact cosine below,
  // so the same stored vectors always give the same ranking.
  const proposed = vec.map((r) => r.get('id'));

  const ids = [...new Set([...lexical.map((x) => x.id), ...proposed])];
  const meta = new Map();
  if (ids.length) {
    const rows = await run(
      driver,
      `MATCH (k:Chunk) WHERE k.id IN $ids
       RETURN k.id AS id, k.sectionId AS sectionId, k.path AS path, k.headingPath AS headingPath, k.startLine AS startLine,
              k.endLine AS endLine, k.text AS text, k.hash AS hash, k.commit AS commit, k.embedding AS embedding`,
      { ids },
    );
    for (const r of rows) {
      const m = Object.fromEntries(r.keys.map((key) => [key, r.get(key)]));
      m.cosine = qv && m.embedding ? cosine(qv, m.embedding) : null;
      delete m.embedding;
      meta.set(m.id, m);
    }
  }
  const vector = proposed
    .map((id) => ({ id, score: meta.get(id).cosine }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, depth);
  return { query, lexical, vector, meta };
}

/**
 * Turn candidate lists into a ranked list of sections (best chunk per section).
 * mode: 'lexical' | 'vector' | 'hybrid'.
 */
export function rank(cand, { mode = 'hybrid', weights = DEFAULTS.weights, rrfK = DEFAULTS.rrfK, limit = 10 } = {}) {
  const lexRank = new Map(cand.lexical.map((x, i) => [x.id, i + 1]));
  const vecRank = new Map(cand.vector.map((x, i) => [x.id, i + 1]));
  const lexScore = new Map(cand.lexical.map((x) => [x.id, x.score]));
  let ordered;
  if (mode === 'lexical') ordered = cand.lexical.map((x) => ({ id: x.id, fused: null }));
  else if (mode === 'vector') ordered = cand.vector.map((x) => ({ id: x.id, fused: null }));
  else ordered = fuse({ lexical: cand.lexical, vector: cand.vector }, { weights, k: rrfK });

  const seen = new Set();
  const out = [];
  for (const o of ordered) {
    const m = cand.meta.get(o.id);
    if (seen.has(m.sectionId)) continue;
    seen.add(m.sectionId);
    const text = m.text;
    const body = text.replace(/^#{1,6}\s.*\n?/, '').trim() || text;
    out.push({
      sectionId: m.sectionId,
      chunkId: m.id,
      path: m.path,
      headingPath: m.headingPath,
      startLine: m.startLine,
      endLine: m.endLine,
      commit: m.commit,
      hash: m.hash,
      snippet: body.length > 300 ? body.slice(0, 300).trimEnd() + ' ...' : body,
      text,
      scores: {
        lexicalRank: lexRank.get(o.id) ?? null,
        lexicalScore: lexScore.get(o.id) ?? null,
        vectorRank: vecRank.get(o.id) ?? null,
        cosine: m.cosine,
        fused: o.fused,
      },
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Score used to decide "no answer": cosine of the top hit (vector, hybrid) or its BM25 (lexical). */
export const gateScore = (results, mode) => (results.length ? (mode === 'lexical' ? results[0].scores.lexicalScore ?? 0 : results[0].scores.cosine) : -1);

/**
 * Attach document-level lifecycle to results: declared status, supersession both ways, work item and phase.
 * Surfaced next to the hit, never used to re-rank it (plan section 7: staleness without decay).
 */
export async function annotate(driver, corpus, results) {
  const paths = [...new Set(results.map((r) => r.path))];
  if (!paths.length) return results;
  const rows = await run(
    driver,
    `MATCH (d:Document {corpus: $c}) WHERE d.path IN $paths
     OPTIONAL MATCH (n:Document)-[:SUPERSEDES]->(d)
     WITH d, collect(DISTINCT n.path) AS newer
     OPTIONAL MATCH (d)-[:SUPERSEDES]->(o:Document)
     RETURN d.path AS path, d.uid AS uid, d.status AS status, d.workItem AS workItem, d.phase AS phase, newer, collect(DISTINCT o.path) AS sup`,
    { c: corpus, paths },
  );
  const byPath = new Map(rows.map((r) => [r.get('path'), { uid: r.get('uid'), status: r.get('status'), workItem: r.get('workItem'), phase: r.get('phase'), supersededBy: r.get("newer").sort(), supersedes: r.get('sup').sort() }]));
  for (const r of results) r.doc = byPath.get(r.path) || null;
  return results;
}

/**
 * mode is the mode to run; callers that want the configured default resolve it first (switches.js, plan item 57).
 * vectors: false is for a vectors-off corpus and allows lexical mode only.
 */
export async function search(driver, corpus, query, { mode = 'hybrid', limit = 5, embedder = localEmbedder(), weights, rrfK, minCosine = DEFAULTS.minCosine, signals = DEFAULTS.signals, vectors = true } = {}) {
  if (!vectors && mode !== 'lexical') throw new Error(`mode ${mode} needs vectors, which are off for corpus ${corpus}`);
  const cand = await candidates(driver, embedder, corpus, query, DEFAULTS.depth, { vectors });
  const want = { similar: !!signals.similar, entity: !!signals.entity, community: !!signals.community };
  const anySignal = want.similar || want.entity || want.community;
  let ranked = rank(cand, { mode, limit: anySignal ? SIGNAL_PARAMS.depth : limit, weights, rrfK });
  const g = gateScore(ranked, mode); // the no-answer gate looks at the base ranking, before any inferred signal
  let signalInfo = { requested: Object.keys(want).filter((k) => want[k]), applied: [], note: null };
  if (anySignal) {
    const idx = await loadInferredIndex(driver, corpus);
    if (!idx.present) {
      signalInfo.note = 'inferred layer not built for this corpus (run `breakwall infer`); signals skipped, base ranking returned';
    } else {
      const res = await applySignals(driver, corpus, ranked, idx, query, { ...want, params: SIGNAL_PARAMS });
      ranked = res.results;
      signalInfo.applied = res.applied;
      signalInfo.inferredRun = idx.run;
    }
  }
  const results = await annotate(driver, corpus, ranked.slice(0, limit));
  const answered = mode === 'lexical' || minCosine === null ? null : g >= minCosine;
  return { query, mode, corpus, answered, gate: g, signals: signalInfo, results };
}

export function formatResults(res) {
  const lines = [];
  if (res.answered === false) lines.push(`(low confidence: top cosine ${res.gate.toFixed(3)} is below the no-answer threshold; hits below are probably not an answer)`);
  if (!res.results.length) lines.push('no results');
  const f = (x, d = 3) => (x === null || x === undefined ? '-' : x.toFixed(d));
  res.results.forEach((r, i) => {
    const s = r.scores;
    lines.push(`${i + 1}. ${r.path}  [${r.startLine}-${r.endLine}]  ${r.headingPath || '(preamble)'}`);
    lines.push(`   lexical rank ${s.lexicalRank ?? '-'} (bm25 ${f(s.lexicalScore, 2)})  vector rank ${s.vectorRank ?? '-'} (cos ${f(s.cosine)})  fused ${f(s.fused, 5)}  commit ${(r.commit || 'none').slice(0, 8)}`);
    if (r.inferred && r.inferred.via.length) lines.push(`   [inferred] ${r.inferred.via.slice(0, 3).join('; ')}`);
    lines.push(`   ${r.snippet.replace(/\n/g, ' ')}`);
  });
  if (res.signals && res.signals.note) lines.push(`(${res.signals.note})`);
  return lines.join('\n');
}

/** Exact section by id, or by path + heading (full heading path, or a case-insensitive suffix). */
export async function getSection(driver, corpus, path, heading, { includeDeleted = false } = {}) {
  const rows = await run(
    driver,
    `MATCH (s:Section {corpus: $c}) WHERE (s.id = $path OR s.path = $path) AND ($del OR s.deleted IS NULL)
     RETURN s.id AS id, s.path AS path, s.headingPath AS headingPath, s.startLine AS startLine, s.endLine AS endLine,
            s.text AS text, s.hash AS hash, s.commit AS commit, s.ordinal AS ordinal, s.deleted AS deleted ORDER BY s.path, s.ordinal`,
    { c: corpus, path, del: includeDeleted },
  );
  let hits = rows.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])));
  if (heading) {
    const h = heading.toLowerCase();
    const exact = hits.filter((x) => x.headingPath.toLowerCase() === h);
    hits = exact.length ? exact : hits.filter((x) => x.headingPath.toLowerCase().endsWith(h));
  }
  return hits;
}

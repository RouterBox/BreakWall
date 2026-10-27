// Retrieval signals built on the inferred layer (plan item 35). Each one is optional and off unless asked for:
//   similar   - graph-neighbour expansion: sections SIMILAR_TO the top base hits are added as a ranked list
//   entity    - entity-match boost: sections that mention entities named in the query, ranked by summed idf score
//   community - diversification: at most `cap` results per community in the top `topN`
// similar and entity are fused with the base (hybrid) section ranking by weighted reciprocal rank fusion.
// Everything here is deterministic: ties break on section id.
import { fuse } from '../search.js';
import { matchQuery } from './entities.js';

export const SIGNALS = ['similar', 'entity', 'community'];
export const SIGNAL_PARAMS = { weights: { similar: 0.5, entity: 0.5 }, rrfK: 60, seeds: 3, cap: 2, topN: 10, depth: 50 };

async function rows(driver, query, params = {}) {
  const s = driver.session();
  try {
    return (await s.run(query, params)).records.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])));
  } finally {
    await s.close();
  }
}

/** The inferred layer of one corpus as lookup tables (no section text). present=false when infer has not run. */
export async function loadInferredIndex(driver, corpus) {
  const run = (await rows(driver, 'MATCH (r:InferredRun {id: $id}) RETURN r.run AS run, r.passes AS passes', { id: `${corpus}:inferred-run` }))[0];
  if (!run) return { present: false };
  const idx = { present: true, run: run.run, passes: JSON.parse(run.passes), similar: new Map(), entityByKey: new Map(), entitySections: new Map(), mentions: new Map(), community: new Map(), communities: new Map() };
  for (const e of await rows(driver, 'MATCH (e:Entity {corpus: $c}) RETURN e.key AS key, e.name AS name, e.type AS type, e.idf AS idf, e.sectionDf AS df ORDER BY key', { c: corpus })) {
    idx.entityByKey.set(e.key, e);
  }
  for (const r of await rows(driver, 'MATCH (a:Section {corpus: $c})-[x:SIMILAR_TO]->(b:Section) RETURN a.id AS a, b.id AS b, x.score AS score ORDER BY a, b', { c: corpus })) {
    for (const [from, to] of [[r.a, r.b], [r.b, r.a]]) {
      if (!idx.similar.has(from)) idx.similar.set(from, []);
      idx.similar.get(from).push({ id: to, score: r.score });
    }
  }
  for (const r of await rows(driver, 'MATCH (s:Section {corpus: $c})-[x:MENTIONS_ENTITY]->(e:Entity) RETURN s.id AS sid, e.key AS key, x.score AS score, x.method AS method ORDER BY sid, key', { c: corpus })) {
    if (!idx.entitySections.has(r.key)) idx.entitySections.set(r.key, []);
    idx.entitySections.get(r.key).push({ sectionId: r.sid, score: r.score, method: r.method });
    if (!idx.mentions.has(r.sid)) idx.mentions.set(r.sid, []);
    idx.mentions.get(r.sid).push({ key: r.key, score: r.score });
  }
  for (const r of await rows(driver, 'MATCH (s:Section {corpus: $c})-[:IN_COMMUNITY]->(m:Community) RETURN s.id AS sid, m.n AS n, m.label AS label, m.size AS size', { c: corpus })) {
    idx.community.set(r.sid, r.n);
    idx.communities.set(r.n, { n: r.n, label: r.label, size: r.size });
  }
  return idx;
}

const byScoreThenId = (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Pure. base: ranked section results (best first, each with sectionId). Returns the new order and why each section moved.
 * [{ sectionId, score, via: [...], signals: { base, entity, similar, community } }]
 */
export function planSignals(base, idx, query, { similar = false, entity = false, community = false, params = SIGNAL_PARAMS } = {}) {
  const { rrfK: k, seeds, cap, topN, depth } = params;
  const lists = { base: base.map((r) => ({ id: r.sectionId })) };
  const via = new Map();
  const note = (id, text) => via.set(id, [...(via.get(id) || []), text]);
  const detail = { entityMatched: [], seedSections: [] };

  if (similar && idx.present) {
    const acc = new Map();
    base.slice(0, seeds).forEach((seed, i) => {
      detail.seedSections.push(seed.sectionId);
      for (const n of idx.similar.get(seed.sectionId) || []) {
        acc.set(n.id, (acc.get(n.id) || 0) + n.score / (k + i + 1));
        note(n.id, `similar-to (inferred, cosine ${n.score.toFixed(3)}) the #${i + 1} hit`);
      }
    });
    lists.similar = [...acc.entries()].map(([id, score]) => ({ id, score })).sort(byScoreThenId).slice(0, depth);
  }
  if (entity && idx.present) {
    const matched = matchQuery(query, idx.entityByKey);
    detail.entityMatched = matched.map((e) => e.key);
    const acc = new Map();
    for (const e of matched) {
      for (const m of idx.entitySections.get(e.key) || []) {
        acc.set(m.sectionId, (acc.get(m.sectionId) || 0) + m.score);
        note(m.sectionId, `mentions entity "${e.name}" (inferred, ${m.method}, score ${m.score.toFixed(2)})`);
      }
    }
    lists.entity = [...acc.entries()].map(([id, score]) => ({ id, score })).sort(byScoreThenId).slice(0, depth);
  }

  const weights = { base: 1, ...params.weights };
  const fused = fuse(lists, { weights, k });
  let order = fused.map((f) => ({ sectionId: f.id, score: f.fused, signals: { base: f.ranks.base, entity: f.ranks.entity ?? null, similar: f.ranks.similar ?? null }, via: via.get(f.id) || [] }));

  if (community && idx.present && idx.community.size) {
    const taken = [];
    const used = new Map();
    for (const o of order) {
      if (taken.length >= topN) break;
      const c = idx.community.get(o.sectionId);
      if (c !== undefined && (used.get(c) || 0) >= cap) continue;
      if (c !== undefined) used.set(c, (used.get(c) || 0) + 1);
      taken.push(o);
    }
    const inTop = new Set(taken.map((o) => o.sectionId));
    for (const o of order) if (!inTop.has(o.sectionId)) o.demoted = idx.community.get(o.sectionId) !== undefined;
    order = [...taken, ...order.filter((o) => !inTop.has(o.sectionId))];
  }
  for (const o of order) {
    const c = idx.present ? idx.community.get(o.sectionId) : undefined;
    o.signals.community = c ?? null;
  }
  return { order, detail };
}

/** Section rows for sections that the signals introduced (they were not in the base candidate lists). */
export async function hydrateSections(driver, corpus, ids) {
  if (!ids.length) return new Map();
  const found = await rows(
    driver,
    `MATCH (s:Section {corpus: $c}) WHERE s.id IN $ids AND s.deleted IS NULL
     RETURN s.id AS id, s.path AS path, s.headingPath AS headingPath, s.startLine AS startLine, s.endLine AS endLine, s.text AS text, s.hash AS hash, s.commit AS commit`,
    { c: corpus, ids },
  );
  return new Map(found.map((r) => [r.id, r]));
}

/** base results -> results re-ordered by the requested signals, with the inferred reasons attached. */
export async function applySignals(driver, corpus, base, idx, query, opts) {
  const want = ['similar', 'entity', 'community'].some((s) => opts[s]);
  if (!want || !idx.present) return { results: base, applied: [], detail: null };
  const { order, detail } = planSignals(base, idx, query, opts);
  const baseById = new Map(base.map((r) => [r.sectionId, r]));
  const hydrated = await hydrateSections(driver, corpus, order.map((o) => o.sectionId).filter((id) => !baseById.has(id)));
  const results = [];
  for (const o of order) {
    let r = baseById.get(o.sectionId);
    if (r) r = { ...r, scores: { ...r.scores } };
    else {
      const h = hydrated.get(o.sectionId);
      if (!h) continue;
      const body = h.text.replace(/^#{1,6}\s.*\n?/, '').trim() || h.text;
      r = {
        sectionId: h.id, chunkId: null, path: h.path, headingPath: h.headingPath, startLine: h.startLine, endLine: h.endLine, commit: h.commit, hash: h.hash,
        snippet: body.length > 300 ? body.slice(0, 300).trimEnd() + ' ...' : body, text: h.text,
        scores: { lexicalRank: null, lexicalScore: null, vectorRank: null, cosine: null, fused: null },
      };
    }
    r.scores.signalFused = o.score;
    r.inferred = { layer: 'inferred', signals: o.signals, via: o.via, demotedByCommunityCap: o.demoted === true ? true : undefined };
    results.push(r);
  }
  return { results, applied: ['similar', 'entity', 'community'].filter((s) => opts[s]), detail };
}

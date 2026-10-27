// trace(from, to): the cheapest explanation path between two sections / entities (plan item 37).
// The corpus graph is read into memory (fine at this size) and searched with Dijkstra; ties break on node id so the
// same graph always yields the same path. Every edge keeps its layer, method, score and provenance.
import { canonKey } from './entities.js';

/** Edge costs: parsed edges are cheap, inferred ones dearer; a stronger SIMILAR_TO is cheaper. */
export const COST = { CONTAINS: 1, LINKS_TO: 1, NEXT: 1.5, MENTIONS_ENTITY: 2, SIMILAR_TO: (score) => 3 - score };

async function rows(driver, query, params = {}) {
  const s = driver.session();
  try {
    return (await s.run(query, params)).records.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])));
  } finally {
    await s.close();
  }
}

const j = (x) => {
  try {
    return JSON.parse(x);
  } catch {
    return null;
  }
};

export async function loadTraceGraph(driver, corpus) {
  const g = { sections: new Map(), entities: new Map(), entityByKey: new Map(), docFirst: new Map(), edges: [], adj: new Map() };
  for (const s of await rows(
    driver,
    `MATCH (s:Section {corpus: $c}) WHERE s.deleted IS NULL
     RETURN s.id AS id, s.docId AS docId, s.path AS path, s.headingPath AS headingPath, s.ordinal AS ordinal, s.startLine AS startLine, s.endLine AS endLine, s.hash AS hash, s.commit AS commit ORDER BY s.id`,
    { c: corpus },
  )) {
    g.sections.set(s.id, { kind: 'section', ...s });
    const f = g.docFirst.get(s.path);
    if (!f || s.ordinal < f.ordinal) g.docFirst.set(s.path, s);
  }
  for (const e of await rows(driver, 'MATCH (e:Entity {corpus: $c}) RETURN e.id AS id, e.key AS key, e.name AS name, e.type AS type, e.aliases AS aliases, e.sectionDf AS df ORDER BY id', { c: corpus })) {
    const node = { kind: 'entity', ...e, aliases: j(e.aliases) || [] };
    g.entities.set(e.id, node);
    g.entityByKey.set(e.key, node);
  }
  const add = (a, b, type, layer, props, cost) => {
    if (!g.sections.has(a) && !g.entities.has(a)) return;
    if (!g.sections.has(b) && !g.entities.has(b)) return;
    const edge = { a, b, type, layer, props, cost };
    g.edges.push(edge);
    for (const [x, y, dir] of [[a, b, 'forward'], [b, a, 'reverse']]) {
      if (!g.adj.has(x)) g.adj.set(x, []);
      g.adj.get(x).push({ to: y, edge, direction: dir });
    }
  };
  for (const r of await rows(driver, 'MATCH (a:Section {corpus: $c})-[x:CONTAINS]->(b:Section) WHERE a.deleted IS NULL AND b.deleted IS NULL RETURN a.id AS a, b.id AS b, properties(x) AS p ORDER BY a, b', { c: corpus })) add(r.a, r.b, 'CONTAINS', 'deterministic', r.p, COST.CONTAINS);
  for (const r of await rows(driver, 'MATCH (a:Section {corpus: $c})-[x:NEXT]->(b:Section) WHERE a.deleted IS NULL AND b.deleted IS NULL RETURN a.id AS a, b.id AS b, properties(x) AS p ORDER BY a, b', { c: corpus })) add(r.a, r.b, 'NEXT', 'deterministic', r.p, COST.NEXT);
  const docTitle = new Map([...g.docFirst.values()].map((s) => [s.docId, s.id]));
  for (const r of await rows(
    driver,
    `MATCH (a:Section {corpus: $c})-[x:LINKS_TO]->(t) WHERE a.deleted IS NULL AND (t:Section OR t:Document) AND t.deleted IS NULL
     RETURN a.id AS a, t.id AS t, (t:Section) AS isSection, properties(x) AS p ORDER BY a, t`,
    { c: corpus },
  )) {
    const b = r.isSection ? r.t : docTitle.get(r.t);
    if (b) add(r.a, b, 'LINKS_TO', 'deterministic', { ...r.p, resolvedTo: r.isSection ? 'section' : 'document title section' }, COST.LINKS_TO);
  }
  for (const r of await rows(driver, 'MATCH (a:Section {corpus: $c})-[x:SIMILAR_TO]->(b:Section) RETURN a.id AS a, b.id AS b, properties(x) AS p ORDER BY a, b', { c: corpus })) add(r.a, r.b, 'SIMILAR_TO', 'inferred', r.p, COST.SIMILAR_TO(r.p.score));
  for (const r of await rows(driver, 'MATCH (a:Section {corpus: $c})-[x:MENTIONS_ENTITY]->(e:Entity) RETURN a.id AS a, e.id AS b, properties(x) AS p ORDER BY a, b', { c: corpus })) add(r.a, r.b, 'MENTIONS_ENTITY', 'inferred', { ...r.p, spans: j(r.p.spans) }, COST.MENTIONS_ENTITY);
  return g;
}

export class TraceInputError extends Error {}

/** A section id, "path#heading", a document path, "entity:name", an entity name or alias, or a unique heading suffix. */
export function resolveRef(g, ref) {
  const q = String(ref).trim();
  if (!q) throw new TraceInputError('empty reference');
  const entityOf = (name) => {
    const tries = [canonKey(name, 'term'), canonKey(name, 'file'), canonKey(name, 'endpoint'), /^\d{2,5}$/.test(name) ? canonKey(name, 'port') : null].filter(Boolean);
    for (const k of tries) if (g.entityByKey.has(k)) return g.entityByKey.get(k);
    return null;
  };
  if (/^entity:/i.test(q)) {
    const e = entityOf(q.replace(/^entity:/i, '').trim());
    if (!e) throw new TraceInputError(`no entity "${q.replace(/^entity:/i, '')}" (entities exist only after \`breakwall infer\`; list them with \`breakwall entities\`)`);
    return e;
  }
  if (g.sections.has(q)) return g.sections.get(q);
  if (g.entities.has(q)) return g.entities.get(q);
  const secs = [...g.sections.values()];
  const pick = (list, what) => {
    if (list.length === 1) return list[0];
    if (list.length === 0) return null;
    throw new TraceInputError(`${list.length} sections match ${what}; be more specific. Candidates: ${list.slice(0, 8).map((s) => `${s.path}#${s.headingPath}`).join(' | ')}`);
  };
  if (q.includes('#')) {
    const [p, ...h] = q.split('#');
    const heading = h.join('#').toLowerCase();
    const inDoc = secs.filter((s) => s.path === p);
    if (!inDoc.length) throw new TraceInputError(`no document "${p}"`);
    const exact = inDoc.filter((s) => s.headingPath.toLowerCase() === heading);
    const hit = pick(exact.length ? exact : inDoc.filter((s) => s.headingPath.toLowerCase().endsWith(heading)), `"${q}"`);
    if (!hit) throw new TraceInputError(`no section "${h.join('#')}" in ${p}`);
    return hit;
  }
  if (g.docFirst.has(q)) return g.sections.get(g.docFirst.get(q).id);
  const e = entityOf(q);
  if (e) return e;
  const lower = q.toLowerCase();
  const byHeading = pick(secs.filter((s) => s.headingPath.toLowerCase().endsWith(lower)), `heading "${q}"`);
  if (byHeading) return byHeading;
  throw new TraceInputError(`cannot resolve "${q}" to a section, document, or entity. Use a section id, "path#heading", a document path, or an entity name.`);
}

class Heap {
  constructor() { this.a = []; }
  less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(item) {
    const a = this.a;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        let m = i;
        for (const c of [2 * i + 1, 2 * i + 2]) if (c < a.length && this.less(a[c], a[m])) m = c;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

/** Cheapest path from -> to using only edges whose layer is allowed. Returns { hops: [{from,to,edge,direction}], cost } or null. */
export function shortestPath(g, fromId, toId, { layers = 'both', maxHops = 6 } = {}) {
  const ok = (e) => layers === 'both' || e.layer === layers;
  const dist = new Map([[fromId, 0]]);
  const hopsTo = new Map([[fromId, 0]]);
  const prev = new Map();
  const done = new Set();
  const heap = new Heap();
  heap.push([0, fromId]);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === toId) break;
    if (hopsTo.get(u) >= maxHops) continue;
    for (const { to, edge, direction } of g.adj.get(u) || []) {
      if (!ok(edge) || done.has(to)) continue;
      const nd = d + edge.cost;
      const cur = dist.get(to);
      if (cur === undefined || nd < cur - 1e-9 || (Math.abs(nd - cur) <= 1e-9 && u < prev.get(to).u)) {
        dist.set(to, nd);
        hopsTo.set(to, hopsTo.get(u) + 1);
        prev.set(to, { u, edge, direction });
        heap.push([nd, to]);
      }
    }
  }
  if (!dist.has(toId) || (fromId !== toId && !prev.has(toId))) return null;
  const hops = [];
  for (let n = toId; n !== fromId; ) {
    const p = prev.get(n);
    hops.unshift({ from: p.u, to: n, edge: p.edge, direction: p.direction });
    n = p.u;
  }
  return { hops, cost: Math.round(dist.get(toId) * 1e6) / 1e6 };
}

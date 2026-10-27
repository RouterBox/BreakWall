// Tool core for the inferred layer (M4): trace, entities, communities. Read-only, like the rest of src/tools.js.
// The CLI and the MCP server both call these. Everything returned from here is labelled with its layer.
import neo4j from 'neo4j-driver';
import { cite, ToolError } from '../tools.js';
import { loadTraceGraph, resolveRef, shortestPath, TraceInputError } from './trace.js';

async function rows(driver, query, params = {}) {
  const s = driver.session();
  try {
    return (await s.run(query, params)).records.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])));
  } finally {
    await s.close();
  }
}

const secLabel = (s) => `${s.path}${s.headingPath ? ' > ' + s.headingPath.split(' > ').slice(-1)[0] : ''}`;

function describeNode(n, corpus, light = false) {
  if (n.kind === 'entity' && light) return { type: 'entity', id: n.id, name: n.name, layer: 'inferred' };
  if (n.kind === 'section' && light) return { type: 'section', id: n.id, label: secLabel(n), ref: `${n.path}:${n.startLine}-${n.endLine}` };
  if (n.kind === 'entity') return { type: 'entity', id: n.id, name: n.name, key: n.key, entityType: n.type, aliases: n.aliases.map((a) => a.surface), layer: 'inferred' };
  return { type: 'section', id: n.id, label: secLabel(n), citation: cite(n, corpus) };
}

function describeHop(g, hop, corpus, i) {
  const e = hop.edge;
  const p = e.props || {};
  const node = (id) => g.sections.get(id) || g.entities.get(id);
  const A = node(hop.from);
  const B = node(hop.to);
  const name = (n) => (n.kind === 'entity' ? `entity "${n.name}"` : `"${secLabel(n)}"`);
  const [src, dst] = hop.direction === 'forward' ? [A, B] : [B, A]; // as stored
  let explanation;
  let provenance;
  if (e.type === 'LINKS_TO') {
    explanation = `${name(src)} links to ${name(dst)} (${p.kind === 'wikilink' ? 'wikilink' : 'markdown link'} at line ${p.line}${p.resolvedTo === 'document title section' ? '; the link targets the document, shown as its title section' : ''})`;
    provenance = { line: p.line, link: p.url, kind: p.kind, method: p.method };
  } else if (e.type === 'CONTAINS') {
    explanation = `${name(src)} contains the subsection ${name(dst)}`;
    provenance = { method: p.method };
  } else if (e.type === 'NEXT') {
    explanation = `${name(dst)} follows ${name(src)} in reading order`;
    provenance = { method: p.method };
  } else if (e.type === 'MENTIONS_ENTITY') {
    const sp = (p.spans || []).slice(0, 3).map((s) => `line ${s.line}`).join(', ');
    explanation = `${name(src)} mentions ${name(dst)} (found by ${p.methods || p.method} at ${sp}; inferred by local entity extraction, idf-weighted score ${p.score})`;
    provenance = { run: p.run, methods: p.methods, spans: p.spans, tf: p.tf, idf: p.idf };
  } else {
    explanation = `${name(src)} is similar to ${name(dst)} (embedding cosine ${p.score}, top-${p.k} neighbour above threshold ${p.threshold}; inferred)`;
    provenance = { run: p.run, k: p.k, threshold: p.threshold };
  }
  return {
    hop: i + 1,
    from: describeNode(A, corpus, true),
    to: describeNode(B, corpus, true),
    edge: { type: e.type, layer: e.layer, method: p.method, storedDirection: hop.direction === 'forward' ? 'from->to' : 'to->from', score: p.score ?? undefined, cost: e.cost, provenance },
    explanation,
  };
}

export async function toolTrace(driver, corpus, { from, to, layers = 'both', maxHops = 6 }) {
  if (!['both', 'deterministic', 'inferred'].includes(layers)) throw new ToolError(`layers must be both, deterministic or inferred (got "${layers}")`);
  const g = await loadTraceGraph(driver, corpus);
  let a;
  let b;
  try {
    a = resolveRef(g, from);
    b = resolveRef(g, to);
  } catch (e) {
    if (e instanceof TraceInputError) throw new ToolError(e.message);
    throw e;
  }
  const hasInferred = g.entities.size > 0 || g.edges.some((e) => e.layer === 'inferred');
  const render = (res) =>
    res
      ? { found: true, hops: res.hops.map((h, i) => describeHop(g, h, corpus, i)), totalCost: res.cost, usesInferred: res.hops.some((h) => h.edge.layer === 'inferred') }
      : { found: false };
  const main = shortestPath(g, a.id, b.id, { layers, maxHops });
  const out = {
    corpus,
    from: describeNode(a, corpus),
    to: describeNode(b, corpus),
    layers,
    maxHops,
    note: 'Deterministic edges are parsed from the files; inferred edges (entity mentions, similar-to) are computed locally and carry method and score. Edge cost: CONTAINS 1, LINKS_TO 1, NEXT 1.5, MENTIONS_ENTITY 2, SIMILAR_TO 3 minus score.',
    path: render(main),
  };
  if (layers === 'both') {
    out.deterministicOnly = render(shortestPath(g, a.id, b.id, { layers: 'deterministic', maxHops }));
    if (!hasInferred) out.warning = 'no inferred layer for this corpus (run `breakwall infer`); only deterministic edges were available';
  }
  if (!out.path.found) out.path.message = `no path of at most ${maxHops} hops over ${layers === 'both' ? 'any' : layers} edges`;
  const label = (n) => (n.type === 'entity' ? `[entity ${n.name}]` : n.label);
  out.summary = out.path.found
    ? `${out.path.hops.length} hop(s), ${out.path.usesInferred ? 'uses inferred edges' : 'deterministic edges only'}: ${[out.from, ...out.path.hops.map((h) => h.to)].map(label).join('  ->  ')}`
    : out.path.message;
  return out;
}

export async function toolEntities(driver, corpus, { query = null, type = null, limit = 50, aliases = false } = {}) {
  const ents = await rows(
    driver,
    `MATCH (e:Entity {corpus: $c})
     WHERE ($type IS NULL OR e.type = $type) AND ($q IS NULL OR e.key CONTAINS toLower($q) OR toLower(e.name) CONTAINS toLower($q) OR toLower(e.aliases) CONTAINS toLower($q))
     RETURN e.key AS key, e.name AS name, e.type AS type, e.sectionDf AS sectionDf, e.docDf AS docDf, e.idf AS idf, e.mentions AS mentions, e.aliases AS aliases
     ORDER BY e.sectionDf DESC, e.key LIMIT $limit`,
    { c: corpus, type, q: query, limit: neo4j.int(limit) },
  );
  const total = (await rows(driver, 'MATCH (e:Entity {corpus: $c}) RETURN count(e) AS n', { c: corpus }))[0].n;
  return {
    corpus,
    layer: 'inferred',
    method: 'local deterministic extraction (patterns + frequency filter); no model, no network',
    totalEntities: total,
    shown: ents.length,
    entities: ents.map((e) => {
      const al = JSON.parse(e.aliases);
      return { name: e.name, key: e.key, type: e.type, sectionDf: e.sectionDf, docDf: e.docDf, idf: e.idf, mentions: e.mentions, aliases: aliases || al.length > 1 ? al : undefined };
    }),
  };
}

export async function toolCommunities(driver, corpus, { members = false } = {}) {
  const cs = await rows(driver, 'MATCH (m:Community {corpus: $c}) RETURN m.id AS id, m.n AS n, m.label AS label, m.size AS size, m.docs AS docs, m.modularity AS modularity ORDER BY m.n', { c: corpus });
  const out = [];
  for (const c of cs) {
    const item = { n: c.n, label: c.label, sections: c.size, documents: c.docs };
    if (members) item.members = (await rows(driver, 'MATCH (s:Section)-[:IN_COMMUNITY]->(m:Community {id: $id}) RETURN s.path AS path, s.headingPath AS headingPath ORDER BY s.id', { id: c.id })).map((r) => `${r.path} > ${r.headingPath}`);
    out.push(item);
  }
  return { corpus, layer: 'inferred', method: 'louvain (local, deterministic)', modularity: cs[0]?.modularity ?? null, communities: out };
}

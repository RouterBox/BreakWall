// The tool core. The CLI and the MCP server both call these, so they cannot drift (plan section 6).
// Everything here only reads the graph (and, for lint, the files). Every result carries citations:
// { path, headingPath, startLine, endLine, ref, corpus, provenance: { commit, hash, uid } }.
import { existsSync } from 'node:fs';
import { loadCorpus } from './scan.js';
import { lintCorpus } from './lint.js';
import { search as runSearch, getSection, DEFAULTS } from './search.js';
import { localEmbedder } from './embed.js';
import { parseEvents } from './sync.js';
import { phaseOrder } from './lifecycle.js';
import { inferStatus } from './infer/index.js';
import { formatCitation, parseCitation, judgeCitation } from './cite.js';
import { corpusSwitches, SwitchError } from './switches.js';

/** Thrown for caller mistakes (bad input, not found). The MCP layer turns these into isError results. */
export class ToolError extends Error {}

async function rows(driver, query, params = {}) {
  const s = driver.session();
  try {
    return (await s.run(query, params)).records.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])));
  } finally {
    await s.close();
  }
}

export function cite(x, corpus) {
  return {
    path: x.path,
    headingPath: x.headingPath ?? '',
    startLine: x.startLine,
    endLine: x.endLine,
    ref: `${x.path}:${x.startLine}-${x.endLine}`,
    corpus,
    provenance: { commit: x.commit || null, hash: x.hash || null, uid: x.uid || null },
  };
}

const preview = (text, n = 240) => {
  const body = (text || '').replace(/^#{1,6}\s.*\n?/, '').replace(/\s+/g, ' ').trim();
  return body.length > n ? body.slice(0, n).trimEnd() + ' ...' : body;
};

/** --corpus / the configured default / the only corpus in the database. */
export async function resolveCorpus(driver, requested) {
  const ids = (await rows(driver, 'MATCH (c:Corpus) RETURN c.id AS id ORDER BY id')).map((r) => r.id);
  const want = requested || process.env.BREAKWALL_CORPUS;
  if (want) {
    if (!ids.includes(want)) throw new ToolError(`unknown corpus "${want}"; indexed corpora: ${ids.join(', ') || '(none)'}`);
    return want;
  }
  if (ids.length === 1) return ids[0];
  throw new ToolError(ids.length ? `several corpora indexed (${ids.join(', ')}); pass a corpus` : 'nothing indexed yet; run `breakwall sync <dir>` first');
}

// ---------------------------------------------------------------- search / get / outline

/** Switch A and B for one corpus (plan item 57); a bad value or an impossible mode is a caller error. */
export async function resolveSwitches(driver, corpus, explicitMode = null, env = process.env) {
  try {
    return await corpusSwitches(driver, corpus, { explicit: explicitMode, env });
  } catch (e) {
    if (e instanceof SwitchError) throw new ToolError(e.message);
    throw e;
  }
}

/** mode: null (or absent) means the configured default (switch A); an explicit mode wins over every other source. */
export async function toolSearch(driver, corpus, { query, mode = null, limit = 5, maxChars = 6000, embedder = localEmbedder(), signals = DEFAULTS.signals }) {
  const sw = await resolveSwitches(driver, corpus, mode);
  mode = sw.mode.mode;
  const res = await runSearch(driver, corpus, query, { mode, limit, embedder, minCosine: DEFAULTS.minCosine, signals, vectors: sw.vectors.on });
  let budget = maxChars;
  const results = res.results.map((r, i) => {
    const out = {
      rank: i + 1,
      citation: cite({ ...r }, corpus),
      scores: r.scores,
      inferred: r.inferred ? { layer: 'inferred', why: r.inferred.via, signals: r.inferred.signals, demotedByCommunityCap: r.inferred.demotedByCommunityCap } : undefined,
      document: r.doc ? { status: r.doc.status, supersedes: r.doc.supersedes, supersededBy: r.doc.supersededBy, superseded: r.doc.supersededBy.length > 0, workItem: r.doc.workItem, phase: r.doc.phase } : null,
    };
    if (r.doc) out.citation.provenance.uid = r.doc.uid;
    if (budget <= 0) return { ...out, textOmitted: true };
    const text = r.text.length > budget ? r.text.slice(0, budget).trimEnd() : r.text;
    out.text = text;
    if (text.length < r.text.length) out.truncated = true;
    budget -= text.length;
    return out;
  });
  return {
    query,
    mode,
    modeSource: sw.mode.source,
    corpus,
    signals: res.signals,
    lowConfidence: res.answered === false,
    note: res.answered === false ? `top-hit cosine ${res.gate.toFixed(3)} is below ${DEFAULTS.minCosine}; these hits are probably not an answer` : undefined,
    results,
  };
}

export async function toolGet(driver, corpus, { ref, heading = null, includeDeleted = false, maxChars = 12000 }) {
  const hits = await getSection(driver, corpus, ref, heading, { includeDeleted });
  if (!hits.length) throw new ToolError(`no section found for "${ref}"${heading ? ` / "${heading}"` : ''}${includeDeleted ? '' : ' (tombstoned documents are hidden; pass include_deleted to see them)'}`);
  if (hits.length > 1) {
    return { ambiguous: true, message: `${hits.length} sections match; pass a full heading path or a section id`, candidates: hits.slice(0, 30).map((h) => ({ id: h.id, citation: cite(h, corpus) })) };
  }
  const h = hits[0];
  const doc = (await rows(driver, 'MATCH (d:Document {id: $id}) RETURN d.uid AS uid, d.status AS status, d.deleted AS deleted', { id: `${corpus}:${h.path}` }))[0] || {};
  const text = h.text.length > maxChars ? h.text.slice(0, maxChars).trimEnd() : h.text;
  return {
    id: h.id,
    citation: cite({ ...h, uid: doc.uid }, corpus),
    deleted: h.deleted === true,
    status: doc.status ?? null,
    text,
    truncated: text.length < h.text.length ? true : undefined,
  };
}

export async function toolOutline(driver, corpus, { path, includeDeleted = false }) {
  const d = (await rows(driver, 'MATCH (d:Document {corpus: $c, path: $p}) RETURN d', { c: corpus, p: path }))[0];
  if (!d) throw new ToolError(`no document "${path}" in corpus ${corpus}`);
  const doc = d.d.properties;
  if (doc.deleted === true && !includeDeleted) throw new ToolError(`"${path}" was deleted (tombstoned ${doc.deletedAt}); pass include_deleted to see its outline`);
  const secs = await rows(
    driver,
    'MATCH (s:Section {docId: $id}) RETURN s.id AS id, s.level AS level, s.heading AS heading, s.headingPath AS headingPath, s.startLine AS startLine, s.endLine AS endLine, s.hash AS hash, s.commit AS commit ORDER BY s.ordinal',
    { id: doc.id },
  );
  return {
    path,
    title: doc.title,
    status: doc.status ?? null,
    deleted: doc.deleted === true,
    lineCount: doc.lineCount,
    uid: doc.uid,
    sections: secs.map((s) => ({ id: s.id, level: s.level, heading: s.heading || '(preamble)', citation: cite({ ...s, path, uid: doc.uid }, corpus) })),
  };
}

// ---------------------------------------------------------------- neighbors

export async function toolNeighbors(driver, corpus, { ref, heading = null, includeDeleted = false }) {
  const hits = await getSection(driver, corpus, ref, heading, { includeDeleted });
  if (!hits.length) throw new ToolError(`no section found for "${ref}"${heading ? ` / "${heading}"` : ''}`);
  if (hits.length > 1) return { ambiguous: true, message: `${hits.length} sections match; pass a section id (from search/outline) or a full heading path`, candidates: hits.slice(0, 30).map((h) => ({ id: h.id, citation: cite(h, corpus) })) };
  const me = hits[0];
  const live = includeDeleted ? '' : ' AND t.deleted IS NULL';
  const sec = (r) => ({ id: r.id, citation: cite(r, corpus), snippet: preview(r.text), deleted: r.deleted === true ? true : undefined });
  const secCols = 't.id AS id, t.path AS path, t.headingPath AS headingPath, t.startLine AS startLine, t.endLine AS endLine, t.hash AS hash, t.commit AS commit, t.text AS text, t.deleted AS deleted';
  const one = async (q) => (await rows(driver, q, { id: me.id }))[0];

  const parent = await one(`MATCH (t:Section)-[:CONTAINS]->(s:Section {id: $id}) WHERE true${live} RETURN ${secCols}`);
  const children = await rows(driver, `MATCH (s:Section {id: $id})-[:CONTAINS]->(t:Section) WHERE true${live} RETURN ${secCols} ORDER BY t.ordinal`, { id: me.id });
  const prev = await one(`MATCH (t:Section)-[:NEXT]->(s:Section {id: $id}) WHERE true${live} RETURN ${secCols}`);
  const next = await one(`MATCH (s:Section {id: $id})-[:NEXT]->(t:Section) WHERE true${live} RETURN ${secCols}`);

  const out = await rows(
    driver,
    `MATCH (s:Section {id: $id})-[r:LINKS_TO]->(t) WHERE (t:Section OR t:Document)${live}
     RETURN labels(t) AS labels, t.id AS id, t.path AS path, t.headingPath AS headingPath, t.title AS title, t.startLine AS startLine, t.endLine AS endLine,
            t.hash AS hash, t.commit AS commit, t.text AS text, t.deleted AS deleted, r.line AS line, r.url AS url, r.kind AS kind ORDER BY r.line, t.id`,
    { id: me.id },
  );
  const into = await rows(
    driver,
    `MATCH (t:Section)-[r:LINKS_TO]->(s:Section {id: $id}) WHERE true${live}
     RETURN ${secCols}, r.line AS line, r.url AS url ORDER BY t.path, r.line`,
    { id: me.id },
  );
  const intoDoc = await rows(
    driver,
    `MATCH (t:Section)-[r:LINKS_TO]->(d:Document {id: $docId}) WHERE true${live}
     RETURN ${secCols}, r.line AS line, r.url AS url ORDER BY t.path, r.line`,
    { docId: `${corpus}:${me.path}` },
  );
  const dangling = await rows(
    driver,
    'MATCH (s:Section {id: $id})-[r:DANGLING_LINK]->(m:MissingTarget) RETURN m.target AS target, r.reason AS reason, r.line AS line, r.url AS url ORDER BY r.line',
    { id: me.id },
  );
  const docRow = (await rows(driver, 'MATCH (d:Document {id: $id}) RETURN d.uid AS uid', { id: `${corpus}:${me.path}` }))[0] || {};

  return {
    section: { id: me.id, citation: cite({ ...me, uid: docRow.uid }, corpus), snippet: preview(me.text), deleted: me.deleted === true ? true : undefined },
    structure: { parent: parent ? sec(parent) : null, children: children.map(sec), previous: prev ? sec(prev) : null, next: next ? sec(next) : null },
    linksOut: out.map((r) => ({
      line: r.line,
      link: r.url,
      kind: r.kind,
      target: r.labels.includes('Section')
        ? { type: 'section', ...sec(r) }
        : { type: 'document', path: r.path, title: r.title, citation: { path: r.path, headingPath: '', startLine: 1, endLine: null, ref: r.path, corpus, provenance: { commit: r.commit || null, hash: r.hash || null, uid: null } } },
    })),
    linksIn: into.map((r) => ({ line: r.line, link: r.url, from: sec(r) })),
    linksToThisDocument: intoDoc.map((r) => ({ line: r.line, link: r.url, from: sec(r) })),
    danglingOut: dangling.map((r) => ({ line: r.line, link: r.url, target: r.target, reason: r.reason })),
  };
}

// ---------------------------------------------------------------- work items

export async function toolWorkItem(driver, corpus, { id, includeDeleted = false }) {
  const all = await rows(driver, 'MATCH (w:WorkItem {corpus: $c}) RETURN w.wid AS wid ORDER BY wid', { c: corpus });
  const ids = all.map((r) => r.wid);
  if (!ids.length) {
    throw new ToolError(`corpus ${corpus} has no work-item layer. It is optional: add a breakwall.json with workItems.idFromPath (and phases), or a "work-item:" key in document frontmatter, then sync.`);
  }
  let wid = ids.includes(id) ? id : null;
  if (!wid) {
    const ci = ids.filter((x) => x.toLowerCase() === String(id).toLowerCase());
    if (ci.length === 1) wid = ci[0];
  }
  if (!wid) throw new ToolError(`unknown work item "${id}"; known: ${ids.slice(0, 50).join(', ')}${ids.length > 50 ? ` (+${ids.length - 50} more)` : ''}`);

  const docs = await rows(
    driver,
    `MATCH (d:Document {corpus: $c, workItem: $wid}) WHERE $del OR d.deleted IS NULL
     OPTIONAL MATCH (n:Document)-[:SUPERSEDES]->(d)
     RETURN d.path AS path, d.title AS title, d.phase AS phase, d.status AS status, d.uid AS uid, d.hash AS hash, d.commit AS commit,
            d.lineCount AS lineCount, d.deleted AS deleted, collect(DISTINCT n.path) AS supersededBy ORDER BY d.path`,
    { c: corpus, wid, del: includeDeleted },
  );
  const secs = await rows(
    driver,
    `MATCH (s:Section {corpus: $c}) WHERE s.docId IN $ids AND s.level >= 1
     RETURN s.docId AS docId, s.headingPath AS headingPath, s.startLine AS startLine, s.endLine AS endLine ORDER BY s.docId, s.ordinal`,
    { c: corpus, ids: docs.map((d) => `${corpus}:${d.path}`) },
  );
  const byDoc = new Map();
  for (const s of secs) byDoc.set(s.docId, [...(byDoc.get(s.docId) || []), s]);
  const entry = (d) => {
    const all = byDoc.get(`${corpus}:${d.path}`) || [];
    return {
      citation: cite({ path: d.path, headingPath: '', startLine: 1, endLine: d.lineCount, commit: d.commit, hash: d.hash, uid: d.uid }, corpus),
      title: d.title,
      status: d.status ?? null,
      superseded: d.supersededBy.length > 0,
      supersededBy: d.supersededBy.sort(),
      deleted: d.deleted === true ? true : undefined,
      sections: all.slice(0, 25).map((s) => ({ headingPath: s.headingPath, ref: `${d.path}:${s.startLine}-${s.endLine}` })),
      moreSections: all.length > 25 ? all.length - 25 : undefined,
    };
  };
  // Phase order comes from the corpus' own breakwall.json when it is still on disk, else the default order.
  const seen = [...new Set(docs.map((d) => d.phase).filter(Boolean))];
  const order = phaseOrder(await readConfig(driver, corpus), seen);
  const phases = order.map((p) => ({ phase: p, documents: docs.filter((d) => d.phase === p).map(entry) }));
  const unphased = docs.filter((d) => !d.phase).map(entry);
  if (unphased.length) phases.push({ phase: null, documents: unphased });
  return { workItem: wid, corpus, documentCount: docs.length, phases };
}

async function readConfig(driver, corpus) {
  const root = (await rows(driver, 'MATCH (c:Corpus {id: $c}) RETURN c.root AS root', { c: corpus }))[0]?.root;
  if (!root || !existsSync(root)) return null;
  try {
    const { loadConfig } = await import('./lifecycle.js');
    return loadConfig(root);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- history

/** Find the document(s) a topic means: path, uid or an earlier path first, then title/path substring. */
async function findDocs(driver, corpus, topic) {
  const cols = 'd.id AS id, d.path AS path, d.title AS title, d.uid AS uid, d.status AS status, d.deleted AS deleted, d.deletedAt AS deletedAt, d.events AS events, d.hash AS hash, d.commit AS commit, d.lineCount AS lineCount';
  const exact = await rows(driver, `MATCH (d:Document {corpus: $c}) WHERE d.path = $t OR d.uid = $t OR d.id = $t RETURN ${cols} ORDER BY d.deleted IS NOT NULL, d.path`, { c: corpus, t: topic });
  if (exact.length) return { docs: [exact[0]], by: 'exact' };
  const earlier = (await rows(driver, `MATCH (d:Document {corpus: $c}) WHERE d.events CONTAINS $t RETURN ${cols} ORDER BY d.path`, { c: corpus, t: JSON.stringify(topic).slice(1, -1) })).filter((d) => parseEvents(d.events).some((e) => e.from === topic || e.path === topic));
  if (earlier.length) return { docs: [earlier[0]], by: 'earlier-path' };
  const like = await rows(
    driver,
    `MATCH (d:Document {corpus: $c}) WHERE toLower(d.title) CONTAINS toLower($t) OR toLower(d.path) CONTAINS toLower($t) RETURN ${cols} ORDER BY d.deleted IS NOT NULL, d.path LIMIT 11`,
    { c: corpus, t: topic },
  );
  return { docs: like, by: 'substring' };
}

export async function toolHistory(driver, corpus, { topic }) {
  const { docs, by } = await findDocs(driver, corpus, topic);
  if (!docs.length) throw new ToolError(`no document matches "${topic}" (tried path, uid, earlier paths, title and path substring)`);
  if (docs.length > 1) {
    return {
      ambiguous: true,
      message: `${docs.length > 10 ? 'more than 10' : docs.length} documents match "${topic}"; call again with one path`,
      candidates: docs.slice(0, 10).map((d) => ({ path: d.path, title: d.title, status: d.status ?? null, deleted: d.deleted === true ? true : undefined })),
    };
  }
  const d = docs[0];

  // Supersession component around d. Edges are stored "newer -> older"; newest first = depth from the heads.
  const edges = await rows(driver, 'MATCH (a:Document {corpus: $c})-[:SUPERSEDES]->(b:Document) RETURN a.path AS newer, b.path AS older', { c: corpus });
  const adj = new Map();
  const link = (a, b) => adj.set(a, [...(adj.get(a) || []), b]);
  for (const e of edges) {
    link(e.newer, e.older);
    link(e.older, e.newer);
  }
  const comp = new Set([d.path]);
  for (const q = [d.path]; q.length; ) for (const n of adj.get(q.shift()) || []) if (!comp.has(n)) (comp.add(n), q.push(n));
  const inC = edges.filter((e) => comp.has(e.newer) && comp.has(e.older));
  const hasNewer = new Set(inC.map((e) => e.older));
  const depth = new Map();
  const heads = [...comp].filter((p) => !hasNewer.has(p)).sort();
  heads.forEach((h) => depth.set(h, 0));
  for (const q = [...heads]; q.length; ) {
    const p = q.shift();
    for (const e of inC.filter((x) => x.newer === p).sort((a, b) => (a.older < b.older ? -1 : 1))) {
      if (!depth.has(e.older)) (depth.set(e.older, depth.get(p) + 1), q.push(e.older));
    }
  }
  const members = await rows(
    driver,
    'MATCH (x:Document {corpus: $c}) WHERE x.path IN $paths RETURN x.path AS path, x.title AS title, x.status AS status, x.uid AS uid, x.hash AS hash, x.commit AS commit, x.lineCount AS lineCount, x.deleted AS deleted, x.deletedAt AS deletedAt',
    { c: corpus, paths: [...comp] },
  );
  const chain = members
    .map((m) => ({
      depth: depth.get(m.path) ?? 0,
      path: m.path,
      title: m.title,
      status: m.status ?? null,
      deleted: m.deleted === true ? true : undefined,
      deletedAt: m.deletedAt ?? undefined,
      supersedes: inC.filter((e) => e.newer === m.path).map((e) => e.older).sort(),
      supersededBy: inC.filter((e) => e.older === m.path).map((e) => e.newer).sort(),
      focus: m.path === d.path ? true : undefined,
      citation: cite({ path: m.path, headingPath: '', startLine: 1, endLine: m.lineCount, commit: m.commit, hash: m.hash, uid: m.uid }, corpus),
    }))
    .sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1));

  return {
    matchedBy: by,
    document: { path: d.path, title: d.title, uid: d.uid, status: d.status ?? null, deleted: d.deleted === true, deletedAt: d.deletedAt ?? undefined, citation: cite({ path: d.path, headingPath: '', startLine: 1, endLine: d.lineCount, commit: d.commit, hash: d.hash, uid: d.uid }, corpus) },
    lifecycle: parseEvents(d.events),
    note: 'lifecycle lists renames, deletions and restores recorded by sync; content edits are in git (see provenance.commit). A wipe of the index loses it.',
    supersessionChainNewestFirst: chain,
    current: chain.filter((x) => x.depth === 0 && !x.deleted).map((x) => x.path),
  };
}

// ---------------------------------------------------------------- lint / status

export async function toolLint(driver, corpus, { rules = null, maxFindings = 200 } = {}) {
  const root = (await rows(driver, 'MATCH (c:Corpus {id: $c}) RETURN c.root AS root', { c: corpus }))[0]?.root;
  if (!root || !existsSync(root)) throw new ToolError(`corpus root ${root || '(unknown)'} is not on this machine any more; lint reads the files, so it cannot run`);
  const loaded = loadCorpus(root, corpus, { git: false });
  let findings = lintCorpus(loaded);
  if (rules && rules.length) findings = findings.filter((f) => rules.includes(f.rule));
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] || 0) + 1;
  return { corpus, root, documents: loaded.docs.length, totalFindings: findings.length, counts, findings: findings.slice(0, maxFindings), truncated: findings.length > maxFindings ? true : undefined };
}

export async function toolStatus(driver) {
  const corpora = await rows(
    driver,
    `MATCH (c:Corpus)
     OPTIONAL MATCH (d:Document {corpus: c.id})
     WITH c, count(d) AS docsAll, sum(CASE WHEN d.deleted IS NULL THEN 1 ELSE 0 END) AS docsLive, sum(CASE WHEN d.deleted = true THEN 1 ELSE 0 END) AS tombstoned,
          sum(CASE WHEN d.status IS NOT NULL THEN 1 ELSE 0 END) AS withStatus
     OPTIONAL MATCH (s:Section {corpus: c.id}) WHERE s.deleted IS NULL
     WITH c, docsLive, tombstoned, withStatus, count(s) AS sections
     OPTIONAL MATCH (k:Chunk {corpus: c.id})
     WITH c, docsLive, tombstoned, withStatus, sections, count(k) AS chunks, collect(DISTINCT k.embedModel) AS models
     OPTIONAL MATCH (w:WorkItem {corpus: c.id})
     WITH c, docsLive, tombstoned, withStatus, sections, chunks, models, count(w) AS workItems
     OPTIONAL MATCH (:Document {corpus: c.id})-[r:SUPERSEDES]->(o:Document) WHERE o.deleted IS NULL
     RETURN c.id AS corpus, c.commit AS commit, c.root AS root, docsLive, tombstoned, sections, chunks, models, workItems, withStatus, count(DISTINCT o) AS supersededDocs
     ORDER BY corpus`,
  );
  const inferred = new Map();
  const search = new Map();
  for (const c of corpora) {
    inferred.set(c.corpus, await inferStatus(driver, c.corpus));
    search.set(c.corpus, await searchStatus(driver, c.corpus));
  }
  return {
    corpora: corpora.map((c) => ({
      corpus: c.corpus,
      search: search.get(c.corpus),
      inferred: inferred.get(c.corpus),
      indexedCommit: c.commit ?? null,
      root: c.root ?? null,
      documents: c.docsLive,
      tombstoned: c.tombstoned,
      sections: c.sections,
      chunks: c.chunks,
      embedModels: c.models,
      workItems: c.workItems,
      documentsWithStatus: c.withStatus,
      supersededDocuments: c.supersededDocs,
    })),
    lowConfidenceCosine: DEFAULTS.minCosine,
  };
}

/**
 * Plan item 57 for status: vectors on/off and where from (as stored by the last sync), the effective default mode and
 * where from, and the unembedded chunk count. A default that cannot be served is reported as an error, not thrown.
 */
async function searchStatus(driver, corpus) {
  try {
    const sw = await corpusSwitches(driver, corpus, {});
    return { vectors: sw.vectors.on, vectorsSource: sw.vectors.source, defaultMode: sw.mode.mode, defaultModeSource: sw.mode.source, unembeddedChunks: sw.unembedded };
  } catch (e) {
    if (!(e instanceof SwitchError)) throw e;
    try {
      const s = await corpusSwitches(driver, corpus, { explicit: 'lexical', env: {} }); // still report what is known
      return { vectors: s.vectors.on, vectorsSource: s.vectors.source, defaultMode: null, defaultModeError: e.message, unembeddedChunks: s.unembedded };
    } catch {
      return { defaultMode: null, defaultModeError: e.message };
    }
  }
}

// ---------------------------------------------------------------- cite (Undertow bridge, plan item 53)

/** The citation string and its parts for one section. Same section selection rules as `get`. */
export async function toolCite(driver, corpus, { ref, heading = null, includeDeleted = false }) {
  const hits = await getSection(driver, corpus, ref, heading, { includeDeleted });
  if (!hits.length) throw new ToolError(`no section found for "${ref}"${heading ? ` / "${heading}"` : ''}`);
  if (hits.length > 1) {
    const list = hits.slice(0, 20).map((h) => `  ${h.path} [${h.startLine}-${h.endLine}] ${h.headingPath || '(preamble)'}`);
    throw new ToolError([`${hits.length} sections match; narrow the heading or pass a section id:`, ...list].join('\n'));
  }
  const h = hits[0];
  const doc = (await rows(driver, 'MATCH (d:Document {id: $id}) RETURN d.commit AS commit', { id: `${corpus}:${h.path}` }))[0] || {};
  const commit = doc.commit || h.commit || null;
  const parts = { corpus, path: h.path, headingPath: h.headingPath, commit };
  return { citation: formatCitation(parts), ...parts, startLine: h.startLine, endLine: h.endLine, hash: h.hash, note: 'a pointer, not content; quote the section with breakwall_get when it is needed' };
}

/** Is a citation string still good? Read-only. */
export async function toolCiteCheck(driver, citation) {
  const cited = parseCitation(citation);
  const doc = (await rows(driver, 'MATCH (d:Document {id: $id}) RETURN d.commit AS commit, d.deleted AS deleted', { id: `${cited.corpus}:${cited.path}` }))[0];
  let sectionExists = !cited.headingPath;
  if (doc && cited.headingPath) {
    const hits = await getSection(driver, cited.corpus, cited.path, cited.headingPath, { includeDeleted: true });
    sectionExists = hits.length >= 1;
  }
  const verdict = judgeCitation(cited, { docExists: !!doc, deleted: doc?.deleted === true, sectionExists, commit: doc?.commit ?? null });
  return { citation, cited, ...verdict, currentCommit: doc?.commit ?? null };
}

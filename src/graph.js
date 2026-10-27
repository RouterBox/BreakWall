// Neo4j side. The graph is a derived index of the files: index() can be re-run at any
// time and wipe() + index() must give an identical graph (see rebuildCheck).
import neo4j from 'neo4j-driver';
import { createHash } from 'node:crypto';
import { resolveLinks } from './resolve.js';
import { resolveSupersession } from './lifecycle.js';
import { matchRenames, headingSet, newUid, parseEvents } from './sync.js';
import { fileExists } from './scan.js';
import { chunkSection, embedInput } from './chunk.js';
import { localEmbedder, embedHash, DIMS } from './embed.js';
import { sha256 as sha } from './parse.js';
import { vectorsForRoot } from './switches.js';

const DET = { layer: 'deterministic' }; // every edge from parsing carries this

export function connect(env = process.env) {
  return neo4j.driver(
    env.NEO4J_URI || 'bolt://127.0.0.1:7688',
    neo4j.auth.basic(env.NEO4J_USER || 'neo4j', env.NEO4J_PASSWORD),
    { disableLosslessIntegers: true },
  );
}

export async function ensureSchema(driver) {
  const s = driver.session();
  try {
    for (const q of [
      'CREATE CONSTRAINT corpus_id IF NOT EXISTS FOR (n:Corpus) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT document_id IF NOT EXISTS FOR (n:Document) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT section_id IF NOT EXISTS FOR (n:Section) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT missing_id IF NOT EXISTS FOR (n:MissingTarget) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (n:Chunk) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT workitem_id IF NOT EXISTS FOR (n:WorkItem) REQUIRE n.id IS UNIQUE',
      // Inferred layer (M4). These labels exist only when `infer` has run.
      'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT community_id IF NOT EXISTS FOR (n:Community) REQUIRE n.id IS UNIQUE',
      'CREATE CONSTRAINT inferredrun_id IF NOT EXISTS FOR (n:InferredRun) REQUIRE n.id IS UNIQUE',
      // BM25 (Lucene) over chunk text + heading path. Stemming and stop words via the english analyzer.
      "CREATE FULLTEXT INDEX chunk_text IF NOT EXISTS FOR (n:Chunk) ON EACH [n.text, n.headingPath] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
      `CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS FOR (n:Chunk) ON (n.embedding) OPTIONS {indexConfig: {\`vector.dimensions\`: ${DIMS}, \`vector.similarity_function\`: 'cosine'}}`,
    ]) await s.run(q);
    await s.run('CALL db.awaitIndexes(120)');
  } finally {
    await s.close();
  }
}

/**
 * Lucene keeps deleted documents in its term statistics until segments merge, so BM25 scores would depend on the
 * history of deletes and re-indexes. Dropping and recreating the full-text index repopulates it from the live
 * nodes only, which makes scores a function of the current content (stable answers, plan principle 5).
 * Cheap at this size; revisit with M3's incremental sync for big corpora.
 */
export async function rebuildFulltext(driver) {
  const s = driver.session();
  try {
    await s.run('DROP INDEX chunk_text IF EXISTS');
  } finally {
    await s.close();
  }
  await ensureSchema(driver);
}

/** Remove everything belonging to one corpus. */
export async function wipe(driver, corpusName) {
  const s = driver.session();
  try {
    await s.run('MATCH (n) WHERE n.corpus = $c OR (n:Corpus AND n.id = $c) DETACH DELETE n', { c: corpusName });
  } finally {
    await s.close();
  }
  await rebuildFulltext(driver);
}

const sumUpdates = (counters) => Object.values(counters.updates()).reduce((a, b) => a + b, 0);
const isoNow = () => new Date().toISOString();
const dead = (x) => x === true;

/**
 * Sync a loaded corpus into the graph (PLAN items 23-26). Per file, by content hash:
 *   unchanged -> no write, no embed;  changed/added -> one transaction for the document, only new embed hashes are embedded;
 *   renamed   -> same document (uid, history) under its new path;  gone -> tombstone;  reappeared at the same path -> restored.
 * A run with nothing to do performs zero graph writes (stats.writes counts Neo4j's own update counters).
 * Cross-document edges (links, supersession, work items) are rebuilt in one transaction, and only when something changed.
 * Vectors (plan item 57, switch B): `vectors` is { on, source }, resolved from env and the corpus' breakwall.json when not
 * given. Off: nothing is embedded and the model is never loaded; stored embeddings are kept (reversible) and every chunk
 * keeps its embedHash, so switching back on embeds only the chunks that have no vector yet.
 */
export async function indexCorpus(driver, corpus, { embedder = localEmbedder(), now = isoNow, vectors = vectorsForRoot(corpus.root) } = {}) {
  await ensureSchema(driver);
  const c = corpus.name;
  const session = driver.session();
  const stats = {
    vectors,
    documents: 0, sections: 0, chunks: 0, embedded: 0, reused: 0, backfilled: 0, unembedded: 0, skipped: 0, links: 0, dangling: 0,
    removed: 0, // alias of tombstoned, kept for M1/M2 callers
    writes: 0,
    changes: { added: [], changed: [], renamed: [], tombstoned: [], restored: [], unchanged: 0 },
    supersessionDangling: [],
  };
  const exec = async (runner, q, p) => {
    const r = await runner.run(q, p);
    stats.writes += sumUpdates(r.summary.counters);
    return r;
  };
  try {
    // Corpus node: written only when something differs.
    const cur = (await exec(session, 'MATCH (c:Corpus {id: $c}) RETURN c.commit AS commit, c.root AS root, c.linkDigest AS digest, c.vectors AS vectors, c.vectorsSource AS vsrc', { c })).records[0];
    const cprops = { c, commit: corpus.commit, root: corpus.root, vectors: vectors.on, vsrc: vectors.source };
    if (!cur) await exec(session, 'CREATE (c:Corpus {id: $c, name: $c, commit: $commit, root: $root, vectors: $vectors, vectorsSource: $vsrc})', cprops);
    else if ((cur.get('commit') ?? null) !== (corpus.commit ?? null) || cur.get('root') !== corpus.root || cur.get('vectors') !== vectors.on || cur.get('vsrc') !== vectors.source) {
      await exec(session, 'MATCH (c:Corpus {id: $c}) SET c.name = $c, c.commit = $commit, c.root = $root, c.vectors = $vectors, c.vectorsSource = $vsrc', cprops);
    }
    const storedDigest = cur ? cur.get('digest') : null;

    // What the index knows now.
    const existing = new Map(); // path -> { id, hash, commit, uid, events, deleted }
    for (const r of (await exec(session, 'MATCH (d:Document {corpus: $c}) RETURN d.id AS id, d.path AS path, d.hash AS hash, d.commit AS commit, d.uid AS uid, d.events AS events, d.deleted AS deleted', { c })).records) {
      existing.set(r.get('path'), { id: r.get('id'), hash: r.get('hash'), commit: r.get('commit'), uid: r.get('uid'), events: parseEvents(r.get('events')), deleted: dead(r.get('deleted')) });
    }
    const oldHeadings = new Map(); // docId -> Set of heading texts (live sections, levels 2+)
    for (const r of (await exec(session, 'MATCH (s:Section {corpus: $c}) WHERE s.level >= 2 AND s.deleted IS NULL RETURN s.docId AS d, s.heading AS h', { c })).records) {
      if (!oldHeadings.has(r.get('d'))) oldHeadings.set(r.get('d'), new Set());
      oldHeadings.get(r.get('d')).add(r.get('h').trim().toLowerCase());
    }

    // Classify. fresh = never seen; restored = tombstoned path reappeared; gone = live in the index, not on disk.
    const onDisk = new Set(corpus.docs.map((d) => d.path));
    const fresh = corpus.docs.filter((d) => !existing.has(d.path));
    const gone = [...existing.entries()].filter(([p, e]) => !e.deleted && !onDisk.has(p)).map(([p, e]) => ({ path: p, hash: e.hash, headings: oldHeadings.get(e.id) || new Set() }));
    const renames = matchRenames(gone, fresh.map((d) => ({ path: d.path, hash: d.hash, headings: headingSet(d.sections) })));
    const renameTo = new Map(renames.map((r) => [r.to, r]));
    const renamedFrom = new Set(renames.map((r) => r.from));
    const tombstones = gone.filter((g) => !renamedFrom.has(g.path));

    // Chunk everything, then embed only chunks whose embed hash is not already stored (plan section 11 cost metric).
    // Done before any delete so a renamed document's old chunks still feed the cache.
    const chunksByDoc = new Map();
    const wanted = new Map(); // embedHash -> embed input
    for (const doc of corpus.docs) {
      const rows = [];
      for (const s of doc.sections) {
        for (const k of chunkSection({ ...s, id: `${c}:${s.id}` })) {
          const input = embedInput(k, doc.title);
          const eh = embedHash(input, embedder.model);
          wanted.set(eh, input);
          rows.push({ ...k, corpus: c, docId: `${c}:${doc.path}`, sectionId: `${c}:${s.id}`, path: doc.path, hash: sha(k.text), embedHash: eh, embedModel: embedder.model, commit: doc.commit });
        }
      }
      chunksByDoc.set(doc.path, rows);
    }
    const have = new Map();
    for (const r of (await exec(session, 'MATCH (k:Chunk {corpus: $c}) WHERE k.embedding IS NOT NULL RETURN k.embedHash AS h, k.embedding AS e', { c })).records) have.set(r.get('h'), r.get('e'));
    const missing = [...wanted.keys()].filter((h) => !have.has(h));
    if (missing.length && vectors.on) {
      const vecs = await embedder.embed(missing.map((h) => wanted.get(h)));
      missing.forEach((h, i) => have.set(h, vecs[i]));
    }
    stats.embedded = vectors.on ? missing.length : 0;
    stats.reused = wanted.size - missing.length;

    // Documents whose file hash, commit and chunks (text, lines, embed hash) are unchanged are left alone.
    const sigOf = (rows) => rows.map((k) => [k.id, k.hash, k.embedHash, k.startLine, k.endLine, k.commit ?? ''].join('|')).sort().join(String.fromCharCode(10));
    const existingChunks = new Map();
    for (const r of (await exec(session, 'MATCH (k:Chunk {corpus: $c}) RETURN k.docId AS d, k.id AS id, k.hash AS hash, k.embedHash AS eh, k.startLine AS sl, k.endLine AS el, k.commit AS commit, k.embedding IS NULL AS noVec', { c })).records) {
      if (!existingChunks.has(r.get('d'))) existingChunks.set(r.get('d'), []);
      existingChunks.get(r.get('d')).push({ id: r.get('id'), hash: r.get('hash'), embedHash: r.get('eh'), startLine: r.get('sl'), endLine: r.get('el'), commit: r.get('commit'), noVec: r.get('noVec') });
    }
    let wrote = false; // a document or tombstone changed, i.e. chunks changed

    for (const doc of corpus.docs) {
      const docId = `${c}:${doc.path}`;
      const was = existing.get(doc.path);
      if (was && !was.deleted && was.hash === doc.hash && (was.commit ?? null) === (doc.commit ?? null) && sigOf(existingChunks.get(docId) || []) === sigOf(chunksByDoc.get(doc.path))) {
        if (!was.uid) await exec(session, "MATCH (d:Document {id: $id}) SET d.uid = $uid, d.events = '[]'", { id: docId, uid: newUid(c, doc.path) }); // index written before M3
        // Vectors switched back on: give unchanged chunks the vectors they lack, without rewriting the document.
        const lacking = (existingChunks.get(docId) || []).filter((k) => k.noVec && have.has(k.embedHash));
        if (lacking.length) {
          await exec(session, 'UNWIND $rows AS r MATCH (k:Chunk {id: r.id}) CALL db.create.setNodeVectorProperty(k, "embedding", r.embedding)', { rows: lacking.map((k) => ({ id: k.id, embedding: have.get(k.embedHash) })) });
          stats.backfilled += lacking.length;
        }
        stats.unembedded += (existingChunks.get(docId) || []).filter((k) => k.noVec && !have.has(k.embedHash)).length;
        stats.skipped++;
        stats.changes.unchanged++;
        stats.documents++;
        stats.sections += doc.sections.length;
        stats.chunks += chunksByDoc.get(doc.path).length;
        continue;
      }
      wrote = true;

      // Identity and history: carried over for a rewrite, a restore or a rename; minted for a new document.
      const at = now();
      let uid;
      let events;
      let oldDocId = null;
      if (renameTo.has(doc.path)) {
        const r = renameTo.get(doc.path);
        const src = existing.get(r.from);
        uid = src.uid || newUid(c, r.from);
        events = [...src.events, { event: 'renamed', from: r.from, to: doc.path, by: r.by, at }];
        oldDocId = src.id;
        stats.changes.renamed.push({ from: r.from, to: doc.path, by: r.by, score: Number(r.score.toFixed(3)) });
      } else if (was) {
        uid = was.uid || newUid(c, doc.path);
        events = was.events;
        if (was.deleted) {
          events = [...events, { event: 'restored', path: doc.path, at }];
          stats.changes.restored.push(doc.path);
        } else stats.changes.changed.push(doc.path);
      } else {
        uid = newUid(c, doc.path);
        events = [];
        stats.changes.added.push(doc.path);
      }

      const sections = doc.sections.map((s) => ({
        id: `${c}:${s.id}`,
        corpus: c,
        docId,
        path: doc.path,
        ordinal: s.ordinal,
        level: s.level,
        heading: s.heading,
        headingPath: s.headingPath.join(' > '),
        slug: s.slug,
        startLine: s.startLine,
        endLine: s.endLine,
        text: s.text,
        hash: s.hash,
        commit: doc.commit,
      }));
      const contains = doc.sections.filter((s) => s.parentId).map((s) => ({ parent: `${c}:${s.parentId}`, child: `${c}:${s.id}` }));
      const top = sections.filter((_, i) => !doc.sections[i].parentId).map((s) => s.id);
      const next = doc.sections.slice(1).map((s, i) => ({ from: `${c}:${doc.sections[i].id}`, to: `${c}:${s.id}` }));

      const tx = session.beginTransaction();
      try {
        for (const id of [docId, oldDocId].filter(Boolean)) {
          await exec(tx, 'MATCH (k:Chunk {docId: $docId}) DETACH DELETE k', { docId: id });
          await exec(tx, 'MATCH (s:Section {docId: $docId}) DETACH DELETE s', { docId: id });
          await exec(tx, 'MATCH (d:Document {id: $docId}) DETACH DELETE d', { docId: id });
        }
        await exec(
          tx,
          `MATCH (c:Corpus {id: $c})
           CREATE (d:Document {id: $docId, corpus: $c, path: $path, title: $title, hash: $hash, commit: $commit,
                               frontmatter: $fm, lineCount: $lineCount, sectionCount: $n, uid: $uid, events: $events})
           CREATE (c)-[:CONTAINS $det]->(d)`,
          { c, docId, path: doc.path, title: doc.title, hash: doc.hash, commit: doc.commit, fm: JSON.stringify(doc.frontmatter), lineCount: doc.lineCount, n: sections.length, uid, events: JSON.stringify(events), det: { ...DET, method: 'structure' } },
        );
        await exec(tx, 'UNWIND $rows AS row CREATE (s:Section) SET s = row', { rows: sections });
        await exec(tx, 'MATCH (d:Document {id: $docId}) UNWIND $ids AS id MATCH (s:Section {id: id}) CREATE (d)-[:CONTAINS $det]->(s)', { docId, ids: top, det: { ...DET, method: 'structure' } });
        await exec(tx, 'UNWIND $rows AS r MATCH (p:Section {id: r.parent}), (s:Section {id: r.child}) CREATE (p)-[:CONTAINS $det]->(s)', { rows: contains, det: { ...DET, method: 'heading-tree' } });
        await exec(tx, 'UNWIND $rows AS r MATCH (a:Section {id: r.from}), (b:Section {id: r.to}) CREATE (a)-[:NEXT $det]->(b)', { rows: next, det: { ...DET, method: 'reading-order' } });
        const chunkRows = chunksByDoc.get(doc.path);
        await exec(tx, 'UNWIND $rows AS row CREATE (k:Chunk) SET k = row', { rows: chunkRows });
        await exec(tx, 'UNWIND $rows AS r MATCH (s:Section {id: r.sectionId}), (k:Chunk {id: r.id}) CREATE (s)-[:HAS_CHUNK $det]->(k)', { rows: chunkRows.map((k) => ({ id: k.id, sectionId: k.sectionId })), det: { ...DET, method: 'chunking' } });
        // With vectors off only already-stored vectors are carried over (nothing new is computed).
        const withVec = chunkRows.filter((k) => have.has(k.embedHash));
        await exec(tx, 'UNWIND $rows AS r MATCH (k:Chunk {id: r.id}) CALL db.create.setNodeVectorProperty(k, "embedding", r.embedding)', { rows: withVec.map((k) => ({ id: k.id, embedding: have.get(k.embedHash) })) });
        stats.unembedded += chunkRows.length - withVec.length;
        stats.chunks += chunkRows.length;
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      stats.documents++;
      stats.sections += sections.length;
    }

    // Tombstones: the document and its sections stay (flagged), chunks go so search never sees them.
    for (const g of tombstones) {
      wrote = true;
      const e = existing.get(g.path);
      const events = [...e.events, { event: 'deleted', path: g.path, hash: e.hash, at: now() }];
      const tx = session.beginTransaction();
      try {
        await exec(tx, 'MATCH (k:Chunk {docId: $docId}) DETACH DELETE k', { docId: e.id });
        await exec(tx, 'MATCH (s:Section {docId: $docId}) SET s.deleted = true', { docId: e.id });
        await exec(tx, 'MATCH (d:Document {id: $docId}) SET d.deleted = true, d.deletedAt = $at, d.events = $events, d.uid = $uid', { docId: e.id, at: events[events.length - 1].at, events: JSON.stringify(events), uid: e.uid || newUid(c, g.path) });
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
      stats.changes.tombstoned.push(g.path);
    }
    stats.removed = stats.changes.tombstoned.length;
    // Tombstoned documents still count as targets for supersession (history keeps its chain).
    const tombstonedPaths = new Set([...existing.entries()].filter(([p, e]) => e.deleted && !onDisk.has(p)).map(([p]) => p).concat(tombstones.map((g) => g.path)));

    // Cross-document layer: links, supersession, work items. Rebuilt in one transaction, only if anything could have changed.
    const { resolved, dangling } = resolveLinks(corpus, (p) => fileExists(corpus.root, p));
    const known = new Set([...onDisk, ...tombstonedPaths]);
    const sup = resolveSupersession(corpus.docs, known);
    const work = corpus.docs.filter((d) => d.workItem).map((d) => ({ path: d.path, id: d.workItem.id, phase: d.workItem.phase, source: d.workItem.source }));
    const docProps = corpus.docs.map((d) => ({ id: `${c}:${d.path}`, status: d.lifecycle.status, workItem: d.workItem ? d.workItem.id : null, phase: d.workItem ? d.workItem.phase : null }));
    const digestNow = digest(JSON.stringify({ resolved, dangling, sup, work, docProps, tombstonedPaths: [...tombstonedPaths].sort() }));
    stats.links = resolved.length;
    stats.dangling = dangling.length;
    stats.supersessionDangling = sup.dangling;

    if (wrote || storedDigest !== digestNow) {
      const tx = session.beginTransaction();
      try {
        await exec(tx, 'MATCH (s:Section {corpus: $c})-[r:LINKS_TO|DANGLING_LINK]->() WHERE s.deleted IS NULL DELETE r', { c });
        await exec(tx, 'MATCH (m:MissingTarget {corpus: $c}) DETACH DELETE m', { c });
        await exec(tx, 'MATCH (a:Document {corpus: $c})-[r:SUPERSEDES]->() WHERE a.deleted IS NULL DELETE r', { c });
        await exec(tx, 'MATCH (w:WorkItem {corpus: $c}) DETACH DELETE w', { c });
        const rel = (r) => ({
          from: `${c}:${r.fromSectionId}`,
          to: r.toSection ? `${c}:${r.toSection}` : `${c}:${r.toDoc}`,
          toIsSection: !!r.toSection,
          props: { ...DET, method: r.kind === 'wikilink' ? 'wikilink' : 'markdown-link', kind: r.kind, url: r.url, text: r.text, line: r.line },
        });
        await exec(
          tx,
          `UNWIND $rows AS r MATCH (a:Section {id: r.from})
           CALL { WITH r MATCH (b:Section {id: r.to}) WHERE r.toIsSection RETURN b AS t UNION WITH r MATCH (b:Document {id: r.to}) WHERE NOT r.toIsSection RETURN b AS t }
           CREATE (a)-[x:LINKS_TO]->(t) SET x = r.props`,
          { rows: resolved.map(rel) },
        );
        const missingRows = dangling.map((d) => ({
          from: `${c}:${d.fromSectionId}`,
          to: `${c}:${d.target}`,
          target: d.target,
          props: { ...DET, method: d.kind === 'wikilink' ? 'wikilink' : 'markdown-link', kind: d.kind, url: d.url, text: d.text, line: d.line, reason: d.reason },
        }));
        await exec(
          tx,
          `UNWIND $rows AS r MATCH (a:Section {id: r.from})
           MERGE (m:MissingTarget {id: r.to}) ON CREATE SET m.corpus = $c, m.target = r.target
           CREATE (a)-[x:DANGLING_LINK]->(m) SET x = r.props`,
          { rows: missingRows, c },
        );
        await exec(tx, 'UNWIND $rows AS r MATCH (d:Document {id: r.id}) SET d.status = r.status, d.workItem = r.workItem, d.phase = r.phase', { rows: docProps });
        await exec(
          tx,
          'UNWIND $rows AS r MATCH (a:Document {id: r.from}), (b:Document {id: r.to}) CREATE (a)-[x:SUPERSEDES]->(b) SET x = r.det',
          { rows: sup.edges.map((e) => ({ from: `${c}:${e.from}`, to: `${c}:${e.to}`, det: { ...DET, method: 'frontmatter', declaredIn: e.declaredIn } })) },
        );
        const wids = [...new Set(work.map((w) => w.id))].sort();
        await exec(tx, 'UNWIND $ids AS id CREATE (w:WorkItem {id: $c + ":work:" + id, corpus: $c, wid: id})', { ids: wids, c });
        await exec(
          tx,
          'UNWIND $rows AS r MATCH (d:Document {id: r.doc}), (w:WorkItem {id: r.wid}) CREATE (d)-[x:BELONGS_TO]->(w) SET x = r.det',
          { rows: work.map((w) => ({ doc: `${c}:${w.path}`, wid: `${c}:work:${w.id}`, det: { ...DET, method: w.source === 'frontmatter' ? 'frontmatter' : 'config-path', phase: w.phase } })) },
        );
        await exec(tx, 'MATCH (c:Corpus {id: $c}) SET c.linkDigest = $d', { c, d: digestNow });
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
    }
    if (wrote) await rebuildFulltext(driver);
  } finally {
    await session.close();
  }
  return stats;
}

/**
 * Canonical, order-independent text dump of one corpus' DETERMINISTIC subgraph. The inferred layer (layer: 'inferred',
 * M4) is excluded on purpose: the deterministic digest must not depend on it. See dumpInferred in infer/index.js.
 */
export async function dumpCorpus(driver, corpusName) {
  const s = driver.session();
  try {
    const nodes = await s.run(
      "MATCH (n) WHERE (n.corpus = $c OR (n:Corpus AND n.id = $c)) AND n.deleted IS NULL AND coalesce(n.layer, '') <> 'inferred' RETURN labels(n) AS l, properties(n) AS p",
      { c: corpusName },
    );
    const rels = await s.run(
      `MATCH (a)-[r]->(b) WHERE (a.corpus = $c OR (a:Corpus AND a.id = $c)) AND a.deleted IS NULL AND b.deleted IS NULL
         AND coalesce(r.layer, '') <> 'inferred' AND coalesce(a.layer, '') <> 'inferred' AND coalesce(b.layer, '') <> 'inferred'
       RETURN a.id AS a, type(r) AS t, b.id AS b, properties(r) AS p`,
      { c: corpusName },
    );
    const sortedJson = (o) => JSON.stringify(o, Object.keys(o).sort());
    const lines = [
      // The vector itself is left out (float noise); its embedHash/embedModel are in the dump.
      // Lifecycle state (uid, events, link digest) exists only in the index and is not rebuilt from files after a wipe
      // when a rename or deletion happened (PLAN item 26), so it is left out; tombstoned nodes are filtered in the queries.
      ...nodes.records.map((r) => { const p = r.get('p'); for (const k of ['embedding', 'uid', 'events', 'linkDigest']) delete p[k]; return `N ${r.get('l').sort().join(':')} ${sortedJson(p)}`; }),
      ...rels.records.map((r) => `R ${r.get('a')} -${r.get('t')}-> ${r.get('b')} ${sortedJson(r.get('p'))}`),
    ];
    return lines.sort().join('\n');
  } finally {
    await s.close();
  }
}

export const digest = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Plan section 11: wipe, reindex, diff. Returns { identical, nodes, rels, digest } for the deterministic layer (unchanged
 * meaning since M3). With { inferred: true } the inferred layer is also computed, wiped and recomputed, and compared:
 * the result gets an `inferred` block and `identical` is true only if both layers are identical.
 */
export async function rebuildCheck(driver, corpus, opts = {}) {
  const { inferred = false, passes, ...indexOpts } = opts;
  const infer = inferred ? (await import('./infer/index.js')).inferCorpus : null;
  const inferDump = inferred ? (await import('./infer/index.js')).dumpInferred : null;
  await indexCorpus(driver, corpus, indexOpts);
  if (infer) await infer(driver, corpus.name, { passes });
  const before = await dumpCorpus(driver, corpus.name);
  const beforeInf = inferred ? await inferDump(driver, corpus.name) : '';
  await wipe(driver, corpus.name);
  const empty = await dumpCorpus(driver, corpus.name);
  const emptyInf = inferred ? await inferDump(driver, corpus.name) : '';
  await indexCorpus(driver, corpus, indexOpts);
  if (infer) await infer(driver, corpus.name, { passes });
  const after = await dumpCorpus(driver, corpus.name);
  const afterInf = inferred ? await inferDump(driver, corpus.name) : '';
  const lines = after.split(String.fromCharCode(10));
  const det = before === after && empty === '';
  const res = {
    identical: det,
    wipedToEmpty: empty === '' && emptyInf === '',
    nodes: lines.filter((l) => l.startsWith('N ')).length,
    rels: lines.filter((l) => l.startsWith('R ')).length,
    digest: digest(after),
  };
  if (inferred) {
    const il = afterInf.split(String.fromCharCode(10));
    res.inferred = {
      identical: beforeInf === afterInf && afterInf !== '',
      nodes: il.filter((l) => l.startsWith('N ')).length,
      rels: il.filter((l) => l.startsWith('R ')).length,
      digest: digest(afterInf),
    };
    res.identical = det && res.inferred.identical && res.wipedToEmpty;
  }
  return res;
}

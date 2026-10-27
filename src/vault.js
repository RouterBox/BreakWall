// `breakwall vault` (plan item 58): a one-way Obsidian projection of one corpus, faithful to the Neo4j graph.
// One note per node, one folder per label, one `TYPE::` line per relationship in the source note (plus an `in_TYPE::`
// copy in the target note). Reads the graph through READ sessions only and never touches the corpus; it writes only
// under the output folder, and there only files its own manifest says it wrote (hand edits are kept unless --force).
// Same graph in, same bytes out: sorted everywhere, no timestamps in notes (generation time is only in the manifest).
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync, readdirSync, rmdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import neo4j from 'neo4j-driver';
import YAML from 'yaml';
import { inferStatus } from './infer/index.js';
import { lintCorpus } from './lint.js';
import { loadCorpus } from './scan.js';

export const MANIFEST = '_breakwall-manifest.json';
export const LABELS = ['Corpus', 'Document', 'Section', 'WorkItem', 'MissingTarget', 'Entity', 'Community'];
const INFERRED_LABELS = ['Entity', 'Community'];
export const GRAPH_HEADING = 'BreakWall graph (parsed from the files)';
export const INFERRED_HEADING = 'BreakWall (inferred, local, hints not facts)';
/** Ends the verbatim section text in a Section note (an Obsidian comment, hidden in reading view). */
export const TEXT_END = '%% breakwall: end of section text %%';

export class VaultError extends Error {}

const sha = (t) => createHash('sha256').update(t).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function rows(db, query, params = {}) {
  const s = db.session();
  try {
    return (await s.run(query, params)).records.map((r) => r.toObject());
  } finally {
    await s.close();
  }
}

// ---------------------------------------------------------------- output folder safety

const canon = (p) => {
  let r = resolve(p);
  try {
    r = realpathSync.native(r);
  } catch {
    // not there yet: the resolved path is what will be created
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const within = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Refuse an output folder inside the corpus root, or one that contains it. Checked before any write. */
export function checkOutDir(out, root) {
  if (!root) return;
  const o = canon(out);
  const r = canon(root);
  if (within(o, r)) throw new VaultError(`refusing to write the vault to ${resolve(out)}: it is inside the corpus root ${root}. Pass --out with a folder outside it.`);
  if (within(r, o)) throw new VaultError(`refusing to write the vault to ${resolve(out)}: it contains the corpus root ${root}. Pass --out with a folder outside it.`);
  if (existsSync(out) && !statSync(out).isDirectory()) throw new VaultError(`${resolve(out)} exists and is not a folder`);
}

// ---------------------------------------------------------------- reading the graph

/** Everything the vault shows, read from Neo4j in a few queries. Tombstoned nodes and Chunk nodes are not notes. */
export async function readVaultGraph(db, corpus, { inferred = true } = {}) {
  const want = inferred ? LABELS : LABELS.filter((l) => !INFERRED_LABELS.includes(l));
  const raw = await rows(
    db,
    `MATCH (n) WHERE (n.corpus = $c OR (n:Corpus AND n.id = $c)) AND n.deleted IS NULL AND any(l IN labels(n) WHERE l IN $want)
     RETURN labels(n) AS labels, properties(n) AS p`,
    { c: corpus, want },
  );
  const nodes = raw.map((r) => ({ label: LABELS.find((l) => r.labels.includes(l)), p: r.p })).sort((a, b) => cmp(a.p.id, b.p.id));
  const ids = nodes.map((n) => n.p.id);
  const rels = (
    await rows(
      db,
      `MATCH (a)-[r]->(b) WHERE a.id IN $ids AND b.id IN $ids AND (a.corpus = $c OR a.id = $c) AND ($inf OR coalesce(r.layer, '') <> 'inferred')
       RETURN a.id AS a, type(r) AS type, b.id AS b, properties(r) AS p`,
      { ids, c: corpus, inf: inferred },
    )
  ).sort((x, y) => cmp(x.type, y.type) || cmp(x.a, y.a) || cmp(x.b, y.b) || cmp(JSON.stringify(sortObj(x.p)), JSON.stringify(sortObj(y.p))));
  const chunks = await rows(
    db,
    `MATCH (s:Section {corpus: $c})-[:HAS_CHUNK]->(k:Chunk) WHERE s.deleted IS NULL
     RETURN s.id AS section, k.id AS id, k.embedModel AS model, k.embedding IS NOT NULL AS embedded ORDER BY k.id`,
    { c: corpus },
  );
  // What the vault leaves out, for _index.md: relationships with one end not exported (tombstones, chunks, a skipped layer).
  const omitted = await rows(
    db,
    `MATCH (a)-[r]->(b) WHERE (a.corpus = $c OR a.id = $c) AND (NOT a.id IN $ids OR NOT b.id IN $ids OR (NOT $inf AND r.layer = 'inferred'))
     RETURN type(r) AS type, count(r) AS n ORDER BY type`,
    { c: corpus, ids, inf: inferred },
  );
  const tomb = (await rows(db, 'MATCH (d:Document {corpus: $c}) WHERE d.deleted = true RETURN count(d) AS n', { c: corpus }))[0].n;
  return { nodes, rels, chunks, omitted, tombstonedDocuments: tomb };
}

const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

// ---------------------------------------------------------------- names

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** A file name Windows, macOS, Linux and Obsidian's wikilinks all accept. */
export function safeName(s, max = 120) {
  let x = String(s ?? '').replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
  if (x.length > max) x = x.slice(0, max).trim();
  x = x.replace(/[. ]+$/, '');
  if (!x) x = '_';
  if (x.startsWith('.')) x = `_${x}`; // Obsidian hides dot files
  return RESERVED.test(x) ? `${x}_` : x;
}
/** Generated prose must not create links the graph does not have: break any `[[` / `]]` in names and headings. */
const plain = (s) => String(s ?? '').replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]');
const display = (s) => String(s ?? '').replace(/[|[\]]/g, '-').replace(/\s+/g, ' ').trim() || '_';
const docBase = (path) => path.replace(/\.md$/i, '').split('/').join(' - ');

function baseName(n) {
  const p = n.p;
  switch (n.label) {
    case 'Corpus': return p.name || p.id;
    case 'Document': return docBase(p.path);
    case 'Section': return `${docBase(p.path)} - ${(p.heading || '(preamble)').slice(0, 80)}`;
    case 'WorkItem': return p.wid;
    case 'MissingTarget': return p.target;
    case 'Entity': return p.name;
    case 'Community': return `Community ${p.id.split(':').pop()} - ${p.label || ''}`;
    default: return p.id;
  }
}

/** id -> { folder, name, link }. Names that collide in a folder (case-insensitively) all get a short id hash. */
export function nameNotes(nodes) {
  const byKey = new Map();
  for (const n of nodes) {
    const key = `${n.label}/${safeName(baseName(n)).toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) || []), n]);
  }
  const out = new Map();
  for (const group of byKey.values()) {
    for (const n of group) {
      const base = safeName(baseName(n));
      const name = group.length > 1 ? `${base} ~${sha(n.p.id).slice(0, 6)}` : base;
      out.set(n.p.id, { folder: n.label, name, link: `${n.label}/${name}`, title: baseName(n) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- rendering

const snake = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const SECTION_FIXED = ['id', 'corpus', 'path', 'headingPath', 'startLine', 'endLine', 'commit', 'hash', 'text'];

/** Frontmatter: the named keys first, then every other property as bw_<snake_case>, sorted. Vectors never. */
function frontmatter(n, extra = {}) {
  const p = n.p;
  const fm = { bw_id: p.id, bw_label: n.label, bw_corpus: p.corpus ?? p.id };
  const skip = new Set(['id', 'corpus', 'embedding', 'text']);
  if (n.label === 'Section') {
    Object.assign(fm, { bw_path: p.path, bw_heading_path: p.headingPath, bw_lines: `${p.startLine}-${p.endLine}`, bw_commit: p.commit ?? null, bw_hash: p.hash });
    for (const k of SECTION_FIXED) skip.add(k);
  }
  Object.assign(fm, extra);
  for (const k of Object.keys(p).sort()) {
    if (skip.has(k)) continue;
    const key = k === 'status' ? 'status' : k === 'run' && INFERRED_LABELS.includes(n.label) ? 'bw_inferred_run' : `bw_${snake(k)}`;
    if (!(key in fm)) fm[key] = p[k];
  }
  return `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n`;
}

const edgeMeta = (p) => [p.layer, p.method, p.score !== undefined && p.score !== null ? `score ${p.score}` : null, p.line !== undefined && p.line !== null ? `line ${p.line}` : null].filter(Boolean).join(', ');
const edgeLine = (field, note, p) => `- [${field}:: [[${note.link}|${display(note.title)}]]] (${edgeMeta(p)})`;

/** Out-lines and in-lines per note, split by layer, each list sorted. */
function edgeLines(rels, names) {
  const by = new Map(); // id -> { det: [], inf: [] }
  const add = (id, layer, sortKey, line) => {
    if (!by.has(id)) by.set(id, { det: [], inf: [] });
    by.get(id)[layer === 'inferred' ? 'inf' : 'det'].push([sortKey, line]);
  };
  for (const r of rels) {
    const a = names.get(r.a);
    const b = names.get(r.b);
    const props = JSON.stringify(sortObj(r.p));
    add(r.a, r.p.layer, `0 ${r.type}\u0000${b.link}\u0000${props}`, edgeLine(r.type, b, r.p));
    add(r.b, r.p.layer, `1 ${r.type}\u0000${a.link}\u0000${props}`, edgeLine(`in_${r.type}`, a, r.p));
  }
  const fin = (xs) => xs.sort((x, y) => cmp(x[0], y[0])).map((x) => x[1]);
  for (const v of by.values()) {
    v.det = fin(v.det);
    v.inf = fin(v.inf);
  }
  return by;
}

function blocks(e) {
  const out = [];
  if (e && e.det.length) out.push(`### ${GRAPH_HEADING}\n\n${e.det.join('\n')}`);
  if (e && e.inf.length) out.push(`### ${INFERRED_HEADING}\n\n${e.inf.join('\n')}`);
  return out.length ? `\n${out.join('\n\n')}\n` : '';
}

/** All notes and generated pages of the vault as { relPath: content }, plus summary counts. Pure. */
export function renderVault(graph, { corpus, inferredNote, lint }) {
  const names = nameNotes(graph.nodes);
  const edges = edgeLines(graph.rels, names);
  const files = new Map();
  const docs = graph.nodes.filter((n) => n.label === 'Document');
  const sectionsOf = new Map();
  for (const n of graph.nodes.filter((x) => x.label === 'Section')) sectionsOf.set(n.p.docId, [...(sectionsOf.get(n.p.docId) || []), n]);
  for (const v of sectionsOf.values()) v.sort((a, b) => a.p.ordinal - b.p.ordinal);
  const chunksOf = new Map();
  for (const k of graph.chunks) chunksOf.set(k.section, [...(chunksOf.get(k.section) || []), k]);
  const docStatus = new Map(docs.map((d) => [d.p.id, d.p.status ?? null]));

  for (const n of graph.nodes) {
    const nm = names.get(n.p.id);
    const p = n.p;
    const e = edges.get(p.id);
    let body;
    if (n.label === 'Section') {
      const ks = chunksOf.get(p.id) || [];
      const fm = frontmatter(n, {
        status: docStatus.get(p.docId) ?? null,
        bw_chunks: ks.map((k) => k.id),
        bw_embed_model: [...new Set(ks.map((k) => k.model).filter(Boolean))].sort(),
        bw_chunks_unembedded: ks.filter((k) => !k.embedded).length,
      });
      body = `${fm}${p.text}\n\n${TEXT_END}\n${blocks(e)}`;
    } else if (n.label === 'Document') {
      const secs = sectionsOf.get(p.id) || [];
      const list = secs.map((s, i) => `${i + 1}. ${plain(s.p.headingPath) || '(preamble)'} (lines ${s.p.startLine}-${s.p.endLine})`).join('\n');
      body = `${frontmatter(n, { status: p.status ?? null, bw_uid: p.uid ?? null, bw_work_item: p.workItem ?? null })}# ${plain(p.title || p.path)}\n\n\`${p.path}\`${p.status ? ` · status ${p.status}` : ''}${p.workItem ? ` · work item ${p.workItem}${p.phase ? ` (${p.phase})` : ''}` : ''}\n\nSections in reading order (the links are in the graph blocks):\n\n${list || '(none)'}\n${blocks(e)}`;
    } else if (n.label === 'Corpus') {
      body = `${frontmatter(n)}# Corpus ${plain(p.name || p.id)}\n\nRoot \`${p.root}\`, indexed at commit ${p.commit || 'none'}. See [[_index]].\n${blocks(e)}`;
    } else if (n.label === 'WorkItem') {
      body = `${frontmatter(n)}# Work item ${plain(p.wid)}\n${blocks(e)}`;
    } else if (n.label === 'MissingTarget') {
      body = `${frontmatter(n)}# Missing: ${plain(p.target)}\n\nLinked from the corpus, but no such file or heading exists (a dangling link; see [[_lint]]).\n${blocks(e)}`;
    } else if (n.label === 'Entity') {
      body = `${frontmatter(n)}# ${plain(p.name)}\n\nEntity (${p.type || 'unknown type'}), extracted locally by BreakWall: a hint, not a fact.\n${blocks(e)}`;
    } else {
      body = `${frontmatter(n)}# ${plain(nm.title)}\n\nCommunity of ${p.size ?? '?'} sections (Louvain), computed locally by BreakWall: a hint, not a fact.\n${blocks(e)}`;
    }
    files.set(`${nm.link}.md`, body);
  }

  // Counts for _index.md and for the caller.
  const notes = Object.fromEntries(LABELS.map((l) => [l, graph.nodes.filter((n) => n.label === l).length]).filter(([, v]) => v));
  const relCounts = {};
  for (const r of graph.rels) {
    const k = `${r.type}|${r.p.layer || '-'}`;
    relCounts[k] = (relCounts[k] || 0) + 1;
  }
  const corpusNode = graph.nodes.find((n) => n.label === 'Corpus');
  const dirs = new Map();
  for (const d of docs) {
    const dir = d.p.path.includes('/') ? d.p.path.slice(0, d.p.path.lastIndexOf('/')) : '.';
    dirs.set(dir, [...(dirs.get(dir) || []), d]);
  }
  const idx = [
    `# ${corpus} (BreakWall vault)`,
    '',
    'Generated by `breakwall vault` from the BreakWall Neo4j graph. One-way: edit the source markdown files, then sync and re-export; edits made here are never read back.',
    '',
    `- Corpus: ${corpusNode ? `[[${names.get(corpusNode.p.id).link}|${corpus}]]` : corpus}, root \`${corpusNode?.p.root ?? '?'}\`, commit ${corpusNode?.p.commit || 'none'}`,
    `- Inferred layer: ${inferredNote}`,
    '- Layout: one note per graph node, one folder per label, one `TYPE::` line per relationship in the source note and an `in_TYPE::` copy in the target note.',
    '',
    '## Notes per label',
    '',
    '| Label | Notes |',
    '|---|---|',
    ...Object.entries(notes).map(([l, v]) => `| ${l} | ${v} |`),
    '',
    '## Relationships per type',
    '',
    '| Type | Layer | Count |',
    '|---|---|---|',
    ...Object.keys(relCounts).sort().map((k) => `| ${k.split('|')[0]} | ${k.split('|')[1]} | ${relCounts[k]} |`),
    '',
    '## Not exported',
    '',
    `- Chunk (${graph.chunks.length}): the embedding unit, not a unit of meaning. Each Section note lists its chunk ids (\`bw_chunks\`) and embed model instead; this is the one deliberate departure from one note per node. HAS_CHUNK edges are therefore not links.`,
    '- Vectors: never written.',
    `- Tombstoned documents: ${graph.tombstonedDocuments} (with their sections).`,
    `- Relationships with an end that is not exported: ${graph.omitted.map((o) => `${o.type} ${o.n}`).join(', ') || 'none'}.`,
    '',
    '## Documents',
    '',
    ...[...dirs.keys()].sort().flatMap((dir) => [`### ${dir}`, '', ...dirs.get(dir).sort((a, b) => cmp(a.p.path, b.p.path)).map((d) => `- [[${names.get(d.p.id).link}|${display(d.p.path)}]]${d.p.status ? ` (${d.p.status})` : ''}`), '']),
  ];
  files.set('_index.md', idx.join('\n'));

  const docLink = (path) => {
    const d = docs.find((x) => x.p.path === path);
    return d ? `[[${names.get(d.p.id).link}|${display(path)}]]` : `\`${path}\``;
  };
  const lintLines = ['# Lint', ''];
  if (lint.error) lintLines.push(`Not available: ${lint.error}`);
  else {
    lintLines.push(`From \`breakwall lint\` over the files on disk (they may be newer than the index). ${lint.findings.length} findings.`, '');
    const rules = [...new Set(lint.findings.map((f) => f.rule))];
    for (const rule of rules) {
      const fs = lint.findings.filter((f) => f.rule === rule);
      lintLines.push(`## ${rule} (${fs.length})`, '', ...fs.map((f) => `- ${docLink(f.path)}:${f.line} ${plain(f.message)}`), '');
    }
  }
  files.set('_lint.md', lintLines.join('\n'));
  for (const [k, v] of files) if (!v.endsWith('\n')) files.set(k, v + '\n');
  return { files, notes, relCounts };
}

/** Obsidian graph-view colour groups per folder: deterministic labels in blues and greys, inferred ones warm. */
const GRAPH_JSON = {
  // Wikilinks inside verbatim section text are kept as written; hiding unresolved ones keeps the graph view to Neo4j's shape.
  hideUnresolved: true,
  colorGroups: [
    ['Corpus', 0x1f2937], ['Document', 0x2563eb], ['Section', 0x60a5fa], ['WorkItem', 0x0d9488], ['MissingTarget', 0xdc2626], ['Entity', 0xf59e0b], ['Community', 0xa855f7],
  ].map(([l, rgb]) => ({ query: `path:${l}/`, color: { a: 1, rgb } })),
};

// ---------------------------------------------------------------- writing

function readManifest(out) {
  const f = join(out, MANIFEST);
  if (!existsSync(f)) return null;
  try {
    const m = JSON.parse(readFileSync(f, 'utf8'));
    if (!m || typeof m.files !== 'object') throw new Error('no files map');
    return m;
  } catch (e) {
    throw new VaultError(`${f} is unreadable (${e.message}); move it away to start over`);
  }
}

/**
 * Export one corpus. Returns a summary. The graph is read through READ sessions; the only writes are under `out`:
 * files whose content changed, deletions of files the previous manifest named and no longer produced, the manifest,
 * and `.obsidian/graph.json` when `.obsidian/` does not exist yet. Hand-edited files are listed, not overwritten,
 * unless `force`.
 */
export async function exportVault(driver, corpus, { out, inferred = true, force = false, now = () => new Date().toISOString() } = {}) {
  const t0 = Date.now();
  const db = { session: () => driver.session({ defaultAccessMode: neo4j.session.READ }) };
  const c = (await rows(db, 'MATCH (c:Corpus {id: $c}) RETURN c.root AS root', { c: corpus }))[0];
  if (!c) throw new VaultError(`unknown corpus "${corpus}"`);
  checkOutDir(out, c.root);

  let include = false;
  let inferredNote;
  if (!inferred) inferredNote = 'omitted on request (--no-inferred)';
  else {
    const st = await inferStatus(db, corpus);
    if (!st.present) inferredNote = 'omitted: not built for this corpus (run `breakwall infer`)';
    else if (!st.fresh) inferredNote = `omitted: stale (run ${st.run} was built before the corpus last changed; run \`breakwall infer\` or \`sync --infer\`)`;
    else {
      include = true;
      inferredNote = `included, run ${st.run} (fresh). Its links sit under "${INFERRED_HEADING}"; Entity and Community notes exist only because of it.`;
    }
  }
  const graph = await readVaultGraph(db, corpus, { inferred: include });
  let lint;
  try {
    if (!c.root || !existsSync(c.root)) throw new Error(`corpus root ${c.root || '(unknown)'} is not on this machine`);
    lint = { findings: lintCorpus(loadCorpus(c.root, corpus, { git: false })) };
  } catch (e) {
    lint = { error: e.message };
  }
  const { files, notes, relCounts } = renderVault(graph, { corpus, inferredNote, lint });

  const prev = readManifest(out);
  const prevFiles = prev ? prev.files : {};
  mkdirSync(out, { recursive: true });
  const manifest = {};
  const res = { corpus, out: resolve(out), inferred: { included: include, note: inferredNote }, notes, relationships: relCounts, files: files.size, written: 0, unchanged: 0, deleted: 0, protected: [], graphJson: false };
  for (const rel of [...files.keys()].sort()) {
    const content = files.get(rel);
    const h = sha(content);
    const abs = join(out, rel);
    if (existsSync(abs)) {
      const disk = sha(readFileSync(abs));
      if (disk === h) {
        manifest[rel] = h;
        res.unchanged++;
        continue;
      }
      if (prevFiles[rel] !== disk && !force) {
        res.protected.push({ path: rel, reason: prevFiles[rel] ? 'edited since the last export' : 'not written by breakwall vault' });
        if (prevFiles[rel]) manifest[rel] = prevFiles[rel]; // still ours, still edited: protect it next time too
        continue;
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    manifest[rel] = h;
    res.written++;
  }
  const emptied = new Set();
  for (const rel of Object.keys(prevFiles).sort()) {
    if (files.has(rel)) continue;
    const abs = join(out, rel);
    if (!existsSync(abs)) continue;
    if (sha(readFileSync(abs)) !== prevFiles[rel] && !force) {
      res.protected.push({ path: rel, reason: 'no longer produced, but edited since the last export; left in place' });
      manifest[rel] = prevFiles[rel];
      continue;
    }
    unlinkSync(abs);
    emptied.add(dirname(abs));
    res.deleted++;
  }
  for (const d of [...emptied].sort().reverse()) {
    try {
      if (within(canon(d), canon(out)) && canon(d) !== canon(out) && !readdirSync(d).length) rmdirSync(d);
    } catch {
      // not empty or already gone
    }
  }
  if (!existsSync(join(out, '.obsidian'))) {
    mkdirSync(join(out, '.obsidian'));
    writeFileSync(join(out, '.obsidian', 'graph.json'), JSON.stringify(GRAPH_JSON, null, 2) + '\n');
    res.graphJson = true;
  }
  writeFileSync(join(out, MANIFEST), JSON.stringify({ tool: 'breakwall vault', corpus, generatedAt: now(), files: Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]])) }, null, 2) + '\n');
  res.ms = Date.now() - t0;
  return res;
}

export function formatVault(r) {
  const lines = [`vault for ${r.corpus} at ${r.out}: ${r.files} files (${r.written} written, ${r.unchanged} unchanged, ${r.deleted} deleted) in ${r.ms} ms`];
  lines.push(`  notes: ${Object.entries(r.notes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  lines.push(`  inferred layer: ${r.inferred.note}`);
  if (r.graphJson) lines.push('  wrote .obsidian/graph.json (colour groups per folder); it is never overwritten');
  if (r.protected.length) {
    lines.push(`  NOT overwritten (${r.protected.length}; rerun with --force to replace them):`);
    for (const p of r.protected) lines.push(`    ${p.path}  (${p.reason})`);
  }
  return lines.join('\n');
}

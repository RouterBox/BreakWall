// Plan item 58: `breakwall vault`, the one-way Obsidian export. Pure naming and safety tests first, then DB tests on a
// throwaway test-* corpus (stub embedder), then a read-only faithfulness check of the live undertow-fixture index when it
// is there. Every DB test is skipped loudly when breakwall-neo4j is not reachable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import YAML from 'yaml';
import { loadCorpus } from '../src/scan.js';
import { connect, indexCorpus, wipe } from '../src/graph.js';
import { DIMS } from '../src/embed.js';
import { inferCorpus } from '../src/infer/index.js';
import { exportVault, checkOutDir, nameNotes, safeName, MANIFEST, TEXT_END, INFERRED_HEADING, VaultError } from '../src/vault.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'breakwall.js');
const sample = fileURLToPath(new URL('./data/sample-corpus', import.meta.url));
const NAME = `test-vault-${process.pid}`;
const tmpDirs = [];
const mk = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

// ---------- pure ----------

test('vault names: safe on every OS, unique per folder, colliding names get a short id hash', () => {
  assert.equal(safeName('a/b: c?*"<>|#^[x]'), 'a-b- c---------x-');
  assert.equal(safeName('CON'), 'CON_');
  assert.equal(safeName('trailing. '), 'trailing');
  assert.equal(safeName('.md'), '_.md', 'no hidden dot files');
  const nodes = [
    { label: 'Section', p: { id: 'k:a.md#1', path: 'a.md', heading: 'Testing' } },
    { label: 'Section', p: { id: 'k:a.md#5', path: 'a.md', heading: 'testing' } },
    { label: 'Section', p: { id: 'k:a.md#6', path: 'a.md', heading: 'Other' } },
    { label: 'Document', p: { id: 'k:a.md', path: 'a.md' } },
  ];
  const n = nameNotes(nodes);
  assert.equal(n.get('k:a.md#6').link, 'Section/a - Other');
  assert.equal(n.get('k:a.md').link, 'Document/a');
  const a = n.get('k:a.md#1').name;
  const b = n.get('k:a.md#5').name;
  assert.ok(a.startsWith('a - Testing ~') && b.startsWith('a - testing ~') && a.toLowerCase() !== b.toLowerCase());
  assert.deepEqual(nameNotes(nodes), n, 'deterministic');
});

test('vault output: refused inside the corpus root and around it, accepted beside it', () => {
  const base = mk('bw-vault-out-');
  const root = join(base, 'corpus');
  mkdirSync(root);
  assert.throws(() => checkOutDir(join(root, 'vault'), root), (e) => e instanceof VaultError && /inside the corpus root/.test(e.message));
  assert.throws(() => checkOutDir(root, root), /inside the corpus root/);
  assert.throws(() => checkOutDir(base, root), /contains the corpus root/);
  checkOutDir(join(base, 'corpus-vault'), root);
  writeFileSync(join(base, 'file'), 'x');
  assert.throws(() => checkOutDir(join(base, 'file'), root), /not a folder/);
});

// ---------- helpers for the DB tests ----------

let driver;
let skip = false;
before(async () => {
  driver = connect();
  try {
    await driver.getServerInfo();
  } catch (e) {
    skip = `Neo4j not reachable: ${e.message}`;
    console.warn('SKIPPING vault DB tests -', skip);
  }
});
after(async () => {
  if (!skip) await wipe(driver, NAME);
  await driver.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function stubEmbedder() {
  return {
    model: 'stub-model',
    dims: DIMS,
    async embed(texts) {
      return texts.map((t) => {
        const v = Array.from({ length: DIMS }, (_, i) => createHash('sha256').update(`${t}|${i}`).digest().readInt16LE(0) / 32768);
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      });
    },
  };
}
async function q(query, params) {
  const s = driver.session();
  try {
    return (await s.run(query, params)).records.map((r) => r.toObject());
  } finally {
    await s.close();
  }
}
/** Every file under dir, relative with forward slashes -> content. */
function readTree(dir, skipDirs = ['.obsidian']) {
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.includes(e.name)) walk(p);
      } else out.set(relative(dir, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}
const splitNote = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  return { fm: YAML.parse(m[1]), body: m[2] };
};
const LINK = /\[\[([^|\]]+)(?:\|[^\]]*)?\]\]/g;
const OUT_LINE = /^- \[([A-Z_]+):: \[\[([^|\]]+)\|/;
const IN_LINE = /^- \[in_([A-Z_]+):: \[\[([^|\]]+)\|/;

/**
 * The faithfulness check, written independently of the vault code: every live node of an exported label is exactly one
 * note in its label's folder, and every relationship between two exported nodes is exactly one `TYPE::` line in its
 * source note (and one `in_TYPE::` line in its target note). Counted against Neo4j directly.
 */
async function faithfulness(corpus, dir, { inferred }) {
  const labels = ['Corpus', 'Document', 'Section', 'WorkItem', 'MissingTarget', ...(inferred ? ['Entity', 'Community'] : [])];
  const nodes = await q(
    'MATCH (n) WHERE (n.corpus = $c OR (n:Corpus AND n.id = $c)) AND n.deleted IS NULL AND any(l IN labels(n) WHERE l IN $labels) RETURN n.id AS id, [l IN labels(n) WHERE l IN $labels][0] AS label',
    { c: corpus, labels },
  );
  const ids = nodes.map((n) => n.id);
  const rels = await q(
    "MATCH (a)-[r]->(b) WHERE a.id IN $ids AND b.id IN $ids AND (a.corpus = $c OR a.id = $c) AND ($inf OR coalesce(r.layer, '') <> 'inferred') RETURN a.id AS a, type(r) AS t, b.id AS b",
    { ids, c: corpus, inf: inferred },
  );
  const tree = readTree(dir);
  const notes = [...tree.entries()].filter(([p]) => p.includes('/'));
  const idOf = new Map();
  const seen = [];
  for (const [p, text] of notes) {
    const { fm } = splitNote(text);
    assert.equal(p.split('/')[0], fm.bw_label, `${p} sits in its label's folder`);
    idOf.set(p.replace(/\.md$/, ''), fm.bw_id);
    seen.push(`${fm.bw_label} ${fm.bw_id}`);
  }
  assert.deepEqual(seen.sort(), nodes.map((n) => `${n.label} ${n.id}`).sort(), 'one note per node');
  for (const l of new Set(nodes.map((n) => n.label))) assert.ok(existsSync(join(dir, l)), `folder ${l}`);
  const outs = [];
  const ins = [];
  for (const [p, text] of notes) {
    const me = idOf.get(p.replace(/\.md$/, ''));
    for (const line of text.split('\n')) {
      let m = OUT_LINE.exec(line);
      if (m) outs.push(`${me} ${m[1]} ${idOf.get(m[2])}`);
      m = IN_LINE.exec(line);
      if (m) ins.push(`${idOf.get(m[2])} ${m[1]} ${me}`);
    }
  }
  const want = rels.map((r) => `${r.a} ${r.t} ${r.b}`).sort();
  assert.deepEqual(outs.sort(), want, 'one TYPE:: line per relationship');
  assert.deepEqual(ins.sort(), want, 'one in_TYPE:: line per relationship');
  // Every wikilink the vault generates resolves to a note. Verbatim section text and frontmatter values are the corpus'
  // own words and keep any [[...]] they hold (hidden in the graph view by hideUnresolved), so they are not checked here.
  for (const [p, text] of tree) {
    let gen = text.startsWith('---\n') ? splitNote(text).body : text;
    if (p.startsWith('Section/')) gen = gen.slice(gen.indexOf(TEXT_END));
    for (const m of gen.matchAll(LINK)) assert.ok(tree.has(`${m[1]}.md`), `${p}: [[${m[1]}]] resolves`);
  }
  return { nodes: nodes.length, rels: rels.length, labels: Object.fromEntries(labels.map((l) => [l, nodes.filter((n) => n.label === l).length])) };
}
const noVectors = (tree) => {
  for (const [p, text] of tree) {
    assert.ok(!/bw_embedding|^embedding:/m.test(text), `${p} has no embedding key`);
    assert.ok(!/(-?\d\.\d{4,}, ?){16}/.test(text), `${p} has no float array`);
  }
};

// ---------- DB tests ----------

test('db: the vault is faithful to the graph: notes per node, lines per relationship, verbatim sections, links resolve, no vectors', async (t) => {
  if (skip) return t.skip(skip);
  const dir = mk('bw-vault-c-');
  cpSync(sample, dir, { recursive: true });
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: stubEmbedder() });
  await inferCorpus(driver, NAME);
  const out = join(mk('bw-vault-o-'), 'v');
  const r = await exportVault(driver, NAME, { out });
  assert.equal(r.inferred.included, true);
  assert.deepEqual(r.protected, []);
  const f = await faithfulness(NAME, out, { inferred: true });
  for (const l of ['Corpus', 'Document', 'Section', 'WorkItem', 'MissingTarget']) assert.ok(f.labels[l] > 0, `the sample corpus has ${l} nodes`);
  assert.ok(f.labels.Entity + f.labels.Community > 0, 'and some inferred nodes');

  const tree = readTree(out);
  noVectors(tree);
  // Sections round-trip verbatim, against Neo4j and against the file's own lines.
  const secs = await q('MATCH (s:Section {corpus: $c}) WHERE s.deleted IS NULL RETURN s.id AS id, s.text AS text, s.path AS path, s.startLine AS a, s.endLine AS b', { c: NAME });
  const byId = new Map(secs.map((s) => [s.id, s]));
  let n = 0;
  for (const [p, text] of tree) {
    if (!p.startsWith('Section/')) continue;
    const { fm, body } = splitNote(text);
    const verbatim = body.slice(0, body.indexOf(`\n\n${TEXT_END}\n`));
    const s = byId.get(fm.bw_id);
    assert.equal(verbatim, s.text, p);
    assert.equal(verbatim, readFileSync(join(dir, s.path), 'utf8').split(/\r?\n/).slice(s.a - 1, s.b).join('\n'), `${p} matches the file`);
    assert.equal(fm.bw_lines, `${s.a}-${s.b}`);
    for (const k of ['bw_id', 'bw_label', 'bw_corpus', 'bw_path', 'bw_heading_path', 'bw_lines', 'bw_commit', 'bw_hash', 'status', 'bw_chunks', 'bw_embed_model']) assert.ok(k in fm, `${p} has ${k}`);
    n++;
  }
  assert.equal(n, secs.length);
  const chunks = (await q('MATCH (k:Chunk {corpus: $c}) RETURN count(k) AS n', { c: NAME }))[0].n;
  assert.equal([...tree].filter(([p]) => p.startsWith('Section/')).reduce((a, [, t]) => a + splitNote(t).fm.bw_chunks.length, 0), chunks, 'every chunk is listed on its section');
  // Inferred links sit under the fixed heading only.
  const anySection = [...tree].find(([p, t]) => p.startsWith('Section/') && t.includes('IN_COMMUNITY::'))[1];
  assert.ok(anySection.indexOf(`### ${INFERRED_HEADING}`) < anySection.indexOf('IN_COMMUNITY::'));
  assert.ok(tree.get('_index.md').includes('Chunk (') && tree.get('_lint.md').includes('dangling-link'));
  assert.equal(JSON.parse(readFileSync(join(out, '.obsidian', 'graph.json'), 'utf8')).colorGroups.length, 7);
});

test('db: deterministic: two exports are byte-identical, a rerun writes nothing, a deleted vault comes back the same', async (t) => {
  if (skip) return t.skip(skip);
  const a = join(mk('bw-vault-d-'), 'v');
  const b = join(mk('bw-vault-d-'), 'v');
  await exportVault(driver, NAME, { out: a });
  await exportVault(driver, NAME, { out: b });
  const ta = readTree(a);
  const tb = readTree(b);
  ta.delete(MANIFEST);
  tb.delete(MANIFEST);
  assert.deepEqual(tb, ta);
  const again = await exportVault(driver, NAME, { out: a });
  assert.deepEqual([again.written, again.deleted, again.unchanged], [0, 0, again.files]);
  assert.deepEqual(JSON.parse(readFileSync(join(a, MANIFEST), 'utf8')).files, JSON.parse(readFileSync(join(b, MANIFEST), 'utf8')).files);
  rmSync(a, { recursive: true });
  await exportVault(driver, NAME, { out: a });
  const tc = readTree(a);
  tc.delete(MANIFEST);
  assert.deepEqual(tc, tb);
});

test('db: hand edits are protected without --force; the manifest scopes deletes; a stale layer is omitted, never exported as current', async (t) => {
  if (skip) return t.skip(skip);
  const out = join(mk('bw-vault-e-'), 'v');
  await exportVault(driver, NAME, { out });
  const tree = readTree(out);
  const entityNote = [...tree.keys()].find((p) => p.startsWith('Entity/') || p.startsWith('Community/'));
  assert.ok(entityNote, 'the export has inferred notes');
  const docNote = 'Document/docs - notes.md';
  assert.ok(tree.has(docNote));
  writeFileSync(join(out, docNote), tree.get(docNote) + '\nmy own note in Obsidian\n');
  mkdirSync(join(out, 'Entity'), { recursive: true });
  writeFileSync(join(out, 'Entity', 'my hand-made note.md'), 'mine\n');
  writeFileSync(join(out, 'Scratch.md'), 'mine too\n');

  // The corpus changes: the inferred layer goes stale, so Entity/ and Community/ notes are dropped (manifest-scoped).
  const root = (await q('MATCH (c:Corpus {id: $c}) RETURN c.root AS root', { c: NAME }))[0].root;
  writeFileSync(join(root, 'docs', 'auth-v1.md'), readFileSync(join(root, 'docs', 'auth-v1.md'), 'utf8') + '\nAn appended line.\n');
  await indexCorpus(driver, loadCorpus(root, NAME), { embedder: stubEmbedder() });
  const r = await exportVault(driver, NAME, { out });
  assert.equal(r.inferred.included, false);
  assert.match(r.inferred.note, /stale/);
  assert.deepEqual(r.protected.map((p) => p.path), [docNote]);
  assert.match(readFileSync(join(out, docNote), 'utf8'), /my own note in Obsidian/, 'hand edit kept');
  assert.ok(!existsSync(join(out, entityNote)), 'inferred notes from the previous export are gone');
  assert.ok(existsSync(join(out, 'Entity', 'my hand-made note.md')) && existsSync(join(out, 'Scratch.md')), 'files the manifest never named are untouched');
  assert.ok(!existsSync(join(out, 'Community')), 'an emptied folder of ours is removed');
  assert.ok(!readTree(out).get('_index.md').includes('[[Entity/'));
  unlinkSync(join(out, 'Entity', 'my hand-made note.md'));
  unlinkSync(join(out, 'Scratch.md'));
  await faithfulness(NAME, out, { inferred: false });

  const forced = await exportVault(driver, NAME, { out, force: true });
  assert.deepEqual(forced.protected, []);
  assert.doesNotMatch(readFileSync(join(out, docNote), 'utf8'), /my own note in Obsidian/);
  const graphJson = join(out, '.obsidian', 'graph.json');
  writeFileSync(graphJson, '{"mine": true}\n');
  await exportVault(driver, NAME, { out, force: true });
  assert.equal(readFileSync(graphJson, 'utf8'), '{"mine": true}\n', 'the Obsidian settings are never overwritten');
});

test('db: tombstoned documents are not exported, nor edges to them; --no-inferred omits the layer on purpose', async (t) => {
  if (skip) return t.skip(skip);
  const root = (await q('MATCH (c:Corpus {id: $c}) RETURN c.root AS root', { c: NAME }))[0].root;
  unlinkSync(join(root, 'docs', 'auth-v1.md'));
  const st = await indexCorpus(driver, loadCorpus(root, NAME), { embedder: stubEmbedder() });
  assert.deepEqual(st.changes.tombstoned, ['docs/auth-v1.md']);
  await inferCorpus(driver, NAME);
  const sup = await q('MATCH (a:Document {corpus: $c})-[:SUPERSEDES]->(b:Document {deleted: true}) RETURN count(*) AS n', { c: NAME });
  assert.equal(sup[0].n, 1, 'the graph keeps the edge to the tombstone');
  const out = join(mk('bw-vault-t-'), 'v');
  const r = await exportVault(driver, NAME, { out, inferred: false });
  assert.match(r.inferred.note, /--no-inferred/);
  const tree = readTree(out);
  assert.ok(![...tree.keys()].some((p) => p.includes('auth-v1')), 'no note for the tombstone or its sections');
  assert.ok(![...tree.keys()].some((p) => p.startsWith('Entity/') || p.startsWith('Community/')));
  assert.match(tree.get('_index.md'), /Tombstoned documents: 1/);
  assert.match(tree.get('_index.md'), /SUPERSEDES 1/);
  await faithfulness(NAME, out, { inferred: false });
});

test('db: the CLI writes to ./<corpus>-vault by default and refuses a folder inside the corpus root before writing', async (t) => {
  if (skip) return t.skip(skip);
  const cwd = mk('bw-vault-cwd-');
  const ok = spawnSync(process.execPath, [BIN, 'vault', NAME], { cwd, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(cwd, `${NAME}-vault`, '_index.md')));
  const root = (await q('MATCH (c:Corpus {id: $c}) RETURN c.root AS root', { c: NAME }))[0].root;
  const bad = spawnSync(process.execPath, [BIN, 'vault', NAME], { cwd: root, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /inside the corpus root/);
  assert.ok(!existsSync(join(root, `${NAME}-vault`)), 'nothing was written');
});

test('db: faithfulness on the live undertow-fixture index (read-only), when it is indexed', async (t) => {
  if (skip) return t.skip(skip);
  if (!(await q("MATCH (c:Corpus {id: 'undertow-fixture'}) RETURN c.id AS id", {})).length) return t.skip('undertow-fixture is not indexed');
  const out = join(mk('bw-vault-uf-'), 'v');
  const r = await exportVault(driver, 'undertow-fixture', { out });
  const f = await faithfulness('undertow-fixture', out, { inferred: r.inferred.included });
  noVectors(readTree(out));
  assert.ok(f.labels.Section > 300 && f.rels > 500, JSON.stringify(f));
});

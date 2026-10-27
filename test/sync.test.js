// Incremental sync (M3): pure rename matching and lifecycle helpers first, then DB tests against breakwall-neo4j
// (skipped loudly when it is not reachable). All DB tests use a deterministic stub embedder that counts its work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, cpSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { loadCorpus } from '../src/scan.js';
import { connect, indexCorpus, wipe, dumpCorpus, rebuildCheck } from '../src/graph.js';
import { search, getSection } from '../src/search.js';
import { DIMS } from '../src/embed.js';
import { matchRenames, headingSet, jaccard } from '../src/sync.js';
import { lifecycleOf, resolveSupersession, workItemOf, loadConfig } from '../src/lifecycle.js';
import { toolHistory, toolOutline, toolWorkItem } from '../src/tools.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const sample = fileURLToPath(new URL('./data/sample-corpus', import.meta.url));
const NAME = `test-sync-${process.pid}`;
let driver;
let skip = false;
const tmpDirs = [];

before(async () => {
  driver = connect();
  try {
    await driver.getServerInfo();
  } catch (e) {
    skip = `Neo4j not reachable: ${e.message}`;
    console.warn('SKIPPING sync DB tests -', skip);
  }
});
after(async () => {
  if (!skip) await wipe(driver, NAME);
  await driver.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Deterministic fake embedder that counts what it is asked to embed. */
function stubEmbedder() {
  const e = {
    model: 'stub-model',
    dims: DIMS,
    calls: 0,
    async embed(texts) {
      e.calls += texts.length;
      return texts.map((t) => {
        const v = Array.from({ length: DIMS }, (_, i) => createHash('sha256').update(`${t}|${i}`).digest().readInt16LE(0) / 32768);
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      });
    },
  };
  return e;
}

function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'bw-sync-'));
  tmpDirs.push(dir);
  cpSync(sample, dir, { recursive: true });
  return dir;
}
const edit = (dir, rel, fn) => writeFileSync(join(dir, rel), fn(readFileSync(join(dir, rel), 'utf8')));
const move = (dir, from, to) => {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  renameSync(join(dir, from), join(dir, to));
};

async function docNode(path) {
  const s = driver.session();
  try {
    const r = await s.run('MATCH (d:Document {id: $id}) RETURN properties(d) AS p', { id: `${NAME}:${path}` });
    return r.records.length ? r.records[0].get('p') : null;
  } finally {
    await s.close();
  }
}
async function count(q, params = {}) {
  const s = driver.session();
  try {
    return (await s.run(q, { c: NAME, ...params })).records[0].get('n');
  } finally {
    await s.close();
  }
}
const ids = async () => {
  const s = driver.session();
  try {
    const r = await s.run('MATCH (n) WHERE n.corpus = $c OR n.id = $c OPTIONAL MATCH (n)-[r]->() RETURN collect(DISTINCT elementId(n)) AS n, collect(DISTINCT elementId(r)) AS r', { c: NAME });
    return JSON.stringify([r.records[0].get('n').sort(), r.records[0].get('r').sort()]);
  } finally {
    await s.close();
  }
};

// ---------------------------------------------------------------- pure

const secs = (...hs) => hs.map((h) => ({ level: 2, heading: h }));
const doc = (path, hash, ...hs) => ({ path, hash, headings: headingSet(secs(...hs)) });

test('rename matching: identical hash wins, same basename preferred, one-to-one', () => {
  const gone = [doc('old/a.md', 'H1'), doc('old/b.md', 'H1'), doc('old/c.md', 'H2')];
  const fresh = [doc('new/b.md', 'H1'), doc('new/x.md', 'H1'), doc('new/c2.md', 'H2')];
  const r = matchRenames(gone, fresh);
  assert.deepEqual(r.map((x) => [x.from, x.to, x.by]), [['old/b.md', 'new/b.md', 'hash'], ['old/c.md', 'new/c2.md', 'hash'], ['old/a.md', 'new/x.md', 'hash']]);
});

test('rename matching: edited file matches by heading structure, but not below the thresholds', () => {
  const gone = [doc('a.md', 'H1', 'Goals', 'Requirements', 'Scope', 'Risks')];
  assert.deepEqual(matchRenames(gone, [doc('b.md', 'H2', 'Goals', 'Requirements', 'Scope', 'Risks', 'Extra')]).map((x) => [x.from, x.to, x.by]), [['a.md', 'b.md', 'structure']]);
  assert.equal(matchRenames(gone, [doc('b.md', 'H2', 'Goals', 'Other', 'Things', 'Here')]).length, 0, 'similarity 0.14 is below 0.6');
  assert.equal(matchRenames([doc('a.md', 'H1', 'Goals', 'Scope')], [doc('b.md', 'H2', 'Goals', 'Scope')]).length, 0, 'fewer than 3 headings is hash-only');
  assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
  // two candidates for one file: best score wins, the other file stays unmatched
  const two = matchRenames(
    [doc('a1.md', 'X1', 'Goals', 'Requirements', 'Scope', 'Risks'), doc('a2.md', 'X2', 'Goals', 'Requirements', 'Scope', 'Risks', 'Plan')],
    [doc('n.md', 'Y', 'Goals', 'Requirements', 'Scope', 'Risks', 'Plan')],
  );
  assert.deepEqual(two.map((x) => [x.from, x.to]), [['a2.md', 'n.md']]);
});

test('frontmatter status and supersession resolve to newer -> older edges, both directions, dangling reported', () => {
  assert.deepEqual(lifecycleOf({ status: ' current ', supersedes: 'a.md', 'superseded-by': ['b.md', 3], 'work-item': 42 }), { status: 'current', supersedes: ['a.md'], supersededBy: ['b.md', '3'], workItem: '42', phase: null });
  assert.deepEqual(lifecycleOf(null).supersedes, []);
  const docs = [
    { path: 'docs/v1.md', lifecycle: lifecycleOf({ superseded_by: 'v2.md' }) },
    { path: 'docs/v2.md', lifecycle: lifecycleOf({ supersedes: ['v1.md', 'nope.md'] }) },
    { path: 'docs/v3.md', lifecycle: lifecycleOf({ supersedes: '../docs/v2' }) },
  ];
  const r = resolveSupersession(docs, new Set(docs.map((d) => d.path)));
  assert.deepEqual(r.edges.map((e) => `${e.from}>${e.to}`), ['docs/v2.md>docs/v1.md', 'docs/v3.md>docs/v2.md'], 'declared from both ends, deduplicated');
  assert.deepEqual(r.dangling, [{ path: 'docs/v2.md', field: 'supersedes', target: 'nope.md' }]);
});

test('work items: from a config convention or frontmatter only, never required', () => {
  const cfg = loadConfig(sample);
  assert.deepEqual(workItemOf('work/WI-1/design.md', lifecycleOf(null), cfg), { id: 'WI-1', phase: 'design', source: 'config' });
  assert.deepEqual(workItemOf('docs/notes.md', lifecycleOf(null), cfg), null);
  assert.deepEqual(workItemOf('anywhere/x.md', lifecycleOf({ 'work-item': 'ABC', phase: 'spec' }), { workItems: null }), { id: 'ABC', phase: 'spec', source: 'frontmatter' });
  assert.equal(workItemOf('work/WI-1/design.md', lifecycleOf(null), { workItems: null }), null, 'no config, no frontmatter: no work item layer');
  const bad = mkdtempSync(join(tmpdir(), 'bw-cfg-'));
  tmpDirs.push(bad);
  writeFileSync(join(bad, 'breakwall.json'), '{"workItems":{"idFromPath":"^work/[^/]+/"}}');
  assert.throws(() => loadConfig(bad), /capture group/);
  writeFileSync(join(bad, 'breakwall.json'), '{nope');
  assert.throws(() => loadConfig(bad), /not valid JSON/);
});

// ---------------------------------------------------------------- database

test('a sync with no changes writes nothing (not one node or edge touched) and embeds 0', async (t) => {
  if (skip) return t.skip(skip);
  const dir = freshCopy();
  const emb = stubEmbedder();
  const first = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.equal(first.changes.added.length, 9);
  assert.ok(first.embedded > 0 && first.writes > 0);
  // The 2nd run may write once: nothing is dirty, so even that is a bug.
  const calls = emb.calls;
  const dumpBefore = await dumpCorpus(driver, NAME);
  const idsBefore = await ids();
  const again = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.equal(again.writes, 0, 'Neo4j update counters: zero');
  assert.equal(again.embedded, 0);
  assert.equal(emb.calls, calls, 'the embedder was not called');
  assert.equal(again.skipped, again.documents);
  assert.equal(again.changes.unchanged, 9);
  assert.deepEqual([again.changes.added, again.changes.changed, again.changes.renamed, again.changes.tombstoned, again.changes.restored], [[], [], [], [], []]);
  assert.equal(await dumpCorpus(driver, NAME), dumpBefore);
  assert.equal(await ids(), idsBefore, 'same node and relationship element ids: nothing was deleted and recreated');
  await wipe(driver, NAME);
});

test('editing one section re-embeds only that chunk and rewrites only that document', async (t) => {
  if (skip) return t.skip(skip);
  const dir = freshCopy();
  const emb = stubEmbedder();
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  const calls = emb.calls;
  const other = await docNode('docs/notes.md');
  edit(dir, 'work/WI-1/design.md', (s) => s.replace('The raw token never touches disk.', 'The raw token never touches disk or logs.'));
  const r = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.deepEqual(r.changes.changed, ['work/WI-1/design.md']);
  assert.equal(r.embedded, 1, 'exactly the edited section');
  assert.equal(emb.calls, calls + 1);
  assert.equal(r.skipped, 8);
  assert.deepEqual(await docNode('docs/notes.md'), other, 'other documents untouched');
  const hit = await getSection(driver, NAME, 'work/WI-1/design.md', 'Storage');
  assert.match(hit[0].text, /disk or logs/);
  await wipe(driver, NAME);
});

test('a renamed file keeps its identity and history, costs 0 embeds, and is found under the new path', async (t) => {
  if (skip) return t.skip(skip);
  const dir = freshCopy();
  const emb = stubEmbedder();
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  const before = await docNode('work/WI-1/design.md');
  const calls = emb.calls;

  move(dir, 'work/WI-1/design.md', 'work/WI-1/design-login.md');
  const r = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb, now: () => '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(r.changes.renamed.map((x) => [x.from, x.to, x.by]), [['work/WI-1/design.md', 'work/WI-1/design-login.md', 'hash']]);
  assert.deepEqual(r.changes.tombstoned, []);
  assert.deepEqual(r.changes.added, []);
  assert.equal(r.embedded, 0);
  assert.equal(emb.calls, calls);
  assert.equal(await docNode('work/WI-1/design.md'), null, 'no node left at the old path, and no tombstone either');
  const after = await docNode('work/WI-1/design-login.md');
  assert.equal(after.uid, before.uid, 'same identity');
  assert.deepEqual(JSON.parse(after.events), [{ event: 'renamed', from: 'work/WI-1/design.md', to: 'work/WI-1/design-login.md', by: 'hash', at: '2026-01-01T00:00:00.000Z' }]);
  // the document is still in its work item and phase, and links into it resolve
  assert.equal(after.workItem, 'WI-1');
  assert.equal(after.phase, 'design');
  const found = await search(driver, NAME, 'hashed in the sessions table', { mode: 'lexical', embedder: emb });
  assert.equal(found.results[0].path, 'work/WI-1/design-login.md');
  // the spec's link to design.md#storage is now dangling (a real broken link), reported by the graph
  assert.equal(await count("MATCH (:Section {corpus: $c, path: 'work/WI-1/spec.md'})-[r:DANGLING_LINK]->(:MissingTarget) RETURN count(r) AS n"), 1);
  // history finds it by the old path too
  const h = await toolHistory(driver, NAME, { topic: 'work/WI-1/design.md' });
  assert.equal(h.document.path, 'work/WI-1/design-login.md');
  assert.equal(h.matchedBy, 'earlier-path');
  assert.equal(h.lifecycle[0].event, 'renamed');
  await wipe(driver, NAME);
});

test('a renamed and edited file is matched by heading structure and re-embeds only the edit', async (t) => {
  if (skip) return t.skip(skip);
  const dir = freshCopy();
  const emb = stubEmbedder();
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  const uid = (await docNode('work/WI-1/design.md')).uid;
  move(dir, 'work/WI-1/design.md', 'work/WI-1/login-design-v2.md');
  edit(dir, 'work/WI-1/login-design-v2.md', (s) => s.replace('users sign in again.', 'users sign in again with a new code.'));
  const r = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.equal(r.changes.renamed.length, 1);
  assert.equal(r.changes.renamed[0].by, 'structure');
  assert.ok(r.changes.renamed[0].score >= 0.6);
  assert.equal(r.embedded, 1, 'the edited Migration section only (a title edit would change every heading path, which is part of the embed input)');
  assert.equal((await docNode('work/WI-1/login-design-v2.md')).uid, uid);
  await wipe(driver, NAME);
});

test('a deleted file becomes a tombstone: hidden from search and get, visible via history and the flag; restore brings it back', async (t) => {
  if (skip) return t.skip(skip);
  const dir = freshCopy();
  const emb = stubEmbedder();
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  const uid = (await docNode('work/WI-1/retro.md')).uid;
  const q = 'migration plan before the design review';
  assert.equal((await search(driver, NAME, q, { mode: 'lexical', embedder: emb })).results[0].path, 'work/WI-1/retro.md');

  const text = readFileSync(join(dir, 'work/WI-1/retro.md'), 'utf8');
  rmSync(join(dir, 'work/WI-1/retro.md'));
  const T = '2026-02-02T00:00:00.000Z';
  const r = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb, now: () => T });
  assert.deepEqual(r.changes.tombstoned, ['work/WI-1/retro.md']);
  assert.equal(r.embedded, 0);
  const tomb = await docNode('work/WI-1/retro.md');
  assert.equal(tomb.deleted, true, 'kept, not silently dropped');
  assert.equal(tomb.deletedAt, T);
  assert.equal(tomb.uid, uid);
  assert.equal(await count("MATCH (k:Chunk {corpus: $c, path: 'work/WI-1/retro.md'}) RETURN count(k) AS n"), 0, 'no chunks, so rankings only reflect live content');
  assert.equal(await count("MATCH (s:Section {corpus: $c, path: 'work/WI-1/retro.md'}) WHERE s.deleted IS NULL RETURN count(s) AS n"), 0);
  assert.ok((await search(driver, NAME, q, { mode: 'lexical', embedder: emb })).results.every((x) => x.path !== 'work/WI-1/retro.md'), 'excluded from search by default');
  assert.equal((await getSection(driver, NAME, 'work/WI-1/retro.md')).length, 0);
  const withFlag = await getSection(driver, NAME, 'work/WI-1/retro.md', 'What to change', { includeDeleted: true });
  assert.equal(withFlag.length, 1);
  assert.match(withFlag[0].text, /migration plan/, 'the text is still there behind the flag');
  await assert.rejects(toolOutline(driver, NAME, { path: 'work/WI-1/retro.md' }), /deleted/);
  assert.equal((await toolOutline(driver, NAME, { path: 'work/WI-1/retro.md', includeDeleted: true })).deleted, true);
  const h = await toolHistory(driver, NAME, { topic: 'work/WI-1/retro.md' });
  assert.equal(h.document.deleted, true);
  assert.deepEqual(h.lifecycle.map((e) => e.event), ['deleted']);
  const wi = await toolWorkItem(driver, NAME, { id: 'WI-1' });
  assert.ok(!JSON.stringify(wi).includes('retro.md'), 'work item view hides tombstones by default');
  assert.ok(JSON.stringify(await toolWorkItem(driver, NAME, { id: 'WI-1', includeDeleted: true })).includes('retro.md'));

  // the tombstone is stable: syncing again does not touch it
  const same = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.equal(same.writes, 0);
  assert.deepEqual(same.changes.tombstoned, []);

  // restore at the same path
  writeFileSync(join(dir, 'work/WI-1/retro.md'), text);
  const back = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb, now: () => '2026-03-03T00:00:00.000Z' });
  assert.deepEqual(back.changes.restored, ['work/WI-1/retro.md']);
  assert.deepEqual(back.changes.added, []);
  const live = await docNode('work/WI-1/retro.md');
  assert.equal(live.deleted, undefined);
  assert.equal(live.uid, uid, 'same document');
  assert.deepEqual(JSON.parse(live.events).map((e) => e.event), ['deleted', 'restored']);
  assert.equal((await search(driver, NAME, q, { mode: 'lexical', embedder: emb })).results[0].path, 'work/WI-1/retro.md');
  assert.equal((await getSection(driver, NAME, 'work/WI-1/retro.md')).length, 3);
  await wipe(driver, NAME);
});

test('status, supersession and work items land in the graph and in search results', async (t) => {
  if (skip) return t.skip(skip);
  const dir = freshCopy();
  const emb = stubEmbedder();
  const r = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.deepEqual(r.supersessionDangling, []);
  const v1 = await docNode('docs/auth-v1.md');
  assert.equal(v1.status, 'superseded');
  assert.equal(await count("MATCH (:Document {corpus: $c, path: 'docs/auth-v2.md'})-[r:SUPERSEDES]->(:Document {path: 'docs/auth-v1.md'}) WHERE r.layer = 'deterministic' RETURN count(r) AS n"), 1, 'one edge though both files declare it');
  const hit = (await search(driver, NAME, 'bcrypt passwords sessions last 24 hours', { mode: 'lexical', embedder: emb })).results[0];
  assert.equal(hit.path, 'docs/auth-v1.md');
  assert.deepEqual(hit.doc.supersededBy, ['docs/auth-v2.md']);
  assert.equal(hit.doc.status, 'superseded');
  const wi = await toolWorkItem(driver, NAME, { id: 'wi-1' });
  assert.deepEqual(wi.phases.map((p) => [p.phase, p.documents.map((d) => d.citation.path)]), [
    ['spec', ['work/WI-1/spec.md']],
    ['design', ['work/WI-1/design.md']],
    ['test', ['work/WI-1/test-plan.md']],
    ['retro', ['work/WI-1/retro.md']],
  ]);
  const hist = await toolHistory(driver, NAME, { topic: 'Authentication v1' });
  assert.deepEqual(hist.supersessionChainNewestFirst.map((x) => x.path), ['docs/auth-v2.md', 'docs/auth-v1.md']);
  assert.deepEqual(hist.current, ['docs/auth-v2.md']);
  await assert.rejects(toolWorkItem(driver, NAME, { id: 'WI-99' }), /unknown work item/);

  // dropping the config removes the layer without touching documents
  rmSync(join(dir, 'breakwall.json'));
  const noCfg = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.equal(noCfg.skipped, noCfg.documents);
  assert.equal(await count('MATCH (w:WorkItem {corpus: $c}) RETURN count(w) AS n'), 0);
  await assert.rejects(toolWorkItem(driver, NAME, { id: 'WI-1' }), /no work-item layer/);
  await wipe(driver, NAME);
});

test('rebuild check: wipe, reindex, diff is still identical, with renames and tombstones in the index', async (t) => {
  if (skip) return t.skip(skip);
  const dir = freshCopy();
  const emb = stubEmbedder();
  await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  move(dir, 'docs/notes.md', 'docs/clock-notes.md');
  rmSync(join(dir, 'work/WI-2/spec.md'));
  const r = await indexCorpus(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.equal(r.changes.renamed.length, 1);
  assert.equal(r.changes.tombstoned.length, 1);
  const rc = await rebuildCheck(driver, loadCorpus(dir, NAME), { embedder: emb });
  assert.equal(rc.wipedToEmpty, true);
  assert.equal(rc.identical, true);
  assert.ok(rc.nodes > 30);
  await wipe(driver, NAME);
});

test('the rewritten index path is idempotent on the sample corpus: 0 writes on repeat', async (t) => {
  if (skip) return t.skip(skip);
  const fixture = fileURLToPath(new URL('../fixtures/sample-corpus', import.meta.url));
  assert.ok(existsSync(fixture));
  const emb = stubEmbedder();
  await indexCorpus(driver, loadCorpus(fixture, NAME), { embedder: emb });
  const again = await indexCorpus(driver, loadCorpus(fixture, NAME), { embedder: emb });
  assert.equal(again.writes, 0);
  assert.equal(again.embedded, 0);
  await wipe(driver, NAME);
});

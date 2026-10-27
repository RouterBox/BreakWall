// MCP smoke: spawn our own server over stdio, speak hand-written JSON-RPC, close stdin to stop it.
// Needs breakwall-neo4j and the cached local embedding model (the server embeds queries locally).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadCorpus } from '../src/scan.js';
import { connect, indexCorpus, wipe } from '../src/graph.js';
import { readOnly } from '../src/mcp.js';
import { inferCorpus } from '../src/infer/index.js';
import { startServer, jsonOf } from './helpers/mcpclient.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const sample = fileURLToPath(new URL('./data/sample-corpus', import.meta.url));
const NAME = `test-mcp-${process.pid}`;
let driver;
let skip = false;

before(async () => {
  driver = connect();
  try {
    await driver.getServerInfo();
    await indexCorpus(driver, loadCorpus(sample, NAME));
    await inferCorpus(driver, NAME);
  } catch (e) {
    skip = `Neo4j not reachable or embedder unavailable: ${e.message}`;
    console.warn('SKIPPING mcp tests -', skip);
  }
});
after(async () => {
  if (!skip) await wipe(driver, NAME);
  await driver.close();
});

test('the read-only facade cannot write to the graph', async (t) => {
  if (skip) return t.skip(skip);
  const s = readOnly(driver).session();
  try {
    await assert.rejects(s.run('CREATE (n:ShouldNotExist {corpus: $c})', { c: NAME }));
  } finally {
    await s.close();
  }
  const s2 = driver.session();
  const r = await s2.run('MATCH (n:ShouldNotExist) RETURN count(n) AS n');
  await s2.close();
  assert.equal(r.records[0].get('n'), 0);
});

test('MCP server over stdio: initialize, tools/list, every tool once, bad input, clean shutdown, stdout is protocol only', async (t) => {
  if (skip) return t.skip(skip);
  const srv = startServer({ BREAKWALL_CORPUS: NAME });
  try {
    const init = await srv.initialize();
    assert.equal(init.result.serverInfo.name, 'breakwall');
    assert.ok(init.result.capabilities.tools);

    const list = await srv.request('tools/list', {});
    const names = list.result.tools.map((x) => x.name).sort();
    assert.deepEqual(names, ['breakwall_get', 'breakwall_history', 'breakwall_lint', 'breakwall_neighbors', 'breakwall_outline', 'breakwall_search', 'breakwall_status', 'breakwall_trace', 'breakwall_work_item']);
    assert.ok(names.every((n) => n.startsWith('breakwall_')), 'no collision with undertow_* names');
    for (const tool of list.result.tools) assert.ok(tool.description.length > 40 && tool.inputSchema.type === 'object');

    // search: citation format on every result
    const s = jsonOf(await srv.call('breakwall_search', { query: 'how long until a session token expires', limit: 3 }));
    assert.ok(s.results.length >= 1);
    for (const r of s.results) {
      const c = r.citation;
      assert.ok(c.path && c.headingPath !== undefined && c.startLine <= c.endLine && c.ref === `${c.path}:${c.startLine}-${c.endLine}`);
      assert.equal(c.corpus, NAME);
      assert.ok('commit' in c.provenance && /^[0-9a-f]{64}$/.test(c.provenance.hash) && c.provenance.uid);
      for (const k of ['lexicalRank', 'lexicalScore', 'vectorRank', 'cosine', 'fused']) assert.ok(k in r.scores, k);
    }
    assert.ok(s.results.some((r) => r.citation.path === 'work/WI-1/spec.md' || r.citation.path === 'docs/auth-v2.md'));

    // the superseded document is shown with its supersession, not hidden
    const old = jsonOf(await srv.call('breakwall_search', { query: 'bcrypt passwords sessions last 24 hours', mode: 'lexical', limit: 1 }));
    assert.equal(old.results[0].citation.path, 'docs/auth-v1.md');
    assert.equal(old.results[0].document.superseded, true);
    assert.deepEqual(old.results[0].document.supersededBy, ['docs/auth-v2.md']);

    // the token budget caps text but keeps citations
    const tight = jsonOf(await srv.call('breakwall_search', { query: 'session', limit: 5, max_chars: 200 }));
    assert.ok(tight.results.reduce((n, r) => n + (r.text ? r.text.length : 0), 0) <= 200);
    assert.ok(tight.results.length > 1 && tight.results.every((r) => r.citation.path));

    const get = jsonOf(await srv.call('breakwall_get', { ref: 'work/WI-1/design.md', heading: 'Storage' }));
    assert.match(get.text, /hashed in the sessions table/);
    assert.equal(get.citation.ref, `work/WI-1/design.md:${get.citation.startLine}-${get.citation.endLine}`);

    const outline = jsonOf(await srv.call('breakwall_outline', { path: 'work/WI-1/design.md' }));
    assert.deepEqual(outline.sections.map((x) => x.heading), ['Login design', 'Storage', 'API', 'Risks', 'Migration']);

    const nb = jsonOf(await srv.call('breakwall_neighbors', { ref: 'work/WI-1/design.md', heading: 'Risks' }));
    assert.equal(nb.structure.previous.citation.headingPath, 'Login design > API');
    assert.deepEqual(nb.linksOut.map((l) => l.target.path ?? l.target.citation.path), ['docs/notes.md']);
    const stor = jsonOf(await srv.call('breakwall_neighbors', { ref: 'work/WI-1/design.md', heading: 'Storage' }));
    assert.deepEqual(stor.linksIn.map((l) => l.from.citation.path).sort(), ['docs/auth-v2.md', 'work/WI-1/spec.md']);
    const notes = jsonOf(await srv.call('breakwall_neighbors', { ref: 'docs/notes.md', heading: 'Clock skew' }));
    assert.equal(notes.danglingOut[0].target, 'docs/runbook.md');

    const wi = jsonOf(await srv.call('breakwall_work_item', { id: 'WI-1' }));
    assert.deepEqual(wi.phases.map((p) => p.phase), ['spec', 'design', 'test', 'retro']);
    assert.equal(wi.phases[0].documents[0].status, 'approved');

    const hist = jsonOf(await srv.call('breakwall_history', { topic: 'docs/auth-v1.md' }));
    assert.deepEqual(hist.supersessionChainNewestFirst.map((x) => x.path), ['docs/auth-v2.md', 'docs/auth-v1.md']);
    assert.deepEqual(hist.current, ['docs/auth-v2.md']);

    const lint = jsonOf(await srv.call('breakwall_lint', {}));
    assert.ok(lint.counts['dangling-link'] >= 1);
    assert.ok(lint.findings.some((f) => f.rule === 'dangling-link' && f.path === 'docs/notes.md'));

    const status = jsonOf(await srv.call('breakwall_status', {}));
    const me = status.corpora.find((c) => c.corpus === NAME);
    assert.equal(me.documents, 9);
    assert.equal(me.workItems, 2);

    // M4: signals are opt-in and labelled; status reports the inferred layer; trace labels layers
    const sig = jsonOf(await srv.call('breakwall_search', { query: 'session token expiry', limit: 3, signals: ['entity', 'similar'] }));
    assert.deepEqual(sig.signals.applied, ['similar', 'entity']);
    assert.deepEqual(s.signals.applied, [], 'no signals unless asked for');
    const tr = jsonOf(await srv.call('breakwall_trace', { from: 'work/WI-1/design.md#Risks', to: 'docs/notes.md' }));
    assert.equal(tr.path.found, true);
    assert.ok(tr.path.hops.every((h) => ['deterministic', 'inferred'].includes(h.edge.layer) && h.edge.type && h.explanation));
    assert.equal(tr.path.hops[0].edge.layer, 'deterministic');
    assert.equal(tr.path.hops[0].edge.type, 'LINKS_TO');
    assert.ok(tr.path.hops[0].edge.provenance.line >= 1);
    assert.equal(tr.deterministicOnly.found, true);
    const trBad = await srv.call('breakwall_trace', { from: 'docs/nope.md#x', to: 'docs/notes.md' });
    assert.ok(trBad.result.isError && /no document/.test(trBad.result.content[0].text));
    const trLayers = await srv.call('breakwall_trace', { from: 'docs/notes.md', to: 'docs/notes.md', layers: 'sideways' });
    assert.ok(trLayers.error || trLayers.result.isError);
    assert.equal(me.inferred.present, true);
    assert.equal(me.inferred.fresh, true);

    // errors are tool errors (isError) or protocol validation errors, never a crash; input is validated
    const bad = [
      await srv.call('breakwall_search', { query: '' }),
      await srv.call('breakwall_search', { query: 'x', limit: 0 }),
      await srv.call('breakwall_search', { query: 'x', mode: 'fuzzy' }),
      await srv.call('breakwall_get', {}),
      await srv.call('breakwall_search', { query: 'x', corpus: 'no-such-corpus' }),
      await srv.call('breakwall_work_item', { id: 'WI-404' }),
      await srv.call('breakwall_get', { ref: 'docs/nope.md' }),
      await srv.call('breakwall_outline', { path: 'docs/nope.md' }),
    ];
    for (const r of bad) assert.ok(r.error || r.result.isError, JSON.stringify(r));
    assert.match(bad[4].result.content[0].text, /unknown corpus/);
    assert.match(bad[5].result.content[0].text, /unknown work item/);
    const nope = await srv.request('tools/call', { name: 'breakwall_nope', arguments: {} });
    assert.ok(nope.error || nope.result.isError);

    // the server is still healthy after all of that
    assert.ok(jsonOf(await srv.call('breakwall_status', {})).corpora.length >= 1);

    // stdout carried nothing but JSON-RPC
    for (const line of srv.stdoutLines) assert.equal(JSON.parse(line).jsonrpc, '2.0', line);
  } finally {
    const exit = await srv.shutdown();
    assert.equal(exit.code, 0, `server exit after stdin closed: ${JSON.stringify(exit)}\n${srv.stderr()}`);
  }
});

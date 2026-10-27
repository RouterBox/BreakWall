#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { loadCorpus } from '../src/scan.js';
import { lintCorpus, formatLint } from '../src/lint.js';
import { outlineFile } from '../src/outline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

const USAGE = `usage:
  breakwall sync <dir> [--name <corpus>] [--json]  incremental: add/change/rename/tombstone/restore by content hash, embed only new chunks
  breakwall index <dir> ...                        same as sync
  breakwall search <query> [--corpus <c>] [--mode hybrid|lexical|vector] [--limit 5] [--signals similar,entity,community|all|none] [--json]
                                                   no --mode: env BREAKWALL_SEARCH_MODE, else breakwall.json search.mode, else hybrid (lexical if vectors are off)
  breakwall get <path|section-id> [heading] [--corpus <c>] [--include-deleted] [--json]   exact section text with citation
  breakwall neighbors <path|section-id> [heading] [--corpus <c>] [--include-deleted]   links in/out, parent, children, prev/next (JSON)
  breakwall work-item <id> [--corpus <c>] [--include-deleted]       documents of a work item grouped by phase (JSON)
  breakwall history <path|uid|title> [--corpus <c>]                 renames/deletions + supersession chain, newest first (JSON)
  breakwall status                                                  what is indexed, and whether the inferred layer is fresh (JSON)
  breakwall infer [--corpus <c>] [--passes similar,entities,communities] [--force]   (re)compute the inferred layer, local only, no embedder
  breakwall entities [<text>] [--corpus <c>] [--type t] [--aliases] [--limit 50]     entity table with its alias table (inferred)
  breakwall communities [--corpus <c>] [--members]                  Louvain communities (inferred)
  breakwall trace <from> <to> [--corpus <c>] [--layers both|deterministic|inferred] [--max-hops 6]   explanation path; from/to = section id, path#heading, document path, or entity name
  breakwall cite <path|section-id> [heading] [--corpus <c>] [--json]   citation string for a section: bw:<corpus>:<path>#<heading>@<commit>
  breakwall cite --check "<bw:...>" [--json]                        is a citation still good? ok / changed / heading-missing / deleted / unknown
  breakwall stale [--corpus <c>] [--days 90] [--recent-days 14] [--json]   staleness report (source changed since index, superseded, untouched but linked, lint claims); read-only
  breakwall hook-test [--corpus <c>] [--prompt <on-topic prompt>]   run the ambient hook script against sample input: shape, latency, silence on failure
  breakwall vault <corpus> [--out <dir>] [--no-inferred] [--force] [--json]   one-way Obsidian vault of the graph (default ./<corpus>-vault); never inside the corpus root
  breakwall outline <file.md>                      heading tree of one document
  breakwall lint <dir> [--strict]                  dangling links, orphans, duplicate headings, count mismatches
  breakwall eval <dir> [--name <corpus>] [--write eval/results-m2.md]   score lexical / vector / hybrid
  breakwall eval <dir> --inferred [--name <corpus>] [--write eval/results-m4.md]   score the inferred signals against the hybrid baseline
  breakwall rebuild-check <dir> [--name <corpus>] [--inferred]   wipe, reindex, diff (plan section 11); --inferred also rebuilds and diffs the inferred layer
  sync/index accept --infer to refresh the inferred layer afterwards`;

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  if (i === -1) return null;
  return args.splice(i, 2)[1];
};
const bool = (n) => {
  const i = args.indexOf(n);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};

const name = flag('--name');
const corpusFlag = flag('--corpus');
const promptFlag = flag('--prompt'); // hook-test only
const mode = flag('--mode'); // null: the configured default (plan item 57, switch A)
const limit = Number(flag('--limit') || 5);
const writeTo = flag('--write');
const strict = bool('--strict');
const passesFlag = flag('--passes');
const signalsFlag = flag('--signals');
const layersFlag = flag('--layers') || 'both';
const maxHops = Number(flag('--max-hops') || 6);
const typeFlag = flag('--type');
const force = bool('--force');
const outFlag = flag('--out');
const noInferred = bool('--no-inferred');
const withInfer = bool('--infer');
const inferredFlag = bool('--inferred');
const aliases = bool('--aliases');
const check = bool('--check');
const daysFlag = flag('--days');
const recentFlag = flag('--recent-days');
const members = bool('--members');
const asJson = bool('--json');
const includeDeleted = bool('--include-deleted');
const [cmd, target, ...rest] = args;

function parseSignals(text, dflt) {
  if (text === null || text === undefined) return dflt;
  const all = ['similar', 'entity', 'community'];
  const want = text === 'all' ? all : text === 'none' ? [] : text.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = want.find((x) => !all.includes(x));
  if (bad) throw new Error(`unknown signal "${bad}"; signals: ${all.join(', ')}, all, none`);
  return Object.fromEntries(all.map((k) => [k, want.includes(k)]));
}

async function withDriver(fn) {
  const { connect } = await import('../src/graph.js');
  const driver = connect();
  try {
    return await fn(driver);
  } finally {
    await driver.close();
  }
}

/** --corpus, or the only corpus in the database. */
async function pickCorpus(driver) {
  if (corpusFlag) return corpusFlag;
  const s = driver.session();
  try {
    const r = await s.run('MATCH (c:Corpus) RETURN c.id AS id ORDER BY id');
    const ids = r.records.map((x) => x.get('id'));
    if (ids.length === 1) return ids[0];
    throw new Error(ids.length ? `several corpora indexed (${ids.join(', ')}); pass --corpus` : 'nothing indexed; run `breakwall index <dir>` first');
  } finally {
    await s.close();
  }
}

function formatSync(name, st) {
  const c = st.changes;
  const lines = [`corpus ${name}: ${st.documents} documents, ${st.sections} sections, ${st.chunks} chunks`];
  const list = (label, xs) => xs.length && lines.push(`  ${label} (${xs.length}): ${xs.join(', ')}`);
  list('added', c.added);
  list('changed', c.changed);
  list('renamed', c.renamed.map((r) => `${r.from} -> ${r.to} [by ${r.by}]`));
  list('tombstoned', c.tombstoned);
  list('restored', c.restored);
  list('supersession target missing', st.supersessionDangling.map((d) => `${d.path} ${d.field}: ${d.target}`));
  lines.push(`  unchanged: ${c.unchanged}`);
  return lines.join('\n');
}

async function main() {
  if (!cmd || (!target && !['status', 'infer', 'entities', 'communities', 'stale', 'hook-test'].includes(cmd))) {
    console.log(USAGE);
    process.exit(cmd ? 2 : 0);
  }
  if (cmd === 'outline') return console.log(outlineFile(target));

  if (cmd === 'search') {
    if (mode !== null && !['hybrid', 'lexical', 'vector'].includes(mode)) throw new Error(`unknown --mode ${mode}`);
    const { search, formatResults, DEFAULTS } = await import('../src/search.js');
    const { resolveSwitches } = await import('../src/tools.js');
    return withDriver(async (driver) => {
      const corpus = await pickCorpus(driver);
      const sw = await resolveSwitches(driver, corpus, mode);
      const res = await search(driver, corpus, [target, ...rest].join(' '), { mode: sw.mode.mode, limit, minCosine: DEFAULTS.minCosine, signals: parseSignals(signalsFlag, DEFAULTS.signals), vectors: sw.vectors.on });
      res.modeSource = sw.mode.source;
      if (!asJson) console.error(`mode ${sw.mode.mode} (${sw.mode.source})${sw.vectors.on ? '' : `; vectors off (${sw.vectors.source})`}`);
      console.log(asJson ? JSON.stringify(res, null, 2) : formatResults(res));
    });
  }

  if (cmd === 'get') {
    const { getSection } = await import('../src/search.js');
    return withDriver(async (driver) => {
      const corpus = await pickCorpus(driver);
      const hits = await getSection(driver, corpus, target, rest.join(' ') || null, { includeDeleted });
      if (!hits.length) {
        console.error('not found');
        process.exitCode = 1;
      } else if (hits.length > 1) {
        console.error(`${hits.length} sections match; narrow the heading:`);
        for (const h of hits) console.error(`  ${h.path} [${h.startLine}-${h.endLine}] ${h.headingPath || '(preamble)'}`);
        process.exitCode = 1;
      } else {
        const h = hits[0];
        if (asJson) console.log(JSON.stringify(h, null, 2));
        else console.log(`${h.path} [${h.startLine}-${h.endLine}]  ${h.headingPath || '(preamble)'}  commit ${(h.commit || 'none').slice(0, 8)}  id ${h.id}\n\n${h.text}`);
      }
    });
  }

  if (cmd === 'hook-test') {
    const { runHookTest, LATENCY_BUDGET_MS } = await import('../src/hooktest.js');
    const results = await runHookTest({ corpus: corpusFlag || process.env.BREAKWALL_CORPUS || 'undertow-fixture', prompt: promptFlag || undefined, log: (r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${String(r.ms).padStart(5)} ms  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`) });
    const failed = results.filter((r) => !r.pass);
    console.log(`
${results.length - failed.length}/${results.length} checks passed (latency budget ${LATENCY_BUDGET_MS} ms per run, including node start)`);
    if (failed.length) {
      console.log('failed: ' + failed.map((f) => f.name).join('; '));
      if (failed[0].name.startsWith('injects')) console.log('the first check needs the breakwall-neo4j container up, the corpus indexed (docker start breakwall-neo4j; breakwall sync <dir> --name <corpus>) and an on-topic --prompt for that corpus');
      process.exitCode = 1;
    }
    return;
  }

  if (['cite', 'stale'].includes(cmd)) {
    const tools = await import('../src/tools.js');
    return withDriver(async (driver) => {
      if (cmd === 'stale') {
        const { toolStale, formatStale, STALE_DEFAULTS } = await import('../src/stale.js');
        const corpus = await tools.resolveCorpus(driver, corpusFlag);
        const r = await toolStale(driver, corpus, { days: Number(daysFlag || STALE_DEFAULTS.days), recentDays: Number(recentFlag || STALE_DEFAULTS.recentDays) });
        return console.log(asJson ? JSON.stringify(r, null, 2) : formatStale(r));
      }
      if (check) {
        const r = await tools.toolCiteCheck(driver, [target, ...rest].join(' '));
        console.log(asJson ? JSON.stringify(r, null, 2) : `${r.status}: ${r.note}`);
        if (r.status !== 'ok') process.exitCode = 1;
        return;
      }
      const corpus = await tools.resolveCorpus(driver, corpusFlag);
      const r = await tools.toolCite(driver, corpus, { ref: target, heading: rest.join(' ') || null, includeDeleted });
      console.log(asJson ? JSON.stringify(r, null, 2) : r.citation);
    });
  }

  if (cmd === 'vault') {
    const { exportVault, formatVault } = await import('../src/vault.js');
    const tools = await import('../src/tools.js');
    return withDriver(async (driver) => {
      const corpus = await tools.resolveCorpus(driver, target);
      const r = await exportVault(driver, corpus, { out: outFlag || join(process.cwd(), `${corpus}-vault`), inferred: !noInferred, force });
      console.log(asJson ? JSON.stringify(r, null, 2) : formatVault(r));
      if (r.protected.length) process.exitCode = 1;
    });
  }

  if (['infer', 'entities', 'communities', 'trace'].includes(cmd)) {
    const tools = await import('../src/tools.js');
    const it = await import('../src/infer/tools.js');
    return withDriver(async (driver) => {
      const corpus = await tools.resolveCorpus(driver, corpusFlag);
      if (cmd === 'infer') {
        const { inferCorpus, PASSES } = await import('../src/infer/index.js');
        const { embedStats } = await import('../src/embed.js');
        const passes = passesFlag ? passesFlag.split(',').map((x) => x.trim()).filter(Boolean) : PASSES;
        const res = await inferCorpus(driver, corpus, { passes, force });
        console.log(JSON.stringify({ corpus, ...res, embedderCalls: embedStats.calls, embedderTexts: embedStats.texts, embedderModelLoads: embedStats.loads }, null, 2));
        return;
      }
      if (cmd === 'entities') return console.log(JSON.stringify(await it.toolEntities(driver, corpus, { query: target ? [target, ...rest].join(' ') : null, type: typeFlag, limit, aliases }), null, 2));
      if (cmd === 'communities') return console.log(JSON.stringify(await it.toolCommunities(driver, corpus, { members }), null, 2));
      if (!rest.length) throw new Error('usage: breakwall trace <from> <to>');
      const res = await it.toolTrace(driver, corpus, { from: target, to: rest.join(' '), layers: layersFlag, maxHops });
      console.log(JSON.stringify(res, null, 2));
    });
  }

  if (['neighbors', 'work-item', 'history', 'status'].includes(cmd)) {
    const tools = await import('../src/tools.js');
    return withDriver(async (driver) => {
      const corpus = cmd === 'status' ? null : await tools.resolveCorpus(driver, corpusFlag);
      const rest1 = rest.join(' ') || null;
      const res =
        cmd === 'status' ? await tools.toolStatus(driver)
        : cmd === 'neighbors' ? await tools.toolNeighbors(driver, corpus, { ref: target, heading: rest1, includeDeleted })
        : cmd === 'work-item' ? await tools.toolWorkItem(driver, corpus, { id: [target, ...rest].join(' '), includeDeleted })
        : await tools.toolHistory(driver, corpus, { topic: [target, ...rest].join(' ') });
      console.log(JSON.stringify(res, null, 2));
    });
  }

  const corpus = loadCorpus(target, name);
  if (cmd === 'lint') {
    const findings = lintCorpus(corpus);
    console.log(formatLint(findings, corpus.docs.length));
    if (strict && findings.length) process.exitCode = 1;
    return;
  }
  if (cmd === 'index' || cmd === 'sync' || cmd === 'rebuild-check') {
    const { indexCorpus, rebuildCheck } = await import('../src/graph.js');
    return withDriver(async (driver) => {
      if (cmd !== 'rebuild-check') {
        const stats = await indexCorpus(driver, corpus);
        const inf = await import('../src/infer/index.js');
        let inferred = null;
        if (withInfer) {
          inferred = await inf.inferCorpus(driver, corpus.name);
        } else {
          const st = await inf.inferStatus(driver, corpus.name);
          if (st.present && !st.fresh) console.error('inferred layer is stale (the corpus changed); run `breakwall infer` or sync with --infer');
        }
        if (asJson || cmd === 'index') console.log(JSON.stringify({ corpus: corpus.name, commit: corpus.commit, ...stats, inferred }));
        else console.log(formatSync(corpus.name, stats));
        if (inferred) console.error(`inferred layer: ${inferred.unchanged ? 'unchanged (0 writes)' : `recomputed in ${inferred.ms} ms, ${inferred.writes} writes`}; run ${inferred.run}`);
        if (stats.vectors.on) console.error(`embedded ${stats.embedded} chunks, reused ${stats.reused} unchanged (of ${stats.embedded + stats.reused} distinct embed inputs)${stats.backfilled ? `, gave ${stats.backfilled} unchanged chunks their missing vectors` : ''}; graph writes ${stats.writes}`);
        else console.error(`vectors off (${stats.vectors.source}): nothing embedded, model not loaded; ${stats.unembedded} chunks without a vector; graph writes ${stats.writes}`);
      } else {
        const r = await rebuildCheck(driver, corpus, { inferred: inferredFlag });
        console.log(JSON.stringify(r));
        if (!r.identical) process.exitCode = 1;
      }
    });
  }
  if (cmd === 'eval') {
    // The eval scores all three modes, so it needs vectors (plan item 57); say so instead of indexing lexical-only.
    const { vectorsForRoot } = await import('../src/switches.js');
    const v = vectorsForRoot(corpus.root);
    if (!v.on) throw new Error(`eval needs vectors on (it scores lexical, vector and hybrid), but they are off for ${corpus.name} (${v.source})`);
    if (!existsSync(join(ROOT, 'eval', 'questions.json'))) throw new Error('eval needs eval/questions.json, which is local-only and not in the repo; see eval/README.md for its format');
  }
  if (cmd === 'eval' && inferredFlag) {
    const { indexCorpus } = await import('../src/graph.js');
    const { inferCorpus } = await import('../src/infer/index.js');
    const { runInferredEval, renderM4Tables } = await import('../src/evalinferred.js');
    const { localEmbedder } = await import('../src/embed.js');
    return withDriver(async (driver) => {
      const embedder = localEmbedder();
      const stats = await indexCorpus(driver, corpus, { embedder });
      const inf = await inferCorpus(driver, corpus.name);
      console.error(`index: embedded ${stats.embedded}, reused ${stats.reused}; inferred layer ${inf.unchanged ? 'unchanged' : 'recomputed'} (run ${inf.run})`);
      const r = await runInferredEval({ driver, embedder, corpusName: corpus.name, corpusRoot: corpus.root, questionsFile: join(ROOT, 'eval', 'questions.json') });
      const tables = renderM4Tables(r, { corpusName: corpus.name, commit: corpus.commit });
      if (!writeTo) return console.log(tables);
      const head = "# M4 inferred-layer eval results\n\nGenerated by `node bin/breakwall.js eval fixtures/undertow-corpus --name undertow-fixture --inferred --write eval/results-m4.md`. The tables are regenerated on every run; the section \"Reading the numbers\" at the end is hand-written and is kept (not regenerated) when the file is rewritten.\n\n";
      const MARK = '## Reading the numbers';
      let tail = '';
      if (existsSync(writeTo)) {
        const old = readFileSync(writeTo, 'utf8');
        const i = old.indexOf(MARK);
        if (i !== -1) tail = '\n\n' + old.slice(i);
      }
      writeFileSync(writeTo, head + tables + tail);
      console.error(`wrote ${writeTo}`);
    });
  }
  if (cmd === 'eval') {
    const { indexCorpus } = await import('../src/graph.js');
    const { runEval, renderTables } = await import('../src/evalrun.js');
    const { localEmbedder } = await import('../src/embed.js');
    return withDriver(async (driver) => {
      const embedder = localEmbedder();
      const stats = await indexCorpus(driver, corpus, { embedder });
      console.error(`index: embedded ${stats.embedded}, reused ${stats.reused}`);
      const s = driver.session();
      const corpora = (await s.run('MATCH (c:Corpus) RETURN c.id AS id ORDER BY id')).records.map((x) => x.get('id'));
      await s.close();
      const r = await runEval({ driver, embedder, corpusName: corpus.name, corpusRoot: corpus.root, questionsFile: join(ROOT, 'eval', 'questions.json') });
      const tables = renderTables(r, { corpusName: corpus.name, commit: corpus.commit, chunks: stats.chunks, corpora });
      if (!writeTo) return console.log(tables);
      const head = '# M2 search eval results\n\nGenerated by `node bin/breakwall.js eval fixtures/undertow-corpus --name undertow-fixture --write eval/results-m2.md` (tables) plus the hand-written analysis from `eval/analysis-m2.md`.\n\n';
      const ana = join(ROOT, 'eval', 'analysis-m2.md');
      writeFileSync(writeTo, head + tables + '\n\n' + (existsSync(ana) ? readFileSync(ana, 'utf8') : ''));
      console.error(`wrote ${writeTo}`);
    });
  }
  console.log(USAGE);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

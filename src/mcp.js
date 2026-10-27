// BreakWall MCP server (stdio). Read-only: the graph is opened with READ sessions and no tool touches the corpus.
// Tool names are prefixed breakwall_ so they can never collide with Undertow's undertow_* tools.
// stdout is the protocol channel; nothing else may write to it (the bin redirects console.log to stderr).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { localEmbedder } from './embed.js';
import { DEFAULTS } from './search.js';
import { toolTrace } from './infer/tools.js';
import { ToolError, resolveCorpus, toolSearch, toolGet, toolOutline, toolNeighbors, toolWorkItem, toolHistory, toolLint, toolStatus } from './tools.js';

export const SERVER_NAME = 'breakwall';
export const SERVER_VERSION = '0.4.0';

/** A driver facade whose sessions are READ sessions: the server cannot write to the graph even by mistake. */
export const readOnly = (driver) => ({ session: () => driver.session({ defaultAccessMode: neo4j.session.READ }) });

const CITATION = 'Every result carries a citation: path, heading path, line range, ref ("path:start-end"), corpus, and provenance (git commit, content hash, document uid).';
const corpusArg = z.string().trim().min(1).max(200).optional().describe('Corpus name. Optional when only one corpus is indexed or BREAKWALL_CORPUS is set.');
const includeDeleted = z.boolean().optional().describe('Also show tombstoned (deleted) documents. Off by default.');

export function createServer({ driver, embedder = localEmbedder() }) {
  const db = readOnly(driver);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const wrap = (fn) => async (args) => {
    try {
      const out = await fn(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      let msg;
      if (e instanceof ToolError) msg = e.message;
      else if (e && (e.code === 'ServiceUnavailable' || e.code === 'SessionExpired' || /ECONNREFUSED/.test(String(e.message)))) {
        msg = 'BreakWall\'s Neo4j (container breakwall-neo4j, bolt 127.0.0.1:7688) is not reachable. Start it with `docker start breakwall-neo4j` and try again.';
      } else msg = `breakwall internal error: ${e && e.message ? e.message : e}`;
      return { isError: true, content: [{ type: 'text', text: msg }] };
    }
  };
  const withCorpus = (fn) => wrap(async (a) => fn(await resolveCorpus(db, a.corpus), a));

  server.registerTool(
    'breakwall_search',
    {
      title: 'Search the reference docs',
      description:
        'Search BreakWall, a read-only index over a pile of markdown documentation. Hybrid lexical (BM25) + vector search over document sections; returns the verbatim section text with where it lives. ' +
        'Use for "what do we already know about X, and where is it written". Quote and cite what you use. ' +
        CITATION +
        ' Also: score breakdown (lexical rank/BM25, vector rank/cosine, fused RRF), and document status / supersession (a superseded document is shown, not hidden; check "superseded" before relying on it). ' +
        'lowConfidence=true means the best hit is probably not an answer. Tombstoned documents are never searched.',
      inputSchema: {
        query: z.string().trim().min(1).max(2000).describe('Natural-language question or keywords.'),
        corpus: corpusArg,
        mode: z.enum(['hybrid', 'lexical', 'vector']).optional().describe('Ranking mode. Omit it to use the corpus default (env BREAKWALL_SEARCH_MODE, else the corpus breakwall.json search.mode, else hybrid; lexical when the corpus has vectors switched off). The result says which mode ran and where it came from. hybrid and vector are errors on a corpus with vectors off.'),
        limit: z.number().int().min(1).max(20).default(5).describe('Number of sections to return.'),
        max_chars: z.number().int().min(200).max(50000).default(6000).describe('Budget for returned section text in characters (about 4 per token). Hits past the budget keep their citation but lose their text.'),
        signals: z.array(z.enum(['similar', 'entity', 'community'])).max(3).optional().describe('Optional retrieval signals from the INFERRED layer (similar = neighbour expansion, entity = entity-match boost, community = diversification). Off unless listed here; the M4 eval did not show any of them beating plain hybrid search (eval/results-m4.md). Needs `breakwall infer` to have been run. Results they add or move carry an "inferred" block saying why.'),
      },
    },
    withCorpus((corpus, a) => toolSearch(db, corpus, { query: a.query, mode: a.mode, limit: a.limit, maxChars: a.max_chars, embedder, signals: a.signals ? Object.fromEntries(['similar', 'entity', 'community'].map((k) => [k, a.signals.includes(k)])) : DEFAULTS.signals })),
  );

  server.registerTool(
    'breakwall_get',
    {
      title: 'Get an exact section',
      description: 'Return the exact verbatim text of one section, by section id (from search/outline/neighbors) or by document path plus heading (a full heading path or a unique heading suffix). ' + CITATION,
      inputSchema: {
        ref: z.string().trim().min(1).max(500).describe('Document path (corpus-relative, forward slashes) or a section id.'),
        heading: z.string().trim().min(1).max(500).optional().describe('Heading path or unique heading suffix, when ref is a path.'),
        corpus: corpusArg,
        include_deleted: includeDeleted,
        max_chars: z.number().int().min(200).max(100000).default(12000).describe('Cap on returned text; "truncated" is set if it was cut.'),
      },
    },
    withCorpus((corpus, a) => toolGet(db, corpus, { ref: a.ref, heading: a.heading, includeDeleted: a.include_deleted, maxChars: a.max_chars })),
  );

  server.registerTool(
    'breakwall_outline',
    {
      title: 'Outline of a document',
      description: 'Heading tree of one indexed document with a line-range citation for every section. ' + CITATION,
      inputSchema: {
        path: z.string().trim().min(1).max(500).describe('Corpus-relative document path.'),
        corpus: corpusArg,
        include_deleted: includeDeleted,
      },
    },
    withCorpus((corpus, a) => toolOutline(db, corpus, { path: a.path, includeDeleted: a.include_deleted })),
  );

  server.registerTool(
    'breakwall_neighbors',
    {
      title: 'Neighbours of a section',
      description:
        'What a section is connected to: structure (parent, children, previous, next), links out (resolved to sections or documents), links in (who links to it, and to its whole document), and dangling links. ' +
        'Deterministic edges only (parsed from the files). ' + CITATION,
      inputSchema: {
        ref: z.string().trim().min(1).max(500).describe('Section id, or document path (then pass heading).'),
        heading: z.string().trim().min(1).max(500).optional(),
        corpus: corpusArg,
        include_deleted: includeDeleted,
      },
    },
    withCorpus((corpus, a) => toolNeighbors(db, corpus, { ref: a.ref, heading: a.heading, includeDeleted: a.include_deleted })),
  );

  server.registerTool(
    'breakwall_work_item',
    {
      title: 'Everything for a work item',
      description:
        'All documents of one work item, grouped by phase (spec, design, build, test, retro, decision, ...), with status, supersession and a section list per document. ' +
        'The work-item layer is optional: it exists only if the corpus has a breakwall.json convention or "work-item:" frontmatter; otherwise this returns a clear error. ' + CITATION,
      inputSchema: {
        id: z.string().trim().min(1).max(200).describe('Work item id, for example "WI-1". Case-insensitive if unambiguous.'),
        corpus: corpusArg,
        include_deleted: includeDeleted,
      },
    },
    withCorpus((corpus, a) => toolWorkItem(db, corpus, { id: a.id, includeDeleted: a.include_deleted })),
  );

  server.registerTool(
    'breakwall_history',
    {
      title: 'History of a document or topic',
      description:
        'Lifecycle and supersession for a document: renames, deletions (tombstones) and restores recorded by sync, plus the supersession chain newest first and which documents are current. ' +
        'Content edits are not listed (see provenance.commit and git). Topic is a path, an earlier path, a uid, or a title/path substring; if several documents match, the candidates are listed. ' + CITATION,
      inputSchema: {
        topic: z.string().trim().min(1).max(500).describe('Document path, earlier path, uid, or part of a title.'),
        corpus: corpusArg,
      },
    },
    withCorpus((corpus, a) => toolHistory(db, corpus, { topic: a.topic })),
  );

  server.registerTool(
    'breakwall_trace',
    {
      title: 'Explain how two things are connected',
      description:
        'The cheapest explanation path between two sections, documents or entities, hop by hop. Every hop shows the edge type, its layer, method, score and provenance. ' +
        'Layer "deterministic" edges are parsed from the files (heading tree, reading order, links: authoritative). Layer "inferred" edges are computed locally by BreakWall (entity mentions, embedding similarity): treat them as hints, not facts; they carry method and score. ' +
        'With layers=both the result also includes the deterministic-only path, so you can see what is parsed and what is inferred. Endpoints: a section id, "path#heading" (full heading path or unique suffix), a document path (its title section), an entity name or alias ("entity:Spider" forces entity). ' +
        'Entities and similarity exist only after the inferred layer was built (`breakwall infer`); without it only deterministic edges are available. ' + CITATION,
      inputSchema: {
        from: z.string().trim().min(1).max(500).describe('Start: section id, "path#heading", document path, or entity name.'),
        to: z.string().trim().min(1).max(500).describe('End: same forms as from.'),
        corpus: corpusArg,
        layers: z.enum(['both', 'deterministic', 'inferred']).default('both').describe('Which edge layers the main path may use.'),
        max_hops: z.number().int().min(1).max(12).default(6),
      },
    },
    withCorpus((corpus, a) => toolTrace(db, corpus, { from: a.from, to: a.to, layers: a.layers, maxHops: a.max_hops })),
  );

  server.registerTool(
    'breakwall_lint',
    {
      title: 'Lint the corpus',
      description: 'Health report computed from the markdown files on disk: dangling links, orphan documents, duplicate headings, count mismatches ("8 daemons" above a 9-row table), supersession targets that do not exist. Read-only.',
      inputSchema: {
        corpus: corpusArg,
        rules: z.array(z.enum(['dangling-link', 'orphan', 'duplicate-heading', 'count-mismatch', 'supersession-target'])).max(5).optional().describe('Only these rules.'),
        max_findings: z.number().int().min(1).max(1000).default(200),
      },
    },
    withCorpus((corpus, a) => toolLint(db, corpus, { rules: a.rules, maxFindings: a.max_findings })),
  );

  server.registerTool(
    'breakwall_status',
    {
      title: 'What is indexed',
      description: 'Indexed corpora with document, section and chunk counts, tombstones, embedding model, indexed git commit, work items and supersession counts, whether vectors are on and the default search mode (with where each setting came from, and how many chunks have no embedding), and whether the inferred layer (entities, similarity, communities) is built and fresh or stale. Use it to check BreakWall is up.',
      inputSchema: {},
    },
    wrap(() => toolStatus(db)),
  );

  return server;
}

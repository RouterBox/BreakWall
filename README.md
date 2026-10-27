# BreakWall

A knowledge graph over a pile of markdown. The files are canonical; the Neo4j graph is a derived index you can wipe and rebuild. See `PLAN.md` for the design. Built so far: M0 (fixtures, eval set), M1 (deterministic graph, lint, outline), M2 (BM25 + local vector search fused with RRF; `search`, `get`, `outline`; eval harness) M3 (incremental `sync` with renames and tombstones, status/supersession, optional work items, `neighbors` / `work-item` / `history`, MCP server) and M4 (a labelled inferred layer: similar-to edges, local entity extraction, communities, `trace`) and M5 (an optional read-only ambient hook, `stale`, `cite`, the Undertow bridge), plus two switches (default search mode, vectors on/off per corpus) and `vault`, a one-way Obsidian export of the graph. No LLM and no API calls: the embedding model runs locally and is downloaded once on first use, and the inferred layer makes no embedder call at all.

## Quickstart from zero

Requirements: Node 20+ (developed on 23), Docker, git. The corpus never leaves the machine: the embedding model runs locally and is downloaded once from the model hub on first use (about 90 MB); nothing else makes a network call.

```bash
# 1. install
git clone https://github.com/RouterBox/BreakWall.git && cd BreakWall
npm install

# 2. Neo4j in its own container, loopback only (ports 7475 http / 7688 bolt). Never reuse another project's Neo4j.
docker run -d --name breakwall-neo4j -p 127.0.0.1:7475:7474 -p 127.0.0.1:7688:7687 \
  -v breakwall_neo4j_data:/data -e NEO4J_AUTH=neo4j/<password> neo4j:community
# later, after a reboot or `docker stop`:  docker start breakwall-neo4j

# 3. a git-ignored .env (see below)

# 4. index the bundled sample corpus (8 invented documents about a ferry timetable service; first run downloads the model)
node bin/breakwall.js sync fixtures/sample-corpus --name sample
node bin/breakwall.js infer                    # optional: the inferred layer (local, under a second)

# 5. ask it something
node bin/breakwall.js search "Why are uploaded timetables parsed by background workers?"
node bin/breakwall.js get docs/architecture.md "Request flow"

# 6. check it
node bin/breakwall.js rebuild-check fixtures/sample-corpus --name sample   # wipe, reindex, diff: must say identical
npm test                                       # DB tests are skipped loudly if the container is down

# 7. optional integrations (nothing is registered for you): see "MCP server" and "Ambient hook" below
node scripts/mcp-smoke.js sample "Why are uploaded timetables parsed by background workers?"
node bin/breakwall.js hook-test --corpus sample --prompt "How long are departures cached by harbor-api for each port?"
```

The retrieval eval (`breakwall eval`) needs a question set with gold sections. The one used to build BreakWall was mined from RouterBox's own prompts over a snapshot of Undertow's docs; neither ships here (see `eval/README.md` and `fixtures/README.md`), so bring your own corpus and questions.

The `.env` (never committed):

```
NEO4J_URI=bolt://127.0.0.1:7688
NEO4J_HTTP=http://127.0.0.1:7475
NEO4J_USER=neo4j
NEO4J_PASSWORD=<password>
```

`NEO4J_URI` is for the driver (CLI, MCP server, tests); `NEO4J_HTTP` is for the ambient hook, which avoids the driver on purpose (PLAN item 48).

To index your own folder of markdown: `node bin/breakwall.js sync <dir> --name <corpus>`. Any folder works; work items, status and supersession are optional layers (below).

## Usage

```bash
node bin/breakwall.js sync <dir> [--name <corpus>] [--json]  # incremental: add / change / rename / tombstone / restore by content hash
                                                             # (`index` is an alias)
node bin/breakwall.js search "<query>" [--corpus <c>] [--mode hybrid|lexical|vector] [--limit 5] [--json]   # no --mode: the corpus default (see "Switches")
node bin/breakwall.js get <path|section-id> [heading] [--corpus <c>] [--include-deleted] [--json]
node bin/breakwall.js neighbors <path|section-id> [heading] [--corpus <c>] [--include-deleted]   # JSON
node bin/breakwall.js work-item <id> [--corpus <c>] [--include-deleted]                        # JSON, grouped by phase
node bin/breakwall.js history <path|earlier path|uid|title> [--corpus <c>]                     # JSON
node bin/breakwall.js status                                                                   # JSON, includes whether the inferred layer is fresh
node bin/breakwall.js infer [--corpus <c>] [--passes similar,entities,communities] [--force]   # inferred layer: local, no embedder; recomputed whole, 0 writes if unchanged
node bin/breakwall.js entities [<text>] [--corpus <c>] [--type t] [--aliases] [--limit 50]        # JSON, entity table with alias table
node bin/breakwall.js communities [--corpus <c>] [--members]                                       # JSON
node bin/breakwall.js trace <from> <to> [--corpus <c>] [--layers both|deterministic|inferred] [--max-hops 6]   # JSON
node bin/breakwall.js search "<query>" --signals similar,entity,community|all|none               # opt-in inferred retrieval signals (all off by default)
node bin/breakwall.js eval <dir> --inferred [--name <corpus>] [--write eval/results-m4.md]       # inferred signals vs the M2 hybrid baseline
node bin/breakwall.js rebuild-check <dir> --inferred                                              # also wipes, rebuilds and diffs the inferred layer
node bin/breakwall.js eval <dir> [--name <corpus>] [--write eval/results-m2.md]
node bin/breakwall.js cite <path|section-id> [heading] [--corpus <c>] [--json]                 # bw:<corpus>:<path>#<heading>@<commit>
node bin/breakwall.js cite --check "<bw:...>"                                                  # ok / changed / heading-missing / deleted / unknown
node bin/breakwall.js stale [--corpus <c>] [--days 90] [--recent-days 14] [--json]             # staleness report, read-only
node bin/breakwall.js hook-test [--corpus <c>]                                                 # exercise hooks/user-prompt-submit.js
node bin/breakwall.js vault <corpus> [--out <dir>] [--no-inferred] [--force] [--json]       # Obsidian vault of the graph, default ./<corpus>-vault
node bin/breakwall.js lint <dir> [--strict]                  # no database needed
node bin/breakwall.js outline <file.md>                      # no database needed
node bin/breakwall.js rebuild-check <dir> [--name <corpus>]  # wipe, reindex, diff
npm test
```

`lint` rules: `dangling-link` (missing file or anchor), `orphan` (no other document links to it), `duplicate-heading` (same heading path twice in a document), `count-mismatch` ("N things" directly above a table whose header names the thing, with a different row count), `supersession-target` (frontmatter `supersedes` / `superseded_by` names a document that is not in the corpus).

## Search (M2)

Every section becomes one or more `Chunk` nodes (`HAS_CHUNK`). Sections over 1500 chars are split on blank-line block boundaries into chunks of about 1000 chars, never inside a code fence, and every chunk keeps the heading path. Each chunk is embedded locally (`Xenova/all-MiniLM-L6-v2`, 384-dim; input = heading path + chunk text, capped at 1500 chars) and stored with `embedModel` and `embedHash`. A chunk is re-embedded only when that hash changes; `index` prints how many were embedded vs reused, and a no-change reindex embeds 0. Neo4j holds a Lucene BM25 full-text index (`chunk_text`, english analyzer) and a cosine vector index (`chunk_embedding`). Search runs both, fuses them with reciprocal rank fusion (weights 1:1, k=60, ties broken by chunk id) and collapses chunks to sections.

Each hit cites doc path, heading path, line range, lexical rank and BM25, vector rank and cosine, fused score, commit and a snippet (`--json` adds the full text). `get` returns an exact section by id, or by path plus a full heading path or a unique heading suffix. If the top hit's cosine is below 0.41 the output says low confidence; results are never hidden.

Rankings are reproducible for a given database state: vector order is decided by exact cosine on the stored vectors, and the full-text index is rebuilt whenever content changes, so BM25 does not depend on index history. BM25 statistics do span every corpus in the database, so adding another corpus can shift lexical scores.

Eval results were measured on a local-only corpus and question set (24 questions over a snapshot of Undertow's docs; not in this repo, see `eval/README.md`); the numbers are in `PLAN.md` items 21 and 42. Headline: hybrid is not shown to beat lexical alone on that set.

## Switches: default search mode and vectors per corpus

Two settings, each read from the environment first, then from the corpus' `breakwall.json` (at the corpus root, the same file as the work-item and alias tables), then a built-in default (PLAN item 57). A bad value is an error that names where it came from; nothing falls back silently.

| Switch | Env | `breakwall.json` | Built-in | When it is read |
|---|---|---|---|---|
| Default search mode (A) | `BREAKWALL_SEARCH_MODE` = `hybrid` / `lexical` / `vector` | `{"search": {"mode": "lexical"}}` | `hybrid` (`lexical` if vectors are off) | every `search` and `breakwall_search` without an explicit mode |
| Vectors on/off (B) | `BREAKWALL_VECTORS` = `0` / `1` | `{"vectors": false}` | on | at `sync` / `index`; stored on the `Corpus` node |

- An explicit `--mode` (CLI) or `mode` (MCP) always wins. The CLI prints the mode and its source on stderr; JSON and MCP results carry `mode` and `modeSource`.
- **Vectors off:** `sync` does not load or download the embedding model and embeds nothing; search on that corpus is lexical and does not embed the query. `--mode hybrid|vector` there, or a switch A that names them, is an error saying vectors are off (never a silent downgrade). Switching off deletes nothing: stored vectors stay and every chunk keeps its `embedHash`, so switching back on and syncing embeds only the chunks that have no vector, without rewriting any document.
- **Half-embedded corpus** (vectors on but some chunks without one, e.g. a sync that failed while embedding after switching back on): `hybrid` and `vector` are refused until a `sync` completes; `lexical` works.
- `status` / `breakwall_status` show per corpus a `search` block: `vectors`, `vectorsSource`, `defaultMode`, `defaultModeSource` and `unembeddedChunks` (or `defaultModeError`).
- Not affected: the ambient hook (lexical only, item 49), `trace`, and the eval harness, which always scores all three modes and so refuses a vectors-off or half-embedded corpus with a message saying so.

## Sync, renames, tombstones (M3)

`sync` compares every file's content hash with the index. Per file: **unchanged** (no graph write, no embedding), **changed** (the document is rewritten in one transaction; only chunks with a new embed hash are embedded), **added**, **renamed**, **removed** (tombstoned) or **restored**. It prints the list; a run with nothing to do reports `graph writes 0` (Neo4j's own update counters) and embeds 0.

- **Rename rule.** A file that vanished and a file that appeared in the same sync are the same document if their hashes are equal (same basename wins among identical files), else if both have at least 3 headings below level 1 and the Jaccard similarity of their lowercased heading texts is at least 0.6 (best first, one-to-one). Otherwise it is a delete plus an add. A renamed document keeps its `uid` and gets a `renamed` event; node ids stay path-based.
- **Tombstones.** A document that disappears and matches no rename is kept with `deleted` and `deletedAt`; its section text stays (flagged) so `get`/`outline`/`neighbors`/`work-item --include-deleted` and `history` can show it. Its chunks are removed, so it is not searchable and cannot shift live rankings. A file reappearing at the same path restores the same document (same `uid`, a `restored` event, embedded again).
- **History is index state.** `uid`, renames and tombstones cannot be rebuilt from files; a wipe loses them. `rebuild-check` therefore compares the live content graph. Back up the Neo4j volume if the history matters.
- **Status and supersession (optional frontmatter).** `status`, `supersedes`, `superseded_by` (values: paths relative to the file, corpus-relative paths, or a unique file name). One stored edge, `(newer)-[:SUPERSEDES]->(older)`, declared from either side. Search results and `history` show it; nothing is down-ranked or hidden.
- **Work items (optional).** Only if the corpus root has a `breakwall.json`, or a document has `work-item:` (and optionally `phase:`) in its frontmatter. Example, see `test/data/sample-corpus/breakwall.json`:

```json
{ "workItems": { "idFromPath": "^work/([^/]+)/", "phases": { "spec": "spec", "design": "design", "test": "test", "retro": "retro" } } }
```

`idFromPath` is a regex over the corpus-relative path (group 1 is the id); each phase is a regex over the path, first match in key order wins. Without any of this the corpus simply has no work items (`work_item` says so).

## Inferred layer (M4)

Everything here is computed locally and deterministically from the stored graph: **no LLM, no API call, no embedder call** (`infer` reads the vectors already stored on the chunks and prints the embedder's call counters, which stay 0). Every inferred node and edge carries `layer: 'inferred'`, a `method`, a `run` id and, where it applies, a `score`; they use their own labels and relationship types (`Entity`, `Community`, `InferredRun`, `SIMILAR_TO`, `MENTIONS_ENTITY`, `IN_COMMUNITY`), so they can never be mistaken for the deterministic layer, whose dump and `rebuild-check` digest do not include them.

- **`similar`**: for each section, its top 3 neighbours in other documents by cosine over the stored chunk vectors (a section's score is its best chunk pair), kept at cosine 0.70 or more; sections with under 120 characters of body are skipped. The threshold was chosen by looking at the score distribution and sampled pairs (PLAN item 39), not from the eval set.
- **`entities`**: backticked terms, bold terms, file names, endpoints, ports, `ENV_VARS`, camel/Pascal/snake identifiers and capitalised names, kept when they occur in at least 2 sections and in no more than max(20% of sections, 3). Surface forms are merged by case, plural, hyphen/underscore/space and camel/snake form into one canonical entity whose alias table you can see with `breakwall entities --aliases`; an explicit table can be added to the corpus' `breakwall.json` as `{"entities": {"aliases": {"wonder daemon": "Wonder"}}}`. A section-to-entity edge records the method(s), a tf-idf score and up to 5 spans (line, column, surface, method).
- **`communities`**: Louvain (no randomness, fixed tie-breaks) over the heading tree, resolved links and similar-to edges; each community gets a label from its top entities.
- **Reproducible and rebuildable.** The layer is a function of the corpus and the pass code (the input digest includes a hash of the pass sources). Same corpus, same edges, entities and communities; `rebuild-check --inferred` proves it. The layer is recomputed whole, never patched: `infer` does zero graph writes when nothing changed, and costs about 0.6 s for a 320-section corpus. After a `sync` that changed documents the layer is reported **stale** (stderr, `status`, `breakwall_status`) until `infer` or `sync --infer` runs.
- **Retrieval signals, off by default.** `similar` (neighbour expansion of the top hits), `entity` (boost sections that mention entities named in the query) and `community` (at most 2 results per community in the top 10) are opt-in with `--signals` / MCP `signals`; results they add or move carry an `inferred` block saying why. They were scored against the M2 hybrid baseline and **none beat it** (PLAN item 42: similar and entity cost top-1 citation accuracy, entity gains recall@10 by 2 questions of 19, community lowers recall), so they ship off. The rule that decided this was written before the first run (PLAN item 36).
- **`trace <from> <to>`** explains how two things connect: the cheapest path over parsed edges (heading tree, reading order, links) and, unless `--layers deterministic`, inferred ones (entity mentions, similarity). `from`/`to` can be a section id, `path#heading` (full heading path or unique suffix), a document path (its title section) or an entity name (`entity:Spider` forces an entity). Every hop shows the edge type, layer, method, score, provenance and a sentence; the deterministic-only path is returned beside the main one. Same tool over MCP as `breakwall_trace`.

Not built (PLAN item 47): relations between entities (DEFINES / USES / DEPENDS_ON), centrality, LLM-based extraction (left as an option pending RouterBox's explicit go, since it would spend money and send the corpus off the machine).

## MCP server (M3, trace added in M4)

`bin/breakwall-mcp.js` is a stdio MCP server with tools `breakwall_search`, `breakwall_get`, `breakwall_outline`, `breakwall_neighbors`, `breakwall_work_item`, `breakwall_history`, `breakwall_trace` (M4), `breakwall_lint`, `breakwall_status` (prefixed so they never collide with Undertow's `undertow_*`). It is read-only: the graph is opened with READ sessions, nothing writes to the corpus, and syncing stays a CLI action. Every result carries a citation (path, heading path, line range, `ref`, corpus, provenance = commit, content hash, document uid); search adds the score breakdown, status / supersession, and a `max_chars` text budget. Bad input comes back as a tool error, not a crash. There is no HTTP service and no BreakWall port. It reads the same git-ignored `.env`, so the config needs no secrets.

It is not registered anywhere. To use it, add this to the MCP config you want (for Claude Code, `mcpServers` in `~/.claude.json`, or a project `.mcp.json`), then restart the client:

```json
{
  "mcpServers": {
    "breakwall": {
      "command": "node",
      "args": ["/path/to/BreakWall/bin/breakwall-mcp.js"],
      "env": { "BREAKWALL_CORPUS": "sample" }
    }
  }
}
```

`BREAKWALL_CORPUS` is optional when only one corpus is indexed; every tool also takes a `corpus` argument. The container must be up (`docker start breakwall-neo4j`); otherwise tools answer with that hint. The first search loads the local embedding model (a few seconds). `breakwall_search` takes an optional `mode` (omitted: the corpus default from switch A, read from the server's environment and the corpus `breakwall.json`) and an optional `signals` list (off by default, see above) and `breakwall_trace` takes `from`, `to`, `layers` and `max_hops`. Smoke test: `node scripts/mcp-smoke.js [corpus]` spawns the server, makes one call per tool and closes stdin to stop it.

## Ambient hook (M5, optional, read-only)

`hooks/user-prompt-submit.js` is a Claude Code `UserPromptSubmit` hook that injects a few cited, verbatim BreakWall excerpts into a prompt's context. It is **off everywhere until you do both of these**: register the hook, and drop a `.breakwall.json` marker into a project.

Register it (the builder never touched your settings). Prefer a project's own `.claude/settings.local.json` over the global file, so it only runs where you want it:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node /path/to/BreakWall/hooks/user-prompt-submit.js", "timeout": 5 } ] }
    ]
  }
}
```

Opt a project in by putting `.breakwall.json` in its root (the hook looks in the prompt's working directory and up to 7 parents; no marker, no output):

```json
{ "corpus": "sample" }
```

Optional keys: `ambient: false` (switch off without deleting), `limit` (hits, default 3, max 5), `maxTokens` (default 400, max 1000), `minBm25` (default 9.341), `minChars` (default 25). `BREAKWALL_AMBIENT=0` in the environment switches every project off.

What it does, and why it is built this way (PLAN items 48 to 51):

- **Lexical (BM25) only, over Neo4j's HTTP API, no warm process.** A fresh Node process that loads the Neo4j driver costs 1.6 to 1.8 s, and loading the local embedding model about 1.2 s, so neither fits the one-second budget. A one-shot `fetch` to `http://127.0.0.1:7475` takes about 250 ms wall including Node start (`hook-test` shows 80 to 160 ms per run on a quiet machine). A warm vector process would not be faster and the M2 eval did not show hybrid beating lexical, so none exists. Consequence: the confidence gate is a BM25 threshold (9.341, from the M2 eval) applied to every injected hit, not the cosine gate. On the 19 answerable eval questions it stays silent for 6 of them, on all 5 unanswerable ones, and on 11 of 12 off-topic prompts (`scripts/hook-gate-check.js`, PLAN item 54). Silence is the cheap failure. The threshold is calibrated on one corpus: tune `minBm25` per project.
- **Safety.** Hard stop 950 ms after process start; exit code always 0; stdout is one line of hook JSON or nothing; stderr is empty unless `BREAKWALL_HOOK_DEBUG=1`. Container stopped, wrong port, bad credentials, a server that hangs, bad stdin, a broken marker: all silent. Prompts under 25 characters or 4 words, and slash commands, are skipped. The hook only reads (one fixed read-only Cypher statement) and never writes to the corpus or the graph; its only write is a tiny per-session file in the OS temp dir (`breakwall-hook/<session>.json`) listing sections it already injected, so a section is injected at most once per session.
- **Budget shared with Undertow's flashes.** BreakWall's block is capped at `maxTokens` (400 by default, estimated as characters / 4) and at most 3 snippets of 350 characters. Undertow's `haiku` mode injects at most 2 flashes, so a prompt gets BreakWall's block plus those flashes, about 700 tokens in all. This is a convention, not a protocol: both hooks run for the same event and cannot see each other, and coordinating them would mean reading Undertow's internals. If you add another ambient source, lower `maxTokens`.
- **Inferred signals stay off** (M4 found none worth turning on).
- **Citation-formatted:** each hit is `[n] bw:<corpus>:<path>#<heading path>@<commit8> (lines a-b)`, followed by the verbatim excerpt; a superseded document is labelled `[SUPERSEDED by ...]`, never hidden.

`node bin/breakwall.js hook-test` pipes sample hook input into the real script and checks it: output shape, the token cap, a repeat being silent, opt-in and opt-out, short and slash prompts, an off-topic prompt, garbage stdin, a different hook event, and three outages simulated without touching any container (wrong port, wrong password, a local listener on an ephemeral port that accepts and never answers), each with a latency budget of 1000 ms including Node start. Exit code 1 if any check fails. To try the hook by hand:

```bash
echo '{"session_id":"x","cwd":"C:/path/to/opted-in/project","hook_event_name":"UserPromptSubmit","prompt":"your question here"}' | BREAKWALL_HOOK_DEBUG=1 node hooks/user-prompt-submit.js
```

## Obsidian vault (`breakwall vault`)

`node bin/breakwall.js vault <corpus> [--out <dir>] [--no-inferred] [--force] [--json]` writes the indexed corpus as an Obsidian vault, the BreakWall counterpart of Undertow's Tapestry (PLAN item 58). It is a one-way projection like the graph itself: delete the folder, rerun, get the same files. Nothing is ever read back; to change knowledge, edit the source markdown and `sync`.

- **Where.** Default `./<corpus>-vault` in the current directory (git-ignored in this repo as `/*-vault/`). The output may be neither inside the corpus root nor around it; that is checked before anything is written and the command refuses rather than picking another place.
- **Faithful to Neo4j.** One note per node in a folder per label: `Corpus/`, `Document/`, `Section/`, `WorkItem/`, `MissingTarget/` (dangling-link targets), and `Entity/`, `Community/` for the inferred layer. Each relationship is one `- [TYPE:: [[target]]] (layer, method, score)` line in its source note and one `in_TYPE::` line in its target note (Dataview inline fields, so the type survives). `Chunk` nodes are the one exception: a Section note lists its chunk ids and embed model in `bw_chunks` / `bw_embed_model`. Vectors are never written. Tombstoned documents, their sections and edges to them are left out (counted in `_index.md`).
- **Section notes** hold the verbatim section text, followed by `%% breakwall: end of section text %%` and the link blocks; frontmatter has `bw_id`, `bw_label`, `bw_corpus`, `bw_path`, `bw_heading_path`, `bw_lines`, `bw_commit`, `bw_hash`, `status` and every other non-vector property as `bw_<name>`. Document notes list their sections in reading order as plain text (the links are the real `CONTAINS` edges). Wikilinks that appear inside verbatim text are left as written; the generated `.obsidian/graph.json` sets `hideUnresolved` so the graph view keeps Neo4j's shape.
- **Inferred layer, labelled.** Only when it is present and fresh, its links sit under "BreakWall (inferred, local, hints not facts)" and the Entity/Community notes exist. Stale or absent: omitted, and the command says why. `--no-inferred` omits it on purpose.
- **`_index.md`** (corpus, commit, notes per label, relationships per type, what is not exported, documents by folder) and **`_lint.md`** (`breakwall lint` over the files on disk).
- **Safe reruns.** `_breakwall-manifest.json` records every file written and its hash. A rerun writes only changed files and deletes only files the previous manifest named that are no longer produced. A file edited by hand since the last export is listed and left alone (exit code 1) unless `--force`; files the manifest never named are never touched. `.obsidian/graph.json` (colour groups per folder) is written only when `.obsidian/` does not exist yet. The generation time is only in the manifest, so the notes are byte-identical for the same graph.

On the 20-document Undertow corpus it writes 720 files (718 notes) in about 2 s; see PLAN item 59 for the measured run.

## Staleness (M5)

`node bin/breakwall.js stale [--corpus c] [--days 90] [--recent-days 14] [--json]` is a report, never an action: nothing is ranked down, hidden or decayed. It is read-only and cheap (no embedder, no graph write; it hashes the files, runs a handful of read queries and one `git log`). It lists:

1. documents whose file changed since the last index (changed, added, removed), with the sections that differ; fix with `sync`;
2. documents superseded by a newer document;
3. documents not touched for more than `--days` days that a document touched within `--recent-days` days links to ("touched" = last git commit time of the file, else its modification time);
4. claims that lint flags: `count-mismatch`, `dangling-link`, `supersession-target`.

On a freshly synced corpus with clean lint and no supersession all four lists are empty.

## Undertow bridge (M5, BreakWall side only)

BreakWall and Undertow stay separate stores. Nothing in this repo touches Undertow, and Undertow does not need to change to use BreakWall.

- **Read-only access for Undertow-side agents.** Register the MCP server (previous section) in the agent's config. Its tools are `breakwall_*`, which cannot collide with `undertow_*`, and it opens the graph read-only. An agent without MCP can shell out: `node /path/to/BreakWall/bin/breakwall.js search "<query>" --json`.
- **Referencing a section without copying it.** An Undertow neuron (or any note) that depends on a BreakWall document stores a citation string and no content: `bw:<corpus>:<path>#<heading path>@<commit8>`, for example `bw:undertow-fixture:context/projectPlan.md#Undertow > Economics: The Token Burn Problem > Feedback Loop: Detecting Pursuit vs Dismissal@123bef1e`. `breakwall cite <path> [heading]` prints it (`--json` adds line range and content hash). `breakwall cite --check "<citation>"` says whether it still holds: `ok`, `changed` (the document was committed since; re-read the section), `heading-missing`, `deleted` or `unknown` (exit code 1 unless ok). The `@commit` is the last commit that touched the file in the corpus repository. The same string is what the ambient hook prints, so a flash and a neuron can quote the same reference. `src/cite.js` has the pure `formatCitation` / `parseCitation` if you want them in code.
- **What an Undertow-side change would be** (a proposal, PLAN item 55, not built and not requested): a `sources: ["bw:..."]` field on a neuron; Janitor or Spider running `cite --check` over them and flagging `changed` / `heading-missing` as `needs_review` (never auto-correcting, as with `wrong` feedback); and, if the two ambient hooks should really share a budget, Undertow publishing the section refs it injected for a prompt where the BreakWall hook can read them.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Neo4j not reachable` / tools answer with a hint / DB tests skipped | The container is stopped. `docker start breakwall-neo4j`. Check `docker ps`, and that `.env` has the right password and ports (7688 bolt, 7475 http). |
| `several corpora indexed (...); pass --corpus` | More than one corpus is in the database. Pass `--corpus <name>` or set `BREAKWALL_CORPUS`. |
| First `search`, `sync` or `eval` is slow, or errors about the model | The local embedding model (`Xenova/all-MiniLM-L6-v2`) loads in about 1 s and downloads once on first use; with no network and no cache it fails by design instead of falling back to an API. |
| The hook never injects anything | By design it is silent on any doubt. Run it by hand with `BREAKWALL_HOOK_DEBUG=1` (see above); the reason is printed on stderr: not opted in (no `.breakwall.json`), short prompt, container down, below the BM25 gate, or already injected in this session. Lower `minBm25` in the marker to test; `hook-test` should be all PASS. |
| `hook-test` first check fails | The corpus named in the marker (default `undertow-fixture`, or `--corpus`) is not indexed, the container is down, or the prompt (`--prompt`) is not on topic for that corpus. |
| Hook output appears but the sections look off-topic | BM25 scores depend on the whole index, so another corpus in the same database shifts them. Raise `minBm25`, or give the project its own database. |
| `stale` says everything is changed | The corpus folder moved or was re-checked-out; run `sync` again from the folder the corpus was indexed from. |
| `vectors are off for corpus ...` or `... is half-embedded` | Switch B is off for that corpus (search lexically), or a sync failed while embedding; run `sync` again. `status` shows which setting came from where. |
| Rankings changed after indexing a second corpus | Known (PLAN item 18): Lucene statistics are index-wide. |
| Ports | BreakWall owns only 7475 and 7688 (loopback). It runs no service of its own. Do not point it at another project's Neo4j. |

## Graph model (M1)

Nodes: `Corpus`, `Document` (path, title, hash, git commit, frontmatter, and from M3 `uid`, `events`, `status`, `workItem`, `phase`, `deleted`/`deletedAt` on tombstones), `Section` (heading path, line range, verbatim text, hash, git commit), `MissingTarget` (a dangling link's target), `Chunk` (M2), `WorkItem` (M3, optional).
Edges, all with `layer: 'deterministic'` and a `method` (the M4 inferred layer is separate, see above): `CONTAINS` (corpus > document > section > child section), `NEXT` (reading order), `LINKS_TO` (section to document or section; markdown links and `[[wikilinks]]`), `DANGLING_LINK` (section to `MissingTarget`, with a reason), `SUPERSEDES` (document to older document, from frontmatter) and `BELONGS_TO` (document to work item). External URLs and links leaving the corpus root are ignored. Every node has `corpus`, so several corpora share one database. Indexing is one transaction per document plus one for link edges.

Explore at http://127.0.0.1:7475 (credentials from `.env`).

## Tests

`npm test` runs `node --test --test-concurrency=1` (serial: full-text statistics are shared by all corpora in the database). The graph and search tests use the container and write only to `test-*` corpora that they remove; if Neo4j is unreachable they are skipped with a warning. They include the plan's rebuild test (wipe, reindex, diff must be identical). `test/sync.test.js` covers the sync behaviours above with a counting stub embedder; `test/mcp.test.js` spawns the real server over stdio and checks the wire format. `test/m5.test.js` covers citations, the hook (pure core, the real script as a child process with silent-failure and latency bounds, and against a real index) and the staleness report. `test/switches.test.js` covers both switches (precedence, bad values, vectors off loads no model and writes no vector, off then on embeds only the missing chunks, the half-embedded refusal, status, hook and eval unaffected). `test/vault.test.js` covers the vault: naming, the output-folder refusal, the count check of every node and relationship against Neo4j (sample corpus and, read-only, a live `undertow-fixture` index when one exists), verbatim sections, link resolution, no vectors, determinism, manifest-scoped deletes, hand-edit protection, stale and tombstoned handling, and the CLI default path. `test/infer.test.js` covers the inferred layer: extraction and canonicalisation, similarity, Louvain, signals, trace, the decision rule, then (with the container) layering, zero embedder calls, reproducibility, rebuild, staleness after sync, signals and trace on a real graph.

Tests run on fresh clones: the corpus they index is `fixtures/sample-corpus/` (invented content). A few checks need RouterBox's local-only Undertow fixture or eval set (`test/eval.test.js`, one lint check, one vault check) and skip with a message when those are absent.

## License

MIT, copyright 2026 RouterBox (see `LICENSE`). Public on GitHub as RouterBox/BreakWall, a sibling of [Undertow](https://github.com/RouterBox/Undertow).

# Fixtures

## `sample-corpus/` (shipped)

A small synthetic corpus: 8 invented markdown documents about "Tidewater", a made-up ferry timetable service. It describes no real system and copies nothing from any other project. The tests and the README quickstart use it. It is shaped to exercise the parser and the graph: a heading tree, relative links and section anchors, a superseded document (`docs/ingest-v1.md`, superseded by `docs/ingest-v2.md`), a dangling link (`docs/operations.md` links to a missing `runbook.md`), orphans, a "3 components" claim above a 3-row table, one section long enough to be split into two chunks, and entities repeated across documents (`harbor-api`, `TideQueue`, `TIDE_DB_URL`, port 8080).

`test/data/sample-corpus/` is a second, even smaller synthetic corpus with work items, used by the sync and vault tests.

## `undertow-corpus/` (local-only, not in the repository)

BreakWall was developed and evaluated against a pinned snapshot of Undertow's markdown (20 documents, 320 sections: `context/**/*.md`, five files from `docs/` and `CLAUDE.md`), indexed as the corpus `undertow-fixture`. Since the repository went public (2026-10-27) that snapshot, and the eval set mined from it, are git-ignored and stay on RouterBox's machine only. The numbers measured on it are recorded in `PLAN.md`.

To re-create a comparable snapshot from a checkout of [Undertow](https://github.com/RouterBox/Undertow):

```bash
U=../Undertow
mkdir -p fixtures/undertow-corpus
cp -r $U/context fixtures/undertow-corpus/ 2>/dev/null   # if your checkout has context/
mkdir -p fixtures/undertow-corpus/docs && cp $U/docs/*.md fixtures/undertow-corpus/docs/
cp $U/CLAUDE.md fixtures/undertow-corpus/
find fixtures/undertow-corpus -type f ! -name '*.md' -delete
node bin/breakwall.js sync fixtures/undertow-corpus --name undertow-fixture
```

The public Undertow repository may not contain the same files as the snapshot, so scores measured on a re-created copy will differ from those in `PLAN.md`. Tests that need this corpus (`test/eval.test.js`, one lint check) skip with a message when it is absent.

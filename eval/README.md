# Eval set

The harness (`src/evalrun.js`, `src/evalinferred.js`, `breakwall eval`) ships; the question set and its results do not.

BreakWall was measured with 24 questions (19 answerable, 5 deliberately unanswerable) mined from RouterBox's real past prompts over a local-only snapshot of Undertow's docs (`fixtures/README.md`). Because the questions quote private prompts and the gold points into that snapshot, `eval/questions.json`, `eval/results-m2.md`, `eval/results-m4.md`, `eval/results-m5.md` and `eval/analysis-m2.md` are git-ignored and stay on RouterBox's machine. The headline numbers are in `PLAN.md` (items 21, 42 and 54).

## Bring your own

1. Index a corpus: `node bin/breakwall.js sync <dir> --name <corpus>`.
2. Write `eval/questions.json` (git-ignored) in this shape:

```json
{
  "status": "draft",
  "corpus": "<dir>",
  "questions": [
    {
      "id": "q01",
      "type": "single",
      "question": "Why are uploaded timetables parsed by background workers?",
      "answerable": true,
      "gold": [{ "file": "decisions/0002-queue.md", "heading_path": "ADR 0002: Move ingest to TideQueue > Decision" }]
    },
    { "id": "q02", "type": "single", "question": "What is the ferry fare to the outer islands?", "answerable": false, "gold": [] }
  ]
}
```

- `gold[].file` is the corpus-relative path; `heading_path` is the exact heading path the BreakWall parser produces (`" > "` separated, h1 included; `breakwall outline <file>` shows it).
- `answerable: false` with an empty `gold` tests the "no answer" gate.
- A question counts as retrieved at k if any gold section is in the top k; for multi-section questions the fraction of gold sections found is reported too.

3. Run `node bin/breakwall.js eval <dir> --name <corpus>` (lexical vs vector vs hybrid; needs vectors on) and, after `infer`, `eval <dir> --inferred --name <corpus>`. `--write <file>` saves the tables.

Mine questions from real prompts rather than inventing them: invented questions are too easy, and the unanswerable ones matter most for the ambient hook's gate.

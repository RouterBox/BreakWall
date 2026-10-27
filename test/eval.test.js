// Needs the local-only Undertow fixture and eval set (fixtures/README.md, eval/README.md). Neither ships in the public
// repo, so these tests skip, with a message, when either is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../src/scan.js';

const root = (p) => fileURLToPath(new URL('../' + p, import.meta.url));
const missing = ['fixtures/undertow-corpus', 'eval/questions.json'].filter((p) => !existsSync(root(p)));
const skipMsg = missing.length ? `local-only eval data absent (${missing.join(', ')}); see eval/README.md` : false;

test('every gold section in eval/questions.json exists in the pinned fixture', (t) => {
  if (skipMsg) return t.skip(skipMsg);
  const evalSet = JSON.parse(readFileSync(root('eval/questions.json'), 'utf8'));
  assert.equal(evalSet.status, 'unreviewed-by-RouterBox');
  const corpus = loadCorpus(root('fixtures/undertow-corpus'), 'fx');
  const paths = new Set(corpus.docs.flatMap((d) => d.sections.map((s) => `${d.path}|${s.headingPath.join(' > ')}`)));
  let gold = 0;
  for (const q of evalSet.questions) {
    assert.equal(q.answerable, q.gold.length > 0, q.id);
    for (const g of q.gold) {
      gold++;
      assert.ok(paths.has(`${g.file}|${g.heading_path}`), `${q.id}: ${g.file} | ${g.heading_path}`);
    }
  }
  assert.ok(gold > 0);
});


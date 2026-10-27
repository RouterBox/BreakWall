import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCorpus } from '../src/scan.js';
import { lintCorpus } from '../src/lint.js';
import { resolveLinks } from '../src/resolve.js';

function makeCorpus(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return loadCorpus(dir, 'tmp');
}

test('link resolution: doc, section anchor, wikilink, dangling, external ignored', () => {
  const c = makeCorpus({
    'a.md': '# A\n\n## Sec\n\n[to b](sub/b.md) [anchor](sub/b.md#deep-one) [bad](sub/nope.md) [badanchor](sub/b.md#zzz) [web](https://x.io) [[b]] [self](#sec)\n',
    'sub/b.md': '# B\n\n## Deep One\n\ntext [up](../a.md)\n',
  });
  const { resolved, dangling } = resolveLinks(c, () => false);
  assert.equal(resolved.length, 5);
  assert.deepEqual(dangling.map((d) => d.reason).sort(), ['missing-anchor', 'missing-file']);
  const anchored = resolved.find((r) => r.url === 'sub/b.md#deep-one');
  assert.equal(anchored.toSection, 'sub/b.md#1');
  assert.ok(resolved.some((r) => r.kind === 'wikilink' && r.toDoc === 'sub/b.md'));
});

test('lint reports dangling links, orphans, duplicate headings and count mismatches', () => {
  const c = makeCorpus({
    'a.md': '# A\n\nSee [b](b.md) and [gone](gone.md).\n\n## Dup\n\n## Dup\n\nThere are 3 named daemons.\n\n| Daemon | Role |\n|---|---|\n| x | 1 |\n| y | 2 |\n',
    'b.md': '# B\n',
    'lonely.md': '# Lonely\n',
  });
  const f = lintCorpus(c);
  const rules = f.map((x) => `${x.rule}:${x.path}`);
  assert.ok(rules.includes('dangling-link:a.md'));
  assert.ok(rules.includes('duplicate-heading:a.md'));
  assert.ok(rules.includes('count-mismatch:a.md'));
  assert.ok(rules.includes('orphan:lonely.md'));
  assert.ok(rules.includes('orphan:a.md'));
  assert.ok(!rules.includes('orphan:b.md'));
});

test('lint is deterministic', () => {
  const c = makeCorpus({ 'a.md': '# A\n\n[x](x.md)\n', 'b.md': '# B\n\n[y](y.md)\n' });
  assert.deepEqual(lintCorpus(c), lintCorpus(c));
});

test('fixture: 8-vs-8 daemons in CLAUDE.md is consistent, so no count-mismatch (known gap, see README)', (t) => {
  const dir = new URL('../fixtures/undertow-corpus', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  if (!existsSync(dir)) return t.skip('local-only Undertow fixture absent (fixtures/README.md)');
  const c = loadCorpus(dir, 'fx');
  const claude = c.docs.find((d) => d.path === 'CLAUDE.md');
  assert.deepEqual(claude.claims.map((x) => [x.claimed, x.counted]), [[8, 8]]);
  assert.equal(lintCorpus(c).filter((f) => f.rule === 'count-mismatch').length, 0);
});

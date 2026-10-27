import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, slugify } from '../src/parse.js';

const DOC = `---
title: Sample
---
Intro text before any heading.

# Top

Body of top.

## Child A

\`\`\`
# not a heading
\`\`\`

### Grandchild

text with [a link](other.md#child-a) and [[Wiki Page]]

## Child B

end
`;

test('sections carry heading path, line range, text and hash', () => {
  const d = parseMarkdown(DOC, 'a/sample.md');
  assert.equal(d.title, 'Sample');
  assert.deepEqual(d.sections.map((s) => s.headingPath.join(' > ')), ['', 'Top', 'Top > Child A', 'Top > Child A > Grandchild', 'Top > Child B']);
  const pre = d.sections[0];
  assert.equal(pre.level, 0);
  assert.equal(pre.startLine, 4);
  const gc = d.sections[3];
  assert.equal(gc.startLine, 16);
  assert.ok(gc.text.startsWith('### Grandchild'));
  assert.match(gc.hash, /^[0-9a-f]{64}$/);
  assert.equal(d.sections[4].parentId, d.sections[1].id);
});

test('code fences do not create headings and text is verbatim', () => {
  const d = parseMarkdown(DOC, 'a/sample.md');
  assert.ok(!d.sections.some((s) => s.heading === 'not a heading'));
  assert.ok(d.sections[2].text.includes('# not a heading'));
});

test('links and wikilinks are extracted with their owning section', () => {
  const d = parseMarkdown(DOC, 'a/sample.md');
  assert.deepEqual(d.links.map((l) => [l.kind, l.url]), [['link', 'other.md#child-a'], ['wikilink', 'Wiki Page']]);
  assert.equal(d.links[0].fromSectionId, 'a/sample.md#3');
});

test('duplicate headings get distinct slugs', () => {
  const d = parseMarkdown('# A\n\n## X\n\n## X\n', 'd.md');
  assert.deepEqual(d.sections.map((s) => s.slug), ['a', 'x', 'x-1']);
  assert.equal(slugify('Hello, World! v2'), 'hello-world-v2');
});

test('numeric claim before a table is compared to the row count', () => {
  const d = parseMarkdown('# T\n\nWe have 3 named daemons here.\n\n| Daemon | Role |\n|---|---|\n| a | x |\n| b | y |\n', 'c.md');
  assert.equal(d.claims.length, 1);
  assert.equal(d.claims[0].claimed, 3);
  assert.equal(d.claims[0].counted, 2);
});

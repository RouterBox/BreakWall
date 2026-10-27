import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../src/scan.js';
import { chunkSection, embedInput, CHUNK_MAX, EMBED_CAP } from '../src/chunk.js';

const sec = (text, headingPath = ['Doc', 'Part'], startLine = 10) => ({ id: 'c:a.md#1', headingPath, startLine, text });
const para = (n, ch) => Array.from({ length: n }, (_, i) => `${ch}${i} ` + 'word '.repeat(20)).join('\n');

test('a short section is exactly one chunk with the section text and range', () => {
  const s = sec('## Part\n\nsmall body\nsecond line');
  const [c, ...more] = chunkSection(s);
  assert.equal(more.length, 0);
  assert.equal(c.text, s.text);
  assert.equal(c.startLine, 10);
  assert.equal(c.endLine, 13);
  assert.equal(c.headingPath, 'Doc > Part');
  assert.equal(c.id, 'c:a.md#1~0');
});

test('a long section splits on block boundaries, keeps heading path and contiguous ranges on every chunk', () => {
  const text = '## Part\n\n' + [para(6, 'a'), para(6, 'b'), para(6, 'c'), para(6, 'd')].join('\n\n');
  const s = sec(text);
  assert.ok(text.length > CHUNK_MAX);
  const chunks = chunkSection(s);
  assert.ok(chunks.length > 1);
  const lines = text.split('\n');
  for (const [i, c] of chunks.entries()) {
    assert.equal(c.headingPath, 'Doc > Part');
    assert.equal(c.ordinal, i);
    assert.ok(c.text.length <= CHUNK_MAX, `chunk ${i} is ${c.text.length}`);
    assert.equal(c.text, lines.slice(c.startLine - 10, c.endLine - 10 + 1).join('\n'), 'chunk text is the exact line range');
    if (i) assert.ok(c.startLine > chunks[i - 1].endLine);
  }
  assert.equal(chunks[0].startLine, 10);
  assert.equal(chunks.at(-1).endLine, 10 + lines.length - 1);
  // No content line is lost.
  const kept = chunks.flatMap((c) => c.text.split('\n')).filter((l) => l.trim());
  assert.deepEqual(kept, lines.filter((l) => l.trim()));
});

test('a code fence with blank lines inside is not cut when it fits', () => {
  const fence = '```js\n' + Array.from({ length: 12 }, (_, i) => `const x${i} = ${i};\n`).join('\n') + '```';
  const text = '## Part\n\n' + para(8, 'p') + '\n\n' + fence + '\n\n' + para(8, 'q');
  const chunks = chunkSection(sec(text));
  assert.ok(chunks.length > 1);
  const open = chunks.filter((c) => c.text.includes('```js')).length;
  assert.equal(open, 1);
  for (const c of chunks) assert.equal((c.text.match(/```/g) || []).length % 2, 0, 'fence markers balanced in each chunk');
});

test('chunking is deterministic and works on the whole sample corpus', () => {
  const corpus = loadCorpus(fileURLToPath(new URL('../fixtures/sample-corpus', import.meta.url)), 'fx');
  const run = () => corpus.docs.flatMap((d) => d.sections.flatMap((s) => chunkSection({ ...s, id: `fx:${s.id}` })));
  const a = run();
  assert.deepEqual(a, run());
  assert.ok(a.length > corpus.docs.reduce((n, d) => n + d.sections.length, 0), 'some long sections were split');
  for (const c of a) assert.ok(c.text.length > 0 && c.endLine >= c.startLine);
  // Provenance: chunk text is the file's own lines.
  const doc = corpus.docs.find((d) => d.path === 'docs/architecture.md');
  const raw = readFileSync(fileURLToPath(new URL('../fixtures/sample-corpus/docs/architecture.md', import.meta.url)), 'utf8').split(/\r?\n/);
  for (const s of doc.sections) {
    for (const c of chunkSection({ ...s, id: s.id })) assert.equal(c.text, raw.slice(c.startLine - 1, c.endLine).join('\n'));
  }
});

test('embed input is heading path plus text, capped', () => {
  const c = { headingPath: 'A > B', text: 'x'.repeat(5000) };
  assert.equal(embedInput(c).length, EMBED_CAP);
  assert.ok(embedInput(c).startsWith('A > B\nxxx'));
  assert.ok(embedInput({ headingPath: '', text: 'hi' }, 'Title').startsWith('Title\nhi'));
});

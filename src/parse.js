// Pure markdown parsing: text in, document + sections + links out. No I/O, no DB.
import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { parse as parseYaml } from 'yaml';

const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function nodeText(node) {
  if (node.value !== undefined) return node.value;
  return (node.children || []).map(nodeText).join('');
}

// GitHub-style anchor slug (the -1/-2 dedupe is added by parseMarkdown).
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

const WIKILINK = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g;

function walk(node, fn) {
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

const WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUMBER_NOUN = new RegExp(`\\b(\\d{1,3}|${Object.keys(WORDS).join('|')})\\s+(?:[a-z-]+\\s+){0,2}?[a-z]+s\\b`, 'i');
const toNumber = (w) => (/^\d/.test(w) ? Number(w) : WORDS[w.toLowerCase()]);

/**
 * @param {string} raw  file contents
 * @param {string} path corpus-relative posix path
 */
export function parseMarkdown(raw, path) {
  const tree = processor.parse(raw);
  const lines = raw.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

  let frontmatter = null;
  let bodyStart = 1; // first line after frontmatter
  const first = tree.children[0];
  if (first && first.type === 'yaml') {
    try {
      frontmatter = parseYaml(first.value) ?? null;
    } catch {
      frontmatter = null;
    }
    bodyStart = first.position.end.line + 1;
  }

  // Headings in reading order (headings inside code fences are not headings in the AST).
  const headings = tree.children
    .filter((n) => n.type === 'heading')
    .map((n) => ({ level: n.depth, text: nodeText(n).trim(), line: n.position.start.line }));

  // Sections: a preamble (if any text precedes the first heading) + one per heading.
  const bounds = [];
  const firstHeadingLine = headings.length ? headings[0].line : lines.length + 1;
  if (lines.slice(bodyStart - 1, firstHeadingLine - 1).some((l) => l.trim() !== '')) {
    bounds.push({ level: 0, heading: '', start: bodyStart, end: firstHeadingLine - 1 });
  }
  headings.forEach((h, i) => {
    const next = headings[i + 1];
    bounds.push({ level: h.level, heading: h.text, start: h.line, end: next ? next.line - 1 : lines.length });
  });

  const sections = [];
  const stack = [];
  const slugCount = new Map();
  for (const b of bounds) {
    while (b.end > b.start && lines[b.end - 1].trim() === '') b.end--;
    let parent = null;
    if (b.level > 0) {
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
      parent = stack.length ? stack[stack.length - 1] : null;
    }
    const headingPath = b.level === 0 ? [] : [...(parent ? parent.headingPath : []), b.heading];
    let slug = '';
    if (b.level > 0) {
      slug = slugify(b.heading);
      const n = slugCount.get(slug) || 0;
      slugCount.set(slug, n + 1);
      if (n > 0) slug = `${slug}-${n}`;
    }
    const text = lines.slice(b.start - 1, b.end).join('\n');
    const s = {
      id: `${path}#${sections.length}`,
      ordinal: sections.length,
      level: b.level,
      heading: b.heading,
      headingPath,
      slug,
      parentId: parent ? parent.id : null,
      startLine: b.start,
      endLine: b.end,
      text,
      hash: sha256(text),
    };
    sections.push(s);
    if (b.level > 0) stack.push(s);
  }

  const sectionAt = (line) => {
    let found = null;
    for (const s of sections) if (s.startLine <= line) found = s;
    return found;
  };

  // Links: markdown links, link definitions, and [[wikilinks]].
  const links = [];
  walk(tree, (n) => {
    if ((n.type === 'link' || n.type === 'definition') && n.url) {
      links.push({ kind: 'link', url: n.url, text: n.type === 'link' ? nodeText(n) : n.label || '', line: n.position.start.line });
    } else if (n.type === 'text') {
      for (const m of n.value.matchAll(WIKILINK)) {
        const line = n.position.start.line + (n.value.slice(0, m.index).match(/\n/g) || []).length;
        links.push({ kind: 'wikilink', url: m[1].trim() + (m[2] ? '#' + m[2].trim() : ''), text: m[0], line });
      }
    }
  });
  for (const l of links) {
    const s = sectionAt(l.line);
    l.fromSectionId = s ? s.id : null;
  }

  // Numeric claims: a paragraph saying "N <things>" directly before a table whose
  // row count differs. Only direct neighbours, which keeps it low-noise.
  const claims = [];
  tree.children.forEach((n, i) => {
    if (n.type !== 'table') return;
    const prev = tree.children[i - 1];
    if (!prev || prev.type !== 'paragraph') return;
    const m = nodeText(prev).match(NUMBER_NOUN);
    if (!m) return;
    // Only tables, and only when the header names the noun ("8 daemons" before a table
    // with a Daemon column). Lists were tried and were all false positives.
    if (n.type !== 'table') return;
    const noun = m[0].trim().split(/\s+/).pop().toLowerCase().replace(/s$/, '');
    if (!nodeText(n.children[0]).toLowerCase().includes(noun)) return;
    const counted = n.children.length - 1;
    claims.push({ line: prev.position.start.line, claimed: toNumber(m[1]), counted, phrase: m[0].trim(), kind: n.type });
  });

  const title =
    (frontmatter && typeof frontmatter.title === 'string' && frontmatter.title) ||
    (headings.find((h) => h.level === 1) || {}).text ||
    path.split('/').pop().replace(/\.md$/i, '');

  return { path, title, frontmatter, sections, links, claims, lineCount: lines.length };
}

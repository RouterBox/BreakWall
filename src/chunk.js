// Deterministic chunking. A section of at most CHUNK_MAX chars is one chunk. A longer one is split on
// blank-line block boundaries into chunks of about CHUNK_TARGET chars or less (never inside a code
// fence unless the fence alone is too big). The heading path travels with every chunk as context.
export const CHUNK_MAX = 1500;
export const CHUNK_TARGET = 1000;
export const EMBED_CAP = 1500;

/** Group lines into blocks separated by blank lines; a fenced code block is one block. */
function blocks(lines) {
  const out = [];
  let cur = null;
  let fence = null;
  lines.forEach((line, i) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
    } else if (f) fence = f[1];
    if (line.trim() === '' && !fence) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { from: i, to: i };
      out.push(cur);
    } else cur.to = i;
  });
  return out;
}

/** Cut one oversized block into line groups (a single huge line stays one group). */
function splitBlock(lines, b) {
  const parts = [];
  let from = b.from;
  let len = 0;
  for (let i = b.from; i <= b.to; i++) {
    const l = lines[i].length + 1;
    if (len > 0 && len + l > CHUNK_TARGET) {
      parts.push({ from, to: i - 1 });
      from = i;
      len = 0;
    }
    len += l;
  }
  parts.push({ from, to: b.to });
  return parts;
}

/**
 * @param {{ id:string, headingPath:string[], startLine:number, text:string }} section
 * @returns {{ id:string, ordinal:number, startLine:number, endLine:number, text:string, headingPath:string }[]}
 */
export function chunkSection(section) {
  const headingPath = section.headingPath.join(' > ');
  const lines = section.text.split('\n');
  const make = (ordinal, from, to) => ({
    id: `${section.id}~${ordinal}`,
    ordinal,
    startLine: section.startLine + from,
    endLine: section.startLine + to,
    text: lines.slice(from, to + 1).join('\n'),
    headingPath,
  });
  if (section.text.length <= CHUNK_MAX) return [make(0, 0, lines.length - 1)];

  const units = [];
  for (const b of blocks(lines)) {
    const len = lines.slice(b.from, b.to + 1).join('\n').length;
    if (len > CHUNK_MAX) units.push(...splitBlock(lines, b));
    else units.push(b);
  }
  const groups = [];
  let g = null;
  for (const u of units) {
    if (g && lines.slice(g.from, u.to + 1).join('\n').length <= CHUNK_TARGET) g.to = u.to;
    else {
      g = { from: u.from, to: u.to };
      groups.push(g);
    }
  }
  // The first chunk starts at the heading line, so nothing before the first block is lost.
  groups[0].from = 0;
  groups[groups.length - 1].to = lines.length - 1;
  return groups.map((x, i) => make(i, x.from, x.to));
}

/** The text that is embedded: heading path as context, then the chunk, capped. */
export function embedInput(chunk, fallbackTitle = '') {
  return `${chunk.headingPath || fallbackTitle}\n${chunk.text}`.slice(0, EMBED_CAP);
}

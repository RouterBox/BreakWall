import { readFileSync } from 'node:fs';
import { parseMarkdown } from './parse.js';

export function outlineFile(file) {
  const doc = parseMarkdown(readFileSync(file, 'utf8'), file.split('\\').join('/'));
  const lines = [`${doc.title}  (${doc.sections.length} sections, ${doc.lineCount} lines)`];
  for (const s of doc.sections) {
    const label = s.level === 0 ? '(preamble)' : '#'.repeat(s.level) + ' ' + s.heading;
    lines.push(`${'  '.repeat(Math.max(0, s.level - 1))}${label}  [${s.startLine}-${s.endLine}]`);
  }
  return lines.join('\n');
}

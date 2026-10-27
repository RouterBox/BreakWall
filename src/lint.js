// Lint over a loaded corpus. File-based; needs no database.
import { resolveLinks } from './resolve.js';
import { fileExists } from './scan.js';
import { resolveSupersession } from './lifecycle.js';

/** Returns findings { rule, path, line, message }, sorted deterministically. */
export function lintCorpus(corpus) {
  const findings = [];
  const { resolved, dangling } = resolveLinks(corpus, (p) => fileExists(corpus.root, p));

  for (const d of dangling) {
    findings.push({ rule: 'dangling-link', path: d.fromDoc, line: d.line, message: `${d.url} -> ${d.target} (${d.reason})` });
  }

  const sup = resolveSupersession(corpus.docs, new Set(corpus.docs.map((d) => d.path)));
  for (const d of sup.dangling) {
    findings.push({ rule: 'supersession-target', path: d.path, line: 1, message: `frontmatter ${d.field}: "${d.target}" is not a document in this corpus` });
  }

  const inbound = new Set(resolved.filter((r) => r.toDoc !== r.fromDoc).map((r) => r.toDoc));
  for (const doc of corpus.docs) {
    if (!inbound.has(doc.path)) {
      findings.push({ rule: 'orphan', path: doc.path, line: 1, message: 'no other document links to this one' });
    }
    const seen = new Map();
    for (const s of doc.sections) {
      if (s.level === 0) continue;
      const key = s.headingPath.join(' > ');
      if (seen.has(key)) {
        findings.push({ rule: 'duplicate-heading', path: doc.path, line: s.startLine, message: `"${key}" also at line ${seen.get(key)}` });
      } else seen.set(key, s.startLine);
    }
    for (const c of doc.claims) {
      if (c.claimed !== c.counted) {
        findings.push({
          rule: 'count-mismatch',
          path: doc.path,
          line: c.line,
          message: `says "${c.phrase}" but the following ${c.kind} has ${c.counted} ${c.kind === 'table' ? 'rows' : 'items'}`,
        });
      }
    }
  }

  return findings.sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path) || a.line - b.line || a.message.localeCompare(b.message),
  );
}

export function formatLint(findings, docCount) {
  const lines = findings.map((f) => `${f.rule.padEnd(20)} ${f.path}:${f.line}  ${f.message}`);
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  lines.push('', `${docCount} documents, ${findings.length} findings: ${summary}`);
  return lines.join('\n');
}

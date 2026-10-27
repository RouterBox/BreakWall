// Pure link resolution over a loaded corpus. Deterministic; the only I/O is the injected exists().
import { posix } from 'node:path';

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i; // http:, https:, mailto:, ...

/**
 * Returns { resolved, dangling }.
 * resolved: { fromSectionId, fromDoc, kind, url, text, line, toDoc, toSection|null }
 * dangling: { fromSectionId, fromDoc, kind, url, text, line, target, reason }
 * External URLs, links that leave the corpus root, and links to existing
 * non-markdown files are neither: they cannot be judged by the corpus.
 */
export function resolveLinks(corpus, exists) {
  const byPath = new Map(corpus.docs.map((d) => [d.path, d]));
  const byBase = new Map();
  for (const d of corpus.docs) {
    const key = posix.basename(d.path).replace(/\.md$/i, '').toLowerCase();
    byBase.set(key, [...(byBase.get(key) || []), d]);
  }
  const resolved = [];
  const dangling = [];

  for (const doc of corpus.docs) {
    for (const l of doc.links) {
      const base = { fromSectionId: l.fromSectionId, fromDoc: doc.path, kind: l.kind, url: l.url, text: l.text, line: l.line };
      if (l.kind === 'link' && EXTERNAL.test(l.url)) continue;

      let [target, anchor] = splitAnchor(l.url);
      let targetDoc;
      if (l.kind === 'wikilink') {
        const hits = byBase.get(posix.basename(target).replace(/\.md$/i, '').toLowerCase()) || [];
        if (hits.length !== 1) {
          dangling.push({ ...base, target, reason: hits.length ? 'ambiguous-wikilink' : 'missing-file' });
          continue;
        }
        targetDoc = hits[0];
      } else if (target === '') {
        targetDoc = doc; // "#anchor" within the same file
      } else {
        target = safeDecode(target);
        const full = target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(doc.path), target);
        const norm = posix.normalize(full).replace(/\/$/, '');
        if (norm.startsWith('..')) continue; // outside the corpus root
        targetDoc = byPath.get(norm);
        if (!targetDoc) {
          if (!/\.md$/i.test(norm) && exists(norm)) continue; // exists on disk, just not markdown
          dangling.push({ ...base, target: norm, reason: 'missing-file' });
          continue;
        }
      }

      let toSection = null;
      if (anchor) {
        const a = safeDecode(anchor).toLowerCase();
        toSection = targetDoc.sections.find((s) => s.slug === a) || null;
        if (!toSection) {
          dangling.push({ ...base, target: `${targetDoc.path}#${anchor}`, reason: 'missing-anchor' });
          continue;
        }
      }
      resolved.push({ ...base, toDoc: targetDoc.path, toSection: toSection ? toSection.id : null });
    }
  }
  return { resolved, dangling };
}

function splitAnchor(url) {
  const i = url.indexOf('#');
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
}
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Citation strings for the Undertow bridge (plan item 53). Pure: no database, no filesystem.
// bw:<corpus>:<path>#<heading path>@<commit8>   - names a section by path and heading, pins a version, carries no content.
export const COMMIT_LEN = 8;

export function formatCitation({ corpus, path, headingPath = '', commit = null }) {
  if (!corpus || !path) throw new Error('a citation needs a corpus and a path');
  const heading = Array.isArray(headingPath) ? headingPath.join(' > ') : headingPath || '';
  return `bw:${corpus}:${path}${heading ? '#' + heading : ''}${commit ? '@' + String(commit).slice(0, COMMIT_LEN) : ''}`;
}

/** Inverse of formatCitation. The commit is the trailing @hex (7-40 chars); headings may contain '#' or '@'. */
export function parseCitation(text) {
  const m = /^bw:([^:]+):(.+)$/s.exec(String(text).trim());
  if (!m) throw new Error(`not a BreakWall citation (expected bw:<corpus>:<path>#<heading>@<commit>): ${text}`);
  let rest = m[2];
  let commit = null;
  const c = /@([0-9a-f]{7,40})$/.exec(rest);
  if (c) {
    commit = c[1];
    rest = rest.slice(0, c.index);
  }
  const h = rest.indexOf('#');
  const path = h === -1 ? rest : rest.slice(0, h);
  const headingPath = h === -1 ? '' : rest.slice(h + 1);
  if (!path) throw new Error(`citation has no path: ${text}`);
  return { corpus: m[1], path, headingPath, commit };
}

/** Compare a parsed citation with what the index holds now. cur = { docExists, deleted, sectionExists, commit }. */
export function judgeCitation(cited, cur) {
  if (!cur.docExists) return { status: 'unknown', note: 'no such document in the index (it may never have existed, or it was renamed; try `breakwall history`)' };
  if (cur.deleted) return { status: 'deleted', note: 'the document was removed from the corpus (tombstoned); its text is still readable with --include-deleted' };
  if (cited.headingPath && !cur.sectionExists) return { status: 'heading-missing', note: 'the document exists but no section has that heading path any more (renamed or restructured)' };
  if (cited.commit && cur.commit) {
    const n = Math.min(cited.commit.length, String(cur.commit).length);
    if (cited.commit.slice(0, n) !== String(cur.commit).slice(0, n)) {
      return { status: 'changed', note: `the document was committed again since the citation (cited ${cited.commit.slice(0, COMMIT_LEN)}, now ${String(cur.commit).slice(0, COMMIT_LEN)}); re-read the section before relying on it` };
    }
  }
  return { status: 'ok', note: 'the cited section exists and the document has not been committed since' };
}

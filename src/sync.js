// Pure change detection for incremental sync: rename matching (PLAN item 24).
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export const RENAME_MIN_HEADINGS = 3;
export const RENAME_MIN_SIMILARITY = 0.6;

/** Lowercased heading texts of levels 2+. The level-1 title is left out because retitling is the commonest edit. */
export const headingSet = (sections) => new Set(sections.filter((s) => s.level >= 2).map((s) => s.heading.trim().toLowerCase()));

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * gone:  [{ path, hash, headings:Set }]  indexed documents that are no longer on disk
 * fresh: [{ path, hash, headings:Set }]  files on disk that were never indexed
 * Returns [{ from, to, by: 'hash'|'structure', score }], one-to-one, deterministic.
 */
export function matchRenames(gone, fresh) {
  const pairs = [];
  const usedGone = new Set();
  const usedFresh = new Set();

  // 1. identical content. Same basename pairs first, then path order.
  for (const f of [...fresh].sort((a, b) => cmp(a.path, b.path))) {
    const cands = gone.filter((g) => g.hash === f.hash && !usedGone.has(g.path)).sort((a, b) => cmp(a.path, b.path));
    if (!cands.length) continue;
    const g = cands.find((x) => posix.basename(x.path) === posix.basename(f.path)) || cands[0];
    usedGone.add(g.path);
    usedFresh.add(f.path);
    pairs.push({ from: g.path, to: f.path, by: 'hash', score: 1 });
  }

  // 2. edited while moving: similar heading structure.
  const scored = [];
  for (const g of gone) {
    if (usedGone.has(g.path) || g.headings.size < RENAME_MIN_HEADINGS) continue;
    for (const f of fresh) {
      if (usedFresh.has(f.path) || f.headings.size < RENAME_MIN_HEADINGS) continue;
      const score = jaccard(g.headings, f.headings);
      if (score >= RENAME_MIN_SIMILARITY) scored.push({ from: g.path, to: f.path, by: 'structure', score });
    }
  }
  scored.sort((a, b) => b.score - a.score || cmp(a.from, b.from) || cmp(a.to, b.to));
  for (const p of scored) {
    if (usedGone.has(p.from) || usedFresh.has(p.to)) continue;
    usedGone.add(p.from);
    usedFresh.add(p.to);
    pairs.push(p);
  }
  return pairs.sort((a, b) => cmp(a.to, b.to));
}

/** Stable document identity: set once, when a path is first indexed, and carried across renames. */
export const newUid = (corpus, firstPath) => createHash('sha256').update(`${corpus}\n${firstPath}`).digest('hex').slice(0, 12);

export const parseEvents = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

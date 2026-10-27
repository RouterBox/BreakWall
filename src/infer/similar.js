// SIMILAR_TO pass: top-k nearest sections of other documents by cosine over the chunk vectors that are already stored.
// Pure and offline: it receives vectors, never an embedder, so it cannot call one (plan item 34).
export const SIMILAR = {
  k: 3,
  threshold: 0.7, // chosen from the data by inspecting sampled pairs, not from the eval set; see PLAN item 39
  minBodyChars: 120, // heading-only and stub sections are not compared (their vectors are mostly the heading)
};

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const dot = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};

/**
 * sections: [{ id, docId, bodyLen }]; chunks: [{ sectionId, embedding }].
 * Section similarity = max cosine over the pairs of their chunks. Same-document pairs are skipped (they are
 * already related by structure). Returns every eligible section's candidate list too, for threshold inspection.
 */
export function sectionNeighbours(sections, chunks, { minBodyChars = SIMILAR.minBodyChars } = {}) {
  const vecs = new Map();
  for (const c of chunks) {
    if (!vecs.has(c.sectionId)) vecs.set(c.sectionId, []);
    vecs.get(c.sectionId).push(c.embedding);
  }
  const elig = sections.filter((s) => s.bodyLen >= minBodyChars && vecs.has(s.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const cand = new Map(elig.map((s) => [s.id, []]));
  for (let i = 0; i < elig.length; i++) {
    for (let j = i + 1; j < elig.length; j++) {
      const a = elig[i];
      const b = elig[j];
      if (a.docId === b.docId) continue;
      let best = -2;
      for (const va of vecs.get(a.id)) for (const vb of vecs.get(b.id)) best = Math.max(best, dot(va, vb));
      const sim = round6(best);
      cand.get(a.id).push({ id: b.id, score: sim });
      cand.get(b.id).push({ id: a.id, score: sim });
    }
  }
  for (const list of cand.values()) list.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
  return { eligible: elig.length, candidates: cand };
}

export function similarEdges(sections, chunks, params = SIMILAR) {
  const { eligible, candidates } = sectionNeighbours(sections, chunks, params);
  const edges = new Map();
  for (const [id, list] of candidates) {
    for (const n of list.slice(0, params.k)) {
      if (n.score < params.threshold) break;
      const [a, b] = id < n.id ? [id, n.id] : [n.id, id];
      edges.set(`${a}\u0000${b}`, { a, b, score: n.score });
    }
  }
  const out = [...edges.values()].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return { edges: out, eligible };
}

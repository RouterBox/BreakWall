// Louvain community detection, deterministic: no randomness anywhere. Nodes are visited in sorted-id order,
// candidate communities are compared in ascending index order, ties go to the lowest index, and a move needs a
// strictly positive modularity gain, so the same graph always gives the same partition (plan item 34).

/** nodes: sorted array of ids; edges: [{ a, b, w }] undirected (a != b). Returns { community: Map(id -> index), modularity, levels }. */
export function louvain(nodeIds, edges, { resolution = 1, maxLevels = 10 } = {}) {
  const ids = [...nodeIds].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  let n = ids.length;
  let adj = Array.from({ length: n }, () => new Map());
  let m2 = 0; // 2m: total weight counting each undirected edge twice
  for (const e of edges) {
    const a = index.get(e.a);
    const b = index.get(e.b);
    if (a === undefined || b === undefined || a === b || !(e.w > 0)) continue;
    adj[a].set(b, (adj[a].get(b) || 0) + e.w);
    adj[b].set(a, (adj[b].get(a) || 0) + e.w);
    m2 += 2 * e.w;
  }
  const origToCur = Array.from({ length: n }, (_, i) => i); // original node -> node of the current level
  if (m2 === 0) return { community: new Map(ids.map((id, i) => [id, i])), modularity: 0, levels: 0 };
  const total = m2;
  let levels = 0;

  for (; levels < maxLevels; levels++) {
    const deg = adj.map((nb) => [...nb.values()].reduce((s, x) => s + x, 0)); // includes self loops counted once per direction
    const comm = Array.from({ length: n }, (_, i) => i);
    const tot = deg.slice();
    let improved = false;
    for (let pass = 0; pass < 100; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const own = comm[i];
        const links = new Map(); // community -> weight from i into it (excluding self loop)
        for (const [j, w] of [...adj[i].entries()].sort((x, y) => x[0] - y[0])) {
          if (j === i) continue;
          links.set(comm[j], (links.get(comm[j]) || 0) + w);
        }
        tot[own] -= deg[i];
        const gain = (c) => (links.get(c) || 0) - (resolution * tot[c] * deg[i]) / total;
        let best = own;
        let bestGain = gain(own);
        for (const c of [...links.keys()].sort((x, y) => x - y)) {
          const g = gain(c);
          if (g > bestGain + 1e-12) {
            best = c;
            bestGain = g;
          }
        }
        tot[best] += deg[i];
        if (best !== own) {
          comm[i] = best;
          moved = true;
          improved = true;
        }
      }
      if (!moved) break;
    }
    if (!improved) break;
    // Renumber communities by their smallest member, aggregate.
    const renum = new Map();
    for (let i = 0; i < n; i++) if (!renum.has(comm[i])) renum.set(comm[i], renum.size);
    const next = Array.from({ length: renum.size }, () => new Map());
    for (let i = 0; i < n; i++) {
      for (const [j, w] of adj[i]) {
        const a = renum.get(comm[i]);
        const b = renum.get(comm[j]);
        next[a].set(b, (next[a].get(b) || 0) + w);
      }
    }
    for (let o = 0; o < origToCur.length; o++) origToCur[o] = renum.get(comm[origToCur[o]]);
    adj = next;
    n = renum.size;
    if (n === 1) {
      levels++;
      break;
    }
  }
  const community = new Map(ids.map((id, i) => [id, origToCur[i]]));
  return { community, modularity: modularity(ids, index, edges, community, resolution), levels };
}

function modularity(ids, index, edges, community, resolution) {
  let m2 = 0;
  const deg = new Map();
  let inside = 0;
  for (const e of edges) {
    if (!index.has(e.a) || !index.has(e.b) || e.a === e.b || !(e.w > 0)) continue;
    m2 += 2 * e.w;
    deg.set(e.a, (deg.get(e.a) || 0) + e.w);
    deg.set(e.b, (deg.get(e.b) || 0) + e.w);
    if (community.get(e.a) === community.get(e.b)) inside += 2 * e.w;
  }
  if (!m2) return 0;
  const sum = new Map();
  for (const [id, d] of deg) sum.set(community.get(id), (sum.get(community.get(id)) || 0) + d);
  let q = inside / m2;
  for (const s of sum.values()) q -= (resolution * (s / m2) * (s / m2));
  return Math.round(q * 1e6) / 1e6;
}

/**
 * Stable community numbering: communities of 2+ members only, biggest first, ties by smallest member id.
 * Returns [{ n, members: [ids] }] with n starting at 1.
 */
export function numberCommunities(partition, minSize = 2) {
  const groups = new Map();
  for (const [id, c] of partition) {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(id);
  }
  const list = [...groups.values()].filter((g) => g.length >= minSize).map((g) => g.sort());
  list.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  return list.map((members, i) => ({ n: i + 1, members }));
}

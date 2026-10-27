// Pure helpers for the optional layers on top of the markdown structure: frontmatter status and
// supersession (plan section 7), and the optional work-item layer (decision 5). Nothing here needs a
// database; only loadConfig touches the filesystem.
import { posix, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export const CONFIG_FILE = 'breakwall.json';
export const DEFAULT_PHASES = ['spec', 'design', 'build', 'test', 'retro', 'decision'];

const scalar = (v) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(scalar).filter(Boolean);

/** status / supersedes / superseded_by / work-item / phase from parsed frontmatter. All optional. */
export function lifecycleOf(frontmatter) {
  const fm = frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter) ? frontmatter : {};
  return {
    status: scalar(fm.status),
    supersedes: list(fm.supersedes),
    supersededBy: list(fm.superseded_by ?? fm['superseded-by'] ?? fm.supersededBy),
    workItem: scalar(fm['work-item'] ?? fm.work_item ?? fm.workItem),
    phase: scalar(fm.phase),
  };
}

/**
 * Optional `breakwall.json` in the corpus root:
 *   { "workItems": { "idFromPath": "^work/([^/]+)/", "phases": { "spec": "spec", "design": "design" } } }
 * idFromPath: regex over the corpus-relative path, group 1 is the work item id.
 * phases: name -> regex (case-insensitive) over the path; the first match in key order wins.
 * Without the file there is no work-item layer, except documents that name a `work-item:` in frontmatter.
 */
export function loadConfig(root) {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return { workItems: null };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILE}: not valid JSON (${e.message})`);
  }
  const w = raw && raw.workItems;
  if (w === undefined || w === null) return { workItems: null };
  if (typeof w !== 'object' || Array.isArray(w)) throw new Error(`${CONFIG_FILE}: "workItems" must be an object`);
  const compile = (src, what) => {
    try {
      return new RegExp(src, 'i');
    } catch (e) {
      throw new Error(`${CONFIG_FILE}: bad regex for ${what}: ${e.message}`);
    }
  };
  let idFromPath = null;
  if (w.idFromPath !== undefined) {
    if (typeof w.idFromPath !== 'string') throw new Error(`${CONFIG_FILE}: workItems.idFromPath must be a string`);
    idFromPath = compile(w.idFromPath, 'workItems.idFromPath');
    if (new RegExp(`${w.idFromPath}|`).exec('').length < 2) throw new Error(`${CONFIG_FILE}: workItems.idFromPath needs a capture group for the id`);
  }
  const phases = [];
  if (w.phases !== undefined) {
    if (!w.phases || typeof w.phases !== 'object' || Array.isArray(w.phases)) throw new Error(`${CONFIG_FILE}: workItems.phases must be an object of name -> regex`);
    for (const [name, src] of Object.entries(w.phases)) {
      if (typeof src !== 'string') throw new Error(`${CONFIG_FILE}: workItems.phases.${name} must be a regex string`);
      phases.push({ name, re: compile(src, `workItems.phases.${name}`) });
    }
  }
  return { workItems: { idFromPath, phases } };
}

/** { id, phase, source } or null. Frontmatter wins over the path convention. */
export function workItemOf(path, lc, config) {
  const w = config && config.workItems;
  let id = lc.workItem;
  let source = id ? 'frontmatter' : null;
  if (!id && w && w.idFromPath) {
    const m = w.idFromPath.exec(path);
    if (m && m[1]) {
      id = m[1];
      source = 'config';
    }
  }
  if (!id) return null;
  let phase = lc.phase;
  if (!phase && w) phase = (w.phases.find((p) => p.re.test(path)) || {}).name || null;
  return { id, phase: phase || null, source };
}

/** Phase display order: config order, then the default names, then anything else alphabetically; only phases in `seen`. */
export function phaseOrder(config, seen) {
  const order = [...((config && config.workItems && config.workItems.phases) || []).map((p) => p.name), ...DEFAULT_PHASES];
  const known = [...new Set(order)];
  const extra = [...new Set(seen)].filter((p) => p && !known.includes(p)).sort();
  return [...known.filter((p) => seen.includes(p)), ...extra];
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Resolve declared supersession to edges "newer SUPERSEDES older". Only this direction is stored;
 * the inverse is a traversal. `docs` need { path, lifecycle }; `known` is the set of every path that
 * may be a target (live documents plus tombstones).
 * Returns { edges: [{ from, to, declaredIn }], dangling: [{ path, field, target }] }, sorted.
 */
export function resolveSupersession(docs, known) {
  const byBase = new Map();
  for (const p of known) {
    const k = posix.basename(p).replace(/\.md$/i, '').toLowerCase();
    byBase.set(k, [...(byBase.get(k) || []), p]);
  }
  const find = (from, ref) => {
    const clean = ref.split('#')[0].trim();
    if (!clean) return null;
    const rel = posix.normalize(posix.join(posix.dirname(from), clean));
    const abs = posix.normalize(clean.replace(/^\//, ''));
    for (const cand of [rel, abs, `${rel}.md`, `${abs}.md`]) if (known.has(cand)) return cand;
    const hits = byBase.get(posix.basename(clean).replace(/\.md$/i, '').toLowerCase()) || [];
    return hits.length === 1 ? hits[0] : null;
  };
  const seen = new Map();
  const dangling = [];
  const add = (from, to, declaredIn) => {
    if (from === to) return;
    const k = `${from}\n${to}`;
    if (!seen.has(k)) seen.set(k, { from, to, declaredIn });
  };
  for (const d of docs) {
    for (const ref of d.lifecycle.supersedes) {
      const t = find(d.path, ref);
      if (t) add(d.path, t, d.path);
      else dangling.push({ path: d.path, field: 'supersedes', target: ref });
    }
    for (const ref of d.lifecycle.supersededBy) {
      const t = find(d.path, ref);
      if (t) add(t, d.path, d.path);
      else dangling.push({ path: d.path, field: 'superseded_by', target: ref });
    }
  }
  return {
    edges: [...seen.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
    dangling: dangling.sort((a, b) => cmp(a.path, b.path) || cmp(a.field, b.field) || cmp(a.target, b.target)),
  };
}

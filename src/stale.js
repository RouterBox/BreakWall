// Staleness report (plan section 7, item 52). Report only: nothing is ranked down, hidden or decayed.
// Cheap and read-only: no embedder, no graph write; one pass over the files, a handful of read queries and one `git log`.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listMarkdown, loadCorpus } from './scan.js';
import { sha256 } from './parse.js';
import { lintCorpus } from './lint.js';
import { ToolError } from './tools.js';

export const CLAIM_RULES = ['count-mismatch', 'dangling-link', 'supersession-target'];
export const STALE_DEFAULTS = { days: 90, recentDays: 14 };
const DAY = 864e5;

async function rows(driver, query, params = {}) {
  const s = driver.session();
  try {
    return (await s.run(query, params)).records.map((r) => Object.fromEntries(r.keys.map((k) => [k, r.get(k)])));
  } finally {
    await s.close();
  }
}

/** path -> epoch ms of the last commit that touched it (one git log), else file mtime. */
export function touchTimes(root, paths) {
  const out = new Map();
  try {
    const log = execFileSync('git', ['log', '--relative', '--name-only', '--format=@@%ct', '--', '.'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    let t = null;
    for (const line of log.split(/\r?\n/)) {
      if (line.startsWith('@@')) t = Number(line.slice(2)) * 1000;
      else if (line && t !== null && !out.has(line)) out.set(line, { at: t, by: 'git' });
    }
  } catch {
    /* not a git repository: fall back to mtimes below */
  }
  for (const p of paths) {
    if (!out.has(p)) {
      try {
        out.set(p, { at: statSync(join(root, p)).mtimeMs, by: 'mtime' });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

/** Pure: the four lists from plain inputs, so it can be tested without a database. */
export function buildStale({ now, days, recentDays, indexed, disk, sectionDiff, supersessions, links, touched, claims }) {
  const changed = [];
  for (const [path, d] of disk) {
    const ix = indexed.get(path);
    if (!ix) changed.push({ path, kind: 'added', note: 'on disk, not indexed yet' });
    else if (ix.hash !== d.hash) changed.push({ path, kind: 'changed', sections: sectionDiff.get(path) || [] });
  }
  for (const [path, ix] of indexed) if (!ix.deleted && !disk.has(path)) changed.push({ path, kind: 'removed', note: 'indexed, no longer on disk (a sync will tombstone it, or detect a rename)' });
  changed.sort((a, b) => a.path.localeCompare(b.path));

  const superseded = supersessions
    .map((s) => ({ path: s.older, supersededBy: s.newers.slice().sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const recent = new Set();
  for (const [p, t] of touched) if (now - t.at <= recentDays * DAY) recent.add(p);
  const byTarget = new Map();
  for (const l of links) {
    if (l.from === l.to || !recent.has(l.from)) continue;
    const t = touched.get(l.to);
    if (!t || now - t.at <= days * DAY) continue;
    if (!byTarget.has(l.to)) byTarget.set(l.to, new Set());
    byTarget.get(l.to).add(l.from);
  }
  const untouched = [...byTarget.entries()]
    .map(([path, from]) => ({ path, daysSinceTouched: Math.floor((now - touched.get(path).at) / DAY), touchedBy: touched.get(path).by, linkedFromRecentlyChanged: [...from].sort() }))
    .sort((a, b) => b.daysSinceTouched - a.daysSinceTouched || a.path.localeCompare(b.path));

  return {
    parameters: { days, recentDays },
    changedSinceIndex: changed,
    superseded,
    linkedFromRecentButUntouched: untouched,
    claimsLintFlags: claims,
    counts: { changedSinceIndex: changed.length, superseded: superseded.length, linkedFromRecentButUntouched: untouched.length, claimsLintFlags: claims.length },
  };
}

export async function toolStale(driver, corpus, { days = STALE_DEFAULTS.days, recentDays = STALE_DEFAULTS.recentDays, now = Date.now() } = {}) {
  const root = (await rows(driver, 'MATCH (c:Corpus {id: $c}) RETURN c.root AS root', { c: corpus }))[0]?.root;
  if (!root || !existsSync(root)) throw new ToolError(`corpus root ${root || '(unknown)'} is not on this machine; staleness compares the files with the index, so it cannot run`);

  const indexed = new Map((await rows(driver, 'MATCH (d:Document {corpus: $c}) RETURN d.path AS path, d.hash AS hash, d.deleted AS deleted', { c: corpus })).map((r) => [r.path, { hash: r.hash, deleted: r.deleted === true }]));
  const sections = await rows(driver, 'MATCH (s:Section {corpus: $c}) WHERE s.deleted IS NULL RETURN s.path AS path, s.headingPath AS hp, s.hash AS hash', { c: corpus });
  const sectionsByDoc = new Map();
  for (const s of sections) {
    if (!sectionsByDoc.has(s.path)) sectionsByDoc.set(s.path, new Map());
    sectionsByDoc.get(s.path).set(s.hp, s.hash);
  }
  const sup = await rows(driver, 'MATCH (n:Document {corpus: $c})-[:SUPERSEDES]->(o:Document) WHERE n.deleted IS NULL AND o.deleted IS NULL RETURN o.path AS older, collect(DISTINCT n.path) AS newers', { c: corpus });
  const links = await rows(driver, 'MATCH (a:Section {corpus: $c})-[:LINKS_TO]->(t) WHERE a.deleted IS NULL AND t.path IS NOT NULL RETURN DISTINCT a.path AS from, t.path AS to', { c: corpus });

  // Files: hash every file; parse (for section-level diffs and lint) only what is needed.
  const paths = listMarkdown(root);
  const disk = new Map();
  for (const p of paths) disk.set(p, { hash: sha256(readFileSync(join(root, p), 'utf8')) });
  const loaded = loadCorpus(root, corpus, { git: false });
  const sectionDiff = new Map();
  for (const doc of loaded.docs) {
    const ix = indexed.get(doc.path);
    if (!ix || ix.hash === disk.get(doc.path).hash) continue;
    const old = sectionsByDoc.get(doc.path) || new Map();
    const now2 = new Map(doc.sections.map((s) => [s.headingPath.join(' > '), s.hash]));
    const diff = [];
    for (const [hp, h] of now2) {
      if (!old.has(hp)) diff.push({ headingPath: hp, change: 'added' });
      else if (old.get(hp) !== h) diff.push({ headingPath: hp, change: 'changed' });
    }
    for (const hp of old.keys()) if (!now2.has(hp)) diff.push({ headingPath: hp, change: 'removed' });
    sectionDiff.set(doc.path, diff.sort((a, b) => a.headingPath.localeCompare(b.headingPath)));
  }
  const claims = lintCorpus(loaded).filter((f) => CLAIM_RULES.includes(f.rule));
  const touched = touchTimes(root, paths);

  const report = buildStale({ now, days, recentDays, indexed, disk, sectionDiff, supersessions: sup, links, touched, claims });
  return { corpus, root, documents: paths.length, ...report, note: 'report only: nothing is down-ranked, hidden or decayed (plan section 7)' };
}

export function formatStale(r) {
  const L = [];
  const head = (t, n) => L.push('', `${t}: ${n}`);
  L.push(`corpus ${r.corpus}: ${r.documents} documents on disk; days=${r.parameters.days}, recent-days=${r.parameters.recentDays}`);
  head('Source changed since the last index (run `breakwall sync` to refresh)', r.counts.changedSinceIndex);
  for (const c of r.changedSinceIndex) {
    L.push(`  ${c.kind.padEnd(7)} ${c.path}${c.note ? '  (' + c.note + ')' : ''}`);
    for (const s of c.sections || []) L.push(`          ${s.change.padEnd(7)} ${s.headingPath || '(preamble)'}`);
  }
  head('Superseded by a newer document', r.counts.superseded);
  for (const s of r.superseded) L.push(`  ${s.path}  <- ${s.supersededBy.join(', ')}`);
  head(`Untouched for over ${r.parameters.days} days but linked from a document changed in the last ${r.parameters.recentDays} days`, r.counts.linkedFromRecentButUntouched);
  for (const u of r.linkedFromRecentButUntouched) L.push(`  ${u.path}  (${u.daysSinceTouched} days, by ${u.touchedBy})  <- ${u.linkedFromRecentlyChanged.join(', ')}`);
  head('Claims that lint flags', r.counts.claimsLintFlags);
  for (const f of r.claimsLintFlags) L.push(`  ${f.rule.padEnd(20)} ${f.path}:${f.line}  ${f.message}`);
  return L.join('\n');
}

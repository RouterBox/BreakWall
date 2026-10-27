// Core of the ambient UserPromptSubmit hook (plan items 49-51). Deliberately light: node built-ins, fetch and two
// pure modules. It must NOT import neo4j-driver, the embedder or anything that does: that alone costs more than the
// one-second budget (plan item 48). Never throws to the caller; every failure is a silent "no output".
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, parse as parsePath } from 'node:path';
import { tmpdir } from 'node:os';
import { luceneQuery } from './luceneq.js';
import { formatCitation } from './cite.js';

export const MARKER = '.breakwall.json';
export const HOOK_DEFAULTS = {
  limit: 3,
  maxTokens: 400, // characters / 4; Undertow keeps its own flashes small, see PLAN item 51
  minBm25: 9.341, // M2 lexical gate (eval/results-m2.md); provisional, calibrated on one corpus
  minChars: 25,
  minWords: 4,
  snippetChars: 350,
  markerLevels: 8,
  maxSeen: 200,
  depth: 200, // lexical candidates fetched before filtering to the corpus (index is shared by all corpora)
};

const CYPHER = `CALL db.index.fulltext.queryNodes('chunk_text', $q, {limit: $depth}) YIELD node, score
WHERE node.corpus = $c
WITH node, score ORDER BY score DESC, node.id ASC LIMIT 20
OPTIONAL MATCH (d:Document {id: $c + ':' + node.path})
OPTIONAL MATCH (n:Document)-[:SUPERSEDES]->(d)
WHERE n.deleted IS NULL
WITH node, score, d, collect(n.path) AS newer
RETURN node.sectionId AS sectionId, node.path AS path, node.headingPath AS headingPath, node.startLine AS startLine,
       node.endLine AS endLine, node.text AS text, node.commit AS commit, score, d.status AS status, newer
ORDER BY score DESC, node.id ASC`;

/** Nearest .breakwall.json in cwd or a parent. Returns { file, config } or null. Throws nothing. */
export function findMarker(cwd, levels = HOOK_DEFAULTS.markerLevels) {
  try {
    let dir = resolve(cwd);
    const root = parsePath(dir).root;
    for (let i = 0; i < levels; i++) {
      const f = join(dir, MARKER);
      if (existsSync(f)) {
        const config = JSON.parse(readFileSync(f, 'utf8'));
        return config && typeof config === 'object' ? { file: f, config } : null;
      }
      if (dir === root) break;
      dir = dirname(dir);
    }
  } catch {
    /* unreadable or invalid marker: treat as not opted in */
  }
  return null;
}

function parseDotenv(file) {
  const out = {};
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* no .env: the request will simply fail and the hook stays silent */
  }
  return out;
}

/** Connection settings: process env wins over the repo's git-ignored .env. BREAKWALL_NEO4J_HTTP exists so tests can point at a dead port. */
export function connection(repoRoot, env = process.env) {
  const file = parseDotenv(join(repoRoot, '.env'));
  const pick = (k) => env[k] ?? file[k];
  return {
    base: (env.BREAKWALL_NEO4J_HTTP || pick('NEO4J_HTTP') || 'http://127.0.0.1:7475').replace(/\/$/, ''),
    user: pick('NEO4J_USER') || 'neo4j',
    password: pick('NEO4J_PASSWORD') || '',
  };
}

export function skipPrompt(prompt, cfg) {
  const p = String(prompt || '').trim();
  if (!p) return 'empty prompt';
  if (p.startsWith('/')) return 'slash command';
  if (p.length < cfg.minChars) return 'short prompt';
  if (p.split(/\s+/).length < cfg.minWords) return 'short prompt';
  return null;
}

const clip = (text, n) => {
  if (text.length <= n) return text;
  const cut = text.slice(0, Math.max(0, n - 4)); // the " ..." marker counts toward n
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + ' ...';
};

const bodyOf = (text) => (text || '').replace(/^#{1,6}\s.*\n?/, '').replace(/\s+/g, ' ').trim() || (text || '').replace(/\s+/g, ' ').trim();

/**
 * Pure: query rows -> { text, hits } or null. rows are the Cypher result objects, best score first.
 * Collapses chunks to sections, applies the BM25 gate to every hit, drops sections already injected this session,
 * and keeps the whole text within maxTokens * 4 characters.
 */
export function buildContext(rows, { corpus, cfg, seen = new Set() }) {
  const bySection = new Map();
  for (const r of rows) if (!bySection.has(r.sectionId)) bySection.set(r.sectionId, r); // rows are score-ordered: first chunk is the best
  const gated = [...bySection.values()].filter((r) => r.score >= cfg.minBm25);
  const fresh = gated.filter((r) => !seen.has(r.sectionId)).slice(0, cfg.limit);
  if (!fresh.length) return { text: null, hits: [], gated: gated.length };

  const cap = cfg.maxTokens * 4;
  const head = `BreakWall reference (corpus ${corpus}; verbatim lexical matches, not summaries; cite as shown, full text via breakwall_get):`;
  let text = head;
  const hits = [];
  for (const [i, r] of fresh.entries()) {
    const cite = formatCitation({ corpus, path: r.path, headingPath: r.headingPath, commit: r.commit });
    const flags = [];
    if (r.newer && r.newer.length) flags.push(`SUPERSEDED by ${r.newer.join(', ')}`);
    if (r.status && /^(superseded|deprecated|obsolete)/i.test(r.status)) flags.push(`status: ${r.status}`);
    const lead = `\n[${i + 1}] ${cite} (lines ${r.startLine}-${r.endLine})${flags.length ? ' [' + flags.join('; ') + ']' : ''}\n`;
    const room = cap - text.length - lead.length - 2;
    if (room < 80) break;
    const snippet = clip(bodyOf(r.text), Math.min(cfg.snippetChars, room));
    text += lead + `"${snippet}"`;
    hits.push({ sectionId: r.sectionId, path: r.path, headingPath: r.headingPath, score: r.score });
  }
  if (!hits.length) return { text: null, hits: [], gated: gated.length };
  return { text, hits, gated: gated.length };
}

function stateFile(env, sessionId) {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,80}$/.test(String(sessionId))) return null;
  return join(env.BREAKWALL_HOOK_STATE_DIR || join(tmpdir(), 'breakwall-hook'), `${sessionId}.json`);
}

function readSeen(file) {
  try {
    return new Set(JSON.parse(readFileSync(file, 'utf8')).seen || []);
  } catch {
    return new Set();
  }
}

function writeSeen(file, seen, max) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ seen: [...seen].slice(-max) }));
    // housekeeping: forget sessions untouched for a week
    for (const f of readdirSync(dirname(file))) {
      const p = join(dirname(file), f);
      if (Date.now() - statSync(p).mtimeMs > 7 * 864e5) unlinkSync(p);
    }
  } catch {
    /* habituation is best effort */
  }
}

/**
 * The whole hook. input = the raw stdin text. Returns { output: string|null, reason }.
 * output is the exact stdout (one JSON line) or null for "print nothing".
 */
export async function runHook(input, { repoRoot, env = process.env, fetchImpl = fetch, deadlineMs = 800 } = {}) {
  try {
    let evt;
    try {
      evt = JSON.parse(input);
    } catch {
      return { output: null, reason: 'unparseable stdin' };
    }
    if (!evt || typeof evt !== 'object') return { output: null, reason: 'bad stdin' };
    if (evt.hook_event_name && evt.hook_event_name !== 'UserPromptSubmit') return { output: null, reason: 'not UserPromptSubmit' };
    if (env.BREAKWALL_AMBIENT === '0') return { output: null, reason: 'disabled by BREAKWALL_AMBIENT=0' };

    const marker = findMarker(evt.cwd || process.cwd());
    if (!marker) return { output: null, reason: 'project not opted in (no .breakwall.json)' };
    const mc = marker.config;
    if (mc.ambient === false) return { output: null, reason: 'ambient: false in marker' };
    if (typeof mc.corpus !== 'string' || !mc.corpus) return { output: null, reason: 'marker names no corpus' };
    const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const cfg = {
      ...HOOK_DEFAULTS,
      limit: num(mc.limit, HOOK_DEFAULTS.limit, 1, 5),
      maxTokens: num(mc.maxTokens, HOOK_DEFAULTS.maxTokens, 50, 1000),
      minBm25: num(mc.minBm25, HOOK_DEFAULTS.minBm25, 0, 1000),
      minChars: num(mc.minChars, HOOK_DEFAULTS.minChars, 1, 500),
    };

    const skip = skipPrompt(evt.prompt, cfg);
    if (skip) return { output: null, reason: skip };
    const q = luceneQuery(String(evt.prompt));
    if (!q) return { output: null, reason: 'no searchable words' };

    const conn = connection(repoRoot, env);
    const res = await fetchImpl(`${conn.base}/db/neo4j/query/v2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Basic ' + Buffer.from(`${conn.user}:${conn.password}`).toString('base64') },
      body: JSON.stringify({ statement: CYPHER, parameters: { q, c: mc.corpus, depth: cfg.depth } }),
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!res.ok) return { output: null, reason: `neo4j answered ${res.status}` };
    const j = await res.json();
    if (!j || !j.data || !Array.isArray(j.data.values)) return { output: null, reason: 'unexpected neo4j response' };
    const rows = j.data.values.map((v) => Object.fromEntries(j.data.fields.map((f, i) => [f, v[i]])));

    const sf = stateFile(env, evt.session_id);
    const seen = sf ? readSeen(sf) : new Set();
    const ctx = buildContext(rows, { corpus: mc.corpus, cfg, seen });
    if (!ctx.text) return { output: null, reason: ctx.gated ? 'only already-injected sections' : `below the BM25 gate (${cfg.minBm25})`, top: rows[0] ? rows[0].score : null };
    if (sf) {
      for (const h of ctx.hits) seen.add(h.sectionId);
      writeSeen(sf, seen, cfg.maxSeen);
    }
    return {
      output: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.text } }),
      reason: 'injected',
      hits: ctx.hits,
      top: rows[0] ? rows[0].score : null,
    };
  } catch (e) {
    return { output: null, reason: `error: ${e && e.name === 'TimeoutError' ? 'timeout' : e && e.cause && e.cause.code ? e.cause.code : e && e.message}` };
  }
}

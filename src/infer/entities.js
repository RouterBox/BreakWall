// Local, deterministic entity extraction (plan item 32/34). No model, no network, no randomness.
// Pure functions only: sections in, entity table and mentions out. The database layer lives in infer/index.js.
//
// Methods (a mention records the method that found it): backtick, bold, file, endpoint, port, envvar,
// identifier (camelCase / PascalCase / snake_case), name (capitalised words, not at a sentence start).
// A capitalised word that does start a sentence is "weak": it only counts when the same entity was found
// elsewhere by a non-weak mention (so "Wonder does X." counts once "Wonder" exists as an entity).

export const METHODS = ['backtick', 'file', 'endpoint', 'port', 'envvar', 'identifier', 'bold', 'name']; // priority order
export const PARAMS = { minSections: 2, maxSectionFrac: 0.2, maxSpans: 5, minKeyLength: 2 };

const STOP_CAPS = new Set(
  ('a an the this that these those it its if when where what why how which who whom whose and or but nor for so yet with without not no yes each every all any some one two three ' +
    'we you they he she i in on at by to from as is are was were be been being can could will would should may might must do does did also then than only both either neither after before during once ' +
    'note see use used using add run set get here there now new old first second third last next previous today todo example examples step steps phase status however instead because since while ' +
    'such other another more most less least many much few very just still even already always never often sometimes usually typically default optional required').split(/\s+/),
);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'none', 'nil', 'yes', 'no', 'ok', 'and', 'or', 'not', 'get', 'post', 'put', 'delete', 'patch']);

const FILE_EXT = '(?:md|js|mjs|cjs|ts|tsx|jsx|json|jsonl|py|sh|ps1|yml|yaml|toml|env|txt|html|css|cypher|sql|log|png|jpg|csv)';
const RE_FILE = new RegExp(`(?<![\\w@:/.~-])((?:\\.{1,2}/|~/)?(?:[\\w.-]+/)*[\\w-][\\w.-]*\\.${FILE_EXT})(?![\\w/-])`, 'g');
const RE_ENDPOINT_VERB = /\b(GET|POST|PUT|DELETE|PATCH)\s+(\/[\w\-./:{}*]*)/g;
const RE_URL_PATH = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?(\/[\w\-./:{}*]+)/g;
const RE_PORT_HOST = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g;
const RE_PORT_WORD = /\bports?\s+(\d{2,5})\b/gi;
const RE_ENVVAR = /(?<![\w])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![\w])/g;
const RE_CAMEL = /(?<![\w])([a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)(?![\w])/g;
const RE_PASCAL = /(?<![\w])((?:[A-Z][a-z0-9]+){2,})(?![\w])/g;
const RE_SNAKE = /(?<![\w])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w])/g;
const RE_CAPRUN = /(?<![\w])[A-Z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?: [A-Z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*){0,3}(?![\w])/g;

/** Canonical key: the identity two surface forms must share to be merged (plan item 34). */
export function canonKey(surface, type = 'term') {
  let s = String(surface).trim();
  if (type === 'file') return s.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (type === 'endpoint') return s.toLowerCase().replace(/[.,;:)]+$/, '').replace(/(.)\/+$/, '$1');
  if (type === 'port') return `port ${s.replace(/\D/g, '')}`;
  s = s.replace(/\(\)$/, '').replace(/['’]s\b/g, '');
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2'); // camelCase / PascalCase -> words
  s = s.toLowerCase().replace(/[_\-./\s]+/g, ' ').replace(/[^\p{L}\p{N} ]+/gu, '').trim();
  s = s.replace(/^(the|a|an) /, '');
  const words = s.split(' ').filter(Boolean);
  if (!words.length) return '';
  const last = words[words.length - 1];
  if (/ies$/.test(last) && last.length > 4) words[words.length - 1] = last.slice(0, -3) + 'y';
  else if (/[^su]s$/.test(last) && last.length > 3) words[words.length - 1] = last.slice(0, -1);
  return words.join(' ');
}

const wordCount = (s) => s.trim().split(/\s+/).length;

/** What kind of thing does the inside of a backtick span look like? */
function classifyCode(c) {
  let m;
  if ((m = /^(GET|POST|PUT|DELETE|PATCH)\s+(\/\S*)$/.exec(c))) return { type: 'endpoint', surface: m[2] };
  if (/^\/[\w\-./:{}*]+$/.test(c) && !new RegExp(`\\.${FILE_EXT}$`).test(c)) return { type: 'endpoint', surface: c };
  if (new RegExp(`^[\\w./\\\\~-]+\\.${FILE_EXT}$`).test(c)) return { type: 'file', surface: c };
  if ((m = /^(?:[\w.-]+):(\d{2,5})$/.exec(c))) return { type: 'port', surface: m[1] };
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(c)) return { type: 'envvar', surface: c };
  if (/^(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+|(?:[A-Z][a-z0-9]+){2,}|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\(\))?$/.test(c)) return { type: 'identifier', surface: c };
  return { type: 'term', surface: c };
}

/** Is the text before a word the start of a sentence, a list item or a line (but not a table cell)? */
const atSentenceStart = (before) => !/\|\s*$/.test(before) && (/^[\s>*+\-#\d.)]*$/.test(before) || /[.!?:]\s+$/.test(before));

const mask = (s, from, to) => s.slice(0, from) + ' '.repeat(to - from) + s.slice(to);

/** All mentions in one section's text. Positions are 1-based file line and 0-based column within that line. */
export function extractMentions(section) {
  const out = [];
  const lines = section.text.split(/\r?\n/);
  let fence = null;
  lines.forEach((raw, idx) => {
    const line = idx + section.startLine;
    const f = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) fence = null;
      // lines inside a fence are still scanned below, but only by the code-safe patterns
    } else if (f) {
      fence = f[1];
      return;
    }
    const inFence = fence !== null;
    const isHeading = !inFence && /^\s{0,3}#{1,6}\s/.test(raw);
    let work = raw;
    const add = (method, type, surface, col, weak = false, lead = false) => {
      const key = canonKey(surface, type);
      if (key.length < PARAMS.minKeyLength || /^\d+$/.test(key) || LITERALS.has(key) || (type === 'name' && STOP_CAPS.has(key))) return;
      out.push({ key, surface: type === 'port' ? `port ${surface.replace(/\D/g, '')}` : surface.replace(/\(\)$/, ''), method, type, line, col, weak, lead });
    };
    const scan = (re, fn) => {
      re.lastIndex = 0;
      const hits = [];
      let m;
      while ((m = re.exec(work))) hits.push(m);
      for (const h of hits) fn(h);
    };
    // Link targets carry paths that are not mentions: blank them (the link text stays).
    work = work.replace(/\]\(([^)\s]*)\)/g, (m0, u) => '](' + ' '.repeat(u.length) + ')');

    if (!inFence) {
      scan(/`([^`\n]+)`/g, (m) => {
        const c = m[1].trim();
        if (c.length < 2 || c.length > 50 || wordCount(c) > 4) return;
        if (/[=;{}$<>|\\]/.test(c)) return;
        const k = classifyCode(c);
        add('backtick', k.type, k.surface, m.index + 1);
      });
      work = work.replace(/`[^`\n]*`/g, (m0) => ' '.repeat(m0.length)); // do not see code spans again
      scan(/\*\*([^*\n]{2,40})\*\*|__([^_\n]{2,40})__/g, (m) => {
        const c = (m[1] || m[2]).trim().replace(/[:.,;]+$/, '');
        if (!/\p{L}/u.test(c) || wordCount(c) > 3) return;
        add('bold', 'term', c, m.index + 2);
      });
      work = work.replace(/\*\*[^*\n]*\*\*|__[^_\n]*__/g, (m0) => ' '.repeat(m0.length));
    }
    scan(RE_ENDPOINT_VERB, (m) => {
      add('endpoint', 'endpoint', m[2], m.index + m[0].length - m[2].length);
      work = mask(work, m.index, m.index + m[0].length);
    });
    scan(RE_URL_PATH, (m) => add('endpoint', 'endpoint', m[1], m.index + m[0].length - m[1].length));
    scan(RE_PORT_HOST, (m) => add('port', 'port', m[1], m.index));
    scan(RE_PORT_WORD, (m) => add('port', 'port', m[1], m.index));
    work = work.replace(/https?:\/\/\S+/g, (m0) => ' '.repeat(m0.length)); // URLs are not file paths or names (their port and local path were taken above)
    scan(RE_FILE, (m) => {
      add('file', 'file', m[1], m.index);
      work = mask(work, m.index, m.index + m[1].length);
    });
    scan(RE_ENVVAR, (m) => {
      add('envvar', 'envvar', m[1], m.index);
      work = mask(work, m.index, m.index + m[1].length);
    });
    if (inFence) return;
    for (const re of [RE_CAMEL, RE_PASCAL, RE_SNAKE]) {
      scan(re, (m) => {
        add('identifier', 'identifier', m[1], m.index);
        work = mask(work, m.index, m.index + m[1].length);
      });
    }
    if (isHeading) return; // title-case headings are not evidence of names
    scan(RE_CAPRUN, (m) => {
      const words = m[0].split(' ');
      let off = m.index;
      while (words.length && STOP_CAPS.has(words[0].toLowerCase())) {
        off += words[0].length + 1;
        words.shift();
      }
      while (words.length && STOP_CAPS.has(words[words.length - 1].toLowerCase())) words.pop();
      if (!words.length) return;
      let weak = false;
      if (words.length === 1) {
        weak = atSentenceStart(work.slice(0, off));
      }
      add('name', 'name', words.join(' '), off, weak, words.length > 1 && atSentenceStart(work.slice(0, off)));
    });
  });
  return out;
}

const METHOD_RANK = Object.fromEntries(METHODS.map((m, i) => [m, i]));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the entity table for a set of sections.
 * sections: [{ id, docId, startLine, text }], aliasTable: { alias: canonicalName } (explicit, optional).
 * Returns { entities: [{ key, name, type, aliases:[{surface,count}], sectionDf, docDf, idf, mentions }],
 *           mentions: Map(sectionId -> [{ key, method, methods, count, tf, idf, score, spans }]), dropped, sectionsTotal }
 */
export function buildEntities(sections, { aliasTable = {}, params = PARAMS } = {}) {
  const N = sections.length;
  const explicit = new Map();
  for (const [alias, canon] of Object.entries(aliasTable)) explicit.set(canonKey(alias), canonKey(canon));
  const remap = (key) => explicit.get(key) ?? key;

  const raw = [];
  for (const s of sections) for (const m of extractMentions(s)) raw.push({ sectionId: s.id, docId: s.docId, ...m, key: remap(m.key) });

  // How the corpus uses ordinary lower-case words, and how often a capitalised single word stands mid-sentence as a name.
  const lowerCounts = new Map();
  for (const sec of sections) {
    const prose = sec.text.replace(/`[^`\n]*`/g, ' ').replace(/\S*[/_\\]\S*/g, ' '); // not code spans, paths or identifiers
    for (const w of prose.match(/(?<![\w])[a-z][a-z0-9]+(?![\w])/g) || []) lowerCounts.set(w, (lowerCounts.get(w) || 0) + 1);
  }
  const solidSingle = new Map();
  for (const m of raw) if (m.method === 'name' && !m.weak && !m.surface.includes(' ')) solidSingle.set(m.surface.toLowerCase(), (solidSingle.get(m.surface.toLowerCase()) || 0) + 1);
  // "Ask Prowler" at the start of a sentence: when the first word is an ordinary word of this corpus (lower case at least
  // 3 times and more often than it stands as a capitalised name mid-sentence) it is not part of the name.
  for (const m of raw) {
    if (!m.lead) continue;
    const [first, ...others] = m.surface.split(' ');
    const lc = lowerCounts.get(first.toLowerCase()) || 0;
    if (lc >= 3 && lc > (solidSingle.get(first.toLowerCase()) || 0)) {
      m.surface = others.join(' ');
      m.key = remap(canonKey(m.surface, 'name'));
      m.col += first.length + 1;
    }
  }

  // Weak mentions (sentence-start capitalised single words) count only if the key has a non-weak mention somewhere.
  const solid = new Set(raw.filter((m) => !m.weak).map((m) => m.key));
  const mentions = raw.filter((m) => !m.weak || solid.has(m.key));

  const byKey = new Map();
  for (const m of mentions) {
    if (!byKey.has(m.key)) byKey.set(m.key, []);
    byKey.get(m.key).push(m);
  }
  // A capitalised single word that the corpus also uses in lower case at least as often (Risk, Type, Graph) is an
  // ordinary word that happened to start a table cell or bold label, not a name.
  const entities = [];
  const kept = new Set();
  const dropped = { rare: 0, common: 0, commonWord: 0 };
  for (const key of [...byKey.keys()].sort()) {
    const ms = byKey.get(key);
    const secs = new Set(ms.map((m) => m.sectionId));
    if (secs.size < params.minSections) {
      dropped.rare++;
      continue;
    }
    if (secs.size > Math.max(Math.floor(params.maxSectionFrac * N), params.minSections + 1)) {
      dropped.common++;
      continue;
    }
    if (ms.every((m) => m.method === 'name' && !m.surface.includes(' '))) {
      const lower = ms[0].surface.toLowerCase();
      if ((lowerCounts.get(lower) || 0) >= ms.filter((m) => !m.weak).length) {
        dropped.commonWord++;
        continue;
      }
    }
    const surfaces = new Map();
    for (const m of ms) surfaces.set(m.surface, (surfaces.get(m.surface) || 0) + 1);
    const aliases = [...surfaces.entries()].map(([surface, count]) => ({ surface, count })).sort((a, b) => b.count - a.count || a.surface.length - b.surface.length || cmp(a.surface, b.surface));
    const types = new Map();
    for (const m of ms) types.set(m.type, (types.get(m.type) || 0) + 1);
    const type = [...types.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
    entities.push({
      key,
      name: aliases[0].surface,
      type,
      aliases,
      sectionDf: secs.size,
      docDf: new Set(ms.map((m) => m.docId)).size,
      idf: Math.round(Math.log(N / secs.size) * 1e6) / 1e6,
      mentions: ms.length,
    });
    kept.add(key);
  }
  const idf = new Map(entities.map((e) => [e.key, e.idf]));

  const perSection = new Map();
  for (const m of mentions) {
    if (!kept.has(m.key)) continue;
    if (!perSection.has(m.sectionId)) perSection.set(m.sectionId, new Map());
    const per = perSection.get(m.sectionId);
    if (!per.has(m.key)) per.set(m.key, []);
    per.get(m.key).push(m);
  }
  const out = new Map();
  for (const sid of [...perSection.keys()].sort()) {
    const rows = [];
    for (const [key, ms] of [...perSection.get(sid).entries()].sort((a, b) => cmp(a[0], b[0]))) {
      ms.sort((a, b) => a.line - b.line || a.col - b.col);
      const methods = [...new Set(ms.map((m) => m.method))].sort((a, b) => METHOD_RANK[a] - METHOD_RANK[b]);
      const tf = ms.length;
      rows.push({
        key,
        method: methods[0],
        methods,
        count: tf,
        tf,
        idf: idf.get(key),
        score: Math.round((1 + Math.log(tf)) * idf.get(key) * 1e6) / 1e6,
        spans: ms.slice(0, params.maxSpans).map((m) => ({ line: m.line, col: m.col, surface: m.surface, method: m.method })),
      });
    }
    out.set(sid, rows);
  }
  return { entities, mentions: out, dropped, sectionsTotal: N };
}

/** Entities named by a free-text query: every 1..4-word n-gram is canonicalised and looked up. */
export function matchQuery(query, entityByKey) {
  const toks = (String(query).match(/[\p{L}\p{N}_./:-]+/gu) || []).map((t) => t.replace(/^[./:-]+|[./:-]+$/g, '')).filter(Boolean);
  const found = new Map();
  const tryKey = (text, type) => {
    const k = canonKey(text, type);
    if (k && entityByKey.has(k) && !found.has(k)) found.set(k, entityByKey.get(k));
  };
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + n <= toks.length; i++) tryKey(toks.slice(i, i + n).join(' '), 'term');
  }
  for (const t of toks) {
    if (t.includes('/')) tryKey('/' + t.replace(/^\//, ''), 'endpoint');
    if (/\.[A-Za-z0-9]{1,6}$/.test(t)) tryKey(t, 'file');
    if (/^\d{3,5}$/.test(t)) tryKey(t, 'port');
  }
  return [...found.values()].sort((a, b) => cmp(a.key, b.key));
}

// The two switches of plan item 57. Pure resolution plus one small read of the corpus' breakwall.json.
//   A, default search mode: explicit mode > env BREAKWALL_SEARCH_MODE > breakwall.json search.mode > built-in 'hybrid'.
//   B, vectors per corpus (index time): env BREAKWALL_VECTORS (0/1) > breakwall.json vectors (boolean) > built-in true.
// Every bad value is an error naming where it came from; nothing falls back silently.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE } from './lifecycle.js';

export const SEARCH_MODES = ['hybrid', 'lexical', 'vector'];
export const BUILTIN_MODE = 'hybrid';
const NEEDS_VECTORS = new Set(['hybrid', 'vector']);

/** Thrown for a bad switch value or a mode the corpus cannot serve. tools.js turns it into a ToolError. */
export class SwitchError extends Error {}

/** { mode, vectors } as written in <root>/breakwall.json; undefined when absent. Type errors throw, naming the key. */
export function readSwitchConfig(root) {
  const file = root ? join(root, CONFIG_FILE) : null;
  if (!file || !existsSync(file)) return { mode: undefined, vectors: undefined };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new SwitchError(`${file}: not valid JSON (${e.message})`);
  }
  const out = { mode: undefined, vectors: undefined };
  if (raw && raw.search !== undefined) {
    if (!raw.search || typeof raw.search !== 'object' || Array.isArray(raw.search)) throw new SwitchError(`${file}: "search" must be an object`);
    out.mode = raw.search.mode;
  }
  if (raw && raw.vectors !== undefined) out.vectors = raw.vectors;
  return out;
}

/** Switch B. Returns { on, source }. */
export function resolveVectors({ env = process.env, config = {}, root = null } = {}) {
  const e = env.BREAKWALL_VECTORS;
  if (e !== undefined && e !== '') {
    if (e !== '0' && e !== '1') throw new SwitchError(`env BREAKWALL_VECTORS="${e}" is not valid; use 0 or 1`);
    return { on: e === '1', source: 'env BREAKWALL_VECTORS' };
  }
  const where = `${root ? join(root, CONFIG_FILE) : CONFIG_FILE} key "vectors"`;
  if (config.vectors !== undefined) {
    if (typeof config.vectors !== 'boolean') throw new SwitchError(`${where} is ${JSON.stringify(config.vectors)}; it must be true or false`);
    return { on: config.vectors, source: where };
  }
  return { on: true, source: 'built-in' };
}

/** Switch B straight from a corpus root on disk: what `sync` will use. */
export const vectorsForRoot = (root, env = process.env) => resolveVectors({ env, config: readSwitchConfig(root), root });

/**
 * Switch A, given the corpus' vectors state (as stored at index time) and its unembedded chunk count.
 * Returns { mode, source }. Throws SwitchError for an invalid value, a mode that needs vectors on a vectors-off corpus,
 * and hybrid or vector on a half-embedded corpus.
 */
export function resolveSearchMode({ explicit = null, env = process.env, config = {}, root = null, corpus = 'corpus', vectors = { on: true, source: 'built-in' }, unembedded = 0, chunks = 0 } = {}) {
  const check = (v, source) => {
    if (!SEARCH_MODES.includes(v)) throw new SwitchError(`${source} is ${JSON.stringify(v)}; search mode must be one of ${SEARCH_MODES.join(', ')}`);
    return { mode: v, source };
  };
  let pick;
  if (explicit !== null && explicit !== undefined) pick = check(explicit, 'explicit mode');
  else if (env.BREAKWALL_SEARCH_MODE !== undefined && env.BREAKWALL_SEARCH_MODE !== '') pick = check(env.BREAKWALL_SEARCH_MODE, 'env BREAKWALL_SEARCH_MODE');
  else if (config.mode !== undefined) pick = check(config.mode, `${root ? join(root, CONFIG_FILE) : CONFIG_FILE} key "search.mode"`);
  else pick = vectors.on ? { mode: BUILTIN_MODE, source: 'built-in' } : { mode: 'lexical', source: 'built-in (vectors off)' };

  if (!vectors.on && NEEDS_VECTORS.has(pick.mode)) {
    if (pick.source === 'explicit mode') throw new SwitchError(`vectors are off for corpus ${corpus} (${vectors.source}); mode "${pick.mode}" needs them. Use mode lexical, or switch vectors on and sync.`);
    throw new SwitchError(`${pick.source} names search mode "${pick.mode}", but vectors are off for corpus ${corpus} (${vectors.source}). Set it to lexical or switch vectors on and sync.`);
  }
  if (vectors.on && unembedded > 0 && NEEDS_VECTORS.has(pick.mode)) {
    throw new SwitchError(`corpus ${corpus} is half-embedded: ${unembedded} of ${chunks} chunks have no embedding (vectors were switched on after a lexical-only period). Mode "${pick.mode}" (${pick.source}) would rank on part of the corpus; run \`breakwall sync\` on it first, or use mode lexical.`);
  }
  return pick;
}

/**
 * Everything the search side needs for one indexed corpus, from the graph plus the corpus' breakwall.json:
 * vectors as stored by the last sync (switch B is index time), the unembedded count, and switch A resolved.
 * A corpus indexed before the switch existed has no stored value and was indexed with vectors: built-in on.
 */
export async function corpusSwitches(driver, corpus, { explicit = null, env = process.env } = {}) {
  const s = driver.session();
  let row;
  try {
    row = (await s.run(
      `MATCH (c:Corpus {id: $c}) OPTIONAL MATCH (k:Chunk {corpus: $c})
       RETURN c.root AS root, c.vectors AS vectors, c.vectorsSource AS vectorsSource, count(k) AS chunks, count(k.embedding) AS embedded`,
      { c: corpus },
    )).records[0];
  } finally {
    await s.close();
  }
  if (!row) throw new SwitchError(`unknown corpus "${corpus}"`);
  const root = row.get('root');
  const stored = row.get('vectors');
  const vectors = stored === null || stored === undefined ? { on: true, source: 'built-in' } : { on: stored, source: row.get('vectorsSource') || 'built-in' };
  const chunks = row.get('chunks');
  const unembedded = chunks - row.get('embedded');
  const config = root && existsSync(root) ? readSwitchConfig(root) : {};
  const mode = resolveSearchMode({ explicit, env, config, root, corpus, vectors, unembedded, chunks });
  return { corpus, vectors, unembedded, chunks, mode };
}

/** The eval harness scores all three modes, so it needs a fully embedded, vectors-on corpus; it says so if not. */
export async function requireVectors(driver, corpus, what = 'the eval harness') {
  const sw = await corpusSwitches(driver, corpus, { explicit: 'lexical', env: {} });
  if (!sw.vectors.on) throw new SwitchError(`${what} needs vectors on (it scores lexical, vector and hybrid), but they are off for corpus ${corpus} (${sw.vectors.source})`);
  if (sw.unembedded) throw new SwitchError(`${what} needs every chunk embedded; corpus ${corpus} has ${sw.unembedded} of ${sw.chunks} without a vector. Run \`breakwall sync\` on it first.`);
  return sw;
}

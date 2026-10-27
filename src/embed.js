// Local embeddings only: Xenova/all-MiniLM-L6-v2 through @xenova/transformers (ONNX, CPU, 384-dim).
// The only network use is the one-time model download when it is not cached; if that fails we throw.
// No API fallback exists, on purpose (plan section 9, item 11).
import { sha256 } from './parse.js';

export const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DIMS = 384;

// Process-wide counters of what the real local embedder did. The inferred layer must leave them at zero (plan item 34).
export const embedStats = { loads: 0, calls: 0, texts: 0 };

export const embedHash = (input, model = MODEL) => sha256(`${model}\n${input}`);

let extractor = null;
async function load() {
  if (extractor) return extractor;
  embedStats.loads++;
  const { pipeline, env } = await import('@xenova/transformers');
  try {
    env.allowRemoteModels = false; // cached model: zero network
    extractor = await pipeline('feature-extraction', MODEL);
  } catch (localErr) {
    console.error(`breakwall: model ${MODEL} not cached (${localErr.message}); downloading once from the model hub`);
    env.allowRemoteModels = true;
    try {
      extractor = await pipeline('feature-extraction', MODEL);
    } catch (e) {
      throw new Error(`cannot load embedding model ${MODEL} (download failed: ${e.message}). Not falling back to any API.`);
    } finally {
      env.allowRemoteModels = false;
    }
  }
  return extractor;
}

/** One text at a time: batching pads and can change the last float digits, one-by-one is reproducible. */
export function localEmbedder() {
  return {
    model: MODEL,
    dims: DIMS,
    async embed(texts) {
      embedStats.calls++;
      embedStats.texts += texts.length;
      const ex = await load();
      const out = [];
      for (const t of texts) {
        const r = await ex(t, { pooling: 'mean', normalize: true });
        out.push(Array.from(r.data));
      }
      return out;
    },
  };
}

export function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // vectors are unit length
}

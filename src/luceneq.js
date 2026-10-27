// Dependency-free so the ambient hook can use it without loading the Neo4j driver (plan item 49).
/** Lucene-safe query: alphanumeric word tokens only, so no operator or special character can get through. */
export function luceneQuery(text) {
  const toks = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length > 1);
  return [...new Set(toks)].slice(0, 40).join(' ');
}

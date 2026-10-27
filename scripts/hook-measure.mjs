// M5 measurement: lexical-only path cost (driver import + connect + one BM25 query) in a fresh process.
const t0 = performance.now();
const dotenv = (await import('dotenv')).default;
dotenv.config({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), quiet: true });
const { connect } = await import('../src/graph.js');
const t1 = performance.now();
const d = connect();
const s = d.session();
await s.run('RETURN 1');
const t2 = performance.now();
await s.run("CALL db.index.fulltext.queryNodes('chunk_text','pursuit dismissal',{limit:10}) YIELD node,score WHERE node.corpus=$c RETURN node.path,score LIMIT 5", { c: 'undertow-fixture' });
const t3 = performance.now();
await s.close(); await d.close();
console.log(JSON.stringify({ importMs: Math.round(t1 - t0), connectMs: Math.round(t2 - t1), ftsMs: Math.round(t3 - t2), totalInProc: Math.round(t3 - t0) }));

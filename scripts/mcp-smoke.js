// Spawns the BreakWall MCP server, makes one real call per tool against an indexed corpus, prints a summary, and
// shuts the server down by closing stdin.   usage: node scripts/mcp-smoke.js [corpus] [query]
import { startServer, jsonOf, textOf } from '../test/helpers/mcpclient.js';

const corpus = process.argv[2] || undefined;
const query = process.argv[3] || 'How is detection of whether the agent pursued or dismissed a flash supposed to work?';
const srv = startServer(corpus ? { BREAKWALL_CORPUS: corpus } : {});
const brief = (s, n = 160) => (s.length > n ? s.slice(0, n) + '...' : s);
try {
  const init = await srv.initialize();
  console.log(`initialize -> ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);
  const list = await srv.request('tools/list', {});
  console.log(`tools/list -> ${list.result.tools.map((t) => t.name).join(', ')}`);

  const s = jsonOf(await srv.call('breakwall_search', { query, limit: 3, max_chars: 600 }));
  console.log(`breakwall_search -> lowConfidence=${s.lowConfidence}; top: ${s.results[0].citation.ref} | ${s.results[0].citation.headingPath} | commit ${String(s.results[0].citation.provenance.commit).slice(0, 8)} | fused ${s.results[0].scores.fused.toFixed(5)}`);
  const top = s.results[0].citation;
  const g = jsonOf(await srv.call('breakwall_get', { ref: top.path, heading: top.headingPath, max_chars: 300 }));
  console.log(`breakwall_get -> ${g.citation.ref} (${g.text.length} chars${g.truncated ? ', truncated' : ''}): ${brief(g.text.replace(/\s+/g, ' '), 100)}`);
  const o = jsonOf(await srv.call('breakwall_outline', { path: top.path }));
  console.log(`breakwall_outline -> ${o.title}: ${o.sections.length} sections, first ${o.sections[0].citation.ref}`);
  const n = jsonOf(await srv.call('breakwall_neighbors', { ref: g.id }));
  console.log(`breakwall_neighbors -> parent ${n.structure.parent ? n.structure.parent.citation.headingPath : '-'}; ${n.structure.children.length} children; links out ${n.linksOut.length}, in ${n.linksIn.length}, to doc ${n.linksToThisDocument.length}, dangling ${n.danglingOut.length}`);
  const sg = jsonOf(await srv.call('breakwall_search', { query, limit: 3, max_chars: 300, signals: ['entity', 'similar'] }));
  console.log(`breakwall_search signals=[entity,similar] -> applied ${JSON.stringify(sg.signals.applied)}${sg.signals.note ? '; note: ' + sg.signals.note : ''}; top: ${sg.results[0].citation.ref}${sg.results[0].inferred ? ' (inferred: ' + sg.results[0].inferred.why[0] + ')' : ''}`);
  const tr = jsonOf(await srv.call('breakwall_trace', { from: top.path + '#' + top.headingPath.split(' > ').slice(-1)[0], to: (s.results.find((r) => r.citation.path !== top.path) || s.results[0]).citation.path, max_hops: 6 }));
  console.log(`breakwall_trace -> ${tr.summary}`);
  for (const h of tr.path.hops || []) console.log(`    hop ${h.hop}: [${h.edge.layer}] ${h.edge.type}${h.edge.score !== undefined ? ' score ' + h.edge.score : ''} - ${brief(h.explanation, 130)}`);
  const w = await srv.call('breakwall_work_item', { id: 'M3' });
  console.log(`breakwall_work_item -> ${w.result.isError ? 'isError: ' + brief(textOf(w), 140) : JSON.stringify(brief(textOf(w)))}`);
  const h = jsonOf(await srv.call('breakwall_history', { topic: top.path }));
  console.log(`breakwall_history -> ${h.document.path} uid ${h.document.uid}; lifecycle events ${h.lifecycle.length}; chain ${h.supersessionChainNewestFirst.map((x) => x.path).join(' > ')}`);
  const l = jsonOf(await srv.call('breakwall_lint', {}));
  console.log(`breakwall_lint -> ${l.documents} documents, ${l.totalFindings} findings ${JSON.stringify(l.counts)}`);
  const st = jsonOf(await srv.call('breakwall_status', {}));
  console.log(`breakwall_status -> ${st.corpora.map((c) => `${c.corpus}: ${c.documents} docs, ${c.sections} sections, ${c.chunks} chunks, ${c.tombstoned} tombstoned, inferred layer ${c.inferred && c.inferred.present ? (c.inferred.fresh ? 'fresh' : 'STALE') + ' (run ' + c.inferred.run + ')' : 'not built'}`).join('; ')}`);
  const badTrace = await srv.call('breakwall_trace', { from: 'docs/nope.md#x', to: 'CLAUDE.md' });
  console.log(`invalid trace ref -> ${badTrace.error ? 'protocol error' : 'isError: ' + brief(textOf(badTrace), 100)}`);
  const bad = await srv.call('breakwall_search', { query: 'x', limit: 99 });
  console.log(`invalid input (limit 99) -> ${bad.error ? 'protocol error: ' + brief(bad.error.message, 120) : 'isError: ' + brief(textOf(bad), 120)}`);
  const nonJson = srv.stdoutLines.filter((l) => { try { return JSON.parse(l).jsonrpc !== '2.0'; } catch { return true; } });
  console.log(`stdout lines: ${srv.stdoutLines.length}, non-protocol lines: ${nonJson.length}`);
} finally {
  const exit = await srv.shutdown();
  console.log(`shutdown by closing stdin -> exit code ${exit.code}${srv.stderr().trim() ? `; stderr: ${brief(srv.stderr().trim(), 200)}` : ''}`);
}

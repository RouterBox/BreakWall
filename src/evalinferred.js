// M4: score the inferred-layer retrieval signals against the M2 hybrid baseline (plan items 35 and 36).
// Candidate lists are fetched once per question; every configuration is then computed offline from them, so the
// comparison is exactly like for like. Nothing here changes the stored data.
import { candidates, rank, DEFAULTS } from './search.js';
import { loadQuestions, scoreRanking, aggregate, verbatim } from './evalrun.js';
import { planSignals, loadInferredIndex, SIGNAL_PARAMS } from './infer/signals.js';
import { requireVectors } from './switches.js';

export const M2_BASELINE = { recall5: 14 / 19, recall10: 16 / 19, mrr: 0.669, top1: 11 / 19 }; // eval/results-m2.md, for the reproduction check
const SINGLE = ['similar', 'entity', 'community'];

/** The decision rule of plan item 36, applied to one configuration against the baseline. */
export function decide(base, cfg, paired) {
  const n = base.n;
  const inQuestions = (x) => x * n;
  const gainsRecall = inQuestions(cfg.recall5 - base.recall5) >= 1 - 1e-9 || inQuestions(cfg.recall10 - base.recall10) >= 1 - 1e-9;
  const gainsMrr = cfg.mrr - base.mrr >= 0.03;
  const drops = [
    ['recall@5', base.recall5 - cfg.recall5],
    ['recall@10', base.recall10 - cfg.recall10],
    ['top-1 citation', base.top1 - cfg.top1],
  ].filter(([, d]) => inQuestions(d) >= 1 - 1e-9).map(([k]) => k);
  const reasons = [];
  if (!(gainsRecall || gainsMrr)) reasons.push('no gain of one question in recall@5/@10 and MRR gain below 0.03');
  if (drops.length) reasons.push(`loses ${drops.join(', ')} by one question or more`);
  if (!(paired.better > paired.worse)) reasons.push(`not better on more questions than worse (${paired.better} vs ${paired.worse})`);
  return { pass: reasons.length === 0, reasons };
}

export async function runInferredEval({ driver, embedder, corpusName, corpusRoot, questionsFile }) {
  const { status, questions } = loadQuestions(questionsFile);
  await requireVectors(driver, corpusName); // all three modes are scored (plan item 57)
  const answerable = questions.filter((q) => q.answerable);
  const idx = await loadInferredIndex(driver, corpusName);
  if (!idx.present) throw new Error('no inferred layer for this corpus; run `breakwall infer` (or eval with --inferred, which builds it)');
  const cands = new Map();
  for (const q of questions) cands.set(q.id, await candidates(driver, embedder, corpusName, q.question));

  // Every live section, so signal-introduced sections can be scored and quoted.
  const s = driver.session();
  let sectionRows;
  try {
    const res = await s.run('MATCH (x:Section {corpus: $c}) WHERE x.deleted IS NULL RETURN x.id AS id, x.path AS path, x.headingPath AS headingPath, x.startLine AS startLine, x.endLine AS endLine, x.text AS text', { c: corpusName });
    sectionRows = new Map(res.records.map((r) => [r.get('id'), Object.fromEntries(r.keys.map((k) => [k, r.get(k)]))]));
  } finally {
    await s.close();
  }

  const ranking = (q, opts) => {
    const base = rank(cands.get(q.id), { mode: 'hybrid', limit: SIGNAL_PARAMS.depth, weights: DEFAULTS.weights, rrfK: DEFAULTS.rrfK });
    if (!opts.similar && !opts.entity && !opts.community) return { list: base, plan: null };
    const extra = opts.params || {};
    const params = { ...SIGNAL_PARAMS, ...extra, weights: { ...SIGNAL_PARAMS.weights, ...(extra.weights || {}) } };
    const plan = planSignals(base, idx, q.question, { similar: !!opts.similar, entity: !!opts.entity, community: !!opts.community, params });
    const byId = new Map(base.map((r) => [r.sectionId, r]));
    const list = plan.order.map((o) => {
      const r = byId.get(o.sectionId);
      if (r) return r;
      const h = sectionRows.get(o.sectionId);
      return { sectionId: h.id, path: h.path, headingPath: h.headingPath, startLine: h.startLine, endLine: h.endLine, text: h.text, scores: {} };
    });
    return { list, plan };
  };
  const evalConfig = (opts) => {
    const per = answerable.map((q) => {
      const { list } = ranking(q, opts);
      return { id: q.id, ...scoreRanking(list, q), top: list.slice(0, 10).map((r) => r.sectionId) };
    });
    return { per, ...aggregate(per) };
  };
  const pairedVs = (base, cfg) => {
    let better = 0;
    let worse = 0;
    let moved = 0;
    base.per.forEach((b, i) => {
      const c = cfg.per[i];
      if (c.rr > b.rr) better++;
      else if (c.rr < b.rr) worse++;
      else if (c.top.join() !== b.top.join()) moved++;
    });
    return { better, worse, equal: base.per.length - better - worse, equalButTop10Changed: moved };
  };
  const verb = (opts) => {
    const tops = answerable.map((q) => ranking(q, opts).list[0]).filter(Boolean);
    return { ok: tops.filter((r) => verbatim(corpusRoot, r)).length, of: tops.length };
  };

  const CONFIGS = [
    ['baseline (M2 hybrid)', {}],
    ['similar (graph-neighbour expansion)', { similar: true }],
    ['entity (entity-match boost)', { entity: true }],
    ['community (diversification)', { community: true }],
    ['similar + entity', { similar: true, entity: true }],
    ['all three', { similar: true, entity: true, community: true }],
  ];
  const results = [];
  let baseline = null;
  for (const [label, opts] of CONFIGS) {
    const m = evalConfig(opts);
    if (!baseline) baseline = m;
    const paired = pairedVs(baseline, m);
    results.push({ label, opts, ...m, paired, verbatim: verb(opts), decision: baseline === m ? null : decide(baseline, m, paired) });
  }

  // Sensitivity: reported only, never used to set a default (plan item 35).
  const sens = [];
  for (const w of [0.25, 0.5, 1]) {
    for (const sig of ['similar', 'entity']) {
      const m = evalConfig({ [sig]: true, params: { weights: { [sig]: w } } });
      sens.push({ label: `${sig} weight ${w}`, ...m, paired: pairedVs(baseline, m) });
    }
  }
  for (const cap of [1, 2, 3]) {
    const m = evalConfig({ community: true, params: { cap } });
    sens.push({ label: `community cap ${cap}`, ...m, paired: pairedVs(baseline, m) });
  }

  // Diagnostics: what did the signals actually do?
  const plans = (opts) => answerable.map((q) => ({ q, plan: ranking(q, opts).plan }));
  const baseTop10 = new Map(answerable.map((q) => [q.id, ranking(q, {}).list.slice(0, 10).map((r) => r.sectionId).join()]));
  const diag = {
    questionsWithEntityMatch: plans({ entity: true }).filter((x) => x.plan.order.some((o) => o.via.some((v) => v.startsWith('mentions entity')))).length,
    questionsWhereSimilarAddedASectionToTop10: plans({ similar: true }).filter((x) => x.plan.order.slice(0, 10).some((o) => o.signals.base === null)).length,
    questionsWhereEntityAddedASectionToTop10: plans({ entity: true }).filter((x) => x.plan.order.slice(0, 10).some((o) => o.signals.base === null)).length,
    questionsWhereCommunityChangedTop10: answerable.filter((q) => ranking(q, { community: true }).list.slice(0, 10).map((r) => r.sectionId).join() !== baseTop10.get(q.id)).length,
  };
  const perQuestion = answerable.map((q, i) => ({ id: q.id, question: q.question, ranks: results.map((r) => r.per[i].firstRank) }));
  const reproduces =
    Math.abs(baseline.recall5 - M2_BASELINE.recall5) < 1e-9 &&
    Math.abs(baseline.recall10 - M2_BASELINE.recall10) < 1e-9 &&
    Math.abs(baseline.mrr - M2_BASELINE.mrr) < 0.001 &&
    Math.abs(baseline.top1 - M2_BASELINE.top1) < 1e-9;
  const defaults = SINGLE.filter((sig) => results.find((r) => r.label.startsWith(sig + ' ')).decision.pass);
  return { status, counts: { questions: questions.length, answerable: answerable.length }, results, sens, diag, perQuestion, baselineReproducesM2: reproduces, inferredRun: idx.run, defaults };
}

export function renderM4Tables(r, meta) {
  const L = [];
  const pc = (x) => (x * 100).toFixed(0) + '%';
  const n = r.counts.answerable;
  const cnt = (x) => `${pc(x)} (${Math.round(x * n)}/${n})`;
  L.push(`Eval set status: **${r.status}** (unreviewed by RouterBox; every number is provisional).`);
  L.push(`Corpus \`${meta.corpusName}\` at ${meta.commit || 'no commit'}; ${r.counts.questions} questions, ${n} answerable. Inferred layer run \`${r.inferredRun}\`. The baseline row reproduces the recorded M2 hybrid numbers (recall@5 74%, recall@10 84%, MRR 0.669, citation 58%): **${r.baselineReproducesM2 ? 'yes' : 'NO - investigate before reading anything below'}**.`);
  L.push('');
  L.push('## Headline (answerable questions)');
  L.push('');
  L.push(`One question = ${pc(1 / n)} of recall; differences under about one question are noise. Signal weights are the pre-declared 0.5 (plan item 35), not tuned. "Decision" applies the rule of plan item 36 (written before the first run).`);
  L.push('');
  L.push('| configuration | recall@5 | recall@10 | MRR | citation (top-1) | verbatim cites | paired vs baseline (better / worse / equal) | decision |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const x of r.results) {
    const p = x.paired;
    L.push(`| ${x.label} | ${cnt(x.recall5)} | ${cnt(x.recall10)} | ${x.mrr.toFixed(3)} | ${cnt(x.top1)} | ${x.verbatim.ok}/${x.verbatim.of} | ${x.decision ? `${p.better} / ${p.worse} / ${p.equal}` : '-'} | ${x.decision ? (x.decision.pass ? '**beats baseline**' : 'no: ' + x.decision.reasons.join('; ')) : 'reference'} |`);
  }
  L.push('');
  L.push(`Default-on signals after applying the rule: ${r.defaults.length ? r.defaults.join(', ') : '**none**'}.`);
  L.push('');
  L.push('## What the signals did (diagnostics)');
  L.push('');
  L.push(`- Questions whose text named at least one extracted entity: ${r.diag.questionsWithEntityMatch}/${n}.`);
  L.push(`- Questions where \`similar\` put a section into the top 10 that was not among the 50 base candidates: ${r.diag.questionsWhereSimilarAddedASectionToTop10}/${n}.`);
  L.push(`- Questions where \`entity\` put a section into the top 10 that was not among the 50 base candidates: ${r.diag.questionsWhereEntityAddedASectionToTop10}/${n}.`);
  L.push(`- Questions where \`community\` changed the top 10: ${r.diag.questionsWhereCommunityChangedTop10}/${n}.`);
  L.push('');
  L.push('## Sensitivity (reported, not used to choose anything)');
  L.push('');
  L.push('| setting | recall@5 | recall@10 | MRR | citation (top-1) | paired (better / worse / equal) |');
  L.push('|---|---|---|---|---|---|');
  for (const x of r.sens) L.push(`| ${x.label} | ${cnt(x.recall5)} | ${cnt(x.recall10)} | ${x.mrr.toFixed(3)} | ${cnt(x.top1)} | ${x.paired.better} / ${x.paired.worse} / ${x.paired.equal} |`);
  L.push('');
  L.push('## Per question (rank of first gold section, - = not in top 50)');
  L.push('');
  L.push('| id | baseline | similar | entity | community | sim+ent | all | question |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const q of r.perQuestion) L.push(`| ${q.id} | ${q.ranks.map((x) => x ?? '-').join(' | ')} | ${q.question.replace(/\|/g, '/')} |`);
  return L.join('\n');
}

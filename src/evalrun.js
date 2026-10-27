// Eval harness: scores lexical, vector and hybrid search on eval/questions.json (plan sections 10 and 11).
// Candidate retrieval hits the database once per question; every method and every fusion setting is then
// computed offline from the same candidate lists, so comparisons are exactly like for like.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { candidates, rank, gateScore, DEFAULTS } from './search.js';
import { requireVectors } from './switches.js';

const MAX_RANKED = 50;

export function loadQuestions(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return { status: j.status, questions: j.questions };
}

const key = (path, headingPath) => `${path}|${headingPath}`;
const goldKeys = (q) => new Set(q.gold.map((g) => key(g.file, g.heading_path)));

/** Metrics for one ranked section list against one question's gold. */
export function scoreRanking(results, q) {
  const gold = goldKeys(q);
  const hits = results.map((r) => gold.has(key(r.path, r.headingPath)));
  const first = hits.indexOf(true);
  const inTop = (k) => new Set(results.slice(0, k).filter((_, i) => hits[i]).map((r) => key(r.path, r.headingPath)));
  return {
    hit5: hits.slice(0, 5).some(Boolean),
    hit10: hits.slice(0, 10).some(Boolean),
    rr: first === -1 ? 0 : 1 / (first + 1),
    firstRank: first === -1 ? null : first + 1,
    top1: hits[0] === true,
    goldFrac10: gold.size ? inTop(10).size / gold.size : 0,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const num = (b) => (b === true ? 1 : b === false ? 0 : b);

export function aggregate(perQuestion) {
  return {
    n: perQuestion.length,
    recall5: mean(perQuestion.map((m) => num(m.hit5))),
    recall10: mean(perQuestion.map((m) => num(m.hit10))),
    mrr: mean(perQuestion.map((m) => m.rr)),
    top1: mean(perQuestion.map((m) => num(m.top1))),
    goldFrac10: mean(perQuestion.map((m) => m.goldFrac10)),
  };
}

/** Does the cited line range of the file really contain the chunk text we quote? */
export function verbatim(corpusRoot, r) {
  const f = join(corpusRoot, r.path);
  if (!existsSync(f)) return false;
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  return lines.slice(r.startLine - 1, r.endLine).join('\n') === r.text;
}

/**
 * Pick a threshold t ("answer if score >= t") maximising balanced accuracy over labelled scores.
 * Candidates are midpoints between neighbouring distinct scores; ties resolve to the lower median of the best set.
 */
export function pickThreshold(items) {
  const pos = items.filter((x) => x.answerable);
  const neg = items.filter((x) => !x.answerable);
  const vals = [...new Set(items.map((x) => x.score))].sort((a, b) => a - b);
  const cands = vals.slice(1).map((v, i) => (v + vals[i]) / 2);
  if (!cands.length || !pos.length || !neg.length) return { t: vals[0] ?? 0, ba: 0 };
  const scored = cands.map((t) => ({
    t,
    ba: (pos.filter((x) => x.score >= t).length / pos.length + neg.filter((x) => x.score < t).length / neg.length) / 2,
  }));
  const best = Math.max(...scored.map((s) => s.ba));
  const top = scored.filter((s) => s.ba === best);
  return { t: top[(top.length - 1) >> 1].t, ba: best };
}

/** Threshold quality: in-sample, plus leave-one-question-out (pick on the other n-1, predict the held-out one). */
export function gateReport(items) {
  const { t, ba } = pickThreshold(items);
  const pos = items.filter((x) => x.answerable);
  const neg = items.filter((x) => !x.answerable);
  let loo = 0;
  for (let i = 0; i < items.length; i++) {
    const rest = items.filter((_, j) => j !== i);
    const th = pickThreshold(rest).t;
    const predictAnswer = items[i].score >= th;
    if (predictAnswer === items[i].answerable) loo++;
  }
  return {
    threshold: t,
    answerablePassed: pos.filter((x) => x.score >= t).length,
    answerable: pos.length,
    unanswerableRefused: neg.filter((x) => x.score < t).length,
    unanswerable: neg.length,
    balancedAccuracy: ba,
    looAccuracy: loo / items.length,
    minAnswerable: Math.min(...pos.map((x) => x.score)),
    maxUnanswerable: Math.max(...neg.map((x) => x.score)),
    medianAnswerable: [...pos.map((x) => x.score)].sort((a, b) => a - b)[pos.length >> 1],
  };
}

export const GRID = {
  lexicalWeights: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4], // vector weight is fixed at 1
  rrfKs: [10, 30, 60],
};

export async function runEval({ driver, embedder, corpusName, corpusRoot, questionsFile }) {
  const { status, questions } = loadQuestions(questionsFile);
  await requireVectors(driver, corpusName); // all three modes are scored (plan item 57)
  const cands = new Map();
  for (const q of questions) cands.set(q.id, await candidates(driver, embedder, corpusName, q.question));
  const answerable = questions.filter((q) => q.answerable);

  const rankFor = (q, opts) => rank(cands.get(q.id), { limit: MAX_RANKED, ...opts });
  const evalConfig = (opts) => {
    const per = answerable.map((q) => ({ id: q.id, ...scoreRanking(rankFor(q, opts), q) }));
    return { per, ...aggregate(per) };
  };

  // The three headline methods, hybrid at the default (standard RRF) setting.
  const methods = {};
  for (const mode of ['lexical', 'vector', 'hybrid']) {
    const opts = { mode, weights: DEFAULTS.weights, rrfK: DEFAULTS.rrfK };
    const m = evalConfig(opts);
    const tops = answerable.map((q) => rankFor(q, opts)[0]).filter(Boolean);
    const citeVerbatim = tops.filter((r) => verbatim(corpusRoot, r)).length;
    const gates = questions.map((q) => ({ id: q.id, answerable: q.answerable, score: gateScore(rankFor(q, opts), mode) }));
    methods[mode] = { ...m, citationAccuracy: m.top1, verbatimCites: citeVerbatim, verbatimOf: tops.length, gate: gateReport(gates), gates };
  }

  // Fusion grid.
  const grid = [];
  for (const rrfK of GRID.rrfKs) {
    for (const wl of GRID.lexicalWeights) {
      const m = evalConfig({ mode: 'hybrid', weights: { lexical: wl, vector: 1 }, rrfK });
      grid.push({ rrfK, wl, recall5: m.recall5, recall10: m.recall10, mrr: m.mrr, top1: m.top1, rrs: m.per.map((p) => p.rr) });
    }
  }
  // Leave-one-out tuning: choose the grid cell with best MRR on the other questions (ties: closest to default), score the held-out one.
  const isDefault = (g) => g.wl === 1 && g.rrfK === DEFAULTS.rrfK;
  const dist = (g) => Math.abs(Math.log(g.wl)) + Math.abs(Math.log(g.rrfK / DEFAULTS.rrfK));
  const looRR = [];
  const picks = [];
  for (let i = 0; i < answerable.length; i++) {
    const score = (g) => mean(g.rrs.filter((_, j) => j !== i));
    const best = [...grid].sort((a, b) => score(b) - score(a) || dist(a) - dist(b))[0];
    picks.push(`${best.wl}/${best.rrfK}`);
    looRR.push(best.rrs[i]);
  }
  const def = grid.find(isDefault);
  const mrrs = grid.map((g) => g.mrr);
  const tuning = {
    grid,
    defaultCell: def,
    mrrMin: Math.min(...mrrs),
    mrrMax: Math.max(...mrrs),
    bestCell: [...grid].sort((a, b) => b.mrr - a.mrr || dist(a) - dist(b))[0],
    looMrr: mean(looRR),
    looPicks: picks,
  };

  // Per-question detail for the headline methods and a paired comparison of hybrid against each single method.
  const detail = answerable.map((q) => {
    const row = { id: q.id, type: q.type, question: q.question, gold: q.gold.map((g) => `${g.file} | ${g.heading_path}`) };
    for (const mode of ['lexical', 'vector', 'hybrid']) {
      const r = rankFor(q, { mode, weights: DEFAULTS.weights, rrfK: DEFAULTS.rrfK });
      row[mode] = { ...scoreRanking(r, q), top: r[0] ? `${r[0].path} | ${r[0].headingPath}` : null };
    }
    return row;
  });
  const paired = (other) => {
    let better = 0, worse = 0;
    for (const d of detail) {
      if (d.hybrid.rr > d[other].rr) better++;
      else if (d.hybrid.rr < d[other].rr) worse++;
    }
    return { better, worse, same: detail.length - better - worse };
  };
  const unanswerableTop = questions
    .filter((q) => !q.answerable)
    .map((q) => {
      const r = rankFor(q, { mode: 'hybrid' })[0];
      return { id: q.id, question: q.question, top: r ? `${r.path} | ${r.headingPath}` : null, cosine: r?.scores.cosine ?? null, bm25: r?.scores.lexicalScore ?? null };
    });

  return {
    status,
    counts: { questions: questions.length, answerable: answerable.length, unanswerable: questions.length - answerable.length },
    methods,
    tuning,
    detail,
    pairedVsLexical: paired('lexical'),
    pairedVsVector: paired('vector'),
    unanswerableTop,
  };
}

const pct = (x) => (x * 100).toFixed(0) + '%';
const f3 = (x) => x.toFixed(3);

export function renderTables(r, meta) {
  const L = [];
  L.push(`Eval set status: **${r.status}** (RouterBox has not reviewed these questions; every number below is provisional).`);
  L.push(`Corpus \`${meta.corpusName}\` at ${meta.commit || 'no commit'}; ${r.counts.questions} questions (${r.counts.answerable} answerable, ${r.counts.unanswerable} unanswerable). Chunks: ${meta.chunks}. Corpora in the database during this run: ${meta.corpora.join(', ')}.`);
  L.push('');
  L.push('## Headline (answerable questions, n=' + r.counts.answerable + ')');
  L.push('');
  L.push('Hybrid = reciprocal rank fusion, lexical weight 1, vector weight 1, k=60 (no tuning). Citation accuracy = the top-1 cited section is a gold section; "verbatim" = the cited file line range reproduces the quoted text exactly.');
  L.push('');
  L.push('| method | recall@5 | recall@10 | MRR | citation accuracy (top-1) | verbatim cites |');
  L.push('|---|---|---|---|---|---|');
  for (const m of ['lexical', 'vector', 'hybrid']) {
    const x = r.methods[m];
    L.push(`| ${m} | ${pct(x.recall5)} (${Math.round(x.recall5 * x.n)}/${x.n}) | ${pct(x.recall10)} (${Math.round(x.recall10 * x.n)}/${x.n}) | ${f3(x.mrr)} | ${pct(x.citationAccuracy)} (${Math.round(x.citationAccuracy * x.n)}/${x.n}) | ${x.verbatimCites}/${x.verbatimOf} |`);
  }
  L.push('');
  L.push(`Paired on reciprocal rank, hybrid vs lexical: better on ${r.pairedVsLexical.better}, worse on ${r.pairedVsLexical.worse}, equal on ${r.pairedVsLexical.same}. Hybrid vs vector: better on ${r.pairedVsVector.better}, worse on ${r.pairedVsVector.worse}, equal on ${r.pairedVsVector.same}. One question is worth ${f3(1 / r.counts.answerable)} of recall (5.3 points); differences of one or two questions are noise.`);
  L.push('');
  L.push('## Unanswerable handling ("no answer" threshold)');
  L.push('');
  L.push('Rule: answer only if the top hit scores at least t. Score = BM25 of the top hit for lexical, cosine of the top hit for vector and hybrid (fused RRF scores are rank-based and cannot signal absence). t is the midpoint maximising balanced accuracy over all ' + r.counts.questions + ' questions (answer vs refuse); "LOO" re-picks t with each question held out and predicts it, the honest estimate.');
  L.push('');
  L.push('| method | t | answerable passed | unanswerable refused | in-sample balanced acc | LOO accuracy | answerable min / median | unanswerable max |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const m of ['lexical', 'vector', 'hybrid']) {
    const g = r.methods[m].gate;
    L.push(`| ${m} | ${g.threshold.toFixed(3)} | ${g.answerablePassed}/${g.answerable} | ${g.unanswerableRefused}/${g.unanswerable} | ${pct(g.balancedAccuracy)} | ${pct(g.looAccuracy)} | ${g.minAnswerable.toFixed(3)} / ${g.medianAnswerable.toFixed(3)} | ${g.maxUnanswerable.toFixed(3)} |`);
  }
  L.push('');
  L.push(`Baseline to beat: always answering is right on ${r.counts.answerable}/${r.counts.questions} = ${pct(r.counts.answerable / r.counts.questions)} of questions. Every LOO accuracy above is below that, so on this set a score threshold does not reliably beat "always answer" in plain accuracy; it only buys some refusals at the cost of some wrong refusals. Five unanswerable questions cannot support a stronger claim.`);
  L.push('');
  L.push('Top hit for each unanswerable question (hybrid):');
  L.push('');
  for (const u of r.unanswerableTop) L.push(`- ${u.id} "${u.question}" -> ${u.top} (cos ${u.cosine?.toFixed(3)}, bm25 ${u.bm25?.toFixed(2) ?? '-'})`);
  L.push('');
  L.push('## Fusion weights tried');
  L.push('');
  const t = r.tuning;
  L.push(`Grid: lexical weight in {${GRID.lexicalWeights.join(', ')}} (vector weight fixed at 1) x RRF k in {${GRID.rrfKs.join(', ')}} = ${t.grid.length} settings, all scored on the same ${r.counts.answerable} questions the weights are then judged on.`);
  L.push('');
  L.push(`- MRR across the grid: min ${f3(t.mrrMin)}, max ${f3(t.mrrMax)} (spread ${f3(t.mrrMax - t.mrrMin)}). Default (1, k=60): ${f3(t.defaultCell.mrr)}, recall@5 ${pct(t.defaultCell.recall5)}, recall@10 ${pct(t.defaultCell.recall10)}.`);
  L.push(`- Best in-sample cell: lexical weight ${t.bestCell.wl}, k=${t.bestCell.rrfK}: MRR ${f3(t.bestCell.mrr)}, recall@5 ${pct(t.bestCell.recall5)}, recall@10 ${pct(t.bestCell.recall10)}. This number is optimistic: it is the maximum of ${t.grid.length} tries on ${r.counts.answerable} questions.`);
  L.push(`- Leave-one-out tuned MRR (weights chosen without the held-out question): ${f3(t.looMrr)} vs default ${f3(t.defaultCell.mrr)}. Picks per held-out question varied across: ${[...new Set(t.looPicks)].join(', ')}.`);
  L.push('');
  L.push('| lexical weight | k | recall@5 | recall@10 | MRR |');
  L.push('|---|---|---|---|---|');
  for (const g of t.grid) L.push(`| ${g.wl} | ${g.rrfK} | ${pct(g.recall5)} | ${pct(g.recall10)} | ${f3(g.mrr)} |`);
  L.push('');
  L.push('## Per question (rank of first gold section, - = not in top 50)');
  L.push('');
  L.push('| id | type | lexical | vector | hybrid | question |');
  L.push('|---|---|---|---|---|---|');
  const rk = (x) => (x.firstRank === null ? '-' : x.firstRank);
  for (const d of r.detail) L.push(`| ${d.id} | ${d.type} | ${rk(d.lexical)} | ${rk(d.vector)} | ${rk(d.hybrid)} | ${d.question.replace(/\|/g, '/')} |`);
  return L.join('\n');
}

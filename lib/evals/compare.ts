import {
  parseAggregateCorrelatedFailure,
  parseItemCorrelatedFailure,
  type AggregateCorrelatedFailure,
  type IndependenceLabel
} from "@/lib/evals/correlation";
import { parseEvalSetItems } from "@/lib/evals/resume";

export type ComparableEvalScore = {
  item_index?: number;
  prompt: string;
  score: number | null;
  hidden_score?: number | null;
  correlated_failure?: unknown;
};

export type ComparableEvalConfig = {
  models?: string[];
  judgeModel?: string;
  reviewerModel?: string;
  debateDepth?: number;
  researchEnabled?: boolean;
} | null;

export type ComparableEvalRun = {
  id: string;
  eval_set_id?: string | null;
  status: string;
  aggregate_score: number | null;
  created_at: string;
  baseline_label?: string | null;
  correlated_failure?: unknown;
  council_config?: ComparableEvalConfig;
  eval_sets?: {
    name?: string;
    items?: unknown;
  } | null;
  eval_scores?: ComparableEvalScore[];
};

export type EvalCompareItem = {
  itemIndex: number;
  prompt: string;
  leftScore: number | null;
  rightScore: number | null;
  scoreDelta: number | null;
  leftHidden: number | null;
  rightHidden: number | null;
  hiddenDelta: number | null;
  leftCorrelatedFailure: number | null;
  rightCorrelatedFailure: number | null;
  correlatedFailureDelta: number | null;
  leftIndependence?: IndependenceLabel;
  rightIndependence?: IndependenceLabel;
};

export type EvalCompareResult = {
  evalSetId: string;
  setName: string;
  left: EvalCompareSide;
  right: EvalCompareSide;
  items: EvalCompareItem[];
  meanScoreDelta: number | null;
  meanHiddenDelta: number | null;
  meanCorrelatedFailureDelta: number | null;
  overlapping: number;
};

export type EvalCompareSide = {
  id: string;
  label: string;
  aggregateScore: number | null;
  correlatedFailure?: AggregateCorrelatedFailure;
};

export type EvalCompareGroup = {
  evalSetId: string;
  name: string;
  promptCount: number;
  runs: ComparableEvalRun[];
};

export function formatEvalConfigLabel(config?: ComparableEvalConfig): string {
  if (!config) return "—";
  return [
    config.models?.length ? `${config.models.length} models` : null,
    config.debateDepth != null ? `depth ${config.debateDepth}` : null,
    config.reviewerModel && config.reviewerModel !== config.judgeModel ? "held-out reviewer" : null,
    config.researchEnabled ? "research" : null
  ].filter(Boolean).join(" · ") || "—";
}

export function evalRunCompareLabel(run: ComparableEvalRun): string {
  const baseline = run.baseline_label?.trim();
  const config = formatEvalConfigLabel(run.council_config);
  if (baseline && config !== "—") return `${baseline} · ${config}`;
  return baseline || config;
}

export function canCompareEvalRuns(left: ComparableEvalRun, right: ComparableEvalRun): boolean {
  return Boolean(
    left.id !== right.id
    && left.eval_set_id
    && left.eval_set_id === right.eval_set_id
  );
}

export function evalSetCompareGroups(runs: ComparableEvalRun[]): EvalCompareGroup[] {
  const groups = new Map<string, EvalCompareGroup>();
  for (const run of runs) {
    const evalSetId = run.eval_set_id?.trim();
    if (!evalSetId) continue;
    const current = groups.get(evalSetId);
    if (current) {
      current.runs.push(run);
      continue;
    }
    groups.set(evalSetId, {
      evalSetId,
      name: run.eval_sets?.name?.trim() || "Eval set",
      promptCount: parseEvalSetItems(run.eval_sets?.items).length,
      runs: [run]
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      runs: [...group.runs].sort((left, right) => right.created_at.localeCompare(left.created_at))
    }))
    .filter((group) => group.runs.length >= 2)
    .sort((left, right) => {
      const leftLatest = left.runs[0]?.created_at ?? "";
      const rightLatest = right.runs[0]?.created_at ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
}

export function compareEvalRuns(left: ComparableEvalRun, right: ComparableEvalRun): EvalCompareResult {
  if (!canCompareEvalRuns(left, right) || !left.eval_set_id) {
    throw new Error("Choose two runs that used the same eval set.");
  }

  const prompts = promptsForSet(left, right);
  const leftScores = scoresByIndex(left);
  const rightScores = scoresByIndex(right);
  const items: EvalCompareItem[] = prompts.map((prompt, itemIndex) => {
    const leftScore = leftScores.get(itemIndex);
    const rightScore = rightScores.get(itemIndex);
    const leftHidden = finiteOrNull(leftScore?.hidden_score);
    const rightHidden = finiteOrNull(rightScore?.hidden_score);
    const leftFailure = parseItemCorrelatedFailure(leftScore?.correlated_failure);
    const rightFailure = parseItemCorrelatedFailure(rightScore?.correlated_failure);
    return {
      itemIndex,
      prompt,
      leftScore: finiteOrNull(leftScore?.score),
      rightScore: finiteOrNull(rightScore?.score),
      scoreDelta: delta(finiteOrNull(rightScore?.score), finiteOrNull(leftScore?.score)),
      leftHidden,
      rightHidden,
      hiddenDelta: delta(rightHidden, leftHidden),
      leftCorrelatedFailure: finiteOrNull(leftFailure?.correlatedFailure),
      rightCorrelatedFailure: finiteOrNull(rightFailure?.correlatedFailure),
      correlatedFailureDelta: delta(
        finiteOrNull(rightFailure?.correlatedFailure),
        finiteOrNull(leftFailure?.correlatedFailure)
      ),
      leftIndependence: leftFailure?.independence,
      rightIndependence: rightFailure?.independence
    };
  });

  return {
    evalSetId: left.eval_set_id,
    setName: left.eval_sets?.name?.trim() || right.eval_sets?.name?.trim() || "Eval set",
    left: sideFromRun(left),
    right: sideFromRun(right),
    items,
    meanScoreDelta: mean(items.map((item) => item.scoreDelta)),
    meanHiddenDelta: mean(items.map((item) => item.hiddenDelta)),
    meanCorrelatedFailureDelta: mean(items.map((item) => item.correlatedFailureDelta)),
    overlapping: items.filter((item) => item.leftScore != null && item.rightScore != null).length
  };
}

export function formatSignedDelta(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const formatted = value.toFixed(digits);
  return value > 0 ? `+${formatted}` : formatted;
}

export function formatEvalCompareSummary(result: EvalCompareResult): string {
  return [
    `Rubric ${formatSignedDelta(result.meanScoreDelta)}`,
    `held-out ${formatSignedDelta(result.meanHiddenDelta)}`,
    `correlated failure ${formatSignedDelta(result.meanCorrelatedFailureDelta, 2)}`
  ].join(" · ");
}

function sideFromRun(run: ComparableEvalRun): EvalCompareSide {
  return {
    id: run.id,
    label: evalRunCompareLabel(run),
    aggregateScore: finiteOrNull(run.aggregate_score),
    correlatedFailure: parseAggregateCorrelatedFailure(run.correlated_failure)
  };
}

function promptsForSet(left: ComparableEvalRun, right: ComparableEvalRun): string[] {
  const fromSet = parseEvalSetItems(left.eval_sets?.items).map((item) => item.prompt);
  if (fromSet.length) return fromSet;
  const fromRight = parseEvalSetItems(right.eval_sets?.items).map((item) => item.prompt);
  if (fromRight.length) return fromRight;
  const scores = [...(left.eval_scores ?? []), ...(right.eval_scores ?? [])]
    .map((score) => ({
      index: typeof score.item_index === "number" ? score.item_index : Number.POSITIVE_INFINITY,
      prompt: score.prompt
    }))
    .filter((score) => Number.isFinite(score.index))
    .sort((a, b) => a.index - b.index);
  const prompts: string[] = [];
  for (const score of scores) {
    if (prompts[score.index] == null) prompts[score.index] = score.prompt;
  }
  return prompts.map((prompt, index) => prompt || `Prompt ${index + 1}`);
}

function scoresByIndex(run: ComparableEvalRun): Map<number, ComparableEvalScore> {
  const scores = new Map<number, ComparableEvalScore>();
  for (const [fallbackIndex, score] of (run.eval_scores ?? []).entries()) {
    const index = typeof score.item_index === "number" ? score.item_index : fallbackIndex;
    if (index < 0 || scores.has(index)) continue;
    scores.set(index, score);
  }
  return scores;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function delta(right: number | null, left: number | null): number | null {
  if (right == null || left == null) return null;
  return Math.round((right - left) * 1e6) / 1e6;
}

function mean(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

import { ApiError } from "@/lib/api-error";
import {
  parseItemCorrelatedFailure,
  type ItemCorrelatedFailure
} from "@/lib/evals/correlation";
import type { EvalRunInput } from "@/lib/evals/types";

export type StoredEvalResumeRow = {
  id: string;
  status: string;
  baseline_label: string | null;
  correlated_failure?: unknown;
  council_config: {
    models?: unknown;
    judgeModel?: unknown;
    reviewerModel?: unknown;
    debateDepth?: unknown;
    researchEnabled?: unknown;
  } | null;
  eval_sets: StoredEvalSet | StoredEvalSet[] | null;
  eval_scores: Array<{
    item_index: number | null;
    score: number | string | null;
    correlated_failure?: unknown;
    member_scores?: unknown;
  }> | null;
};

type StoredEvalSet = {
  name?: unknown;
  description?: unknown;
  rubric?: unknown;
  hidden_criteria?: unknown;
  items?: unknown;
};

export type EvalResumeState = {
  evalRunId: string;
  input: EvalRunInput;
  completedIndexes: number[];
  scores: number[];
  itemMetrics: Array<ItemCorrelatedFailure | undefined>;
};

export type EvalSetItem = {
  prompt: string;
  hiddenCriteria?: string;
};

export type StoredEvalSetRecord = {
  id: string;
  name: string;
  description?: string | null;
  rubric: string;
  hidden_criteria?: string | null;
  items: unknown;
  created_at?: string;
};

export function parseEvalSetItems(value: unknown): EvalSetItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !("prompt" in item)) return [];
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
    if (!prompt) return [];
    const hiddenCriteria = "hiddenCriteria" in item && typeof item.hiddenCriteria === "string"
      ? item.hiddenCriteria.trim()
      : "";
    return hiddenCriteria ? [{ prompt, hiddenCriteria }] : [{ prompt }];
  });
}

export function buildEvalResumeState(row: StoredEvalResumeRow): EvalResumeState {
  if (row.status === "running") throw new ApiError(409, "This eval is still running.");
  if (row.status === "complete") throw new ApiError(400, "This eval is already complete.");
  if (row.status !== "partial" && row.status !== "failed") {
    throw new ApiError(400, "This eval cannot be resumed.");
  }

  const set = firstRelation(row.eval_sets);
  if (!set) throw new ApiError(400, "Eval set is missing.");

  const items = parseEvalSetItems(set.items);
  const config = row.council_config ?? {};
  const models = Array.isArray(config.models)
    ? config.models.filter((modelId): modelId is string => typeof modelId === "string" && modelId.trim().length > 0)
    : [];
  const judgeModel = typeof config.judgeModel === "string" ? config.judgeModel.trim() : "";
  const reviewerModel = typeof config.reviewerModel === "string" ? config.reviewerModel.trim() : "";
  const debateDepth = typeof config.debateDepth === "number" && Number.isInteger(config.debateDepth)
    ? config.debateDepth
    : 1;
  const name = typeof set.name === "string" ? set.name.trim() : "";
  const rubric = typeof set.rubric === "string" ? set.rubric.trim() : "";
  const hiddenCriteria = typeof set.hidden_criteria === "string" ? set.hidden_criteria.trim() : "";

  if (!name || !rubric || !items.length || !models.length || !judgeModel) {
    throw new ApiError(400, "Eval configuration is incomplete.");
  }

  const completed = (row.eval_scores ?? [])
    .map((score) => ({
      index: typeof score.item_index === "number" ? score.item_index : -1,
      score: Number(score.score),
      correlatedFailure: parseItemCorrelatedFailure(score.correlated_failure)
    }))
    .filter((score) => score.index >= 0 && Number.isFinite(score.score))
    .sort((left, right) => left.index - right.index);

  if (completed.length >= items.length) {
    throw new ApiError(400, "This eval has no remaining prompts.");
  }

  const itemMetrics: Array<ItemCorrelatedFailure | undefined> = [];
  for (const score of completed) {
    itemMetrics[score.index] = score.correlatedFailure;
  }

  return {
    evalRunId: row.id,
    input: {
      name,
      description: typeof set.description === "string" && set.description.trim()
        ? set.description.trim()
        : undefined,
      rubric,
      hiddenCriteria: hiddenCriteria || undefined,
      baselineLabel: row.baseline_label ?? undefined,
      items,
      models,
      judgeModel,
      reviewerModel: reviewerModel || undefined,
      debateDepth: Math.min(3, Math.max(1, debateDepth)),
      researchEnabled: Boolean(config.researchEnabled)
    },
    completedIndexes: completed.map((score) => score.index),
    scores: completed.map((score) => score.score),
    itemMetrics
  };
}

export function evalInputFromStoredSet(
  set: StoredEvalSetRecord,
  config: Pick<EvalRunInput, "models" | "judgeModel" | "reviewerModel" | "debateDepth" | "researchEnabled" | "baselineLabel">
): EvalRunInput {
  const items = parseEvalSetItems(set.items);
  const name = set.name.trim();
  const rubric = set.rubric.trim();
  const judgeModel = config.judgeModel.trim();
  const models = config.models.map((modelId) => modelId.trim()).filter(Boolean);
  const hiddenCriteria = set.hidden_criteria?.trim() || "";
  const description = set.description?.trim() || "";
  const reviewerModel = config.reviewerModel?.trim() || "";

  if (!name || !rubric || !items.length || !models.length || !judgeModel) {
    throw new ApiError(400, "Eval configuration is incomplete.");
  }

  return {
    evalSetId: set.id,
    name,
    description: description || undefined,
    rubric,
    hiddenCriteria: hiddenCriteria || undefined,
    baselineLabel: config.baselineLabel,
    items,
    models,
    judgeModel,
    reviewerModel: reviewerModel || undefined,
    debateDepth: Math.min(3, Math.max(1, config.debateDepth)),
    researchEnabled: Boolean(config.researchEnabled)
  };
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

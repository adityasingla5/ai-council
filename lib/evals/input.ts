import type { EvalRunInput } from "@/lib/evals/types";

export function evalReviewerModel(
  input: Pick<EvalRunInput, "judgeModel" | "reviewerModel">
): string {
  const reviewer = input.reviewerModel?.trim();
  return reviewer || input.judgeModel;
}

export function evalHiddenCriteria(params: {
  rubric: string;
  hiddenCriteria?: string;
  itemHiddenCriteria?: string;
}): string {
  const item = params.itemHiddenCriteria?.trim();
  if (item) return item;
  const global = params.hiddenCriteria?.trim();
  if (global) return global;
  return params.rubric.trim();
}

export function evalHasDistinctHiddenCriteria(params: {
  rubric: string;
  hiddenCriteria?: string;
  itemHiddenCriteria?: string;
}): boolean {
  const hidden = params.itemHiddenCriteria?.trim() || params.hiddenCriteria?.trim();
  if (!hidden) return false;
  return hidden !== params.rubric.trim();
}

export function evalModelIds(
  input: Pick<EvalRunInput, "models" | "judgeModel" | "reviewerModel">
): string[] {
  return uniqueNonEmpty([...input.models, input.judgeModel, input.reviewerModel]);
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

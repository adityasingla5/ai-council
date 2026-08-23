import { z } from "zod";

export const EVAL_HELD_OUT_FAIL_THRESHOLD = 60;
export const CORRELATED_FAILURE_THRESHOLD = 0.25;

export type IndependenceLabel = "correlated" | "independent" | "insufficient";

export type MemberHeldOutScore = {
  modelId: string;
  score: number;
  rationale: string;
  failed: boolean;
};

export type ItemCorrelatedFailure = {
  failThreshold: number;
  memberCount: number;
  failedCount: number;
  failRate: number;
  coFailureRate: number;
  expectedCoFailureRate: number;
  excessCoFailure: number;
  answerAgreement: number;
  rankingAgreement: number;
  internalAgreement: number;
  hiddenScore: number;
  rubricScore: number;
  framingGap: number;
  consensusTrap: number;
  correlatedFailure: number;
  allFailed: boolean;
  wrongTask: boolean;
  independence: IndependenceLabel;
};

export type AggregateCorrelatedFailure = {
  items: number;
  meanRubricScore: number;
  meanHiddenScore: number;
  meanAnswerAgreement: number;
  meanCoFailureRate: number;
  meanExpectedCoFailureRate: number;
  meanExcessCoFailure: number;
  meanConsensusTrap: number;
  meanCorrelatedFailure: number;
  meanFramingGap: number;
  allFailedItems: number;
  correlatedItems: number;
  independence: IndependenceLabel;
};

const memberHeldOutScoreSchema = z.object({
  modelId: z.string().trim().min(1),
  score: z.number().finite().min(0).max(100),
  rationale: z.string(),
  failed: z.boolean()
});

export const itemCorrelatedFailureSchema = z.object({
  failThreshold: z.number().finite(),
  memberCount: z.number().finite(),
  failedCount: z.number().finite(),
  failRate: z.number().finite(),
  coFailureRate: z.number().finite(),
  expectedCoFailureRate: z.number().finite(),
  excessCoFailure: z.number().finite(),
  answerAgreement: z.number().finite(),
  rankingAgreement: z.number().finite(),
  internalAgreement: z.number().finite(),
  hiddenScore: z.number().finite(),
  rubricScore: z.number().finite(),
  framingGap: z.number().finite(),
  consensusTrap: z.number().finite(),
  correlatedFailure: z.number().finite(),
  allFailed: z.boolean(),
  wrongTask: z.boolean(),
  independence: z.enum(["correlated", "independent", "insufficient"])
});

export const aggregateCorrelatedFailureSchema = z.object({
  items: z.number().finite(),
  meanRubricScore: z.number().finite(),
  meanHiddenScore: z.number().finite(),
  meanAnswerAgreement: z.number().finite(),
  meanCoFailureRate: z.number().finite(),
  meanExpectedCoFailureRate: z.number().finite(),
  meanExcessCoFailure: z.number().finite(),
  meanConsensusTrap: z.number().finite(),
  meanCorrelatedFailure: z.number().finite(),
  meanFramingGap: z.number().finite(),
  allFailedItems: z.number().finite(),
  correlatedItems: z.number().finite(),
  independence: z.enum(["correlated", "independent", "insufficient"])
});

export function memberHeldOutScore(
  modelId: string,
  score: number,
  rationale: string,
  failThreshold = EVAL_HELD_OUT_FAIL_THRESHOLD
): MemberHeldOutScore {
  const bounded = clampScore(score);
  return {
    modelId,
    score: bounded,
    rationale,
    failed: bounded < failThreshold
  };
}

export function tokenizeForAgreement(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3)
  );
}

export function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

export function meanPairwiseJaccard(texts: string[]): number {
  const tokens = texts
    .map((text) => text.trim())
    .filter(Boolean)
    .map(tokenizeForAgreement);
  return meanPairwise(tokens, jaccardSimilarity);
}

export function pairwiseBothTrueRate(flags: boolean[]): number {
  return meanPairwise(flags, (left, right) => (left && right ? 1 : 0));
}

export function rankingScoreAgreement(scores: number[]): number {
  const valid = scores.filter((score) => Number.isFinite(score));
  if (valid.length < 2) return 0;
  const mean = average(valid);
  const variance = average(valid.map((score) => (score - mean) ** 2));
  return clamp01(1 - Math.sqrt(variance) / 50);
}

export function measureCorrelatedFailure(params: {
  memberScores: MemberHeldOutScore[];
  memberAnswers: Array<{ modelId: string; content: string }>;
  rankingScores?: number[];
  hiddenScore: number;
  rubricScore: number;
  wrongTask?: boolean;
  failThreshold?: number;
}): ItemCorrelatedFailure {
  const failThreshold = params.failThreshold ?? EVAL_HELD_OUT_FAIL_THRESHOLD;
  const hiddenScore = clampScore(params.hiddenScore);
  const rubricScore = clampScore(params.rubricScore);
  const memberCount = params.memberScores.length;
  const failedCount = params.memberScores.filter((member) => member.failed).length;
  const failRate = memberCount === 0 ? 0 : failedCount / memberCount;
  const coFailureRate = pairwiseBothTrueRate(params.memberScores.map((member) => member.failed));
  const expectedCoFailureRate = failRate * failRate;
  const answersByModel = new Map(params.memberAnswers.map((answer) => [answer.modelId, answer.content]));
  const answerAgreement = meanPairwiseJaccard(
    params.memberScores.map((member) => answersByModel.get(member.modelId) ?? "")
  );
  const rankingScores = (params.rankingScores ?? []).filter((score) => Number.isFinite(score));
  const rankingAgreement = rankingScoreAgreement(rankingScores);
  const meanRanking = rankingScores.length ? average(rankingScores) / 100 : 0;
  const rankingConfidence = rankingAgreement * clamp01(meanRanking);
  const internalAgreement = rankingScores.length >= 2
    ? Math.max(answerAgreement, rankingConfidence)
    : answerAgreement;
  const correlatedFailure = clamp01(answerAgreement * coFailureRate);
  const consensusTrap = clamp01(internalAgreement * (1 - hiddenScore / 100));
  const independence = classifyIndependence(memberCount, correlatedFailure);

  return {
    failThreshold,
    memberCount,
    failedCount,
    failRate,
    coFailureRate,
    expectedCoFailureRate,
    excessCoFailure: coFailureRate - expectedCoFailureRate,
    answerAgreement,
    rankingAgreement,
    internalAgreement,
    hiddenScore,
    rubricScore,
    framingGap: rubricScore - hiddenScore,
    consensusTrap,
    correlatedFailure,
    allFailed: memberCount > 0 && failedCount === memberCount,
    wrongTask: Boolean(params.wrongTask),
    independence
  };
}

export function aggregateCorrelatedFailure(
  items: Array<ItemCorrelatedFailure | undefined>
): AggregateCorrelatedFailure | undefined {
  const measured = items.filter((item): item is ItemCorrelatedFailure => Boolean(item));
  if (!measured.length) return undefined;

  const meanCorrelatedFailure = average(measured.map((item) => item.correlatedFailure));
  const comparable = measured.filter((item) => item.memberCount >= 2);
  const independence = comparable.length
    ? classifyIndependence(2, meanCorrelatedFailure)
    : "insufficient";

  return {
    items: measured.length,
    meanRubricScore: average(measured.map((item) => item.rubricScore)),
    meanHiddenScore: average(measured.map((item) => item.hiddenScore)),
    meanAnswerAgreement: average(measured.map((item) => item.answerAgreement)),
    meanCoFailureRate: average(measured.map((item) => item.coFailureRate)),
    meanExpectedCoFailureRate: average(measured.map((item) => item.expectedCoFailureRate)),
    meanExcessCoFailure: average(measured.map((item) => item.excessCoFailure)),
    meanConsensusTrap: average(measured.map((item) => item.consensusTrap)),
    meanCorrelatedFailure,
    meanFramingGap: average(measured.map((item) => item.framingGap)),
    allFailedItems: measured.filter((item) => item.allFailed).length,
    correlatedItems: measured.filter((item) => item.independence === "correlated").length,
    independence
  };
}

export function parseMemberHeldOutScores(value: unknown): MemberHeldOutScore[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = memberHeldOutScoreSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parseItemCorrelatedFailure(value: unknown): ItemCorrelatedFailure | undefined {
  const parsed = itemCorrelatedFailureSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseAggregateCorrelatedFailure(value: unknown): AggregateCorrelatedFailure | undefined {
  const parsed = aggregateCorrelatedFailureSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function classifyIndependence(memberCount: number, correlatedFailure: number): IndependenceLabel {
  if (memberCount < 2) return "insufficient";
  return correlatedFailure >= CORRELATED_FAILURE_THRESHOLD ? "correlated" : "independent";
}

function meanPairwise<T>(values: T[], score: (left: T, right: T) => number): number {
  if (values.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      const left = values[i];
      const right = values[j];
      if (left === undefined || right === undefined) continue;
      total += score(left, right);
      pairs += 1;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

import { isCouncilAbortError } from "@/lib/council/abort";
import { runCouncil } from "@/lib/council";
import { getErrorLog } from "@/lib/errors";
import {
  aggregateCorrelatedFailure,
  EVAL_HELD_OUT_FAIL_THRESHOLD,
  measureCorrelatedFailure,
  memberHeldOutScore,
  type ItemCorrelatedFailure,
  type MemberHeldOutScore
} from "@/lib/evals/correlation";
import type { EvalAbortReason, EvalEvent } from "@/lib/evals/events";
import {
  evalHasDistinctHiddenCriteria,
  evalHiddenCriteria,
  evalModelIds,
  evalReviewerModel
} from "@/lib/evals/input";
import {
  createEvalRunRecords,
  loadEvalRunForResume,
  markEvalRunComplete,
  markEvalRunFailed,
  markEvalRunPartial,
  markEvalRunRunning,
  persistEvalScore
} from "@/lib/evals/repository";
import { scoreEvalAnswer, scoreHeldOutAnswer } from "@/lib/evals/scoring";
import type { EvalAdminClient } from "@/lib/evals/repository";
import type { EvalRunInput, EvalRunResult } from "@/lib/evals/types";
import { loadModelPricing } from "@/lib/model-pricing";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { AuthProfile, CouncilRunInput, CouncilRunResult, StageResult } from "@/lib/types";
import type { CouncilRunContext } from "@/lib/council/context";
import { buildUsageEvent, persistUsageEvent } from "@/lib/usage";
import {
  assertModelPricingAvailable,
  releaseCompletionBudget
} from "@/lib/production-guardrails";

export type RunEvalParams = {
  profile: Pick<AuthProfile, "id" | "email">;
  input?: EvalRunInput;
  resumeEvalRunId?: string;
  signal?: AbortSignal;
  abortReason?: () => EvalAbortReason;
  onEvent?: (event: EvalEvent) => void | Promise<void>;
};

type CouncilEvalResult = Pick<CouncilRunResult, "finalAnswer"> &
  Partial<Pick<CouncilRunResult, "initialResponses" | "judge">>;

export type EvalServiceDependencies = {
  createAdminClient: () => EvalAdminClient;
  loadPricing: typeof loadModelPricing;
  createRunRecords: typeof createEvalRunRecords;
  loadResume: typeof loadEvalRunForResume;
  runCouncil: (
    input: CouncilRunInput,
    context: CouncilRunContext
  ) => Promise<CouncilEvalResult>;
  scoreAnswer: typeof scoreEvalAnswer;
  scoreHeldOut: typeof scoreHeldOutAnswer;
  persistUsage: typeof persistUsageEvent;
  persistScore: typeof persistEvalScore;
  markComplete: typeof markEvalRunComplete;
  markPartial: typeof markEvalRunPartial;
  markRunning: typeof markEvalRunRunning;
  markFailed: typeof markEvalRunFailed;
};

const defaultDependencies: EvalServiceDependencies = {
  createAdminClient: createSupabaseAdminClient,
  loadPricing: loadModelPricing,
  createRunRecords: createEvalRunRecords,
  loadResume: loadEvalRunForResume,
  runCouncil,
  scoreAnswer: scoreEvalAnswer,
  scoreHeldOut: scoreHeldOutAnswer,
  persistUsage: persistUsageEvent,
  persistScore: persistEvalScore,
  markComplete: markEvalRunComplete,
  markPartial: markEvalRunPartial,
  markRunning: markEvalRunRunning,
  markFailed: markEvalRunFailed
};

export async function runEval(
  params: RunEvalParams,
  dependencies: EvalServiceDependencies = defaultDependencies
): Promise<EvalRunResult> {
  const admin = dependencies.createAdminClient();
  let evalRunId: string | undefined;
  const scores: number[] = [];
  const itemMetrics: Array<ItemCorrelatedFailure | undefined> = [];
  let input = params.input;
  const completedIndexes = new Set<number>();

  try {
    if (params.resumeEvalRunId) {
      const resume = await dependencies.loadResume({
        admin,
        userId: params.profile.id,
        evalRunId: params.resumeEvalRunId
      });
      evalRunId = resume.evalRunId;
      input = resume.input;
      for (const [index, score] of resume.scores.entries()) {
        const itemIndex = resume.completedIndexes[index];
        if (itemIndex === undefined) continue;
        completedIndexes.add(itemIndex);
        scores[itemIndex] = score;
        itemMetrics[itemIndex] = resume.itemMetrics[itemIndex];
      }
    } else if (!input) {
      throw new Error("Eval input is required.");
    }

    if (!input) throw new Error("Eval input is required.");

    const pricingByModel = await dependencies.loadPricing({ required: true });
    assertModelPricingAvailable(evalModelIds(input), pricingByModel);
    const reviewerModel = evalReviewerModel(input);

    if (params.resumeEvalRunId && evalRunId) {
      await dependencies.markRunning({ admin, evalRunId });
    } else if (input) {
      evalRunId = await dependencies.createRunRecords({
        admin,
        userId: params.profile.id,
        input
      });
    }

    if (!input || !evalRunId) throw new Error("Eval input is required.");

    await emit(params, {
      type: "started",
      evalRunId,
      total: input.items.length,
      completed: completedIndexes.size
    });

    for (const [index, item] of input.items.entries()) {
      if (completedIndexes.has(index)) continue;

      await emit(params, {
        type: "item_started",
        evalRunId,
        itemIndex: index,
        total: input.items.length,
        prompt: item.prompt
      });

      const council = await dependencies.runCouncil(
        {
          prompt: item.prompt,
          models: input.models,
          judgeModel: input.judgeModel,
          debateDepth: input.debateDepth,
          researchEnabled: input.researchEnabled,
          saveHistory: false
        },
        {
          userId: params.profile.id,
          userEmail: params.profile.email,
          signal: params.signal
        }
      );

      const criteria = evalHiddenCriteria({
        rubric: input.rubric,
        hiddenCriteria: input.hiddenCriteria,
        itemHiddenCriteria: item.hiddenCriteria
      });
      const distinctHidden = evalHasDistinctHiddenCriteria({
        rubric: input.rubric,
        hiddenCriteria: input.hiddenCriteria,
        itemHiddenCriteria: item.hiddenCriteria
      });

      const score = await dependencies.scoreAnswer({
        judgeModel: reviewerModel,
        prompt: item.prompt,
        rubric: input.rubric,
        answer: council.finalAnswer,
        signal: params.signal,
        userId: params.profile.id,
        pricing: pricingByModel[reviewerModel]
      });
      await persistScoringUsage({
        dependencies,
        profileId: params.profile.id,
        reviewerModel,
        completion: score.completion,
        pricing: pricingByModel[reviewerModel],
        evalRunId,
        itemIndex: index,
        scoring: "rubric"
      });

      let hiddenScore = score.score;
      let adversarialRationale = score.rationale;
      let wrongTask = false;
      let failedChecks: string[] = [];

      if (distinctHidden) {
        const heldOut = await dependencies.scoreHeldOut({
          judgeModel: reviewerModel,
          prompt: item.prompt,
          criteria,
          answer: council.finalAnswer,
          isolation: "final",
          signal: params.signal,
          userId: params.profile.id,
          pricing: pricingByModel[reviewerModel]
        });
        await persistScoringUsage({
          dependencies,
          profileId: params.profile.id,
          reviewerModel,
          completion: heldOut.completion,
          pricing: pricingByModel[reviewerModel],
          evalRunId,
          itemIndex: index,
          scoring: "held_out"
        });
        hiddenScore = heldOut.score;
        adversarialRationale = heldOut.rationale;
        wrongTask = heldOut.wrongTask;
        failedChecks = heldOut.failedChecks;
      }

      const memberAnswers = independentMemberAnswers(input.models, council.initialResponses);
      const memberScores: MemberHeldOutScore[] = [];
      for (const member of memberAnswers) {
        if (!member.content) {
          memberScores.push(
            memberHeldOutScore(member.modelId, 0, "No independent initial answer.")
          );
          continue;
        }

        const heldOut = await dependencies.scoreHeldOut({
          judgeModel: reviewerModel,
          prompt: item.prompt,
          criteria,
          answer: member.content,
          isolation: "member",
          signal: params.signal,
          userId: params.profile.id,
          pricing: pricingByModel[reviewerModel]
        });
        await persistScoringUsage({
          dependencies,
          profileId: params.profile.id,
          reviewerModel,
          completion: heldOut.completion,
          pricing: pricingByModel[reviewerModel],
          evalRunId,
          itemIndex: index,
          scoring: "member",
          memberModelId: member.modelId
        });
        memberScores.push(
          memberHeldOutScore(member.modelId, heldOut.score, heldOut.rationale)
        );
      }

      const correlatedFailure = measureCorrelatedFailure({
        memberScores,
        memberAnswers,
        rankingScores: council.judge?.rankings?.map((ranking) => ranking.score),
        hiddenScore,
        rubricScore: score.score,
        wrongTask,
        failThreshold: EVAL_HELD_OUT_FAIL_THRESHOLD
      });

      scores[index] = score.score;
      itemMetrics[index] = correlatedFailure;
      completedIndexes.add(index);

      await dependencies.persistScore({
        admin,
        evalRunId,
        itemIndex: index,
        prompt: item.prompt,
        score: score.score,
        rationale: score.rationale,
        finalAnswer: council.finalAnswer,
        judgeModel: input.judgeModel,
        hiddenScore,
        adversarialRationale,
        reviewerModel,
        memberScores,
        correlatedFailure
      });

      await emit(params, {
        type: "item_scored",
        evalRunId,
        itemIndex: index,
        total: input.items.length,
        prompt: item.prompt,
        score: score.score,
        rationale: score.rationale,
        finalAnswer: council.finalAnswer,
        hiddenScore,
        adversarialRationale,
        wrongTask,
        failedChecks,
        memberScores,
        correlatedFailure
      });
    }

    const completedScores = completedScoreValues(scores);
    const aggregateScore = averageScore(completedScores);
    const correlatedFailure = aggregateCorrelatedFailure(itemMetrics);
    await dependencies.markComplete({ admin, evalRunId, aggregateScore, correlatedFailure });
    await emit(params, {
      type: "complete",
      evalRunId,
      aggregateScore,
      scored: completedScores.length,
      total: input.items.length,
      correlatedFailure
    });

    return {
      evalRunId,
      aggregateScore,
      status: "complete",
      scored: completedScores.length,
      total: input.items.length,
      correlatedFailure
    };
  } catch (error) {
    const completedScores = completedScoreValues(scores);
    if (evalRunId && input && isCouncilAbortError(error, params.signal) && completedScores.length > 0) {
      const aggregateScore = averageScore(completedScores);
      const reason = params.abortReason?.() ?? "cancelled";
      const correlatedFailure = aggregateCorrelatedFailure(itemMetrics);
      await dependencies.markPartial({ admin, evalRunId, aggregateScore, correlatedFailure });
      await emit(params, {
        type: "partial",
        evalRunId,
        aggregateScore,
        scored: completedScores.length,
        total: input.items.length,
        reason,
        correlatedFailure
      });
      return {
        evalRunId,
        aggregateScore,
        status: "partial",
        scored: completedScores.length,
        total: input.items.length,
        reason,
        correlatedFailure
      };
    }

    if (evalRunId) {
      const failedUpdateError = await dependencies.markFailed(admin, evalRunId);
      if (failedUpdateError) {
        console.error("[evals] could not mark eval run failed", {
          evalRunId,
          ...getErrorLog(failedUpdateError)
        });
      }
    }
    throw error;
  }
}

async function emit(params: RunEvalParams, event: EvalEvent): Promise<void> {
  await params.onEvent?.(event);
}

function independentMemberAnswers(
  models: string[],
  initialResponses: StageResult[] | undefined
): Array<{ modelId: string; content: string }> {
  return models.map((modelId) => {
    const response = initialResponses?.find((entry) => entry.modelId === modelId);
    const content = response?.status === "complete" ? response.content.trim() : "";
    return { modelId, content };
  });
}

async function persistScoringUsage(params: {
  dependencies: EvalServiceDependencies;
  profileId: string;
  reviewerModel: string;
  completion: {
    usage: Parameters<typeof buildUsageEvent>[0]["usage"];
    latencyMs: number;
    budgetReservationId?: string;
  };
  pricing: Parameters<typeof buildUsageEvent>[0]["pricing"];
  evalRunId: string;
  itemIndex: number;
  scoring: "rubric" | "held_out" | "member";
  memberModelId?: string;
}): Promise<void> {
  await params.dependencies.persistUsage({
    userId: params.profileId,
    usage: buildUsageEvent({
      stage: "eval_scoring",
      modelId: params.reviewerModel,
      usage: params.completion.usage,
      latencyMs: params.completion.latencyMs,
      pricing: params.pricing
    }),
    metadata: {
      evalRunId: params.evalRunId,
      itemIndex: params.itemIndex,
      scoring: params.scoring,
      ...(params.memberModelId ? { memberModelId: params.memberModelId } : {})
    }
  });
  await releaseCompletionBudget(params.profileId, params.completion.budgetReservationId);
}

function completedScoreValues(scores: Array<number | undefined>): number[] {
  return scores.filter((score): score is number => typeof score === "number" && Number.isFinite(score));
}

function averageScore(scores: number[]): number {
  if (!scores.length) return 0;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

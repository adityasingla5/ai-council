import { ApiError } from "@/lib/api-error";
import type { AggregateCorrelatedFailure, ItemCorrelatedFailure, MemberHeldOutScore } from "@/lib/evals/correlation";
import { evalReviewerModel } from "@/lib/evals/input";
import { buildEvalResumeState, type EvalResumeState, type StoredEvalSetRecord } from "@/lib/evals/resume";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { EvalRunInput } from "@/lib/evals/types";

export type EvalAdminClient = ReturnType<typeof createSupabaseAdminClient>;

export async function loadEvalSetForUser(params: {
  admin: EvalAdminClient;
  userId: string;
  evalSetId: string;
}): Promise<StoredEvalSetRecord> {
  const { data, error } = await params.admin
    .from("eval_sets")
    .select("id,name,description,rubric,hidden_criteria,items,created_at")
    .eq("id", params.evalSetId)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id || typeof data.name !== "string" || typeof data.rubric !== "string") {
    throw new ApiError(404, "Eval set not found.");
  }
  return data as StoredEvalSetRecord;
}

export async function listEvalSetsForUser(userId: string): Promise<StoredEvalSetRecord[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("eval_sets")
    .select("id,name,description,rubric,hidden_criteria,items,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as StoredEvalSetRecord[];
}

export async function createEvalRunRecords(params: {
  admin: EvalAdminClient;
  userId: string;
  input: EvalRunInput;
}): Promise<string> {
  const evalSetId = params.input.evalSetId
    ? (await loadEvalSetForUser({
      admin: params.admin,
      userId: params.userId,
      evalSetId: params.input.evalSetId
    })).id
    : await insertEvalSet(params);

  const { data: evalRun, error: evalRunError } = await params.admin
    .from("eval_runs")
    .insert({
      eval_set_id: evalSetId,
      user_id: params.userId,
      baseline_label: params.input.baselineLabel ?? null,
      council_config: {
        models: params.input.models,
        judgeModel: params.input.judgeModel,
        reviewerModel: evalReviewerModel(params.input),
        debateDepth: params.input.debateDepth,
        researchEnabled: params.input.researchEnabled
      },
      status: "running"
    })
    .select("id")
    .single();
  if (evalRunError) throw evalRunError;
  return evalRun.id as string;
}

async function insertEvalSet(params: {
  admin: EvalAdminClient;
  userId: string;
  input: EvalRunInput;
}): Promise<string> {
  const { data: evalSet, error: evalSetError } = await params.admin
    .from("eval_sets")
    .insert({
      user_id: params.userId,
      name: params.input.name,
      description: params.input.description ?? null,
      rubric: params.input.rubric,
      hidden_criteria: params.input.hiddenCriteria?.trim() || null,
      items: params.input.items
    })
    .select("id")
    .single();
  if (evalSetError) throw evalSetError;
  return evalSet.id as string;
}

export async function persistEvalScore(params: {
  admin: EvalAdminClient;
  evalRunId: string;
  itemIndex: number;
  prompt: string;
  score: number;
  rationale: string;
  finalAnswer: string;
  judgeModel: string;
  hiddenScore?: number;
  adversarialRationale?: string;
  reviewerModel?: string;
  memberScores?: MemberHeldOutScore[];
  correlatedFailure?: ItemCorrelatedFailure;
}): Promise<void> {
  const { error } = await params.admin.from("eval_scores").insert({
    eval_run_id: params.evalRunId,
    item_index: params.itemIndex,
    prompt: params.prompt,
    score: params.score,
    rationale: params.rationale,
    final_answer: params.finalAnswer,
    judge_model: params.judgeModel,
    hidden_score: params.hiddenScore ?? null,
    adversarial_rationale: params.adversarialRationale ?? null,
    reviewer_model: params.reviewerModel ?? null,
    member_scores: params.memberScores ?? [],
    correlated_failure: params.correlatedFailure ?? {}
  });
  if (error) throw error;
}

export async function markEvalRunComplete(params: {
  admin: EvalAdminClient;
  evalRunId: string;
  aggregateScore: number;
  correlatedFailure?: AggregateCorrelatedFailure;
}): Promise<void> {
  const { error } = await params.admin
    .from("eval_runs")
    .update({
      status: "complete",
      aggregate_score: params.aggregateScore,
      correlated_failure: params.correlatedFailure ?? {},
      completed_at: new Date().toISOString()
    })
    .eq("id", params.evalRunId);
  if (error) throw error;
}

export async function markEvalRunFailed(admin: EvalAdminClient, evalRunId: string): Promise<unknown> {
  const { error } = await admin
    .from("eval_runs")
    .update({ status: "failed", completed_at: new Date().toISOString() })
    .eq("id", evalRunId);
  return error;
}

export async function markEvalRunPartial(params: {
  admin: EvalAdminClient;
  evalRunId: string;
  aggregateScore: number;
  correlatedFailure?: AggregateCorrelatedFailure;
}): Promise<void> {
  const { error } = await params.admin
    .from("eval_runs")
    .update({
      status: "partial",
      aggregate_score: params.aggregateScore,
      correlated_failure: params.correlatedFailure ?? {},
      completed_at: new Date().toISOString()
    })
    .eq("id", params.evalRunId);
  if (error) throw error;
}

export async function markEvalRunRunning(params: {
  admin: EvalAdminClient;
  evalRunId: string;
}): Promise<void> {
  const { error } = await params.admin
    .from("eval_runs")
    .update({
      status: "running",
      completed_at: null
    })
    .eq("id", params.evalRunId);
  if (error) throw error;
}

export async function loadEvalRunForResume(params: {
  admin: EvalAdminClient;
  userId: string;
  evalRunId: string;
}): Promise<EvalResumeState> {
  const { data, error } = await params.admin
    .from("eval_runs")
    .select("id,eval_set_id,status,baseline_label,council_config,eval_sets(name,description,rubric,hidden_criteria,items),eval_scores(item_index,score,correlated_failure)")
    .eq("id", params.evalRunId)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "Eval run not found.");
  return buildEvalResumeState(data);
}

export async function listEvalRunsForUser(userId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("eval_runs")
    .select("id,eval_set_id,status,aggregate_score,created_at,baseline_label,correlated_failure,council_config,eval_sets(name,rubric,hidden_criteria,description,items),eval_scores(item_index,score,prompt,rationale,final_answer,hidden_score,adversarial_rationale,reviewer_model,member_scores,correlated_failure)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}

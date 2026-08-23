import type { infer as ZodInfer } from "zod";
import type { AggregateCorrelatedFailure } from "@/lib/evals/correlation";
import type { EvalAbortReason } from "@/lib/evals/events";
import type { evalReuseSchema, evalRunSchema } from "@/lib/validation";

export type EvalRunInput = ZodInfer<typeof evalRunSchema>;
export type EvalReuseInput = ZodInfer<typeof evalReuseSchema>;

export type EvalRunResult = {
  evalRunId: string;
  aggregateScore: number;
  status: "complete" | "partial";
  scored: number;
  total: number;
  reason?: EvalAbortReason;
  correlatedFailure?: AggregateCorrelatedFailure;
};

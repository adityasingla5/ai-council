import { z } from "zod";
import { MAX_FIRECRAWL_SEARCH_LIMIT, MIN_DETAILED_RESEARCH_SOURCES } from "@/lib/firecrawl";
import { MAX_ATTACHMENT_COUNT, MAX_COUNCIL_DEBATE_ROUNDS, MAX_COUNCIL_MODELS, MAX_PROMPT_CHARACTERS } from "@/lib/limits";

export const councilRunSchema = z.object({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARACTERS),
  models: z.array(z.string().trim().min(1)).min(1).max(MAX_COUNCIL_MODELS).refine((models) => new Set(models).size === models.length, {
    message: "Council models must be unique."
  }),
  judgeModel: z.string().trim().min(1),
  debateDepth: z.number().int().min(1).max(MAX_COUNCIL_DEBATE_ROUNDS),
  researchEnabled: z.boolean(),
  saveHistory: z.boolean(),
  threadId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENT_COUNT).refine((ids) => new Set(ids).size === ids.length, {
    message: "Attached files must be unique."
  }).optional()
});

export const researchSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  limit: z.number().int().min(MIN_DETAILED_RESEARCH_SOURCES).max(MAX_FIRECRAWL_SEARCH_LIMIT).optional()
});

export const inviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["admin", "member"]).default("member")
});

export const adminUsageBudgetSchema = z.object({
  monthlyBudgetUsd: z.number().finite().min(0).max(999999.999999).nullable()
});

export const profilePreferencesSchema = z.object({
  defaultSaveHistory: z.boolean()
});

export const chatTitleSchema = z.object({
  title: z.string().trim().min(1).max(120)
});


export const evalResumeSchema = z.object({
  evalRunId: z.string().uuid()
});

export const evalRunSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  rubric: z.string().trim().min(1).max(6000),
  hiddenCriteria: z.string().trim().max(6000).optional(),
  baselineLabel: z.string().trim().max(120).optional(),
  items: z.array(z.object({
    prompt: z.string().trim().min(1).max(6000),
    hiddenCriteria: z.string().trim().max(4000).optional()
  })).min(1).max(5),
  models: z.array(z.string().trim().min(1)).min(1).max(6).refine((models) => new Set(models).size === models.length, {
    message: "Eval models must be unique."
  }),
  judgeModel: z.string().trim().min(1),
  reviewerModel: z.string().trim().max(200).optional(),
  debateDepth: z.number().int().min(1).max(3).default(1),
  researchEnabled: z.boolean().default(false)
});

export function parseEvalRequest(body: unknown): { kind: "create"; input: z.infer<typeof evalRunSchema> } | { kind: "resume"; evalRunId: string } {
  if (isRecord(body) && typeof body.evalRunId === "string" && body.items === undefined) {
    return { kind: "resume", evalRunId: evalResumeSchema.parse(body).evalRunId };
  }
  return { kind: "create", input: evalRunSchema.parse(body) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

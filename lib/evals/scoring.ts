import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import { completeWithOpenRouter, type CompletionResult } from "@/lib/openrouter";
import type { ModelPricing } from "@/lib/usage";

const scoreOutputSchema = z.object({
  score: z.number().finite().min(0).max(100),
  rationale: z.string().trim().min(1).max(4000)
});

const heldOutOutputSchema = scoreOutputSchema.extend({
  failed_checks: z.array(z.string().trim().min(1).max(400)).max(12).optional(),
  wrong_task: z.boolean().optional()
});

export type ParsedEvalScore = {
  score: number;
  rationale: string;
};

export type ParsedHeldOutScore = ParsedEvalScore & {
  failedChecks: string[];
  wrongTask: boolean;
};

export type HeldOutIsolation = "final" | "member";

export function buildEvalScoreMessages(params: {
  prompt: string;
  rubric: string;
  answer: string;
}): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: "Score the answer from 0 to 100 against the rubric. Return JSON only."
    },
    {
      role: "user",
      content: `Prompt:\n${params.prompt}\n\nRubric:\n${params.rubric}\n\nAnswer:\n${params.answer}\n\nReturn {"score": number, "rationale": "short explanation"}.`
    }
  ];
}

export function parseEvalScoreOutput(content: string): ParsedEvalScore {
  try {
    const parsed = scoreOutputSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return { score: 0, rationale: content };
    return {
      score: parsed.data.score,
      rationale: parsed.data.rationale
    };
  } catch {
    return { score: 0, rationale: content };
  }
}

export function buildHeldOutScoreMessages(params: {
  prompt: string;
  criteria: string;
  answer: string;
  isolation: HeldOutIsolation;
}): ChatCompletionMessageParam[] {
  const isolation =
    params.isolation === "member"
      ? "You are an adversarial reviewer scoring one model's independent first-pass answer. You are not shown other models, debate, or judge synthesis. Ignore any appearance of consensus."
      : "You are an adversarial reviewer scoring the council's published answer. You are not shown member reasoning, debate, rankings, or the judge's notes. Do not treat fluency or internal consistency as correctness.";

  return [
    {
      role: "system",
      content: `${isolation} Score 0 to 100 against the held-out acceptance criteria only. The council did not see those criteria. Return JSON only.`
    },
    {
      role: "user",
      content: `User prompt (this is what the council saw):\n${params.prompt}\n\nHeld-out acceptance criteria (the council did not see this):\n${params.criteria}\n\nAnswer to review:\n${params.answer}\n\nReturn {"score": number, "rationale": "short explanation", "failed_checks": ["criteria that failed"], "wrong_task": boolean}. Set wrong_task true if the answer is a confident response to the prompt but misses the held-out task.`
    }
  ];
}

export function parseHeldOutScoreOutput(content: string): ParsedHeldOutScore {
  try {
    const parsed = heldOutOutputSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      return { score: 0, rationale: content, failedChecks: [], wrongTask: false };
    }
    return {
      score: parsed.data.score,
      rationale: parsed.data.rationale,
      failedChecks: parsed.data.failed_checks ?? [],
      wrongTask: Boolean(parsed.data.wrong_task)
    };
  } catch {
    return { score: 0, rationale: content, failedChecks: [], wrongTask: false };
  }
}

export async function scoreEvalAnswer(params: {
  judgeModel: string;
  prompt: string;
  rubric: string;
  answer: string;
  signal?: AbortSignal;
  userId?: string;
  pricing?: ModelPricing;
}): Promise<ParsedEvalScore & { completion: CompletionResult }> {
  const completion = await completeWithOpenRouter({
    model: params.judgeModel,
    responseFormat: "json_object",
    temperature: 0,
    maxTokens: 600,
    signal: params.signal,
    budget: params.userId ? { userId: params.userId, pricing: params.pricing } : undefined,
    messages: buildEvalScoreMessages(params)
  });

  return {
    ...parseEvalScoreOutput(completion.content),
    completion
  };
}

export async function scoreHeldOutAnswer(params: {
  judgeModel: string;
  prompt: string;
  criteria: string;
  answer: string;
  isolation: HeldOutIsolation;
  signal?: AbortSignal;
  userId?: string;
  pricing?: ModelPricing;
}): Promise<ParsedHeldOutScore & { completion: CompletionResult }> {
  const completion = await completeWithOpenRouter({
    model: params.judgeModel,
    responseFormat: "json_object",
    temperature: 0,
    maxTokens: 700,
    signal: params.signal,
    budget: params.userId ? { userId: params.userId, pricing: params.pricing } : undefined,
    messages: buildHeldOutScoreMessages(params)
  });

  return {
    ...parseHeldOutScoreOutput(completion.content),
    completion
  };
}

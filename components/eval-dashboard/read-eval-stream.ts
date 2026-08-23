import { parseEvalStreamBlock } from "@/lib/sse";
import type { EvalEvent, EvalScoreEvent } from "@/lib/evals/events";

export type LiveEvalState = {
  evalRunId?: string;
  total: number;
  completed: number;
  currentIndex?: number;
  currentPrompt?: string;
  scores: EvalScoreEvent[];
};

export const emptyLiveEvalState: LiveEvalState = {
  total: 0,
  completed: 0,
  scores: []
};

export type EvalStreamOutcome = {
  terminal: boolean;
  event?: Extract<EvalEvent, { type: "complete" | "partial" | "error" }>;
};

export async function readEvalEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: EvalEvent) => void
): Promise<EvalStreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome: EvalStreamOutcome = { terminal: false };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const event = parseEvalStreamBlock(block);
        if (!event) continue;
        outcome = recordEvalStreamEvent(event, outcome);
        onEvent(event);
      }
    }

    if (buffer.trim()) {
      const event = parseEvalStreamBlock(buffer);
      if (event) {
        outcome = recordEvalStreamEvent(event, outcome);
        onEvent(event);
      }
    }

    return outcome;
  } finally {
    reader.releaseLock();
  }
}

export function applyEvalEvent(state: LiveEvalState, event: EvalEvent): LiveEvalState {
  if (event.type === "started") {
    return {
      ...state,
      evalRunId: event.evalRunId,
      total: event.total,
      completed: event.completed
    };
  }
  if (event.type === "item_started") {
    return {
      ...state,
      evalRunId: event.evalRunId,
      total: event.total,
      currentIndex: event.itemIndex,
      currentPrompt: event.prompt
    };
  }
  if (event.type === "item_scored") {
    const scores = [
      ...state.scores.filter((score) => score.itemIndex !== event.itemIndex),
      {
        itemIndex: event.itemIndex,
        prompt: event.prompt,
        score: event.score,
        rationale: event.rationale,
        finalAnswer: event.finalAnswer,
        hiddenScore: event.hiddenScore,
        adversarialRationale: event.adversarialRationale,
        wrongTask: event.wrongTask,
        failedChecks: event.failedChecks,
        memberScores: event.memberScores,
        correlatedFailure: event.correlatedFailure
      }
    ].sort((left, right) => left.itemIndex - right.itemIndex);
    return {
      evalRunId: event.evalRunId,
      total: event.total,
      completed: scores.length,
      currentIndex: undefined,
      currentPrompt: undefined,
      scores
    };
  }
  if (event.type === "complete" || event.type === "partial") {
    return {
      ...state,
      evalRunId: event.evalRunId,
      total: event.total,
      completed: event.scored,
      currentIndex: undefined,
      currentPrompt: undefined
    };
  }
  return state;
}

export function recordEvalStreamEvent(event: EvalEvent, current: EvalStreamOutcome): EvalStreamOutcome {
  if (event.type === "complete" || event.type === "partial" || event.type === "error") {
    return { terminal: true, event };
  }
  return current;
}

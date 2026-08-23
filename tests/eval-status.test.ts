import { describe, expect, it } from "vitest";
import { applyEvalEvent, emptyLiveEvalState } from "@/components/eval-dashboard/read-eval-stream";
import {
  canResumeEval,
  evalNoticeClass,
  formatCorrelatedFailureNotice,
  formatEvalStatus,
  formatIndependence,
  itemFailureMetrics
} from "@/components/eval-dashboard/eval-status";
import { measureCorrelatedFailure, memberHeldOutScore } from "@/lib/evals/correlation";

describe("eval status labels", () => {
  it("shows scored progress for partial runs", () => {
    expect(formatEvalStatus("partial", 2, 5)).toBe("partial (2/5)");
    expect(formatEvalStatus("complete", 5, 5)).toBe("complete");
  });

  it("treats failed runs with leftover prompts as resumable", () => {
    expect(canResumeEval("partial", 2, 5)).toBe(true);
    expect(canResumeEval("failed", 1, 4)).toBe(true);
    expect(canResumeEval("complete", 4, 4)).toBe(false);
    expect(canResumeEval("failed", 0, 0)).toBe(false);
  });

  it("does not style in-progress notices as success", () => {
    expect(evalNoticeClass("status")).toBe("muted");
    expect(evalNoticeClass("success")).toBe("success-text");
    expect(evalNoticeClass("error")).toBe("error-text");
  });
});

describe("live eval events", () => {
  it("accumulates scores without assuming contiguous indexes", () => {
    const started = applyEvalEvent(emptyLiveEvalState, {
      type: "started",
      evalRunId: "eval-1",
      total: 3,
      completed: 1
    });
    const scored = applyEvalEvent(started, {
      type: "item_scored",
      evalRunId: "eval-1",
      itemIndex: 2,
      total: 3,
      prompt: "Third",
      score: 70,
      rationale: "Fine",
      finalAnswer: "Answer"
    });

    expect(scored.completed).toBe(1);
    expect(scored.scores.map((score) => score.itemIndex)).toEqual([2]);
  });

  it("keeps correlated-failure measurements on scored items", () => {
    const correlatedFailure = measureCorrelatedFailure({
      memberScores: [
        memberHeldOutScore("model-a", 20, "Missed"),
        memberHeldOutScore("model-b", 22, "Missed")
      ],
      memberAnswers: [
        { modelId: "model-a", content: "Same wrong framing for the council." },
        { modelId: "model-b", content: "Same wrong framing for the council." }
      ],
      hiddenScore: 21,
      rubricScore: 80
    });
    const scored = applyEvalEvent(emptyLiveEvalState, {
      type: "item_scored",
      evalRunId: "eval-1",
      itemIndex: 0,
      total: 1,
      prompt: "Q",
      score: 80,
      rationale: "Fluent",
      finalAnswer: "A",
      hiddenScore: 21,
      correlatedFailure
    });

    expect(scored.scores[0]?.hiddenScore).toBe(21);
    expect(scored.scores[0]?.correlatedFailure?.independence).toBe("correlated");
    expect(itemFailureMetrics(correlatedFailure).some((metric) => metric.label === "Correlated failure")).toBe(true);
    expect(formatIndependence("correlated")).toBe("Correlated");
    expect(formatCorrelatedFailureNotice({
      items: 1,
      meanRubricScore: 80,
      meanHiddenScore: 21,
      meanAnswerAgreement: 1,
      meanCoFailureRate: 1,
      meanExpectedCoFailureRate: 1,
      meanExcessCoFailure: 0,
      meanConsensusTrap: 0.79,
      meanCorrelatedFailure: 1,
      meanFramingGap: 59,
      allFailedItems: 1,
      correlatedItems: 1,
      independence: "correlated"
    })).toMatch(/correlated failure 1\.00/i);
  });
});

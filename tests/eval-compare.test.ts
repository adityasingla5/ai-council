import { describe, expect, it } from "vitest";
import {
  canCompareEvalRuns,
  compareEvalRuns,
  evalSetCompareGroups,
  formatEvalCompareSummary,
  formatEvalConfigLabel,
  formatSignedDelta,
  type ComparableEvalRun
} from "@/lib/evals/compare";

const setId = "set-quality";

describe("eval configuration comparison", () => {
  it("groups two or more runs that share an eval set", () => {
    const groups = evalSetCompareGroups([
      run({ id: "run-a", eval_set_id: setId, created_at: "2026-08-23T10:00:00.000Z" }),
      run({ id: "run-b", eval_set_id: setId, created_at: "2026-08-23T11:00:00.000Z" }),
      run({ id: "run-c", eval_set_id: "other", created_at: "2026-08-23T12:00:00.000Z" }),
      run({ id: "run-d", eval_set_id: null, created_at: "2026-08-23T13:00:00.000Z" })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.evalSetId).toBe(setId);
    expect(groups[0]?.runs.map((item) => item.id)).toEqual(["run-b", "run-a"]);
  });

  it("compares rubric, held-out, and correlated-failure deltas on the same prompts", () => {
    const left = run({
      id: "run-left",
      baseline_label: "3-model depth-1",
      aggregate_score: 80,
      eval_scores: [
        score(0, "One", 80, 40, 0.8),
        score(1, "Two", 70, 30, 0.6)
      ]
    });
    const right = run({
      id: "run-right",
      baseline_label: "4-model depth-2",
      aggregate_score: 72,
      council_config: {
        models: ["a", "b", "c", "d"],
        judgeModel: "judge-a",
        reviewerModel: "reviewer-b",
        debateDepth: 2,
        researchEnabled: true
      },
      eval_scores: [
        score(0, "One", 90, 70, 0.2),
        score(1, "Two", 74, 50, 0.3)
      ]
    });

    const comparison = compareEvalRuns(left, right);
    expect(comparison.overlapping).toBe(2);
    expect(comparison.meanScoreDelta).toBeCloseTo(7);
    expect(comparison.meanHiddenDelta).toBeCloseTo(25);
    expect(comparison.meanCorrelatedFailureDelta).toBeCloseTo(-0.45);
    expect(comparison.items[0]).toMatchObject({
      prompt: "One",
      leftScore: 80,
      rightScore: 90,
      scoreDelta: 10,
      hiddenDelta: 30
    });
    expect(comparison.items[0]?.correlatedFailureDelta).toBeCloseTo(-0.6);
    expect(formatEvalCompareSummary(comparison)).toContain("Rubric +7.0");
    expect(formatEvalCompareSummary(comparison)).toContain("held-out +25.0");
    expect(formatEvalCompareSummary(comparison)).toContain("correlated failure -0.45");
  });

  it("refuses to compare runs from different eval sets", () => {
    expect(canCompareEvalRuns(
      run({ id: "run-a", eval_set_id: "set-a" }),
      run({ id: "run-b", eval_set_id: "set-b" })
    )).toBe(false);
    expect(() => compareEvalRuns(
      run({ id: "run-a", eval_set_id: "set-a" }),
      run({ id: "run-b", eval_set_id: "set-b" })
    )).toThrow(/same eval set/);
  });

  it("labels a council config without treating agreement as the headline", () => {
    expect(formatEvalConfigLabel({
      models: ["a", "b", "c"],
      judgeModel: "judge-a",
      reviewerModel: "reviewer-b",
      debateDepth: 2,
      researchEnabled: true
    })).toBe("3 models · depth 2 · held-out reviewer · research");
    expect(formatSignedDelta(-1.25, 2)).toBe("-1.25");
    expect(formatSignedDelta(0.5, 2)).toBe("+0.50");
  });
});

function run(overrides: Partial<ComparableEvalRun> = {}): ComparableEvalRun {
  return {
    id: "run-a",
    eval_set_id: setId,
    status: "complete",
    aggregate_score: 80,
    created_at: "2026-08-23T10:00:00.000Z",
    baseline_label: "baseline",
    council_config: {
      models: ["a", "b", "c"],
      judgeModel: "judge-a",
      reviewerModel: "reviewer-b",
      debateDepth: 1,
      researchEnabled: false
    },
    eval_sets: {
      name: "Quality",
      items: [{ prompt: "One" }, { prompt: "Two" }]
    },
    eval_scores: [],
    ...overrides
  };
}

function score(
  itemIndex: number,
  prompt: string,
  rubric: number,
  hidden: number,
  correlatedFailure: number
) {
  return {
    item_index: itemIndex,
    prompt,
    score: rubric,
    hidden_score: hidden,
    correlated_failure: {
      failThreshold: 60,
      memberCount: 2,
      failedCount: correlatedFailure > 0.5 ? 2 : 0,
      failRate: correlatedFailure,
      coFailureRate: correlatedFailure,
      expectedCoFailureRate: 0.1,
      excessCoFailure: Math.max(0, correlatedFailure - 0.1),
      answerAgreement: 0.8,
      rankingAgreement: 0.7,
      internalAgreement: 0.75,
      hiddenScore: hidden,
      rubricScore: rubric,
      framingGap: rubric - hidden,
      consensusTrap: correlatedFailure,
      correlatedFailure,
      allFailed: correlatedFailure > 0.9,
      wrongTask: false,
      independence: correlatedFailure >= 0.25 ? "correlated" : "independent"
    }
  };
}

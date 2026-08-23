import { describe, expect, it } from "vitest";
import {
  classifyIndependence,
  jaccardSimilarity,
  meanPairwiseJaccard,
  measureCorrelatedFailure,
  memberHeldOutScore,
  pairwiseBothTrueRate,
  rankingScoreAgreement,
  tokenizeForAgreement
} from "@/lib/evals/correlation";
import {
  evalHasDistinctHiddenCriteria,
  evalHiddenCriteria,
  evalModelIds,
  evalReviewerModel
} from "@/lib/evals/input";

const sharedWrongAnswer =
  "Independent models remove blind spots, so a unanimous council answer is the correct task definition.";

describe("agreement is not correlated failure", () => {
  it("treats identical failing first-pass answers as correlated failure", () => {
    const result = measureCorrelatedFailure({
      memberScores: [
        memberHeldOutScore("model-a", 32, "Missed held-out checks"),
        memberHeldOutScore("model-b", 28, "Missed held-out checks"),
        memberHeldOutScore("model-c", 35, "Missed held-out checks")
      ],
      memberAnswers: [
        { modelId: "model-a", content: sharedWrongAnswer },
        { modelId: "model-b", content: sharedWrongAnswer },
        { modelId: "model-c", content: `${sharedWrongAnswer} Yes.` }
      ],
      rankingScores: [94, 92, 91],
      hiddenScore: 30,
      rubricScore: 88,
      wrongTask: true
    });

    expect(result.independence).toBe("correlated");
    expect(result.coFailureRate).toBe(1);
    expect(result.answerAgreement).toBeGreaterThan(0.8);
    expect(result.correlatedFailure).toBeGreaterThan(0.8);
    expect(result.framingGap).toBe(58);
    expect(result.consensusTrap).toBeGreaterThan(0.5);
    expect(result.allFailed).toBe(true);
  });

  it("does not treat agreement among passing answers as correlated failure", () => {
    const result = measureCorrelatedFailure({
      memberScores: [
        memberHeldOutScore("model-a", 88, "Met the checks"),
        memberHeldOutScore("model-b", 91, "Met the checks")
      ],
      memberAnswers: [
        { modelId: "model-a", content: sharedWrongAnswer },
        { modelId: "model-b", content: sharedWrongAnswer }
      ],
      hiddenScore: 90,
      rubricScore: 90
    });

    expect(result.answerAgreement).toBe(1);
    expect(result.coFailureRate).toBe(0);
    expect(result.correlatedFailure).toBe(0);
    expect(result.independence).toBe("independent");
  });

  it("stays independent when members fail different answers on a hard item", () => {
    const result = measureCorrelatedFailure({
      memberScores: [
        memberHeldOutScore("model-a", 18, "Missed evidence"),
        memberHeldOutScore("model-b", 22, "Missed constraint"),
        memberHeldOutScore("model-c", 20, "Missed counterexample")
      ],
      memberAnswers: [
        { modelId: "model-a", content: "Prefer a hash map so lookups stay constant time under load." },
        { modelId: "model-b", content: "The sky appears blue because of Rayleigh scattering in the atmosphere." },
        { modelId: "model-c", content: "Cut the marketing budget and freeze hiring until cash flow recovers." }
      ],
      hiddenScore: 21,
      rubricScore: 24
    });

    expect(result.coFailureRate).toBe(1);
    expect(result.answerAgreement).toBeLessThan(0.15);
    expect(result.correlatedFailure).toBeLessThan(0.15);
    expect(result.independence).toBe("independent");
  });

  it("requires two members before classifying independence", () => {
    const result = measureCorrelatedFailure({
      memberScores: [memberHeldOutScore("model-a", 10, "Empty")],
      memberAnswers: [{ modelId: "model-a", content: "" }],
      hiddenScore: 12,
      rubricScore: 70
    });

    expect(result.memberCount).toBe(1);
    expect(result.independence).toBe("insufficient");
    expect(result.correlatedFailure).toBe(0);
    expect(result.framingGap).toBe(58);
  });
});

describe("pairwise helpers", () => {
  it("computes Jaccard overlap on tokens of length 3+", () => {
    const left = tokenizeForAgreement("Council members share one framing");
    const right = tokenizeForAgreement("Council members share one prompt framing");
    expect(jaccardSimilarity(left, right)).toBeGreaterThan(0.5);
    expect(meanPairwiseJaccard(["alpha beta gamma", "alpha beta gamma"])).toBe(1);
    expect(meanPairwiseJaccard(["only one answer"])).toBe(0);
  });

  it("measures observed co-failure against an independent baseline", () => {
    expect(pairwiseBothTrueRate([true, true, false])).toBeCloseTo(1 / 3);
    expect(pairwiseBothTrueRate([true, true, true])).toBe(1);
    expect(rankingScoreAgreement([90, 92, 91])).toBeGreaterThan(0.9);
    expect(classifyIndependence(2, 0.4)).toBe("correlated");
    expect(classifyIndependence(2, 0.1)).toBe("independent");
  });
});

describe("held-out eval input", () => {
  it("keeps hidden criteria off the council prompt path", () => {
    expect(evalHiddenCriteria({
      rubric: "Be clear.",
      hiddenCriteria: "Must name a shared-framing failure mode."
    })).toBe("Must name a shared-framing failure mode.");
    expect(evalHasDistinctHiddenCriteria({
      rubric: "Be clear.",
      hiddenCriteria: "Must name a shared-framing failure mode."
    })).toBe(true);
    expect(evalHasDistinctHiddenCriteria({ rubric: "Be clear." })).toBe(false);
  });

  it("uses a separate reviewer when provided", () => {
    expect(evalReviewerModel({ judgeModel: "judge-a", reviewerModel: "reviewer-b" })).toBe("reviewer-b");
    expect(evalReviewerModel({ judgeModel: "judge-a" })).toBe("judge-a");
    expect(evalModelIds({
      models: ["model-a"],
      judgeModel: "judge-a",
      reviewerModel: "reviewer-b"
    })).toEqual(["model-a", "judge-a", "reviewer-b"]);
  });
});

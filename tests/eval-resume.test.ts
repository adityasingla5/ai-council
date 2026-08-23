import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-error";
import { buildEvalResumeState, evalInputFromStoredSet, parseEvalSetItems } from "@/lib/evals/resume";
import { parseEvalRequest } from "@/lib/validation";

describe("parseEvalRequest", () => {
  it("treats an evalRunId-only body as a resume", () => {
    expect(parseEvalRequest({ evalRunId: "00000000-0000-4000-8000-000000000001" })).toEqual({
      kind: "resume",
      evalRunId: "00000000-0000-4000-8000-000000000001"
    });
  });

  it("parses a new eval run", () => {
    const parsed = parseEvalRequest({
      name: "Check",
      rubric: "Be useful.",
      items: [{ prompt: "Why?" }],
      models: ["model-a"],
      judgeModel: "judge-a",
      debateDepth: 1,
      researchEnabled: false
    });
    expect(parsed.kind).toBe("create");
    if (parsed.kind === "create") expect(parsed.input.name).toBe("Check");
  });

  it("accepts held-out criteria and a separate reviewer", () => {
    const parsed = parseEvalRequest({
      name: "Independence check",
      rubric: "Be useful.",
      hiddenCriteria: "Must not treat agreement as correctness.",
      items: [{ prompt: "Why?", hiddenCriteria: "Name a shared framing failure." }],
      models: ["model-a", "model-b"],
      judgeModel: "judge-a",
      reviewerModel: "reviewer-b",
      debateDepth: 1,
      researchEnabled: false
    });
    expect(parsed.kind).toBe("create");
    if (parsed.kind === "create") {
      expect(parsed.input.hiddenCriteria).toBe("Must not treat agreement as correctness.");
      expect(parsed.input.reviewerModel).toBe("reviewer-b");
      expect(parsed.input.items[0]?.hiddenCriteria).toBe("Name a shared framing failure.");
    }
  });

  it("reuses a saved eval set instead of creating a new one", () => {
    const parsed = parseEvalRequest({
      evalSetId: "00000000-0000-4000-8000-000000000111",
      baselineLabel: "4-model depth-2",
      models: ["model-a", "model-b"],
      judgeModel: "judge-a",
      reviewerModel: "reviewer-b",
      debateDepth: 2,
      researchEnabled: true,
      name: "ignored",
      items: [{ prompt: "ignored" }]
    });
    expect(parsed).toEqual({
      kind: "reuse",
      input: {
        evalSetId: "00000000-0000-4000-8000-000000000111",
        baselineLabel: "4-model depth-2",
        models: ["model-a", "model-b"],
        judgeModel: "judge-a",
        reviewerModel: "reviewer-b",
        debateDepth: 2,
        researchEnabled: true
      }
    });
  });

  it("still treats evalRunId-only bodies as resume when a set id is also present", () => {
    expect(parseEvalRequest({
      evalRunId: "00000000-0000-4000-8000-000000000001",
      evalSetId: "00000000-0000-4000-8000-000000000111"
    })).toEqual({
      kind: "resume",
      evalRunId: "00000000-0000-4000-8000-000000000001"
    });
  });
});

describe("eval resume state", () => {
  it("rebuilds remaining work from a partial run", () => {
    const resume = buildEvalResumeState({
      id: "eval-1",
      status: "partial",
      baseline_label: "3-model",
      council_config: {
        models: ["model-a"],
        judgeModel: "judge-a",
        reviewerModel: "reviewer-b",
        debateDepth: 2,
        researchEnabled: false
      },
      eval_sets: {
        name: "Quality",
        rubric: "Score carefully.",
        hidden_criteria: "Must measure correlated failure.",
        items: [{ prompt: "One" }, { prompt: "Two" }]
      },
      eval_scores: [{
        item_index: 0,
        score: 81,
        correlated_failure: {
          failThreshold: 60,
          memberCount: 2,
          failedCount: 2,
          failRate: 1,
          coFailureRate: 1,
          expectedCoFailureRate: 1,
          excessCoFailure: 0,
          answerAgreement: 0.9,
          rankingAgreement: 0.8,
          internalAgreement: 0.9,
          hiddenScore: 20,
          rubricScore: 81,
          framingGap: 61,
          consensusTrap: 0.72,
          correlatedFailure: 0.9,
          allFailed: true,
          wrongTask: true,
          independence: "correlated"
        }
      }]
    });

    expect(resume.completedIndexes).toEqual([0]);
    expect(resume.scores).toEqual([81]);
    expect(resume.input.items).toEqual([{ prompt: "One" }, { prompt: "Two" }]);
    expect(resume.input.debateDepth).toBe(2);
    expect(resume.input.hiddenCriteria).toBe("Must measure correlated failure.");
    expect(resume.input.reviewerModel).toBe("reviewer-b");
    expect(resume.itemMetrics[0]?.independence).toBe("correlated");
  });

  it("rejects complete and still-running evals", () => {
    expect(() => buildEvalResumeState(row({ status: "complete" }))).toThrow(ApiError);
    expect(() => buildEvalResumeState(row({ status: "running" }))).toThrow(/still running/);
  });

  it("reads prompt items from stored eval sets", () => {
    expect(parseEvalSetItems([{ prompt: "  Hello  " }, { prompt: "" }, "nope"])).toEqual([{ prompt: "Hello" }]);
    expect(parseEvalSetItems([{ prompt: "Hello", hiddenCriteria: "  Hidden  " }])).toEqual([
      { prompt: "Hello", hiddenCriteria: "Hidden" }
    ]);
  });

  it("rebuilds eval input from a stored set and a new council config", () => {
    const input = evalInputFromStoredSet({
      id: "set-1",
      name: "Quality",
      description: "Private checks",
      rubric: "Score carefully.",
      hidden_criteria: "Must measure correlated failure.",
      items: [{ prompt: "One" }, { prompt: "Two", hiddenCriteria: "Per-item" }]
    }, {
      models: ["model-a", "model-b"],
      judgeModel: "judge-a",
      reviewerModel: "reviewer-b",
      debateDepth: 2,
      researchEnabled: true,
      baselineLabel: "deeper debate"
    });

    expect(input).toMatchObject({
      evalSetId: "set-1",
      name: "Quality",
      hiddenCriteria: "Must measure correlated failure.",
      models: ["model-a", "model-b"],
      debateDepth: 2,
      baselineLabel: "deeper debate",
      items: [{ prompt: "One" }, { prompt: "Two", hiddenCriteria: "Per-item" }]
    });
  });
});

describe("createEvalRunRecords set reuse", () => {
  it("does not insert a new eval set when evalSetId is present", async () => {
    const { createEvalRunRecords } = await import("@/lib/evals/repository");
    const inserted: string[] = [];
    const admin = {
      from(table: string) {
        const query = {
          insert() {
            inserted.push(table);
            return query;
          },
          select() {
            return query;
          },
          eq() {
            return query;
          },
          single: async () => ({ data: { id: "run-1" }, error: null }),
          maybeSingle: async () => ({
            data: {
              id: "set-1",
              name: "Quality",
              description: null,
              rubric: "Score carefully.",
              hidden_criteria: "Must measure correlated failure.",
              items: [{ prompt: "One" }]
            },
            error: null
          })
        };
        return query;
      }
    };

    await expect(createEvalRunRecords({
      admin: admin as never,
      userId: "user-a",
      input: {
        evalSetId: "set-1",
        name: "Quality",
        rubric: "Score carefully.",
        items: [{ prompt: "One" }],
        models: ["model-a"],
        judgeModel: "judge-a",
        debateDepth: 1,
        researchEnabled: false,
        baselineLabel: "rerun"
      }
    })).resolves.toBe("run-1");
    expect(inserted).toEqual(["eval_runs"]);
  });
});

function row(overrides: { status: string }) {
  return {
    id: "eval-1",
    status: overrides.status,
    baseline_label: null,
    council_config: {
      models: ["model-a"],
      judgeModel: "judge-a",
      debateDepth: 1,
      researchEnabled: false
    },
    eval_sets: {
      name: "Quality",
      rubric: "Score carefully.",
      items: [{ prompt: "One" }, { prompt: "Two" }]
    },
    eval_scores: [{ item_index: 0, score: 50 }]
  };
}

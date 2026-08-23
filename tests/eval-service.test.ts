import { describe, expect, it, vi } from "vitest";
import {
  runEval,
  type EvalServiceDependencies
} from "@/lib/evals/service";
import type { EvalRunInput } from "@/lib/evals/types";

const input: EvalRunInput = {
  name: "Decision quality",
  rubric: "Reward accurate, actionable answers.",
  items: [{ prompt: "Question A" }, { prompt: "Question B" }],
  models: ["model-a"],
  judgeModel: "judge-a",
  debateDepth: 1,
  researchEnabled: false
};

const profile = { id: "user-a", email: "user@example.com" };

describe("eval service orchestration", () => {
  it("persists each result and completes the run with the aggregate score", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.scoreAnswer)
      .mockResolvedValueOnce(score(80, "Strong"))
      .mockResolvedValueOnce(score(60, "Adequate"));

    await expect(runEval({ profile, input }, dependencies)).resolves.toMatchObject({
      evalRunId: "eval-run-a",
      aggregateScore: 70,
      status: "complete",
      scored: 2,
      total: 2,
      correlatedFailure: expect.objectContaining({
        items: 2,
        independence: "insufficient"
      })
    });

    expect(dependencies.runCouncil).toHaveBeenCalledTimes(2);
    expect(dependencies.persistUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: profile.id,
      metadata: expect.objectContaining({ evalRunId: "eval-run-a", itemIndex: 0, scoring: "rubric" })
    }));
    expect(dependencies.persistScore).toHaveBeenNthCalledWith(2, expect.objectContaining({
      evalRunId: "eval-run-a",
      itemIndex: 1,
      prompt: "Question B",
      score: 60,
      finalAnswer: "Answer for Question B"
    }));
    expect(dependencies.markComplete).toHaveBeenCalledWith(expect.objectContaining({
      evalRunId: "eval-run-a",
      aggregateScore: 70
    }));
    expect(dependencies.markFailed).not.toHaveBeenCalled();
    expect(dependencies.markPartial).not.toHaveBeenCalled();
  });

  it("keeps scored prompts as a partial run when the remaining work is aborted", async () => {
    const dependencies = createDependencies();
    const controller = new AbortController();
    vi.mocked(dependencies.scoreAnswer)
      .mockResolvedValueOnce(score(80, "Strong"))
      .mockImplementationOnce(async () => {
        controller.abort();
        const error = new Error("stopped");
        error.name = "AbortError";
        throw error;
      });

    await expect(runEval({
      profile,
      input,
      signal: controller.signal,
      abortReason: () => "timeout"
    }, dependencies)).resolves.toMatchObject({
      evalRunId: "eval-run-a",
      aggregateScore: 80,
      status: "partial",
      scored: 1,
      total: 2,
      reason: "timeout"
    });

    expect(dependencies.persistScore).toHaveBeenCalledTimes(1);
    expect(dependencies.markPartial).toHaveBeenCalledWith(expect.objectContaining({
      evalRunId: "eval-run-a",
      aggregateScore: 80
    }));
    expect(dependencies.markFailed).not.toHaveBeenCalled();
    expect(dependencies.markComplete).not.toHaveBeenCalled();
  });

  it("resumes from scored items instead of rerunning them", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.loadResume).mockResolvedValue({
      evalRunId: "eval-run-a",
      input,
      completedIndexes: [0],
      scores: [90],
      itemMetrics: []
    });
    vi.mocked(dependencies.scoreAnswer).mockResolvedValueOnce(score(70, "Resumed"));

    await expect(runEval({
      profile,
      resumeEvalRunId: "eval-run-a"
    }, dependencies)).resolves.toMatchObject({
      evalRunId: "eval-run-a",
      aggregateScore: 80,
      status: "complete",
      scored: 2,
      total: 2
    });

    expect(dependencies.createRunRecords).not.toHaveBeenCalled();
    expect(dependencies.markRunning).toHaveBeenCalledWith(expect.objectContaining({ evalRunId: "eval-run-a" }));
    expect(dependencies.runCouncil).toHaveBeenCalledTimes(1);
    expect(dependencies.runCouncil).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Question B" }),
      expect.anything()
    );
    expect(dependencies.persistScore).toHaveBeenCalledTimes(1);
  });

  it("marks an established run failed before rethrowing an orchestration error", async () => {
    const failure = new Error("scoring failed");
    const dependencies = createDependencies();
    vi.mocked(dependencies.scoreAnswer).mockRejectedValue(failure);

    await expect(runEval({ profile, input }, dependencies)).rejects.toBe(failure);

    expect(dependencies.markFailed).toHaveBeenCalledWith(expect.anything(), "eval-run-a");
    expect(dependencies.markComplete).not.toHaveBeenCalled();
  });

  it("does not attempt a failed-state update before a run id exists", async () => {
    const failure = new Error("could not create run");
    const dependencies = createDependencies();
    vi.mocked(dependencies.createRunRecords).mockRejectedValue(failure);

    await expect(runEval({ profile, input }, dependencies)).rejects.toBe(failure);

    expect(dependencies.markFailed).not.toHaveBeenCalled();
  });

  it("scores independent first-pass answers without sharing peer reasoning", async () => {
    const independenceInput: EvalRunInput = {
      ...input,
      models: ["model-a", "model-b"],
      hiddenCriteria: "Must measure correlated failure rather than agreement.",
      reviewerModel: "reviewer-b"
    };
    const dependencies = createDependencies();
    vi.mocked(dependencies.loadPricing).mockResolvedValue({
      "model-a": { prompt: "0.000001", completion: "0.000002" },
      "model-b": { prompt: "0.000001", completion: "0.000002" },
      "judge-a": { prompt: "0.000001", completion: "0.000002" },
      "reviewer-b": { prompt: "0.000001", completion: "0.000002" }
    });
    vi.mocked(dependencies.runCouncil).mockImplementation(async (councilInput) => ({
      finalAnswer: `Consensus for ${councilInput.prompt}`,
      initialResponses: [
        {
          id: "r1",
          modelId: "model-a",
          stage: "initial_answer",
          content: "Unanimous council answers are proof the task is solved.",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          status: "complete"
        },
        {
          id: "r2",
          modelId: "model-b",
          stage: "initial_answer",
          content: "Unanimous council answers are proof the task is solved.",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 1,
          status: "complete"
        }
      ],
      judge: {
        id: "j1",
        modelId: "judge-a",
        synthesis: "The council agrees.",
        rankings: [
          { modelId: "model-a", rank: 1, score: 96, rationale: "Clear" },
          { modelId: "model-b", rank: 2, score: 94, rationale: "Clear" }
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        latencyMs: 1,
        status: "complete"
      }
    }));
    vi.mocked(dependencies.scoreAnswer).mockResolvedValue(score(88, "Looks complete"));
    vi.mocked(dependencies.scoreHeldOut).mockImplementation(async ({ isolation }) => (
      isolation === "final"
        ? heldOut(24, "Solved the stated prompt, missed correlated failure.", true)
        : heldOut(26, "Did not measure shared failure.", false)
    ));

    const result = await runEval({ profile, input: independenceInput }, dependencies);

    expect(result.correlatedFailure).toMatchObject({
      independence: "correlated",
      meanFramingGap: 64,
      correlatedItems: 2
    });
    const heldOutAnswers = vi.mocked(dependencies.scoreHeldOut).mock.calls.map(([params]) => params.answer);
    expect(heldOutAnswers).toEqual([
      "Consensus for Question A",
      "Unanimous council answers are proof the task is solved.",
      "Unanimous council answers are proof the task is solved.",
      "Consensus for Question B",
      "Unanimous council answers are proof the task is solved.",
      "Unanimous council answers are proof the task is solved."
    ]);
    expect(vi.mocked(dependencies.scoreHeldOut).mock.calls.every(([params]) => (
      params.criteria === "Must measure correlated failure rather than agreement."
      && !params.answer.includes("Debate:")
      && params.judgeModel === "reviewer-b"
    ))).toBe(true);
    expect(dependencies.persistScore).toHaveBeenCalledWith(expect.objectContaining({
      hiddenScore: 24,
      reviewerModel: "reviewer-b",
      correlatedFailure: expect.objectContaining({
        independence: "correlated",
        wrongTask: true
      })
    }));
  });
});

function createDependencies(): EvalServiceDependencies {
  return {
    createAdminClient: () => ({}) as never,
    loadPricing: vi.fn(async () => ({
      "model-a": { prompt: "0.000001", completion: "0.000002" },
      "judge-a": { prompt: "0.000001", completion: "0.000002" }
    })),
    createRunRecords: vi.fn(async () => "eval-run-a"),
    loadResume: vi.fn(async () => {
      throw new Error("resume should not run");
    }),
    runCouncil: vi.fn(async (councilInput) => ({
      finalAnswer: `Answer for ${councilInput.prompt}`
    })),
    scoreAnswer: vi.fn(async () => score(50, "Default score")),
    scoreHeldOut: vi.fn(async () => heldOut(50, "Default held-out")),
    persistUsage: vi.fn(async () => undefined),
    persistScore: vi.fn(async () => undefined),
    markComplete: vi.fn(async () => undefined),
    markPartial: vi.fn(async () => undefined),
    markRunning: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => null)
  };
}

function score(value: number, rationale: string) {
  return {
    score: value,
    rationale,
    completion: {
      content: JSON.stringify({ score: value, rationale }),
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
      latencyMs: 25
    }
  };
}

function heldOut(value: number, rationale: string, wrongTask = false) {
  return {
    score: value,
    rationale,
    failedChecks: wrongTask ? ["held-out task"] : [],
    wrongTask,
    completion: {
      content: JSON.stringify({ score: value, rationale, wrong_task: wrongTask }),
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
      latencyMs: 25
    }
  };
}

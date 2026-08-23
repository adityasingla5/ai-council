import { describe, expect, it } from "vitest";
import {
  buildEvalScoreMessages,
  buildHeldOutScoreMessages,
  parseEvalScoreOutput,
  parseHeldOutScoreOutput
} from "@/lib/evals/scoring";

describe("eval score prompt construction", () => {
  it("preserves the scorer instructions and input sections", () => {
    expect(
      buildEvalScoreMessages({
        prompt: "Explain the tradeoff",
        rubric: "Reward accuracy and clarity",
        answer: "A concise answer"
      })
    ).toEqual([
      {
        role: "system",
        content: "Score the answer from 0 to 100 against the rubric. Return JSON only."
      },
      {
        role: "user",
        content:
          "Prompt:\nExplain the tradeoff\n\nRubric:\nReward accuracy and clarity\n\nAnswer:\nA concise answer\n\nReturn {\"score\": number, \"rationale\": \"short explanation\"}."
      }
    ]);
  });
});

describe("eval score output parsing", () => {
  it("accepts bounded numeric scores and trims the rationale", () => {
    expect(parseEvalScoreOutput('{"score":87.5,"rationale":"  Meets the rubric  "}')).toEqual({
      score: 87.5,
      rationale: "Meets the rubric"
    });
  });

  it("falls back to zero and the raw response for invalid JSON", () => {
    const content = "not valid JSON";
    expect(parseEvalScoreOutput(content)).toEqual({ score: 0, rationale: content });
  });

  it("uses the same fallback for schema-invalid output", () => {
    const content = '{"score":101,"rationale":"Outside the allowed range"}';
    expect(parseEvalScoreOutput(content)).toEqual({ score: 0, rationale: content });
  });
});

describe("held-out adversarial scoring", () => {
  it("withholds peer reasoning and names the hidden criteria", () => {
    const member = buildHeldOutScoreMessages({
      prompt: "How should a council reduce blind spots?",
      criteria: "Must measure correlated failure, not agreement.",
      answer: "More models will fix it.",
      isolation: "member"
    });
    const final = buildHeldOutScoreMessages({
      prompt: "How should a council reduce blind spots?",
      criteria: "Must measure correlated failure, not agreement.",
      answer: "The council agreed, so the task is solved.",
      isolation: "final"
    });

    expect(member[0]?.content).toMatch(/independent first-pass answer/i);
    expect(member[0]?.content).toMatch(/not shown other models/i);
    expect(final[0]?.content).toMatch(/not shown member reasoning/i);
    expect(String(member[1]?.content)).toContain("Held-out acceptance criteria (the council did not see this)");
    expect(String(member[1]?.content)).not.toContain("Debate:");
    expect(String(member[1]?.content)).not.toContain("peer");
  });

  it("parses wrong-task flags from the reviewer", () => {
    expect(parseHeldOutScoreOutput(
      '{"score":22,"rationale":"Solved the prompt, missed the hidden check.","failed_checks":["correlated failure"],"wrong_task":true}'
    )).toEqual({
      score: 22,
      rationale: "Solved the prompt, missed the hidden check.",
      failedChecks: ["correlated failure"],
      wrongTask: true
    });
  });
});

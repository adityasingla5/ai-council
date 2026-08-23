import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/0009_eval_correlated_failure.sql", import.meta.url),
  "utf8"
);

describe("eval correlated failure migration", () => {
  it("stores held-out criteria and per-item correlation measurements", () => {
    expect(migration).toMatch(/hidden_criteria/i);
    expect(migration).toMatch(/member_scores/i);
    expect(migration).toMatch(/correlated_failure/i);
    expect(migration).toMatch(/reviewer_model/i);
    expect(migration).toMatch(/hidden_score/i);
  });
});

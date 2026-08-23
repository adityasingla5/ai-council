"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Beaker, ChevronDown, ChevronRight, Play, RotateCcw, Search, Square } from "lucide-react";
import {
  aggregateFailureMetrics,
  canResumeEval,
  evalItemCount,
  evalNoticeClass,
  formatCorrelatedFailureNotice,
  formatEvalStatus,
  formatIndependence,
  formatRatio,
  itemFailureMetrics,
  type EvalMetric
} from "@/components/eval-dashboard/eval-status";
import { EvalComparePanel } from "@/components/eval-dashboard/eval-compare";
import {
  applyEvalEvent,
  emptyLiveEvalState,
  readEvalEventStream,
  type LiveEvalState
} from "@/components/eval-dashboard/read-eval-stream";
import { isAbortError, readResponseError } from "@/components/council-workspace/request-utils";
import { requestJson } from "@/lib/client-api";
import {
  parseAggregateCorrelatedFailure,
  parseItemCorrelatedFailure,
  parseMemberHeldOutScores,
  type ItemCorrelatedFailure,
  type MemberHeldOutScore
} from "@/lib/evals/correlation";
import { formatEvalConfigLabel } from "@/lib/evals/compare";
import type { EvalEvent } from "@/lib/evals/events";
import { parseEvalSetItems, type StoredEvalSetRecord } from "@/lib/evals/resume";
import { compactText } from "@/lib/format";
import { MAX_COUNCIL_DEBATE_ROUNDS } from "@/lib/limits";
import type { ModelOption } from "@/lib/types";

type EvalScore = {
  item_index?: number;
  score: number | null;
  prompt: string;
  rationale: string | null;
  final_answer?: string | null;
  hidden_score?: number | null;
  adversarial_rationale?: string | null;
  reviewer_model?: string | null;
  member_scores?: unknown;
  correlated_failure?: unknown;
};

type EvalRun = {
  id: string;
  eval_set_id?: string | null;
  status: string;
  aggregate_score: number | null;
  created_at: string;
  baseline_label: string | null;
  correlated_failure?: unknown;
  council_config?: {
    models?: string[];
    judgeModel?: string;
    reviewerModel?: string;
    debateDepth?: number;
    researchEnabled?: boolean;
  } | null;
  eval_sets?: {
    name?: string;
    rubric?: string;
    hidden_criteria?: string | null;
    description?: string | null;
    items?: unknown;
  } | null;
  eval_scores?: EvalScore[];
};

type Notice = { kind: "error" | "status" | "success"; text: string };

export function EvalDashboard() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [evals, setEvals] = useState<EvalRun[]>([]);
  const [sets, setSets] = useState<StoredEvalSetRecord[]>([]);
  const [selectedSetId, setSelectedSetId] = useState("");
  const [name, setName] = useState("Private quality check");
  const [description, setDescription] = useState("");
  const [baselineLabel, setBaselineLabel] = useState("");
  const [rubric, setRubric] = useState("Score for factuality, completeness, reasoning quality, and clarity.");
  const [hiddenCriteria, setHiddenCriteria] = useState("");
  const [items, setItems] = useState("Explain the tradeoffs of using multiple LLMs for one decision.");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [judgeModel, setJudgeModel] = useState("");
  const [reviewerModel, setReviewerModel] = useState("");
  const [debateDepth, setDebateDepth] = useState(1);
  const [researchEnabled, setResearchEnabled] = useState(false);
  const [researchAvailable, setResearchAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [live, setLive] = useState<LiveEvalState>(emptyLiveEvalState);
  const [notice, setNotice] = useState<Notice | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [modelFilter, setModelFilter] = useState("");
  const deferredModelFilter = useDeferredValue(modelFilter);

  const filteredModels = useMemo(() => {
    const query = deferredModelFilter.trim().toLowerCase();
    if (!query) return models.slice(0, 80);
    return models
      .filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(query))
      .slice(0, 80);
  }, [deferredModelFilter, models]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      requestJson<{ models: ModelOption[]; researchAvailable?: boolean }>("/api/models", { signal: controller.signal }),
      requestJson<{ evals: EvalRun[]; sets?: StoredEvalSetRecord[] }>("/api/evals", { signal: controller.signal })
    ])
      .then(([modelsBody, evalsBody]) => {
        setModels(modelsBody.models);
        setResearchAvailable(Boolean(modelsBody.researchAvailable));
        setSelectedModels((current) => (
          current.length ? current : modelsBody.models.slice(0, 3).map((model) => model.id)
        ));
        setJudgeModel((current) => current || modelsBody.models[0]?.id || "");
        setReviewerModel((current) => current || modelsBody.models[1]?.id || modelsBody.models[0]?.id || "");
        setEvals(evalsBody.evals);
        setSets(evalsBody.sets ?? []);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setNotice({ kind: "error", text: loadError instanceof Error ? loadError.message : "Could not load evals." });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [refreshVersion]);

  function toggleModel(modelId: string) {
    setSelectedModels((current) => {
      if (current.includes(modelId)) return current.filter((id) => id !== modelId);
      if (current.length >= 6) return current;
      return [...current, modelId];
    });
  }

  async function runEval(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompts = items
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((prompt) => ({ prompt }));

    if (!prompts.length) {
      setNotice({ kind: "error", text: "Add at least one prompt." });
      return;
    }

    const council = {
      baselineLabel: baselineLabel.trim() || undefined,
      models: selectedModels,
      judgeModel,
      reviewerModel: reviewerModel || undefined,
      debateDepth,
      researchEnabled: researchEnabled && researchAvailable
    };

    if (selectedSetId) {
      await startEval({
        evalSetId: selectedSetId,
        ...council
      });
      return;
    }

    await startEval({
      name,
      description: description.trim() || undefined,
      rubric,
      hiddenCriteria: hiddenCriteria.trim() || undefined,
      items: prompts,
      ...council
    });
  }

  function applySet(set: StoredEvalSetRecord) {
    setSelectedSetId(set.id);
    setName(set.name);
    setDescription(set.description ?? "");
    setRubric(set.rubric);
    setHiddenCriteria(set.hidden_criteria ?? "");
    setItems(parseEvalSetItems(set.items).map((item) => item.prompt).join("\n"));
  }

  function prepareRerun(evalRun: EvalRun) {
    const set = sets.find((item) => item.id === evalRun.eval_set_id);
    if (set) {
      applySet(set);
    } else if (evalRun.eval_set_id && evalRun.eval_sets) {
      applySet({
        id: evalRun.eval_set_id,
        name: evalRun.eval_sets.name ?? "Eval set",
        description: evalRun.eval_sets.description ?? null,
        rubric: evalRun.eval_sets.rubric ?? rubric,
        hidden_criteria: evalRun.eval_sets.hidden_criteria ?? null,
        items: evalRun.eval_sets.items ?? []
      });
    }
    const config = evalRun.council_config;
    if (config?.models?.length) setSelectedModels(config.models);
    if (config?.judgeModel) setJudgeModel(config.judgeModel);
    if (config?.reviewerModel) setReviewerModel(config.reviewerModel);
    if (config?.debateDepth) setDebateDepth(config.debateDepth);
    if (typeof config?.researchEnabled === "boolean") setResearchEnabled(config.researchEnabled);
    setBaselineLabel("");
    document.getElementById("eval-setup")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function stopEval() {
    if (!running || stopping) return;
    setStopping(true);
    runAbortRef.current?.abort();
  }

  async function startEval(body: Record<string, unknown>) {
    if (running) return;

    const controller = new AbortController();
    runAbortRef.current = controller;
    setRunning(true);
    setStopping(false);
    setLive(initialLiveState(body, evals));
    setNotice({ kind: "status", text: "Starting eval…" });

    try {
      const response = await fetch("/api/evals/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        throw new Error(await readResponseError(response, "Eval request failed"));
      }

      const outcome = await readEvalEventStream(response.body, (event) => {
        setLive((current) => applyEvalEvent(current, event));
        setNotice(noticeForEvent(event));
        if (event.type === "started" || event.type === "complete" || event.type === "partial") {
          setExpandedId(event.evalRunId);
        }
      });

      if (!outcome.terminal) {
        throw new Error("Eval stream ended before a final result arrived.");
      }
      setRefreshVersion((version) => version + 1);
    } catch (runError) {
      if (isAbortError(runError)) {
        setNotice({ kind: "status", text: "Eval stopped." });
        setRefreshVersion((version) => version + 1);
      } else {
        setNotice({ kind: "error", text: runError instanceof Error ? runError.message : "Eval failed." });
      }
    } finally {
      if (runAbortRef.current === controller) runAbortRef.current = null;
      setRunning(false);
      setStopping(false);
    }
  }

  return (
    <div className="stack">
      <form className="panel stack" id="eval-setup" onSubmit={runEval}>
        <div className="section-title">
          <h2>Compare council configurations</h2>
          <Beaker size={16} />
        </div>
        <p className="muted small">
          Run the same saved prompt set against different council configurations. Members&apos; independent first-pass answers are scored against held-out criteria the council never sees. The dashboard reports correlated failure separately from answer agreement, then lets you compare two labeled runs of the same set.
        </p>
        <div className="form-row">
          <label className="field">
            <span>Eval set</span>
            <select
              disabled={running}
              value={selectedSetId}
              onChange={(event) => {
                const nextId = event.target.value;
                if (!nextId) {
                  setSelectedSetId("");
                  return;
                }
                const set = sets.find((item) => item.id === nextId);
                if (set) applySet(set);
              }}
            >
              <option value="">New set</option>
              {sets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name} · {parseEvalSetItems(set.items).length} prompts
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Name</span>
            <input
              readOnly={Boolean(selectedSetId)}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Baseline label</span>
            <input
              value={baselineLabel}
              onChange={(event) => setBaselineLabel(event.target.value)}
              placeholder="e.g. 3-model depth-1"
            />
          </label>
        </div>
        {selectedSetId ? (
          <p className="muted small">
            Prompts, rubric, and held-out criteria stay fixed so the new run is comparable. Change the council, reviewer, or baseline label.
          </p>
        ) : null}
        <div className="form-row">
          <label className="field">
            <span>Judge model</span>
            <select value={judgeModel} onChange={(event) => setJudgeModel(event.target.value)}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Adversarial reviewer</span>
            <select value={reviewerModel} onChange={(event) => setReviewerModel(event.target.value)}>
              {models.map((model) => (
                <option key={`reviewer-${model.id}`} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Debate depth</span>
            <select
              value={debateDepth}
              onChange={(event) => setDebateDepth(Number(event.target.value))}
            >
              {Array.from({ length: Math.min(3, MAX_COUNCIL_DEBATE_ROUNDS) }, (_, index) => index + 1).map((depth) => (
                <option key={depth} value={depth}>
                  {depth} {depth === 1 ? "round" : "rounds"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Description</span>
          <input
            readOnly={Boolean(selectedSetId)}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional notes about this configuration"
          />
        </label>
        <label className="field">
          <span>Rubric</span>
          <textarea
            readOnly={Boolean(selectedSetId)}
            value={rubric}
            onChange={(event) => setRubric(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Held-out acceptance criteria</span>
          <textarea
            readOnly={Boolean(selectedSetId)}
            value={hiddenCriteria}
            onChange={(event) => setHiddenCriteria(event.target.value)}
            placeholder="Optional checks the council never sees. Prefer constraints the prompt does not already imply — required evidence, disallowed assumptions, or a different success definition."
          />
        </label>
        <p className="muted small">
          The reviewer scores first-pass member answers one at a time, without other models&apos; reasoning. Prefer a reviewer that is not the council judge.
        </p>
        <label className="field">
          <span>Prompts, one per line</span>
          <textarea
            readOnly={Boolean(selectedSetId)}
            value={items}
            onChange={(event) => setItems(event.target.value)}
          />
        </label>
        <label className="switch-row">
          <input
            checked={researchEnabled}
            disabled={!researchAvailable || running}
            type="checkbox"
            onChange={(event) => setResearchEnabled(event.target.checked)}
          />
          <span>Firecrawl research</span>
        </label>
        {!researchAvailable ? (
          <p className="muted small">Research is unavailable until Firecrawl is configured.</p>
        ) : null}
        <label className="field">
          <span>Search models ({selectedModels.length}/6 selected)</span>
          <span className="input-shell">
            <Search aria-hidden size={16} />
            <input
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              placeholder="openai, claude, llama..."
            />
          </span>
        </label>
        <div className="model-list">
          {filteredModels.length === 0 ? (
            <p className="muted small">No models match “{modelFilter.trim()}”.</p>
          ) : null}
          {filteredModels.map((model) => (
            <label className="model-item" key={model.id}>
              <input
                checked={selectedModels.includes(model.id)}
                disabled={running || (!selectedModels.includes(model.id) && selectedModels.length >= 6)}
                type="checkbox"
                onChange={() => toggleModel(model.id)}
              />
              <span>
                <strong>{model.name}</strong>
                <span>{model.id}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="eval-run-actions">
          <button className="button primary" disabled={running || selectedModels.length === 0} type="submit">
            <Play size={16} />
            {running ? "Running" : selectedSetId ? "Rerun set" : "Run eval"}
          </button>
          {running ? (
            <button
              className="button subtle"
              type="button"
              disabled={stopping}
              onClick={stopEval}
            >
              <Square size={14} />
              {stopping ? "Stopping" : "Stop"}
            </button>
          ) : null}
        </div>
        {running && live.total > 0 ? (
          <p className="muted small" role="status">
            {live.currentPrompt
              ? `Scoring ${(live.currentIndex ?? live.completed) + 1} of ${live.total}: ${compactText(live.currentPrompt, 80)}`
              : `Scored ${live.completed} of ${live.total} prompts.`}
          </p>
        ) : null}
        {live.scores.length ? (
          <ul className="eval-score-list">
            {live.scores.map((score) => (
              <li key={`live-${score.itemIndex}`}>
                <strong>{score.score.toFixed(1)}</strong>
                <span>{score.prompt}</span>
                {score.rationale ? <p className="muted small">{score.rationale}</p> : null}
                <EvalItemAudit
                  hiddenScore={score.hiddenScore}
                  adversarialRationale={score.adversarialRationale}
                  wrongTask={score.wrongTask}
                  failedChecks={score.failedChecks}
                  memberScores={score.memberScores}
                  correlatedFailure={score.correlatedFailure}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {notice ? (
          <p
            className={evalNoticeClass(notice.kind)}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        ) : null}
      </form>

      <EvalComparePanel disabled={running} runs={evals} />

      <section className="panel">
        <h2>Recent evals</h2>
        {loading ? <p className="muted small" role="status">Loading evals.</p> : null}
        {!loading && evals.length === 0 ? <p className="muted small">No evals yet.</p> : null}
        {evals.length ? (
          <div className="table-scroll">
            <table className="table">
              <caption className="sr-only">Recent evaluation runs</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Baseline</th>
                  <th scope="col">Config</th>
                  <th scope="col">Status</th>
                  <th scope="col">Score</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {evals.flatMap((evalRun) => {
                  const expanded = expandedId === evalRun.id;
                  const config = evalRun.council_config;
                  const scored = (evalRun.eval_scores ?? []).length;
                  const total = evalItemCount(evalRun.eval_sets?.items);
                  const resumable = !running && canResumeEval(evalRun.status, scored, total);
                  const runMetrics = parseAggregateCorrelatedFailure(evalRun.correlated_failure);
                  const configLabel = formatEvalConfigLabel(config);
                  const scores = [...(evalRun.eval_scores ?? [])].sort(
                    (left, right) => (left.item_index ?? 0) - (right.item_index ?? 0)
                  );

                  const rows = [
                    <tr key={evalRun.id}>
                      <td>
                        <button
                          className="link-button"
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => setExpandedId(expanded ? null : evalRun.id)}
                        >
                          {expanded ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}
                          {evalRun.eval_sets?.name ?? "Eval"}
                        </button>
                      </td>
                      <td>{evalRun.baseline_label || "—"}</td>
                      <td>{configLabel}</td>
                      <td>{formatEvalStatus(evalRun.status, scored, total)}</td>
                      <td>
                        {evalRun.aggregate_score?.toFixed(1) ?? "-"}
                        {runMetrics ? (
                          <div className="muted small">
                            Correlated failure {formatRatio(runMetrics.meanCorrelatedFailure)} · {formatIndependence(runMetrics.independence)}
                          </div>
                        ) : null}
                      </td>
                      <td>{new Date(evalRun.created_at).toLocaleString()}</td>
                    </tr>
                  ];

                  if (expanded) {
                    rows.push(
                      <tr key={`${evalRun.id}-detail`}>
                        <td colSpan={6}>
                          <div className="stack eval-detail">
                            {evalRun.eval_sets?.rubric ? (
                              <p className="muted small"><strong>Rubric:</strong> {evalRun.eval_sets.rubric}</p>
                            ) : null}
                            {evalRun.eval_sets?.hidden_criteria ? (
                              <p className="muted small"><strong>Held-out criteria:</strong> {evalRun.eval_sets.hidden_criteria}</p>
                            ) : null}
                            {config?.reviewerModel ? (
                              <p className="muted small"><strong>Adversarial reviewer:</strong> {config.reviewerModel}</p>
                            ) : null}
                            {runMetrics ? <MetricGrid metrics={aggregateFailureMetrics(runMetrics)} /> : null}
                            <div className="eval-run-actions">
                              {evalRun.eval_set_id ? (
                                <button
                                  className="button subtle small"
                                  type="button"
                                  disabled={running}
                                  onClick={() => prepareRerun(evalRun)}
                                >
                                  <RotateCcw size={14} />
                                  Rerun this set
                                </button>
                              ) : null}
                              {resumable ? (
                                <button
                                  className="button subtle small"
                                  type="button"
                                  onClick={() => void startEval({ evalRunId: evalRun.id })}
                                >
                                  Resume remaining prompts
                                </button>
                              ) : null}
                            </div>
                            {scores.length ? (
                              <ul className="eval-score-list">
                                {scores.map((score, index) => (
                                  <li key={`${evalRun.id}-score-${score.item_index ?? index}`}>
                                    <strong>{score.score?.toFixed(1) ?? "—"}</strong>
                                    <span>{score.prompt}</span>
                                    {score.rationale ? <p className="muted small">{score.rationale}</p> : null}
                                    <EvalItemAudit
                                      hiddenScore={score.hidden_score}
                                      adversarialRationale={score.adversarial_rationale}
                                      memberScores={parseMemberHeldOutScores(score.member_scores)}
                                      correlatedFailure={parseItemCorrelatedFailure(score.correlated_failure)}
                                    />
                                    {score.final_answer ? (
                                      <details className="eval-answer-details">
                                        <summary>Council answer</summary>
                                        <pre className="eval-answer-body">{score.final_answer}</pre>
                                      </details>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="muted small">No per-prompt scores recorded.</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  return rows;
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function initialLiveState(body: Record<string, unknown>, evals: EvalRun[]): LiveEvalState {
  const evalRunId = typeof body.evalRunId === "string" ? body.evalRunId : "";
  const existing = evalRunId ? evals.find((evalRun) => evalRun.id === evalRunId) : undefined;
  if (!existing) return emptyLiveEvalState;

  const scores = [...(existing.eval_scores ?? [])]
    .map((score, index) => ({
      itemIndex: score.item_index ?? index,
      prompt: score.prompt,
      score: score.score ?? 0,
      rationale: score.rationale ?? "",
      finalAnswer: score.final_answer ?? "",
      hiddenScore: score.hidden_score ?? undefined,
      adversarialRationale: score.adversarial_rationale ?? undefined,
      memberScores: parseMemberHeldOutScores(score.member_scores),
      correlatedFailure: parseItemCorrelatedFailure(score.correlated_failure)
    }))
    .sort((left, right) => left.itemIndex - right.itemIndex);

  return {
    evalRunId: existing.id,
    total: evalItemCount(existing.eval_sets?.items),
    completed: scores.length,
    scores
  };
}

function noticeForEvent(event: EvalEvent): Notice {
  if (event.type === "started") {
    return {
      kind: "status",
      text: event.completed
        ? `Resuming eval (${event.completed} of ${event.total} already scored).`
        : `Running eval (${event.total} prompts).`
    };
  }
  if (event.type === "item_started") {
    return { kind: "status", text: `Scoring prompt ${event.itemIndex + 1} of ${event.total}.` };
  }
  if (event.type === "item_scored") {
    const correlated = event.correlatedFailure
      ? ` Correlated failure ${formatRatio(event.correlatedFailure.correlatedFailure)}.`
      : "";
    return {
      kind: "status",
      text: `Scored prompt ${event.itemIndex + 1} of ${event.total}: rubric ${Math.round(event.score)}.${correlated}`
    };
  }
  if (event.type === "complete") {
    return {
      kind: "success",
      text: `Eval complete. Aggregate score: ${Math.round(event.aggregateScore)}.${formatCorrelatedFailureNotice(event.correlatedFailure)}`
    };
  }
  if (event.type === "partial") {
    const reason = event.reason === "timeout" ? "timed out" : "stopped";
    return {
      kind: "status",
      text: `Eval ${reason} after ${event.scored} of ${event.total} prompts. Aggregate so far: ${Math.round(event.aggregateScore)}.${formatCorrelatedFailureNotice(event.correlatedFailure)}`
    };
  }
  return { kind: "error", text: event.message };
}

function MetricGrid({ metrics }: { metrics: EvalMetric[] }) {
  if (!metrics.length) return null;
  return (
    <dl className="eval-metric-grid">
      {metrics.map((metric) => (
        <div className={metric.warn ? "eval-metric warn" : "eval-metric"} key={metric.label}>
          <dt>{metric.label}</dt>
          <dd>{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EvalItemAudit(params: {
  hiddenScore?: number | null;
  adversarialRationale?: string | null;
  wrongTask?: boolean;
  failedChecks?: string[];
  memberScores?: MemberHeldOutScore[];
  correlatedFailure?: ItemCorrelatedFailure;
}) {
  const metrics = params.correlatedFailure ? itemFailureMetrics(params.correlatedFailure) : [];
  const members = params.memberScores ?? [];
  const hasHidden = params.hiddenScore != null && Number.isFinite(params.hiddenScore);
  if (!hasHidden && !metrics.length && !members.length && !params.adversarialRationale) return null;

  return (
    <div className="eval-audit">
      {params.wrongTask ? (
        <p className="eval-flag">Held-out reviewer flagged a confident answer to the wrong task.</p>
      ) : null}
      {params.failedChecks?.length ? (
        <p className="muted small">Failed checks: {params.failedChecks.join("; ")}</p>
      ) : null}
      {params.adversarialRationale && params.correlatedFailure && params.correlatedFailure.framingGap !== 0 ? (
        <p className="muted small">{params.adversarialRationale}</p>
      ) : null}
      {metrics.length ? <MetricGrid metrics={metrics} /> : null}
      {members.length ? (
        <ul className="eval-member-scores">
          {members.map((member) => (
            <li key={member.modelId}>
              <strong>{member.score.toFixed(1)}</strong>
              <span>{member.modelId}{member.failed ? " · failed held-out" : ""}</span>
              {member.rationale ? <p className="muted small">{member.rationale}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

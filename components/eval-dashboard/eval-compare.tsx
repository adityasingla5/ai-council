"use client";

import { useMemo, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import {
  aggregateFailureMetrics,
  formatIndependence,
  formatRatio,
  type EvalMetric
} from "@/components/eval-dashboard/eval-status";
import {
  compareEvalRuns,
  evalSetCompareGroups,
  formatEvalCompareSummary,
  formatSignedDelta,
  type ComparableEvalRun
} from "@/lib/evals/compare";

export function EvalComparePanel({
  runs,
  disabled = false
}: {
  runs: ComparableEvalRun[];
  disabled?: boolean;
}) {
  const groups = useMemo(() => evalSetCompareGroups(runs), [runs]);
  const [groupId, setGroupId] = useState(groups[0]?.evalSetId ?? "");
  const selectedGroup = groups.find((group) => group.evalSetId === groupId) ?? groups[0];
  const [leftId, setLeftId] = useState(selectedGroup?.runs[1]?.id ?? selectedGroup?.runs[0]?.id ?? "");
  const [rightId, setRightId] = useState(selectedGroup?.runs[0]?.id ?? "");

  const group = selectedGroup;
  const left = group?.runs.find((run) => run.id === leftId) ?? group?.runs[1] ?? group?.runs[0];
  const right = group?.runs.find((run) => run.id === rightId) ?? group?.runs.find((run) => run.id !== left?.id) ?? group?.runs[0];
  const comparison = left && right && left.id !== right.id
    ? compareEvalRuns(left, right)
    : null;

  if (!groups.length) return null;

  return (
    <section className="panel stack">
      <div className="section-title">
        <h2>Compare configurations</h2>
        <ArrowLeftRight size={16} />
      </div>
      <p className="muted small">
        Re-run the same saved prompt set with a different council, then compare rubric scores against held-out scores and correlated failure. A higher rubric with worse held-out or higher correlated failure is agreement, not independence.
      </p>
      <div className="form-row">
        <label className="field">
          <span>Eval set</span>
          <select
            disabled={disabled}
            value={group?.evalSetId ?? ""}
            onChange={(event) => {
              const next = groups.find((item) => item.evalSetId === event.target.value);
              setGroupId(event.target.value);
              setLeftId(next?.runs[1]?.id ?? next?.runs[0]?.id ?? "");
              setRightId(next?.runs[0]?.id ?? "");
            }}
          >
            {groups.map((item) => (
              <option key={item.evalSetId} value={item.evalSetId}>
                {item.name} · {item.runs.length} runs
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Left</span>
          <select
            disabled={disabled || !group}
            value={left?.id ?? ""}
            onChange={(event) => setLeftId(event.target.value)}
          >
            {group?.runs.map((run) => (
              <option key={`left-${run.id}`} value={run.id}>
                {runLabel(run)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Right</span>
          <select
            disabled={disabled || !group}
            value={right?.id ?? ""}
            onChange={(event) => setRightId(event.target.value)}
          >
            {group?.runs.map((run) => (
              <option key={`right-${run.id}`} value={run.id}>
                {runLabel(run)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {comparison ? (
        <div className="stack eval-compare">
          <p className="muted small">
            Right minus left: {formatEvalCompareSummary(comparison)}
            {comparison.overlapping < comparison.items.length
              ? ` · ${comparison.overlapping} of ${comparison.items.length} prompts scored on both runs.`
              : null}
          </p>
          <dl className="eval-metric-grid">
            <CompareMetric
              label="Rubric"
              left={formatScore(comparison.left.aggregateScore)}
              right={formatScore(comparison.right.aggregateScore)}
              delta={comparison.meanScoreDelta}
            />
            <CompareMetric
              label="Held-out"
              left={formatScore(comparison.left.correlatedFailure?.meanHiddenScore ?? null)}
              right={formatScore(comparison.right.correlatedFailure?.meanHiddenScore ?? null)}
              delta={comparison.meanHiddenDelta}
            />
            <CompareMetric
              label="Correlated failure"
              left={formatRatioOrDash(comparison.left.correlatedFailure?.meanCorrelatedFailure)}
              right={formatRatioOrDash(comparison.right.correlatedFailure?.meanCorrelatedFailure)}
              delta={comparison.meanCorrelatedFailureDelta}
              invert
              digits={2}
            />
            <div className="eval-metric">
              <dt>Independence</dt>
              <dd>
                {formatIndependence(comparison.left.correlatedFailure?.independence)}
                {" → "}
                {formatIndependence(comparison.right.correlatedFailure?.independence)}
              </dd>
            </div>
          </dl>
          {comparison.left.correlatedFailure || comparison.right.correlatedFailure ? (
            <div className="eval-compare-metrics">
              <SideMetrics label={comparison.left.label} metrics={comparison.left.correlatedFailure ? aggregateFailureMetrics(comparison.left.correlatedFailure) : []} />
              <SideMetrics label={comparison.right.label} metrics={comparison.right.correlatedFailure ? aggregateFailureMetrics(comparison.right.correlatedFailure) : []} />
            </div>
          ) : null}
          <div className="table-scroll">
            <table className="table">
              <caption className="sr-only">Per-prompt comparison for {comparison.setName}</caption>
              <thead>
                <tr>
                  <th scope="col">Prompt</th>
                  <th scope="col">Left rubric</th>
                  <th scope="col">Right rubric</th>
                  <th scope="col">Δ rubric</th>
                  <th scope="col">Δ held-out</th>
                  <th scope="col">Δ correlated failure</th>
                </tr>
              </thead>
              <tbody>
                {comparison.items.map((item) => (
                  <tr key={`${comparison.evalSetId}-${item.itemIndex}`}>
                    <td>{item.prompt}</td>
                    <td>{formatScore(item.leftScore)}</td>
                    <td>{formatScore(item.rightScore)}</td>
                    <td className={deltaClass(item.scoreDelta)}>{formatSignedDelta(item.scoreDelta)}</td>
                    <td className={deltaClass(item.hiddenDelta)}>{formatSignedDelta(item.hiddenDelta)}</td>
                    <td className={deltaClass(item.correlatedFailureDelta, true)}>{formatSignedDelta(item.correlatedFailureDelta, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="muted small">Choose two different runs of this set to compare.</p>
      )}
    </section>
  );
}

function SideMetrics({ label, metrics }: { label: string; metrics: EvalMetric[] }) {
  if (!metrics.length) return null;
  return (
    <div className="stack">
      <p className="muted small"><strong>{label}</strong></p>
      <dl className="eval-metric-grid">
        {metrics.map((metric) => (
          <div className={metric.warn ? "eval-metric warn" : "eval-metric"} key={`${label}-${metric.label}`}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CompareMetric({
  label,
  left,
  right,
  delta,
  invert = false,
  digits = 1
}: {
  label: string;
  left: string;
  right: string;
  delta: number | null;
  invert?: boolean;
  digits?: number;
}) {
  return (
    <div className={["eval-metric", deltaClass(delta, invert)].filter(Boolean).join(" ")}>
      <dt>{label}</dt>
      <dd>
        {left} → {right}
        <span className="muted small"> {formatSignedDelta(delta, digits)}</span>
      </dd>
    </div>
  );
}

function runLabel(run: ComparableEvalRun): string {
  const created = new Date(run.created_at).toLocaleString();
  const baseline = run.baseline_label?.trim();
  return baseline ? `${baseline} · ${created}` : created;
}

function formatScore(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";
}

function formatRatioOrDash(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? formatRatio(value) : "—";
}

function deltaClass(value: number | null, invert = false): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "";
  const worse = invert ? value > 0 : value < 0;
  return worse ? "eval-delta worse" : "eval-delta better";
}


import type {
  AggregateCorrelatedFailure,
  IndependenceLabel,
  ItemCorrelatedFailure
} from "@/lib/evals/correlation";
import { parseEvalSetItems } from "@/lib/evals/resume";

export type EvalMetric = {
  label: string;
  value: string;
  warn?: boolean;
};

export function evalItemCount(items: unknown): number {
  return parseEvalSetItems(items).length;
}

export function formatEvalStatus(status: string, scored: number, total: number): string {
  if (status === "partial") {
    return total > 0 ? `partial (${scored}/${total})` : "partial";
  }
  if (status === "failed" && scored > 0 && total > scored) {
    return `partial (${scored}/${total})`;
  }
  return status;
}

export function canResumeEval(status: string, scored: number, total: number): boolean {
  if (total <= 0 || scored >= total) return false;
  return status === "partial" || status === "failed";
}

export function evalNoticeClass(kind: "error" | "status" | "success"): string {
  if (kind === "error") return "error-text";
  if (kind === "success") return "success-text";
  return "muted";
}

export function formatRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

export function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

export function formatIndependence(value: IndependenceLabel | undefined): string {
  if (value === "correlated") return "Correlated";
  if (value === "independent") return "Independent";
  return "n/a";
}

export function itemFailureMetrics(metrics: ItemCorrelatedFailure): EvalMetric[] {
  return [
    { label: "Held-out score", value: metrics.hiddenScore.toFixed(1), warn: metrics.hiddenScore < 60 },
    { label: "Answer agreement", value: formatPercent(metrics.answerAgreement) },
    { label: "Co-failure", value: formatPercent(metrics.coFailureRate), warn: metrics.coFailureRate >= 0.5 },
    { label: "Correlated failure", value: formatRatio(metrics.correlatedFailure), warn: metrics.independence === "correlated" },
    { label: "Consensus trap", value: formatRatio(metrics.consensusTrap), warn: metrics.consensusTrap >= 0.4 },
    { label: "Framing gap", value: metrics.framingGap.toFixed(1), warn: metrics.framingGap >= 15 }
  ];
}

export function aggregateFailureMetrics(metrics: AggregateCorrelatedFailure): EvalMetric[] {
  return [
    { label: "Held-out score", value: metrics.meanHiddenScore.toFixed(1), warn: metrics.meanHiddenScore < 60 },
    { label: "Answer agreement", value: formatPercent(metrics.meanAnswerAgreement) },
    { label: "Co-failure", value: formatPercent(metrics.meanCoFailureRate), warn: metrics.meanCoFailureRate >= 0.5 },
    { label: "Correlated failure", value: formatRatio(metrics.meanCorrelatedFailure), warn: metrics.independence === "correlated" },
    { label: "Consensus trap", value: formatRatio(metrics.meanConsensusTrap), warn: metrics.meanConsensusTrap >= 0.4 },
    { label: "Independence", value: formatIndependence(metrics.independence), warn: metrics.independence === "correlated" }
  ];
}

export function formatCorrelatedFailureNotice(metrics: AggregateCorrelatedFailure | undefined): string {
  if (!metrics) return "";
  return ` Agreement ${formatPercent(metrics.meanAnswerAgreement)}; co-failure ${formatPercent(metrics.meanCoFailureRate)}; correlated failure ${formatRatio(metrics.meanCorrelatedFailure)}.`;
}

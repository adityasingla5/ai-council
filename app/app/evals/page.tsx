import { EvalDashboard } from "@/components/eval-dashboard";

export default function EvalsPage() {
  return (
    <main className="page stack">
      <div className="page-title">
        <h1>Evals</h1>
        <p>Measure the council against private prompt sets, held-out criteria, and correlated failure — not just agreement. Rerun a saved set against another configuration and compare the two. Long runs stream progress and can be stopped or resumed.</p>
      </div>
      <EvalDashboard />
    </main>
  );
}

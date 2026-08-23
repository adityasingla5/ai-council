-- Held-out acceptance criteria and correlated-failure measurements for evals.
alter table public.eval_sets
  add column if not exists hidden_criteria text;

alter table public.eval_runs
  add column if not exists correlated_failure jsonb not null default '{}'::jsonb;

alter table public.eval_scores
  add column if not exists hidden_score numeric(5, 2),
  add column if not exists adversarial_rationale text,
  add column if not exists reviewer_model text,
  add column if not exists member_scores jsonb not null default '[]'::jsonb,
  add column if not exists correlated_failure jsonb not null default '{}'::jsonb;

alter table public.eval_scores
  drop constraint if exists eval_scores_hidden_score_range_check;

alter table public.eval_scores
  add constraint eval_scores_hidden_score_range_check
  check (hidden_score is null or hidden_score between 0 and 100);

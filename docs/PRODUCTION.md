# Production runbook

This is the release checklist for AI Council. A release is not complete until the database migration, environment, health check, and authenticated smoke tests all pass. The source is MIT-licensed; each deployment still needs its own secrets, allowlist, and invite list.

## Production controls

- Authentication is invite-only. `INITIAL_ADMIN_EMAIL` works only before the first profile exists, and the first successful admin login persists a normal invite.
- Every model is checked against `ALLOWED_MODEL_IDS`.
- Model calls reserve their worst-case estimated cost against a hard monthly budget before contacting OpenRouter. Calls fail closed when current model pricing is unavailable.
- Rate limits, per-user operation leases, budget reservations, and attachment quotas are stored in Supabase, so they work across serverless instances.
- Browser sessions cannot write directly to application tables or the attachment bucket. Server routes perform authorization, validation, and logging.
- Uploaded files are limited to five text-like files and 4 MB combined per request, stored privately as `text/plain`, and counted against a per-user quota. Members can reuse files from the composer library and see used storage there. The margin below Vercel's [4.5 MB function payload limit](https://vercel.com/docs/functions/limitations#request-body-size) covers multipart overhead.
- Firecrawl research is off by default and cannot be enabled in the interface until its server credential is configured.
- Unsaved attachments expire through daily maintenance. The same job marks abandoned runs failed and prunes expired guardrail rows.
- API routes reject cross-origin mutations, cap JSON request bodies, emit structured logs and request IDs, and return sanitized internal errors.
- Council and eval mutations require UUID idempotency keys and reject a repeated key for 24 hours.
- Long-running routes abort at 280 seconds so they can persist a failed or partial state and respond before the five-minute function ceiling. Evals keep scored prompts and can be resumed.

Current per-user limits are 12 council runs/hour, 2 evals/hour, 10 research requests/hour, 30 upload requests/hour, and one concurrent AI operation. Magic-link requests are limited by normalized email and client address.

## Before deployment

1. Use Node.js 22 and install exactly the lockfile:

   ```bash
   npm ci
   npm run check:release
   ```

2. Back up the Supabase database. Confirm point-in-time recovery or a recent restorable snapshot for the target environment.
3. Apply all files in `supabase/migrations` in filename order. Migration `0005_production_guardrails.sql` is transactional and removes direct browser data/storage access; deploy the matching application in the same release window. Migration `0006_completion_alignments.sql` sets the attachment bucket limit to 4 MB and drops the unused `model_critiques.target_model_id` column. Migration `0007_run_error_message.sql` adds `council_runs.error_message` for failed-run display. Migration `0008_eval_partial_status.sql` adds the `partial` run status for evals that score some prompts before a timeout or cancel. Migration `0009_eval_correlated_failure.sql` stores held-out eval criteria, adversarial reviewer scores, and correlated-failure measurements.
4. Configure every required variable from `.env.example`. Generate `CRON_SECRET` with at least 32 random characters. Never place service-role, OpenRouter, Firecrawl, cron, or webhook credentials in a `NEXT_PUBLIC_` variable.
5. Configure the Supabase authentication site URL and allowed redirect URL as:

   ```text
   https://your-domain.example/auth/callback
   ```

6. Confirm `ALLOWED_MODEL_IDS` contains only approved models. Confirm each model exposes prompt and completion pricing through OpenRouter; missing pricing intentionally blocks generation.
7. Set a conservative `DEFAULT_MONTHLY_BUDGET_USD`. A per-user budget of `0` disables paid AI generation for that user.
8. Configure log retention and an HTTPS `ERROR_WEBHOOK_URL` or equivalent log drain. Alert on repeated 5xx responses, failed maintenance, unhealthy readiness, provider failures, and rapid budget exhaustion.
9. Review what users may submit to OpenRouter, Firecrawl, and Supabase. Put appropriate contracts, retention rules, access controls, and user notices in place before accepting sensitive or regulated data.

For Vercel, `vercel.json` schedules `/api/cron/maintenance` daily at 03:17 UTC and sets five-minute limits on long AI routes. Vercel sends `CRON_SECRET` as a bearer credential. On another host, schedule the same authenticated GET once per day and set `REQUIRE_PRODUCTION_ENV=true`.

## Release verification

After deployment:

1. `GET /api/health` must return HTTP 200 with both checks true and the expected release SHA.
2. Confirm responses include CSP, HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and the referrer/permissions policies.
3. Invoke maintenance with its bearer credential and confirm HTTP 200. Never put the secret in a query string.
4. Sign in as the bootstrap admin. Confirm an invite row exists for that address, then remove `INITIAL_ADMIN_EMAIL` and redeploy.
5. Create and revoke a member invite. Confirm uninvited magic-link requests receive the same generic response as invited requests.
6. Run one saved council, one ephemeral council, and one eval with allowlisted models. Confirm the stream completes, usage rows appear, and the admin usage total increases.
7. Temporarily set the test user's budget below the projected request and confirm generation returns HTTP 402 without contacting the provider. Restore the intended budget.
8. Attempt a blocked model and confirm HTTP 400. Start overlapping AI operations and confirm the second is rejected.
9. Upload an allowed text file, reject a non-text file, and delete the upload. Confirm the object is private and inaccessible with the publishable key.
10. If Firecrawl is configured, run one research request and confirm sources are returned. Otherwise confirm research is presented as unavailable.
11. Find test requests in logs by `X-Request-Id`, and trigger a safe test error in a non-production environment to verify alert delivery.

The automated browser suite uses the setup screen and does not validate live authentication, database mutations, or provider calls. Those authenticated checks remain a release requirement.

## Operations

- Monitor `/api/health` externally at least every five minutes.
- Review spend, 402 and 429 responses, provider latency, and failed or stale runs daily. Members can see their own remaining budget on `/app/usage` and in the council composer. Admins can open a member's usage from the admin members table.
- Check that maintenance logs an event every day. Missing two consecutive runs is actionable.
- Rotate service-role, provider, cron, and webhook credentials on suspected exposure and on the organization's normal schedule.
- Review Dependabot pull requests weekly. Merge only after the release gate and browser tests pass.
- Test restoration periodically in an isolated Supabase project, including authentication metadata, application tables, and the private storage bucket.

Unsaved attachments are retained for `EPHEMERAL_ATTACHMENT_TTL_HOURS` after upload, then deleted by maintenance. Saved chats and attachments persist until the user deletes them. Provider-side retention is controlled by provider agreements and settings, not this repository.

## Incident and rollback

1. Disable traffic or paid provider keys if spend, authorization, or data exposure is ongoing.
2. Preserve logs and note request IDs, release SHA, affected user IDs, and the first and last known event times.
3. Roll the application back to the last known-good immutable deployment.
4. Database migrations are forward-only. Do not manually undo `0005` during an incident: restoring browser write policies would reopen validation and quota bypasses. Prepare and review a corrective migration.
5. Restore from backup only after confirming the recovery point and its effect on authentication and storage objects. Test in an isolated project first whenever time permits.
6. Rotate affected secrets, verify `/api/health`, rerun the authenticated smoke checklist, and document the incident before restoring full traffic.

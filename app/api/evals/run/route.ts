import { jsonError, parseJsonBody } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { requireApiProfile } from "@/lib/auth";
import { isCouncilAbortError } from "@/lib/council/abort";
import type { EvalAbortReason } from "@/lib/evals/events";
import { loadEvalRunForResume, loadEvalSetForUser } from "@/lib/evals/repository";
import { evalInputFromStoredSet } from "@/lib/evals/resume";
import { runEval } from "@/lib/evals/service";
import type { EvalRunInput } from "@/lib/evals/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { getErrorLog } from "@/lib/errors";
import { logEvent, reportError } from "@/lib/observability";
import {
  acquireOperationLease,
  assertAllowedModels,
  assertResearchAvailable,
  claimIdempotencyKey,
  enforceRateLimit,
  type OperationLease
} from "@/lib/production-guardrails";
import { assertTrustedOrigin, requireIdempotencyKey } from "@/lib/request-security";
import { evalModelIds } from "@/lib/evals/input";
import { parseEvalRequest } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 300;

const HEARTBEAT_INTERVAL_MS = 15_000;
const FUNCTION_DEADLINE_MS = 280_000;

export async function POST(request: Request) {
  const requestId =
    request.headers.get("x-vercel-id") ??
    request.headers.get("x-request-id") ??
    crypto.randomUUID();
  const requestStarted = Date.now();
  let lease: OperationLease | undefined;
  let streamStarted = false;

  try {
    assertTrustedOrigin(request);
    const profile = await requireApiProfile();
    const parsed = parseEvalRequest(await parseJsonBody(request));
    const idempotencyKey = requireIdempotencyKey(request);
    const resolved = await resolveEvalRun(parsed, profile.id);
    assertAllowedModels(evalModelIds(resolved.guard));
    assertResearchAvailable(resolved.guard.researchEnabled);
    await enforceRateLimit({
      scope: "eval-run",
      key: profile.id,
      limit: 2,
      windowSeconds: 60 * 60,
      message: "Eval limit reached. Try again later."
    });
    lease = await acquireOperationLease({
      scope: "ai-operation",
      key: profile.id,
      ttlSeconds: 6 * 60,
      conflictMessage: "Another AI operation is already running for this account."
    });
    await claimIdempotencyKey({
      scope: "eval-run",
      userId: profile.id,
      key: idempotencyKey
    });

    logEvent("info", "Eval stream starting", {
      requestId,
      userId: profile.id,
      kind: parsed.kind
    });

    const encoder = new TextEncoder();
    const runAbortController = new AbortController();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminalEventSent = false;
    let abortReason: EvalAbortReason = "cancelled";

    const abortRun = (reason?: unknown) => {
      if (!runAbortController.signal.aborted) runAbortController.abort(reason);
    };
    const abortFromRequest = () => {
      abortReason = "cancelled";
      abortRun(request.signal.reason);
    };
    if (request.signal.aborted) abortFromRequest();
    else request.signal.addEventListener("abort", abortFromRequest, { once: true });
    deadline = setTimeout(() => {
      abortReason = "timeout";
      const timeoutError = new Error("Eval timed out before completion.");
      timeoutError.name = "TimeoutError";
      abortRun(timeoutError);
    }, FUNCTION_DEADLINE_MS);

    const cleanup = () => {
      request.signal.removeEventListener("abort", abortFromRequest);
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (deadline) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const sendBlock = (block: string): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(block));
            return true;
          } catch (error) {
            closed = true;
            abortRun(error);
            logEvent("warn", "Eval stream send failed", {
              requestId,
              ...getErrorLog(error)
            });
            return false;
          }
        };
        const send = (event: unknown, type = "message") =>
          sendBlock(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);

        sendBlock(": connected\n\n");
        heartbeat = setInterval(() => sendBlock(": heartbeat\n\n"), HEARTBEAT_INTERVAL_MS);

        runEval({
          profile,
          input: resolved.input,
          resumeEvalRunId: resolved.resumeEvalRunId,
          signal: runAbortController.signal,
          abortReason: () => abortReason,
          onEvent: async (event) => {
            if (event.type === "complete" || event.type === "partial" || event.type === "error") {
              terminalEventSent = true;
            }
            send(event, event.type);
          }
        })
          .catch((error) => {
            if (isCouncilAbortError(error, runAbortController.signal)) {
              logEvent("info", "Eval run stopped", {
                requestId,
                userId: profile.id,
                reason: abortReason
              });
              if (!terminalEventSent) {
                terminalEventSent = true;
                send({
                  type: "error",
                  message: abortReason === "timeout"
                    ? "Eval timed out before any prompts were scored."
                    : "Eval stopped before any prompts were scored."
                }, "error");
              }
              return;
            }
            void reportError(error, {
              requestId,
              route: "/api/evals/run",
              userId: profile.id
            });
            if (!terminalEventSent) {
              terminalEventSent = true;
              send({
                type: "error",
                message: error instanceof ApiError ? error.message : "Eval failed."
              }, "error");
            }
          })
          .finally(async () => {
            cleanup();
            await lease?.release();
            if (closed) return;
            closed = true;
            try {
              controller.close();
            } catch (error) {
              logEvent("warn", "Eval stream close failed", {
                requestId,
                ...getErrorLog(error)
              });
            }
          });
      },
      cancel(reason) {
        closed = true;
        abortReason = "cancelled";
        abortRun(reason);
        cleanup();
        void lease?.release();
      }
    });

    streamStarted = true;
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Request-Id": requestId
      }
    });
  } catch (error) {
    if (lease && !streamStarted) await lease.release();
    if (!(error instanceof ApiError) || error.status >= 500) {
      await reportError(error, {
        requestId,
        route: "/api/evals/run",
        method: "POST",
        durationMs: Date.now() - requestStarted
      });
    } else {
      logEvent("warn", "Eval stream request rejected", {
        requestId,
        status: error.status,
        durationMs: Date.now() - requestStarted
      });
    }
    const response = jsonError(error, requestId);
    response.headers.set("X-Request-Id", requestId);
    return response;
  }
}

async function resolveEvalRun(
  parsed: ReturnType<typeof parseEvalRequest>,
  userId: string
): Promise<{
  input?: EvalRunInput;
  resumeEvalRunId?: string;
  guard: Pick<EvalRunInput, "models" | "judgeModel" | "reviewerModel" | "researchEnabled">;
}> {
  const admin = createSupabaseAdminClient();
  if (parsed.kind === "resume") {
    const resume = await loadEvalRunForResume({
      admin,
      userId,
      evalRunId: parsed.evalRunId
    });
    return {
      resumeEvalRunId: parsed.evalRunId,
      guard: resume.input
    };
  }
  if (parsed.kind === "reuse") {
    const set = await loadEvalSetForUser({
      admin,
      userId,
      evalSetId: parsed.input.evalSetId
    });
    const input = evalInputFromStoredSet(set, parsed.input);
    return { input, guard: input };
  }
  return { input: parsed.input, guard: parsed.input };
}

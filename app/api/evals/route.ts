import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api";
import { requireApiProfile } from "@/lib/auth";
import { listEvalRunsForUser, listEvalSetsForUser } from "@/lib/evals/repository";

export const GET = apiRoute(async () => {
  const profile = await requireApiProfile();
  const [evals, sets] = await Promise.all([
    listEvalRunsForUser(profile.id),
    listEvalSetsForUser(profile.id)
  ]);
  return NextResponse.json({ evals, sets });
});

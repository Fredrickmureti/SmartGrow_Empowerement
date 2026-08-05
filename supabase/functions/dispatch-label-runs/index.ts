/**
 * dispatch-label-runs — the Label Operations Engine drainer.
 *
 * Bulk label demand used to be a client-side `for` loop: the browser
 * resolved every product, rendered every label, and opened every ledger
 * row. That model cannot survive a 50,000-label price-change run — one
 * tab close and the run is gone, with no record of what printed.
 *
 * This function is the batch counterpart to `dispatch-print-jobs`:
 *   1. Claim active runs (`claim_label_runs`).
 *   2. Call `expand_label_run` repeatedly — set-based SQL expands the
 *      selection into run lines, resolves label vars, refuses lines with
 *      no printable barcode identity (ADR-0089), and enqueues
 *      `print_jobs` rows.
 *   3. Stop when the pass budget is spent; the next cron tick continues.
 *
 * Byte rendering and hardware routing stay in `dispatch-print-jobs`, so
 * a bulk label and a single button-press label execute through exactly
 * the same path.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const DEFAULT_RUN_LIMIT = 5;
const DEFAULT_BATCH_SIZE = 500;
/** Max expansion passes per run per invocation — keeps the function well
 *  inside the edge CPU budget while still moving big runs quickly. */
const MAX_PASSES_PER_RUN = 8;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({})) as {
    run_id?: string;
    run_limit?: number;
    batch_size?: number;
  };

  // Two callers exist: the cron drainer (service key, sweeps all runs) and
  // an operator "run this now" nudge from the workspace, which may only
  // advance a run they can already see through RLS.
  const cronFailure = requireCronAuth(req);
  if (cronFailure) {
    if (!body.run_id) return cronFailure;
    const authHeader = req.headers.get("Authorization") ?? "";
    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: visible, error: visErr } = await asUser
      .from("label_print_runs")
      .select("id")
      .eq("id", body.run_id)
      .maybeSingle();
    if (visErr || !visible) return json({ error: "forbidden" }, 403);
  }
  const batchSize = clamp(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, 2000);
  const runLimit = clamp(body.run_limit ?? DEFAULT_RUN_LIMIT, 1, 25);

  let runIds: string[] = [];
  if (body.run_id) {
    runIds = [body.run_id];
  } else {
    const { data, error } = await admin.rpc("claim_label_runs", { p_limit: runLimit });
    if (error) {
      console.error("[dispatch-label-runs] claim failed", error);
      return json({ error: "claim_failed", detail: error.message }, 500);
    }
    runIds = ((data ?? []) as unknown[]).map((r) =>
      typeof r === "string" ? r : String((r as { claim_label_runs?: string }).claim_label_runs)
    );
  }

  const results: Array<Record<string, unknown>> = [];

  for (const runId of runIds) {
    let expanded = 0;
    let queued = 0;
    let passes = 0;
    let lastError: string | null = null;

    while (passes < MAX_PASSES_PER_RUN) {
      passes += 1;
      const { data, error } = await admin.rpc("expand_label_run", {
        p_run_id: runId,
        p_batch_size: batchSize,
      });
      if (error) {
        lastError = error.message;
        console.error(`[dispatch-label-runs] run ${runId} expand failed`, error);
        await admin
          .from("label_print_runs")
          .update({ status: "failed", last_error: error.message.slice(0, 500) })
          .eq("id", runId);
        break;
      }
      const pass = (data ?? {}) as { expanded?: number; queued?: number; skipped?: boolean };
      if (pass.skipped) break;
      expanded += pass.expanded ?? 0;
      queued += pass.queued ?? 0;
      if ((pass.expanded ?? 0) === 0 && (pass.queued ?? 0) === 0) break;
    }

    results.push({ run_id: runId, expanded, queued, passes, error: lastError });
  }

  return json({ runs: runIds.length, results });
});

function clamp(n: number, lo: number, hi: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

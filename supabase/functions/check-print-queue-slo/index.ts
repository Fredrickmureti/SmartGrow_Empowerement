/**
 * check-print-queue-slo — ADR-0090 · Phase D4.
 *
 * Nightly SLO monitor for the print job ledger. Emits `security_alerts`
 * rows when:
 *
 *   1. Any thermal job has sat in status='sent' longer than SENT_STALL_MIN
 *      (driver never ACKed — printer likely offline / cable pulled).
 *   2. Failure rate over the last 24h exceeds FAILURE_RATE_THRESHOLD.
 *   3. Queue depth (status='queued') is older than QUEUED_STALL_MIN — the
 *      shared queue worker isn't draining.
 *
 * Alerts are per-organization so an ops user sees the same alert stream
 * across POS / label / A4 subsystems.
 *
 * Invoke via pg_cron (see D4 cron schedule migration).
 */
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SENT_STALL_MIN = 10;           // thermal ack SLO
const QUEUED_STALL_MIN = 5;          // worker liveness SLO
const FAILURE_RATE_THRESHOLD = 0.15; // 15% failed over 24h
const MIN_SAMPLE_SIZE = 20;          // don't cry over 3 jobs

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const now = Date.now();
    const sentCutoff = new Date(now - SENT_STALL_MIN * 60_000).toISOString();
    const queuedCutoff = new Date(now - QUEUED_STALL_MIN * 60_000).toISOString();
    const failureWindow = new Date(now - 24 * 3_600_000).toISOString();

    // 1. Stalled 'sent' thermal rows — driver ack missing.
    const { data: stalledSent } = await supabase
      .from("print_jobs")
      .select("business_id, id, doc_type, intent, transport, sent_at")
      .eq("status", "sent")
      .eq("transport", "thermal")
      .lt("sent_at", sentCutoff)
      .limit(500);

    // 2. Stalled 'queued' rows — worker liveness.
    const { data: stalledQueued } = await supabase
      .from("print_jobs")
      .select("business_id, id, doc_type, intent, requested_at")
      .eq("status", "queued")
      .lt("requested_at", queuedCutoff)
      .limit(500);

    // 3. Failure rate over 24h per business.
    const { data: recent } = await supabase
      .from("print_jobs")
      .select("business_id, status")
      .gte("requested_at", failureWindow)
      .limit(5000);

    const perBiz: Record<string, { total: number; failed: number }> = {};
    for (const r of (recent ?? []) as { business_id: string; status: string }[]) {
      const b = (perBiz[r.business_id] ??= { total: 0, failed: 0 });
      b.total += 1;
      if (r.status === "failed" || r.status === "abandoned") b.failed += 1;
    }

    const alertRows: Array<Record<string, unknown>> = [];

    // Group stalled-sent by business.
    const stalledSentByBiz: Record<string, number> = {};
    for (const r of (stalledSent ?? []) as { business_id: string }[]) {
      stalledSentByBiz[r.business_id] = (stalledSentByBiz[r.business_id] ?? 0) + 1;
    }
    for (const [businessId, count] of Object.entries(stalledSentByBiz)) {
      alertRows.push({
        organization_id: businessId,
        severity: "high",
        alert_type: "print_queue_stalled_sent",
        title: `${count} thermal print(s) never confirmed by hardware`,
        details: { count, threshold_minutes: SENT_STALL_MIN, kind: "print_queue_stalled_sent" },
      });
    }

    // Group stalled-queued by business.
    const stalledQueuedByBiz: Record<string, number> = {};
    for (const r of (stalledQueued ?? []) as { business_id: string }[]) {
      stalledQueuedByBiz[r.business_id] = (stalledQueuedByBiz[r.business_id] ?? 0) + 1;
    }
    for (const [businessId, count] of Object.entries(stalledQueuedByBiz)) {
      alertRows.push({
        organization_id: businessId,
        severity: "medium",
        alert_type: "print_queue_worker_idle",
        title: `${count} print job(s) waiting > ${QUEUED_STALL_MIN}m — worker may be down`,
        details: { count, threshold_minutes: QUEUED_STALL_MIN, kind: "print_queue_worker_idle" },
      });
    }

    // Failure rate.
    for (const [businessId, { total, failed }] of Object.entries(perBiz)) {
      if (total < MIN_SAMPLE_SIZE) continue;
      const rate = failed / total;
      if (rate >= FAILURE_RATE_THRESHOLD) {
        alertRows.push({
          organization_id: businessId,
          severity: "high",
          alert_type: "print_queue_high_failure_rate",
          title: `Print failure rate ${(rate * 100).toFixed(1)}% over 24h (${failed}/${total})`,
          details: { total, failed, rate, window_hours: 24, kind: "print_queue_high_failure_rate" },
        });
      }
    }

    // ---------------------------------------------------------------
    // 4. Label-run arm — the engine above the ledger.
    //
    // A run can be healthy at the job level and still be broken as a
    // unit of work: expansion wedged, most lines refused because the
    // catalogue has no printable identity, or demand piling up that no
    // operator ever turned into a run.
    // ---------------------------------------------------------------
    const runStallCutoff = new Date(now - RUN_STALL_MIN * 60_000).toISOString();

    const { data: stuckRuns } = await supabase
      .from("label_print_runs")
      .select("id, business_id, name, status, total_lines, printed_lines, updated_at")
      .in("status", ["expanding", "running"])
      .lt("updated_at", runStallCutoff)
      .limit(500);

    const stuckByBiz: Record<string, number> = {};
    for (const r of (stuckRuns ?? []) as { business_id: string }[]) {
      stuckByBiz[r.business_id] = (stuckByBiz[r.business_id] ?? 0) + 1;
    }
    for (const [businessId, count] of Object.entries(stuckByBiz)) {
      alertRows.push({
        organization_id: businessId,
        severity: "high",
        alert_type: "label_run_stalled",
        title: `${count} label run(s) have not advanced in ${RUN_STALL_MIN}m`,
        details: { count, threshold_minutes: RUN_STALL_MIN, kind: "label_run_stalled" },
      });
    }

    // Refusal ratio on runs finished in the last 24h. A refused line means
    // the item had no printable identity — a catalogue problem, not a
    // printer problem, and it needs a different person to fix it.
    const { data: recentRuns } = await supabase
      .from("label_print_runs")
      .select("business_id, total_lines, refused_lines")
      .gte("created_at", failureWindow)
      .limit(2000);

    const refusedByBiz: Record<string, { lines: number; refused: number }> = {};
    for (const r of (recentRuns ?? []) as {
      business_id: string; total_lines: number | null; refused_lines: number | null;
    }[]) {
      const b = (refusedByBiz[r.business_id] ??= { lines: 0, refused: 0 });
      b.lines += r.total_lines ?? 0;
      b.refused += r.refused_lines ?? 0;
    }
    for (const [businessId, { lines, refused }] of Object.entries(refusedByBiz)) {
      if (lines < MIN_SAMPLE_SIZE) continue;
      const ratio = refused / lines;
      if (ratio >= REFUSED_RATIO_THRESHOLD) {
        alertRows.push({
          organization_id: businessId,
          severity: "medium",
          alert_type: "label_run_high_refusal_rate",
          title:
            `${(ratio * 100).toFixed(1)}% of label lines refused over 24h (${refused}/${lines}) — items lack a printable barcode`,
          details: { lines, refused, ratio, window_hours: 24, kind: "label_run_high_refusal_rate" },
        });
      }
    }

    // Demand aging: raised, never printed, nobody looking at it.
    const demandCutoff = new Date(now - DEMAND_AGE_HOURS * 3_600_000).toISOString();
    const { data: agingDemand } = await supabase
      .from("label_demand")
      .select("business_id")
      .eq("status", "open")
      .lt("created_at", demandCutoff)
      .limit(5000);

    const agingByBiz: Record<string, number> = {};
    for (const r of (agingDemand ?? []) as { business_id: string }[]) {
      agingByBiz[r.business_id] = (agingByBiz[r.business_id] ?? 0) + 1;
    }
    for (const [businessId, count] of Object.entries(agingByBiz)) {
      if (count < DEMAND_MIN_COUNT) continue;
      alertRows.push({
        organization_id: businessId,
        severity: "medium",
        alert_type: "label_demand_aging",
        title: `${count} item(s) have needed a label for over ${DEMAND_AGE_HOURS}h`,
        details: { count, threshold_hours: DEMAND_AGE_HOURS, kind: "label_demand_aging" },
      });
    }

    if (alertRows.length > 0) {
      const { error } = await supabase.from("platform_admin_alerts").insert(alertRows);
      if (error) console.error("[check-print-queue-slo] insert alerts failed:", error.message);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        alerts_created: alertRows.length,
        stalled_sent_businesses: Object.keys(stalledSentByBiz).length,
        stalled_queued_businesses: Object.keys(stalledQueuedByBiz).length,
        stalled_label_run_businesses: Object.keys(stuckByBiz).length,
        aging_demand_businesses: Object.keys(agingByBiz).length,
        checked_at: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[check-print-queue-slo] fatal:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

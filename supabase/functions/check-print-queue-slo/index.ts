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
        business_id: businessId,
        severity: "high",
        alert_type: "print_queue_stalled_sent",
        message: `${count} thermal print(s) never confirmed by hardware in the last ${SENT_STALL_MIN}m — check printer connectivity.`,
        metadata: { count, threshold_minutes: SENT_STALL_MIN },
      });
    }

    // Group stalled-queued by business.
    const stalledQueuedByBiz: Record<string, number> = {};
    for (const r of (stalledQueued ?? []) as { business_id: string }[]) {
      stalledQueuedByBiz[r.business_id] = (stalledQueuedByBiz[r.business_id] ?? 0) + 1;
    }
    for (const [businessId, count] of Object.entries(stalledQueuedByBiz)) {
      alertRows.push({
        business_id: businessId,
        severity: "medium",
        alert_type: "print_queue_worker_idle",
        message: `${count} print job(s) waiting > ${QUEUED_STALL_MIN}m — the hardware queue worker may be down.`,
        metadata: { count, threshold_minutes: QUEUED_STALL_MIN },
      });
    }

    // Failure rate.
    for (const [businessId, { total, failed }] of Object.entries(perBiz)) {
      if (total < MIN_SAMPLE_SIZE) continue;
      const rate = failed / total;
      if (rate >= FAILURE_RATE_THRESHOLD) {
        alertRows.push({
          business_id: businessId,
          severity: "high",
          alert_type: "print_queue_high_failure_rate",
          message: `Print failure rate ${(rate * 100).toFixed(1)}% over 24h (${failed}/${total}) exceeds ${FAILURE_RATE_THRESHOLD * 100}%.`,
          metadata: { total, failed, rate, window_hours: 24 },
        });
      }
    }

    if (alertRows.length > 0) {
      const { error } = await supabase.from("security_alerts").insert(alertRows);
      if (error) console.error("[check-print-queue-slo] insert alerts failed:", error.message);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        alerts_created: alertRows.length,
        stalled_sent_businesses: Object.keys(stalledSentByBiz).length,
        stalled_queued_businesses: Object.keys(stalledQueuedByBiz).length,
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

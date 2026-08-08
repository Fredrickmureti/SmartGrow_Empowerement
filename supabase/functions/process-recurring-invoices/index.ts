// Recurring invoice scheduler — THIN DRIVER.
//
// This worker owns exactly one concern: deciding which billing occurrences are
// due, and asking the database to produce each one. It does not build invoices,
// resolve GL accounts, post journal entries or advance schedules — all of that
// lives in `generate_recurring_invoice_occurrence`, the single engine shared
// with the UI's "Generate now" action.
//
// Delivery (auto-send) is a separate, retryable sweep that runs after the
// financial event has committed. A failed email never alters an invoice.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/** Safety cap on catch-up periods generated for one template in one sweep. */
const MAX_CATCH_UP = 12;
/** Delivery attempts per run row before it stops being retried automatically. */
const MAX_DELIVERY_ATTEMPTS = 5;

interface OccurrenceResult {
  status: "generated" | "posted" | "failed" | "skipped";
  duplicate: boolean;
  run_id: string;
  invoice_id?: string | null;
  invoice_number?: string | null;
  period_start: string;
  period_end: string;
  next_run_date?: string;
  error?: string;
}

/** Mirrors public.recurring_period_end so the driver can walk the calendar. */
function periodEnd(frequency: string, periodStart: string): string {
  const d = new Date(`${periodStart}T00:00:00Z`);
  const day = d.getUTCDate();
  switch (frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "biweekly":
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case "quarterly":
      d.setUTCMonth(d.getUTCMonth() + 3);
      if (d.getUTCDate() < day) d.setUTCDate(0);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      if (d.getUTCDate() < day) d.setUTCDate(0);
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() + 1);
      if (d.getUTCDate() < day) d.setUTCDate(0);
      break;
  }
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextStart(frequency: string, periodStart: string): string {
  const d = new Date(`${periodEnd(frequency, periodStart)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function deliverPendingInvoices(supabase: any, today: string) {
  const { data: pending } = await supabase
    .from("recurring_invoice_runs")
    .select("id, organization_id, invoice_id, invoice_number, attempt_count")
    .eq("delivery_status", "pending")
    .not("invoice_id", "is", null)
    .limit(200);

  let delivered = 0;
  let failed = 0;

  for (const run of (pending || []) as Array<Record<string, any>>) {
    const { data: invoice } = await supabase
      .from("invoices")
      .select("id, contact_id, contact:contacts(name, email)")
      .eq("id", run.invoice_id)
      .maybeSingle();

    const email = invoice?.contact?.email as string | undefined;
    if (!email) {
      await supabase
        .from("recurring_invoice_runs")
        .update({
          delivery_status: "failed",
          delivery_error: "Customer has no email address on file",
        })
        .eq("id", run.id);
      failed++;
      continue;
    }

    try {
      const { error } = await supabase.functions.invoke("send-invoice", {
        body: {
          invoiceId: run.invoice_id,
          recipientEmail: email,
          recipientName: invoice?.contact?.name ?? null,
        },
      });
      if (error) throw new Error(error.message ?? String(error));

      await supabase
        .from("recurring_invoice_runs")
        .update({
          delivery_status: "sent",
          delivery_error: null,
          delivered_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      delivered++;
    } catch (e) {
      const attempts = Number(run.attempt_count ?? 1);
      await supabase
        .from("recurring_invoice_runs")
        .update({
          // Exhausted attempts stop the retry loop but keep the evidence.
          delivery_status: attempts >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending",
          delivery_error: String(e),
        })
        .eq("id", run.id);
      failed++;
    }
  }

  console.log(`[recurring] delivery sweep ${today}: sent=${delivered} failed=${failed}`);
  return { delivered, failed };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  try {
    const supabase: any = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");

    const today = new Date().toISOString().slice(0, 10);
    console.log(`[recurring] sweep starting for ${today}`);

    const { data: templates, error: fetchError } = await supabase
      .from("recurring_invoices")
      .select("id, organization_id, template_name, frequency, next_run_date, end_date")
      .eq("is_active", true)
      .lte("next_run_date", today);

    if (fetchError) throw fetchError;

    const results: Array<Record<string, unknown>> = [];
    const subscriptionCache: Record<string, boolean> = {};

    for (const t of (templates || []) as Array<Record<string, any>>) {
      try {
        // ── Entitlement gate ──────────────────────────────────────────────
        if (subscriptionCache[t.organization_id] === undefined) {
          const check = await checkSubscriptionActive(supabase, t.organization_id);
          subscriptionCache[t.organization_id] = check.allowed;
          if (!check.allowed) {
            await supabase.from("platform_admin_alerts").insert({
              alert_type: "background_job_skipped",
              severity: "warning",
              title: `Recurring billing skipped for org ${t.organization_id}`,
              details: {
                function: "process-recurring-invoices",
                reason: check.reason,
              },
              organization_id: t.organization_id,
            });
          }
        }
        if (!subscriptionCache[t.organization_id]) {
          results.push({ id: t.id, status: "skipped", reason: "subscription inactive" });
          continue;
        }

        // ── Walk every due occurrence, one RPC call each ──────────────────
        let period: string = t.next_run_date;
        let generated = 0;
        let stopped: string | null = null;

        while (period <= today && generated < MAX_CATCH_UP) {
          if (t.end_date && period > t.end_date) {
            // The schedule has run its course: complete it, don't just disable it.
            await supabase
              .from("recurring_invoices")
              .update({ is_active: false, completed_at: new Date().toISOString() })
              .eq("id", t.id);
            stopped = "completed";
            break;
          }

          const { data, error } = await supabase.rpc("generate_recurring_invoice_occurrence", {
            _recurring_id: t.id,
            _period_start: period,
            _user_id: null,
            _trigger_source: "schedule",
          });
          if (error) throw error;

          const outcome = data as OccurrenceResult;

          if (outcome.status === "failed") {
            // The occurrence rolled back and the schedule did not advance.
            // Stop this template so the same period is retried next sweep;
            // every other tenant continues unaffected.
            console.error(`[recurring] ${t.id} period ${period} failed: ${outcome.error}`);
            results.push({ id: t.id, status: "failed", period, error: outcome.error });
            stopped = "failed";
            break;
          }

          generated++;
          period = outcome.next_run_date ?? nextStart(t.frequency, period);
        }

        if (!stopped) {
          results.push({ id: t.id, status: "success", generated });
        }
      } catch (error) {
        console.error(`[recurring] error processing ${t.id}:`, error);
        results.push({ id: t.id, status: "error", error: String(error) });
      }
    }

    const delivery = await deliverPendingInvoices(supabase, today);

    console.log(`[recurring] sweep complete: ${results.length} templates`);
    return new Response(
      JSON.stringify({ success: true, processed: results.length, results, delivery }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error) {
    console.error("[recurring] fatal:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

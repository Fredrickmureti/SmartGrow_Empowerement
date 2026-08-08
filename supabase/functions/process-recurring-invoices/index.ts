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
/**
 * Email retry schedule, in minutes, indexed by the delivery attempt already
 * made. Delivery has its OWN counter: `attempt_count` counts invoice
 * generation attempts and must never be spent on email failures.
 */
const DELIVERY_BACKOFF_MINUTES = [5, 15, 60, 240, 720];
const MAX_DELIVERY_ATTEMPTS = DELIVERY_BACKOFF_MINUTES.length;

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

// The recurrence calendar lives in the database (`recurring_next_start`),
// anchored on the template's start day. The driver never recomputes it: it
// walks to whatever `next_run_date` the engine returns.

/**
 * Billing day is a local-calendar concept. A tenant in UTC+3 bills on their
 * own date boundary, not the worker's.
 */
function localToday(timezone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function deliverPendingInvoices(supabase: any, today: string) {
  const nowIso = new Date().toISOString();
  const { data: pending } = await supabase
    .from("recurring_invoice_runs")
    .select("id, organization_id, invoice_id, invoice_number, delivery_attempt_count")
    .eq("delivery_status", "pending")
    .not("invoice_id", "is", null)
    .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`)
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
          next_retry_at: null,
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
          next_retry_at: null,
        })
        .eq("id", run.id);
      delivered++;
    } catch (e) {
      const attempts = Number(run.delivery_attempt_count ?? 0) + 1;
      const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
      const backoff = DELIVERY_BACKOFF_MINUTES[Math.min(attempts, MAX_DELIVERY_ATTEMPTS - 1)];
      await supabase
        .from("recurring_invoice_runs")
        .update({
          // Exhausted attempts stop the retry loop but keep the evidence.
          delivery_status: exhausted ? "failed" : "pending",
          delivery_attempt_count: attempts,
          next_retry_at: exhausted
            ? null
            : new Date(Date.now() + backoff * 60_000).toISOString(),
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

    const utcToday = new Date().toISOString().slice(0, 10);
    console.log(`[recurring] sweep starting for ${utcToday} (UTC)`);

    // Pull one day wide, then filter per template against its own local date.
    const horizon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: templates, error: fetchError } = await supabase
      .from("recurring_invoices")
      .select(
        "id, organization_id, business_id, template_name, frequency, next_run_date, end_date, business:businesses(timezone)",
      )
      .eq("status", "active")
      .lte("next_run_date", horizon);

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
        const today = localToday(t.business?.timezone);
        if (t.next_run_date > today) {
          results.push({ id: t.id, status: "not_due", next_run_date: t.next_run_date });
          continue;
        }

        let period: string = t.next_run_date;
        let generated = 0;
        let stopped: string | null = null;

        while (period <= today && generated < MAX_CATCH_UP) {
          if (t.end_date && period > t.end_date) {
            // The schedule has run its course: complete it through the
            // lifecycle writer so the change is attributable, don't just
            // flip a flag.
            await supabase.rpc("set_recurring_status_atomic", {
              p_recurring_id: t.id,
              p_status: "completed",
              p_user_id: null,
              p_reason: "Schedule reached its end date",
            });
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
          if (!outcome.next_run_date) break;
          period = outcome.next_run_date;
        }

        if (!stopped && generated >= MAX_CATCH_UP && period <= today) {
          // Truncated catch-up is a business event, not a silent cap: the
          // remaining periods stay unbilled until someone is told.
          await supabase.from("platform_admin_alerts").insert({
            alert_type: "recurring_catch_up_truncated",
            severity: "warning",
            title: `Recurring billing catch-up truncated for ${t.template_name ?? t.id}`,
            details: {
              function: "process-recurring-invoices",
              recurring_invoice_id: t.id,
              generated,
              next_unbilled_period: period,
            },
            organization_id: t.organization_id,
          });
          results.push({ id: t.id, status: "truncated", generated, next_period: period });
        } else if (!stopped) {
          results.push({ id: t.id, status: "success", generated });
        }
      } catch (error) {
        console.error(`[recurring] error processing ${t.id}:`, error);
        results.push({ id: t.id, status: "error", error: String(error) });
      }
    }

    const delivery = await deliverPendingInvoices(supabase, utcToday);

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

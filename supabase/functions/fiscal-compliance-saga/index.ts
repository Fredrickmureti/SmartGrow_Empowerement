/**
 * fiscal-compliance-saga
 *
 * Drains `business_event_outbox` rows of type `fiscal.receipt_*` and
 * dispatches them to the pack-registered provider adapter with
 * idempotency, exponential backoff, and a per-(org, provider) circuit breaker.
 *
 * Runs on pg_cron every 60 seconds. Also invocable manually for tests.
 */
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/etims/adapter.ts";

const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600, 86400]; // 30s, 2m, 10m, 1h, 6h, 24h
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
const BATCH_SIZE = 25;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLOFF_SECONDS = 300; // 5 minutes

interface OutboxEvent {
  id: string;
  org_id: string;
  branch_id: string | null;
  event_type: string;
  source_doc_type: string;
  source_doc_id: string;
  payload: any;
  attempts: number;
  status: string;
}

async function circuitState(supabase: any, orgId: string, providerKey: string) {
  const { data } = await supabase
    .from("fiscal_provider_circuit")
    .select("*")
    .eq("organization_id", orgId)
    .eq("provider_key", providerKey)
    .maybeSingle();
  return data;
}

async function recordCircuitFailure(supabase: any, orgId: string, providerKey: string, err: string) {
  const existing = await circuitState(supabase, orgId, providerKey);
  const failures = (existing?.consecutive_failures ?? 0) + 1;
  const shouldOpen = failures >= CIRCUIT_FAILURE_THRESHOLD;
  await supabase.from("fiscal_provider_circuit").upsert({
    organization_id: orgId,
    provider_key: providerKey,
    state: shouldOpen ? "open" : (existing?.state ?? "closed"),
    consecutive_failures: failures,
    opened_at: shouldOpen ? new Date().toISOString() : existing?.opened_at ?? null,
    next_probe_at: shouldOpen
      ? new Date(Date.now() + CIRCUIT_COOLOFF_SECONDS * 1000).toISOString()
      : existing?.next_probe_at ?? null,
    last_error: err.slice(0, 500),
    updated_at: new Date().toISOString(),
  }, { onConflict: "organization_id,provider_key" });
}

async function recordCircuitSuccess(supabase: any, orgId: string, providerKey: string) {
  await supabase.from("fiscal_provider_circuit").upsert({
    organization_id: orgId,
    provider_key: providerKey,
    state: "closed",
    consecutive_failures: 0,
    opened_at: null,
    next_probe_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "organization_id,provider_key" });
}

/**
 * Dispatch one outbox event: invoke the pack-registered edge function,
 * update ledger and outbox status, and emit follow-on events.
 */
async function dispatchEvent(supabase: any, ev: OutboxEvent) {
  const providerKey = ev.payload?.provider_key;
  const documentKind = ev.payload?.document_kind ?? "sale";

  if (!providerKey) {
    await supabase.from("business_event_outbox").update({
      status: "dead_letter",
      last_error: "missing provider_key in payload",
    }).eq("id", ev.id);
    return;
  }

  // Look up the provider row for the endpoint edge function name.
  const { data: provider } = await supabase
    .from("localization_pack_fiscal_providers")
    .select("provider_key, endpoint_edge_function, pack_id")
    .eq("provider_key", providerKey)
    .maybeSingle();
  if (!provider) {
    await supabase.from("business_event_outbox").update({
      status: "dead_letter",
      last_error: `no pack row for provider_key=${providerKey}`,
    }).eq("id", ev.id);
    return;
  }

  // Circuit-breaker gate.
  const circuit = await circuitState(supabase, ev.org_id, providerKey);
  if (circuit?.state === "open" && circuit.next_probe_at && new Date(circuit.next_probe_at) > new Date()) {
    // Leave the event pending — POS keeps operating; queue drains when breaker half-opens.
    return;
  }

  // Determine invocation body per document kind.
  const invocationBody: Record<string, any> = { organizationId: ev.org_id };
  switch (ev.source_doc_type) {
    case "invoices":
      invocationBody.invoiceId = ev.source_doc_id;
      invocationBody.doc_type = "invoice";
      break;
    case "credit_notes":
      invocationBody.creditNoteId = ev.source_doc_id;
      invocationBody.doc_type = "credit_note";
      break;
    case "pos_transactions":
      invocationBody.transactionId = ev.source_doc_id;
      invocationBody.doc_type = "pos";
      break;
    case "sales_returns":
      invocationBody.transactionId = ev.source_doc_id;
      invocationBody.doc_type = "credit_note";
      break;
    default:
      await supabase.from("business_event_outbox").update({
        status: "dead_letter",
        last_error: `unsupported source_doc_type=${ev.source_doc_type}`,
      }).eq("id", ev.id);
      return;
  }

  const attempts = (ev.attempts ?? 0) + 1;
  try {
    const { data, error } = await supabase.functions.invoke(provider.endpoint_edge_function, {
      body: invocationBody,
    });

    if (error || data?.success === false) {
      const errMsg = error?.message ?? data?.error ?? "adapter returned failure";
      // 5xx / network → retriable; other → rejected
      const isTransient = !!error;
      if (isTransient) {
        await recordCircuitFailure(supabase, ev.org_id, providerKey, errMsg);
        if (attempts >= MAX_ATTEMPTS) {
          await supabase.from("business_event_outbox").update({
            status: "dead_letter", attempts, last_error: errMsg,
          }).eq("id", ev.id);
        } else {
          await supabase.from("business_event_outbox").update({
            status: "pending", attempts, last_error: errMsg,
            // Delay next processing via updated_at + saga's WHERE clause skipping recent retries.
          }).eq("id", ev.id);
          // Store backoff hint in payload for the next tick.
          const nextAt = new Date(Date.now() + BACKOFF_SECONDS[Math.min(attempts, MAX_ATTEMPTS) - 1] * 1000);
          await supabase.from("business_event_outbox").update({
            payload: { ...ev.payload, __retry_after: nextAt.toISOString() },
          }).eq("id", ev.id);
        }
      } else {
        // KRA business-rule rejection — needs accountant action, do not retry blindly.
        await supabase.from("business_event_outbox").update({
          status: "failed", attempts, last_error: errMsg, completed_at: new Date().toISOString(),
        }).eq("id", ev.id);
        // Emit follow-on rejection event.
        await supabase.from("business_event_outbox").insert({
          org_id: ev.org_id, branch_id: ev.branch_id,
          event_type: "fiscal.receipt_rejected",
          source_doc_type: ev.source_doc_type, source_doc_id: ev.source_doc_id,
          payload: { ...ev.payload, provider_key: providerKey, document_kind: documentKind, error: errMsg },
          idempotency_key: `fiscal.receipt_rejected:${ev.source_doc_type}:${ev.source_doc_id}:${ev.id}`,
        });
      }
      return;
    }

    // Success path.
    await recordCircuitSuccess(supabase, ev.org_id, providerKey);
    await supabase.from("business_event_outbox").update({
      status: "completed", attempts, completed_at: new Date().toISOString(), last_error: null,
    }).eq("id", ev.id);
    await supabase.from("business_event_outbox").insert({
      org_id: ev.org_id, branch_id: ev.branch_id,
      event_type: "fiscal.receipt_issued",
      source_doc_type: ev.source_doc_type, source_doc_id: ev.source_doc_id,
      payload: {
        ...ev.payload,
        provider_key: providerKey, document_kind: documentKind,
        fiscal_number: data?.cuNumber, qr_data: data?.qrCodeUrl,
      },
      idempotency_key: `fiscal.receipt_issued:${ev.source_doc_type}:${ev.source_doc_id}:${ev.id}`,
    });
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    await recordCircuitFailure(supabase, ev.org_id, providerKey, errMsg);
    if (attempts >= MAX_ATTEMPTS) {
      await supabase.from("business_event_outbox").update({
        status: "dead_letter", attempts, last_error: errMsg,
      }).eq("id", ev.id);
    } else {
      await supabase.from("business_event_outbox").update({
        status: "pending", attempts, last_error: errMsg,
      }).eq("id", ev.id);
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Claim a batch of pending fiscal events whose backoff has elapsed.
  const nowIso = new Date().toISOString();
  const { data: events } = await supabase
    .from("business_event_outbox")
    .select("id, org_id, branch_id, event_type, source_doc_type, source_doc_id, payload, attempts, status")
    .in("event_type", ["fiscal.receipt_required", "fiscal.receipt_cancelled"])
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  const claimed = (events ?? []).filter((e: any) => {
    const retryAfter = e.payload?.__retry_after;
    return !retryAfter || retryAfter <= nowIso;
  }) as OutboxEvent[];

  let processed = 0;
  for (const ev of claimed) {
    await dispatchEvent(supabase, ev);
    processed++;
  }

  return new Response(JSON.stringify({ ok: true, processed, batch: claimed.length }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});

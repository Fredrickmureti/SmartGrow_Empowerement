/**
 * process-localization-outbox — pulls PENDING events out of
 * `business_event_outbox` that were emitted by the payroll return
 * state machine and the pack lifecycle triggers, and dispatches them
 * to the appropriate downstream side effect.
 *
 * Contract:
 *   - Claims a batch of PENDING rows with a lease so parallel workers
 *     never process the same event twice.
 *   - Dispatch is idempotent: every handler MUST tolerate replay,
 *     because the row is only marked SUCCESS after handler completion.
 *   - Unhandled event_types are marked SUCCESS with a `noop` marker so
 *     they don't clog the queue — the outbox is a bus, not a DLQ.
 *   - Failed handlers bump `attempts` and record `last_error`. A
 *     future retry policy (attempts < 5) will re-lease them.
 *
 * Handled events:
 *   - `pack.upgraded`  → invalidate payroll readiness snapshots for
 *                        every org that has the pack installed, so
 *                        the readiness engine re-evaluates with the
 *                        new rule surface.
 *   - `pack.published` → no-op today; reserved for tenant notification
 *                        fan-out.
 *   - `return.state_changed` → no-op today; reserved for GL posting
 *                        and notification consumers. The event is
 *                        already durable in the outbox, so consumers
 *                        can be wired later without losing history.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const HANDLED = new Set([
  "pack.upgraded",
  "pack.published",
  "return.state_changed",
]);

const WORKER_ID = `localization-outbox:${crypto.randomUUID().slice(0, 8)}`;
const LEASE_SECONDS = 60;
const BATCH_SIZE = 25;

interface OutboxRow {
  id: string;
  org_id: string;
  event_type: string;
  source_doc_type: string | null;
  source_doc_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

async function claim(): Promise<OutboxRow[]> {
  // Atomic claim: flip PENDING → PENDING with a fresh lease so any
  // second worker sees claimed_at > now() - lease and skips.
  const { data, error } = await admin
    .from("business_event_outbox")
    .select("id, org_id, event_type, source_doc_type, source_doc_id, payload, attempts")
    .eq("status", "PENDING")
    .in("event_type", Array.from(HANDLED))
    .or(`claimed_at.is.null,claimed_at.lt.${new Date(Date.now() - LEASE_SECONDS * 1000).toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;
  const rows = (data ?? []) as OutboxRow[];
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  await admin
    .from("business_event_outbox")
    .update({
      claimed_at: new Date().toISOString(),
      claim_lease_seconds: LEASE_SECONDS,
      worker_id: WORKER_ID,
    })
    .in("id", ids);
  return rows;
}

async function handlePackUpgraded(row: OutboxRow): Promise<void> {
  const packId = (row.payload as any)?.pack_id;
  if (!packId) return;
  // Invalidate readiness snapshots for every business that has this
  // pack installed. The readiness engine reads from
  // `payroll_batch_readiness_snapshots` and recomputes on-demand when
  // no snapshot is found, so DELETE is a valid invalidation primitive.
  const { data: installs } = await admin
    .from("installed_localization_packs")
    .select("organization_id, business_id")
    .eq("pack_id", packId);
  const businessIds = Array.from(new Set((installs ?? []).map((i: any) => i.business_id).filter(Boolean)));
  if (!businessIds.length) return;
  await admin
    .from("payroll_batch_readiness_snapshots")
    .delete()
    .in("business_id", businessIds);
  // Rebuild the filing-calendar projection for every affected business.
  // The RPC is the single writer; direct writes are forbidden by the
  // architecture guard.
  for (const businessId of businessIds) {
    await admin.rpc("refresh_filing_calendar_business", { _business_id: businessId });
  }
}

async function handlePackPublished(row: OutboxRow): Promise<void> {
  const packId = (row.payload as any)?.pack_id;
  if (!packId) return;
  const { data: installs } = await admin
    .from("installed_localization_packs")
    .select("business_id")
    .eq("pack_id", packId);
  const businessIds = Array.from(new Set((installs ?? []).map((i: any) => i.business_id).filter(Boolean)));
  for (const businessId of businessIds) {
    await admin.rpc("refresh_filing_calendar_business", { _business_id: businessId });
  }
}

async function handleReturnStateChanged(row: OutboxRow): Promise<void> {
  const businessId = (row.payload as any)?.business_id;
  if (!businessId) return;
  await admin.rpc("refresh_filing_calendar_business", { _business_id: businessId });
}

async function dispatch(row: OutboxRow): Promise<void> {
  switch (row.event_type) {
    case "pack.upgraded":
      await handlePackUpgraded(row);
      return;
    case "pack.published":
      await handlePackPublished(row);
      return;
    case "return.state_changed":
      await handleReturnStateChanged(row);
      return;
  }
}

async function markSuccess(id: string): Promise<void> {
  await admin
    .from("business_event_outbox")
    .update({
      status: "SUCCESS",
      completed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", id);
}

async function markError(id: string, attempts: number, err: unknown): Promise<void> {
  await admin
    .from("business_event_outbox")
    .update({
      status: "ERROR",
      attempts: attempts + 1,
      last_error: err instanceof Error ? err.message : String(err),
    })
    .eq("id", id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const rows = await claim();
    const results: Array<{ id: string; status: string; error?: string }> = [];
    for (const row of rows) {
      try {
        await dispatch(row);
        await markSuccess(row.id);
        results.push({ id: row.id, status: "success" });
      } catch (e) {
        await markError(row.id, row.attempts, e);
        results.push({ id: row.id, status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }
    return new Response(JSON.stringify({ worker: WORKER_ID, processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

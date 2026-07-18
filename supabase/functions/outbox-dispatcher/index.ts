// Wave 2 · Phase D — Durable outbox dispatcher.
//
// Invoked by pg_cron every 10s. Claims server-scope events from
// business_event_outbox (per org, atomic via FOR UPDATE SKIP LOCKED),
// dispatches to a per-topic handler, and calls complete_business_event
// which auto-DLQs after max_attempts.
//
// The browser-side BusinessSaga now only claims 'host' events (drawer,
// printer). This function only claims 'server' events. Both cannot pick
// up the same row.
//
// Handler registry is intentionally minimal in Phase D; Phase E fills it
// in (loyalty, fiscal transmission, analytics projections, …). Unknown
// events succeed as no-ops so the outbox drains instead of accumulating
// while handlers are still being landed.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// The dispatcher is intentionally open (verify_jwt=false). It only drains
// pending business_event_outbox rows atomically via RPC — no user data is
// returned. Callers still need Supabase's anon key on Authorization by the
// platform's default routing, and the pg_cron caller passes it.

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type OutboxRow = {
  id: string;
  org_id: string;
  branch_id: string | null;
  warehouse_id: string | null;
  event_type: string;
  source_doc_type: string;
  source_doc_id: string;
  payload: unknown;
  attempts: number;
  created_at: string;
};

type HandlerFn = (row: OutboxRow) => Promise<void>;

// --- Phase E handlers -----------------------------------------------------
// Each handler must be idempotent (the outbox retries on failure) and must
// throw on unrecoverable errors so the row is dead-lettered after
// max_attempts. Handlers should NOT call user-tenant supabase clients —
// only the service-role `admin` client.

async function handlePosSaleCommitted(row: OutboxRow): Promise<void> {
  const payload = (row.payload ?? {}) as { transaction_id?: string };
  const txnId = payload.transaction_id ?? row.source_doc_id;
  if (!txnId) throw new Error("pos.sale.committed: missing transaction_id");

  // 1. Loyalty accrual — idempotent per pos_transaction_id.
  const { error: loyaltyErr } = await admin.rpc(
    "apply_loyalty_accrual_for_sale",
    { p_transaction_id: txnId },
  );
  if (loyaltyErr) throw new Error(`loyalty accrual: ${loyaltyErr.message}`);

  // 2. Fiscal transmission (KRA eTIMS) — best-effort. Not every org has
  //    eTIMS configured; the function itself decides whether to transmit.
  //    We swallow errors here so a fiscal outage does not block the whole
  //    sale-committed handler; eTIMS retries live inside etims-transmit.
  try {
    await admin.functions.invoke("etims-transmit", {
      body: { doc_type: "pos", transaction_id: txnId, org_id: row.org_id },
    });
  } catch (e) {
    console.warn(JSON.stringify({
      event_id: row.id, event_type: row.event_type,
      warn: "etims-transmit failed", error: e instanceof Error ? e.message : String(e),
    }));
  }
}

async function handleInventoryMovementRecorded(row: OutboxRow): Promise<void> {
  // Reorder-alert recompute lives in check_low_stock_products; call it
  // per-org so subsequent movements trigger fresh alerts. This is cheap
  // enough (single RPC, per event batch) and idempotent.
  const { error } = await admin.rpc("check_low_stock_products");
  if (error) throw new Error(`reorder recompute: ${error.message}`);
}

// Phase E map. Extend with one entry per newly-durable topic. Unknown
// topics remain deliberate no-op successes so the outbox drains.
const HANDLERS: Record<string, HandlerFn> = {
  "pos.sale.committed": handlePosSaleCommitted,
  "inventory.movement.recorded": handleInventoryMovementRecorded,
};

async function dispatch(row: OutboxRow): Promise<void> {
  const handler = HANDLERS[row.event_type];
  if (!handler) return; // no-op success
  await handler(row);
}

async function processOrg(orgId: string, batchSize = 25): Promise<{ ok: number; err: number }> {
  const { data, error } = await admin.rpc("claim_next_business_event", {
    p_org_id: orgId,
    p_limit: batchSize,
    p_claimant: `server-dispatcher:${crypto.randomUUID().slice(0, 8)}`,
    p_branch_id: null,
    p_handler_scope: "server",
  });
  if (error || !data) return { ok: 0, err: 0 };

  let ok = 0, err = 0;
  for (const row of data as OutboxRow[]) {
    const started = Date.now();
    try {
      await dispatch(row);
      await admin.rpc("complete_business_event", {
        p_id: row.id, p_success: true, p_error: null,
      });
      ok++;
      console.log(JSON.stringify({
        org_id: orgId, event_id: row.id, event_type: row.event_type,
        outcome: "ok", attempts: row.attempts, ms: Date.now() - started,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.rpc("complete_business_event", {
        p_id: row.id, p_success: false, p_error: msg,
      });
      err++;
      console.error(JSON.stringify({
        org_id: orgId, event_id: row.id, event_type: row.event_type,
        outcome: "err", attempts: row.attempts, ms: Date.now() - started,
        error: msg,
      }));
    }
  }
  return { ok, err };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });


  // Discover orgs with pending server-scope work. Cheap: distinct scan
  // filtered by index on (org_id, status). Cap orgs per tick to keep
  // each invocation fast.
  const { data: orgs, error } = await admin
    .from("business_event_outbox")
    .select("org_id")
    .in("status", ["pending", "failed"])
    .limit(200);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const uniqueOrgs = Array.from(new Set((orgs ?? []).map((r) => r.org_id)));
  let totalOk = 0, totalErr = 0;
  for (const orgId of uniqueOrgs) {
    const { ok, err } = await processOrg(orgId);
    totalOk += ok; totalErr += err;
  }

  return new Response(
    JSON.stringify({ orgs: uniqueOrgs.length, ok: totalOk, err: totalErr }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

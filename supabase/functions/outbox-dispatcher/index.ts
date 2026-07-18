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
const CRON_SECRET = Deno.env.get("OUTBOX_DISPATCHER_SECRET") ?? "";

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

// Phase E will register real handlers here. Everything unhandled is a
// deliberate no-op so the row is marked succeeded and does not block.
const HANDLERS: Record<string, HandlerFn> = {
  // e.g. "pos.sale.committed.v1": handlePosSaleCommitted,
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

  // Simple shared-secret gate for the cron caller.
  if (CRON_SECRET) {
    const provided = req.headers.get("x-cron-secret") ?? "";
    if (provided !== CRON_SECRET) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

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

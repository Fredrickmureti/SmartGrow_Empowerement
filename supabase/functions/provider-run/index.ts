/**
 * provider-run — executes a configured integration provider.
 *
 * Modes (controlled by request body):
 *   1. Single manual run:
 *      Body: { connection_id, trigger_kind: "manual" }
 *      Auth: caller must be a platform admin (verified via is_platform_admin RPC).
 *
 *   2. Single scheduled run:
 *      Body: { connection_id, trigger_kind: "scheduled" }
 *      Auth: service-role bearer (used internally by batch mode).
 *
 *   3. Scheduled batch (cron entrypoint — FAT FUNCTION pattern):
 *      Body: { trigger_kind: "scheduled_batch" }
 *      Auth: service-role bearer.
 *      Behaviour: scans `platform_integration_connections` for rows where
 *        is_active = true AND auto_refresh_enabled = true
 *        AND (next_run_at IS NULL OR next_run_at <= now())
 *      Processes each one sequentially, updates next_run_at = now() + interval.
 *      Returns a per-connection summary. This single function is the *only*
 *      entry point pg_cron needs to call — keeping us under Supabase's
 *      100-edge-function ceiling (see docs/adr/0005-fat-edge-functions.md).
 *
 * For exchange_rates capability: fetches latest USD-based rates and upserts
 * them into public.platform_exchange_rates (preserves manual customisations
 * to display_name/symbol once a row exists).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  DEFAULT_TARGETS,
  getHandler as getExchangeRateHandler,
} from "../_shared/integration-handlers/exchangeRates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CURRENCY_META: Record<string, { name: string; symbol: string }> = {
  USD: { name: "US Dollar", symbol: "$" },
  EUR: { name: "Euro", symbol: "€" },
  GBP: { name: "British Pound", symbol: "£" },
  KES: { name: "Kenyan Shilling", symbol: "KSh" },
  UGX: { name: "Ugandan Shilling", symbol: "USh" },
  TZS: { name: "Tanzanian Shilling", symbol: "TSh" },
  RWF: { name: "Rwandan Franc", symbol: "FRw" },
  ZAR: { name: "South African Rand", symbol: "R" },
  INR: { name: "Indian Rupee", symbol: "₹" },
  NGN: { name: "Nigerian Naira", symbol: "₦" },
  JPY: { name: "Japanese Yen", symbol: "¥" },
  CAD: { name: "Canadian Dollar", symbol: "C$" },
  AUD: { name: "Australian Dollar", symbol: "A$" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization");
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const body = await req.json().catch(() => ({}));
    const trigger_kind: "manual" | "scheduled" | "scheduled_batch" =
      body.trigger_kind ?? "manual";
    const connection_id: string | undefined = body.connection_id;

    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ─── Mode 3: scheduled batch (cron) ─────────────────────────────────
    if (trigger_kind === "scheduled_batch") {
      // Accept either the service-role key (manual ops) or the anon key
      // (cron jobs — see project-wide pattern in cron.job table). The Supabase
      // Edge Function gateway validates the JWT before reaching us, so anon
      // is sufficient as a "this came from inside Supabase" signal here.
      if (
        auth !== `Bearer ${serviceKey}` &&
        auth !== `Bearer ${anonKey}`
      ) {
        return json({ error: "Unauthorized" }, 401);
      }

      const nowIso = new Date().toISOString();
      const { data: due, error: dueErr } = await admin
        .from("platform_integration_connections")
        .select("id, capability_key, auto_refresh_interval_hours")
        .eq("is_active", true)
        .eq("auto_refresh_enabled", true)
        .or(`next_run_at.is.null,next_run_at.lte.${nowIso}`);
      if (dueErr) return json({ error: dueErr.message }, 500);

      const results: Array<Record<string, unknown>> = [];
      for (const conn of due ?? []) {
        const r = await runOne(admin, conn.id, "scheduled", null);
        const intervalMs = (conn.auto_refresh_interval_hours ?? 24) * 3_600_000;
        await admin
          .from("platform_integration_connections")
          .update({ next_run_at: new Date(Date.now() + intervalMs).toISOString() })
          .eq("id", conn.id);
        results.push({ connection_id: conn.id, ...r });
      }
      return json({ success: true, processed: results.length, results });
    }

    // ─── Modes 1 & 2: single connection run ─────────────────────────────
    if (!connection_id) return json({ error: "connection_id required" }, 400);

    let triggeredBy: string | null = null;
    if (trigger_kind === "manual") {
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const userClient = createClient(url, anonKey, {
        global: { headers: { Authorization: auth } },
      });
      const { data: userResp } = await userClient.auth.getUser();
      if (!userResp?.user) return json({ error: "Unauthorized" }, 401);
      const { data: isAdmin } = await userClient.rpc("is_platform_admin", {
        _user_id: userResp.user.id,
      });
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      triggeredBy = userResp.user.id;
    } else {
      // scheduled (single) — service-role only
      if (auth !== `Bearer ${serviceKey}`) return json({ error: "Unauthorized" }, 401);
    }

    const result = await runOne(admin, connection_id, trigger_kind, triggeredBy);
    if ("error" in result) return json(result, 400);

    // For manual runs, also bump next_run_at if auto-refresh is enabled
    if (trigger_kind === "manual") {
      const { data: conn } = await admin
        .from("platform_integration_connections")
        .select("auto_refresh_enabled, auto_refresh_interval_hours")
        .eq("id", connection_id)
        .single();
      if (conn?.auto_refresh_enabled) {
        const intervalMs = (conn.auto_refresh_interval_hours ?? 24) * 3_600_000;
        await admin
          .from("platform_integration_connections")
          .update({ next_run_at: new Date(Date.now() + intervalMs).toISOString() })
          .eq("id", connection_id);
      }
    }

    return json(result);
  } catch (err) {
    console.error("provider-run error", err);
    return json({ error: (err as Error).message }, 500);
  }
});

/**
 * Executes one provider run: opens a `platform_integration_runs` row,
 * dispatches by capability_key, persists results, updates the connection.
 * Pure helper so both single + batch modes share the same path.
 */
// deno-lint-ignore no-explicit-any
async function runOne(
  admin: any,
  connection_id: string,
  trigger_kind: "manual" | "scheduled",
  triggered_by: string | null,
): Promise<Record<string, unknown>> {
  const { data: conn, error: connErr } = await admin
    .from("platform_integration_connections")
    .select("id, capability_key, credentials, provider_id, is_active")
    .eq("id", connection_id)
    .single();
  if (connErr || !conn) return { error: "Connection not found" };
  if (!conn.is_active) return { error: "Connection is not active" };

  const { data: provider } = await admin
    .from("platform_integration_providers")
    .select("provider_key, capability_key")
    .eq("id", conn.provider_id)
    .single();
  if (!provider) return { error: "Provider not found" };

  const { data: runRow } = await admin
    .from("platform_integration_runs")
    .insert({
      connection_id,
      capability_key: conn.capability_key,
      provider_id: conn.provider_id,
      trigger_kind,
      triggered_by,
    })
    .select("id")
    .single();

  let stats: Record<string, unknown> = {};
  let status: "success" | "partial" | "failed" = "success";
  let message = "";

  try {
    if (provider.capability_key === "exchange_rates") {
      const handler = getExchangeRateHandler(provider.provider_key);
      const result = await handler.fetch(conn.credentials || {}, DEFAULT_TARGETS);
      let updated = 0;
      let inserted = 0;

      for (const [code, rate] of Object.entries(result.rates)) {
        if (!rate || !isFinite(Number(rate))) continue;
        const meta = CURRENCY_META[code];

        const { data: existing } = await admin
          .from("platform_exchange_rates")
          .select("id")
          .eq("from_currency", "USD")
          .eq("to_currency", code)
          .maybeSingle();

        if (existing) {
          await admin
            .from("platform_exchange_rates")
            .update({
              rate: Number(rate),
              is_active: true,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existing.id);
          updated++;
        } else {
          await admin.from("platform_exchange_rates").insert({
            from_currency: "USD",
            to_currency: code,
            rate: Number(rate),
            display_name: meta?.name ?? code,
            symbol: meta?.symbol ?? code,
            is_active: true,
          });
          inserted++;
        }
      }
      stats = { updated, inserted, as_of: result.asOf, total: updated + inserted };
      message = `Refreshed ${updated + inserted} currencies`;
    } else {
      status = "failed";
      message = `No handler for capability: ${provider.capability_key}`;
    }
  } catch (err) {
    status = "failed";
    message = (err as Error).message;
  }

  await admin
    .from("platform_integration_runs")
    .update({ finished_at: new Date().toISOString(), status, message, stats })
    .eq("id", runRow!.id);

  await admin
    .from("platform_integration_connections")
    .update({
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      last_run_message: message,
    })
    .eq("id", connection_id);

  return { success: status === "success", status, message, stats };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

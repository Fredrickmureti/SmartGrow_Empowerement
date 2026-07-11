/**
 * Fat edge function `loan-gl` (ADR 0005) — consolidates:
 *   • post-loan-disbursement       → action: "disburse"
 *   • post-loan-interest-accrual   → action: "accrue"
 *   • post-loan-settlement         → action: "settle"
 *
 * All actions require an admin/manager JWT (Bearer). All handlers are
 * idempotent via `journal_entries.source_type/source_id[/reference]` so
 * re-invocation is safe.
 *
 * For back-compat the router also accepts the legacy per-name path
 * (`?fn=post-loan-disbursement` etc.) so any pg_cron entry still pointing
 * at an old URL can be redirected here in one config change if needed.
 */
import {
  authenticate,
  makeAdminClient,
  handleDisburse,
  handleAccrue,
  handleSettle,
} from "../_shared/loan-gl/handlers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Action = "disburse" | "accrue" | "settle";

function resolveAction(body: any, url: URL): Action | null {
  const raw = (body?.action ?? url.searchParams.get("action") ?? "").toString().trim();
  if (raw === "disburse" || raw === "accrue" || raw === "settle") return raw;
  // legacy compatibility hooks
  const legacy = url.searchParams.get("fn");
  if (legacy === "post-loan-disbursement") return "disburse";
  if (legacy === "post-loan-interest-accrual") return "accrue";
  if (legacy === "post-loan-settlement") return "settle";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = await authenticate(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    const body = await req.json().catch(() => ({}));
    const url = new URL(req.url);
    const action = resolveAction(body, url);
    if (!action) {
      return json({ error: "Unknown action. Use 'disburse' | 'accrue' | 'settle'." }, 400);
    }

    const ctx = { admin: makeAdminClient(), userId: auth.userId };
    const result =
      action === "disburse" ? await handleDisburse(body, ctx) :
      action === "accrue"   ? await handleAccrue(body, ctx)   :
                              await handleSettle(body, ctx);

    return json(result.body, result.status);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
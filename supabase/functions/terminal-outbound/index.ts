/**
 * POS Payment Terminal — outbound gateway.
 *
 * Tenant-owned credentials pattern (mirrors `mpesa-outbound`):
 *   • Reads the org's terminal config row via the authed user's session
 *     (RLS enforced through SECURITY DEFINER RPC `get_terminal_config_masked`).
 *   • Loads the raw vendor credentials from Supabase Vault using the
 *     service-role client (server-side only — never returned to the client).
 *   • Dispatches to a vendor adapter (Stripe Terminal / Adyen / Verifone /
 *     Square Terminal). Real native-SDK wiring lands in follow-up loops;
 *     this function provides the cloud-mode HTTP surface and the
 *     state-machine writes into `payment_requests` + `pos_terminal_sessions`.
 *
 * Actions (selected via ?action= or body.action):
 *   - health           {configId}                           sandbox/live ping
 *   - connection_token {configId}                           short-lived client token
 *   - create_intent    {configId, amount, currency, posTransactionId}
 *   - capture          {paymentRequestId}
 *   - cancel           {paymentRequestId}
 *   - refund           {paymentRequestId, amount?}
 *   - query            {paymentRequestId}
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type ProviderId = "stripe_terminal" | "adyen" | "verifone" | "square_terminal";

interface TerminalConfigRow {
  id: string;
  organization_id: string;
  business_id: string;
  provider: ProviderId;
  provider_mode: "test" | "live";
  location_id: string | null;
  merchant_account: string | null;
  poi_terminal_id: string | null;
  vault_secret_id: string | null;
  is_enabled: boolean;
}

// ────────────────────────── Auth + clients ──────────────────────────

function makeAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

async function getCaller(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { error: "Missing bearer token" as const };
  }
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return { error: "Invalid session" as const };
  return { user: data.user, userClient };
}

async function loadConfigForUser(
  userClient: ReturnType<typeof createClient>,
  admin: ReturnType<typeof createClient>,
  configId: string,
): Promise<{ row?: TerminalConfigRow; secret?: string; error?: string }> {
  // 1) Use the user client so RLS sees their session, but we read the raw
  //    row via service role after we've checked org membership.
  const { data: row, error } = await admin
    .from("pos_terminal_provider_configs")
    .select("*")
    .eq("id", configId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!row) return { error: "Terminal config not found" };

  // 2) Authorize: caller must be owner/admin/super_admin of the org.
  const { data: caller } = await userClient.auth.getUser();
  if (!caller?.user) return { error: "Not authenticated" };
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", caller.user.id)
    .eq("organization_id", row.organization_id)
    .in("role", ["owner", "admin", "super_admin", "cashier", "manager"])
    .maybeSingle();
  if (!roleRow) return { error: "Forbidden" };

  // 3) Load the vault secret (server-side only).
  let secret: string | undefined;
  if (row.vault_secret_id) {
    const { data: vaultRow, error: vErr } = await admin
      .schema("vault")
      .from("decrypted_secrets")
      .select("decrypted_secret")
      .eq("id", row.vault_secret_id)
      .maybeSingle();
    if (vErr) return { error: `Vault read failed: ${vErr.message}` };
    secret = vaultRow?.decrypted_secret ?? undefined;
  }

  return { row: row as TerminalConfigRow, secret };
}

// ────────────────────────── Vendor adapters ──────────────────────────
// Each adapter exposes the same minimal surface. Native SDK / hardware
// wiring lands in per-vendor follow-up loops.

interface VendorContext {
  config: TerminalConfigRow;
  secret: string;
  sandbox: boolean;
}

interface VendorAdapter {
  health(ctx: VendorContext): Promise<{ ok: boolean; error?: string }>;
  connectionToken(ctx: VendorContext): Promise<{ token: string; expires_at: string }>;
  createIntent(
    ctx: VendorContext,
    args: { amount: number; currency: string; reference: string },
  ): Promise<{ intent_id: string; status: string; vendor: Record<string, unknown> }>;
  capture(ctx: VendorContext, intentId: string): Promise<{ status: string; vendor: Record<string, unknown> }>;
  cancel(ctx: VendorContext, intentId: string): Promise<{ status: string; vendor: Record<string, unknown> }>;
  refund(
    ctx: VendorContext,
    intentId: string,
    amount?: number,
  ): Promise<{ status: string; vendor: Record<string, unknown> }>;
  query(ctx: VendorContext, intentId: string): Promise<{ status: string; vendor: Record<string, unknown> }>;
}

/** Stripe Terminal cloud-mode adapter. */
const stripeAdapter: VendorAdapter = {
  async health({ secret, sandbox }) {
    const r = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!r.ok) return { ok: false, error: `Stripe ${r.status} (${sandbox ? "test" : "live"})` };
    return { ok: true };
  },
  async connectionToken({ secret, config }) {
    const body = new URLSearchParams();
    if (config.location_id) body.set("location", config.location_id);
    const r = await fetch("https://api.stripe.com/v1/terminal/connection_tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Stripe connection token failed: ${JSON.stringify(data)}`);
    // Stripe connection tokens last ~10 minutes.
    return { token: data.secret, expires_at: new Date(Date.now() + 9 * 60_000).toISOString() };
  },
  async createIntent({ secret }, { amount, currency, reference }) {
    const body = new URLSearchParams({
      amount: String(Math.round(amount * 100)),
      currency: currency.toLowerCase(),
      "payment_method_types[]": "card_present",
      capture_method: "manual",
      "metadata[pos_reference]": reference,
    });
    const r = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Stripe createIntent failed: ${JSON.stringify(data)}`);
    return { intent_id: data.id, status: data.status, vendor: data };
  },
  async capture({ secret }, intentId) {
    const r = await fetch(`https://api.stripe.com/v1/payment_intents/${intentId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Stripe capture failed: ${JSON.stringify(data)}`);
    return { status: data.status, vendor: data };
  },
  async cancel({ secret }, intentId) {
    const r = await fetch(`https://api.stripe.com/v1/payment_intents/${intentId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Stripe cancel failed: ${JSON.stringify(data)}`);
    return { status: data.status, vendor: data };
  },
  async refund({ secret }, intentId, amount) {
    const body = new URLSearchParams({ payment_intent: intentId });
    if (typeof amount === "number") body.set("amount", String(Math.round(amount * 100)));
    const r = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Stripe refund failed: ${JSON.stringify(data)}`);
    return { status: data.status, vendor: data };
  },
  async query({ secret }, intentId) {
    const r = await fetch(`https://api.stripe.com/v1/payment_intents/${intentId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Stripe query failed: ${JSON.stringify(data)}`);
    return { status: data.status, vendor: data };
  },
};

/**
 * Adyen / Verifone / Square placeholder adapters.
 *
 * Real cloud-API integration is per-vendor and lives in follow-up loops
 * (each requires its own merchant onboarding flow, signed-payload shape,
 * and physical-device pairing). The adapters here surface a clear
 * NOT_IMPLEMENTED error rather than silently no-op, so the UI can render
 * "vendor pending" without ever putting a real terminal into a wedged state.
 */
function stubAdapter(name: string): VendorAdapter {
  const notImpl = () => {
    throw new Error(`${name} cloud adapter is not implemented in this build`);
  };
  return {
    async health({ secret }) {
      if (!secret) return { ok: false, error: "No credentials stored" };
      return { ok: true };
    },
    async connectionToken() { return notImpl(); },
    async createIntent() { return notImpl(); },
    async capture()       { return notImpl(); },
    async cancel()        { return notImpl(); },
    async refund()        { return notImpl(); },
    async query()         { return notImpl(); },
  };
}

const adapters: Record<ProviderId, VendorAdapter> = {
  stripe_terminal: stripeAdapter,
  adyen:           stubAdapter("Adyen"),
  verifone:        stubAdapter("Verifone"),
  square_terminal: stubAdapter("Square Terminal"),
};

// ────────────────────────── Handler ──────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
    const action: string = url.searchParams.get("action") ?? body.action ?? "";

    const caller = await getCaller(req);
    if ("error" in caller) return json({ success: false, error: caller.error }, 401);

    const admin = makeAdmin();

    // ── action: health / connection_token / create_intent need configId
    if (["health", "connection_token", "create_intent"].includes(action)) {
      const configId: string | undefined = body.configId;
      if (!configId) return json({ success: false, error: "configId required" }, 400);

      const loaded = await loadConfigForUser(caller.userClient, admin, configId);
      if (loaded.error || !loaded.row) {
        return json({ success: false, error: loaded.error ?? "Config load failed" }, 400);
      }
      if (!loaded.secret) {
        return json({ success: false, error: "No vendor credentials stored" }, 400);
      }
      const ctx: VendorContext = {
        config: loaded.row,
        secret: loaded.secret,
        sandbox: loaded.row.provider_mode === "test",
      };
      const adapter = adapters[loaded.row.provider];

      if (action === "health") {
        try {
          const res = await adapter.health(ctx);
          await admin.rpc("record_terminal_test_result", {
            p_config_id: configId,
            p_status:    res.ok ? "ok" : "failed",
            p_error:     res.error ?? null,
          });
          return json({ success: res.ok, ...res });
        } catch (e: any) {
          await admin.rpc("record_terminal_test_result", {
            p_config_id: configId, p_status: "failed", p_error: e.message,
          });
          return json({ success: false, error: e.message }, 200);
        }
      }

      if (action === "connection_token") {
        const tok = await adapter.connectionToken(ctx);
        return json({ success: true, ...tok });
      }

      if (action === "create_intent") {
        const { amount, currency = "USD", posTransactionId } = body;
        if (typeof amount !== "number" || amount <= 0) {
          return json({ success: false, error: "amount must be > 0" }, 400);
        }
        // 1) Insert a payment_requests row (matches the M-Pesa flow shape).
        const { data: pr, error: prErr } = await admin
          .from("payment_requests")
          .insert({
            organization_id: loaded.row.organization_id,
            business_id:     loaded.row.business_id,
            pos_transaction_id: posTransactionId ?? null,
            provider:        loaded.row.provider,
            amount,
            currency,
            status:          "pending",
            initiated_at:    new Date().toISOString(),
            metadata:        { config_id: configId, mode: loaded.row.provider_mode },
          })
          .select("*")
          .single();
        if (prErr) return json({ success: false, error: prErr.message }, 500);

        try {
          const intent = await adapter.createIntent(ctx, {
            amount, currency, reference: pr.id,
          });
          await admin.from("payment_requests").update({
            provider_reference: intent.intent_id,
            status: "processing",
            updated_at: new Date().toISOString(),
          }).eq("id", pr.id);

          const { data: session } = await admin.from("pos_terminal_sessions").insert({
            organization_id:    loaded.row.organization_id,
            business_id:        loaded.row.business_id,
            config_id:          configId,
            payment_request_id: pr.id,
            provider:           loaded.row.provider,
            intent_id:          intent.intent_id,
            status:             intent.status,
            vendor_response:    intent.vendor,
          }).select("*").single();

          return json({
            success: true,
            paymentRequest: { ...pr, provider_reference: intent.intent_id, status: "processing" },
            session,
          });
        } catch (e: any) {
          await admin.from("payment_requests").update({
            status: "failed", result_description: e.message,
            completed_at: new Date().toISOString(),
          }).eq("id", pr.id);
          return json({ success: false, error: e.message }, 200);
        }
      }
    }

    // ── action: capture / cancel / refund / query need paymentRequestId
    if (["capture", "cancel", "refund", "query"].includes(action)) {
      const paymentRequestId: string | undefined = body.paymentRequestId;
      if (!paymentRequestId) return json({ success: false, error: "paymentRequestId required" }, 400);

      const { data: pr, error: prErr } = await admin
        .from("payment_requests").select("*").eq("id", paymentRequestId).maybeSingle();
      if (prErr || !pr) return json({ success: false, error: "payment_request not found" }, 404);

      const configId = (pr.metadata as any)?.config_id as string | undefined;
      if (!configId) return json({ success: false, error: "payment_request missing config_id" }, 400);

      const loaded = await loadConfigForUser(caller.userClient, admin, configId);
      if (loaded.error || !loaded.row || !loaded.secret) {
        return json({ success: false, error: loaded.error ?? "Config load failed" }, 400);
      }
      const ctx: VendorContext = {
        config: loaded.row, secret: loaded.secret,
        sandbox: loaded.row.provider_mode === "test",
      };
      const adapter = adapters[loaded.row.provider];
      const intentId = pr.provider_reference;
      if (!intentId) return json({ success: false, error: "no provider_reference on payment_request" }, 400);

      const result =
        action === "capture" ? await adapter.capture(ctx, intentId) :
        action === "cancel"  ? await adapter.cancel(ctx, intentId) :
        action === "refund"  ? await adapter.refund(ctx, intentId, body.amount) :
                               await adapter.query(ctx, intentId);

      const mappedStatus =
        action === "capture" && result.status === "succeeded" ? "completed" :
        action === "cancel"  ? "cancelled" :
        action === "refund"  ? "completed" :
        pr.status;

      await admin.from("payment_requests").update({
        status: mappedStatus,
        result_code: result.status,
        callback_payload: result.vendor,
        completed_at: ["completed","cancelled","failed"].includes(mappedStatus)
          ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("id", paymentRequestId);

      await admin.from("pos_terminal_sessions").insert({
        organization_id:    pr.organization_id,
        business_id:        pr.business_id,
        config_id:          configId,
        payment_request_id: paymentRequestId,
        provider:           loaded.row.provider,
        intent_id:          intentId,
        status:             `${action}:${result.status}`,
        vendor_response:    result.vendor,
      });

      return json({ success: true, status: result.status, paymentRequestId });
    }

    return json({ success: false, error: `Unknown action: ${action}` }, 400);
  } catch (e: any) {
    return json({ success: false, error: e?.message ?? String(e) }, 500);
  }
});

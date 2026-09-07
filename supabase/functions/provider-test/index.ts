/**
 * provider-test — unified provider connection-test dispatcher.
 *
 * Routes by `kind`:
 *   - "connection"        → platform_integration_connections (default; capability handlers in _shared/integration-handlers/)
 *   - "bank"              → platform_bank_providers           (legacy: test-bank-connection)
 *   - "sms"               → sms_provider_configs (sends real test SMS) (legacy: test-sms-connection)
 *   - "payment"           → payment_provider_configs          (legacy: test-payment-provider)
 *   - "platform_payment"  → platform_payment_providers        (legacy: test-platform-payment-provider)
 *
 * Each branch keeps its own auth/permission model and request schema.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { getHandler as getExchangeRateHandler } from "../_shared/integration-handlers/exchangeRates.ts";
import { sendSms, sanitizeForLog, type SmsMode } from "../_shared/twilio.ts";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = req.headers.get("Authorization");

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const kind = (body.kind as string | undefined) ?? "connection";

    // ─── Bank ──────────────────────────────────────────────────────────
    if (kind === "bank") {
      const provider_id = body.provider_id as string | undefined;
      if (!provider_id) return json({ success: false, error: "provider_id is required" }, 400);
      const admin = createClient(url, serviceKey);
      const { data: provider, error } = await admin
        .from("platform_bank_providers").select("*").eq("id", provider_id).single();
      if (error || !provider) return json({ success: false, error: "Bank provider not found" }, 404);

      // Validate based on provider_code; identical to legacy stub behavior.
      const has = (k: string) => Boolean((provider as Record<string, unknown>)[k]);
      const requiresMerchant = ["jenga", "ncba", "im_bank", "dtb_astra"].includes(provider.provider_code);
      if (requiresMerchant && !has("merchant_code")) {
        return json({ success: false, message: "Missing merchant code." });
      }
      if (!has("api_key_encrypted")) {
        return json({ success: false, message: "Missing API key." });
      }
      const noSecretNeeded = ["ncba"].includes(provider.provider_code);
      if (!noSecretNeeded && !has("api_secret_encrypted")) {
        return json({ success: false, message: "Missing API secret." });
      }
      return json({
        success: true,
        message: `Connection to ${provider.provider_name} ${provider.is_sandbox ? "(Sandbox)" : "(Production)"} verified. Credentials configured.`,
      });
    }

    // ─── SMS (real test send) ──────────────────────────────────────────
    if (kind === "sms") {
      if (!auth?.startsWith("Bearer ")) return json({ success: false, code: "UNAUTHORIZED", message: "Missing Authorization header" }, 401);
      const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
      const token = auth.replace("Bearer ", "");
      const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
      if (claimsError || !claimsData?.claims) return json({ success: false, code: "UNAUTHORIZED", message: "Invalid auth token" }, 401);
      const userId = claimsData.claims.sub as string;
      const admin = createClient(url, serviceKey);

      const organization_id = body.organization_id as string | undefined;
      const test_phone = body.test_phone as string | undefined;
      if (!organization_id || !test_phone) return json({ success: false, code: "VALIDATION_FAILED", message: "organization_id and test_phone are required" }, 400);

      const { data: userRole } = await admin.from("user_roles").select("role")
        .eq("user_id", userId).eq("organization_id", organization_id).eq("is_active", true).maybeSingle();
      if (!userRole || !["owner", "admin", "super_admin"].includes(userRole.role)) {
        return json({ success: false, code: "PERMISSION_DENIED", message: "Only org admins can test SMS" }, 403);
      }
      const { data: config } = await admin.from("sms_provider_configs").select("*").eq("organization_id", organization_id).limit(1).maybeSingle();
      if (!config) return json({ success: false, code: "CONFIG_MISSING", message: "SMS provider not configured" });

      const providerMode: SmsMode = config.provider_mode === "live" ? "live" : "test";
      const testBody = `[Test SMS — mode=${providerMode}] Your ERP Twilio integration is working.`;
      const result = await sendSms({
        to: test_phone, body: testBody,
        config: {
          account_sid: config.account_sid, auth_token: config.auth_token,
          sender_phone: config.sender_phone, messaging_service_sid: config.messaging_service_sid,
          provider_mode: providerMode,
        },
      });

      try {
        await admin.from("sms_provider_configs").update({
          last_test_at: new Date().toISOString(),
          last_test_status: result.ok ? "success" : result.code,
          last_test_error: result.ok ? null : sanitizeForLog(result.message, config.account_sid),
        }).eq("id", config.id);
        await admin.from("sms_log").insert({
          organization_id, business_id: null, event_type: null,
          recipient_phone: test_phone, message_body: testBody,
          status: result.ok ? "sent" : "failed",
          provider_message_id: result.ok ? result.sid : null,
          error_code: result.ok ? null : result.code,
          error_message: result.ok ? null : sanitizeForLog(result.message, config.account_sid),
          sent_at: result.ok ? new Date().toISOString() : null,
          provider_mode: providerMode, sent_by: userId,
          from_phone: result.ok ? (result.from ?? null) : null,
        });
      } catch (e) { console.error("[provider-test sms] audit write failed", e); }

      return result.ok
        ? json({ success: true, code: "OK", message: null, mode: providerMode, message_sid: result.sid })
        : json({ success: false, code: result.code, message: result.message, mode: providerMode });
    }

    // ─── Payment (tenant) ─────────────────────────────────────────────
    if (kind === "payment") {
      const provider = body.provider as string | undefined;
      const organizationId = body.organizationId as string | undefined;
      if (!provider || !organizationId) return json({ success: false, error: "Missing provider or organizationId" }, 400);
      const admin = createClient(url, serviceKey);
      const { data: cfg, error: cfgErr } = await admin.from("payment_provider_configs").select("*").eq("organization_id", organizationId).eq("provider", provider).single();
      if (cfgErr || !cfg) return json({ success: false, error: `${provider} not configured for this organization` }, 400);

      const updateResult = async (test_result: string, test_error: string | null) =>
        admin.from("payment_provider_configs").update({ last_tested_at: new Date().toISOString(), test_result, test_error }).eq("id", cfg.id);

      try {
        if (provider === "mpesa" || provider === "mpesa_c2b") {
          const c = cfg.config as Record<string, string>;
          if (!c.consumer_key || !c.consumer_secret) { await updateResult("failed", "Missing key/secret"); return json({ success: false, error: "Missing consumer key or secret" }); }
          const { data: ps } = await admin.from("platform_settings").select("setting_value").eq("setting_key", "mpesa_environment").single();
          const env = ps?.setting_value || "production";
          const baseUrl = env === "sandbox" ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";
          const r = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${btoa(`${c.consumer_key}:${c.consumer_secret}`)}` } });
          if (r.ok && (await r.json()).access_token) { await updateResult("success", null); return json({ success: true, message: "M-Pesa credentials verified", environment: env }); }
          await updateResult("failed", "Invalid credentials"); return json({ success: false, error: "Invalid M-Pesa credentials" });
        }
        // Card acquiring (Stripe), PayPal and PesaPal were removed with the
        // ERP payment-gateway configuration. This is a Kenya-only MFI:
        // collections are M-Pesa PayBill, bank transfer/deposit and cash.
        if (provider === "bank_transfer" || provider === "cash") {
          await updateResult("success", null);
          return json({ success: true, message: `${provider} configured. Manual payment method.` });
        }
        await updateResult("skipped", `Testing not available for ${provider}`);
        return json({ success: true, message: `Configuration saved. Automated testing not available for ${provider}.` });
      } catch (e) {
        const msg = (e as Error).message || "Internal error";
        await updateResult("failed", msg);
        return json({ success: false, error: msg }, 500);
      }
    }

    // ─── Platform Payment ──────────────────────────────────────────────
    if (kind === "platform_payment") {
      if (!auth?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
      const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
      const token = auth.replace("Bearer ", "");
      const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
      if (claimsError || !claimsData?.claims) return json({ error: "Unauthorized" }, 401);
      const admin = createClient(url, serviceKey);
      const { data: roleData } = await admin.from("platform_admin_roles").select("role").eq("user_id", claimsData.claims.sub).maybeSingle();
      if (!roleData) return json({ error: "Forbidden: Platform admin access required" }, 403);

      const provider = body.provider as string | undefined;
      // Kenya-only MFI: card acquiring (Stripe), PayPal and PesaPal were removed
      // with the ERP payment-gateway configuration. M-Pesa is the only provider.
      if (provider !== "mpesa") return json({ error: "Invalid provider" }, 400);
      const { data: providerData, error: pErr } = await admin.from("platform_payment_providers").select("credentials, is_test_mode").eq("provider", provider).single();
      if (pErr || !providerData) return json({ success: false, error: "Provider configuration not found" });

      const creds = providerData.credentials || {};
      const testMode = providerData.is_test_mode;
      let success = false; let errorMessage = "";
      try {
        if (!creds.consumer_key || !creds.consumer_secret) return json({ success: false, error: "Missing consumer_key/secret" });
        const baseUrl = testMode ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";
        const r = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${btoa(`${creds.consumer_key}:${creds.consumer_secret}`)}` } });
        if (r.ok && (await r.json()).access_token) success = true; else errorMessage = "Invalid credentials";
      } catch (e) { errorMessage = (e as Error).message || "Connection failed"; }

      await admin.from("platform_payment_providers").update({
        last_tested_at: new Date().toISOString(),
        test_status: success ? "success" : "failed",
        test_error: success ? null : errorMessage,
      }).eq("provider", provider);
      return json({ success, error: errorMessage || null });
    }

    // ─── Default: platform integration connection (capability dispatch) ─
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
    const { data: userResp } = await userClient.auth.getUser();
    if (!userResp?.user) return json({ error: "Unauthorized" }, 401);
    const { data: isAdmin } = await userClient.rpc("is_platform_admin", { _user_id: userResp.user.id });
    if (!isAdmin) return json({ error: "Forbidden" }, 403);

    const connection_id = body.connection_id as string | undefined;
    if (!connection_id) return json({ error: "connection_id required" }, 400);
    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: conn, error: connErr } = await admin
      .from("platform_integration_connections").select("id, capability_key, credentials, provider_id").eq("id", connection_id).single();
    if (connErr || !conn) return json({ error: "Connection not found" }, 404);
    const { data: provider } = await admin
      .from("platform_integration_providers").select("provider_key, capability_key").eq("id", conn.provider_id).single();
    if (!provider) return json({ error: "Provider not found" }, 404);

    let result: { ok: boolean; message: string };
    if (provider.capability_key === "exchange_rates") {
      result = await getExchangeRateHandler(provider.provider_key).test(conn.credentials || {});
    } else {
      result = { ok: false, message: `No handler for capability: ${provider.capability_key}` };
    }
    await admin.from("platform_integration_connections").update({
      last_test_at: new Date().toISOString(), last_test_ok: result.ok, last_test_message: result.message,
    }).eq("id", connection_id);
    await admin.from("platform_integration_runs").insert({
      connection_id, capability_key: conn.capability_key, provider_id: conn.provider_id,
      trigger_kind: "test", triggered_by: userResp.user.id,
      finished_at: new Date().toISOString(),
      status: result.ok ? "success" : "failed", message: result.message,
    });
    return json({ success: result.ok, message: result.message });
  } catch (err) {
    console.error("provider-test error", err);
    return json({ error: (err as Error).message }, 500);
  }
});

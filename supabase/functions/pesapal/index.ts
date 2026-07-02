import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { activateSubscription } from "../_shared/subscriptionUtils.ts";

/**
 * Consolidated PesaPal function. Routed by URL path suffix:
 *   POST /functions/v1/pesapal/create-order  → create order (auth required)
 *   GET/POST /functions/v1/pesapal/callback  → PesaPal IPN webhook
 *
 * Replaces pesapal-create-order + pesapal-callback. Handler bodies preserved verbatim.
 *
 * OPS NOTE: After deploy, update the PesaPal IPN URL to point at
 * /functions/v1/pesapal/callback (the old /pesapal-callback path is removed).
 */

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

async function getPesaPalToken(consumerKey: string, consumerSecret: string, isSandbox: boolean): Promise<string> {
  const baseUrl = isSandbox ? "https://cybqa.pesapal.com/pesapalv3" : "https://pay.pesapal.com/v3";
  const response = await fetch(`${baseUrl}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ consumer_key: consumerKey, consumer_secret: consumerSecret }),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || "Failed to get PesaPal token");
  return data.token;
}

async function handleCreate(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const authHeader = req.headers.get("authorization");
  if (!authHeader) return json({ error: "Authorization required" }, 401);
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ error: "Invalid authentication" }, 401);

  const { planId, billingCycle, phoneNumber, callbackUrl } = await req.json();
  if (!planId || !billingCycle) return json({ error: "Plan ID and billing cycle required" }, 400);

  const { data: provider } = await supabase
    .from("platform_payment_providers")
    .select("credentials, is_test_mode, is_enabled")
    .eq("provider", "pesapal")
    .single();

  if (!provider || !provider.is_enabled) return json({ error: "PesaPal is not configured or enabled" }, 400);

  const credentials = provider.credentials as { consumer_key?: string; consumer_secret?: string; ipn_id?: string };
  if (!credentials?.consumer_key || !credentials?.consumer_secret)
    return json({ error: "PesaPal credentials not configured" }, 400);

  const { data: plan } = await supabase
    .from("platform_subscription_plans")
    .select("*")
    .eq("id", planId)
    .single();
  if (!plan) return json({ error: "Plan not found" }, 404);

  const currency = plan.price_monthly_kes ? "KES" : "USD";

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  let userCount = 1;
  if (membership?.organization_id) {
    const { count } = await supabase
      .from("organization_members")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", membership.organization_id);
    userCount = count || 1;
  }

  const basePrice = billingCycle === "yearly"
    ? (plan.price_yearly_kes || plan.price_yearly)
    : (plan.price_monthly_kes || plan.price_monthly);
  const perUserPrice = billingCycle === "yearly"
    ? (plan.price_per_user_yearly || 0) * (currency === "KES" ? 130 : 1)
    : (plan.price_per_user_monthly || 0) * (currency === "KES" ? 130 : 1);
  const amount = basePrice + (userCount * perUserPrice);

  const accessToken = await getPesaPalToken(credentials.consumer_key, credentials.consumer_secret, provider.is_test_mode);
  const baseUrl = provider.is_test_mode ? "https://cybqa.pesapal.com/pesapalv3" : "https://pay.pesapal.com/v3";

  const merchantReference = `SUB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const orderPayload = {
    id: merchantReference,
    currency,
    amount: Number(amount.toFixed(2)),
    description: `${plan.name} Plan - ${billingCycle}`,
    callback_url: callbackUrl || `${supabaseUrl}/functions/v1/pesapal/callback`,
    notification_id: credentials.ipn_id || "",
    billing_address: {
      email_address: user.email,
      phone_number: phoneNumber || "",
      first_name: user.user_metadata?.full_name?.split(" ")[0] || "",
      last_name: user.user_metadata?.full_name?.split(" ").slice(1).join(" ") || "",
    },
  };

  const orderResponse = await fetch(`${baseUrl}/api/Transactions/SubmitOrderRequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(orderPayload),
  });
  const order = await orderResponse.json();
  if (!orderResponse.ok || order.error) {
    console.error("PesaPal error:", order);
    return json({ error: order.error?.message || "Failed to create PesaPal order" }, 400);
  }

  await supabase.from("payment_requests").insert({
    organization_id: membership?.organization_id,
    provider: "pesapal",
    provider_reference: order.order_tracking_id,
    merchant_request_id: merchantReference,
    amount: Number(amount.toFixed(2)),
    currency,
    status: "pending",
    initiated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    metadata: { plan_id: planId, billing_cycle: billingCycle, user_id: user.id, type: "subscription" },
  });

  await supabase.from("audit_logs").insert({
    organization_id: membership?.organization_id || user.id,
    entity_type: "subscription",
    entity_id: planId,
    action: "payment_initiated",
    user_id: user.id,
    changes_summary: `PesaPal payment initiated: ${merchantReference}`,
    new_values: {
      order_tracking_id: order.order_tracking_id,
      merchant_reference: merchantReference,
      plan_id: planId,
      billing_cycle: billingCycle,
    },
  });

  console.log(`Created PesaPal order: ${order.order_tracking_id} for plan ${plan.name}`);
  return json({ success: true, orderTrackingId: order.order_tracking_id, merchantReference, redirectUrl: order.redirect_url });
}

async function handleCallback(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const url = new URL(req.url);
    const orderTrackingId = url.searchParams.get("OrderTrackingId") || url.searchParams.get("orderTrackingId");
    const merchantReference = url.searchParams.get("OrderMerchantReference") || url.searchParams.get("orderMerchantReference");
    const notificationType = url.searchParams.get("OrderNotificationType") || url.searchParams.get("orderNotificationType");

    let body: any = {};
    if (req.method === "POST") {
      try { body = await req.json(); } catch { /* query only */ }
    }

    const trackingId = orderTrackingId || body.OrderTrackingId || body.order_tracking_id;
    const reference = merchantReference || body.OrderMerchantReference || body.merchant_reference;

    console.log("PesaPal callback received:", { trackingId, reference, notificationType });
    if (!trackingId) return json({ error: "Order tracking ID required" }, 400);

    const eventId = `pesapal-${trackingId}`;
    const { data: existingEvent } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("provider", "pesapal")
      .eq("event_id", eventId)
      .maybeSingle();

    if (existingEvent) {
      console.log(`Duplicate PesaPal callback for ${trackingId} — skipping`);
      return json({
        orderNotificationType: notificationType,
        orderTrackingId: trackingId,
        orderMerchantReference: reference,
        status: "already_processed",
      });
    }

    const { data: provider } = await supabase
      .from("platform_payment_providers")
      .select("credentials, is_test_mode")
      .eq("provider", "pesapal")
      .single();
    if (!provider) return json({ error: "PesaPal not configured" }, 400);

    const credentials = provider.credentials as { consumer_key?: string; consumer_secret?: string };
    const accessToken = await getPesaPalToken(credentials.consumer_key!, credentials.consumer_secret!, provider.is_test_mode);
    const baseUrl = provider.is_test_mode ? "https://cybqa.pesapal.com/pesapalv3" : "https://pay.pesapal.com/v3";

    const statusResponse = await fetch(`${baseUrl}/api/Transactions/GetTransactionStatus?orderTrackingId=${trackingId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const status = await statusResponse.json();
    console.log("PesaPal transaction status:", status);

    let processedOrgId: string | null = null;

    if (status.status_code === 1 || status.payment_status_description === "Completed") {
      let organization_id: string | null = null;
      let plan_id: string | null = null;
      let billing_cycle: string | null = null;
      let user_id: string | null = null;
      let paymentAmount: number | null = null;
      let paymentCurrency = "KES";

      const { data: paymentReq } = await supabase
        .from("payment_requests")
        .select("*")
        .eq("provider", "pesapal")
        .eq("provider_reference", trackingId)
        .maybeSingle();

      if (paymentReq) {
        const meta = paymentReq.metadata as { plan_id?: string; billing_cycle?: string; user_id?: string } | null;
        organization_id = paymentReq.organization_id;
        plan_id = meta?.plan_id || null;
        billing_cycle = meta?.billing_cycle || null;
        user_id = meta?.user_id || null;
        paymentAmount = paymentReq.amount;
        paymentCurrency = paymentReq.currency || "KES";
      } else {
        const { data: auditLog } = await supabase
          .from("audit_logs")
          .select("*")
          .eq("action", "payment_initiated")
          .limit(100);

        const matchingLog = auditLog?.find((log: any) => {
          const v = log.new_values as any;
          return v?.order_tracking_id === trackingId;
        });

        if (matchingLog?.new_values) {
          const vals = matchingLog.new_values as any;
          plan_id = vals.plan_id;
          billing_cycle = vals.billing_cycle;
          organization_id = matchingLog.organization_id;
          user_id = matchingLog.user_id;
        }
      }

      if (organization_id && plan_id) {
        processedOrgId = organization_id;
        const amount = paymentAmount || (status.amount ? parseFloat(status.amount) : 0);
        await activateSubscription(supabase, {
          organizationId: organization_id,
          planId: plan_id,
          billingCycle: billing_cycle || "monthly",
          paymentMethod: "pesapal",
          amount,
          currency: paymentCurrency,
          userId: user_id,
          notes: `PesaPal payment. TrackingID: ${trackingId}. Reference: ${reference || "N/A"}`,
        });
      }
    }

    await supabase.from("webhook_events").insert({
      provider: "pesapal",
      event_id: eventId,
      event_type: `ipn_${status.status_code || "unknown"}`,
      organization_id: processedOrgId,
      payload: { trackingId, reference, notificationType, status },
    });

    return json({
      orderNotificationType: notificationType,
      orderTrackingId: trackingId,
      orderMerchantReference: reference,
      status: status.status_code,
    });
  } catch (error) {
    console.error("Error in pesapal/callback:", error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("pesapal");
    const action = idx >= 0 ? segments.slice(idx + 1).join("/") : "";

    switch (action) {
      case "create-order":
        return await handleCreate(req);
      case "callback":
        return await handleCallback(req);
      default:
        return json({ error: "Unknown action", expected: ["create-order", "callback"], received: action }, 404);
    }
  } catch (error) {
    console.error("pesapal router error:", error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

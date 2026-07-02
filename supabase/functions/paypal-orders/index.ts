import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { activateSubscription } from "../_shared/subscriptionUtils.ts";

/**
 * Consolidated PayPal orders function. Routed by JSON body `action`:
 *   { action: "create",  planId, billingCycle, returnUrl?, cancelUrl? }
 *   { action: "capture", orderId }
 *
 * Replaces paypal-create-order + paypal-capture-order. Handler bodies preserved verbatim.
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

async function getPayPalAccessToken(clientId: string, clientSecret: string, isSandbox: boolean): Promise<string> {
  const baseUrl = isSandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
  const auth = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || "Failed to get PayPal access token");
  return data.access_token;
}

async function authenticate(req: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return { ok: false as const, response: json({ error: "Authorization required" }, 401) };
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false as const, response: json({ error: "Invalid authentication" }, 401) };
  return { ok: true as const, user };
}

async function handleCreate(req: Request, body: any): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const a = await authenticate(req, supabase);
  if (!a.ok) return a.response;
  const user = a.user;

  const { planId, billingCycle, returnUrl, cancelUrl } = body;
  if (!planId || !billingCycle) return json({ error: "Plan ID and billing cycle required" }, 400);

  const { data: provider, error: providerError } = await supabase
    .from("platform_payment_providers")
    .select("credentials, is_test_mode, is_enabled")
    .eq("provider", "paypal")
    .single();

  if (providerError || !provider || !provider.is_enabled)
    return json({ error: "PayPal is not configured or enabled" }, 400);

  const credentials = provider.credentials as { client_id?: string; client_secret?: string };
  if (!credentials?.client_id || !credentials?.client_secret)
    return json({ error: "PayPal credentials not configured" }, 400);

  const { data: plan, error: planError } = await supabase
    .from("platform_subscription_plans")
    .select("*")
    .eq("id", planId)
    .single();
  if (planError || !plan) return json({ error: "Plan not found" }, 404);

  const currency = plan.currency?.toUpperCase() || "USD";

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

  const basePrice = billingCycle === "yearly" ? plan.price_yearly : plan.price_monthly;
  const perUserPrice = billingCycle === "yearly"
    ? (plan.price_per_user_yearly || 0)
    : (plan.price_per_user_monthly || 0);
  const amount = basePrice + (userCount * perUserPrice);

  const accessToken = await getPayPalAccessToken(credentials.client_id, credentials.client_secret, provider.is_test_mode);
  const baseUrl = provider.is_test_mode ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";

  const orderResponse = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: planId,
        description: `${plan.name} Plan - ${billingCycle}`,
        custom_id: JSON.stringify({
          user_id: user.id,
          organization_id: membership?.organization_id,
          plan_id: planId,
          billing_cycle: billingCycle,
        }),
        amount: { currency_code: currency, value: amount.toFixed(2) },
      }],
      application_context: {
        brand_name: "AccrualFlow",
        landing_page: "LOGIN",
        user_action: "PAY_NOW",
        return_url: returnUrl || `https://accrualflow.systems/upgrade/success`,
        cancel_url: cancelUrl || `https://accrualflow.systems/upgrade`,
      },
    }),
  });

  const order = await orderResponse.json();
  if (!orderResponse.ok) {
    console.error("PayPal error:", order);
    return json({ error: order.message || "Failed to create PayPal order" }, 400);
  }

  const approveLink = order.links?.find((link: any) => link.rel === "approve");
  console.log(`Created PayPal order: ${order.id} for plan ${plan.name}`);

  return json({ success: true, orderId: order.id, approvalUrl: approveLink?.href });
}

async function handleCapture(req: Request, body: any): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const a = await authenticate(req, supabase);
  if (!a.ok) return a.response;
  const user = a.user;

  const { orderId } = body;
  if (!orderId) return json({ error: "Order ID required" }, 400);

  const eventId = `paypal-capture-${orderId}`;
  const { data: existingEvent } = await supabase
    .from("webhook_events")
    .select("id")
    .eq("provider", "paypal")
    .eq("event_id", eventId)
    .maybeSingle();

  if (existingEvent) {
    console.log(`Duplicate PayPal capture for ${orderId} — skipping`);
    return json({ success: true, orderId, status: "COMPLETED", duplicate: true });
  }

  const { data: provider } = await supabase
    .from("platform_payment_providers")
    .select("credentials, is_test_mode, is_enabled")
    .eq("provider", "paypal")
    .single();

  if (!provider || !provider.is_enabled) return json({ error: "PayPal is not configured or enabled" }, 400);

  const credentials = provider.credentials as { client_id?: string; client_secret?: string };
  if (!credentials?.client_id || !credentials?.client_secret)
    return json({ error: "PayPal credentials not configured" }, 400);

  const accessToken = await getPayPalAccessToken(credentials.client_id, credentials.client_secret, provider.is_test_mode);
  const baseUrl = provider.is_test_mode ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";

  const captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });

  const captureData = await captureResponse.json();
  if (!captureResponse.ok) {
    console.error("PayPal capture error:", captureData);
    return json({ error: captureData.message || "Failed to capture PayPal order" }, 400);
  }

  const purchaseUnit = captureData.purchase_units?.[0];
  let metadata: any = {};
  try {
    metadata = JSON.parse(purchaseUnit?.payments?.captures?.[0]?.custom_id || purchaseUnit?.custom_id || "{}");
  } catch {
    console.log("Could not parse metadata");
  }

  const { organization_id, plan_id, billing_cycle } = metadata;
  let processedOrgId: string | null = null;

  if (organization_id && plan_id) {
    processedOrgId = organization_id;
    const amount = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 0;
    const currency = (captureData.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code || "USD").toUpperCase();

    await activateSubscription(supabase, {
      organizationId: organization_id,
      planId: plan_id,
      billingCycle: billing_cycle || "monthly",
      paymentMethod: "paypal",
      amount: parseFloat(amount),
      currency,
      userId: user.id,
      notes: `PayPal order ${captureData.id}`,
    });
  }

  await supabase.from("webhook_events").insert({
    provider: "paypal",
    event_id: eventId,
    event_type: "order_captured",
    organization_id: processedOrgId,
    payload: captureData,
  });

  return json({ success: true, orderId: captureData.id, status: captureData.status });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const action = (body?.action || "").toString();

    switch (action) {
      case "create":
        return await handleCreate(req, body);
      case "capture":
        return await handleCapture(req, body);
      default:
        return json({ error: "Unknown action", expected: ["create", "capture"], received: action }, 400);
    }
  } catch (error) {
    console.error("paypal-orders router error:", error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

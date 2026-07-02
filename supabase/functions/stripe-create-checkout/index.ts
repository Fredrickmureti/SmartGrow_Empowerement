import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify authentication
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid authentication" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { planId, billingCycle, successUrl, cancelUrl } = await req.json();

    if (!planId || !billingCycle) {
      return new Response(
        JSON.stringify({ error: "Plan ID and billing cycle required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Stripe credentials from platform_payment_providers
    const { data: provider, error: providerError } = await supabase
      .from("platform_payment_providers")
      .select("credentials, is_test_mode, is_enabled")
      .eq("provider", "stripe")
      .single();

    if (providerError || !provider || !provider.is_enabled) {
      return new Response(
        JSON.stringify({ error: "Stripe is not configured or enabled" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const credentials = provider.credentials as { secret_key?: string; publishable_key?: string };
    if (!credentials?.secret_key) {
      return new Response(
        JSON.stringify({ error: "Stripe credentials not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get plan details
    const { data: plan, error: planError } = await supabase
      .from("platform_subscription_plans")
      .select("*")
      .eq("id", planId)
      .single();

    if (planError || !plan) {
      return new Response(
        JSON.stringify({ error: "Plan not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const currency = plan.currency?.toLowerCase() || "usd";

    // Get user's organization
    const { data: membership } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .limit(1)
      .single();

    // Calculate per-user billing: base_price + (user_count * per_user_price)
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

    // Create Stripe checkout session using fetch
    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${credentials.secret_key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "mode": "subscription",
        "payment_method_types[0]": "card",
        "line_items[0][price_data][currency]": currency,
        "line_items[0][price_data][product_data][name]": `${plan.name} Plan`,
        "line_items[0][price_data][product_data][description]": plan.description || "",
        "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
        "line_items[0][price_data][recurring][interval]": billingCycle === "yearly" ? "year" : "month",
        "line_items[0][quantity]": "1",
        "success_url": successUrl || `https://accrualflow.systems/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
        "cancel_url": cancelUrl || `https://accrualflow.systems/upgrade`,
        "customer_email": user.email || "",
        "metadata[user_id]": user.id,
        "metadata[organization_id]": membership?.organization_id || "",
        "metadata[plan_id]": planId,
        "metadata[billing_cycle]": billingCycle,
      }).toString(),
    });

    const session = await stripeResponse.json();

    if (!stripeResponse.ok) {
      console.error("Stripe error:", session);
      return new Response(
        JSON.stringify({ error: session.error?.message || "Failed to create checkout session" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Created Stripe checkout session: ${session.id} for plan ${plan.name}`);

    return new Response(
      JSON.stringify({
        success: true,
        sessionId: session.id,
        url: session.url,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in stripe-create-checkout:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

/**
 * M-Pesa Outbound Gateway — consolidated edge function.
 *
 * Replaces three separate edge functions (`mpesa-stk-push`, `mpesa-query`,
 * `mpesa-simulate-callback`) behind a single dispatcher to reduce edge-function
 * count.
 *
 * NOTE: Inbound callback functions (`mpesa-callback`, `mpesa-c2b-confirmation`,
 * `mpesa-c2b-validation`, `mpesa-subscription-callback`) are intentionally NOT
 * consolidated — their URLs are registered with Safaricom externally and
 * renaming them would break in-flight payment flows.
 *
 * Action is selected via `?action=` query param OR `action` field in the JSON body.
 *
 * Actions:
 *   - stk_push         → initiate an STK push to a customer phone
 *   - query            → query the status of an STK push
 *   - simulate_callback → sandbox-only: simulate a callback to test flows
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface MpesaConfig {
  consumer_key: string;
  consumer_secret: string;
  business_short_code: string;
  passkey: string;
  account_reference?: string;
  transaction_type: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
}

type SimulationScenario = "success" | "cancelled" | "failed" | "timeout";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getMpesaEnv(supabase: any) {
  const { data: platformSettings } = await supabase
    .from("platform_settings")
    .select("setting_value")
    .eq("setting_key", "mpesa_environment")
    .single();
  const platformEnvironment = platformSettings?.setting_value || "production";
  const usesSandbox = platformEnvironment === "sandbox";
  const baseUrl = usesSandbox ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";
  return { platformEnvironment, usesSandbox, baseUrl };
}

// ───────────────────────── Action: stk_push ─────────────────────────

async function handleStkPush(supabase: any, supabaseUrl: string, payload: any): Promise<Response> {
  const { organizationId, phoneNumber, amount, posTransactionId, accountReference } = payload;

  if (!organizationId || !phoneNumber || !amount) {
    return jsonResponse({ success: false, error: "Missing required fields" }, 400);
  }

  // Subscription entitlement check
  {
    const { checkSubscriptionActive, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
    const subResult = await checkSubscriptionActive(supabase, organizationId);
    if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);
  }

  const { data: configData, error: configError } = await supabase
    .from("payment_provider_configs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", "mpesa")
    .single();

  if (configError || !configData) {
    return jsonResponse({ success: false, error: "M-Pesa not configured for this organization" }, 400);
  }

  const config = configData.config as MpesaConfig;
  const { usesSandbox, baseUrl, platformEnvironment } = await getMpesaEnv(supabase);
  console.log(`M-Pesa environment: ${platformEnvironment} (platform-controlled)`);

  // OAuth
  const authString = btoa(`${config.consumer_key}:${config.consumer_secret}`);
  const tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${authString}` },
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("OAuth error:", errorText);
    return jsonResponse({ success: false, error: "Failed to authenticate with M-Pesa" }, 500);
  }

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;

  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const password = btoa(`${config.business_short_code}${config.passkey}${timestamp}`);

  // Phone number normalization
  let formattedPhone = phoneNumber.replace(/\s+/g, "").replace(/[^0-9]/g, "");
  if (formattedPhone.startsWith("0")) {
    formattedPhone = "254" + formattedPhone.slice(1);
  } else if (formattedPhone.startsWith("7") && formattedPhone.length === 9) {
    formattedPhone = "254" + formattedPhone;
  } else if (formattedPhone.startsWith("1") && formattedPhone.length === 9) {
    formattedPhone = "254" + formattedPhone;
  } else if (formattedPhone.length === 8 && /^[17]/.test(formattedPhone)) {
    formattedPhone = "2540" + formattedPhone;
  } else if (!formattedPhone.startsWith("254")) {
    formattedPhone = "254" + formattedPhone;
  }

  if (formattedPhone.length !== 12 || !formattedPhone.startsWith("254")) {
    const hint = formattedPhone.startsWith("254")
      ? "Expected format: 2547XXXXXXXXX (12 digits total, 9 digits after 254)."
      : "Expected format: 0712345678 or 254712345678.";
    return jsonResponse(
      { success: false, error: `Invalid phone number format. ${hint} Got: ${formattedPhone} (${formattedPhone.length} digits)` },
      400
    );
  }
  console.log(`Formatted phone: ${formattedPhone} (original: ${phoneNumber})`);

  const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
  const { data: paymentRequest, error: insertError } = await supabase
    .from("payment_requests")
    .insert({
      organization_id: organizationId,
      pos_transaction_id: posTransactionId || null,
      provider: "mpesa",
      amount: amount,
      currency: "KES",
      phone_number: formattedPhone,
      status: "pending",
      expires_at: expiresAt.toISOString(),
      metadata: {
        account_reference: accountReference || config.account_reference || "Payment",
      },
    })
    .select()
    .single();

  if (insertError) {
    console.error("Insert error:", insertError);
    return jsonResponse({ success: false, error: "Failed to create payment request" }, 500);
  }

  // Callback URL still points to the standalone (Safaricom-registered) callback function.
  const callbackUrl = `${supabaseUrl}/functions/v1/mpesa-callback`;
  const transactionType = usesSandbox ? "CustomerPayBillOnline" : config.transaction_type;
  console.log(`Using TransactionType: ${transactionType} (sandbox: ${usesSandbox})`);

  const stkPayload = {
    BusinessShortCode: config.business_short_code,
    Password: password,
    Timestamp: timestamp,
    TransactionType: transactionType,
    Amount: Math.round(amount),
    PartyA: formattedPhone,
    PartyB: config.business_short_code,
    PhoneNumber: formattedPhone,
    CallBackURL: callbackUrl,
    AccountReference: accountReference || config.account_reference || "Payment",
    TransactionDesc: `Payment ${paymentRequest.id.slice(0, 8)}`,
  };

  const stkResponse = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(stkPayload),
  });

  const stkData = await stkResponse.json();

  if (stkData.ResponseCode !== "0") {
    await supabase
      .from("payment_requests")
      .update({
        status: "failed",
        result_code: stkData.ResponseCode,
        result_description: stkData.ResponseDescription || stkData.errorMessage,
      })
      .eq("id", paymentRequest.id);

    return jsonResponse(
      { success: false, error: stkData.ResponseDescription || stkData.errorMessage || "STK push failed" },
      400
    );
  }

  await supabase
    .from("payment_requests")
    .update({
      provider_reference: stkData.CheckoutRequestID,
      merchant_request_id: stkData.MerchantRequestID,
      status: "processing",
    })
    .eq("id", paymentRequest.id);

  const { data: updatedRequest } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("id", paymentRequest.id)
    .single();

  return jsonResponse({
    success: true,
    paymentRequest: updatedRequest,
    checkoutRequestId: stkData.CheckoutRequestID,
    merchantRequestId: stkData.MerchantRequestID,
  });
}

// ───────────────────────── Action: query ─────────────────────────

async function handleQuery(supabase: any, payload: any): Promise<Response> {
  const { organizationId, paymentRequestId } = payload;
  if (!organizationId || !paymentRequestId) {
    return jsonResponse({ success: false, error: "Missing required fields" }, 400);
  }

  const { data: paymentRequest, error: prError } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("id", paymentRequestId)
    .eq("organization_id", organizationId)
    .single();

  if (prError || !paymentRequest) {
    return jsonResponse({ success: false, error: "Payment request not found" }, 404);
  }

  if (["completed", "failed", "cancelled"].includes(paymentRequest.status)) {
    return jsonResponse({ success: true, paymentRequest });
  }

  if (paymentRequest.expires_at && new Date(paymentRequest.expires_at) < new Date()) {
    await supabase
      .from("payment_requests")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", paymentRequestId);

    return jsonResponse({ success: true, paymentRequest: { ...paymentRequest, status: "expired" } });
  }

  const { data: configData, error: configError } = await supabase
    .from("payment_provider_configs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", "mpesa")
    .single();

  if (configError || !configData || !paymentRequest.provider_reference) {
    return jsonResponse({ success: true, paymentRequest });
  }

  const config = configData.config as MpesaConfig;
  const { baseUrl, platformEnvironment } = await getMpesaEnv(supabase);
  console.log(`M-Pesa query environment: ${platformEnvironment} (platform-controlled)`);

  const authString = btoa(`${config.consumer_key}:${config.consumer_secret}`);
  const tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${authString}` },
  });

  if (!tokenResponse.ok) {
    return jsonResponse({ success: true, paymentRequest });
  }

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;

  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const password = btoa(`${config.business_short_code}${config.passkey}${timestamp}`);

  const queryPayload = {
    BusinessShortCode: config.business_short_code,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: paymentRequest.provider_reference,
  };

  const queryResponse = await fetch(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queryPayload),
  });

  const queryData = await queryResponse.json();
  console.log("STK Query response:", queryData);

  let newStatus = paymentRequest.status;
  if (queryData.ResultCode === "0" || queryData.ResultCode === 0) {
    newStatus = "completed";
  } else if (queryData.ResultCode === "1032") {
    newStatus = "cancelled";
  } else if (queryData.ResultCode && queryData.ResultCode !== "1") {
    newStatus = "failed";
  }

  if (newStatus !== paymentRequest.status) {
    const updateData: Record<string, any> = {
      status: newStatus,
      result_code: queryData.ResultCode?.toString(),
      result_description: queryData.ResultDesc,
      updated_at: new Date().toISOString(),
    };
    if (newStatus === "completed") updateData.completed_at = new Date().toISOString();

    await supabase.from("payment_requests").update(updateData).eq("id", paymentRequestId);
  }

  const { data: updatedRequest } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("id", paymentRequestId)
    .single();

  return jsonResponse({ success: true, paymentRequest: updatedRequest });
}

// ───────────────────────── Action: simulate_callback ─────────────────────────

async function handleSimulateCallback(supabase: any, payload: any): Promise<Response> {
  const { paymentRequestId, scenario = "success" } = payload as {
    paymentRequestId: string;
    scenario?: SimulationScenario;
  };

  console.log(`Simulating M-Pesa callback for payment ${paymentRequestId} with scenario: ${scenario}`);

  if (!paymentRequestId) {
    return jsonResponse({ success: false, error: "paymentRequestId is required" }, 400);
  }

  const { data: platformSettings } = await supabase
    .from("platform_settings")
    .select("setting_value")
    .eq("setting_key", "mpesa_environment")
    .single();

  const isSandbox = platformSettings?.setting_value !== "production";
  if (!isSandbox) {
    return jsonResponse({ success: false, error: "Simulation only allowed in sandbox mode" }, 403);
  }

  const { data: paymentRequest, error: fetchError } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("id", paymentRequestId)
    .single();

  if (fetchError || !paymentRequest) {
    return jsonResponse({ success: false, error: "Payment request not found" }, 404);
  }

  if (paymentRequest.status === "completed") {
    return jsonResponse({ success: false, error: "Cannot simulate - payment is already completed" }, 400);
  }

  const now = new Date();
  const transactionDate = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const receiptNumber = `SIM${transactionDate}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  let resultCode: number;
  let resultDesc: string;
  let callbackMetadata: any = null;

  switch (scenario) {
    case "success":
      resultCode = 0;
      resultDesc = "The service request is processed successfully.";
      callbackMetadata = {
        Item: [
          { Name: "Amount", Value: paymentRequest.amount },
          { Name: "MpesaReceiptNumber", Value: receiptNumber },
          { Name: "TransactionDate", Value: transactionDate },
          { Name: "PhoneNumber", Value: paymentRequest.phone_number },
        ],
      };
      break;
    case "cancelled":
      resultCode = 1032;
      resultDesc = "Request cancelled by user.";
      break;
    case "failed":
      resultCode = 1;
      resultDesc = "The balance is insufficient for the transaction.";
      break;
    case "timeout":
      resultCode = 1037;
      resultDesc = "Timeout in completing transaction.";
      break;
    default:
      resultCode = 1;
      resultDesc = "Unknown error.";
  }

  const simulatedPayload = {
    Body: {
      stkCallback: {
        MerchantRequestID: paymentRequest.merchant_request_id || `SIM-${Date.now()}`,
        CheckoutRequestID: paymentRequest.provider_reference,
        ResultCode: resultCode,
        ResultDesc: resultDesc,
        CallbackMetadata: callbackMetadata,
      },
    },
    _simulated: true,
    _simulatedAt: now.toISOString(),
    _scenario: scenario,
  };

  let status: string;
  if (resultCode === 0) status = "completed";
  else if (resultCode === 1032) status = "cancelled";
  else if (resultCode === 1037) status = "expired";
  else status = "failed";

  const updateData: Record<string, any> = {
    status,
    result_code: resultCode.toString(),
    result_description: resultDesc,
    callback_payload: simulatedPayload,
    updated_at: now.toISOString(),
  };

  if (status === "completed") {
    updateData.completed_at = now.toISOString();
    updateData.receipt_number = receiptNumber;
  }

  const { error: updateError } = await supabase
    .from("payment_requests")
    .update(updateData)
    .eq("id", paymentRequest.id);

  if (updateError) {
    console.error("Error updating payment request:", updateError);
    return jsonResponse({ success: false, error: "Failed to update payment request" }, 500);
  }

  if (status === "completed" && paymentRequest.pos_transaction_id) {
    const { data: posTransaction } = await supabase
      .from("pos_transactions")
      .select("*")
      .eq("id", paymentRequest.pos_transaction_id)
      .single();

    if (posTransaction) {
      const { error: paymentInsertError } = await supabase.from("pos_transaction_payments").insert({
        transaction_id: paymentRequest.pos_transaction_id,
        payment_method: "mobile_money",
        amount: paymentRequest.amount,
        reference: receiptNumber,
        status: "completed",
      });

      if (paymentInsertError) {
        console.error("Error inserting pos_transaction_payment:", paymentInsertError);
      }

      const existingPayments = posTransaction.payments || [];
      const newPayment = {
        method: "mobile_money",
        amount: paymentRequest.amount,
        reference: receiptNumber,
        timestamp: now.toISOString(),
        simulated: true,
      };

      await supabase
        .from("pos_transactions")
        .update({
          payments: [...existingPayments, newPayment],
          payment_status: "paid",
          status: "completed",
          updated_at: now.toISOString(),
        })
        .eq("id", paymentRequest.pos_transaction_id);
    }
  }

  console.log(`Simulated callback completed: payment ${paymentRequest.id} -> ${status}`);

  return jsonResponse({
    success: true,
    status,
    receiptNumber: status === "completed" ? receiptNumber : null,
    simulatedPayload,
  });
}

// ───────────────────────── Dispatcher ─────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const url = new URL(req.url);
    const payload = await req.json();
    const action = url.searchParams.get("action") || payload.action || "";

    switch (action) {
      case "stk_push":
        return await handleStkPush(supabase, supabaseUrl, payload);
      case "query":
        return await handleQuery(supabase, payload);
      case "simulate_callback":
        return await handleSimulateCallback(supabase, payload);
      case "subscription_stk":
        return await handleSubscriptionStk(supabase, supabaseUrl, req, payload);
      default:
        return jsonResponse({ success: false, error: `Unknown or missing action: ${action}` }, 400);
    }
  } catch (error: unknown) {
    console.error("[mpesa-outbound] Error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return jsonResponse({ success: false, error: message }, 500);
  }
});

// ───────────────────────── Action: subscription_stk ─────────────────────────
// Initiates an STK push for a platform-level subscription payment using
// `platform_payment_providers` credentials. The callback URL points at the
// consolidated `mpesa-callback?type=subscription` endpoint, which handles
// subscription activation.

async function handleSubscriptionStk(
  supabase: any,
  supabaseUrl: string,
  req: Request,
  payload: any,
): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Authorization required" }, 401);
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: "Invalid authentication" }, 401);
  }

  const { planId, billingCycle, phoneNumber } = payload || {};
  if (!planId || !billingCycle || !phoneNumber) {
    return jsonResponse({ error: "Plan ID, billing cycle, and phone number required" }, 400);
  }

  const { data: provider } = await supabase
    .from("platform_payment_providers")
    .select("credentials, is_test_mode, is_enabled")
    .eq("provider", "mpesa")
    .single();
  if (!provider || !provider.is_enabled) {
    return jsonResponse({ error: "M-Pesa is not configured or enabled" }, 400);
  }
  const credentials = provider.credentials as {
    consumer_key?: string;
    consumer_secret?: string;
    passkey?: string;
    business_short_code?: string;
  };
  if (!credentials?.consumer_key || !credentials?.consumer_secret || !credentials?.passkey || !credentials?.business_short_code) {
    return jsonResponse({ error: "M-Pesa credentials not fully configured" }, 400);
  }

  const { data: plan } = await supabase
    .from("platform_subscription_plans")
    .select("*")
    .eq("id", planId)
    .single();
  if (!plan) return jsonResponse({ error: "Plan not found" }, 404);

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
    ? (plan.price_yearly_kes || plan.price_yearly * 130)
    : (plan.price_monthly_kes || plan.price_monthly * 130);
  const perUserPriceKes = billingCycle === "yearly"
    ? ((plan.price_per_user_yearly || 0) * 130)
    : ((plan.price_per_user_monthly || 0) * 130);
  const amount = Math.ceil(basePrice + (userCount * perUserPriceKes));

  const { baseUrl } = await getMpesaEnv(supabase);

  const auth = btoa(`${credentials.consumer_key}:${credentials.consumer_secret}`);
  const tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error("Failed to get M-Pesa token");
  const accessToken = tokenData.access_token;

  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const password = btoa(`${credentials.business_short_code}${credentials.passkey}${timestamp}`);
  const formattedPhone = phoneNumber.replace(/^0/, "254").replace(/^\+/, "");

  const { data: paymentRequest, error: insertError } = await supabase
    .from("payment_requests")
    .insert({
      organization_id: membership?.organization_id,
      provider: "mpesa",
      amount,
      currency: "KES",
      phone_number: formattedPhone,
      status: "pending",
      initiated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      metadata: {
        plan_id: planId,
        billing_cycle: billingCycle,
        user_id: user.id,
        type: "subscription",
      },
    })
    .select()
    .single();
  if (insertError) throw insertError;

  const stkPayload = {
    BusinessShortCode: credentials.business_short_code,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: formattedPhone,
    PartyB: credentials.business_short_code,
    PhoneNumber: formattedPhone,
    CallBackURL: `${supabaseUrl}/functions/v1/mpesa-callback?type=subscription`,
    AccountReference: `SUB-${planId.slice(0, 8)}`,
    TransactionDesc: `${plan.name} subscription`,
  };

  const stkResponse = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(stkPayload),
  });
  const stkResult = await stkResponse.json();

  if (!stkResponse.ok || stkResult.ResponseCode !== "0") {
    await supabase
      .from("payment_requests")
      .update({ status: "failed", result_description: stkResult.ResponseDescription })
      .eq("id", paymentRequest.id);
    return jsonResponse({ error: stkResult.ResponseDescription || "STK push failed" }, 400);
  }

  await supabase
    .from("payment_requests")
    .update({
      provider_reference: stkResult.CheckoutRequestID,
      merchant_request_id: stkResult.MerchantRequestID,
      status: "processing",
    })
    .eq("id", paymentRequest.id);

  return jsonResponse({
    success: true,
    paymentRequestId: paymentRequest.id,
    checkoutRequestId: stkResult.CheckoutRequestID,
    message: "Check your phone for M-Pesa prompt",
  });
}

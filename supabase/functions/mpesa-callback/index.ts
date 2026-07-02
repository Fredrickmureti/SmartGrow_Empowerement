import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateMpesaCallback } from "../_shared/verifyMpesaCallback.ts";
import { activateSubscription } from "../_shared/subscriptionUtils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Route: subscription callbacks come in as ?type=subscription and are
    // authenticated via the platform-level STK push CheckoutRequestID lookup
    // (no per-tenant ?key=). Tenant callbacks require the per-org callback
    // secret as ?key=.
    const url = new URL(req.url);
    const isSubscription = url.searchParams.get("type") === "subscription";

    if (isSubscription) {
      const body = await req.json();
      return await handleSubscriptionCallback(supabase, body);
    }

    const auth = await authenticateMpesaCallback(req, supabase, "mpesa");
    if (!auth.ok) return auth.response;
    const callerOrgId = auth.ctx.organizationId;

    const body = await req.json();
    console.log("M-Pesa callback received for org:", callerOrgId);


    // M-Pesa callback structure
    const stkCallback = body.Body?.stkCallback;
    if (!stkCallback) {
      console.error("Invalid callback structure");
      return new Response(
        JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = stkCallback;

    // Find the payment request by CheckoutRequestID — scoped to the
    // authenticated tenant so a leaked secret can only affect its own org.
    const { data: paymentRequest, error: findError } = await supabase
      .from("payment_requests")
      .select("*")
      .eq("provider_reference", CheckoutRequestID)
      .eq("organization_id", callerOrgId)
      .single();


    if (findError || !paymentRequest) {
      console.error("Payment request not found:", CheckoutRequestID);
      return new Response(
        JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Subscription entitlement check ───
    // Suspended/expired orgs must not have payments posted to their books.
    // We still ACK (200) to M-Pesa so they don't keep retrying.
    if (paymentRequest.organization_id) {
      const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");
      const subResult = await checkSubscriptionActive(supabase, paymentRequest.organization_id);
      if (!subResult.allowed) {
        console.warn(`[mpesa-callback] Skipping post for ${paymentRequest.id}: ${subResult.reason}`);
        return new Response(
          JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Parse callback metadata
    let receiptNumber = null;
    let transactionDate = null;
    let phoneNumber = null;
    let amount = null;

    if (CallbackMetadata?.Item) {
      for (const item of CallbackMetadata.Item) {
        switch (item.Name) {
          case "MpesaReceiptNumber":
            receiptNumber = item.Value;
            break;
          case "TransactionDate":
            transactionDate = item.Value;
            break;
          case "PhoneNumber":
            phoneNumber = item.Value?.toString();
            break;
          case "Amount":
            amount = item.Value;
            break;
        }
      }
    }

    // Determine status based on ResultCode
    // 0 = Success, 1032 = Cancelled by user, 1 = Insufficient balance, etc.
    let status: string;
    if (ResultCode === 0 || ResultCode === "0") {
      status = "completed";
    } else if (ResultCode === 1032 || ResultCode === "1032") {
      status = "cancelled";
    } else {
      status = "failed";
    }

    // Update payment request
    const updateData: Record<string, any> = {
      status,
      result_code: ResultCode?.toString(),
      result_description: ResultDesc,
      callback_payload: body,
      updated_at: new Date().toISOString(),
    };

    if (status === "completed") {
      updateData.completed_at = new Date().toISOString();
      updateData.receipt_number = receiptNumber;
    }

    const { error: updateError } = await supabase
      .from("payment_requests")
      .update(updateData)
      .eq("id", paymentRequest.id);

    if (updateError) {
      console.error("Error updating payment request:", updateError);
    }

    // If payment is successful and linked to a POS transaction, update the transaction
    if (status === "completed" && paymentRequest.pos_transaction_id) {
      // Get POS transaction to find organization_id
      const { data: posTransaction } = await supabase
        .from("pos_transactions")
        .select("*")
        .eq("id", paymentRequest.pos_transaction_id)
        .single();

      if (posTransaction) {
        // Insert payment into pos_transaction_payments table (to satisfy constraint with mobile_money)
        const { error: paymentInsertError } = await supabase
          .from("pos_transaction_payments")
          .insert({
            transaction_id: paymentRequest.pos_transaction_id,
            payment_method: "mobile_money", // Use mobile_money to match constraint
            amount: paymentRequest.amount,
            reference: receiptNumber, // M-Pesa receipt number
            status: "completed",
          });

        if (paymentInsertError) {
          console.error("Error inserting pos_transaction_payment:", paymentInsertError);
        }

        // Also update the JSON payments array for backward compatibility
        const existingPayments = posTransaction.payments || [];
        const newPayment = {
          method: "mobile_money",
          amount: paymentRequest.amount,
          reference: receiptNumber,
          timestamp: new Date().toISOString(),
        };

        await supabase
          .from("pos_transactions")
          .update({
            payments: [...existingPayments, newPayment],
            payment_status: "paid",
            status: "completed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", paymentRequest.pos_transaction_id);
      }
    }

    console.log(`Payment ${paymentRequest.id} updated to status: ${status}`);

    // Return success response to M-Pesa
    return new Response(
      JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in mpesa-callback:", error);
    // Always return success to M-Pesa to avoid retries
    return new Response(
      JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ───────────────────────── Subscription callback path ─────────────────────────

async function handleSubscriptionCallback(supabase: any, body: any): Promise<Response> {
  try {
    console.log("M-Pesa subscription callback received");
    const stkCallback = body.Body?.stkCallback;
    if (!stkCallback) {
      return new Response(
        JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

    // Idempotency
    const eventId = `mpesa-sub-${CheckoutRequestID}`;
    const { data: existingEvent } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("provider", "mpesa")
      .eq("event_id", eventId)
      .maybeSingle();
    if (existingEvent) {
      return new Response(
        JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: paymentRequest, error: findError } = await supabase
      .from("payment_requests")
      .select("*")
      .eq("provider_reference", CheckoutRequestID)
      .single();
    if (findError || !paymentRequest) {
      return new Response(
        JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let receiptNumber: string | null = null;
    if (CallbackMetadata?.Item) {
      for (const item of CallbackMetadata.Item) {
        if (item.Name === "MpesaReceiptNumber") {
          receiptNumber = item.Value;
          break;
        }
      }
    }

    let status: string;
    if (ResultCode === 0 || ResultCode === "0") status = "completed";
    else if (ResultCode === 1032 || ResultCode === "1032") status = "cancelled";
    else status = "failed";

    const updateData: Record<string, any> = {
      status,
      result_code: ResultCode?.toString(),
      result_description: ResultDesc,
      callback_payload: body,
      updated_at: new Date().toISOString(),
    };
    if (status === "completed") {
      updateData.completed_at = new Date().toISOString();
      updateData.receipt_number = receiptNumber;
    }
    await supabase.from("payment_requests").update(updateData).eq("id", paymentRequest.id);

    if (status === "completed") {
      const metadata = paymentRequest.metadata as { plan_id?: string; billing_cycle?: string; user_id?: string };
      const { plan_id, billing_cycle, user_id } = metadata || {};
      if (paymentRequest.organization_id && plan_id) {
        await activateSubscription(supabase, {
          organizationId: paymentRequest.organization_id,
          planId: plan_id,
          billingCycle: billing_cycle || "monthly",
          paymentMethod: "mpesa",
          amount: paymentRequest.amount,
          currency: paymentRequest.currency || "KES",
          userId: user_id,
          notes: `M-Pesa payment. Receipt: ${receiptNumber}. CheckoutRequestID: ${CheckoutRequestID}`,
        });
      }
    }

    await supabase.from("webhook_events").insert({
      provider: "mpesa",
      event_id: eventId,
      event_type: `stk_callback_${status}`,
      organization_id: paymentRequest.organization_id,
      payload: body,
    });

    return new Response(
      JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error in mpesa-callback (subscription):", error);
    return new Response(
      JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
}

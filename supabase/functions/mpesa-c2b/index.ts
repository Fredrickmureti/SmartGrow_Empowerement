import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateMpesaCallback } from "../_shared/verifyMpesaCallback.ts";

/**
 * Consolidated M-Pesa C2B function. Routed by URL path suffix:
 *   POST /functions/v1/mpesa-c2b/register      → register C2B callback URLs with Safaricom (auth required)
 *   POST /functions/v1/mpesa-c2b/validation    → Safaricom validation webhook
 *   POST /functions/v1/mpesa-c2b/confirmation  → Safaricom confirmation webhook
 *
 * Replaces the previous three separate functions (mpesa-c2b-register,
 * mpesa-c2b-validation, mpesa-c2b-confirmation) to stay within the platform
 * edge-function slot cap. Handler bodies preserved verbatim — no behaviour change.
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

// ──────────────────────────────────────────────────────────────────────
// /register — register C2B validation + confirmation URLs with Safaricom
// ──────────────────────────────────────────────────────────────────────
async function handleRegister(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const authHeader = req.headers.get("authorization");
  if (!authHeader) return json({ error: "Authorization required" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ error: "Invalid authentication" }, 401);

  const { organizationId, businessId } = await req.json();
  if (!organizationId) return json({ error: "Organization ID required" }, 400);
  if (businessId) {
    console.log(`mpesa-c2b/register invoked for org=${organizationId} business=${businessId}`);
  }

  const { data: config, error: configError } = await supabase
    .from("payment_provider_configs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", "mpesa_c2b")
    .single();

  if (configError || !config) return json({ error: "M-Pesa C2B not configured" }, 400);

  const c2bConfig = config.config as {
    consumer_key: string;
    consumer_secret: string;
    business_short_code: string;
    response_type?: string;
  };

  const { data: platformSettings } = await supabase
    .from("platform_settings")
    .select("setting_value")
    .eq("setting_key", "mpesa_environment")
    .single();

  const platformEnvironment = platformSettings?.setting_value || "production";
  const usesSandbox = platformEnvironment === "sandbox";
  console.log(`M-Pesa C2B environment: ${platformEnvironment} (platform-controlled)`);

  const baseUrl = usesSandbox ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";

  const auth = btoa(`${c2bConfig.consumer_key}:${c2bConfig.consumer_secret}`);
  const tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("OAuth error:", errorText);
    return json({ error: "Failed to authenticate with M-Pesa", details: errorText }, 500);
  }

  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;

  // NEW canonical callback URLs (post-consolidation).
  const validationUrl = `${supabaseUrl}/functions/v1/mpesa-c2b/validation`;
  const confirmationUrl = `${supabaseUrl}/functions/v1/mpesa-c2b/confirmation`;

  const registerPayload = {
    ShortCode: c2bConfig.business_short_code,
    ResponseType: c2bConfig.response_type || "Completed",
    ConfirmationURL: confirmationUrl,
    ValidationURL: validationUrl,
  };
  console.log("Registering C2B URLs:", registerPayload);

  const registerResponse = await fetch(`${baseUrl}/mpesa/c2b/v1/registerurl`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(registerPayload),
  });
  const registerResult = await registerResponse.json();
  console.log("C2B Registration response:", registerResult);

  if (!registerResponse.ok || registerResult.ResponseCode !== "0") {
    await supabase
      .from("payment_provider_configs")
      .update({
        test_result: "failed",
        test_error: registerResult.ResponseDescription || "Registration failed",
        last_tested_at: new Date().toISOString(),
      })
      .eq("id", config.id);
    return json({ error: "C2B URL registration failed", details: registerResult }, 400);
  }

  await supabase
    .from("payment_provider_configs")
    .update({
      callback_url: confirmationUrl,
      test_result: "success",
      test_error: null,
      last_tested_at: new Date().toISOString(),
      config: {
        ...c2bConfig,
        validation_url: validationUrl,
        confirmation_url: confirmationUrl,
        registered_at: new Date().toISOString(),
      },
    })
    .eq("id", config.id);

  return json({ success: true, message: "C2B URLs registered successfully", validationUrl, confirmationUrl });
}

// ──────────────────────────────────────────────────────────────────────
// /validation — Safaricom validation webhook
// ──────────────────────────────────────────────────────────────────────
async function handleValidation(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const auth = await authenticateMpesaCallback(req, supabase, "mpesa_c2b");
    if (!auth.ok) return auth.response;
    const matchingConfig = { config: auth.ctx.config, organization_id: auth.ctx.organizationId };

    const body = await req.json();
    console.log("M-Pesa C2B Validation received for org:", auth.ctx.organizationId);

    const { TransID, TransAmount, BusinessShortCode, BillRefNumber, MSISDN } = body;

    const configuredShortCode = (auth.ctx.config as { business_short_code?: string }).business_short_code;
    if (configuredShortCode && BusinessShortCode && configuredShortCode !== BusinessShortCode) {
      console.warn("[mpesa-c2b/validation] short code mismatch", { configuredShortCode, BusinessShortCode });
      return json({ ResultCode: 1, ResultDesc: "Short code mismatch" }, 401);
    }

    if (BillRefNumber) {
      // BillRefNumber is the loan reference (or the client reference). We only
      // log mismatches here — validation must never reject a genuine payment.
      const { data: loan } = await supabase
        .from("mf_loans")
        .select("id, loan_number, status")
        .eq("loan_number", BillRefNumber)
        .maybeSingle();

      if (!loan) {
        console.log(`[mpesa-c2b/validation] no exact loan for BillRef ${BillRefNumber}`);
      } else if (loan.status !== "active" && loan.status !== "disbursed") {
        console.log(`[mpesa-c2b/validation] loan ${loan.loan_number} is ${loan.status}`);
      }
      console.log(`Validation amount ${TransAmount} for BillRef ${BillRefNumber}`);
    }


    console.log(`Validated C2B transaction: ${TransID} for ${TransAmount} from ${MSISDN}`);
    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    console.error("Error in mpesa-c2b/validation:", error);
    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
}

// ──────────────────────────────────────────────────────────────────────
// /confirmation — Safaricom confirmation webhook
// ──────────────────────────────────────────────────────────────────────
async function handleConfirmation(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const auth = await authenticateMpesaCallback(req, supabase, "mpesa_c2b");
    if (!auth.ok) return auth.response;
    const organizationId = auth.ctx.organizationId;

    const body = await req.json();
    console.log("M-Pesa C2B Confirmation received for org:", organizationId);

    const {
      TransactionType, TransID, TransTime, TransAmount, BusinessShortCode,
      BillRefNumber, OrgAccountBalance, ThirdPartyTransID, MSISDN,
      FirstName, MiddleName, LastName,
    } = body;

    const configuredShortCode = (auth.ctx.config as { business_short_code?: string }).business_short_code;
    if (configuredShortCode && BusinessShortCode && configuredShortCode !== BusinessShortCode) {
      console.warn("[mpesa-c2b/confirmation] short code mismatch", { configuredShortCode, BusinessShortCode });
      return json({ ResultCode: 1, ResultDesc: "Short code mismatch" }, 401);
    }

    {
      const { checkSubscriptionActive } = await import("../_shared/entitlementCheck.ts");
      const subResult = await checkSubscriptionActive(supabase, organizationId);
      if (!subResult.allowed) {
        console.warn(`[mpesa-c2b/confirmation] Skipping booking for org ${organizationId}: ${subResult.reason}`);
        return json({ ResultCode: 0, ResultDesc: "Accepted" });
      }
    }

    let transTime: Date;
    try {
      const y = TransTime.substring(0, 4), m = TransTime.substring(4, 6), d = TransTime.substring(6, 8);
      const h = TransTime.substring(8, 10), mi = TransTime.substring(10, 12), s = TransTime.substring(12, 14);
      transTime = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}+03:00`);
    } catch {
      transTime = new Date();
    }

    const maskedMsisdn = MSISDN ? MSISDN.substring(0, 6) + "****" + MSISDN.substring(MSISDN.length - 2) : null;
    // PayBill-only institution: collections are received on the PayBill
    // short code. Till is not part of this operating model.
    const transactionType = "paybill";
    if (TransactionType && !`${TransactionType}`.toLowerCase().replace(/\s+/g, "").includes("paybill")) {
      console.warn(`[mpesa-c2b/confirmation] unexpected transaction type: ${TransactionType}`);
    }


    // ── Match the receipt to a loan ────────────────────────────────────
    // Kenyan PayBill practice: the account/reference field carries the loan
    // reference, or failing that the client reference. We never guess by
    // amount — an unmatched receipt goes to the unmatched-receipts queue.
    let matchedLoanId: string | null = null;
    let matchedClientId: string | null = null;
    let matchReason: string | null = null;

    const { data: orgBusinesses } = await supabase
      .from("businesses")
      .select("id")
      .eq("organization_id", organizationId);
    const businessIds = (orgBusinesses ?? []).map((b: { id: string }) => b.id);

    const ref = typeof BillRefNumber === "string" ? BillRefNumber.trim() : "";

    if (!ref) {
      matchReason = "NO_BILL_REF";
    } else if (businessIds.length === 0) {
      matchReason = "NO_BUSINESS_IN_SCOPE";
    } else {
      const OPEN_STATUSES = ["active", "disbursed", "in_arrears", "overdue"];

      const { data: loan } = await supabase
        .from("mf_loans")
        .select("id, client_id, loan_number, status")
        .in("business_id", businessIds)
        .eq("loan_number", ref)
        .maybeSingle();

      if (loan) {
        matchedLoanId = loan.id;
        matchedClientId = loan.client_id;
        matchReason = "AUTO_LOAN_REF";
      } else {
        // Client reference: settle only when the client has exactly one open loan.
        const { data: client } = await supabase
          .from("mf_clients")
          .select("id")
          .in("business_id", businessIds)
          .eq("client_number", ref)
          .maybeSingle();

        if (!client) {
          matchReason = "NO_MATCH_FOR_REF";
        } else {
          matchedClientId = client.id;
          const { data: openLoans } = await supabase
            .from("mf_loans")
            .select("id")
            .eq("client_id", client.id)
            .in("status", OPEN_STATUSES)
            .limit(5);

          if ((openLoans ?? []).length === 1) {
            matchedLoanId = openLoans![0].id;
            matchReason = "AUTO_CLIENT_REF";
          } else if ((openLoans ?? []).length > 1) {
            matchReason = "AMBIGUOUS_CLIENT_LOANS";
          } else {
            matchReason = "CLIENT_HAS_NO_OPEN_LOAN";
          }
        }
      }
    }


    const { data: insertedTx, error: insertError } = await supabase
      .from("mpesa_c2b_transactions")
      .insert({
        organization_id: organizationId,
        transaction_type: transactionType,
        trans_id: TransID,
        trans_time: transTime.toISOString(),
        trans_amount: parseFloat(TransAmount),
        business_short_code: BusinessShortCode,
        bill_ref_number: BillRefNumber || null,
        org_account_balance: OrgAccountBalance ? parseFloat(OrgAccountBalance) : null,
        third_party_trans_id: ThirdPartyTransID || null,
        msisdn: maskedMsisdn,
        first_name: FirstName || null,
        middle_name: MiddleName || null,
        last_name: LastName || null,
        matched_loan_id: matchedLoanId,
        matched_client_id: matchedClientId,
        matched_contact_id: null,
        is_reconciled: false,
        reconciled_at: null,

        match_reason: matchReason,
        raw_payload: body,
      })
      .select()
      .single();

    const isDuplicate = insertError?.code === "23505";
    if (insertError && !isDuplicate) {
      console.error("Error inserting C2B transaction:", insertError);
    } else {
      if (isDuplicate) {
        // Safaricom redelivers C2B callbacks. The ledger row already exists,
        // but settlement may have failed on the first delivery, so we must
        // still attempt it. Every downstream write below is idempotent.
        console.log("Duplicate C2B delivery — re-attempting settlement:", TransID);
      } else {
        console.log("C2B transaction stored:", insertedTx?.id);
      }

      if (matchedLoanId) {
        // Inbound PayBill settlement goes through the single canonical
        // lending settlement engine (mf_record_repayment), which writes the
        // repayment, allocates it across the schedule and posts the GL leg
        // atomically. A webhook must never write settlement tables directly.
        //
        // Idempotency: one M-Pesa TransID can only ever produce one
        // repayment, no matter how many times Safaricom redelivers.
        const { data: existing } = await supabase
          .from("mf_repayments")
          .select("id")
          .eq("loan_id", matchedLoanId)
          .eq("reference", TransID)
          .maybeSingle();

        if (existing) {
          console.log("C2B repayment already recorded, skipping:", TransID);
          await supabase
            .from("mpesa_c2b_transactions")
            .update({
              is_reconciled: true,
              reconciled_at: new Date().toISOString(),
              matched_repayment_id: existing.id,
              match_reason: matchReason,
            })
            .eq("organization_id", organizationId)
            .eq("trans_id", TransID);
        } else {
          const { data: repaymentId, error: settleError } = await supabase.rpc(
            "mf_record_repayment",
            {
              p_loan_id: matchedLoanId,
              p_paid_on: transTime.toISOString().split("T")[0],
              p_amount: parseFloat(TransAmount),
              p_method: "mpesa",
              p_reference: TransID,
              p_batch_id: null,
              p_notes:
                `M-Pesa PayBill payment from ${FirstName || ""} ${LastName || ""} (${maskedMsisdn})`
                  .trim(),
            } as any,
          );

          if (settleError) {
            // Cash arrived but could not be posted. Leave the row unreconciled
            // and flagged so it surfaces in the unmatched-receipts queue rather
            // than being silently swallowed.
            console.error("Error recording C2B loan repayment:", settleError);
            await supabase
              .from("mpesa_c2b_transactions")
              .update({
                is_reconciled: false,
                reconciled_at: null,
                match_reason: "SETTLEMENT_FAILED",
              })
              .eq("organization_id", organizationId)
              .eq("trans_id", TransID);
          } else {
            await supabase
              .from("mpesa_c2b_transactions")
              .update({
                is_reconciled: true,
                reconciled_at: new Date().toISOString(),
                matched_repayment_id: (repaymentId as string | null) ?? null,
                match_reason: matchReason,
              })
              .eq("organization_id", organizationId)
              .eq("trans_id", TransID);
          }
        }
      }

    }


    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    console.error("Error in mpesa-c2b/confirmation:", error);
    return json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Router
// ──────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    // Path is /functions/v1/mpesa-c2b/<action>. Strip the function prefix.
    const segments = url.pathname.split("/").filter(Boolean);
    // Find the segment after "mpesa-c2b"
    const idx = segments.indexOf("mpesa-c2b");
    const action = idx >= 0 ? segments.slice(idx + 1).join("/") : "";

    switch (action) {
      case "register":
        return await handleRegister(req);
      case "validation":
        return await handleValidation(req);
      case "confirmation":
        return await handleConfirmation(req);
      default:
        return json(
          { error: "Unknown action", expected: ["register", "validation", "confirmation"], received: action },
          404
        );
    }
  } catch (error) {
    console.error("mpesa-c2b router error:", error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

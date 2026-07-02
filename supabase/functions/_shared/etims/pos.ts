import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_SANDBOX_URL = "https://etims-api-sbx.kra.go.ke/etims-api";
const DEFAULT_PRODUCTION_URL = "https://etims-api.kra.go.ke/etims-api";

interface EtimsConfig {
  tin: string;
  bhf_id: string;
  communication_key: string;
  device_serial?: string;
}

interface PlatformEtimsSettings {
  enabled: boolean;
  environment: string;
  sandboxUrl: string;
  productionUrl: string;
}

async function getPlatformEtimsSettings(supabase: any): Promise<PlatformEtimsSettings> {
  const { data } = await supabase
    .from("platform_settings")
    .select("setting_key, setting_value")
    .in("setting_key", [
      "etims_enabled",
      "etims_environment",
      "etims_api_sandbox_url",
      "etims_api_production_url",
    ]);

  const settings: Record<string, string> = {};
  (data || []).forEach((s: any) => {
    settings[s.setting_key] = s.setting_value || "";
  });

  return {
    enabled: settings.etims_enabled === "true",
    environment: settings.etims_environment || "sandbox",
    sandboxUrl: settings.etims_api_sandbox_url || DEFAULT_SANDBOX_URL,
    productionUrl: settings.etims_api_production_url || DEFAULT_PRODUCTION_URL,
  };
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const {
      organizationId,
      transactionId,
      transactionNumber,
      customerTin,
      customerName,
      items,
      subtotal,
      taxAmount,
      discountAmount,
      total,
    } = await req.json();

    if (!organizationId || !transactionId) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Subscription entitlement check ───
    const { checkAppEntitlement, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
    const entResult = await checkAppEntitlement(supabase, organizationId, "etims");
    if (!entResult.allowed) return entitlementDeniedResponse(entResult, corsHeaders);

    // Fetch platform eTIMS settings
    const platformSettings = await getPlatformEtimsSettings(supabase);
    
    if (!platformSettings.enabled) {
      // eTIMS not enabled - update transaction status and return
      await supabase
        .from("pos_transactions")
        .update({ etims_status: "not_applicable" })
        .eq("id", transactionId);

      return new Response(
        JSON.stringify({ success: true, status: "not_applicable", message: "eTIMS not enabled" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch the tax compliance config
    const { data: configData, error: configError } = await supabase
      .from("tax_compliance_configs")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("country_code", "KE")
      .eq("provider", "kra_etims")
      .eq("is_active", true)
      .single();

    if (configError || !configData) {
      console.log("eTIMS not configured for organization, skipping transmission");
      await supabase
        .from("pos_transactions")
        .update({ etims_status: "not_configured" })
        .eq("id", transactionId);

      return new Response(
        JSON.stringify({ success: true, status: "not_configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const config = configData.config as EtimsConfig;
    const isTestMode = platformSettings.environment === "sandbox";
    const baseUrl = isTestMode ? platformSettings.sandboxUrl : platformSettings.productionUrl;

    console.log(`Transmitting POS transaction to eTIMS. Mode: ${isTestMode ? 'sandbox' : 'production'}`);

    // Update status to pending
    await supabase
      .from("pos_transactions")
      .update({ etims_status: "pending" })
      .eq("id", transactionId);

    // Format transaction data for eTIMS
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const salesDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    // Prepare items list with eTIMS codes - prefer snapshotted data from transaction items
    const itemsList = await Promise.all(items.map(async (item: any, index: number) => {
      let classificationCode = "5020101";
      let unitCode = "U";
      let pkgCode = "CT";
      // Use snapshotted tax code if available, otherwise fall back to product lookup
      let taxCode = item.etims_tax_code || "A";

      if (item.product_id) {
        const { data: product } = await supabase
          .from("products")
          .select("etims_classification_code, etims_unit_code, etims_packaging_unit, tax_rate_id")
          .eq("id", item.product_id)
          .single();

        if (product) {
          classificationCode = product.etims_classification_code || classificationCode;
          unitCode = product.etims_unit_code || unitCode;
          pkgCode = product.etims_packaging_unit || pkgCode;

          // Only look up tax code from product if not already snapshotted
          if (!item.etims_tax_code && product.tax_rate_id) {
            const { data: taxRate } = await supabase
              .from("tax_rates")
              .select("etims_tax_code")
              .eq("id", product.tax_rate_id)
              .single();
            if (taxRate?.etims_tax_code) {
              taxCode = taxRate.etims_tax_code;
            }
          }
        }
      }

      return {
        itemSeq: index + 1,
        itemCd: item.product_id || `ITEM-${index + 1}`,
        itemClsCd: classificationCode,
        itemNm: item.name,
        bcd: null,
        pkgUnitCd: pkgCode,
        pkg: 1,
        qtyUnitCd: unitCode,
        qty: item.quantity,
        prc: item.unit_price,
        splyAmt: item.line_total,
        dcRt: 0,
        dcAmt: 0,
        isrccCd: null,
        isrccNm: null,
        isrcRt: 0,
        isrcAmt: 0,
        taxTyCd: taxCode,
        taxblAmt: item.line_total - (item.tax_amount || 0),
        taxAmt: item.tax_amount || 0,
        totAmt: item.line_total,
      };
    }));

    // Extract receipt number from transaction number
    const receiptNo = parseInt(transactionNumber.replace(/\D/g, "").slice(-6)) || 1;

    // Prepare eTIMS payload
    const salesPayload = {
      tin: config.tin,
      bhfId: config.bhf_id,
      invcNo: receiptNo,
      orgInvcNo: 0,
      custTin: customerTin || null,
      custNm: customerName || "Walk-in Customer",
      salesTyCd: "N",
      rcptTyCd: "S",
      pmtTyCd: "01",
      salesSttsCd: "02",
      cfmDt: timestamp,
      salesDt: salesDate,
      stockRlsDt: salesDate,
      cnclReqDt: null,
      cnclDt: null,
      rfdDt: null,
      rfdRsnCd: null,
      totItemCnt: items.length,
      taxblAmtA: subtotal || 0,
      taxblAmtB: 0,
      taxblAmtC: 0,
      taxblAmtD: 0,
      taxblAmtE: 0,
      taxRtA: 16,
      taxRtB: 0,
      taxRtC: 0,
      taxRtD: 8,
      taxRtE: 0,
      taxAmtA: taxAmount || 0,
      taxAmtB: 0,
      taxAmtC: 0,
      taxAmtD: 0,
      taxAmtE: 0,
      totTaxblAmt: subtotal || 0,
      totTaxAmt: taxAmount || 0,
      totAmt: total || 0,
      prchrAcptcYn: "N",
      remark: null,
      regrId: "POS",
      regrNm: "POS System",
      modrId: "POS",
      modrNm: "POS System",
      receipt: {
        custTin: customerTin || null,
        custMblNo: null,
        rptNo: 1,
        trdeNm: customerName || "Customer",
        adrs: null,
        topMsg: null,
        btmMsg: "Thank you for your business",
        prchrAcptcYn: "N",
      },
      itemList: itemsList,
    };

    console.log("eTIMS POS payload:", JSON.stringify(salesPayload, null, 2));

    let cuNumber: string;
    let qrCodeUrl: string;
    let responseData: any;

    try {
      const apiResponse = await fetch(`${baseUrl}/saveTrnsSalesOsdc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.communication_key}`,
        },
        body: JSON.stringify(salesPayload),
      });

      const contentType = apiResponse.headers.get("content-type") || "";
      const responseText = await apiResponse.text();

      if (!contentType.includes("application/json")) {
        console.log("Non-JSON response from eTIMS:", responseText.substring(0, 200));
        throw new Error(`eTIMS API returned non-JSON response (${apiResponse.status})`);
      }

      responseData = JSON.parse(responseText);
      console.log("eTIMS API response:", JSON.stringify(responseData));

      if (responseData.resultCd === "000") {
        cuNumber = responseData.data?.rcptSign || `CU-${timestamp}`;
        qrCodeUrl = responseData.data?.qrCodeUrl || `https://etims.kra.go.ke/verify?cu=${cuNumber}`;
      } else {
        throw new Error(responseData.resultMsg || "eTIMS transmission failed");
      }
    } catch (apiError: any) {
      console.log("API call failed:", apiError.message);

      if (isTestMode) {
        // Simulation for sandbox
        cuNumber = `SIM-POS-${timestamp}-${transactionId.slice(0, 8)}`;
        qrCodeUrl = `https://etims-sbx.kra.go.ke/verify?cu=${cuNumber}`;
        responseData = { simulated: true, resultCd: "000" };
      } else {
        // Update transaction with failed status
        const { data: currentTx } = await supabase
          .from("pos_transactions")
          .select("etims_retry_count")
          .eq("id", transactionId)
          .single();
        
        await supabase
          .from("pos_transactions")
          .update({
            etims_status: "failed",
            etims_error_message: apiError.message,
            etims_retry_count: (currentTx?.etims_retry_count || 0) + 1,
          })
          .eq("id", transactionId);

        throw apiError;
      }
    }

    // Update transaction with eTIMS data
    const { error: updateError } = await supabase
      .from("pos_transactions")
      .update({
        etims_cu_number: cuNumber,
        etims_qr_data: qrCodeUrl,
        etims_transmitted_at: new Date().toISOString(),
        etims_status: "success",
        etims_error_message: null,
      })
      .eq("id", transactionId);

    if (updateError) {
      console.error("Failed to update transaction:", updateError);
    }

    // Log successful transmission
    await supabase.from("etims_transmission_logs").insert({
      organization_id: organizationId,
      document_type: "pos_transaction",
      document_id: transactionId,
      document_number: transactionNumber,
      api_endpoint: "saveTrnsSalesOsdc",
      request_payload: salesPayload,
      response_payload: responseData,
      response_code: "000",
      response_message: "Transmission successful",
      status: "success",
    });

    return new Response(
      JSON.stringify({
        success: true,
        cuNumber,
        qrCodeUrl,
        simulated: isTestMode,
        message: `Transaction transmitted${isTestMode ? " (sandbox)" : ""}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in etims-transmit-pos:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Fallback eTIMS API endpoints (used if platform settings not configured)
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

// KRA eTIMS tax category keys A through E
const TAX_CATEGORIES = ["A", "B", "C", "D", "E"] as const;

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

/**
 * Maps payment method strings to KRA eTIMS payment type codes.
 * KRA codes: 01=Cash, 02=Credit, 03=Cheque, 04=Transfer/EFT, 05=Mobile Money, 06=Other
 */
function mapPaymentType(paymentMethod: string | null | undefined): string {
  if (!paymentMethod) return "01";
  const method = paymentMethod.toLowerCase();
  if (method.includes("cash")) return "01";
  if (method.includes("credit") || method.includes("card")) return "02";
  if (method.includes("cheque") || method.includes("check")) return "03";
  if (method.includes("transfer") || method.includes("eft") || method.includes("bank")) return "04";
  if (method.includes("mpesa") || method.includes("mobile") || method.includes("m-pesa")) return "05";
  return "06"; // Other
}

export async function handle(req: Request): Promise<Response> {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { organizationId, invoiceId } = await req.json();

    if (!organizationId || !invoiceId) {
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
    // Check if eTIMS is enabled at platform level
    if (!platformSettings.enabled) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "eTIMS is not enabled on this platform. Please contact your administrator." 
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch the invoice with items and contact
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select(`
        *,
        contact:contacts(*),
        items:invoice_items(*)
      `)
      .eq("id", invoiceId)
      .eq("organization_id", organizationId)
      .single();

    if (invoiceError || !invoice) {
      console.error("Invoice fetch error:", invoiceError);
      return new Response(
        JSON.stringify({ success: false, error: "Invoice not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
      console.error("Config fetch error:", configError);
      return new Response(
        JSON.stringify({ success: false, error: "eTIMS is not configured or not active for this organization" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const config = configData.config as EtimsConfig;
    const isTestMode = platformSettings.environment === "sandbox";
    const baseUrl = isTestMode ? platformSettings.sandboxUrl : platformSettings.productionUrl;

    console.log(`Transmitting invoice to eTIMS. Mode: ${isTestMode ? 'sandbox' : 'production'}, URL: ${baseUrl}`);

    // Check if already transmitted
    if (invoice.etims_transmission_status === "success" && invoice.etims_cu_number) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          alreadyTransmitted: true,
          cuNumber: invoice.etims_cu_number,
          message: "Invoice already transmitted to eTIMS" 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Transmitting invoice ${invoice.invoice_number} to eTIMS`);

    // Format invoice data for eTIMS
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const salesDate = new Date(invoice.invoice_date).toISOString().slice(0, 10).replace(/-/g, "");
    
    // Determine receipt type (S = Sale, R = Refund)
    const receiptType = invoice.total >= 0 ? "S" : "R";
    
    // Determine customer type (B2B vs B2C)
    const isB2B = invoice.contact?.tax_id ? true : false;

    // Tax category accumulators — distribute across A-E based on per-item tax codes
    const taxCategoryTotals: Record<string, { taxableAmt: number; taxAmt: number; rate: number }> = {};
    for (const cat of TAX_CATEGORIES) {
      taxCategoryTotals[cat] = { taxableAmt: 0, taxAmt: 0, rate: 0 };
    }

    // Prepare items list with dynamic eTIMS codes
    const itemsList = await Promise.all(invoice.items.map(async (item: any, index: number) => {
      // Fetch product eTIMS configuration if product_id exists
      let classificationCode = "5020101";
      let unitCode = "U";
      let pkgCode = "CT";
      let taxCode = "A"; // default to category A

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

          // Get eTIMS tax code from the linked tax rate
          if (product.tax_rate_id) {
            const { data: taxRate } = await supabase
              .from("tax_rates")
              .select("etims_tax_code, rate")
              .eq("id", product.tax_rate_id)
              .single();
            if (taxRate?.etims_tax_code) {
              taxCode = taxRate.etims_tax_code;
              // Track the rate for this category
              if (TAX_CATEGORIES.includes(taxCode as any)) {
                taxCategoryTotals[taxCode].rate = taxRate.rate || 0;
              }
            }
          }
        }
      }

      const itemTaxableAmt = item.line_total - (item.tax_amount || 0);
      const itemTaxAmt = item.tax_amount || 0;

      // Accumulate into the correct tax category
      const effectiveCategory = TAX_CATEGORIES.includes(taxCode as any) ? taxCode : "A";
      taxCategoryTotals[effectiveCategory].taxableAmt += itemTaxableAmt;
      taxCategoryTotals[effectiveCategory].taxAmt += itemTaxAmt;

      return {
        itemSeq: index + 1,
        itemCd: item.product_id || `ITEM-${index + 1}`,
        itemClsCd: classificationCode,
        itemNm: item.description,
        bcd: null,
        pkgUnitCd: pkgCode,
        pkg: 1,
        qtyUnitCd: unitCode,
        qty: item.quantity,
        prc: item.unit_price,
        splyAmt: item.line_total,
        dcRt: item.discount_percent || 0,
        dcAmt: 0,
        isrccCd: null,
        isrccNm: null,
        isrcRt: 0,
        isrcAmt: 0,
        taxTyCd: taxCode,
        taxblAmt: itemTaxableAmt,
        taxAmt: itemTaxAmt,
        totAmt: item.line_total,
      };
    }));

    // Map payment method to KRA payment type code
    const paymentTypeCode = mapPaymentType(invoice.payment_method);

    // Prepare eTIMS payload with distributed tax category totals
    const salesPayload = {
      tin: config.tin,
      bhfId: config.bhf_id,
      invcNo: parseInt(invoice.invoice_number.replace(/\D/g, "").slice(-10)) || 1,
      orgInvcNo: 0,
      custTin: invoice.contact?.tax_id || null,
      custNm: invoice.contact?.name || "Walk-in Customer",
      salesTyCd: "N", // Normal sale
      rcptTyCd: receiptType,
      pmtTyCd: paymentTypeCode,
      salesSttsCd: "02", // Approved
      cfmDt: timestamp,
      salesDt: salesDate,
      stockRlsDt: salesDate,
      cnclReqDt: null,
      cnclDt: null,
      rfdDt: null,
      rfdRsnCd: null,
      totItemCnt: invoice.items.length,
      // Distributed tax category amounts
      taxblAmtA: taxCategoryTotals.A.taxableAmt,
      taxblAmtB: taxCategoryTotals.B.taxableAmt,
      taxblAmtC: taxCategoryTotals.C.taxableAmt,
      taxblAmtD: taxCategoryTotals.D.taxableAmt,
      taxblAmtE: taxCategoryTotals.E.taxableAmt,
      taxRtA: taxCategoryTotals.A.rate,
      taxRtB: taxCategoryTotals.B.rate,
      taxRtC: taxCategoryTotals.C.rate,
      taxRtD: taxCategoryTotals.D.rate,
      taxRtE: taxCategoryTotals.E.rate,
      taxAmtA: taxCategoryTotals.A.taxAmt,
      taxAmtB: taxCategoryTotals.B.taxAmt,
      taxAmtC: taxCategoryTotals.C.taxAmt,
      taxAmtD: taxCategoryTotals.D.taxAmt,
      taxAmtE: taxCategoryTotals.E.taxAmt,
      totTaxblAmt: invoice.subtotal || 0,
      totTaxAmt: invoice.tax_amount || 0,
      totAmt: invoice.total || 0,
      prchrAcptcYn: "N",
      remark: invoice.notes || null,
      regrId: "SYSTEM",
      regrNm: "System",
      modrId: "SYSTEM",
      modrNm: "System",
      receipt: {
        custTin: invoice.contact?.tax_id || null,
        custMblNo: invoice.contact?.phone || null,
        rptNo: 1,
        trdeNm: invoice.contact?.company || invoice.contact?.name || "Customer",
        adrs: invoice.contact?.address_line1 || null,
        topMsg: null,
        btmMsg: "Thank you for your business",
        prchrAcptcYn: "N",
      },
      itemList: itemsList,
    };

    console.log("eTIMS sales payload:", JSON.stringify(salesPayload, null, 2));

    // Attempt to transmit to eTIMS
    let cuNumber: string;
    let qrCodeUrl: string;
    let receiptSignature: string;
    let sdcId: string;
    let receiptNumber: number;
    let mrcNumber: string;
    let responseData: any;

    try {
      // In production, make actual API call
      const apiResponse = await fetch(`${baseUrl}/saveTrnsSalesOsdc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.communication_key}`,
        },
        body: JSON.stringify(salesPayload),
      });

      // Check if response is JSON before parsing
      const contentType = apiResponse.headers.get("content-type") || "";
      const responseText = await apiResponse.text();
      
      if (!contentType.includes("application/json")) {
        console.log("Non-JSON response from eTIMS API:", responseText.substring(0, 200));
        throw new Error(`eTIMS API returned non-JSON response (${apiResponse.status}). The API may be unavailable.`);
      }

      try {
        responseData = JSON.parse(responseText);
      } catch (parseError) {
        console.log("Failed to parse eTIMS response:", responseText.substring(0, 200));
        throw new Error("eTIMS API returned invalid JSON response");
      }

      console.log("eTIMS API response:", JSON.stringify(responseData));

      if (responseData.resultCd === "000") {
        cuNumber = responseData.data?.rcptSign || `CU-${timestamp}`;
        qrCodeUrl = responseData.data?.qrCodeUrl || `https://etims.kra.go.ke/verify?cu=${cuNumber}`;
        receiptSignature = responseData.data?.rcptSign || cuNumber;
        sdcId = responseData.data?.sdcId || config.device_serial || "OSCU";
        receiptNumber = responseData.data?.rcptNo || 1;
        mrcNumber = responseData.data?.mrcNo || `MRC-${timestamp}`;
      } else {
        throw new Error(responseData.resultMsg || "eTIMS transmission failed");
      }
    } catch (apiError: any) {
      console.log("API call failed:", apiError.message);

      // Simulation mode for sandbox only
      if (isTestMode) {
        console.warn("[SANDBOX SIMULATION] eTIMS API unreachable — generating simulated response. This will NOT work in production.");
        cuNumber = `SIM-CU-${timestamp}-${invoiceId.slice(0, 8)}`;
        qrCodeUrl = `https://etims-sbx.kra.go.ke/verify?cu=${cuNumber}`;
        receiptSignature = `SIG-${timestamp}`;
        sdcId = config.device_serial || `OSCU-${config.tin}`;
        receiptNumber = Math.floor(Math.random() * 100000);
        mrcNumber = `MRC-SIM-${timestamp}`;
        responseData = { 
          simulated: true, 
          resultCd: "000", 
          resultMsg: "Sandbox simulation success - awaiting KRA vendor certification" 
        };
      } else {
        // Log the failed transmission
        await supabase.from("etims_transmission_logs").insert({
          organization_id: organizationId,
          document_type: "invoice",
          document_id: invoiceId,
          document_number: invoice.invoice_number,
          api_endpoint: "saveTrnsSalesOsdc",
          request_payload: salesPayload,
          response_payload: { error: apiError.message },
          status: "failed",
          error_message: apiError.message,
        });

        // Update invoice with failed status
        await supabase
          .from("invoices")
          .update({
            etims_transmission_status: "failed",
            etims_error_message: apiError.message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", invoiceId);

        throw apiError;
      }
    }

    // Update invoice with eTIMS data
    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        etims_cu_number: cuNumber,
        etims_qr_code_url: qrCodeUrl,
        etims_receipt_signature: receiptSignature,
        etims_sdc_id: sdcId,
        etims_receipt_number: receiptNumber,
        etims_mrc_number: mrcNumber,
        etims_transmitted_at: new Date().toISOString(),
        etims_transmission_status: "success",
        etims_error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", invoiceId);

    if (updateError) {
      console.error("Failed to update invoice:", updateError);
    }

    // Log the successful transmission
    await supabase.from("etims_transmission_logs").insert({
      organization_id: organizationId,
      document_type: "invoice",
      document_id: invoiceId,
      document_number: invoice.invoice_number,
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
        receiptSignature,
        sdcId,
        receiptNumber,
        mrcNumber,
        simulated: isTestMode && responseData?.simulated === true,
        message: `Invoice transmitted successfully${isTestMode && responseData?.simulated ? " (sandbox simulation - awaiting KRA vendor certification)" : ""}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in etims-transmit-invoice:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

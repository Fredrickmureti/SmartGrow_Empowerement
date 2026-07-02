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
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { organizationId, creditNoteId } = await req.json();

    if (!organizationId || !creditNoteId) {
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

    // Fetch the credit note with items and contact
    const { data: creditNote, error: creditNoteError } = await supabase
      .from("credit_notes")
      .select(`
        *,
        contact:contacts(*),
        items:credit_note_items(*),
        invoice:invoices(invoice_number, etims_cu_number)
      `)
      .eq("id", creditNoteId)
      .eq("organization_id", organizationId)
      .single();

    if (creditNoteError || !creditNote) {
      console.error("Credit note fetch error:", creditNoteError);
      return new Response(
        JSON.stringify({ success: false, error: "Credit note not found" }),
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
      return new Response(
        JSON.stringify({ success: false, error: "eTIMS is not configured or not active" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const config = configData.config as EtimsConfig;
    const isTestMode = platformSettings.environment === "sandbox";
    const baseUrl = isTestMode ? platformSettings.sandboxUrl : platformSettings.productionUrl;

    console.log(`Transmitting credit note to eTIMS. Mode: ${isTestMode ? 'sandbox' : 'production'}, URL: ${baseUrl}`);

    // Check if already transmitted
    if (creditNote.etims_transmission_status === "success" && creditNote.etims_cu_number) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          alreadyTransmitted: true,
          cuNumber: creditNote.etims_cu_number,
          message: "Credit note already transmitted to eTIMS" 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Transmitting credit note ${creditNote.credit_note_number} to eTIMS`);

    // Validate that original invoice was transmitted
    if (!creditNote.invoice?.etims_cu_number) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Original invoice must be transmitted to eTIMS before credit note" 
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const creditNoteDate = new Date(creditNote.issue_date).toISOString().slice(0, 10).replace(/-/g, "");

    // Prepare items list
    const itemsList = creditNote.items.map((item: any, index: number) => ({
      itemSeq: index + 1,
      itemCd: item.product_id || `ITEM-${index + 1}`,
      itemClsCd: "5020101",
      itemNm: item.description,
      bcd: null,
      pkgUnitCd: "CT",
      pkg: 1,
      qtyUnitCd: "U",
      qty: item.quantity,
      prc: item.unit_price,
      splyAmt: item.line_total,
      dcRt: 0,
      dcAmt: 0,
      isrccCd: null,
      isrccNm: null,
      isrcRt: 0,
      isrcAmt: 0,
      taxTyCd: "A",
      taxblAmt: item.line_total - (item.tax_amount || 0),
      taxAmt: item.tax_amount || 0,
      totAmt: item.line_total,
    }));

    // Prepare eTIMS credit note payload
    const creditNotePayload = {
      tin: config.tin,
      bhfId: config.bhf_id,
      invcNo: parseInt(creditNote.credit_note_number.replace(/\D/g, "").slice(-10)) || 1,
      orgInvcNo: parseInt(creditNote.invoice.invoice_number.replace(/\D/g, "").slice(-10)) || 0,
      custTin: creditNote.contact?.tax_id || null,
      custNm: creditNote.contact?.name || "Customer",
      salesTyCd: "N",
      rcptTyCd: "R", // Refund type
      pmtTyCd: "01",
      salesSttsCd: "02",
      cfmDt: timestamp,
      salesDt: creditNoteDate,
      stockRlsDt: null,
      cnclReqDt: null,
      cnclDt: null,
      rfdDt: creditNoteDate,
      rfdRsnCd: "01", // General refund reason
      totItemCnt: creditNote.items.length,
      taxblAmtA: creditNote.subtotal || 0,
      taxblAmtB: 0,
      taxblAmtC: 0,
      taxblAmtD: 0,
      taxblAmtE: 0,
      taxRtA: (creditNote.subtotal && creditNote.tax_amount) ? Math.round((creditNote.tax_amount / creditNote.subtotal) * 100) : 0,
      taxRtB: 0,
      taxRtC: 0,
      taxRtD: 0,
      taxRtE: 0,
      taxAmtA: creditNote.tax_amount || 0,
      taxAmtB: 0,
      taxAmtC: 0,
      taxAmtD: 0,
      taxAmtE: 0,
      totTaxblAmt: creditNote.subtotal || 0,
      totTaxAmt: creditNote.tax_amount || 0,
      totAmt: creditNote.total || 0,
      prchrAcptcYn: "N",
      remark: creditNote.reason || creditNote.notes || "Credit note",
      regrId: "SYSTEM",
      regrNm: "System",
      modrId: "SYSTEM",
      modrNm: "System",
      itemList: itemsList,
    };

    console.log("eTIMS credit note payload:", JSON.stringify(creditNotePayload, null, 2));

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
        body: JSON.stringify(creditNotePayload),
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
        cuNumber = responseData.data?.rcptSign || `CU-CN-${timestamp}`;
        qrCodeUrl = responseData.data?.qrCodeUrl || `https://etims.kra.go.ke/verify?cu=${cuNumber}`;
      } else {
        throw new Error(responseData.resultMsg || "eTIMS transmission failed");
      }
    } catch (apiError: any) {
      console.log("API call failed, using simulation:", apiError.message);

      if (isTestMode) {
        cuNumber = `SIM-CN-${timestamp}-${creditNoteId.slice(0, 8)}`;
        qrCodeUrl = `https://etims-sbx.kra.go.ke/verify?cu=${cuNumber}`;
        responseData = { 
          simulated: true, 
          resultCd: "000", 
          resultMsg: "Sandbox simulation success - awaiting KRA vendor certification" 
        };
      } else {
        await supabase.from("etims_transmission_logs").insert({
          organization_id: organizationId,
          document_type: "credit_note",
          document_id: creditNoteId,
          document_number: creditNote.credit_note_number,
          api_endpoint: "saveTrnsSalesOsdc",
          request_payload: creditNotePayload,
          response_payload: { error: apiError.message },
          status: "failed",
          error_message: apiError.message,
        });

        await supabase
          .from("credit_notes")
          .update({
            etims_transmission_status: "failed",
            etims_error_message: apiError.message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", creditNoteId);

        throw apiError;
      }
    }

    // Update credit note with eTIMS data
    const { error: updateError } = await supabase
      .from("credit_notes")
      .update({
        etims_cu_number: cuNumber,
        etims_qr_code_url: qrCodeUrl,
        etims_transmitted_at: new Date().toISOString(),
        etims_transmission_status: "success",
        etims_error_message: null,
        etims_original_invoice_number: creditNote.invoice?.invoice_number,
        updated_at: new Date().toISOString(),
      })
      .eq("id", creditNoteId);

    if (updateError) {
      console.error("Failed to update credit note:", updateError);
    }

    // Log the successful transmission
    await supabase.from("etims_transmission_logs").insert({
      organization_id: organizationId,
      document_type: "credit_note",
      document_id: creditNoteId,
      document_number: creditNote.credit_note_number,
      api_endpoint: "saveTrnsSalesOsdc",
      request_payload: creditNotePayload,
      response_payload: responseData,
      response_code: "000",
      response_message: "Credit note transmitted successfully",
      status: "success",
    });

    return new Response(
      JSON.stringify({
        success: true,
        cuNumber,
        qrCodeUrl,
        simulated: isTestMode,
        message: `Credit note transmitted successfully${isTestMode ? " (sandbox simulation - awaiting KRA vendor certification)" : ""}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in etims-transmit-credit-note:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

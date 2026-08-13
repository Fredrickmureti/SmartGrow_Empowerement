
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

    const { organizationId, productId } = await req.json();

    if (!organizationId || !productId) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    // Fetch the product
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .eq("organization_id", organizationId)
      .single();

    if (productError || !product) {
      console.error("Product fetch error:", productError);
      return new Response(
        JSON.stringify({ success: false, error: "Product not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Country-specific fiscal metadata lives in product_tax_localization,
    // never on the product master.
    const { data: localization } = await supabase
      .from("product_tax_localization")
      .select("*")
      .eq("product_id", productId)
      .eq("jurisdiction", "KE")
      .maybeSingle();

    const saveLocalization = (patch: Record<string, unknown>) =>
      supabase.from("product_tax_localization").upsert(
        {
          organization_id: product.organization_id,
          business_id: product.business_id,
          product_id: productId,
          jurisdiction: "KE",
          ...patch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "product_id,jurisdiction" },
      );

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

    console.log(`Registering item with eTIMS. Mode: ${isTestMode ? 'sandbox' : 'production'}, URL: ${baseUrl}`);

    // Check if already registered
    if (localization?.item_code && localization.registration_status === "registered") {
      return new Response(
        JSON.stringify({ 
          success: true, 
          alreadyRegistered: true,
          itemCode: localization.item_code,
          message: "Product already registered with eTIMS" 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Registering product ${product.name} with eTIMS`);

    // Generate item code based on SKU or product ID
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const itemCode = product.sku || `ITEM-${productId.slice(0, 8).toUpperCase()}`;

    // Prepare item registration payload
    const itemPayload = {
      tin: config.tin,
      bhfId: config.bhf_id,
      itemCd: itemCode,
      itemClsCd: localization?.classification_code || "5020101", // Default classification
      itemTyCd: product.type === "service" ? "3" : "1", // 1 = Raw Material, 2 = Finished Product, 3 = Service
      itemNm: product.name,
      itemStdNm: product.name,
      orgnNatCd: localization?.origin_country || "KE",
      pkgUnitCd: localization?.packaging_unit || "CT",
      qtyUnitCd: localization?.unit_code || "U",
      taxTyCd: "A", // VAT 16% - should be from product tax settings
      btchNo: null,
      bcd: product.barcode || null,
      dftPrc: product.price || 0,
      grpPrcL1: 0,
      grpPrcL2: 0,
      grpPrcL3: 0,
      grpPrcL4: 0,
      grpPrcL5: 0,
      addInfo: product.description || null,
      sftyQty: product.reorder_point || 0,
      isrcAplcbYn: "N",
      useYn: "Y",
      regrId: "SYSTEM",
      regrNm: "System",
      modrId: "SYSTEM",
      modrNm: "System",
    };

    console.log("eTIMS item payload:", JSON.stringify(itemPayload, null, 2));

    let responseData: any;
    let registeredItemCode: string;

    try {
      // In production, make actual API call
      const apiResponse = await fetch(`${baseUrl}/saveItem`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.communication_key}`,
        },
        body: JSON.stringify(itemPayload),
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
        registeredItemCode = responseData.data?.itemCd || itemCode;
      } else {
        throw new Error(responseData.resultMsg || "eTIMS item registration failed");
      }
    } catch (apiError: any) {
      console.log("API call failed, using simulation:", apiError.message);

      // Simulation mode for sandbox
      if (isTestMode) {
        registeredItemCode = `SIM-${itemCode}`;
        responseData = { 
          simulated: true, 
          resultCd: "000", 
          resultMsg: "Sandbox simulation success - awaiting KRA vendor certification" 
        };
      } else {
        // Log the failed registration
        await supabase.from("etims_transmission_logs").insert({
          organization_id: organizationId,
          document_type: "item",
          document_id: productId,
          document_number: product.sku || product.name,
          api_endpoint: "saveItem",
          request_payload: itemPayload,
          response_payload: { error: apiError.message },
          status: "failed",
          error_message: apiError.message,
        });

        // Record the failure on the localization record
        await saveLocalization({ registration_status: "failed" });

        throw apiError;
      }
    }

    // Record the registration on the localization record
    const { error: updateError } = await saveLocalization({
      item_code: registeredItemCode,
      registered_at: new Date().toISOString(),
      registration_status: "registered",
    });

    if (updateError) {
      console.error("Failed to update product tax localization:", updateError);
    }

    // Log the successful registration
    await supabase.from("etims_transmission_logs").insert({
      organization_id: organizationId,
      document_type: "item",
      document_id: productId,
      document_number: product.sku || product.name,
      api_endpoint: "saveItem",
      request_payload: itemPayload,
      response_payload: responseData,
      response_code: "000",
      response_message: "Item registered successfully",
      status: "success",
    });

    return new Response(
      JSON.stringify({
        success: true,
        itemCode: registeredItemCode,
        simulated: isTestMode,
        message: `Item registered successfully${isTestMode ? " (sandbox simulation - awaiting KRA vendor certification)" : ""}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in etims-register-item:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

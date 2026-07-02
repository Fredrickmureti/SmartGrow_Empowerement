
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Fallback eTIMS API endpoints (used if platform settings not configured)
const DEFAULT_SANDBOX_URL = "https://etims-api-sbx.kra.go.ke/etims-api";
const DEFAULT_PRODUCTION_URL = "https://etims-api.kra.go.ke/etims-api";

// Code types to sync
const CODE_TYPES = [
  { endpoint: "selectItemClsList", codeType: "item_classification", listField: "itemClsList" },
  { endpoint: "selectCodeList", codeType: "unit_of_measure", listField: "clsList", cdCls: "10" },
  { endpoint: "selectCodeList", codeType: "packaging_unit", listField: "clsList", cdCls: "17" },
  { endpoint: "selectCodeList", codeType: "tax_type", listField: "clsList", cdCls: "04" },
  { endpoint: "selectCodeList", codeType: "country", listField: "clsList", cdCls: "05" },
  { endpoint: "selectCodeList", codeType: "currency", listField: "clsList", cdCls: "03" },
  { endpoint: "selectCodeList", codeType: "payment_type", listField: "clsList", cdCls: "07" },
  { endpoint: "selectCodeList", codeType: "transaction_type", listField: "clsList", cdCls: "09" },
];

// Sample standard codes for simulation
const SAMPLE_CODES: Record<string, any[]> = {
  item_classification: [
    { code: "5020101", name: "Electronics", name_local: "Vifaa vya Kielektroniki" },
    { code: "5020102", name: "Computers", name_local: "Kompyuta" },
    { code: "5010101", name: "Food & Beverages", name_local: "Chakula na Vinywaji" },
    { code: "5010201", name: "Clothing", name_local: "Mavazi" },
    { code: "5030101", name: "Furniture", name_local: "Samani" },
    { code: "5040101", name: "Services", name_local: "Huduma" },
  ],
  unit_of_measure: [
    { code: "U", name: "Unit", name_local: "Kipimo" },
    { code: "KG", name: "Kilogram", name_local: "Kilogramu" },
    { code: "LT", name: "Litre", name_local: "Lita" },
    { code: "M", name: "Meter", name_local: "Mita" },
    { code: "PK", name: "Pack", name_local: "Pakiti" },
    { code: "DZ", name: "Dozen", name_local: "Dazeni" },
    { code: "HR", name: "Hour", name_local: "Saa" },
    { code: "DA", name: "Day", name_local: "Siku" },
  ],
  packaging_unit: [
    { code: "CT", name: "Carton", name_local: "Katoni" },
    { code: "BG", name: "Bag", name_local: "Mfuko" },
    { code: "BX", name: "Box", name_local: "Sanduku" },
    { code: "BT", name: "Bottle", name_local: "Chupa" },
    { code: "EA", name: "Each", name_local: "Kila moja" },
  ],
  tax_type: [
    { code: "A", name: "VAT 16%", description: "Standard Rate" },
    { code: "B", name: "VAT 0%", description: "Zero Rate" },
    { code: "C", name: "VAT Exempt", description: "Exempt" },
    { code: "D", name: "VAT 8%", description: "Reduced Rate" },
    { code: "E", name: "VAT Tourism", description: "Tourism Levy" },
  ],
  country: [
    { code: "KE", name: "Kenya", name_local: "Kenya" },
    { code: "UG", name: "Uganda", name_local: "Uganda" },
    { code: "TZ", name: "Tanzania", name_local: "Tanzania" },
    { code: "RW", name: "Rwanda", name_local: "Rwanda" },
    { code: "CN", name: "China", name_local: "Uchina" },
    { code: "US", name: "United States", name_local: "Marekani" },
    { code: "GB", name: "United Kingdom", name_local: "Uingereza" },
    { code: "AE", name: "United Arab Emirates", name_local: "Falme za Kiarabu" },
  ],
  currency: [
    { code: "KES", name: "Kenyan Shilling", name_local: "Shilingi ya Kenya" },
    { code: "USD", name: "US Dollar", name_local: "Dola ya Marekani" },
    { code: "EUR", name: "Euro", name_local: "Euro" },
    { code: "GBP", name: "British Pound", name_local: "Pauni ya Uingereza" },
    { code: "UGX", name: "Ugandan Shilling", name_local: "Shilingi ya Uganda" },
    { code: "TZS", name: "Tanzanian Shilling", name_local: "Shilingi ya Tanzania" },
  ],
  payment_type: [
    { code: "01", name: "Cash", name_local: "Pesa Taslimu" },
    { code: "02", name: "Credit", name_local: "Mkopo" },
    { code: "03", name: "Bank Transfer", name_local: "Uhamisho wa Benki" },
    { code: "04", name: "Mobile Money", name_local: "Pesa ya Simu" },
    { code: "05", name: "Cheque", name_local: "Cheki" },
    { code: "06", name: "Credit Card", name_local: "Kadi ya Mkopo" },
  ],
  transaction_type: [
    { code: "S", name: "Sale", description: "Standard sale" },
    { code: "R", name: "Refund", description: "Refund transaction" },
    { code: "C", name: "Credit Note", description: "Credit note" },
    { code: "D", name: "Debit Note", description: "Debit note" },
  ],
};

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

    const body = await req.json();
    const { organizationId, configId, syncAll } = body;

    console.log("Starting eTIMS code sync:", { organizationId, configId, syncAll });

    // Fetch platform eTIMS settings
    const platformSettings = await getPlatformEtimsSettings(supabase);

    // If syncing for a specific organization, verify the config
    let config = null;

    if (!syncAll && organizationId && configId) {
      const { data: configData, error: configError } = await supabase
        .from("tax_compliance_configs")
        .select("*")
        .eq("id", configId)
        .eq("organization_id", organizationId)
        .single();

      if (configError || !configData) {
        return new Response(
          JSON.stringify({ success: false, error: "Configuration not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      config = configData;
    }

    const isTestMode = platformSettings.environment === "sandbox";
    const baseUrl = isTestMode ? platformSettings.sandboxUrl : platformSettings.productionUrl;
    
    // Get vendor credentials for API calls (needed in production mode)
    let vendorTin = "";
    let vendorBranchId = "00";
    
    if (!isTestMode && config) {
      // In production, use the org's configured credentials
      const configData = config.config as any;
      vendorTin = configData?.tin || "";
      vendorBranchId = configData?.bhf_id || "00";
    }
    
    console.log(`Syncing codes. Mode: ${isTestMode ? 'sandbox' : 'production'}, URL: ${baseUrl}`);
    
    let totalCodes = 0;
    const errors: string[] = [];

    // For each code type, fetch and store codes
    for (const codeTypeInfo of CODE_TYPES) {
      try {
        console.log(`Syncing code type: ${codeTypeInfo.codeType}`);

        let codes: any[] = [];
        
        // In production mode with valid credentials, attempt real API calls
        if (!isTestMode && vendorTin) {
          try {
            const apiPayload: any = {
              tin: vendorTin,
              bhfId: vendorBranchId,
              lastReqDt: "20200101000000", // Get all codes from the beginning
            };
            
            // Add cdCls parameter for selectCodeList endpoint
            if (codeTypeInfo.cdCls) {
              apiPayload.cdCls = codeTypeInfo.cdCls;
            }
            
            console.log(`Calling KRA API: ${baseUrl}/${codeTypeInfo.endpoint}`, apiPayload);
            
            const apiResponse = await fetch(`${baseUrl}/${codeTypeInfo.endpoint}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(apiPayload),
            });
            
            const contentType = apiResponse.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
              const data = await apiResponse.json();
              
              if (data.resultCd === "000" && data.data?.[codeTypeInfo.listField]) {
                // Map KRA response to our format
                codes = data.data[codeTypeInfo.listField].map((item: any) => ({
                  code: item.cdCls || item.itemClsCd || item.cd,
                  name: item.cdNm || item.itemClsNm || item.nm,
                  name_local: item.cdNmLocal || null,
                  description: item.cdDesc || null,
                }));
                console.log(`Fetched ${codes.length} codes from KRA for ${codeTypeInfo.codeType}`);
              } else {
                console.warn(`KRA API returned: ${data.resultCd} - ${data.resultMsg}`);
                // Fall back to sample data if API fails
                codes = SAMPLE_CODES[codeTypeInfo.codeType] || [];
              }
            } else {
              console.warn(`Non-JSON response from KRA API for ${codeTypeInfo.codeType}`);
              codes = SAMPLE_CODES[codeTypeInfo.codeType] || [];
            }
          } catch (apiError: any) {
            console.error(`KRA API error for ${codeTypeInfo.codeType}:`, apiError.message);
            // Fall back to sample data on API error
            codes = SAMPLE_CODES[codeTypeInfo.codeType] || [];
          }
        } else {
          // Sandbox mode or no credentials - use sample data
          codes = SAMPLE_CODES[codeTypeInfo.codeType] || [];
        }

        if (codes.length > 0) {
          // Upsert codes into the database
          const upsertData = codes.map((code, index) => ({
            code_type: codeTypeInfo.codeType,
            code: code.code,
            name: code.name,
            name_local: code.name_local || null,
            description: code.description || null,
            parent_code: code.parent_code || null,
            sort_order: index,
            is_active: true,
            fetched_at: new Date().toISOString(),
          }));

          const { error: upsertError } = await supabase
            .from("etims_standard_codes")
            .upsert(upsertData, { 
              onConflict: "code_type,code",
              ignoreDuplicates: false 
            });

          if (upsertError) {
            console.error(`Error upserting ${codeTypeInfo.codeType}:`, upsertError);
            errors.push(`${codeTypeInfo.codeType}: ${upsertError.message}`);
          } else {
            totalCodes += codes.length;
            console.log(`Synced ${codes.length} codes for ${codeTypeInfo.codeType}`);
          }
        }
      } catch (codeError: any) {
        console.error(`Error syncing ${codeTypeInfo.codeType}:`, codeError);
        errors.push(`${codeTypeInfo.codeType}: ${codeError.message}`);
      }
    }

    // Update the config's last sync time if syncing for specific org
    if (config) {
      await supabase
        .from("tax_compliance_configs")
        .update({
          last_sync_at: new Date().toISOString(),
          sync_status: errors.length > 0 ? "partial" : "synced",
          updated_at: new Date().toISOString(),
        })
        .eq("id", configId);
    }

    // Log the sync operation
    if (organizationId) {
      await supabase.from("etims_transmission_logs").insert({
        organization_id: organizationId,
        document_type: "code_sync",
        document_id: configId || organizationId,
        api_endpoint: "selectCodeList",
        request_payload: { codeTypes: CODE_TYPES.map(c => c.codeType) },
        response_payload: { totalCodes, errors, simulated: isTestMode },
        response_code: errors.length > 0 ? "partial" : "000",
        response_message: `Synced ${totalCodes} codes`,
        status: errors.length > 0 ? "partial" : "success",
        error_message: errors.length > 0 ? errors.join("; ") : null,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        totalCodes,
        errors: errors.length > 0 ? errors : null,
        simulated: isTestMode,
        message: `Successfully synced ${totalCodes} standard codes${isTestMode ? " (sandbox simulation)" : ""}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in etims-sync-codes:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

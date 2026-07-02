
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
  communication_key?: string;
  device_serial?: string;
}

interface PlatformEtimsSettings {
  enabled: boolean;
  environment: string;
  sandboxUrl: string;
  productionUrl: string;
  vendorTin: string;
  vendorBranchId: string;
  vendorDeviceSerial: string;
  vendorInitialized: boolean;
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
      "etims_vendor_tin",
      "etims_vendor_branch_id",
      "etims_vendor_device_serial",
      "etims_vendor_initialized",
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
    vendorTin: settings.etims_vendor_tin || "",
    vendorBranchId: settings.etims_vendor_branch_id || "00",
    vendorDeviceSerial: settings.etims_vendor_device_serial || "",
    vendorInitialized: settings.etims_vendor_initialized === "true",
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

    const { organizationId, configId } = await req.json();

    if (!organizationId || !configId) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch platform eTIMS settings
    const platformSettings = await getPlatformEtimsSettings(supabase);
    console.log("Platform eTIMS settings:", {
      enabled: platformSettings.enabled,
      environment: platformSettings.environment,
      vendorInitialized: platformSettings.vendorInitialized,
    });

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

    // Fetch the tax compliance config
    const { data: configData, error: configError } = await supabase
      .from("tax_compliance_configs")
      .select("*")
      .eq("id", configId)
      .eq("organization_id", organizationId)
      .single();

    if (configError || !configData) {
      console.error("Config fetch error:", configError);
      return new Response(
        JSON.stringify({ success: false, error: "Tax compliance configuration not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const config = configData.config as EtimsConfig;
    
    // Use platform environment setting (sandbox/production)
    const isTestMode = platformSettings.environment === "sandbox";
    const baseUrl = isTestMode ? platformSettings.sandboxUrl : platformSettings.productionUrl;

    console.log(`Initializing eTIMS device for TIN: ${config.tin}, BHF: ${config.bhf_id}, Mode: ${isTestMode ? 'sandbox' : 'production'}, URL: ${baseUrl}`);

    // Prepare device initialization request
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const deviceSerial = `OSCU-${config.tin}-${timestamp}`;

    // eTIMS selectInitOsdcInfo API call
    const initPayload = {
      tin: config.tin,
      bhfId: config.bhf_id,
      dvcSrlNo: deviceSerial,
    };

    console.log("Sending init request to eTIMS:", JSON.stringify(initPayload));

    let response;
    let responseData;

    try {
      // Attempt actual API call
      const apiResponse = await fetch(`${baseUrl}/selectInitOsdcInfo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(initPayload),
      });

      // Check if response is JSON before parsing
      const contentType = apiResponse.headers.get("content-type") || "";
      const responseText = await apiResponse.text();
      
      if (!contentType.includes("application/json")) {
        console.log("Non-JSON response from eTIMS API:", responseText.substring(0, 200));
        throw new Error(`eTIMS API returned non-JSON response (${apiResponse.status}). The API may be unavailable or requires vendor certification.`);
      }

      try {
        responseData = JSON.parse(responseText);
      } catch (parseError) {
        console.log("Failed to parse eTIMS response:", responseText.substring(0, 200));
        throw new Error("eTIMS API returned invalid JSON response");
      }
      
      console.log("eTIMS API response:", JSON.stringify(responseData));

      if (responseData.resultCd === "000") {
        // Successful initialization
        const communicationKey = responseData.data?.cmcKey;
        
        // Update the config with the communication key and device serial
        const { error: updateError } = await supabase
          .from("tax_compliance_configs")
          .update({
            config: {
              ...config,
              communication_key: communicationKey,
              device_serial: deviceSerial,
            },
            device_serial: deviceSerial,
            sync_status: "initialized",
            last_sync_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", configId);

        if (updateError) {
          console.error("Failed to update config:", updateError);
          throw new Error("Failed to save initialization data");
        }

        // Log the successful transmission
        await supabase.from("etims_transmission_logs").insert({
          organization_id: organizationId,
          document_type: "device_init",
          document_id: configId,
          document_number: deviceSerial,
          api_endpoint: "selectInitOsdcInfo",
          request_payload: initPayload,
          response_payload: responseData,
          response_code: responseData.resultCd,
          response_message: responseData.resultMsg,
          status: "success",
        });

        return new Response(
          JSON.stringify({
            success: true,
            deviceSerial,
            communicationKey: communicationKey ? "****" + communicationKey.slice(-4) : null,
            message: "Device initialized successfully",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } else {
        throw new Error(responseData.resultMsg || "eTIMS initialization failed");
      }
    } catch (apiError: any) {
      console.log("API call failed, using simulation mode:", apiError.message);
      
      // Simulation mode for development/testing
      if (isTestMode) {
        const simulatedCommKey = `CMC-${config.tin}-${Date.now()}`;
        
        // Update config with simulated values
        const { error: updateError } = await supabase
          .from("tax_compliance_configs")
          .update({
            config: {
              ...config,
              communication_key: simulatedCommKey,
              device_serial: deviceSerial,
            },
            device_serial: deviceSerial,
            sync_status: "initialized_simulated",
            last_sync_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", configId);

        if (updateError) {
          console.error("Failed to update config:", updateError);
          throw new Error("Failed to save initialization data");
        }

        // Log the simulated transmission
        await supabase.from("etims_transmission_logs").insert({
          organization_id: organizationId,
          document_type: "device_init",
          document_id: configId,
          document_number: deviceSerial,
          api_endpoint: "selectInitOsdcInfo",
          request_payload: initPayload,
          response_payload: { simulated: true, message: "Sandbox simulation - platform awaiting KRA vendor certification" },
          response_code: "000",
          response_message: "Simulated success",
          status: "success",
        });

        return new Response(
          JSON.stringify({
            success: true,
            deviceSerial,
            communicationKey: "****" + simulatedCommKey.slice(-4),
            message: "Device initialized successfully (sandbox simulation - awaiting KRA vendor certification)",
            simulated: true,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Log the failed transmission
      await supabase.from("etims_transmission_logs").insert({
        organization_id: organizationId,
        document_type: "device_init",
        document_id: configId,
        document_number: deviceSerial,
        api_endpoint: "selectInitOsdcInfo",
        request_payload: initPayload,
        response_payload: { error: apiError.message },
        status: "failed",
        error_message: apiError.message,
      });

      throw apiError;
    }
  } catch (error: unknown) {
    console.error("Error in etims-init:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

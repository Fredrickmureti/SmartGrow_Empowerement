import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ActivateRequest {
  token: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { token }: ActivateRequest = await req.json();

    if (!token) {
      return new Response(JSON.stringify({ error: "Activation token is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[activate-organization] Attempting to activate with token: ${token.substring(0, 8)}...`);

    // Find organization by activation token
    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("id, name, owner_id, is_activated, activation_expires_at")
      .eq("activation_token", token)
      .single();

    if (orgError || !org) {
      console.error("[activate-organization] Organization not found for token");
      return new Response(JSON.stringify({ error: "Invalid activation token" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if already activated
    if (org.is_activated) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: "Organization is already activated",
        organizationId: org.id,
        organizationName: org.name,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if token has expired
    if (org.activation_expires_at && new Date(org.activation_expires_at) < new Date()) {
      console.error("[activate-organization] Activation token has expired");
      return new Response(JSON.stringify({ error: "Activation token has expired. Please contact support." }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Activate the organization
    const { error: updateError } = await supabase
      .from("organizations")
      .update({
        is_activated: true,
        activated_at: new Date().toISOString(),
        activation_token: null, // Clear token after use
        activation_expires_at: null,
      })
      .eq("id", org.id);

    if (updateError) {
      console.error("[activate-organization] Failed to update organization:", updateError);
      throw updateError;
    }

    // Get owner details for welcome email
    const { data: owner } = await supabase
      .from("profiles")
      .select("email, full_name")
      .eq("user_id", org.owner_id)
      .single();

    // Send activation confirmation email
    if (owner?.email) {
      await supabase.functions.invoke("send-platform-email", {
        body: {
          to: owner.email,
          templateKey: "organization_activated",
          recipientUserId: org.owner_id,
          recipientOrgId: org.id,
          variables: {
            user_name: owner.full_name || "there",
            org_name: org.name,
            platform_name: "AccrualFlow",
            dashboard_url: `${supabaseUrl.replace('.supabase.co', '')}/dashboard`,
          },
        },
      });
    }

    console.log(`[activate-organization] Successfully activated organization: ${org.name} (${org.id})`);

    return new Response(JSON.stringify({ 
      success: true, 
      message: "Organization activated successfully",
      organizationId: org.id,
      organizationName: org.name,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("[activate-organization] Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

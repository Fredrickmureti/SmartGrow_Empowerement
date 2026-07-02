import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AcceptRequest {
  token: string;
  password: string;
}

interface ValidateRequest {
  token: string;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const action = body.action || "validate";

    if (action === "validate") {
      // Validate the token
      const { token } = body as ValidateRequest;
      if (!token) {
        return new Response(
          JSON.stringify({ valid: false, error: "Missing token" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: invitation, error: invErr } = await supabase
        .from("vendor_portal_invitations")
        .select(`
          id, email, status, expires_at,
          contact:contacts(id, name, company),
          organization:organizations(id, name)
        `)
        .eq("token", token)
        .single();

      if (invErr || !invitation) {
        return new Response(
          JSON.stringify({ valid: false, error: "Invalid invitation token" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (invitation.status === "accepted") {
        return new Response(
          JSON.stringify({ valid: false, error: "This invitation has already been accepted", isAccepted: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (new Date(invitation.expires_at) < new Date()) {
        return new Response(
          JSON.stringify({ valid: false, error: "This invitation has expired", isExpired: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ valid: true, invitation }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "accept") {
      // Accept the invitation - create auth user and link to contact
      const { token, password } = body as AcceptRequest;
      if (!token || !password) {
        return new Response(
          JSON.stringify({ error: "Missing token or password" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (password.length < 6) {
        return new Response(
          JSON.stringify({ error: "Password must be at least 6 characters" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get invitation
      const { data: invitation, error: invErr } = await supabase
        .from("vendor_portal_invitations")
        .select("id, email, contact_id, organization_id, status, expires_at")
        .eq("token", token)
        .single();

      if (invErr || !invitation) {
        return new Response(
          JSON.stringify({ error: "Invalid invitation" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (invitation.status !== "pending") {
        return new Response(
          JSON.stringify({ error: "Invitation is no longer valid" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (new Date(invitation.expires_at) < new Date()) {
        // Mark as expired
        await supabase
          .from("vendor_portal_invitations")
          .update({ status: "expired" })
          .eq("id", invitation.id);
        return new Response(
          JSON.stringify({ error: "Invitation has expired" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get contact name for the user profile
      const { data: contact } = await supabase
        .from("contacts")
        .select("name, company")
        .eq("id", invitation.contact_id)
        .single();

      // Create auth user with service role
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: invitation.email,
        password: password,
        email_confirm: true,
        user_metadata: {
          full_name: contact?.name || invitation.email,
          is_vendor_portal: true,
          vendor_contact_id: invitation.contact_id,
          vendor_organization_id: invitation.organization_id,
          onboarding_completed: true, // Prevent onboarding flow from triggering
        },
      });

      if (authError) {
        // Check if user already exists
        if (authError.message?.includes("already been registered")) {
          // Find existing user and link
          const { data: existingUsers } = await supabase.auth.admin.listUsers();
          const existingUser = existingUsers?.users?.find(u => u.email === invitation.email);
          
          if (existingUser) {
            // Link existing user to contact
            await supabase
              .from("contacts")
              .update({ portal_user_id: existingUser.id })
              .eq("id", invitation.contact_id);

            await supabase
              .from("vendor_portal_invitations")
              .update({ status: "accepted", accepted_at: new Date().toISOString() })
              .eq("id", invitation.id);

            return new Response(
              JSON.stringify({ success: true, message: "Portal access granted. Please sign in with your existing credentials." }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }
        return new Response(
          JSON.stringify({ error: authError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Link the new user to the contact
      await supabase
        .from("contacts")
        .update({ portal_user_id: authData.user.id })
        .eq("id", invitation.contact_id);

      // Mark invitation as accepted
      await supabase
        .from("vendor_portal_invitations")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", invitation.id);

      return new Response(
        JSON.stringify({ success: true, user_id: authData.user.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

serve(handler);

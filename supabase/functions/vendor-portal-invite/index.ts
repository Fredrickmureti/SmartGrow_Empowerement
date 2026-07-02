import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface VendorPortalInviteRequest {
  contact_id: string;
  email: string;
  organization_id: string;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the requesting user from auth header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: VendorPortalInviteRequest = await req.json();
    const { contact_id, email, organization_id } = body;

    if (!contact_id || !email || !organization_id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: contact_id, email, organization_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify the requesting user is an admin/owner
    const { data: userRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("organization_id", organization_id)
      .single();

    if (!userRole || !["owner", "admin", "super_admin"].includes(userRole.role)) {
      return new Response(
        JSON.stringify({ error: "Insufficient permissions" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if contact already has a portal user
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, name, portal_user_id")
      .eq("id", contact_id)
      .single();

    if (!contact) {
      return new Response(
        JSON.stringify({ error: "Contact not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (contact.portal_user_id) {
      return new Response(
        JSON.stringify({ error: "This vendor already has portal access" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check for existing pending invitation
    const { data: existingInvite } = await supabase
      .from("vendor_portal_invitations")
      .select("id, status")
      .eq("contact_id", contact_id)
      .eq("status", "pending")
      .single();

    if (existingInvite) {
      return new Response(
        JSON.stringify({ error: "A pending invitation already exists for this vendor" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create the invitation
    const { data: invitation, error: invError } = await supabase
      .from("vendor_portal_invitations")
      .insert({
        organization_id,
        contact_id,
        email,
        invited_by: user.id,
      })
      .select()
      .single();

    if (invError) {
      console.error("Error creating invitation:", invError);
      return new Response(
        JSON.stringify({ error: "Failed to create invitation" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve website URL (used in the CTA link) from platform settings.
    const { data: settings } = await supabase
      .from("platform_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["website_url"]);
    const settingsMap = (settings || []).reduce((acc: Record<string, string>, s) => {
      if (s.setting_value) acc[s.setting_key] = s.setting_value;
      return acc;
    }, {});
    const websiteUrl = settingsMap.website_url || "https://accrualflow.systems";

    // Get organization name (used only inside the email body copy — the
    // From-line is resolved centrally by send-email from the tenant's
    // business identity).
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", organization_id)
      .single();
    const orgName = org?.name || "an organization";
    const portalUrl = `${websiteUrl}/vendor-portal/accept?token=${invitation.token}`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
          <tr><td align="center">
            <table width="100%" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,.1);">
              <tr><td style="background:linear-gradient(135deg,#f97316,#ea580c);padding:32px;text-align:center;">
                <h1 style="margin:0;color:#fff;font-size:24px;">Vendor Portal Invitation</h1>
              </td></tr>
              <tr><td style="padding:40px 32px;">
                <p style="margin:0 0 20px;color:#18181b;font-size:16px;line-height:1.6;">Hello,</p>
                <p style="margin:0 0 24px;color:#18181b;font-size:16px;line-height:1.6;">
                  <strong style="color:#f97316;">${orgName}</strong> has invited you to their vendor portal.
                  You'll be able to view purchase orders, respond to RFQs, and manage your vendor profile.
                </p>
                <table width="100%"><tr><td align="center" style="padding:16px 0 32px;">
                  <a href="${portalUrl}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:16px;">
                    Accept & Set Up Account
                  </a>
                </td></tr></table>
                <p style="margin:24px 0 0;color:#71717a;font-size:14px;">If you don't recognize this invitation, you can safely ignore this email.</p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `;

    try {
      // Route through shared send-email transport so tenant branding resolves
      // centrally. See ADR 0023.
      await supabase.functions.invoke("send-email", {
        body: {
          to: email,
          subject: `You're invited to the ${orgName} Vendor Portal`,
          html,
          category: "vendor_portal",
          organization_id,
          template_key: "vendor_portal:invite",
          metadata: { invitation_id: invitation.id, contact_id },
        },
      });
    } catch (emailErr) {
      console.error("Email sending failed:", emailErr);
      // Don't fail the invitation if email fails
    }

    return new Response(
      JSON.stringify({ success: true, invitation_id: invitation.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

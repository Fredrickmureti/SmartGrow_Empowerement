import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface InvitationEmailRequest {
  invitationId: string;
}

type UserLimitResult = boolean | { allowed?: boolean; reason?: string; message?: string } | null;

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // JWT-based auth: validate caller identity
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseUser.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { invitationId }: InvitationEmailRequest = await req.json();

    if (!invitationId) {
      return new Response(JSON.stringify({ error: "Missing invitation ID" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch invitation details with organization + primary business identity.
    // The From-line on user invitations should read as the tenant, not the platform.
    const { data: invitation, error: invError } = await supabase
      .from("organization_invitations")
      // NOTE: `organization_invitations` has no `business_id` column — invitations
      // are scoped at the organization level. Referencing a missing column made
      // PostgREST reject this select, which the handler mapped to a 404
      // "Invitation not found" and silently swallowed every invite email.
      .select(`id, email, role, user_type, token, expires_at, organization_id, organization:organizations(id, name)`)
      .eq("id", invitationId)
      .single();

    if (invError) {
      // Surface the REAL Postgres/PostgREST failure — a schema drift here
      // (e.g. selecting a column that no longer exists) used to be masked
      // as a generic "Invitation not found" 404, which made every invite
      // email silently disappear with zero diagnostic trail.
      console.error("[send-invitation-email] load invite failed", {
        invitationId,
        code: (invError as any).code,
        message: invError.message,
        details: (invError as any).details,
        hint: (invError as any).hint,
      });
      return new Response(
        JSON.stringify({
          error: "invitation_lookup_failed",
          details: invError.message,
          code: (invError as any).code ?? null,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!invitation) {
      return new Response(JSON.stringify({ error: "Invitation not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // Verify caller is admin/owner in the invitation's organization
    // First check user_roles table
    const { data: userRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("organization_id", invitation.organization_id)
      .eq("is_active", true)
      .maybeSingle();

    let hasPermission = userRole && ["owner", "admin", "super_admin"].includes(userRole.role);

    // Fallback: during onboarding, user_roles may not be populated yet.
    // Check if the caller created this invitation (invited_by field)
    if (!hasPermission) {
      const { data: inv } = await supabase
        .from("organization_invitations")
        .select("invited_by")
        .eq("id", invitationId)
        .single();

      if (inv?.invited_by === userId) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch settings needed for the email BODY only. The From-line,
    // Reply-To, and transport credentials are owned by `send-email` + the
    // shared sender-identity resolver (ADR 0023).
    const { data: settings } = await supabase
      .from("platform_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["platform_name"]);

    const settingsMap = (settings || []).reduce((acc: Record<string, string>, s) => {
      if (s.setting_value) acc[s.setting_key] = s.setting_value;
      return acc;
    }, {});

    const org = invitation.organization as any;
    const orgName = org?.name || "an organization";
    // Never fall back to a foreign brand: if no platform name is configured,
    // the organisation name is the only safe identity to show.
    const platformName = (settingsMap.platform_name || "").trim() || orgName;
    const showPlatform = platformName.toLowerCase() !== orgName.toLowerCase();
    const roleName = invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1);
    const article = /^[aeiou]/i.test(roleName) ? "an" : "a";

    // The accept link must point at the deployed APPLICATION, not the
    // marketing website. `app_base_url` is the single canonical source shared
    // with notification deep links (_shared/email/deepLink.ts).
    const appBaseUrl = (await resolveAppBaseUrl(supabase, supabaseUrl)).replace(/\/+$/, "");
    const acceptUrl = `${appBaseUrl}/accept-invitation?token=${encodeURIComponent(invitation.token)}`;

    // Server-side seat enforcement. `check_user_limit` no longer exists; the
    // live surface is `get_effective_user_limit(_org_id)` which returns NULL
    // when the deployment has no seat cap. `check_user_invite_allowed` is not
    // usable here because it relies on auth.uid(), which is null for the
    // service-role client used by this function.
    const { data: seatLimit, error: limitError } = await supabase
      .rpc("get_effective_user_limit", { _org_id: invitation.organization_id });

    if (limitError) {
      console.error("[send-invitation-email] user limit check failed", {
        organization_id: invitation.organization_id,
        code: (limitError as any).code,
        message: limitError.message,
        details: (limitError as any).details,
        hint: (limitError as any).hint,
      });
      return new Response(JSON.stringify({
        error: "user_limit_check_failed",
        details: limitError.message,
        accept_url: acceptUrl,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof seatLimit === "number") {
      const [{ count: activeCount }, { count: pendingCount }] = await Promise.all([
        supabase
          .from("user_roles")
          .select("user_id", { count: "exact", head: true })
          .eq("organization_id", invitation.organization_id)
          .eq("is_active", true),
        supabase
          .from("organization_invitations")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", invitation.organization_id)
          .is("accepted_at", null)
          .gt("expires_at", new Date().toISOString()),
      ]);

      const used = (activeCount ?? 0) + (pendingCount ?? 0);
      if (used > seatLimit) {
        return new Response(JSON.stringify({
          error: `Your plan allows ${seatLimit} users. You currently have ${activeCount ?? 0} member(s) and ${pendingCount ?? 0} pending invitation(s).`,
          accept_url: acceptUrl,
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Transport credentials are owned by `send-email` (ADR 0023); this
    // function no longer gates on a local copy of the provider key.



    const expiresDate = new Date(invitation.expires_at).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
          <tr>
            <td align="center">
              <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                <!-- Header -->
                <tr>
                  <td style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 32px; text-align: center;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">You're Invited!</h1>
                  </td>
                </tr>
                
                <!-- Content -->
                <tr>
                  <td style="padding: 40px 32px;">
                    <p style="margin: 0 0 20px; color: #18181b; font-size: 16px; line-height: 1.6;">
                      Hello,
                    </p>
                    <p style="margin: 0 0 24px; color: #18181b; font-size: 16px; line-height: 1.6;">
                      You've been invited to join <strong style="color: #3b82f6;">${orgName}</strong> on ${platformName} as a <strong>${roleName}</strong>.
                    </p>
                    
                    <!-- CTA Button -->
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="center" style="padding: 16px 0 32px;">
                          <a href="${acceptUrl}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);">
                            Accept Invitation
                          </a>
                        </td>
                      </tr>
                    </table>
                    
                    <!-- Info Box -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; border-radius: 8px; padding: 20px;">
                      <tr>
                        <td style="padding: 16px;">
                          <p style="margin: 0 0 8px; color: #71717a; font-size: 14px;">
                            <strong style="color: #18181b;">Role:</strong> ${roleName}
                          </p>
                          <p style="margin: 0; color: #71717a; font-size: 14px;">
                            <strong style="color: #18181b;">Expires:</strong> ${expiresDate}
                          </p>
                        </td>
                      </tr>
                    </table>
                    
                    <p style="margin: 24px 0 0; color: #71717a; font-size: 14px; line-height: 1.6;">
                      If you don't recognize this invitation, you can safely ignore this email.
                    </p>
                  </td>
                </tr>
                
                <!-- Footer -->
                <tr>
                  <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center; border-top: 1px solid #e4e4e7;">
                    <p style="margin: 0; color: #71717a; font-size: 12px;">
                      © ${new Date().getFullYear()} ${platformName}. All rights reserved.
                    </p>
                    <p style="margin: 8px 0 0; color: #a1a1aa; font-size: 12px;">
                      This invitation link will expire on ${expiresDate}.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    // Route through shared send-email transport so the From-line is
    // resolved from the tenant's business identity (ADR 0023). The
    // support Reply-To is applied by send-email for the user_invitation
    // category.
    const { data: sendData, error: sendErr } = await supabase.functions.invoke("send-email", {
      body: {
        to: invitation.email,
        subject: `You're invited to join ${orgName}`,
        html,
        category: "user_invitation",
        organization_id: invitation.organization_id,
        business_id: null,
        template_key: "invitation:user",
        metadata: { invitation_id: invitation.id, role: invitation.role },
      },
    });

    if (sendErr) {
      console.error("[send-invitation-email] send-email invoke failed", {
        invitation_id: invitation.id,
        to: invitation.email,
        message: sendErr.message,
      });
      return new Response(
        JSON.stringify({ error: "email_send_failed", details: sendErr.message, accept_url: acceptUrl }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }


    return new Response(JSON.stringify({ success: true, id: (sendData as any)?.id, accept_url: acceptUrl }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};

serve(handler);

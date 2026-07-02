import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requirePlatformAdmin } from "../_shared/requirePlatformAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Centralised platform-admin gate (replaces the bespoke
  // getUser → platform_admins lookup that lived here previously).
  let supabase: Awaited<ReturnType<typeof requirePlatformAdmin>>["admin"];
  let callerId: string;
  try {
    const ctx = await requirePlatformAdmin(req);
    supabase = ctx.admin;
    callerId = ctx.userId;
  } catch (e) {
    if (e instanceof Response) {
      const body = await e.text();
      return new Response(body, {
        status: e.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    throw e;
  }

  // Refetch the caller's role; the helper only confirms platform-admin
  // status, but the rest of this function still needs the role string
  // (used to gate self-elevation in `change_role`).
  const { data: callerAdmin } = await supabase
    .from("platform_admins")
    .select("id, role")
    .eq("user_id", callerId)
    .eq("is_active", true)
    .single();

  try {

    const body = await req.json();
    const { action } = body;

    if (action === "invite") {
      const { email, role, groupIds, countryCodes, notes, fullName } = body;

      if (!email || !role) {
        return new Response(JSON.stringify({ error: "Email and role required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check if already a platform admin
      const { data: existingProfile } = await supabase
        .from("profiles")
        .select("id")
        .eq("email", email.toLowerCase())
        .maybeSingle();

      if (existingProfile) {
        const { data: existingAdmin } = await supabase
          .from("platform_admins")
          .select("id")
          .eq("user_id", existingProfile.id)
          .eq("is_active", true)
          .maybeSingle();

        if (existingAdmin) {
          return new Response(JSON.stringify({ error: "User is already a platform admin" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Create invitation record
      const { data: invitation, error: inviteError } = await supabase
        .from("platform_admin_invitations")
        .insert({
          email: email.toLowerCase(),
          role,
          invited_by: callerId,
          group_ids: groupIds || [],
          country_codes: countryCodes || [],
          notes: notes || `Invited as ${role}`,
          full_name: fullName || null,
        })
        .select("id, token")
        .single();

      if (inviteError) {
        if (inviteError.code === "23505") {
          return new Response(JSON.stringify({ error: "A pending invitation already exists for this email" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw inviteError;
      }

      // If user already exists in the system, auto-accept
      if (existingProfile) {
        const { data: acceptResult } = await supabase
          .rpc("accept_platform_invitation", {
            _token: invitation.token,
            _user_id: existingProfile.id,
          });

        return new Response(JSON.stringify({
          success: true,
          autoAccepted: true,
          message: `${email} has been added as a platform ${role}`,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Audit log
      await supabase.from("admin_audit_log").insert({
        admin_user_id: callerId,
        action_type: "platform_admin_invited",
        details: { email, role, group_ids: groupIds, invitation_id: invitation.id },
      });

      // Best-effort: send the invitation email with the accept link.
      const siteUrl =
        Deno.env.get("SITE_URL") ??
        Deno.env.get("PUBLIC_SITE_URL") ??
        "https://accrualflow.systems";
      const acceptUrl = `${siteUrl.replace(/\/$/, "")}/admin-management/accept-invitation?token=${invitation.token}`;
      try {
        const html = `
          <p>Hi,</p>
          <p>You've been invited to join the platform team as <strong>${role}</strong>.</p>
          <p><a href="${acceptUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Accept invitation</a></p>
          <p>Or paste this link into your browser:<br><a href="${acceptUrl}">${acceptUrl}</a></p>
          <p>This link expires in 7 days.</p>
        `;
        const text = `You've been invited to join the platform team as ${role}.\n\nAccept here: ${acceptUrl}\n\nThis link expires in 7 days.`;
        await supabase.functions.invoke("send-platform-email", {
          body: {
            to: email.toLowerCase(),
            subject: "You've been invited to the platform team",
            htmlBody: html,
            textBody: text,
          },
        });
      } catch (mailErr) {
        console.warn("[invite-platform-admin] email send failed:", mailErr);
        // Non-fatal — the invitation row still exists and can be resent.
      }

      return new Response(JSON.stringify({
        success: true,
        autoAccepted: false,
        invitationId: invitation.id,
        message: `Invitation created for ${email}. They will be added when they sign up.`,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "resend") {
      const { invitationId } = body;

      const { data: invite, error } = await supabase
        .from("platform_admin_invitations")
        .update({
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          token: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
        })
        .eq("id", invitationId)
        .eq("status", "pending")
        .select("id")
        .single();

      if (error || !invite) {
        return new Response(JSON.stringify({ error: "Invitation not found or already accepted" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true, message: "Invitation renewed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "cancel") {
      const { invitationId } = body;

      await supabase
        .from("platform_admin_invitations")
        .update({ status: "cancelled" })
        .eq("id", invitationId)
        .eq("status", "pending");

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

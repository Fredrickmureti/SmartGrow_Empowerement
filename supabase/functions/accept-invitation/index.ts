// accept-invitation
//
// Server-authoritative invitation acceptance. Two entry points:
//
//   create-account path (anonymous):
//     POST { token, create_account: true, password, full_name }
//     → ensures auth.users + profiles, then runs the atomic accept RPC.
//
//   existing-user path (signed in):
//     POST { token } with Bearer JWT
//     → identity is derived from the JWT, NEVER trusted from the body.
//
// Legacy callers may still pass { token, user_id } but the value is ignored
// when an Authorization header is present (defense in depth).
//
// Return shape:
//   200 { success: true, organization_id, role }
//   200 { success: false, code: "login_required" | "already_member" | "email_mismatch" | "would_demote_admin" | "expired" | "invalid", error }
//
// The frontend MUST switch on `code` rather than scraping `error`.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Body {
  token?: string;
  user_id?: string; // legacy; ignored when a Bearer token is present
  create_account?: boolean;
  email?: string;
  password?: string;
  full_name?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    const body: Body = await req.json().catch(() => ({} as Body));
    const { token, create_account, email, password, full_name } = body;

    if (!token) {
      return json(400, { success: false, code: "invalid", error: "Missing invitation token" });
    }

    // Server-side identity from JWT (if any). This takes precedence over
    // any client-supplied user_id — that field is legacy and intentionally
    // ignored when a Bearer token is present.
    let callerUserId: string | null = null;
    let callerEmail: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const userClient = createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: authHeader } },
        });
        const tokenStr = authHeader.replace("Bearer ", "");
        const { data: claims } = await userClient.auth.getClaims(tokenStr);
        if (claims?.claims?.sub) {
          callerUserId = claims.claims.sub as string;
          callerEmail = (claims.claims.email as string | undefined) ?? null;
        }
      } catch (e) {
        console.warn("getClaims failed in accept-invitation", e);
      }
    }

    // Fetch and validate invitation
    const { data: invitation, error: invError } = await admin
      .from("organization_invitations")
      .select(
        "id, email, role, token, expires_at, accepted_at, organization_id, user_type, permission_group_ids, organization:organizations (id, name)",
      )
      .eq("token", token)
      .maybeSingle();

    if (invError) {
      console.error("Invitation lookup error:", invError);
      return json(500, { success: false, code: "invalid", error: "Failed to validate invitation" });
    }
    if (!invitation) {
      return json(404, { success: false, code: "invalid", error: "Invalid invitation token" });
    }
    if (new Date(invitation.expires_at) < new Date()) {
      return json(400, { success: false, code: "expired", error: "This invitation has expired" });
    }
    if (invitation.accepted_at) {
      return json(400, { success: false, code: "already_accepted", error: "This invitation has already been accepted" });
    }

    let finalUserId: string | null = callerUserId;
    const invitationUserType = invitation.user_type || "internal";

    // Create-account branch (anonymous). If a session already exists, we
    // ignore create_account=true and fall through to the existing-user path —
    // the right thing for a user who is mid-acceptance and refreshes.
    if (create_account && !callerUserId) {
      if (!email || !password || !full_name) {
        return json(400, {
          success: false,
          code: "invalid",
          error: "Missing required fields for account creation",
        });
      }
      if (email.toLowerCase() !== invitation.email.toLowerCase()) {
        return json(400, {
          success: false,
          code: "email_mismatch",
          error: `This invitation was sent to ${invitation.email}`,
        });
      }

      const { data: newUser, error: createError } = await admin.auth.admin.createUser({
        email: invitation.email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name,
          // CRITICAL: stamp account_origin so OnboardingGuard knows this
          // identity is an invited employee, not a founder. Without this
          // the user lands on /onboarding-setup and sees "could not find
          // signup setup details".
          account_origin: "invitation",
          invitation_token: invitation.token,
          onboarding_completed: true, // invited users do not run founder onboarding
        },
      });

      if (createError) {
        if (createError.message?.toLowerCase().includes("already been registered")) {
          // Auth identity already exists — switch to login_required so the
          // frontend renders the password form for this invitation.
          return json(200, {
            success: false,
            code: "login_required",
            error: "An account with this email already exists. Please sign in to accept the invitation.",
          });
        }
        return json(400, { success: false, code: "invalid", error: createError.message });
      }

      finalUserId = newUser.user!.id;

      // Profile is required by user_roles_profiles_fk. Upsert defensively.
      const { error: profileError } = await admin
        .from("profiles")
        .upsert(
          {
            user_id: finalUserId,
            email: invitation.email,
            full_name,
          } as any,
          { onConflict: "user_id" },
        );
      if (profileError) console.error("Profile upsert error:", profileError);
    }

    if (!finalUserId) {
      // Neither a signed-in caller nor a create_account request.
      return json(401, {
        success: false,
        code: "login_required",
        error: "Sign in with the invited email to accept this invitation.",
      });
    }

    // Email match verification for the existing-user path. We re-fetch
    // from auth admin if the JWT didn't expose the email claim.
    if (!create_account || callerUserId) {
      let effectiveEmail = callerEmail;
      if (!effectiveEmail) {
        const { data: userData, error: userError } = await admin.auth.admin.getUserById(finalUserId);
        if (userError || !userData?.user) {
          return json(404, { success: false, code: "invalid", error: "User not found" });
        }
        effectiveEmail = userData.user.email ?? null;
      }
      if ((effectiveEmail || "").toLowerCase() !== invitation.email.toLowerCase()) {
        return json(400, {
          success: false,
          code: "email_mismatch",
          error: `This invitation was sent to ${invitation.email}`,
        });
      }
    }

    // Atomic membership write
    const invitationGroupIds = (invitation as any).permission_group_ids || null;
    const { data: atomicResult, error: atomicError } = await admin.rpc(
      "accept_organization_invitation_atomic",
      {
        p_invitation_id: invitation.id,
        p_user_id: finalUserId,
        p_permission_group_ids: invitationGroupIds,
      },
    );

    if (atomicError) {
      console.error("Atomic accept failed:", atomicError);
      return json(500, { success: false, code: "invalid", error: atomicError.message || "Failed to accept invitation" });
    }

    if (atomicResult && (atomicResult as any).ok === false) {
      const code = (atomicResult as any).code;
      if (code === "would_demote_admin") {
        return json(409, {
          success: false,
          code,
          error:
            "This email already has internal " +
            ((atomicResult as any).existing_role || "admin") +
            " access in the workspace. A portal invitation would demote them — invite cancelled.",
        });
      }
      return json(400, { success: false, code, error: `Invitation could not be accepted (${code})` });
    }

    // Best-effort: stamp account_origin/onboarding_completed on the user
    // so any future founder-onboarding misroute is impossible.
    try {
      await admin.auth.admin.updateUserById(finalUserId, {
        user_metadata: {
          ...((await admin.auth.admin.getUserById(finalUserId)).data?.user?.user_metadata || {}),
          account_origin: "invitation",
          onboarding_completed: true,
        },
      });
    } catch (e) {
      console.warn("metadata stamp failed (non-fatal):", e);
    }

    // Informational audit log; safe with the new permissive regex CHECK.
    try {
      const org = invitation.organization as any;
      await admin.from("audit_logs").insert({
        organization_id: invitation.organization_id,
        user_id: finalUserId,
        action: "user_joined",
        entity_type: "organization",
        entity_id: invitation.organization_id,
        entity_name: org?.name || "Organization",
        changes_summary: `Joined as ${invitation.role} (${invitationUserType}) via invitation`,
      });
    } catch (auditError) {
      console.error("Audit log error:", auditError);
    }

    return json(200, {
      success: true,
      organization_id: invitation.organization_id,
      role: invitation.role,
    });
  } catch (error: any) {
    console.error("accept-invitation error:", error);
    return json(500, { success: false, code: "invalid", error: error.message });
  }
});

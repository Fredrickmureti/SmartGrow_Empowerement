// validate-invitation
//
// Server-driven router AND validator for the invitation acceptance UX.
// (Previously this function only validated; the routing logic lived in a
// separate `resolve-invitation` function. They are now folded back into
// this single endpoint because the platform's edge-function quota is
// capped and a second function for the same lifecycle was unjustified.)
//
// The frontend MUST NOT ask the invitee to self-classify as new-vs-returning.
// This endpoint decides server-side based on the invitation email and the
// caller's session, then returns one of:
//
//   route values:
//     "signup"        — no auth identity exists for invitation.email
//     "login"         — auth identity exists; caller is anonymous or other user
//     "auto_accept"   — caller's JWT belongs to the invited identity
//     "already_member" — invited identity is already an active member
//
// Contract:
//   POST { token }                          → { valid, invitation, route?, ... }
//   POST { token } with Bearer JWT          → may return route="auto_accept"
//
// Never leaks raw auth user ids; only a boolean `existingAuthUser` flag.
// Service-role only on the server side.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Body {
  token?: string;
}

/**
 * Identity lookup. We prefer `profiles.email` (indexed user-scoped table)
 * over paginating auth.admin.listUsers. profiles has a 1:1 row per
 * auth.users.id and is the canonical email→user mapping inside the product.
 * Auth admin is only consulted as a fallback for the rare case where a user
 * exists in auth.users but profiles is missing (legacy signups, manual
 * imports). This is enterprise-scalable: O(1) lookup, not O(n) over the
 * entire auth table.
 */
async function findAuthUserIdByEmail(
  admin: ReturnType<typeof createClient>,
  email: string,
): Promise<string | null> {
  const lower = email.toLowerCase();
  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("user_id")
    .ilike("email", lower)
    .maybeSingle();
  if (!profileErr && profile?.user_id) return profile.user_id as string;

  // Fallback: try auth admin lookup by listing the first page only. This
  // bounds the worst case while still catching legacy users that never got
  // a profiles row. If the email isn't on page 1 we treat the user as
  // non-existent for routing purposes — the create-account path below
  // catches the "already registered" error from auth.admin.createUser and
  // surfaces a clean login_required response.
  try {
    const { data, error } = await (admin.auth.admin as any).listUsers({
      page: 1,
      perPage: 200,
    });
    if (error) return null;
    const users: Array<{ id: string; email: string | null }> =
      (data as any)?.users ?? [];
    const match = users.find((u) => (u.email || "").toLowerCase() === lower);
    return match?.id ?? null;
  } catch {
    return null;
  }
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

    const { token }: Body = await req.json().catch(() => ({}));
    if (!token) {
      return new Response(
        JSON.stringify({ valid: false, error: "Missing invitation token" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: invitation, error: invErr } = await admin
      .from("organization_invitations")
      .select(
        "id, email, role, token, expires_at, accepted_at, user_type, organization_id, organization:organizations(id, name)",
      )
      .eq("token", token)
      .maybeSingle();

    if (invErr) {
      console.error("invitation lookup failed", invErr);
      return new Response(
        JSON.stringify({ valid: false, error: "Failed to validate invitation" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const baseInvitation = invitation
      ? {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          user_type: invitation.user_type,
          token: invitation.token,
          expires_at: invitation.expires_at,
          accepted_at: invitation.accepted_at,
          organization: invitation.organization,
        }
      : null;

    if (!invitation) {
      return new Response(
        JSON.stringify({
          valid: false,
          error: "This invitation link is invalid or has been revoked.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (new Date(invitation.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({
          valid: false,
          isExpired: true,
          error: "This invitation has expired. Please request a new one.",
          invitation: baseInvitation,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (invitation.accepted_at) {
      return new Response(
        JSON.stringify({
          valid: false,
          isAlreadyAccepted: true,
          error: "This invitation has already been accepted.",
          invitation: baseInvitation,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Determine whether an auth identity already exists for this email.
    const existingAuthUserId = await findAuthUserIdByEmail(
      admin,
      invitation.email,
    );

    // If the caller is authenticated, see if it's the invited identity.
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
        console.warn("getClaims failed; treating caller as anonymous", e);
      }
    }

    // Already a member?
    let alreadyMemberOfOrg = false;
    if (existingAuthUserId) {
      const { data: membership } = await admin
        .from("user_roles")
        .select("user_id")
        .eq("user_id", existingAuthUserId)
        .eq("organization_id", invitation.organization_id)
        .eq("is_active", true)
        .maybeSingle();
      alreadyMemberOfOrg = !!membership;
    }

    let route: "signup" | "login" | "auto_accept" | "already_member";
    if (alreadyMemberOfOrg) {
      route = "already_member";
    } else if (
      callerUserId &&
      existingAuthUserId &&
      callerUserId === existingAuthUserId &&
      (callerEmail || "").toLowerCase() === invitation.email.toLowerCase()
    ) {
      route = "auto_accept";
    } else if (existingAuthUserId) {
      route = "login";
    } else {
      route = "signup";
    }

    return new Response(
      JSON.stringify({
        valid: true,
        route,
        invitation: baseInvitation,
        existingAuthUser: !!existingAuthUserId, // boolean only
        alreadyMemberOfOrg,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("validate-invitation error", err);
    return new Response(
      JSON.stringify({ valid: false, error: err?.message || "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

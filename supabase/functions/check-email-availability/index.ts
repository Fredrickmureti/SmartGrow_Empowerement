// Public, rate-limited endpoint that tells the signup form whether an email
// already has an account — without leaking timing/enumeration via Supabase's
// silent-collision behavior on signUp.
//
// Returns:
//   {
//     exists: boolean,
//     confirmed: boolean,
//     persona?: "platform_admin" | "tenant" | "none",
//     reaped?: boolean,
//     pending_platform_invitation?: boolean
//   }
//
// NOTE: The platform-admin invitation token is intentionally NEVER returned
// here. The token is delivered via the invitation email; this endpoint only
// exposes a boolean hint so the signup form can redirect to the
// accept-invitation page where the invitee pastes the token from email.
//
// - exists=false                       → safe to call supabase.auth.signUp
// - exists=true, confirmed=true,
//   persona="tenant"                   → user has a real tenant account → bounce to /login
// - exists=true, confirmed=true,
//   persona="platform_admin"           → existing platform admin → bounce to /admin-management/login
// - exists=true, confirmed=false       → user signed up but never verified → resend verification
// - reaped=true                        → we synchronously reaped an orphaned record;
//                                        caller MAY immediately retry signUp.
//
// Rate-limited to 5 requests / minute / IP. Uses service role to read auth.users.
// Never returns the user id or any other PII.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// In-memory rate limiter — fine for a single-region Edge Function. If the
// function scales horizontally, replace with a DB-backed limiter.
const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  b.count += 1;
  if (b.count > MAX_PER_WINDOW) return true;
  return false;
}

function isValidEmail(s: unknown): s is string {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
    s.length <= 254;
}

const UNVERIFIED_REAP_AFTER_MS = 24 * 60 * 60 * 1000;        // 24h
const VERIFIED_NO_WORKSPACE_REAP_AFTER_MS = 2 * 60 * 60 * 1000; // 2h

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  if (rateLimited(ip)) {
    return new Response(
      JSON.stringify({ error: "rate_limited" }),
      {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const email = body.email?.trim().toLowerCase();
  if (!isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "invalid_email" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Pending platform-admin invitation lookup (independent of auth user
  // existence — an invitee may not yet have an auth account). The signup
  // form uses this to redirect the user to /admin-management/accept-invitation
  // instead of starting a tenant signup.
  const { data: pendingInvite } = await admin
    .from("platform_admin_invitations")
    .select("id")
    .eq("email", email)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .limit(1)
    .maybeSingle();

  // listUsers supports filtering by email since gotrue v2.155+. We page once
  // because emails are unique.
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (admin.auth.admin as any).listUsers({
    page: 1,
    perPage: 1,
    filter: `email.eq.${email}`,
  });

  if (error) {
    console.error("[check-email-availability] listUsers error:", error.message);
    return new Response(
      JSON.stringify({ error: "lookup_failed" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // Some gotrue versions return all users when filter is unsupported. Guard
  // by re-checking the email on the returned record.
  const match = (data?.users ?? []).find(
    (u: { email?: string | null }) =>
      (u.email ?? "").toLowerCase() === email,
  );

  if (!match) {
    return new Response(
      JSON.stringify({
        exists: false,
        confirmed: false,
        persona: "none",
        pending_platform_invitation: !!pendingInvite,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const matchTyped = match as {
    id: string;
    email_confirmed_at?: string | null;
    created_at?: string | null;
    user_metadata?: Record<string, unknown> | null;
    raw_user_meta_data?: Record<string, unknown> | null;
  };
  const userId = matchTyped.id;
  const confirmed = Boolean(matchTyped.email_confirmed_at);
  const createdAt = matchTyped.created_at
    ? new Date(matchTyped.created_at).getTime()
    : Date.now();
  const meta = (matchTyped.user_metadata ?? matchTyped.raw_user_meta_data ?? {}) as Record<string, unknown>;
  const doNotReap = String(meta.do_not_reap ?? "false") === "true";

  // Determine persona ──────────────────────────────────────────────
  const { data: paRow } = await admin
    .from("platform_admins")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  const isPlatformAdmin = !!paRow;

  if (isPlatformAdmin) {
    return new Response(
      JSON.stringify({
        exists: true,
        confirmed,
        persona: "platform_admin",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const { data: rolesRow } = await admin
    .from("user_roles")
    .select("user_id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const hasTenantRoles = !!rolesRow;
  const persona: "tenant" | "none" = hasTenantRoles ? "tenant" : "none";

  // ── Synchronous reap path ──────────────────────────────────────────
  // If this user is reapable RIGHT NOW (matches the same heuristics as
  // the cron job), wipe them so the caller can immediately retry signUp
  // with the same email — no 15-minute wait.
  const ageMs = Date.now() - createdAt;
  const reapableUnverified =
    !confirmed && !doNotReap && ageMs > UNVERIFIED_REAP_AFTER_MS;
  const hasPendingCompany =
    !!(meta.pending_company_name && String(meta.pending_company_name).length > 0);
  const reapableVerifiedOrphan =
    confirmed &&
    !doNotReap &&
    ageMs > VERIFIED_NO_WORKSPACE_REAP_AFTER_MS &&
    hasPendingCompany &&
    !hasTenantRoles;
  // Belt-and-braces: a *verified* user with no remaining tenancy and no
  // platform role (e.g. their workspace was deleted by a platform admin)
  // is also reapable after 1h. Without this branch the email is
  // permanently locked out (the devmuret@gmail.com bug).
  const VERIFIED_FULLY_ORPHAN_REAP_AFTER_MS = 60 * 60 * 1000; // 1h
  const reapableFullyOrphan =
    confirmed &&
    !doNotReap &&
    !hasTenantRoles &&
    !isPlatformAdmin &&
    ageMs > VERIFIED_FULLY_ORPHAN_REAP_AFTER_MS;

  if (reapableUnverified || reapableVerifiedOrphan || reapableFullyOrphan) {
    try {
      await admin.from("signup_cleanup_log").insert({
        reaped_user_id: userId,
        reaped_email: email,
        reason: reapableUnverified
          ? "unverified_expired"
          : "verified_no_workspace_expired",
        metadata: {
          synchronous: true,
          triggered_by: "check-email-availability",
          age_ms: ageMs,
        },
      });
      // deno-lint-ignore no-explicit-any
      await (admin.auth.admin as any).deleteUser(userId);
      return new Response(
        JSON.stringify({
          exists: false,
          confirmed: false,
          persona: "none",
          reaped: true,
          pending_platform_invitation: !!pendingInvite,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } catch (e) {
      console.error("[check-email-availability] sync reap failed:", e);
      // Fall through — return as if not reaped.
    }
  }

  return new Response(
    JSON.stringify({
      exists: true,
      confirmed,
      persona,
      pending_platform_invitation: !!pendingInvite,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});

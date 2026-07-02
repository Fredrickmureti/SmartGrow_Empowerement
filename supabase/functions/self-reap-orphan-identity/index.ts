// Self-serve orphan-identity reap.
//
// Lets the currently signed-in user delete their OWN auth.users row when
// they are fully orphaned: zero active user_roles, zero platform_admins,
// no pending platform-admin invitation. Used by the "Start over with this
// email" recovery flow so a user whose workspace was deleted by the
// platform admin can re-signup with the same email instead of being
// permanently locked out.
//
// Safety:
//   - Requires a valid user JWT (no anon)
//   - Re-checks orphan state via the SECURITY DEFINER `is_orphan_identity`
//     RPC. The RPC is the source of truth — this function is just the
//     gotrue bridge.
//   - Writes a signup_cleanup_log row before calling deleteUser so we
//     have an audit trail even if the deletion succeeds and the JWT
//     becomes invalid.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // User-scoped client to identify auth.uid() from the JWT.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userData.user.id;
  const email = userData.user.email ?? null;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Source of truth — the SECURITY DEFINER RPC. Service role is used so
  // the call is not subject to RLS or session GUCs.
  const { data: isOrphanData, error: isOrphanErr } = await admin.rpc(
    "is_orphan_identity",
    { p_user_id: userId },
  );

  if (isOrphanErr) {
    console.error("[self-reap-orphan-identity] is_orphan_identity error:", isOrphanErr.message);
    return new Response(
      JSON.stringify({ error: "lookup_failed" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (isOrphanData !== true) {
    return new Response(
      JSON.stringify({ reaped: false, reason: "not_orphan" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // Audit BEFORE deletion (the JWT will be invalid after).
  try {
    await admin.from("signup_cleanup_log").insert({
      reaped_user_id: userId,
      reaped_email: email,
      reason: "self_reap_orphan_identity",
      metadata: {
        triggered_by: "self-reap-orphan-identity",
        synchronous: true,
      },
    });
  } catch (e) {
    console.warn("[self-reap-orphan-identity] audit log failed (non-fatal):", e);
  }

  try {
    // deno-lint-ignore no-explicit-any
    const { error: delErr } = await (admin.auth.admin as any).deleteUser(userId);
    if (delErr) {
      console.error("[self-reap-orphan-identity] deleteUser failed:", delErr.message);
      return new Response(
        JSON.stringify({ reaped: false, error: delErr.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[self-reap-orphan-identity] deleteUser threw:", msg);
    return new Response(
      JSON.stringify({ reaped: false, error: msg }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  return new Response(
    JSON.stringify({ reaped: true, email }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});

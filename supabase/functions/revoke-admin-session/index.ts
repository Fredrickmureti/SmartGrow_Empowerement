/**
 * revoke-admin-session — sign out a single platform_admin_session OR all
 * sessions for the current admin user.
 *
 * Body: { session_id?: string, all_others?: boolean }
 *  - session_id provided ⇒ revoke that one (must belong to caller).
 *  - all_others=true     ⇒ revoke every active session except the current one.
 *
 * Auth: caller must be a platform admin.
 */
import { requirePlatformAdmin } from "../_shared/requirePlatformAdmin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Centralised platform-admin gate. Throws a Response on 401/403; we
  // catch it below and forward as-is (with this function's CORS headers).
  let ctx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    ctx = await requirePlatformAdmin(req);
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
  const { admin, userId } = ctx;

  try {
    const body = await req.json().catch(() => ({}));
    const { session_id, all_others } = body as {
      session_id?: string;
      all_others?: boolean;
    };

    let revoked = 0;

    if (all_others) {
      // Find current session (most recent active for this admin) and revoke
      // every OTHER active session for the same admin.
      const { data: latest } = await admin
        .from("platform_admin_sessions")
        .select("id")
        .eq("admin_user_id", userId)
        .eq("is_active", true)
        .order("session_started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data, error } = await admin
        .from("platform_admin_sessions")
        .update({
          is_active: false,
          expired_at: new Date().toISOString(),
          forced_logout_by: userId,
        })
        .eq("admin_user_id", userId)
        .eq("is_active", true)
        .neq("id", latest?.id ?? "00000000-0000-0000-0000-000000000000")
        .select("id");

      if (error) throw error;
      revoked = data?.length ?? 0;
    } else if (session_id) {
      // Verify ownership then revoke.
      const { data: row } = await admin
        .from("platform_admin_sessions")
        .select("id, admin_user_id")
        .eq("id", session_id)
        .maybeSingle();
      if (!row) return json({ error: "Session not found" }, 404);
      if (row.admin_user_id !== userId) {
        return json({ error: "Cannot revoke another admin's session" }, 403);
      }

      await admin
        .from("platform_admin_sessions")
        .update({
          is_active: false,
          expired_at: new Date().toISOString(),
          forced_logout_by: userId,
        })
        .eq("id", session_id);
      revoked = 1;
    } else {
      return json({ error: "Provide session_id or all_others=true" }, 400);
    }

    await admin.from("admin_audit_log").insert({
      admin_user_id: userId,
      action_type: all_others ? "admin_revoke_all_other_sessions" : "admin_revoke_session",
      details: { session_id: session_id ?? null, count: revoked },
      user_agent: req.headers.get("user-agent"),
    });

    return json({ success: true, revoked });
  } catch (err) {
    console.error("revoke-admin-session error", err);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

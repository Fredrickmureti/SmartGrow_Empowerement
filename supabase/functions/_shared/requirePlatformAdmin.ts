/**
 * requirePlatformAdmin
 *
 * Single source of truth for "this edge-function call must come from an
 * authenticated, active platform admin". Replaces the ~5-line inline pattern
 * (build user-bound client → getUser → call is_platform_admin RPC) that was
 * duplicated across ~11 admin-only edge functions.
 *
 * Returns the resolved auth.uid() and a service-role client ready for the
 * actual work. THROWS a `Response` (caller must `try { … } catch (e) { if (e
 * instanceof Response) return e; throw e; }`) — Deno.serve handlers consume
 * the thrown Response directly when wrapped that way.
 *
 * Design notes:
 *   • We deliberately re-use the existing `public.is_platform_admin(_user_id)`
 *     RPC instead of querying `platform_admins` directly. The RPC is the
 *     canonical admin check used by RLS policies — keeping all code paths on
 *     the same predicate prevents privilege drift.
 *   • CORS headers are intentionally NOT set here. Each function owns its own
 *     CORS contract; this helper only handles auth.
 *   • No logging of the bearer token, ever.
 *
 * See ADR 0004 (Platform Admin vs Tenant boundary) and ADR 0005 (Fat Edge
 * Functions) for the architectural context.
 */
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export interface AdminContext {
  /** Service-role client — bypasses RLS, use for the actual admin work. */
  admin: SupabaseClient;
  /** auth.uid() of the verified caller. */
  userId: string;
  /** Caller's email, when present in the JWT. */
  email: string | null;
}

/**
 * Verify the caller is an active platform admin.
 *
 * @throws Response  401 if no/invalid JWT, 403 if JWT is valid but not admin,
 *                   500 only on unexpected upstream errors.
 */
export async function requirePlatformAdmin(req: Request): Promise<AdminContext> {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    throw jsonResponse({ error: "Unauthorized: missing bearer token" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    throw jsonResponse({ error: "Server misconfiguration" }, 500);
  }

  // JWT-bound client — let Supabase verify the token and derive auth.uid().
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userResp, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userResp?.user) {
    throw jsonResponse({ error: "Unauthorized: invalid token" }, 401);
  }

  // Canonical admin predicate — same one RLS policies use.
  const { data: isAdmin, error: rpcErr } = await userClient.rpc(
    "is_platform_admin",
    { _user_id: userResp.user.id },
  );
  if (rpcErr) {
    throw jsonResponse({ error: "Admin check failed" }, 500);
  }
  if (!isAdmin) {
    throw jsonResponse({ error: "Forbidden: platform admin required" }, 403);
  }

  // Service-role client for the actual write work — bypasses RLS so the
  // function can read/write `platform_*` tables uniformly.
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return {
    admin,
    userId: userResp.user.id,
    email: userResp.user.email ?? null,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

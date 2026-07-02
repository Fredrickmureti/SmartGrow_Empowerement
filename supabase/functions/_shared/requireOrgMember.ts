/**
 * Shared auth gate for service-role edge functions that operate on a
 * specific organization. Verifies the bearer JWT and confirms the caller is
 * an active member of `organizationId` via `user_roles`. Server-to-server
 * callers presenting the service role key are allowed through.
 */
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

export interface RequireOrgMemberOptions {
  /** Optional list of accepted roles (e.g. ["admin", "owner"]). */
  roles?: string[];
}

export interface RequireOrgMemberResult {
  ok: true;
  userId: string | null; // null when authenticated via service-role
  userName: string | null;
  isServiceRole: boolean;
}

export interface RequireOrgMemberError {
  ok: false;
  response: Response;
}

export async function requireOrgMember(
  req: Request,
  organizationId: string | null | undefined,
  corsHeaders: Record<string, string>,
  options: RequireOrgMemberOptions = {},
): Promise<RequireOrgMemberResult | RequireOrgMemberError> {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const authHeader =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!authHeader) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "unauthorized: missing authorization header" }),
        { status: 401, headers: jsonHeaders },
      ),
    };
  }
  if (!organizationId) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "organizationId is required" }),
        { status: 400, headers: jsonHeaders },
      ),
    };
  }

  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceKey);

  if (bearer && bearer === serviceKey) {
    return { ok: true, userId: null, userName: null, isServiceRole: true };
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(bearer);
  if (userErr || !userData?.user) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      }),
    };
  }

  const userId = userData.user.id;
  const meta = (userData.user.user_metadata ?? {}) as Record<string, unknown>;
  const userName =
    (meta.full_name as string) ||
    (meta.name as string) ||
    userData.user.email ||
    null;

  let q = supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("is_active", true);

  if (options.roles && options.roles.length > 0) {
    q = q.in("role", options.roles);
  }

  const { data: roleRow } = await q.maybeSingle();

  if (!roleRow) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "forbidden: not a member of this organization" }),
        { status: 403, headers: jsonHeaders },
      ),
    };
  }

  return { ok: true, userId, userName, isServiceRole: false };
}

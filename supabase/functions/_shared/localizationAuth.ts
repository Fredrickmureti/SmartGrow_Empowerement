/**
 * Standard auth + admin gate for every localization-pack edge function.
 * Produces typed error codes so the client and the function logs can
 * tell distinct failure modes apart instead of all collapsing into an
 * opaque "401 Unauthorized".
 *
 * Used by: publish-localization-pack-version, promote-pack-version,
 *          propose-localization-upgrades.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const localizationCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export type LocalizationErrorCode =
  | "AUTH_MISSING_HEADER"
  | "AUTH_INVALID_TOKEN"
  | "AUTH_NOT_PLATFORM_ADMIN"
  | "AUTH_NO_ORG_MEMBERSHIP"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "LINT_FAILED"
  | "INTERNAL";

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...localizationCorsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(
  code: LocalizationErrorCode,
  message: string,
  status: number,
  ctx: Record<string, unknown> = {},
) {
  console.error(`[localization] ${code}: ${message}`, ctx);
  return jsonResponse({ error: message, code, ...ctx }, status);
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export interface AuthOk {
  user: { id: string; email?: string | null };
  serviceClient: SupabaseClient;
}

/**
 * Validate the caller's bearer token and return a service-role client
 * ready for elevated work. Distinct error codes for missing header vs
 * invalid token so the frontend can recover gracefully (token refresh
 * vs sign-in prompt).
 */
export async function requireAuthenticatedUser(req: Request):
  Promise<{ ok: true; auth: AuthOk } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return { ok: false, response: errorResponse("AUTH_MISSING_HEADER", "Missing authorization header", 401) };
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !userData?.user) {
    return {
      ok: false,
      response: errorResponse(
        "AUTH_INVALID_TOKEN",
        "Could not validate session token. Please sign in again.",
        401,
        { authErr: authErr?.message },
      ),
    };
  }
  const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY);
  return { ok: true, auth: { user: { id: userData.user.id, email: userData.user.email }, serviceClient } };
}

/**
 * Require the authenticated caller to be a platform admin. Returns 403
 * with AUTH_NOT_PLATFORM_ADMIN rather than 401 so the frontend can show
 * a permission message instead of a sign-in prompt.
 */
export async function requirePlatformAdmin(req: Request):
  Promise<{ ok: true; auth: AuthOk } | { ok: false; response: Response }> {
  const r = await requireAuthenticatedUser(req);
  if (!r.ok) return r;
  const { auth } = r;
  const { data: isAdmin, error } = await auth.serviceClient
    .rpc("is_platform_admin", { _user_id: auth.user.id })
    .single();
  if (error) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL",
        `Platform-admin check failed: ${error.message}`,
        500,
        { user_id: auth.user.id },
      ),
    };
  }
  if (!isAdmin) {
    return {
      ok: false,
      response: errorResponse(
        "AUTH_NOT_PLATFORM_ADMIN",
        "Platform admin required for this operation.",
        403,
        { user_id: auth.user.id },
      ),
    };
  }
  return { ok: true, auth };
}

/**
 * Phase 5: authorize a publisher action on a specific pack.
 * Platform admins always pass. Non-admins must hold an owner or publisher
 * grant in `pack_publisher_grants` for the pack's `publisher_org_id`.
 * Used by publish-, promote-, and lint- functions to support independent
 * country publishers without requiring platform-admin status.
 */
export async function requirePackPublisher(req: Request, packId: string):
  Promise<{ ok: true; auth: AuthOk } | { ok: false; response: Response }> {
  const r = await requireAuthenticatedUser(req);
  if (!r.ok) return r;
  const { auth } = r;
  const { data: ok, error } = await auth.serviceClient
    .rpc("is_pack_publisher", { _user_id: auth.user.id, _pack_id: packId })
    .single();
  if (error) {
    return {
      ok: false,
      response: errorResponse(
        "INTERNAL",
        `Publisher check failed: ${error.message}`,
        500,
        { user_id: auth.user.id, pack_id: packId },
      ),
    };
  }
  if (!ok) {
    return {
      ok: false,
      response: errorResponse(
        "AUTH_NOT_PLATFORM_ADMIN",
        "You are not authorized to publish or promote this pack.",
        403,
        { user_id: auth.user.id, pack_id: packId },
      ),
    };
  }
  return { ok: true, auth };
}

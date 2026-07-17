/**
 * apply-localization-pack-upgrade
 *
 * Thin authenticated wrapper around the apply_pack_upgrade_atomic SQL RPC.
 * Returning a typed envelope keeps the client error handling consistent with
 * the rest of the localization edge functions.
 */
import {
  localizationCorsHeaders,
  requireAuthenticatedUser,
  jsonResponse,
  errorResponse,
} from "../../_shared/localizationAuth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export async function run(req: Request): Promise<Response> {

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: localizationCorsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("BAD_REQUEST", "Method not allowed", 405);
  }

  const authResult = await requireAuthenticatedUser(req);
  if (!authResult.ok) return authResult.response;
  const { auth } = authResult;

  let body: { proposal_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
  }
  if (!body.proposal_id || typeof body.proposal_id !== "string") {
    return errorResponse("BAD_REQUEST", "proposal_id is required", 400);
  }

  // The RPC's actor check uses auth.uid() — must run as the caller, not
  // service role. We re-build a JWT-scoped client from the incoming header
  // for the RPC call itself; the service client from the helper is kept
  // available for any non-actor-bound side queries.
  const authHeader = req.headers.get("Authorization")!;
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await userClient
    .rpc("apply_pack_upgrade_atomic", { _proposal_id: body.proposal_id });

  if (error) {
    const msg = (error as any).message ?? String(error);
    const code = (error as any).code as string | undefined;
    if (code === "42501") {
      return errorResponse("AUTH_NO_ORG_MEMBERSHIP", msg, 403);
    }
    if (code === "P0002") {
      return errorResponse("NOT_FOUND", msg, 404);
    }
    return errorResponse("INTERNAL", msg, 500, { code });
  }

  return jsonResponse({ ok: true, result: data });

}


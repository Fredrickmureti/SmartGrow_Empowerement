/**
 * rollback-localization-pack-upgrade (H3)
 *
 * Reverts a previously applied pack upgrade for one org/business/pack/version
 * by calling the SQL RPC `rollback_pack_upgrade_atomic`. The RPC itself
 * enforces org membership (via auth.uid()) and refuses to clobber rules the
 * tenant has edited since the upgrade — those are recorded in
 * `pack_rule_conflicts` as `rollback_blocked`.
 */
import {
  localizationCorsHeaders,
  requireAuthenticatedUser,
  jsonResponse,
  errorResponse,
} from "../_shared/localizationAuth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: localizationCorsHeaders });
  }
  if (req.method !== "POST") {
    return errorResponse("BAD_REQUEST", "Method not allowed", 405);
  }

  const authResult = await requireAuthenticatedUser(req);
  if (!authResult.ok) return authResult.response;

  let body: {
    organization_id?: string;
    business_id?: string;
    pack_id?: string;
    from_version?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
  }

  const { organization_id, business_id, pack_id, from_version, reason } = body;
  if (!organization_id || !business_id || !pack_id || !from_version || !reason) {
    return errorResponse(
      "BAD_REQUEST",
      "organization_id, business_id, pack_id, from_version, and reason are required",
      400,
    );
  }

  // RPC checks auth.uid() membership, so run as the caller (not service role).
  const authHeader = req.headers.get("Authorization")!;
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data, error } = await userClient.rpc("rollback_pack_upgrade_atomic", {
    _organization_id: organization_id,
    _business_id: business_id,
    _pack_id: pack_id,
    _from_version: from_version,
    _reason: reason,
  });

  if (error) {
    const code = (error as any).code as string | undefined;
    const msg = (error as any).message ?? String(error);
    if (code === "42501") return errorResponse("AUTH_NO_ORG_MEMBERSHIP", msg, 403);
    if (code === "P0002") return errorResponse("NOT_FOUND", msg, 404);
    return errorResponse("INTERNAL", msg, 500, { code });
  }

  return jsonResponse({ ok: true, result: data });
});
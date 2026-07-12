/**
 * promote-pack-version — refactored to use the shared auth gate so
 * failures produce typed error codes instead of opaque 401/403s.
 *
 * Promotes a previously-published `pack_versions` row so that it
 * becomes the "current" version for either:
 *   - the caller's tenant only (`scope='self'`), OR
 *   - every tenant currently installed on the pack (`scope='all_tenants'`,
 *     requires platform admin).
 */
import {
  errorResponse,
  jsonResponse,
  localizationCorsHeaders,
  requireAuthenticatedUser,
} from "../_shared/localizationAuth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: localizationCorsHeaders });
  try {
    const gate = await requireAuthenticatedUser(req);
    if (!gate.ok) return gate.response;
    const { auth: { user, serviceClient: sb } } = gate;

    const body = await req.json().catch(() => ({}));
    const pack_id: string | undefined = body.pack_id;
    const version_id: string | undefined = body.version_id;
    const scope: "self" | "all_tenants" = body.scope === "all_tenants" ? "all_tenants" : "self";
    const notes: string | null = (body.notes ?? null) || null;
    if (!pack_id || !version_id) {
      return errorResponse("BAD_REQUEST", "pack_id and version_id are required", 400);
    }

    // Resolve target version: must belong to pack and be published.
    const { data: tgt, error: tgtErr } = await sb
      .from("pack_versions")
      .select("id, version, status, pack_id")
      .eq("id", version_id)
      .maybeSingle();
    if (tgtErr) return errorResponse("INTERNAL", tgtErr.message, 500);
    if (!tgt || tgt.pack_id !== pack_id) {
      return errorResponse("NOT_FOUND", "Version not found for this pack", 404);
    }
    if (tgt.status !== "published") {
      return errorResponse("BAD_REQUEST", "Only published versions can be promoted", 400);
    }

    // Keep pack catalog labels aligned with the promoted/current version.
    // Tenant activation still happens below on installed_localization_packs,
    // but the pack header/list should not keep showing an old catalog version.
    const { error: packVersionErr } = await sb
      .from("localization_packs")
      .update({ version: tgt.version })
      .eq("id", pack_id);
    if (packVersionErr) return errorResponse("INTERNAL", packVersionErr.message, 500);

    let installs: any[] = [];
    if (scope === "all_tenants") {
      // Phase 5: pack publisher (or platform admin) may fan out to every
      // installed tenant of THIS pack — platform-admin-only was too coarse.
      const { data: ok } = await sb
        .rpc("is_pack_publisher", { _user_id: user.id, _pack_id: pack_id })
        .single();
      if (!ok) {
        return errorResponse(
          "AUTH_NOT_PLATFORM_ADMIN",
          "You are not authorized to promote this pack for all tenants",
          403,
        );
      }
      const r = await sb
        .from("installed_localization_packs")
        .select("organization_id, business_id, pack_version")
        .eq("pack_id", pack_id);
      installs = r.data ?? [];
    } else {
      const { data: memberships } = await sb
        .from("user_roles")
        .select("organization_id")
        .eq("user_id", user.id)
        .eq("is_active", true);
      const orgIds = Array.from(
        new Set((memberships ?? []).map((m: any) => m.organization_id).filter(Boolean)),
      );
      if (orgIds.length === 0) {
        return errorResponse("AUTH_NO_ORG_MEMBERSHIP", "No organization memberships", 403);
      }
      const r = await sb
        .from("installed_localization_packs")
        .select("organization_id, business_id, pack_version")
        .eq("pack_id", pack_id)
        .in("organization_id", orgIds);
      installs = r.data ?? [];
      if (installs.length === 0) {
        return errorResponse("NOT_FOUND", "Pack not installed for caller", 404);
      }
    }

    let updated = 0;
    let proposals = 0;
    for (const inst of installs) {
      if (inst.pack_version === tgt.version) continue;
      const { error: upErr } = await sb
        .from("installed_localization_packs")
        .update({ pack_version: tgt.version })
        .eq("pack_id", pack_id)
        .eq("organization_id", inst.organization_id)
        .eq("business_id", inst.business_id);
      if (upErr) continue;
      updated++;
      const { error: pErr } = await sb.from("pack_upgrade_proposals").insert({
        organization_id: inst.organization_id,
        business_id: inst.business_id,
        pack_id,
        from_version: inst.pack_version ?? null,
        to_version: tgt.version,
        diff: { source: "promote-pack-version", scope, notes },
        status: "accepted",
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        decision_notes: notes,
      });
      if (!pErr) proposals++;
    }

    return jsonResponse({
      promoted: updated,
      proposals_logged: proposals,
      version: tgt.version,
    });
  } catch (e: any) {
    return errorResponse("INTERNAL", e?.message ?? String(e), 500);
  }
});

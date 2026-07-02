/**
 * propose-localization-upgrades
 * For a given pack, generate pack_upgrade_proposals for every tenant
 * pinned to a version older than the latest published one. Idempotent
 * (skips tenants who already have a pending proposal for the same
 * from_version → to_version).
 *
 * Body: { pack_id: uuid }
 * Returns: { proposals_created: number, skipped: number }
 *
 * Normally chained automatically by publish-localization-pack-version.
 * Exposed separately so platform admins can re-fan-out manually.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return ok({ error: "Missing authorization" }, 401);

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return ok({ error: "Unauthorized" }, 401);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: isAdmin } = await sb.rpc("is_platform_admin", { _user_id: user.id }).single();
    if (!isAdmin) return ok({ error: "Platform admin required" }, 403);

    const { pack_id } = await req.json();
    if (!pack_id) return ok({ error: "pack_id required" }, 400);

    const { data: latest } = await sb
      .from("pack_versions")
      .select("version, changelog")
      .eq("pack_id", pack_id)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) return ok({ error: "No published version exists" }, 400);

    const { data: installs } = await sb
      .from("installed_localization_packs")
      .select("organization_id, business_id, pack_version")
      .eq("pack_id", pack_id);

    let created = 0, skipped = 0;
    for (const inst of installs ?? []) {
      if (inst.pack_version === latest.version) { skipped++; continue; }

      const { data: existing } = await sb
        .from("pack_upgrade_proposals")
        .select("id")
        .eq("pack_id", pack_id)
        .eq("organization_id", inst.organization_id)
        .eq("business_id", inst.business_id)
        .eq("to_version", latest.version)
        .eq("status", "pending")
        .maybeSingle();
      if (existing) { skipped++; continue; }

      await sb.from("pack_upgrade_proposals").insert({
        organization_id: inst.organization_id,
        business_id: inst.business_id,
        pack_id,
        from_version: inst.pack_version,
        to_version: latest.version,
        diff: latest.changelog,
        status: "pending",
      });
      created++;
    }

    return ok({ proposals_created: created, skipped });
  } catch (e: any) {
    return ok({ error: e?.message ?? String(e) }, 500);
  }
});

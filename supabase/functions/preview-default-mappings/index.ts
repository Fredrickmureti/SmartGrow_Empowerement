// Preview default account mappings.
// Reads the role registry, eligibility, current mappings, and chart of accounts;
// returns a deterministic ranked proposal per role.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  proposeAllMappings,
  summariseProposals,
  type CandidateAccount,
  type EligibilityRow,
  type RoleDefinition,
} from "../_shared/mappingEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface PreviewBody {
  organization_id: string;
  business_id: string;
}

function isUuid(s: unknown): s is string {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Caller-scoped client for auth check.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthenticated" }, 401);

    const body = (await req.json().catch(() => ({}))) as Partial<PreviewBody>;
    if (!isUuid(body.organization_id) || !isUuid(body.business_id)) {
      return json({ error: "organization_id and business_id (uuid) required" }, 400);
    }

    // Service-role client for trusted reads (org membership has been validated below).
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Authorisation: the caller must be a member of the organization.
    const { data: roleRow, error: roleErr } = await adminClient
      .from("user_roles")
      .select("id")
      .eq("user_id", userData.user.id)
      .eq("organization_id", body.organization_id)
      .eq("is_active", true)
      .maybeSingle();
    if (roleErr) return json({ error: roleErr.message }, 500);
    if (!roleRow) return json({ error: "Forbidden" }, 403);

    const [rolesRes, eligRes, accountsRes, currentRes] = await Promise.all([
      adminClient.from("system_account_roles").select("*"),
      adminClient.from("account_role_eligibility").select("*"),
      adminClient
        .from("accounts")
        .select("id, code, name, account_type, detail_type, is_active, is_header, business_id")
        .eq("organization_id", body.organization_id)
        .eq("is_active", true)
        .eq("is_header", false)
        .or(`business_id.eq.${body.business_id},business_id.is.null`),
      adminClient
        .from("default_account_settings")
        .select("setting_key, account_id")
        .eq("organization_id", body.organization_id)
        .eq("business_id", body.business_id),
    ]);

    for (const r of [rolesRes, eligRes, accountsRes, currentRes]) {
      if (r.error) return json({ error: r.error.message }, 500);
    }

    const currentMappings: Record<string, string> = {};
    for (const row of currentRes.data ?? []) {
      currentMappings[row.setting_key as string] = row.account_id as string;
    }

    const proposals = proposeAllMappings(
      (rolesRes.data ?? []) as RoleDefinition[],
      (eligRes.data ?? []) as EligibilityRow[],
      (accountsRes.data ?? []) as CandidateAccount[],
      { currentMappings, currentBusinessId: body.business_id },
    );

    return json({
      proposals,
      summary: summariseProposals(proposals),
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
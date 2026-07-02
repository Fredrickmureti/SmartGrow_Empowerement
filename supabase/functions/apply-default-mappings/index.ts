// Atomically apply a set of default account mappings, recording every change
// in default_account_mapping_audit. Re-runs the engine server-side so the
// caller cannot tamper with the proposal — only confirm it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  proposeAllMappings,
  type CandidateAccount,
  type EligibilityRow,
  type RoleDefinition,
} from "../_shared/mappingEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ApplyBody {
  organization_id: string;
  business_id: string;
  /** role_key → account_id chosen by the user (overrides engine selection). Optional. */
  selections?: Record<string, string | null>;
  /** When true, only commit roles for which the engine has a non-ambiguous proposal. */
  auto_only?: boolean;
}

function isUuid(s: unknown): s is string {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthenticated" }, 401);
    const userId = userData.user.id;

    const body = (await req.json().catch(() => ({}))) as Partial<ApplyBody>;
    if (!isUuid(body.organization_id) || !isUuid(body.business_id)) {
      return json({ error: "organization_id and business_id (uuid) required" }, 400);
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Authorisation: caller must have an admin/owner-style role to mutate finance settings.
    const { data: roleRow, error: roleErr } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("organization_id", body.organization_id)
      .eq("is_active", true)
      .maybeSingle();
    if (roleErr) return json({ error: roleErr.message }, 500);
    if (!roleRow) return json({ error: "Forbidden" }, 403);

    const role = String(roleRow.role ?? "");
    const allowed = ["super_admin", "owner", "admin", "accountant"];
    if (!allowed.includes(role)) {
      return json({ error: `Role "${role}" cannot modify default account mappings` }, 403);
    }

    // Re-run the engine server-side.
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

    const selections = body.selections ?? {};
    const autoOnly = body.auto_only === true;
    const batchId = crypto.randomUUID();
    const upserts: { setting_key: string; account_id: string }[] = [];
    const auditRows: Array<Record<string, unknown>> = [];
    const skipped: Array<{ role_key: string; reason: string }> = [];

    for (const proposal of proposals) {
      const roleKey = proposal.role.role_key;
      const userPick = selections[roleKey];
      let chosenId: string | null;
      let action: "auto_mapped" | "manual" | "preserved" | "cleared";
      let confidence = proposal.selected?.confidence ?? "none";
      let score: number | null = proposal.selected?.score ?? null;
      let reason = proposal.message;

      // Decide what to commit.
      if (userPick === null) {
        // Explicit clear.
        chosenId = null;
        action = "cleared";
        reason = "Cleared by user";
      } else if (userPick && userPick !== "") {
        // Manual override — must still pass eligibility, otherwise the DB trigger rejects it.
        const candidate = (accountsRes.data ?? []).find((a) => a.id === userPick) as
          | CandidateAccount | undefined;
        if (!candidate) {
          skipped.push({ role_key: roleKey, reason: "Selected account not found in chart of accounts." });
          continue;
        }
        chosenId = userPick;
        action = "manual";
        confidence = "exact"; // user-confirmed
        score = null;
        reason = `Manually selected ${candidate.code} ${candidate.name}`;
      } else {
        // No user pick — fall back to the engine's selection.
        if (proposal.status === "preserved") {
          chosenId = proposal.current_account_id;
          action = "preserved";
        } else if (
          proposal.status === "auto_mapped" &&
          proposal.selected
        ) {
          chosenId = proposal.selected.account.id;
          action = "auto_mapped";
        } else {
          // ambiguous or missing → skip unless caller turned auto_only off (they didn't pick).
          skipped.push({
            role_key: roleKey,
            reason:
              proposal.status === "missing"
                ? "No eligible account; create one or pick manually."
                : "Ambiguous proposal; manual confirmation required.",
          });
          continue;
        }
        if (autoOnly && action === "manual") continue;
      }

      const previous = currentMappings[roleKey] ?? null;
      // No-op if the value isn't changing.
      if (previous === chosenId && action !== "manual") continue;

      if (chosenId) {
        upserts.push({ setting_key: roleKey, account_id: chosenId });
      }

      auditRows.push({
        organization_id: body.organization_id,
        business_id: body.business_id,
        role_key: roleKey,
        previous_account_id: previous,
        new_account_id: chosenId,
        action,
        confidence,
        score,
        reason,
        batch_id: batchId,
        performed_by: userId,
      });
    }

    // Apply the deletes (cleared) first, then upserts. The DB trigger on
    // default_account_settings will reject any invalid (role, account_type/detail_type) pair.
    const cleared = auditRows.filter((r) => r.action === "cleared");
    if (cleared.length > 0) {
      const keys = cleared.map((r) => r.role_key as string);
      const delRes = await adminClient
        .from("default_account_settings")
        .delete()
        .eq("organization_id", body.organization_id)
        .eq("business_id", body.business_id)
        .in("setting_key", keys);
      if (delRes.error) return json({ error: delRes.error.message }, 500);
    }

    if (upserts.length > 0) {
      const upsertRows = upserts.map((u) => ({
        organization_id: body.organization_id,
        business_id: body.business_id,
        branch_id: null,
        setting_key: u.setting_key,
        account_id: u.account_id,
      }));
      const upRes = await adminClient
        .from("default_account_settings")
        .upsert(upsertRows, { onConflict: "organization_id,business_id,branch_id,setting_key" });
      if (upRes.error) {
        // The DB trigger threw — return the message verbatim so the UI can show it.
        return json({ error: upRes.error.message, code: upRes.error.code }, 422);
      }
    }

    if (auditRows.length > 0) {
      const auditRes = await adminClient
        .from("default_account_mapping_audit")
        .insert(auditRows);
      if (auditRes.error) return json({ error: auditRes.error.message }, 500);
    }

    return json({
      batch_id: batchId,
      committed: auditRows.length,
      skipped,
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
// deno-lint-ignore-file no-explicit-any
/**
 * Nightly accounting integrity check.
 *
 * For every active organization:
 *   1. Calls `check_balance_integrity` RPC → finds accounts where
 *      stored `current_balance` drifts from posted-line ledger balance.
 *   2. Computes AR drift: sub-ledger (open invoices) vs. AR control account.
 *   3. Computes AP drift: sub-ledger (open bills) vs. AP control account.
 *   4. Inserts a row into `accounting_integrity_reports`.
 *   5. If drift > 0.01, inserts a notification for org owners.
 *
 * Triggered nightly by pg_cron (see Q-1 migration).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: orgs, error: orgsErr } = await supabase
      .from("organizations")
      .select("id, name");
    if (orgsErr) throw orgsErr;

    const results: any[] = [];

    for (const org of orgs || []) {
      // Fetch businesses for this org — each business is an independent
      // accounting boundary (Odoo-grade per-company integrity).
      const { data: businesses, error: bizErr } = await supabase
        .from("businesses")
        .select("id, name")
        .eq("organization_id", org.id);

      if (bizErr) {
        results.push({ organization_id: org.id, error: bizErr.message });
        continue;
      }

      for (const biz of businesses || []) {
        try {
          // 1. Account-level drift via RPC, scoped to this business
          const { data: drifts, error: driftErr } = await supabase.rpc(
            "check_balance_integrity",
            { _org_id: org.id, _business_id: biz.id }
          );
          if (driftErr) throw driftErr;

          // 2. AR/AP control-account reconciliation per business
          const arDrift = await computeControlDrift(supabase, org.id, biz.id, "ar");
          const apDrift = await computeControlDrift(supabase, org.id, biz.id, "ap");

          const balanceDriftsCount = (drifts || []).length;
          const totalAbsDrift =
            (drifts || []).reduce(
              (s: number, r: any) => s + Math.abs(Number(r.drift) || 0),
              0
            ) +
            Math.abs(arDrift) +
            Math.abs(apDrift);
          const hasDrift = totalAbsDrift > 0.01;

          const { data: report, error: insErr } = await supabase
            .from("accounting_integrity_reports")
            .insert({
              organization_id: org.id,
              business_id: biz.id,
              balance_drifts_count: balanceDriftsCount,
              ar_drift: arDrift,
              ap_drift: apDrift,
              total_abs_drift: totalAbsDrift,
              has_drift: hasDrift,
              details: { account_drifts: drifts || [], business_name: biz.name },
            })
            .select("id")
            .single();

          if (insErr) throw insErr;

          if (hasDrift) {
            const { data: owners } = await supabase
              .from("user_roles")
              .select("user_id")
              .eq("organization_id", org.id)
              .eq("role", "owner")
              .eq("is_active", true);

            for (const owner of owners || []) {
              await supabase.from("notifications").insert({
                user_id: owner.user_id,
                organization_id: org.id,
                type: "accounting_integrity_drift",
                title: "Accounting integrity drift detected",
                message: `Nightly check found drift of ${totalAbsDrift.toFixed(
                  2
                )} in ${biz.name} (${org.name}). Review the integrity report.`,
                metadata: {
                  report_id: report?.id,
                  business_id: biz.id,
                  total_abs_drift: totalAbsDrift,
                },
              }).then(() => null, () => null);
            }
          }

          results.push({
            organization_id: org.id,
            organization_name: org.name,
            business_id: biz.id,
            business_name: biz.name,
            balance_drifts_count: balanceDriftsCount,
            ar_drift: arDrift,
            ap_drift: apDrift,
            total_abs_drift: totalAbsDrift,
            has_drift: hasDrift,
            report_id: report?.id,
          });
        } catch (bizErr2: any) {
          console.error(
            `Org ${org.id} / Biz ${biz.id} integrity check failed:`,
            bizErr2
          );
          results.push({
            organization_id: org.id,
            business_id: biz.id,
            error: bizErr2.message,
          });
        }
      }
    }

    return new Response(JSON.stringify({ ran_at: new Date().toISOString(), results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("check-accounting-integrity fatal:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function computeControlDrift(
  supabase: any,
  orgId: string,
  businessId: string,
  type: "ar" | "ap"
): Promise<number> {
  // 1. Control account from default_account_settings (per business if available, else org fallback)
  const settingKey = type === "ar" ? "accounts_receivable" : "accounts_payable";
  const { data: setting } = await supabase
    .from("default_account_settings")
    .select("account_id")
    .eq("organization_id", orgId)
    .eq("setting_key", settingKey)
    .maybeSingle();

  if (!setting?.account_id) return 0;

  const { data: acct } = await supabase
    .from("accounts")
    .select("opening_balance, current_balance, business_id")
    .eq("id", setting.account_id)
    .maybeSingle();

  // Only reconcile if the control account belongs to this business.
  if (!acct || acct.business_id !== businessId) return 0;

  // 3. Sum sub-ledger open documents scoped to this business
  let subLedgerTotal = 0;
  if (type === "ar") {
    const { data: invs } = await supabase
      .from("invoices")
      .select("total, amount_paid")
      .eq("organization_id", orgId)
      .eq("business_id", businessId)
      .in("status", ["sent", "viewed", "overdue", "partial", "confirmed"]);
    subLedgerTotal = (invs || []).reduce(
      (s: number, i: any) => s + (Number(i.total) || 0) - (Number(i.amount_paid) || 0),
      0
    );
  } else {
    const { data: bills } = await supabase
      .from("bills")
      .select("total, amount_paid")
      .eq("organization_id", orgId)
      .eq("business_id", businessId)
      .in("status", ["received", "partial", "overdue"]);
    subLedgerTotal = (bills || []).reduce(
      (s: number, b: any) => s + (Number(b.total) || 0) - (Number(b.amount_paid) || 0),
      0
    );
  }

  const stored = Number(acct?.current_balance) || 0;
  const compareStored = type === "ar" ? stored : Math.abs(stored);
  return subLedgerTotal - compareStored;
}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * run-depreciation
 * 
 * Automated monthly depreciation posting edge function.
 * Can be triggered via cron or manually.
 * 
 * POST body: { organization_id, period_date, business_id? }
 * - organization_id: required
 * - period_date: YYYY-MM-DD (any day in the target month)
 * - business_id: optional filter
 */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { organization_id, period_date, business_id } = await req.json();

    if (!organization_id || !period_date) {
      return new Response(
        JSON.stringify({ error: "organization_id and period_date are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // AUTH GATE: require an admin/owner member of the org, or the cron
    // scheduler presenting the service-role key.
    const { requireOrgMember } = await import("../_shared/requireOrgMember.ts");
    const authResult = await requireOrgMember(req, organization_id, corsHeaders, {
      roles: ["owner", "admin"],
    });
    if (!authResult.ok) return authResult.response;

    // ─── Subscription entitlement check ───
    {
      const { checkSubscriptionActive, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
      const subResult = await checkSubscriptionActive(supabase, organization_id);
      if (!subResult.allowed) return entitlementDeniedResponse(subResult, corsHeaders);
    }

    const periodDate = new Date(period_date);
    const periodStart = new Date(periodDate.getFullYear(), periodDate.getMonth(), 1);
    const periodEnd = new Date(periodDate.getFullYear(), periodDate.getMonth() + 1, 0);
    const periodStartStr = periodStart.toISOString().split("T")[0];
    const periodEndStr = periodEnd.toISOString().split("T")[0];

    // Check fiscal period lock
    const { data: lockedPeriods } = await supabase
      .from("fiscal_periods")
      .select("id")
      .eq("organization_id", organization_id)
      .eq("status", "closed")
      .lte("start_date", periodEndStr)
      .gte("end_date", periodStartStr)
      .limit(1);

    if (lockedPeriods && lockedPeriods.length > 0) {
      return new Response(
        JSON.stringify({ error: `Fiscal period for ${period_date} is closed` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch active assets
    let assetQuery = supabase
      .from("fixed_assets")
      .select("*, category:asset_categories(*)")
      .eq("organization_id", organization_id)
      .eq("status", "active");

    if (business_id) {
      assetQuery = assetQuery.eq("business_id", business_id);
    }

    const { data: assets, error: assetError } = await assetQuery;
    if (assetError) throw assetError;

    // Resolve fallback depreciation accounts from default_account_settings
    // (single source of truth — replaces legacy gl_transaction_mappings).
    let fallbackDepAccountId: string | null = null;
    let fallbackAccumAccountId: string | null = null;
    {
      let q = supabase
        .from("default_account_settings")
        .select("setting_key, account_id, business_id")
        .eq("organization_id", organization_id)
        .in("setting_key", ["depreciation_expense", "accumulated_depreciation"]);
      if (business_id) {
        q = q.or(`business_id.is.null,business_id.eq.${business_id}`);
      }
      const { data: rows } = await q;
      for (const r of (rows || []) as Array<{ setting_key: string; account_id: string; business_id: string | null }>) {
        if (r.setting_key === "depreciation_expense") fallbackDepAccountId = r.account_id;
        else if (r.setting_key === "accumulated_depreciation") fallbackAccumAccountId = r.account_id;
      }
    }

    const results = {
      processed: 0,
      posted: 0,
      skipped: 0,
      errors: [] as string[],
      totalAmount: 0,
    };

    for (const asset of assets || []) {
      const bookValue = asset.book_value ?? (asset.purchase_price - asset.accumulated_depreciation);
      if (bookValue <= asset.residual_value) {
        results.skipped++;
        continue;
      }

      // Check if already posted
      const { data: existing } = await supabase
        .from("depreciation_schedules")
        .select("id")
        .eq("asset_id", asset.id)
        .eq("period_start", periodStartStr)
        .eq("is_posted", true)
        .maybeSingle();

      if (existing) {
        results.skipped++;
        continue;
      }

      // Calculate depreciation
      const usefulLifeYears = asset.useful_life_years || 5;
      const residualValue = asset.residual_value || 0;
      const method = asset.depreciation_method || "straight_line";
      let monthlyDep = 0;

      if (method === "straight_line") {
        const depreciable = asset.purchase_price - residualValue;
        monthlyDep = depreciable / (usefulLifeYears * 12);
      } else {
        const rate = asset.category?.depreciation_rate || (100 / usefulLifeYears);
        monthlyDep = (bookValue * (rate / 100)) / 12;
      }

      monthlyDep = Math.min(Math.round(monthlyDep * 100) / 100, bookValue - residualValue);
      if (monthlyDep <= 0) {
        results.skipped++;
        continue;
      }

      const depAccountId = asset.category?.depreciation_account_id || fallbackDepAccountId;
      const accumAccountId = asset.category?.accumulated_depreciation_account_id || fallbackAccumAccountId;

      if (!depAccountId || !accumAccountId) {
        results.errors.push(`${asset.asset_number}: Missing GL account mappings`);
        continue;
      }

      // Get next JE number
      const { data: jeNumber } = await supabase.rpc("get_next_journal_entry_number", {
        _org_id: organization_id,
      });

      // Post via atomic RPC
      const { data: jeId, error: postError } = await supabase.rpc("post_journal_entry_atomic", {
        _org_id: organization_id,
        _business_id: business_id || asset.business_id || null,
        _entry_number: String(jeNumber) || `DEP-${Date.now()}`,
        _entry_date: periodEndStr,
        _reference: `DEP-${asset.asset_number}-${periodDate.getFullYear()}-${String(periodDate.getMonth() + 1).padStart(2, "0")}`,
        _description: `Monthly depreciation: ${asset.name}`,
        _source_type: "depreciation",
        _source_id: asset.id,
        _created_by: null,
        _is_closing: false,
        _is_adjusting: false,
        _lines: [
          { account_id: depAccountId, debit: monthlyDep, credit: 0, description: `Depreciation expense - ${asset.name}` },
          { account_id: accumAccountId, debit: 0, credit: monthlyDep, description: `Accumulated depreciation - ${asset.name}` },
        ],
      });

      if (postError) {
        results.errors.push(`${asset.asset_number}: ${postError.message}`);
        continue;
      }

      // Record schedule
      const newAccumulated = (asset.purchase_price - bookValue) + monthlyDep;
      const newBookValue = Math.max(asset.purchase_price - newAccumulated, residualValue);

      await supabase.from("depreciation_schedules").insert({
        organization_id,
        asset_id: asset.id,
        period_start: periodStartStr,
        period_end: periodEndStr,
        depreciation_amount: monthlyDep,
        accumulated_depreciation: newAccumulated,
        book_value: newBookValue,
        journal_entry_id: jeId,
        is_posted: true,
        posted_at: new Date().toISOString(),
      });

      // Update asset
      await supabase
        .from("fixed_assets")
        .update({ accumulated_depreciation: newAccumulated, book_value: newBookValue })
        .eq("id", asset.id);

      results.posted++;
      results.totalAmount += monthlyDep;
      results.processed++;
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

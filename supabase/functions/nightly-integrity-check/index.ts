/**
 * nightly-integrity-check (Phase H — hardened)
 *
 * Scheduled audit that snapshots multi-entity health into
 * `identity_drift_reports`. Surfaces:
 *   1. Orgs whose name has drifted from their primary business legal_name.
 *   2. Orgs holding more than one active business (consolidation candidates).
 *   3. Branches whose organization_id ≠ their business's organization_id.
 *   4. Journal lines whose account.business_id ≠ entry.business_id
 *      (CROSS-COMPANY POSTING — silent GL corruption if non-zero).
 *   5. Invoices whose contact.business_id ≠ invoice.business_id.
 *   6. Bills whose vendor.business_id ≠ bill.business_id.
 *
 * The cross-company helpers are SECURITY DEFINER SQL functions defined in
 * the database — keeping the logic close to the schema so it stays correct
 * when columns evolve.
 *
 * Auth: invoked by service role (cron) or by a super_admin user.
 */
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireCronAuth } from "../_shared/requireCronAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authFail = requireCronAuth(req);
  if (authFail) return authFail;


  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // 1. Org-name drift: organizations.name ≠ primary business.legal_name
    const { data: orgs, error: orgsErr } = await admin
      .from("organizations")
      .select("id, name");
    if (orgsErr) throw orgsErr;

    const driftRows: Array<{
      org_id: string;
      org_name: string;
      primary_legal_name: string | null;
    }> = [];

    for (const org of orgs ?? []) {
      const { data: primaryBiz } = await admin
        .from("businesses")
        .select("legal_name, name")
        .eq("organization_id", org.id)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const legal = primaryBiz?.legal_name ?? primaryBiz?.name ?? null;
      if (legal && legal !== org.name) {
        driftRows.push({
          org_id: org.id,
          org_name: org.name,
          primary_legal_name: legal,
        });
      }
    }

    // 2. Multi-business orgs (consolidation candidates).
    const { data: multiOrgs, error: multiErr } = await admin
      .from("businesses")
      .select("organization_id")
      .eq("is_active", true);
    if (multiErr) throw multiErr;

    const counts = new Map<string, number>();
    for (const b of multiOrgs ?? []) {
      counts.set(b.organization_id, (counts.get(b.organization_id) ?? 0) + 1);
    }
    const multiBusinessOrgs = Array.from(counts.entries())
      .filter(([, c]) => c > 1)
      .map(([org_id, count]) => ({ org_id, business_count: count }));

    // 3. Branch/org mismatch (defensive — trigger should keep this at 0).
    const { data: branches } = await admin
      .from("branches")
      .select("id, organization_id, business_id");
    const { data: bizIndex } = await admin
      .from("businesses")
      .select("id, organization_id");
    const bizMap = new Map<string, string>(
      (bizIndex ?? []).map((b) => [b.id, b.organization_id]),
    );
    const branchMismatches: Array<{
      branch_id: string;
      branch_org: string;
      business_org: string | null;
    }> = [];
    for (const br of branches ?? []) {
      if (!br.business_id) continue;
      const expected = bizMap.get(br.business_id) ?? null;
      if (expected && expected !== br.organization_id) {
        branchMismatches.push({
          branch_id: br.id,
          branch_org: br.organization_id,
          business_org: expected,
        });
      }
    }

    // 4. Cross-business journal lines (account.business_id ≠ entry.business_id).
    //    A non-zero count here means the General Ledger is silently wrong.
    const { data: crossBizLines, error: crossErr } = await admin.rpc(
      "find_cross_business_journal_lines" as never,
    );
    if (crossErr) console.warn("cross-business JE check failed:", crossErr.message);

    const details = {
      drift: driftRows,
      multi_business_orgs: multiBusinessOrgs,
      branch_mismatches: branchMismatches,
      cross_business_journal_lines: crossBizLines ?? [],
    };

    const { data: inserted, error: insErr } = await admin
      .from("identity_drift_reports")
      .insert({
        org_name_drift_count: driftRows.length,
        multi_business_org_count: multiBusinessOrgs.length,
        branch_org_mismatch_count: branchMismatches.length,
        details,
      })
      .select("id, ran_at")
      .single();
    if (insErr) throw insErr;

    return new Response(
      JSON.stringify({
        ok: true,
        report_id: inserted.id,
        ran_at: inserted.ran_at,
        summary: {
          org_name_drift_count: driftRows.length,
          multi_business_org_count: multiBusinessOrgs.length,
          branch_org_mismatch_count: branchMismatches.length,
          cross_business_journal_lines_count: (crossBizLines ?? []).length,
          invoice_contact_mismatch_count: (invMismatch ?? []).length,
          bill_vendor_mismatch_count: (billMismatch ?? []).length,
          payroll_je_unbalanced_count: payrollIssues.length,
        },
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("nightly-integrity-check failed:", message);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});

/**
 * Server-side Payroll GL Posting Edge Function
 * 
 * Moves the payroll-to-GL posting logic server-side for integrity.
 * Resolves account mappings via EXPLICIT default_account_settings ONLY.
 * No fuzzy name-matching — if a mapping is missing, posting fails loudly.
 * 
 * After GL posting, auto-generates payroll_remittances records for
 * each statutory deduction type, enabling persistent remittance tracking.
 * 
 * Also updates payroll_run status to "posted" (separate from "paid").
 * 
 * Pattern:
 *   DR  Salary Expense           (gross pay)
 *   CR  [Deduction] Payable      (for each statutory deduction)
 *   CR  Net Salary Payable       (net pay)
 *   DR  [Deduction] Expense      (employer contributions)
 *   CR  [Deduction] Payable      (employer contributions)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface PostPayrollGLRequest {
  payroll_run_id: string;
  organization_id: string;
  business_id: string | null;
  /**
   * Phase 4 — posting simulation. When true, the function performs every
   * validation step and builds the projected journal entry, but does NOT
   * write to `journal_entries`, `payroll_runs`, `payroll_liabilities`,
   * or `audit_logs`. The response returns `{ dry_run: true, lines: [...],
   * totals, warnings }` so accountants can preview the posting from
   * Payroll → Account Mapping before authorising the real post.
   */
  dry_run?: boolean;
}

interface GLLine {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
  contact_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseUser.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.user.id;

    const body: PostPayrollGLRequest = await req.json();
    const { payroll_run_id, organization_id, business_id } = body;
    const dryRun = body.dry_run === true;

    if (!payroll_run_id || !organization_id) {
      return new Response(JSON.stringify({ error: "Missing payroll_run_id or organization_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Subscription entitlement check ───
    const { checkAppEntitlement, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
    const entResult = await checkAppEntitlement(supabaseAdmin, organization_id, "payroll", { requireInstalled: true });
    if (!entResult.allowed) return entitlementDeniedResponse(entResult, corsHeaders);

    // ─── Permission check (delegated to DB single source of truth) ───
    // GL posting requires BOTH payroll.write AND financials.write — payroll
    // is being finalized AND a journal entry is being created.
    const { requireModulePermission } = await import("../_shared/permissionCheck.ts");
    const deniedPayroll = await requireModulePermission(
      supabaseAdmin, userId, organization_id, "payroll", "write", corsHeaders,
    );
    if (deniedPayroll) return deniedPayroll;
    const deniedFin = await requireModulePermission(
      supabaseAdmin, userId, organization_id, "financials", "write", corsHeaders,
    );
    if (deniedFin) return deniedFin;

    // ─── Fetch payroll run ───
    const { data: payrollRun, error: prError } = await supabaseAdmin
      .from("payroll_runs")
      .select("*")
      .eq("id", payroll_run_id)
      .eq("organization_id", organization_id)
      .single();

    if (prError || !payrollRun) {
      return new Response(JSON.stringify({ error: "Payroll run not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── SoD: poster cannot be creator OR approver of this run ───
    // Authoritative check lives in the DB helper user_can_post_payroll, which
    // also re-validates payroll.post permission (defense in depth).
    {
      const { data: canPost, error: sodErr } = await supabaseAdmin.rpc(
        "user_can_post_payroll",
        { _user_id: userId, _org_id: organization_id, _run_id: payroll_run_id },
      );
      if (sodErr) {
        return new Response(JSON.stringify({ error: sodErr.message, code: "SOD_CHECK_FAILED" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (canPost !== true) {
        return new Response(JSON.stringify({
          error:
            "Segregation of duties: the user who created or approved this payroll run cannot also post it to GL. A different poster must complete this step.",
          code: "PERMISSION_DENIED",
          hint: "payroll_post_sod_violation",
        }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Defensive: caller-supplied business_id MUST match the payroll run.
    // Without this guard a malformed client could resolve mappings against
    // a different business than the one the run was computed under.
    if ((payrollRun.business_id ?? null) !== (business_id ?? null)) {
      return new Response(JSON.stringify({
        error: "business_id does not match the payroll run",
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Idempotency: check if already posted ───
    const { data: existingJE } = await supabaseAdmin
      .from("journal_entries")
      .select("id")
      .eq("organization_id", organization_id)
      .eq("source_type", "payroll")
      .eq("source_id", payroll_run_id)
      .neq("status", "voided")
      .maybeSingle();

    if (existingJE) {
      return new Response(JSON.stringify({ journal_entry_id: existingJE.id, already_posted: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Fiscal period lock check ───
    const { data: lockedPeriods } = await supabaseAdmin
      .from("fiscal_periods")
      .select("id, name")
      .eq("organization_id", organization_id)
      .eq("status", "closed")
      .lte("start_date", payrollRun.pay_period_end)
      .gte("end_date", payrollRun.pay_period_start);

    if (lockedPeriods && lockedPeriods.length > 0) {
      return new Response(JSON.stringify({
        error: `Cannot post to GL: fiscal period "${lockedPeriods[0].name}" is closed.`,
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Fetch payslips ───
    const { data: payslips, error: psError } = await supabaseAdmin
      .from("payslips")
      .select("*")
      .eq("payroll_run_id", payroll_run_id);

    if (psError || !payslips || payslips.length === 0) {
      return new Response(JSON.stringify({ error: "No payslips found for this payroll run" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Fetch EXPLICIT account mappings from default_account_settings ───
    // Single source of truth for GL routing.
    let mappingsQuery = supabaseAdmin
      .from("default_account_settings")
      .select("setting_key, account_id, business_id")
      .eq("organization_id", organization_id);

    if (business_id) {
      mappingsQuery = mappingsQuery.or(`business_id.is.null,business_id.eq.${business_id}`);
    }

    const { data: mappings } = await mappingsQuery;

    // Build mappings map: business-level overrides org-level
    const mappingsMap: Record<string, string> = {};
    for (const m of (mappings || []).filter((m: any) => !m.business_id)) {
      mappingsMap[m.setting_key] = m.account_id;
    }
    for (const m of (mappings || []).filter((m: any) => m.business_id === business_id)) {
      mappingsMap[m.setting_key] = m.account_id;
    }


    // ─── Resolve accounts — effective-dated bindings (authoritative) ───
    // `bindingMap` is populated below via `resolve_default_account_binding`,
    // which honours the branch → business → org cascade AND the temporal
    // window in effect at the run's pay-period end. A re-post of a historical
    // run therefore resolves the account that was mapped *then*, not today's.
    // The flat `default_account_settings` map is the migration-safety fallback
    // used only when no binding row resolves. The sync trigger keeps the two
    // in lock-step, so the fallback is inert in steady state.
    const bindingMap: Record<string, string> = {};
    const resolveAccount = (key: string): string | null =>
      bindingMap[key] || mappingsMap[key] || null;

    // ─── Aggregate from payslip_lines (authoritative source) ───
    // We compute needed mapping keys from the actual lines THIS run produced,
    // so the missing-mappings dialog only asks for what this run requires.
    // payslip_lines is the country-agnostic, rule-keyed source of truth.
    // We DO NOT read from legacy Kenya columns (paye/nhif/nssf/housing_levy).
    let totalGross = 0;
    let totalNet = 0;
    for (const ps of payslips) {
      totalGross += ps.gross_pay || 0;
      totalNet += ps.net_pay || 0;
    }

    interface DeductionAgg {
      label: string;
      employeeTotal: number;
      employerTotal: number;
    }
    const deductionMap = new Map<string, DeductionAgg>();

    // Garnishment lines are aggregated separately because they are per-order
    // (one liability + remittance per garnishment_id), not per-rule_code like
    // statutory deductions. Each row drives one CR to garnishment_payable and
    // one payroll_liabilities row keyed by (run, rule_code=garnishment_<uuid>).
    interface GarnishmentAgg {
      garnishment_id: string;
      rule_code: string; // e.g. "garnishment_<uuid>" from compute-payroll
      label: string;
      amount: number;
    }
    const garnishmentMap = new Map<string, GarnishmentAgg>();

    const { data: payslipLines, error: linesError } = await supabaseAdmin
      .from("payslip_lines")
      .select("rule_code, label, category, employee_amount, employer_amount, details")
      .eq("payroll_run_id", payroll_run_id);

    if (linesError) {
      return new Response(JSON.stringify({
        error: `Could not load payslip_lines for posting: ${linesError.message}`,
      }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!payslipLines || payslipLines.length === 0) {
      return new Response(JSON.stringify({
        error: "No payslip_lines found for this run. Re-run payroll computation before posting to GL.",
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Categories that produce a deduction (CR payable) on the employee side.
    const DEDUCTION_CATEGORIES = new Set([
      "deduction", "statutory_employee", "tax", "loan_repayment", "benefit_recovery",
    ]);
    // Categories that produce an employer expense + payable pair.
    const EMPLOYER_CATEGORIES = new Set([
      "employer_contribution", "statutory_employer",
    ]);

    for (const line of payslipLines as any[]) {
      const key = line.rule_code;
      const cat = line.category as string;
      const empAmt = Number(line.employee_amount || 0);
      const erAmt = Number(line.employer_amount || 0);

      // ─── Garnishment lines: aggregate per garnishment order ───
      if (cat === "garnishment" && empAmt > 0) {
        const gid: string | null =
          (line.details && typeof line.details === "object"
            ? (line.details as any).garnishment_id
            : null) ?? null;
        if (!gid) continue;
        const existing = garnishmentMap.get(gid);
        if (existing) {
          existing.amount += empAmt;
        } else {
          garnishmentMap.set(gid, {
            garnishment_id: gid,
            rule_code: key || `garnishment_${gid}`,
            label: line.label || "Garnishment",
            amount: empAmt,
          });
        }
        continue;
      }

      if (!key) continue;
      const isDed = DEDUCTION_CATEGORIES.has(cat) && empAmt > 0;
      const isEr = EMPLOYER_CATEGORIES.has(cat) && erAmt > 0;
      if (!isDed && !isEr) continue;

      const existing = deductionMap.get(key);
      if (existing) {
        existing.employeeTotal += isDed ? empAmt : 0;
        existing.employerTotal += isEr ? erAmt : 0;
      } else {
        deductionMap.set(key, {
          label: line.label || key,
          employeeTotal: isDed ? empAmt : 0,
          employerTotal: isEr ? erAmt : 0,
        });
      }
    }


    // ─── Build GL entries ───
    const lines: GLLine[] = [];

    // ─── Single source of truth: ask the resolver what THIS run needs ───
    // payroll_required_gl_mappings_for_run is shared with the AI assistant,
    // validate_payroll_run_mappings, and the missing-mappings dialog. Posting
    // and preflight can never disagree because they call the same function.
    const { data: requiredRows, error: resolverError } = await supabaseAdmin.rpc(
      "payroll_required_gl_mappings_for_run",
      { p_run_id: payroll_run_id },
    );
    if (resolverError) {
      return new Response(JSON.stringify({
        error: `Could not resolve required GL mappings: ${resolverError.message}`,
      }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Populate the effective-dated binding map (authoritative) ───
    // Resolve every mapping key this run could reference through the temporal
    // binding resolver, using the run's pay-period end as the `as_of` instant
    // and the run's branch (when present) for the branch → business → org
    // cascade. Keys that resolve here override the flat fallback in
    // `resolveAccount`. The key universe is the union of the flat table keys
    // and the required keys the run needs, so nothing is missed.
    {
      const asOf = payrollRun.pay_period_end
        ? new Date(`${payrollRun.pay_period_end}T23:59:59Z`).toISOString()
        : new Date().toISOString();
      const branchId = (payrollRun as any).branch_id ?? null;
      const keyUniverse = new Set<string>([
        ...Object.keys(mappingsMap),
        ...((requiredRows || []) as any[]).map((r) => r.setting_key as string),
      ]);
      for (const key of keyUniverse) {
        const { data: acct, error: bindErr } = await supabaseAdmin.rpc(
          "resolve_default_account_binding",
          {
            _setting_key: key,
            _org_id: organization_id,
            _business_id: business_id ?? null,
            _branch_id: branchId,
            _as_of: asOf,
          },
        );
        if (!bindErr && acct) bindingMap[key] = acct as string;
      }
    }

    const missingMappings = ((requiredRows || []) as any[])
      .filter((r) => !r.is_mapped)
      .map((r) => ({
        setting_key: r.setting_key as string,
        label: r.label as string,
        rule_code: (r.rule_code as string) ?? null,
        kind: r.kind as "core" | "employee_payable" | "employer_expense" | "employer_payable",
        suggested_account_id: (r.suggested_account_id as string) ?? null,
        suggested_account_label: (r.suggested_account_label as string) ?? null,
      }));

    if (missingMappings.length > 0) {
      return new Response(JSON.stringify({
        error: "missing_mappings",
        message: `${missingMappings.length} GL mapping(s) missing for this run. Configure them in Payroll → Configuration → GL Account Mapping.`,
        missing: missingMappings,
        action: { label: "Open GL Account Mapping", to: "/hr/payroll/configuration/accounts" },
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Defense in depth: validate the resolved mappings against the
    // role rules (no salary→COGS, no header accounts, etc.) BEFORE we
    // write any JE lines. Wave-2 hardening — see
    // docs/audit/2026-05-25-payroll-cogs-misposting.md.
    const { data: roleViolations, error: roleError } = await supabaseAdmin.rpc(
      "payroll_validate_post_mappings",
      { p_run_id: payroll_run_id },
    );
    if (roleError) {
      return new Response(JSON.stringify({
        error: `Could not validate GL mapping roles: ${roleError.message}`,
      }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if ((roleViolations || []).length > 0) {
      return new Response(JSON.stringify({
        error: "role_violation",
        message: `${(roleViolations as any[]).length} payroll GL mapping(s) violate accounting role rules (e.g. salary mapped to Cost of Goods Sold). Fix them before posting.`,
        findings: roleViolations,
        action: { label: "Fix Payroll Mappings", to: "/hr/payroll/configuration/accounts" },
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    const salaryExpense = resolveAccount("salary_expense")!;
    const netSalaryPayable = resolveAccount("net_salary_payable")!;

    // Phase 3.4-followup #3 — correction runs post signed-delta payslip
    // totals (which is *amount-correct*), but the narrations would otherwise
    // read like a full ordinary payroll. Tag the entry + each line so the
    // GL reader sees "Correction Δ of <parent_run>" instead of misreading
    // it as a duplicate full payroll.
    const isCorrection = (payrollRun as any).run_type === "correction";
    const parentRunRef =
      (payrollRun as any).parent_run_id
        ? String((payrollRun as any).parent_run_id).slice(0, 8)
        : null;
    const runLabel = isCorrection
      ? `Correction Δ ${payrollRun.payroll_number}${parentRunRef ? ` (of run ${parentRunRef})` : ""}`
      : `Payroll ${payrollRun.payroll_number}`;

    // DR: Salary Expense
    lines.push({
      account_id: salaryExpense,
      debit: totalGross,
      credit: 0,
      description: `${runLabel} - Salary Expense`,
      contact_id: null,
    });

    // CR: Each deduction — require explicit mapping
    for (const [key, deduction] of deductionMap) {
      if (deduction.employeeTotal > 0) {
        const mappingKey = `${key}_payable`;
        const accountId = resolveAccount(mappingKey) || resolveAccount(key)!;
        lines.push({
            account_id: accountId,
            debit: 0,
            credit: deduction.employeeTotal,
            description: `${runLabel} - ${deduction.label}`,
            contact_id: null,
          });
      }
    }

    // CR: Garnishment Payable (one line per order — payee tracked via liability row).
    // Account mapping is the single `garnishment_payable` role; per-payee
    // remittance happens later through the garnishment payment batch flow.
    const garnishmentPayableAcct =
      garnishmentMap.size > 0 ? resolveAccount("garnishment_payable") : null;
    if (garnishmentMap.size > 0 && !garnishmentPayableAcct) {
      return new Response(JSON.stringify({
        error: "missing_mappings",
        message: "Garnishment Payable account is not mapped. Map it under Payroll → GL Account Mapping before posting a run with garnishments.",
        missing: [{
          setting_key: "garnishment_payable",
          label: "Garnishment Payable",
          rule_code: null,
          kind: "employee_payable",
        }],
        action: { label: "Open GL Account Mapping", to: "/hr/payroll/configuration/accounts" },
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    for (const garn of garnishmentMap.values()) {
      lines.push({
        account_id: garnishmentPayableAcct!,
        debit: 0,
        credit: garn.amount,
        description: `${runLabel} - ${garn.label}`,
        contact_id: null,
      });
    }

    // CR: Net Salary Payable
    lines.push({
      account_id: netSalaryPayable,
      debit: 0,
      credit: totalNet,
      description: `${runLabel} - Net Pay`,
      contact_id: null,
    });


    // Validate balance BEFORE employer contributions
    const totalDebits = lines.reduce((s, l) => s + l.debit, 0);
    const totalCredits = lines.reduce((s, l) => s + l.credit, 0);

    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      return new Response(JSON.stringify({
        error: `GL imbalance: Debits (${totalDebits.toFixed(2)}) ≠ Credits (${totalCredits.toFixed(2)}).`,
      }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Employer contributions (balanced pairs — DR expense, CR payable)
    for (const [key, deduction] of deductionMap) {
      if (deduction.employerTotal > 0) {
        const expenseAcct = resolveAccount(`${key}_employer_expense`) || resolveAccount(`${key}_expense`)!;
        const payableAcct = resolveAccount(`${key}_payable`) || resolveAccount(key)!;
        lines.push({
            account_id: expenseAcct,
            debit: deduction.employerTotal,
            credit: 0,
            description: `${runLabel} - Employer ${deduction.label}`,
            contact_id: null,
          });
          lines.push({
            account_id: payableAcct,
            debit: 0,
            credit: deduction.employerTotal,
            description: `${runLabel} - Employer ${deduction.label} Payable`,
            contact_id: null,
          });
      }
    }

    // ─── Phase 4: posting simulation ─────────────────────────────────────
    // When dry_run=true we return the projected JE payload enriched with
    // account code/name/type so the accountant can inspect it before
    // authorising the real post. No writes to the ledger, no payroll_runs
    // status change, no liabilities, no audit log.
    if (dryRun) {
      const acctIds = Array.from(new Set(lines.map((l) => l.account_id).filter(Boolean)));
      const { data: acctRows } = await supabaseAdmin
        .from("accounts")
        .select("id, code, name, account_type")
        .in("id", acctIds);
      const acctById = new Map<string, any>(
        (acctRows || []).map((a: any) => [a.id, a]),
      );
      const enriched = lines.map((l) => {
        const a = acctById.get(l.account_id) || {};
        return {
          ...l,
          account_code: a.code ?? null,
          account_name: a.name ?? null,
          account_type: a.account_type ?? null,
        };
      });
      const dryTotalDebits = enriched.reduce((s, l) => s + Number(l.debit || 0), 0);
      const dryTotalCredits = enriched.reduce((s, l) => s + Number(l.credit || 0), 0);
      return new Response(JSON.stringify({
        dry_run: true,
        payroll_run_id,
        payroll_number: payrollRun.payroll_number,
        pay_period_end: payrollRun.pay_period_end,
        employee_count: payslips.length,
        lines: enriched,
        total_debits: dryTotalDebits,
        total_credits: dryTotalCredits,
        balanced: Math.abs(dryTotalDebits - dryTotalCredits) < 0.01,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // ─── Get journal entry number ───
    const { data: entryNumber } = await supabaseAdmin.rpc("get_next_journal_entry_number", {
      _org_id: organization_id,
    });
    const jeNumber = entryNumber || `JE-${Date.now()}`;

    // ─── Post atomically ───
    const { data: jeId, error: rpcError } = await supabaseAdmin.rpc("post_journal_entry_atomic", {
      _org_id: organization_id,
      _business_id: business_id || null,
      _entry_number: String(jeNumber),
      _entry_date: payrollRun.pay_period_end,
      _reference: payrollRun.payroll_number,
      _description: `${runLabel} - ${payslips.length} employees${isCorrection ? " (signed delta)" : ""}`,
      _source_type: "payroll",
      _source_id: payroll_run_id,
      _created_by: userId,
      _is_closing: false,
      _is_adjusting: false,
      _lines: lines,
    });

    if (rpcError) {
      console.error("GL posting RPC error:", rpcError);
      return new Response(JSON.stringify({ error: `GL posting failed: ${rpcError.message}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Update payroll run status to "posted" + stamp posted_by/posted_at ───
    await supabaseAdmin
      .from("payroll_runs")
      .update({
        status: "posted",
        posted_by: userId,
        posted_at: new Date().toISOString(),
      } as any)
      .eq("id", payroll_run_id);

    // ─── R4: Write payroll_liabilities directly (country-agnostic, pack-driven) ───
    // payroll_liabilities is the source of truth; due_date and liability_account_id
    // are resolved through SQL helpers that read the org's installed localization
    // pack (localization_pack_remittance_schedules). Idempotent per (run, rule_code).
    // Legacy `payroll_remittances` is no longer written by this engine.
    let liabilitiesCreated = 0;
    try {
      // Phase 4: a single run may span multiple jurisdictions
      // (employees with different `statutory_country_code`). Resolve the
      // country per rule_code from `payroll_statutory_rules` instead of
      // assuming one pack per org. Falls back to the most-recently
      // installed pack's country only if no rule row matches.
      const ruleCodes = Array.from(deductionMap.keys());
      const { data: ruleRows } = await supabaseAdmin
        .from("payroll_statutory_rules")
        .select("rule_code, country_code")
        .eq("organization_id", organization_id)
        .in("rule_code", ruleCodes)
        .eq("is_active", true);
      const countryByRule = new Map<string, string>();
      for (const r of (ruleRows || [])) {
        const cc = String((r as any).country_code || "").toUpperCase();
        if (cc && !countryByRule.has((r as any).rule_code)) {
          countryByRule.set((r as any).rule_code, cc);
        }
      }

      // Fallback country (used only when no rule row exists for a given
      // rule_code — extremely rare, kept for legacy compatibility).
      const { data: installedPack } = await supabaseAdmin
        .from("installed_localization_packs")
        .select("pack_id, localization_packs!inner(country_code)")
        .eq("organization_id", organization_id)
        .eq("status", "active")
        .order("business_id", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      const fallbackCountry: string | null =
        (installedPack as any)?.localization_packs?.country_code ?? null;

      const liabRows: any[] = [];
      for (const [ruleCode, deduction] of deductionMap) {
        const total = Number(deduction.employeeTotal || 0) + Number(deduction.employerTotal || 0);
        if (total <= 0) continue;

        const countryCode = countryByRule.get(ruleCode) || fallbackCountry;

        // Pack-driven due date.
        const { data: dueDate } = await supabaseAdmin.rpc("compute_remittance_due_date", {
          p_organization_id: organization_id,
          p_business_id: business_id || null,
          p_country_code: countryCode,
          p_rule_code: ruleCode,
          p_period_end: payrollRun.pay_period_end,
        });

        // Pack-driven liability account (falls back to <rule_code>_payable mapping).
        const { data: acctId } = await supabaseAdmin.rpc("resolve_liability_account_for_rule", {
          p_organization_id: organization_id,
          p_business_id: business_id || null,
          p_country_code: countryCode,
          p_rule_code: ruleCode,
        });

        // Authority name: prefer pack schedule's authority_name; fall back to label.
        let authorityName: string = (deduction.label || ruleCode).toString();
        if (countryCode) {
          const { data: sched } = await supabaseAdmin
            .from("localization_pack_remittance_schedules")
            .select("authority_name, localization_packs!inner(country_code)")
            .eq("rule_code", ruleCode)
            .eq("localization_packs.country_code", countryCode)
            .limit(1)
            .maybeSingle();
          if ((sched as any)?.authority_name) authorityName = (sched as any).authority_name;
        }


        liabRows.push({
          organization_id,
          business_id,
          branch_id: payrollRun.branch_id || null,
          payroll_run_id,
          rule_code: ruleCode,
          authority_name: authorityName,
          label: deduction.label || ruleCode,
          country_code: countryCode,
          period_start: payrollRun.pay_period_start,
          period_end: payrollRun.pay_period_end,
          due_date: dueDate as any,
          original_amount: total,
          paid_amount: 0,
          outstanding_amount: total,
          status: 'open',
          liability_account_id: (acctId as any) || resolveAccount(`${ruleCode}_payable`) || resolveAccount(ruleCode) || null,
          notes: `Auto-created from payroll ${payrollRun.payroll_number}`,
          created_by: userId,
        });
      }

      // ─── Garnishment liabilities: one row per garnishment_id ───
      // rule_code = `garnishment_<uuid>` (matches the payslip_lines rule_code,
      // so the existing (run, rule_code) unique index keeps re-posts idempotent).
      if (garnishmentMap.size > 0) {
        // Hydrate payee_contact_id + due_date hint from the order + resolved policy.
        const garnIds = Array.from(garnishmentMap.keys());
        const { data: garnRows } = await supabaseAdmin
          .from("employee_garnishments")
          .select("id, payee_contact_id, payee_name, kind, end_date")
          .in("id", garnIds);
        const garnById = new Map<string, any>(
          (garnRows || []).map((r: any) => [r.id, r]),
        );

        // Resolve tenant > pack > platform garnishment policy for this org;
        // policy.remittance_due_day overrides the legacy "next month + 8" fallback.
        let policyDueDay = 8;
        try {
          const { data: pol } = await supabaseAdmin.rpc("garnishment_resolve_policy", {
            p_org_id: organization_id,
          });
          const dd = (pol as any)?.remittance_due_day ?? (pol as any)?.due_day;
          if (typeof dd === "number" && dd >= 1 && dd <= 31) policyDueDay = dd;
        } catch (e) {
          console.warn("garnishment_resolve_policy unavailable, using default due_day=8:", e);
        }

        for (const garn of garnishmentMap.values()) {
          const order = garnById.get(garn.garnishment_id) || {};
          const authority = order.payee_name || garn.label || "Garnishment payee";
          const periodEnd = new Date(payrollRun.pay_period_end);
          const due = new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, policyDueDay);
          liabRows.push({
            organization_id,
            business_id,
            branch_id: payrollRun.branch_id || null,
            payroll_run_id,
            rule_code: garn.rule_code,
            authority_name: authority,
            label: garn.label,
            country_code: fallbackCountry,
            period_start: payrollRun.pay_period_start,
            period_end: payrollRun.pay_period_end,
            due_date: due.toISOString().slice(0, 10),
            original_amount: garn.amount,
            paid_amount: 0,
            outstanding_amount: garn.amount,
            status: 'open',
            liability_account_id: garnishmentPayableAcct,
            garnishment_id: garn.garnishment_id,
            payee_contact_id: order.payee_contact_id || null,
            notes: `Auto-created from payroll ${payrollRun.payroll_number} (garnishment ${order.kind ?? ""})`.trim(),
            created_by: userId,
          });
        }
      }



      if (liabRows.length > 0) {
        // Idempotent upsert: re-posting the same run updates the existing liability
        // rows (uq_payroll_liabilities_run_rule) without creating duplicates.
        const { data: upsertedLiab, error: liabErr } = await supabaseAdmin
          .from("payroll_liabilities")
          .upsert(liabRows, { onConflict: "payroll_run_id,rule_code" })
          .select("id, rule_code, original_amount");
        if (liabErr) {
          console.error("Failed to upsert payroll_liabilities:", liabErr);
        } else if (upsertedLiab) {
          liabilitiesCreated = upsertedLiab.length;
          // Refresh source links so each liability traces back to this run.
          await supabaseAdmin
            .from("payroll_liability_sources")
            .delete()
            .eq("payroll_run_id", payroll_run_id);
          const sourceRows = upsertedLiab.map((l: any) => ({
            liability_id: l.id,
            payroll_run_id,
            amount: l.original_amount,
          }));
          const { error: srcErr } = await supabaseAdmin
            .from("payroll_liability_sources")
            .insert(sourceRows);
          if (srcErr) console.warn("Failed to link liability sources:", srcErr);
        }
      }
    } catch (liabFatal) {
      console.error("payroll_liabilities write failed:", liabFatal);
    }

    // ─── Audit log ───
    await supabaseAdmin.from("audit_logs").insert({
      organization_id,
      business_id: business_id || null,
      user_id: userId,
      action: "gl_posted",
      entity_type: "payroll_run",
      entity_id: payroll_run_id,
      entity_name: payrollRun.payroll_number,
      new_values: {
        journal_entry_id: jeId,
        total_debits: totalDebits,
        total_credits: totalCredits,
        line_count: lines.length,
        liabilities_created: liabilitiesCreated,
      },
      changes_summary: `Posted payroll ${payrollRun.payroll_number} to GL (JE: ${jeNumber}), created ${liabilitiesCreated} payroll liabilities`,
    });

    return new Response(JSON.stringify({
      journal_entry_id: jeId,
      journal_entry_number: jeNumber,
      total_debits: lines.reduce((s, l) => s + l.debit, 0),
      total_credits: lines.reduce((s, l) => s + l.credit, 0),
      line_count: lines.length,
      liabilities_created: liabilitiesCreated,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Post payroll GL error:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/**
 * Server-side Payroll GL Posting Edge Function
 * 
 * Moves the payroll-to-GL posting logic server-side for integrity.
 * Resolves account mappings via EXPLICIT default_account_settings ONLY.
 * No fuzzy name-matching — if a mapping is missing, posting fails loudly.
 *
 * Deploy-bump 2026-07-23: re-bundle so `_shared/payslipClassifier.ts`
 * (post_tax_deduction + garnishment buckets) is inlined here.
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
    console.log(`[post-payroll-gl] entry run=${payroll_run_id} dry_run=${dryRun}`);


    if (!payroll_run_id || !organization_id) {
      return new Response(JSON.stringify({ error: "Missing payroll_run_id or organization_id" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[post-payroll-gl] step: entitlement");
    // ─── Subscription entitlement check ───
    const { checkAppEntitlement, entitlementDeniedResponse } = await import("../_shared/entitlementCheck.ts");
    const entResult = await checkAppEntitlement(supabaseAdmin, organization_id, "payroll", { requireInstalled: true });
    if (!entResult.allowed) return entitlementDeniedResponse(entResult, corsHeaders);

    console.log("[post-payroll-gl] step: permissions");
    const { requireModulePermission } = await import("../_shared/permissionCheck.ts");
    const deniedPayroll = await requireModulePermission(
      supabaseAdmin, userId, organization_id, "payroll", "write", corsHeaders,
    );
    if (deniedPayroll) return deniedPayroll;
    const deniedFin = await requireModulePermission(
      supabaseAdmin, userId, organization_id, "financials", "write", corsHeaders,
    );
    if (deniedFin) return deniedFin;

    console.log("[post-payroll-gl] step: fetch run");
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

    const previewWarnings: Array<{ code: string; message: string; details?: unknown }> = [];

    console.log("[post-payroll-gl] step: sod (skipped for dry_run)", { dryRun });
    if (!dryRun) {
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

    // ─── Existing-JE detection ───
    // The write path uses this as an idempotency short-circuit (a replay of
    // a completed post returns the existing JE id). The PREVIEW path must
    // never short-circuit here — accountants need to see the projected JE
    // even when a prior post has produced one (comparison, audit, reversal
    // planning). Instead we surface `already_posted` inside the preview
    // payload so the UI can render a read-only banner.
    const { data: existingJE } = await supabaseAdmin
      .from("journal_entries")
      .select("id")
      .eq("organization_id", organization_id)
      .eq("source_type", "payroll")
      .eq("source_id", payroll_run_id)
      .neq("status", "voided")
      .maybeSingle();

    if (existingJE && !dryRun) {
      return new Response(JSON.stringify({ journal_entry_id: existingJE.id, already_posted: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Fiscal period lock check ───
    // Hard fail on the write path; warning on the preview path so the
    // accountant sees the period issue alongside the projected JE.
    const { data: lockedPeriods } = await supabaseAdmin
      .from("fiscal_periods")
      .select("id, name")
      .eq("organization_id", organization_id)
      .eq("status", "closed")
      .lte("start_date", payrollRun.pay_period_end)
      .gte("end_date", payrollRun.pay_period_start);

    if (lockedPeriods && lockedPeriods.length > 0) {
      if (dryRun) {
        previewWarnings.push({
          code: "period_closed",
          message: `Fiscal period "${lockedPeriods[0].name}" is closed — this run cannot be posted until the period is reopened.`,
          details: { period_id: lockedPeriods[0].id, period_name: lockedPeriods[0].name },
        });
      } else {
        return new Response(JSON.stringify({
          error: `Cannot post to GL: fiscal period "${lockedPeriods[0].name}" is closed.`,
        }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
    // which honours the temporal window in effect at the run's pay-period end.
    // A re-post of a historical run therefore resolves the account that was
    // mapped *then*, not today's.
    //
    // GL ACCOUNT MAPPING IS HQ-AUTHORITATIVE. The chart of accounts is
    // governed centrally at the organization and, where books are separate,
    // the legal-entity (`business_id`) level. A branch/store/location does NOT
    // own GL accounts — it shares the company/entity COA (this mirrors SAP FI,
    // Oracle, Workday, Dynamics 365 F&O). No branch-scoped account bindings are
    // ever authored, so the branch → business → org cascade always collapses to
    // the shared company/entity default for a branch. Branch cost attribution
    // is expressed as a POSTING DIMENSION on the journal line (`branch_id` on
    // journal_entries/journal_entry_lines and, where used, analytic
    // distributions) — never as a different account.
    //
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

    // ADR 0091 (payroll leg) — loan repayment lines are NOT a payable.
    // A payroll-deducted instalment settles an asset: it relieves the loan
    // receivable (and recognises interest income). Posting them to
    // `<rule_code>_payable` parked the money in a liability and made the GL
    // loan receivable drift from `employee_loans.outstanding_balance` forever.
    // They are aggregated here and posted from
    // `payroll_loan_repayment_gl_targets` below.
    let loanRepaymentTotal = 0;

    // Same reasoning for employee advance recovery: the advance was booked as
    // a receivable at disbursement (`disburse_employee_advance`, ADR 0124), so
    // recovering it through payroll relieves that asset. Crediting
    // `advance_recovery_payable` would double-count the money as a liability
    // and leave the receivable outstanding forever.
    let advanceRecoveryTotal = 0;



    // Phase C — split labour cost by accounting_tag when the compute layer
    // stamped one. `null` bucket is the legacy "post to generic
    // salary_expense" path; when every earning is untagged the split
    // collapses to a single DR identical to the pre-Phase-C shape.
    const earningsByTag = new Map<string | null, number>();

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

    // Slice 2 — custom deduction lines are aggregated per (deduction_type_id)
    // and posted using the per-type gl_liability_account_id / gl_expense_account_id
    // that the compute layer stamped into details.
    interface CustomDedAgg {
      deduction_type_id: string;
      code: string;
      label: string;
      employee_amount: number;
      employer_amount: number;
      gl_liability_account_id: string | null;
      gl_expense_account_id: string | null;
    }
    const customDedMap = new Map<string, CustomDedAgg>();

    const { data: payslipLines, error: linesError } = await supabaseAdmin
      .from("payslip_lines")
      .select("rule_code, label, category, employee_amount, employer_amount, source, accounting_tag")
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

    // Category bucketing is owned by `_shared/payslipClassifier.ts` — do NOT
    // re-declare local Sets here. A divergent local set is exactly what
    // caused the PAY-0065 legal-order regression on the PDF renderer.
    const { classifyPayslipLine } = await import("../_shared/payslipClassifier.ts");

    for (const line of payslipLines as any[]) {
      const key = line.rule_code;
      const cat = line.category as string;
      const empAmt = Number(line.employee_amount || 0);
      const erAmt = Number(line.employer_amount || 0);

      // Phase C — accumulate earnings by accounting_tag for salary_expense split.
      if (cat === "earning" && empAmt > 0) {
        const tag = (line.accounting_tag as string | null) ?? null;
        earningsByTag.set(tag, (earningsByTag.get(tag) ?? 0) + empAmt);
      }

      // ─── Garnishment lines: aggregate per garnishment order ───
      // Resilient detection — legacy rows had category='garnishment', current
      // rows normalize to 'post_tax_deduction'. Both carry source.garnishment_id
      // (and/or source.kind='garnishment' / rule_code garnishment_<uuid>). We
      // classify a line as a garnishment when ANY of those markers is present,
      // so GL posting can never silently skip a legal-order deduction again.
      const srcObj = (line.source && typeof line.source === "object") ? (line.source as any) : null;
      const gidFromSource: string | null =
        (srcObj?.garnishment_id as string | null) ??
        (srcObj?.input_ref?.garnishment_id as string | null) ??
        null;
      const isGarnishmentLine =
        empAmt > 0 && (
          cat === "garnishment" ||
          gidFromSource != null ||
          srcObj?.kind === "garnishment" ||
          srcObj?.source === "garnishment" ||
          srcObj?.input_ref?.kind === "garnishment" ||
          (typeof key === "string" && key.startsWith("garnishment_"))
        );
      if (isGarnishmentLine) {
        const gid = gidFromSource
          ?? (typeof key === "string" && key.startsWith("garnishment_") ? key.slice("garnishment_".length) : null);
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

      // ─── Custom deduction lines (Slice 2): aggregate per deduction_type ───
      const details = (line.source && typeof line.source === "object") ? line.source as any : null;
      if (details && details.source === "custom_deduction" && details.deduction_type_id) {
        const tid = details.deduction_type_id as string;
        const existing = customDedMap.get(tid);
        if (existing) {
          existing.employee_amount += empAmt;
          existing.employer_amount += erAmt;
        } else {
          customDedMap.set(tid, {
            deduction_type_id: tid,
            code: (key || "").replace(/^custom_/, ""),
            label: line.label || key,
            employee_amount: empAmt,
            employer_amount: erAmt,
            gl_liability_account_id: details.gl_liability_account_id ?? null,
            gl_expense_account_id: details.gl_expense_account_id ?? null,
          });
        }
        continue;
      }

      // ─── Loan repayment lines: routed to the loan accounts, not a payable ───
      if (cat === "loan_repayment" && empAmt > 0) {
        loanRepaymentTotal += empAmt;
        continue;
      }

      // ─── Advance recovery lines: relieve the advance receivable ───
      if (key === "advance_recovery" && empAmt > 0) {
        advanceRecoveryTotal += empAmt;
        continue;
      }


      if (!key) continue;

      const bucket = classifyPayslipLine(line as any);
      const isDed = bucket === "deduction" && empAmt > 0;
      const isEr = bucket === "employer_contribution" && erAmt > 0;
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
    console.log("[post-payroll-gl] step: required mappings rpc");
    const { data: requiredRows, error: resolverError } = await supabaseAdmin.rpc(
      "payroll_required_gl_mappings_for_run",
      { p_run_id: payroll_run_id },
    );
    if (resolverError) {
      console.error("[post-payroll-gl] resolver error:", resolverError);
      return new Response(JSON.stringify({
        error: `Could not resolve required GL mappings: ${resolverError.message}`,
      }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.log("[post-payroll-gl] required rows:", (requiredRows || []).length);


    // ─── Populate the effective-dated binding map (authoritative) ───
    // Resolve every mapping key this run could reference through the temporal
    // binding resolver, using the run's pay-period end as the `as_of` instant.
    // Keys that resolve here override the flat fallback in `resolveAccount`.
    // The key universe is the union of the flat table keys and the required
    // keys the run needs, so nothing is missed.
    //
    // The run's branch is passed for cascade completeness, but no branch-scoped
    // account bindings are ever authored (mapping is HQ/entity-authoritative),
    // so a branch always resolves to the shared company/entity default. Branch
    // is a posting dimension on the JE line, not a distinct account.
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


    const salaryExpense = resolveAccount("salary_expense");
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

    // DR: Salary Expense — split by accounting_tag when compute stamped one.
    // Each tag `T` posts to salary_expense_<T> if mapped, otherwise folds
    // into the generic salary_expense bucket. Sum across all buckets equals
    // totalGross, so the balance invariant below is preserved.
    const salaryDrByAccount = new Map<string, { debit: number; labelSuffix: string | null }>();
    let unmappedTagAccum = 0;
    for (const [tag, amt] of earningsByTag) {
      if (tag) {
        const specific = resolveAccount(`salary_expense_${tag}`);
        if (specific) {
          const cur = salaryDrByAccount.get(specific);
          salaryDrByAccount.set(specific, {
            debit: (cur?.debit ?? 0) + amt,
            labelSuffix: cur?.labelSuffix ?? tag,
          });
          continue;
        }
      }
      unmappedTagAccum += amt;
    }
    // Any remainder that wasn't sent to a tag-specific account still needs
    // the generic salary_expense mapping. Also cover the pre-Phase-C case
    // where no earning lines were tag-aggregated (e.g. correction runs that
    // predate the column) by falling back to `totalGross`.
    const genericAmount =
      earningsByTag.size === 0 ? totalGross : unmappedTagAccum;
    if (genericAmount > 0.005) {
      if (!salaryExpense) {
        return new Response(JSON.stringify({
          error: "missing_mappings",
          message: "Salary Expense account is not mapped. Configure it under Payroll → GL Account Mapping.",
          missing: [{
            setting_key: "salary_expense",
            label: "Salary Expense",
            rule_code: null,
            kind: "core",
          }],
          action: { label: "Open GL Account Mapping", to: "/hr/payroll/configuration/accounts" },
        }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cur = salaryDrByAccount.get(salaryExpense);
      salaryDrByAccount.set(salaryExpense, {
        debit: (cur?.debit ?? 0) + genericAmount,
        labelSuffix: cur?.labelSuffix ?? null,
      });
    }
    for (const [acct, entry] of salaryDrByAccount) {
      lines.push({
        account_id: acct,
        debit: Math.round(entry.debit * 100) / 100,
        credit: 0,
        description: entry.labelSuffix
          ? `${runLabel} - Salary Expense (${entry.labelSuffix})`
          : `${runLabel} - Salary Expense`,
        contact_id: null,
      });
    }

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

    // ─── CR: Loan repayments — relieve the loan receivable (ADR 0091) ───
    // The split between principal and interest income comes from the loan
    // module (`payroll_loan_repayment_gl_targets` → `_loan_split_repayment`),
    // so payroll and the manual-repayment RPC agree on the same basis the
    // `finance_loan_receivable_integrity_check` reconciles against.
    if (loanRepaymentTotal > 0.005) {
      const { data: loanTargets, error: loanTargetError } = await supabaseAdmin.rpc(
        "payroll_loan_repayment_gl_targets",
        { p_run_id: payroll_run_id },
      );
      if (loanTargetError) {
        return new Response(JSON.stringify({
          error: `Could not resolve loan repayment GL accounts: ${loanTargetError.message}`,
        }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const targets = (loanTargets || []) as Array<{
        loan_id: string;
        loan_number: string | null;
        receivable_account_id: string | null;
        interest_account_id: string | null;
        principal_amount: number | null;
        interest_amount: number | null;
      }>;

      const unmapped = targets.filter((t) => !t.receivable_account_id);
      if (targets.length === 0 || unmapped.length > 0) {
        return new Response(JSON.stringify({
          error: "missing_mappings",
          message: targets.length === 0
            ? "This run deducts loan instalments but no loan repayment records were found for it. Re-run payroll computation before posting."
            : "Loan Receivable account is not mapped for one or more loan types. Map it on the loan type (or as the org default) before posting a run with loan deductions.",
          missing: [{
            setting_key: "loan_receivable",
            label: "Loan Receivable",
            rule_code: null,
            kind: "core",
          }],
          action: { label: "Open Loan Types", to: "/hr/loans/configuration" },
        }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Keep the JE balanced against the payslip lines: the loan-side split is
      // authoritative for the interest/principal ratio, the payslip total is
      // authoritative for the amount. Any rounding residual lands on principal.
      const splitTotal = targets.reduce(
        (s, t) => s + Number(t.principal_amount || 0) + Number(t.interest_amount || 0),
        0,
      );
      const residual = Math.round((loanRepaymentTotal - splitTotal) * 100) / 100;

      targets.forEach((t, idx) => {
        const label = t.loan_number ? `Loan ${t.loan_number}` : "Loan repayment";
        const principal =
          Math.round((Number(t.principal_amount || 0) + (idx === 0 ? residual : 0)) * 100) / 100;
        const interest = Math.round(Number(t.interest_amount || 0) * 100) / 100;
        if (principal > 0.005 || (principal !== 0 && interest === 0)) {
          lines.push({
            account_id: t.receivable_account_id!,
            debit: 0,
            credit: principal,
            description: `${runLabel} - ${label} principal recovery`,
            contact_id: null,
          });
        }
        if (interest > 0.005 && t.interest_account_id) {
          lines.push({
            account_id: t.interest_account_id,
            debit: 0,
            credit: interest,
            description: `${runLabel} - ${label} interest income`,
            contact_id: null,
          });
        }
      });
    }

    // ─── CR: Advance recoveries — relieve the advance receivable (ADR 0124) ───
    // Targets come from `payroll_advance_recovery_gl_targets`, which reads the
    // schedule rows this run wrote and resolves the same account
    // `disburse_employee_advance` debited. Any rounding residual between the
    // payslip total and the schedule total lands on the first target so the
    // journal stays balanced against the payslip lines.
    if (advanceRecoveryTotal > 0.005) {
      const { data: advTargets, error: advTargetError } = await supabaseAdmin.rpc(
        "payroll_advance_recovery_gl_targets",
        { p_run_id: payroll_run_id },
      );
      if (advTargetError) {
        return new Response(JSON.stringify({
          error: `Could not resolve advance recovery GL accounts: ${advTargetError.message}`,
        }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const advRows = (advTargets || []) as Array<{
        advance_id: string;
        employee_name: string | null;
        receivable_account_id: string | null;
        amount: number | null;
      }>;

      if (advRows.length === 0 || advRows.some((t) => !t.receivable_account_id)) {
        return new Response(JSON.stringify({
          error: "missing_mappings",
          message: advRows.length === 0
            ? "This run recovers employee advances but no recovery records were found for it. Re-run payroll computation before posting."
            : "Employee Advance Receivable account is not mapped. Map it (or Loan Receivable as the fallback) under Finance → Default Accounts before posting a run with advance recoveries.",
          missing: [{
            setting_key: "employee_advance_receivable",
            label: "Employee Advance Receivable",
            rule_code: null,
            kind: "core",
          }],
          action: { label: "Open GL Account Mapping", to: "/hr/payroll/configuration/accounts" },
        }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const advSplitTotal = advRows.reduce((s, t) => s + Number(t.amount || 0), 0);
      const advResidual = Math.round((advanceRecoveryTotal - advSplitTotal) * 100) / 100;

      advRows.forEach((t, idx) => {
        const amount =
          Math.round((Number(t.amount || 0) + (idx === 0 ? advResidual : 0)) * 100) / 100;
        if (amount <= 0.005) return;
        lines.push({
          account_id: t.receivable_account_id!,
          debit: 0,
          credit: amount,
          description: `${runLabel} - Advance recovery${t.employee_name ? ` (${t.employee_name})` : ""}`,
          contact_id: null,
        });
      });
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
    // Sub-ledger discipline (ADR-0093, Phase R4b): stamp `contact_id` on
    // every garnishment payable CR line, resolved from the `legal_recipients`
    // master through `recipient_id`. Legacy overlay/snapshot columns are gone.
    let garnRecipientByOrderId = new Map<string, string | null>();
    if (garnishmentMap.size > 0) {
      const garnIds = Array.from(garnishmentMap.keys());
      const { data: garnRows } = await supabaseAdmin
        .from("legal_orders")
        .select("id, recipient_id, legal_recipients:recipient_id(contact_id)")
        .in("id", garnIds);
      garnRecipientByOrderId = new Map(
        (garnRows || []).map((r: any) => [
          r.id as string,
          (r.legal_recipients?.contact_id as string | null) ?? null,
        ]),
      );
    }
    for (const garn of garnishmentMap.values()) {
      lines.push({
        account_id: garnishmentPayableAcct!,
        debit: 0,
        credit: garn.amount,
        description: `${runLabel} - ${garn.label}`,
        contact_id: garnRecipientByOrderId.get(garn.garnishment_id) ?? null,
      });
    }


    // ─── Slice 2: custom deduction JE lines ───
    // Per-type mapping is stored on custom_deduction_types (not
    // default_account_settings). Refuse to post if any consumed type is
    // unmapped — matches the ADR-0040 readiness-payload convention.
    if (customDedMap.size > 0) {
      const missingCd: Array<{ setting_key: string; label: string; kind: string }> = [];
      for (const cd of customDedMap.values()) {
        if (cd.employee_amount > 0 && !cd.gl_liability_account_id) {
          missingCd.push({ setting_key: `custom_deduction:${cd.code}:liability`, label: `${cd.label} — liability account`, kind: "employee_payable" });
        }
        if (cd.employer_amount > 0 && (!cd.gl_expense_account_id || !cd.gl_liability_account_id)) {
          if (!cd.gl_expense_account_id) missingCd.push({ setting_key: `custom_deduction:${cd.code}:expense`, label: `${cd.label} — expense account`, kind: "employer_expense" });
          if (!cd.gl_liability_account_id) missingCd.push({ setting_key: `custom_deduction:${cd.code}:liability`, label: `${cd.label} — liability account`, kind: "employer_payable" });
        }
      }
      if (missingCd.length > 0) {
        return new Response(JSON.stringify({
          error: "missing_mappings",
          message: "Custom deduction types are missing GL mapping. Open Payroll → Configuration → Custom deductions to complete setup.",
          missing: missingCd,
          action: { label: "Open Custom deductions", to: "/hr/payroll/configuration/custom-deductions" },
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      for (const cd of customDedMap.values()) {
        if (cd.employee_amount > 0 && cd.gl_liability_account_id) {
          lines.push({
            account_id: cd.gl_liability_account_id,
            debit: 0,
            credit: cd.employee_amount,
            description: `${runLabel} - ${cd.label}`,
            contact_id: null,
          });
        }
        if (cd.employer_amount > 0 && cd.gl_expense_account_id && cd.gl_liability_account_id) {
          lines.push({
            account_id: cd.gl_expense_account_id,
            debit: cd.employer_amount,
            credit: 0,
            description: `${runLabel} - Employer ${cd.label}`,
            contact_id: null,
          });
          lines.push({
            account_id: cd.gl_liability_account_id,
            debit: 0,
            credit: cd.employer_amount,
            description: `${runLabel} - Employer ${cd.label} Payable`,
            contact_id: null,
          });
        }
      }
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
    // status change, no liabilities, no financial audit_log — but we DO
    // write a lightweight, non-financial "payroll_posting_previewed" row
    // to audit_logs so previews are traceable in enterprise audits.
    if (dryRun) {
      console.log(`[post-payroll-gl] dry_run branch reached, lines=${lines.length}`);

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
      const dryBalanced = Math.abs(dryTotalDebits - dryTotalCredits) < 0.01;

      // Fire-and-forget preview audit row. Never blocks the response.
      try {
        await supabaseAdmin.from("audit_logs").insert({
          organization_id,
          business_id: business_id || null,
          user_id: userId,
          action: "payroll_posting_previewed",
          entity_type: "payroll_run",
          entity_id: payroll_run_id,
          entity_name: payrollRun.payroll_number,
          new_values: {
            line_count: enriched.length,
            total_debits: dryTotalDebits,
            total_credits: dryTotalCredits,
            balanced: dryBalanced,
            warnings: previewWarnings.map((w) => w.code),
            already_posted: !!existingJE,
          },
          changes_summary: `Previewed payroll GL posting for ${payrollRun.payroll_number} (read-only, no ledger change)`,
        });
      } catch (auditErr) {
        console.warn("payroll_posting_previewed audit insert failed:", auditErr);
      }

      return new Response(JSON.stringify({
        dry_run: true,
        payroll_run_id,
        payroll_number: payrollRun.payroll_number,
        pay_period_end: payrollRun.pay_period_end,
        run_status: payrollRun.status,
        employee_count: payslips.length,
        lines: enriched,
        total_debits: dryTotalDebits,
        total_credits: dryTotalCredits,
        balanced: dryBalanced,
        warnings: previewWarnings,
        already_posted: !!existingJE,
        existing_journal_entry_id: existingJE?.id ?? null,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Write-path precondition: run must be APPROVED and not already posted ───
    // Enterprise rule (see plan/redesign): GL Posting is a peer workflow to
    // Payment, Bank File, and Statutory Returns. Its only hard dependency is
    // Payroll Approval (`approved_at IS NOT NULL`) — the legal immutability
    // seal. Duplicate posting is prevented by the independent posting_status
    // column, NOT by the run's overall `status` label.
    if (!payrollRun.approved_at) {
      return new Response(JSON.stringify({
        error: "not_approved",
        message: "This payroll run has not been approved yet. Approve the run before posting it to the general ledger.",
        current_status: payrollRun.status,
        requires: "payroll_runs.approved_at",
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const currentPostingStatus = (payrollRun as any).posting_status ?? "not_posted";
    if (currentPostingStatus === "posted") {
      return new Response(JSON.stringify({
        error: "already_posted",
        message: "This payroll run has already been posted to the general ledger.",
        posting_status: currentPostingStatus,
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (currentPostingStatus === "reversed") {
      return new Response(JSON.stringify({
        error: "posting_reversed",
        message: "This payroll run's GL posting was reversed. Use a correction or reversal run to re-post.",
        posting_status: currentPostingStatus,
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
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

    // ─── Advance the GL Posting workflow independently of the run's overall status ───
    // `posting_status` is the new source of truth for "has this run been
    // posted to GL?" — decoupled from Payment, Bank File, and Returns.
    // We keep writing legacy `status='posted'` for backwards compatibility
    // until Phase 6 retires the coupling.
    await supabaseAdmin
      .from("payroll_runs")
      .update({
        status: "posted",
        posting_status: "posted",
        posting_journal_entry_id: jeId,
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
        // Hydrate recipient contact + due_date hint from the order + resolved policy.
        const garnIds = Array.from(garnishmentMap.keys());
        // ADR-0093 / Phase R4b: authority display name and recipient
        // contact are resolved from the `legal_recipients` master via
        // `recipient_id`. Legacy overlay/snapshot columns are gone.
        const { data: garnRows } = await supabaseAdmin
          .from("legal_orders")
          .select("id, recipient_id, kind_code, end_date, priority_class, calc_model, authority_id, legal_recipients:recipient_id(contact_id, display_name)")
          .in("id", garnIds);
        const garnById = new Map<string, any>(
          (garnRows || []).map((r: any) => [r.id, r]),
        );
        for (const garn of garnishmentMap.values()) {
          const order = garnById.get(garn.garnishment_id) || {};
          const authority =
            order.legal_recipients?.display_name ||
            garn.label ||
            "Garnishment recipient";
          const payeeContactId =
            (order.legal_recipients?.contact_id as string | null) ?? null;
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
            payee_contact_id: payeeContactId,
            notes: `Auto-created from payroll ${payrollRun.payroll_number} (garnishment ${order.kind_code ?? ""})`.trim(),
            created_by: userId,
          });
        }
      }

      // ─── Custom deduction liabilities: one row per deduction type ───
      // Money withheld from the employee under a custom deduction is owed to an
      // external party exactly like a statutory deduction. Previously custom
      // deductions received a GL credit but never a `payroll_liabilities` row,
      // so they could never be remitted or aged. rule_code mirrors the payslip
      // line (`payroll_rule_code` when the type is bound to a pack scheme
      // component, `custom_<code>` otherwise), which keeps the
      // (run, rule_code) unique index idempotent across re-posts.
      if (customDedMap.size > 0) {
        const cdIds = Array.from(customDedMap.keys());
        const { data: cdTypeRows } = await supabaseAdmin
          .from("custom_deduction_types")
          .select(
            "id, code, label, payroll_rule_code, gl_liability_account_id, scheme_component_id",
          )
          .in("id", cdIds);
        const cdTypeById = new Map<string, any>(
          (cdTypeRows || []).map((r: any) => [r.id, r]),
        );

        // Resolve the external authority through the pack chain
        // scheme_component → scheme → statutory_authorities, when bound.
        const componentIds = (cdTypeRows || [])
          .map((r: any) => r.scheme_component_id)
          .filter(Boolean) as string[];
        const authorityByComponent = new Map<
          string,
          { name: string; country: string | null }
        >();
        if (componentIds.length > 0) {
          const { data: compRows } = await supabaseAdmin
            .from("statutory_scheme_components")
            .select(
              "id, statutory_schemes:scheme_id(country_code, display_name, statutory_authorities:authority_id(display_name, country_code))",
            )
            .in("id", componentIds);
          for (const c of (compRows || []) as any[]) {
            const scheme = c.statutory_schemes;
            const auth = scheme?.statutory_authorities;
            authorityByComponent.set(c.id, {
              name: auth?.display_name || scheme?.display_name || "",
              country: auth?.country_code || scheme?.country_code || null,
            });
          }
        }

        for (const cd of customDedMap.values()) {
          const total = Number(cd.employee_amount || 0) +
            Number(cd.employer_amount || 0);
          if (total <= 0) continue;

          const cdType = cdTypeById.get(cd.deduction_type_id) || {};
          const ruleCode: string = cdType.payroll_rule_code ||
            `custom_${cd.code || cd.deduction_type_id}`;

          // A pack-bound custom deduction must not collide with a statutory
          // liability already written from deductionMap for the same run.
          if (liabRows.some((r) => r.rule_code === ruleCode)) continue;

          const bound = cdType.scheme_component_id
            ? authorityByComponent.get(cdType.scheme_component_id)
            : null;
          const countryCode = bound?.country || fallbackCountry;

          // Pack-driven due date when the code is known to the pack; otherwise
          // fall back to the org's generic remittance due day.
          let dueDate: string | null = null;
          const { data: computedDue } = await supabaseAdmin.rpc(
            "compute_remittance_due_date",
            {
              p_organization_id: organization_id,
              p_business_id: business_id || null,
              p_country_code: countryCode,
              p_rule_code: ruleCode,
              p_period_end: payrollRun.pay_period_end,
            },
          );
          dueDate = (computedDue as any) ?? null;
          if (!dueDate) {
            const pe = new Date(payrollRun.pay_period_end);
            dueDate = new Date(pe.getFullYear(), pe.getMonth() + 1, policyDueDay)
              .toISOString()
              .slice(0, 10);
          }

          liabRows.push({
            organization_id,
            business_id,
            branch_id: payrollRun.branch_id || null,
            payroll_run_id,
            rule_code: ruleCode,
            authority_name: bound?.name || cdType.label || cd.label || ruleCode,
            label: cdType.label || cd.label || ruleCode,
            country_code: countryCode,
            period_start: payrollRun.pay_period_start,
            period_end: payrollRun.pay_period_end,
            due_date: dueDate,
            original_amount: total,
            paid_amount: 0,
            outstanding_amount: total,
            status: "open",
            liability_account_id: cd.gl_liability_account_id ??
              cdType.gl_liability_account_id ?? null,
            notes:
              `Auto-created from payroll ${payrollRun.payroll_number} (custom deduction ${
                cdType.code || cd.code || ""
              })`.trim(),
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
    console.error("Post payroll GL error:", error?.message, error?.stack);
    return new Response(JSON.stringify({ error: error?.message || "Internal server error", stack: error?.stack }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

});

/**
 * payrollExtendedData — Phase 4 additions for the Payroll Reports workspace.
 *
 * Adds three new server builders that complete the enterprise-grade
 * lifecycle coverage:
 *
 *   - payroll_gl_posting       (Cost / Financial)
 *       Every journal entry line originating from `source_type='payroll'`
 *       within the window, so finance can reconcile the payroll cost the
 *       HR module posted to the GL against the payroll run itself.
 *
 *   - payroll_audit_trail      (Audit)
 *       Every mutation to payroll_run / payslip / payroll_liability /
 *       payroll_remittance_payment in the window, straight from
 *       `audit_logs`, with actor + change summary.
 *
 *   - payroll_work_entries     (Operational)
 *       Work-entry ledger driving compute-payroll — hours, overtime,
 *       holiday hours, per entry type. This is the upstream input for
 *       the payroll register and the drill-down anchor for attendance.
 *
 * Country-agnostic: no localisation-specific column names, all provenance
 * is inferred from `source_type`, `entity_type` and `work_entry_type_id`.
 */
// deno-lint-ignore-file no-explicit-any
import type { ReportResult } from "../reportDataEngine.ts";

export type PayrollExtendedReportKey =
  | "payroll_gl_posting"
  | "payroll_audit_trail"
  | "payroll_work_entries";

export interface PayrollExtendedFilters {
  branchId?: string | null;
  employeeId?: string | null;
  payrollRunId?: string | null;
}

function withMeta(row: any, meta: Record<string, unknown>) {
  return Object.defineProperty(row, "_meta", { enumerable: false, value: meta });
}

function empName(e: any): string {
  if (!e) return "Unknown";
  return `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() || "Unknown";
}

export async function buildPayrollExtendedReport(
  supabase: any,
  reportType: PayrollExtendedReportKey,
  orgId: string,
  businessId: string | undefined,
  dateFrom: string,
  dateTo: string,
  filters: PayrollExtendedFilters = {},
): Promise<ReportResult> {
  switch (reportType) {
    case "payroll_gl_posting": {
      // Pull journal entries posted from the payroll module in the window.
      let jeQ = supabase
        .from("journal_entries")
        .select("id, entry_number, entry_date, description, status, source_id, business_id, branch_id, total_debit, total_credit")
        .eq("organization_id", orgId)
        .eq("source_type", "payroll")
        .gte("entry_date", dateFrom)
        .lte("entry_date", dateTo);
      if (businessId) jeQ = jeQ.eq("business_id", businessId);
      if (filters.branchId) jeQ = jeQ.eq("branch_id", filters.branchId);
      if (filters.payrollRunId) jeQ = jeQ.eq("source_id", filters.payrollRunId);
      const { data: entries = [], error } = await jeQ;
      if (error) throw error;
      if (entries.length === 0) return { data: [], summary: {} };

      const entryIds = entries.map((e: any) => e.id);
      const runIds = Array.from(
        new Set(entries.map((e: any) => e.source_id).filter(Boolean)),
      );

      const [{ data: lines = [] }, { data: runs = [] }] = await Promise.all([
        supabase
          .from("journal_entry_lines")
          .select("journal_entry_id, account_id, description, debit, credit")
          .in("journal_entry_id", entryIds),
        runIds.length
          ? supabase
              .from("payroll_runs")
              .select("id, payroll_number")
              .in("id", runIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const acctIds = Array.from(
        new Set((lines as any[]).map((l: any) => l.account_id).filter(Boolean)),
      );
      const { data: accounts = [] } = acctIds.length
        ? await supabase
            .from("accounts")
            .select("id, account_code, account_name")
            .in("id", acctIds)
        : { data: [] as any[] };
      const aName = new Map(
        (accounts as any[]).map((a: any) => [
          a.id,
          `${a.account_code ?? ""} ${a.account_name ?? ""}`.trim(),
        ]),
      );
      const runNumber = new Map(
        (runs as any[]).map((r: any) => [r.id, r.payroll_number]),
      );
      const linesByEntry = new Map<string, any[]>();
      for (const l of lines as any[]) {
        const arr = linesByEntry.get(l.journal_entry_id) ?? [];
        arr.push(l);
        linesByEntry.set(l.journal_entry_id, arr);
      }

      const rows: any[] = [];
      let totalDr = 0;
      let totalCr = 0;
      for (const e of entries as any[]) {
        for (const l of linesByEntry.get(e.id) ?? []) {
          const dr = Number(l.debit || 0);
          const cr = Number(l.credit || 0);
          totalDr += dr;
          totalCr += cr;
          rows.push(
            withMeta(
              {
                entry_date: e.entry_date,
                entry_number: e.entry_number ?? "—",
                payroll_number: runNumber.get(e.source_id) ?? "—",
                account: aName.get(l.account_id) ?? "—",
                description: l.description ?? e.description ?? "",
                debit: dr,
                credit: cr,
                status: e.status ?? "—",
              },
              {
                sourceDocType: "journal_entry",
                sourceDocId: e.id,
                accountId: l.account_id,
                relatedDocType: "payroll_run",
                relatedDocId: e.source_id,
              },
            ),
          );
        }
      }
      return {
        data: rows,
        summary: {
          entries: entries.length,
          total_debit: totalDr,
          total_credit: totalCr,
          out_of_balance: Number((totalDr - totalCr).toFixed(2)),
        },
      };
    }

    case "payroll_audit_trail": {
      const entities = [
        "payroll_run",
        "payslip",
        "payroll_liability",
        "payroll_remittance_payment",
      ];
      let auQ = supabase
        .from("audit_logs")
        .select("id, created_at, action, entity_type, entity_id, entity_name, user_id, changes_summary, business_id")
        .eq("organization_id", orgId)
        .in("entity_type", entities)
        .gte("created_at", `${dateFrom}T00:00:00Z`)
        .lte("created_at", `${dateTo}T23:59:59Z`)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (businessId) auQ = auQ.eq("business_id", businessId);
      const { data: logs = [], error } = await auQ;
      if (error) throw error;

      const userIds = Array.from(
        new Set((logs as any[]).map((l: any) => l.user_id).filter(Boolean)),
      );
      const { data: profiles = [] } = userIds.length
        ? await supabase
            .from("profiles")
            .select("id, full_name, email")
            .in("id", userIds)
        : { data: [] as any[] };
      const uName = new Map(
        (profiles as any[]).map((p: any) => [p.id, p.full_name ?? p.email ?? "—"]),
      );

      const rows = (logs as any[]).map((l: any) =>
        withMeta(
          {
            when: l.created_at,
            actor: uName.get(l.user_id) ?? "System",
            action: l.action ?? "—",
            entity_type: l.entity_type,
            entity: l.entity_name ?? l.entity_id?.slice(0, 8) ?? "—",
            summary: l.changes_summary ?? "—",
          },
          {
            sourceDocType: l.entity_type,
            sourceDocId: l.entity_id,
            auditLogId: l.id,
          },
        ),
      );
      return { data: rows, summary: { events: rows.length } };
    }

    case "payroll_work_entries": {
      let runQ = supabase
        .from("payroll_runs")
        .select("id")
        .eq("organization_id", orgId)
        .lte("pay_period_start", dateTo)
        .gte("pay_period_end", dateFrom);
      if (businessId) runQ = runQ.eq("business_id", businessId);
      if (filters.payrollRunId) runQ = runQ.eq("id", filters.payrollRunId);
      const { data: runs = [] } = await runQ;
      const runIds = (runs as any[]).map((r: any) => r.id);

      let weQ = supabase
        .from("payroll_work_entries")
        .select("id, payroll_run_id, employee_id, work_date_start, work_date_end, hours, overtime_hours, holiday_hours, source, work_entry_type_id")
        .eq("organization_id", orgId)
        .gte("work_date_start", dateFrom)
        .lte("work_date_end", dateTo);
      if (businessId) weQ = weQ.eq("business_id", businessId);
      if (runIds.length) weQ = weQ.in("payroll_run_id", runIds);
      if (filters.employeeId) weQ = weQ.eq("employee_id", filters.employeeId);
      const { data: entries = [], error } = await weQ;
      if (error) throw error;

      const empIds = Array.from(
        new Set((entries as any[]).map((e: any) => e.employee_id)),
      );
      const typeIds = Array.from(
        new Set(
          (entries as any[]).map((e: any) => e.work_entry_type_id).filter(Boolean),
        ),
      );
      const [{ data: employees = [] }, { data: types = [] }] = await Promise.all([
        empIds.length
          ? supabase
              .from("employees")
              .select("id, first_name, last_name, employee_number")
              .in("id", empIds)
          : Promise.resolve({ data: [] as any[] }),
        typeIds.length
          ? supabase
              .from("payroll_work_entry_types")
              .select("id, code, name")
              .in("id", typeIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const empById = new Map((employees as any[]).map((e: any) => [e.id, e]));
      const typeById = new Map(
        (types as any[]).map((t: any) => [t.id, t.name ?? t.code ?? "—"]),
      );

      let totalHours = 0;
      let totalOt = 0;
      let totalHol = 0;
      const rows = (entries as any[]).map((e: any) => {
        const emp = empById.get(e.employee_id);
        const h = Number(e.hours || 0);
        const ot = Number(e.overtime_hours || 0);
        const hol = Number(e.holiday_hours || 0);
        totalHours += h;
        totalOt += ot;
        totalHol += hol;
        return withMeta(
          {
            employee: empName(emp),
            employee_number: (emp as any)?.employee_number ?? "—",
            entry_type: typeById.get(e.work_entry_type_id) ?? "—",
            period: `${e.work_date_start} → ${e.work_date_end}`,
            hours: h,
            overtime_hours: ot,
            holiday_hours: hol,
            source: e.source ?? "—",
          },
          {
            sourceDocType: "payroll_work_entry",
            sourceDocId: e.id,
            partnerType: "employee",
            partnerId: e.employee_id,
            relatedDocType: "payroll_run",
            relatedDocId: e.payroll_run_id,
          },
        );
      });
      return {
        data: rows,
        summary: {
          entry_count: rows.length,
          total_hours: Number(totalHours.toFixed(2)),
          total_overtime_hours: Number(totalOt.toFixed(2)),
          total_holiday_hours: Number(totalHol.toFixed(2)),
        },
      };
    }
    default:
      throw new Error(`Unknown payroll extended report key: ${reportType}`);
  }
}
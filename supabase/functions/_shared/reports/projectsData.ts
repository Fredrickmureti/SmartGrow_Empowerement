/**
 * projectsData — server-build helpers for the project_* report keys.
 *
 * Mirrors attendanceData / payrollData. Lets render-report fetch + render
 * project portfolio, profitability, workload, timesheet detail and status
 * reports through the unified engine. Same path used by
 * process-scheduled-reports → automatic scheduled-report support.
 *
 * Each row carries `_meta = { sourceDocType: "project", sourceDocId }`
 * so the existing drill-down router can deep-link rows back to /projects/$id.
 */
// deno-lint-ignore-file no-explicit-any
import type { ReportResult } from "../reportDataEngine.ts";

export type ProjectReportKey =
  | "project_portfolio"
  | "project_profitability"
  | "project_workload"
  | "project_timesheet_detail"
  | "project_status"
  | "project_full_export";

export interface ProjectFilters {
  branchId?: string | null;
  projectId?: string | null;
  managerId?: string | null;
  status?: string | null;
}

const withMeta = (row: Record<string, unknown>, projectId: string | null) => ({
  ...row,
  _meta: { sourceDocType: "project", sourceDocId: projectId },
});

async function loadProjects(
  supabase: any,
  orgId: string,
  businessId: string | undefined,
  filters: ProjectFilters,
) {
  let q = supabase
    .from("projects")
    .select("id, project_number, name, status, manager_id, customer_id, currency, end_date, allocated_hours, spent_hours, branch_id")
    .eq("organization_id", orgId)
    .order("project_number", { ascending: true });
  if (businessId) q = q.eq("business_id", businessId);
  if (filters.branchId) q = q.eq("branch_id", filters.branchId);
  if (filters.projectId) q = q.eq("id", filters.projectId);
  if (filters.managerId) q = q.eq("manager_id", filters.managerId);
  if (filters.status) q = q.eq("status", filters.status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as any[];
}

export async function buildProjectReport(
  supabase: any,
  reportType: ProjectReportKey,
  orgId: string,
  businessId: string | undefined,
  dateFrom: string,
  dateTo: string,
  filters: ProjectFilters,
): Promise<ReportResult> {
  const projects = await loadProjects(supabase, orgId, businessId, filters);
  const projectIds = projects.map((p) => p.id);
  const safeIds = projectIds.length > 0 ? projectIds : ["00000000-0000-0000-0000-000000000000"];
  const projMap = new Map(projects.map((p) => [p.id, p.name]));

  switch (reportType) {
    case "project_portfolio": {
      const rows = projects.map((p) => {
        const allocated = Number(p.allocated_hours ?? 0);
        const spent = Number(p.spent_hours ?? 0);
        const pct = allocated > 0 ? Math.min(100, Math.round((spent / allocated) * 100)) : 0;
        return withMeta(
          {
            project_number: p.project_number ?? "",
            name: p.name,
            status: String(p.status ?? "").replace(/_/g, " "),
            end_date: p.end_date ?? "",
            progress: `${pct}%`,
          },
          p.id,
        );
      });
      return { data: rows, summary: { total_projects: rows.length } };
    }

    case "project_profitability": {
      let rQ = supabase
        .from("project_revenue_entries")
        .select("project_id, amount")
        .in("project_id", safeIds)
        .gte("posted_at", dateFrom)
        .lte("posted_at", dateTo + "T23:59:59Z");
      if (businessId) rQ = rQ.eq("business_id", businessId);
      let cQ = supabase
        .from("project_cost_entries")
        .select("project_id, amount")
        .in("project_id", safeIds)
        .gte("posted_at", dateFrom)
        .lte("posted_at", dateTo + "T23:59:59Z");
      if (businessId) cQ = cQ.eq("business_id", businessId);
      const [rr, cc] = await Promise.all([rQ, cQ]);
      if (rr.error) throw rr.error;
      if (cc.error) throw cc.error;

      const rev: Record<string, number> = {};
      const cost: Record<string, number> = {};
      for (const r of rr.data ?? []) rev[r.project_id] = (rev[r.project_id] ?? 0) + Number(r.amount ?? 0);
      for (const r of cc.data ?? []) cost[r.project_id] = (cost[r.project_id] ?? 0) + Number(r.amount ?? 0);

      let totRev = 0;
      let totCost = 0;
      const rows = projects.map((p) => {
        const re = rev[p.id] ?? 0;
        const co = cost[p.id] ?? 0;
        const margin = re - co;
        totRev += re;
        totCost += co;
        return withMeta(
          {
            project_number: p.project_number ?? "",
            name: p.name,
            revenue: re,
            cost: co,
            margin,
            margin_pct: re > 0 ? (margin / re) * 100 : 0,
          },
          p.id,
        );
      });
      return {
        data: rows,
        summary: {
          total_revenue: totRev,
          total_cost: totCost,
          total_margin: totRev - totCost,
        },
      };
    }

    case "project_workload": {
      let tQ = supabase
        .from("timesheets")
        .select("project_id, employee_id, hours, is_billable")
        .eq("organization_id", orgId)
        .gte("date", dateFrom)
        .lte("date", dateTo);
      if (businessId) tQ = tQ.eq("business_id", businessId);
      const { data, error } = await tQ;
      if (error) throw error;

      const agg = new Map<string, { project: string; hours: number; billable: number; projectId: string | null }>();
      for (const t of (data ?? []) as any[]) {
        const pid = t.project_id ?? "_unassigned";
        const cur = agg.get(pid) ?? {
          project: t.project_id ? (projMap.get(t.project_id) ?? "—") : "Unassigned",
          hours: 0,
          billable: 0,
          projectId: t.project_id ?? null,
        };
        const h = Number(t.hours ?? 0);
        cur.hours += h;
        if (t.is_billable) cur.billable += h;
        agg.set(pid, cur);
      }
      const rows = Array.from(agg.values()).map((v) =>
        withMeta(
          {
            project: v.project,
            total_hours: Number(v.hours.toFixed(2)),
            billable_hours: Number(v.billable.toFixed(2)),
            non_billable_hours: Number((v.hours - v.billable).toFixed(2)),
            billable_pct: v.hours > 0 ? Number(((v.billable / v.hours) * 100).toFixed(1)) : 0,
          },
          v.projectId,
        ),
      );
      return { data: rows, summary: {} };
    }

    case "project_timesheet_detail": {
      let tQ = supabase
        .from("timesheets")
        .select("date, hours, employee_id, project_id, is_billable, description")
        .eq("organization_id", orgId)
        .gte("date", dateFrom)
        .lte("date", dateTo)
        .order("date", { ascending: false })
        .limit(5000);
      if (businessId) tQ = tQ.eq("business_id", businessId);
      if (filters.projectId) tQ = tQ.eq("project_id", filters.projectId);
      const { data, error } = await tQ;
      if (error) throw error;

      // Resolve employee names in one fetch
      const empIds = Array.from(new Set((data ?? []).map((t: any) => t.employee_id).filter(Boolean)));
      let empMap = new Map<string, string>();
      if (empIds.length > 0) {
        const { data: emps } = await supabase
          .from("employees")
          .select("id, first_name, last_name")
          .in("id", empIds);
        empMap = new Map((emps ?? []).map((e: any) => [e.id, `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() || "—"]));
      }

      const rows = (data ?? []).map((t: any) =>
        withMeta(
          {
            date: t.date,
            project: t.project_id ? (projMap.get(t.project_id) ?? "—") : "—",
            employee: t.employee_id ? (empMap.get(t.employee_id) ?? "—") : "—",
            description: (t.description ?? "").slice(0, 80),
            hours: Number(t.hours ?? 0),
            billable: t.is_billable ? "Yes" : "No",
          },
          t.project_id ?? null,
        ),
      );
      return { data: rows, summary: { total_hours: rows.reduce((s: number, r: any) => s + Number(r.hours), 0) } };
    }

    case "project_status": {
      const { data: ud } = await supabase
        .from("project_updates")
        .select("project_id, status, summary, created_at")
        .in("project_id", safeIds)
        .order("created_at", { ascending: false })
        .limit(2000);
      const latest = new Map<string, { status: string; summary: string; created_at: string }>();
      for (const u of (ud ?? []) as any[]) {
        if (!latest.has(u.project_id)) latest.set(u.project_id, u);
      }
      const rows = projects.map((p) => {
        const u = latest.get(p.id);
        return withMeta(
          {
            project_number: p.project_number ?? "",
            name: p.name,
            status: String(p.status ?? "").replace(/_/g, " "),
            last_update: u ? String(u.status).replace(/_/g, " ") : "—",
            last_update_at: u ? u.created_at.slice(0, 10) : "—",
            summary: u ? (u.summary ?? "").slice(0, 120) : "",
          },
          p.id,
        );
      });
      return { data: rows, summary: {} };
    }

    case "project_full_export": {
      // Single-project deep export: project header, milestones, top tasks,
      // timesheet totals, profitability, recent updates — all in one flat
      // section/label/detail/date/hours/amount table.
      if (!filters.projectId) {
        return { data: [], summary: { error: "projectId filter is required for project_full_export" } };
      }
      const project = projects.find((p) => p.id === filters.projectId) ?? projects[0];
      if (!project) return { data: [], summary: {} };

      const [msRes, taskRes, tsRes, revRes, costRes, updRes] = await Promise.all([
        supabase.from("project_milestones").select("name, deadline, is_reached, billing_amount").eq("project_id", project.id).order("sequence", { ascending: true }),
        supabase.from("project_tasks").select("task_number, name, is_done, deadline, planned_hours, effective_hours").eq("project_id", project.id).eq("is_active", true).order("priority", { ascending: false }).limit(200),
        supabase.from("timesheets").select("date, hours, is_billable").eq("project_id", project.id).gte("date", dateFrom).lte("date", dateTo),
        supabase.from("project_revenue_entries").select("amount, posted_at, description").eq("project_id", project.id).gte("posted_at", dateFrom).lte("posted_at", dateTo + "T23:59:59Z"),
        supabase.from("project_cost_entries").select("amount, posted_at, description").eq("project_id", project.id).gte("posted_at", dateFrom).lte("posted_at", dateTo + "T23:59:59Z"),
        supabase.from("project_updates").select("status, summary, created_at").eq("project_id", project.id).order("created_at", { ascending: false }).limit(10),
      ]);

      const rows: Record<string, unknown>[] = [];
      const push = (section: string, label: string, detail = "", date = "", hours: number | "" = "", amount: number | "" = "") =>
        rows.push(withMeta({ section, label, detail, date, hours, amount }, project.id));

      push("Overview", project.name, `${project.project_number ?? ""} · ${String(project.status ?? "").replace(/_/g, " ")}`, project.end_date ?? "");

      const totalHours = (tsRes.data ?? []).reduce((s: number, r: any) => s + Number(r.hours ?? 0), 0);
      const billHours = (tsRes.data ?? []).filter((r: any) => r.is_billable).reduce((s: number, r: any) => s + Number(r.hours ?? 0), 0);
      const totalRev = (revRes.data ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
      const totalCost = (costRes.data ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);

      push("Profitability", "Total revenue", "", "", "", totalRev);
      push("Profitability", "Total cost", "", "", "", totalCost);
      push("Profitability", "Margin", totalRev > 0 ? `${(((totalRev - totalCost) / totalRev) * 100).toFixed(1)}%` : "—", "", "", totalRev - totalCost);

      push("Timesheets", "Total hours (period)", "", "", Number(totalHours.toFixed(2)));
      push("Timesheets", "Billable hours (period)", "", "", Number(billHours.toFixed(2)));

      for (const m of (msRes.data ?? []) as any[]) {
        push("Milestone", m.name, m.is_reached ? "Reached" : "Open", m.deadline ?? "", "", Number(m.billing_amount ?? 0));
      }
      for (const t of (taskRes.data ?? []) as any[]) {
        push("Task", `${t.task_number ?? ""} ${t.name}`.trim(), t.is_done ? "Done" : "Open", t.deadline ?? "", Number(t.effective_hours ?? 0));
      }
      for (const u of (updRes.data ?? []) as any[]) {
        push("Update", String(u.status ?? "").replace(/_/g, " "), (u.summary ?? "").slice(0, 80), u.created_at?.slice(0, 10) ?? "");
      }

      return {
        data: rows,
        summary: {
          project: project.name,
          total_revenue: totalRev,
          total_cost: totalCost,
          total_margin: totalRev - totalCost,
          total_hours: totalHours,
          billable_hours: billHours,
        },
      };
    }
  }
}

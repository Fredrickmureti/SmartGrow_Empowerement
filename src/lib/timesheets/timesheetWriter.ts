/**
 * Canonical timesheet writer (Projects Wave 4.4).
 *
 * This module is the ONLY place in the client allowed to insert, update or
 * delete `timesheets` rows. Every write goes through here so that:
 *
 *  - `organization_id` and `business_id` always come from the active workspace
 *    (a row without a business is invisible to business-scoped reads and
 *    corrupts project cost/revenue reporting);
 *  - `billing_rate` / `billing_amount` are never sent — the server trigger
 *    `trg_timesheets_billing` resolves them through
 *    `resolve_project_billing_rate`;
 *  - billability of project time is derived from the project's configuration,
 *    not from whatever the screen happened to hardcode;
 *  - the "which employee am I" lookup exists once.
 *
 * Eligibility (business, branch, membership, project status) is enforced
 * server-side by `_timesheet_assert_project_eligibility`; this module never
 * tries to reproduce or relax those rules.
 */
import { supabase } from "@/integrations/supabase/client";

export interface TimesheetWriteScope {
  organizationId: string;
  businessId: string | null;
  userId: string | null;
}

export interface TimesheetDraft {
  employee_id: string;
  project_id?: string | null;
  task_id?: string | null;
  date: string;
  hours: number;
  description?: string | null;
  /** Omit to derive from the project's billing configuration. */
  is_billable?: boolean;
  status?: "draft" | "submitted" | "approved" | "rejected";
  start_time?: string | null;
  end_time?: string | null;
}

/** Server-derived columns a client must never send. */
const SERVER_OWNED = [
  "billing_rate",
  "billing_amount",
  "organization_id",
  "business_id",
  "employee",
  "project",
  "task",
] as const;

function stripServerOwned<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of SERVER_OWNED) delete out[key];
  return out;
}

/**
 * Resolve the employee record for the signed-in user inside the active
 * workspace. Returns null when the user has no employee profile.
 */
export async function resolveMyEmployeeId(scope: TimesheetWriteScope): Promise<string | null> {
  if (!scope.userId || !scope.businessId) return null;

  const { data, error } = await supabase
    .from("v_employees_canonical")
    .select("id")
    .eq("user_id", scope.userId)
    .eq("organization_id", scope.organizationId)
    .eq("business_id", scope.businessId)
    .maybeSingle();

  if (error) {
    console.error("Error resolving employee for current user:", error);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

/** Billable flag for project time, read from the project's configuration. */
async function resolveBillability(
  scope: TimesheetWriteScope,
  projectIds: string[],
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (projectIds.length === 0) return map;

  const { data, error } = await supabase
    .from("projects")
    .select("id, is_billable")
    .eq("organization_id", scope.organizationId)
    .in("id", projectIds);

  if (error) {
    console.error("Error resolving project billability:", error);
    return map;
  }
  for (const row of (data ?? []) as Array<{ id: string; is_billable: boolean | null }>) {
    map.set(row.id, row.is_billable === true);
  }
  return map;
}

async function toRows(scope: TimesheetWriteScope, drafts: TimesheetDraft[]) {
  const needsBillability = Array.from(
    new Set(
      drafts
        .filter((d) => d.is_billable === undefined && d.project_id)
        .map((d) => d.project_id as string),
    ),
  );
  const billability = await resolveBillability(scope, needsBillability);

  return drafts.map((draft) => {
    const base = stripServerOwned(draft as unknown as Record<string, unknown>);
    const isBillable =
      draft.is_billable !== undefined
        ? draft.is_billable
        : draft.project_id
          ? (billability.get(draft.project_id) ?? false)
          : false;

    return {
      ...base,
      organization_id: scope.organizationId,
      business_id: scope.businessId,
      project_id: draft.project_id ?? null,
      task_id: draft.task_id ?? null,
      description: draft.description ?? null,
      is_billable: isBillable,
      status: draft.status ?? "draft",
      billing_rate: null,
      billing_amount: null,
      created_by: scope.userId,
    };
  });
}

/** Insert one time entry and return the stored row. */
export async function insertTimesheet(scope: TimesheetWriteScope, draft: TimesheetDraft) {
  const [row] = await toRows(scope, [draft]);
  const { data, error } = await supabase
    .from("timesheets")
    .insert(row as never)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Insert several time entries (e.g. copying a week). Returns the row count. */
export async function insertTimesheets(
  scope: TimesheetWriteScope,
  drafts: TimesheetDraft[],
): Promise<number> {
  if (drafts.length === 0) return 0;
  const rows = await toRows(scope, drafts);
  const { error } = await supabase.from("timesheets").insert(rows as never);
  if (error) throw error;
  return rows.length;
}

/** Patch an existing entry. Server-derived columns are dropped. */
export async function updateTimesheet(id: string, updates: Record<string, unknown>) {
  const patch = stripServerOwned(updates);
  const { error } = await supabase
    .from("timesheets")
    .update(patch as never)
    .eq("id", id);
  if (error) throw error;
}

/** Remove an entry. RLS decides whether the caller may. */
export async function deleteTimesheet(id: string) {
  const { error } = await supabase.from("timesheets").delete().eq("id", id);
  if (error) throw error;
}

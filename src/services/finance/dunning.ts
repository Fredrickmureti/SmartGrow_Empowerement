/**
 * Dunning policy service.
 *
 * A dunning level is an ESCALATION RULE, not a balance. The "next action" for a
 * customer is derived server-side by the `dunning_assignment` view, which joins
 * the canonical AR net position (`finance_ar_net_position`) to the configured
 * ladder in `dunning_levels`. Never re-derive an escalation level in the
 * browser from invoice status or from a locally computed days-overdue value.
 */
import { supabase } from "@/integrations/supabase/client";

export type DunningActionType =
  | "reminder"
  | "statement"
  | "call"
  | "escalate"
  | "legal";

export const DUNNING_ACTION_LABELS: Record<DunningActionType, string> = {
  reminder: "Send reminder",
  statement: "Send statement",
  call: "Collection call",
  escalate: "Escalate",
  legal: "Legal action",
};

export interface DunningLevel {
  id: string;
  organizationId: string;
  businessId: string | null;
  name: string;
  sequence: number;
  minDaysOverdue: number;
  actionType: DunningActionType;
  templateId: string | null;
  active: boolean;
}

export interface DunningAssignmentRow {
  contactId: string;
  contactName: string | null;
  netAmount: number;
  maxDaysOverdue: number;
  dunningLevelId: string | null;
  dunningLevelName: string | null;
  dunningSequence: number | null;
  nextAction: DunningActionType | null;
}

/** Configured escalation ladder for a business (org-wide levels included). */
export async function fetchDunningLevels(
  orgId: string,
  businessId?: string | null,
): Promise<DunningLevel[]> {
  let q = supabase
    .from("dunning_levels" as never)
    .select("*")
    .eq("organization_id", orgId)
    .eq("active", true)
    .order("sequence", { ascending: true });

  const { data, error } = await q;
  if (error) throw error;

  return ((data as unknown as Array<Record<string, unknown>>) ?? [])
    .filter(
      (r) =>
        r.business_id === null ||
        !businessId ||
        String(r.business_id) === businessId,
    )
    .map((r) => ({
      id: String(r.id),
      organizationId: String(r.organization_id),
      businessId: (r.business_id as string) ?? null,
      name: String(r.name),
      sequence: Number(r.sequence) || 0,
      minDaysOverdue: Number(r.min_days_overdue) || 0,
      actionType: (r.action_type as DunningActionType) ?? "reminder",
      templateId: (r.template_id as string) ?? null,
      active: Boolean(r.active),
    }));
}

/**
 * Next collection action per customer, straight off the canonical projection.
 * Returned keyed by contact so table rows can look it up in O(1).
 */
export async function fetchDunningAssignments(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
): Promise<Record<string, DunningAssignmentRow>> {
  let q = supabase
    .from("dunning_assignment" as never)
    .select(
      "contact_id, contact_name, net_amount, max_days_overdue, dunning_level_id, dunning_level_name, dunning_sequence, next_action",
    )
    .eq("organization_id", orgId);
  if (businessId) q = q.eq("business_id", businessId);
  if (branchId) q = q.eq("branch_id", branchId);

  const { data, error } = await q;
  if (error) throw error;

  const out: Record<string, DunningAssignmentRow> = {};
  for (const r of (data as unknown as Array<Record<string, unknown>>) ?? []) {
    const contactId = String(r.contact_id);
    const row: DunningAssignmentRow = {
      contactId,
      contactName: (r.contact_name as string) ?? null,
      netAmount: Number(r.net_amount) || 0,
      maxDaysOverdue: Number(r.max_days_overdue) || 0,
      dunningLevelId: (r.dunning_level_id as string) ?? null,
      dunningLevelName: (r.dunning_level_name as string) ?? null,
      dunningSequence:
        r.dunning_sequence === null || r.dunning_sequence === undefined
          ? null
          : Number(r.dunning_sequence),
      nextAction: (r.next_action as DunningActionType) ?? null,
    };
    // A contact can appear once per branch — keep the most escalated row.
    const prev = out[contactId];
    if (!prev || (row.dunningSequence ?? -1) > (prev.dunningSequence ?? -1)) {
      out[contactId] = row;
    }
  }
  return out;
}

/**
 * Statutory Rules — workspace read-model hooks.
 *
 * Wraps the three SECURITY INVOKER views introduced for the Legislative
 * Workspace:
 *   - v_payroll_statutory_rule_status     → per-rule provenance + pending upgrade
 *   - v_payroll_statutory_rule_consumers  → per-rule downstream impact (blast radius)
 *   - v_payroll_statutory_rule_timeline   → per-(country, rule_code) effective-date timeline
 *
 * These are the *only* place the workspace UI reads statutory rules from.
 * Direct `payroll_statutory_rules` reads remain for legacy non-workspace
 * surfaces (engine, payslip drill-down, etc.).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// ────────────────────────────────────────────────────────────────────────
// Types

export type StatutoryRuleDivergence =
  | "pack_clean"
  | "tenant_override"
  | "pending_upgrade"
  | "conflict"
  | "tenant_authored";

export interface StatutoryRuleStatus {
  rule_id: string;
  organization_id: string;
  business_id: string | null;
  country_code: string;
  rule_code: string | null;
  rule_type: string;
  rule_name: string;
  computation_method: string | null;
  parameters: Record<string, any>;
  effective_from: string;
  effective_to: string | null;
  superseded_by: string | null;
  is_active: boolean;
  sort_order: number;
  is_tenant_override: boolean | null;
  base_pack_template_id: string | null;
  base_pack_version: string | null;
  override_reason: string | null;
  override_version: string | null;
  pack_version_id: string | null;
  legacy_unvalidated: boolean | null;
  pinned_pack_id: string | null;
  pinned_pack_version: string | null;
  pinned_pack_name: string | null;
  pinned_installed_at: string | null;
  conflict_status: string | null;
  conflict_from_version: string | null;
  conflict_to_version: string | null;
  conflict_resolution_notes: string | null;
  conflict_resolved_at: string | null;
  pending_proposal_id: string | null;
  pending_to_version: string | null;
  pending_from_version: string | null;
  last_audit_at: string | null;
  divergence: StatutoryRuleDivergence;
}

export interface StatutoryRuleConsumers {
  rule_id: string;
  organization_id: string;
  business_id: string | null;
  country_code: string;
  rule_code: string | null;
  payslip_line_count_12m: number;
  payslip_line_count_total: number;
  gl_account_role_keys: string[];
  remittance_schedules: string[];
  salary_rule_count: number;
}

export interface StatutoryRuleTimelineEntry {
  organization_id: string;
  business_id: string | null;
  country_code: string;
  rule_code: string | null;
  rule_id: string;
  rule_name: string;
  effective_from: string;
  effective_to: string | null;
  superseded_by: string | null;
  is_active: boolean;
  is_tenant_override: boolean | null;
  is_current: boolean;
  is_scheduled: boolean;
  is_superseded: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// Hooks

export function useStatutoryRuleStatus(orgId: string | undefined) {
  return useQuery({
    queryKey: ["statutory-rule-status", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_payroll_statutory_rule_status")
        .select("*")
        .eq("organization_id", orgId)
        .order("country_code")
        .order("rule_type")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as StatutoryRuleStatus[];
    },
    staleTime: 60_000,
  });
}

export function useStatutoryRuleConsumers(ruleId: string | null | undefined) {
  return useQuery({
    queryKey: ["statutory-rule-consumers", ruleId],
    enabled: !!ruleId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_payroll_statutory_rule_consumers")
        .select("*")
        .eq("rule_id", ruleId)
        .maybeSingle();
      if (error) throw error;
      return data as StatutoryRuleConsumers | null;
    },
    staleTime: 60_000,
  });
}

export function useStatutoryRuleTimeline(
  orgId: string | undefined,
  countryCode: string | null | undefined,
  ruleCode: string | null | undefined,
) {
  return useQuery({
    queryKey: ["statutory-rule-timeline", orgId, countryCode, ruleCode],
    enabled: !!orgId && !!countryCode && !!ruleCode,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_payroll_statutory_rule_timeline")
        .select("*")
        .eq("organization_id", orgId)
        .eq("country_code", countryCode)
        .eq("rule_code", ruleCode)
        .order("effective_from", { ascending: true });
      if (error) throw error;
      return (data ?? []) as StatutoryRuleTimelineEntry[];
    },
    staleTime: 60_000,
  });
}

/** Pending upgrade proposals for this org. Drives the inbox tab + header pill. */
export function usePendingUpgradeProposals(orgId: string | undefined) {
  return useQuery({
    queryKey: ["statutory-pending-proposals", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_upgrade_proposals")
        .select("id, pack_id, from_version, to_version, diff, status, created_at, business_id")
        .eq("organization_id", orgId)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60_000,
  });
}

/** Conflict rows touching statutory rules for this org. */
export function useStatutoryRuleConflicts(orgId: string | undefined) {
  return useQuery({
    queryKey: ["statutory-rule-conflicts", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_rule_conflicts")
        .select("*")
        .eq("organization_id", orgId)
        .eq("rule_table", "payroll_statutory_rules")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60_000,
  });
}

/** Latest pack-audit-log entries scoped to statutory rules. */
export function useStatutoryRuleAuditLog(orgId: string | undefined, limit = 50) {
  return useQuery({
    queryKey: ["statutory-rule-audit", orgId, limit],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_audit_log")
        .select("id, action, entity_table, entity_id, before, after, metadata, created_at, actor_id")
        .eq("organization_id", orgId)
        .eq("entity_table", "payroll_statutory_rules")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60_000,
  });
}

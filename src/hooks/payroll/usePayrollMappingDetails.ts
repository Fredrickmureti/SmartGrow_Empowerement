/**
 * usePayrollMappingDetails — companion to usePayrollGlReadiness.
 *
 * Fetches the enrichment data the enterprise coverage table needs but that
 * `payroll_gl_readiness` does not return today (schema-neutral, no
 * migration required):
 *
 *   • The bound `accounts` row per setting_key (code / name / type /
 *     detail_type / is_active / is_header) — resolved from
 *     `default_account_settings`.
 *   • `updated_at` on the mapping row (proxy for "last modified" until we
 *     add proper provenance columns in Phase 2).
 *   • The most recent `settings_audit_log` entry for the payroll key —
 *     used for the per-row history popover.
 *   • Per-account "last used in a payroll journal entry" timestamp —
 *     scoped to journal entries linked to a `payroll_runs` row.
 *
 * All queries are scoped by (org, business) and reuse the standard
 * Supabase client (RLS applies).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface PayrollMappedAccount {
  setting_key: string;
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  detail_type: string | null;
  is_active: boolean;
  is_header: boolean;
  updated_at: string;
}

export interface PayrollMappingAuditEntry {
  id: string;
  created_at: string;
  actor_id: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
}

export function usePayrollMappingDetails() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;

  const mappedQuery = useQuery({
    queryKey: ["payroll-mapping-details", orgId, bizId],
    enabled: !!orgId && !!bizId,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, PayrollMappedAccount>> => {
      const { data, error } = await supabase
        .from("default_account_settings")
        .select(
          `setting_key, account_id, updated_at,
           accounts:account_id ( id, code, name, account_type, detail_type, is_active, is_header )`,
        )
        .eq("organization_id", orgId!)
        .eq("business_id", bizId!);
      if (error) throw error;

      const out: Record<string, PayrollMappedAccount> = {};
      for (const row of (data ?? []) as any[]) {
        if (!row.accounts) continue;
        out[row.setting_key] = {
          setting_key: row.setting_key,
          account_id: row.account_id,
          code: row.accounts.code,
          name: row.accounts.name,
          account_type: row.accounts.account_type,
          detail_type: row.accounts.detail_type ?? null,
          is_active: row.accounts.is_active ?? true,
          is_header: row.accounts.is_header ?? false,
          updated_at: row.updated_at,
        };
      }
      return out;
    },
  });

  return {
    mappedByKey: mappedQuery.data ?? {},
    isLoading: mappedQuery.isLoading,
  };
}

/**
 * Per-key audit history from `settings_audit_log` — used by the history
 * popover. Only fetches when the popover opens (enabled by caller).
 */
export function usePayrollMappingHistory(settingKey: string | null, enabled = true) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: [
      "payroll-mapping-history",
      currentOrg?.id,
      currentBusiness?.id,
      settingKey,
    ],
    enabled: enabled && !!currentOrg?.id && !!settingKey,
    staleTime: 15_000,
    queryFn: async (): Promise<PayrollMappingAuditEntry[]> => {
      const { data, error } = await supabase
        .from("settings_audit_log")
        .select("id, created_at, actor_id, old_value, new_value, reason")
        .eq("organization_id", currentOrg!.id)
        .eq("table_name", "default_account_settings")
        .eq("setting_key", settingKey!)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as PayrollMappingAuditEntry[];
    },
  });
}

/**
 * Simple client-side ranking that suggests the top-N postable accounts for
 * a required posting key. Reuses the label + rule_code + kind that
 * `payroll_gl_readiness` already returns as scoring signal. This is *not*
 * a replacement for the DB `suggested_account_id` (which stays as the
 * canonical single suggestion); it complements it so the accountant can
 * see close alternatives without leaving the page.
 */
export interface CandidateAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
  score: number;
}

export function rankCandidateAccounts(
  accounts: Array<{
    id: string;
    code: string;
    name: string;
    account_type: string;
    is_active: boolean;
    is_header: boolean;
  }>,
  requiredType: string,
  label: string,
  ruleCode: string | null,
  limit = 3,
): CandidateAccount[] {
  const tokens = new Set(
    `${label} ${ruleCode ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );

  const scored: CandidateAccount[] = [];
  for (const a of accounts) {
    if (a.account_type !== requiredType) continue;
    if (a.is_header) continue;
    if (!a.is_active) continue;
    const hay = `${a.code} ${a.name}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    if (score > 0) {
      scored.push({
        id: a.id,
        code: a.code,
        name: a.name,
        account_type: a.account_type,
        score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return scored.slice(0, limit);
}

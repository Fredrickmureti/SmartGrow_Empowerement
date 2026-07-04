/**
 * usePayrollGlUpgradeDiff — Phase 3 pack-upgrade diff.
 *
 * Wraps the `payroll_gl_upgrade_diff(org, business)` RPC and exposes:
 *   • rows grouped by status bucket (new_key / deprecated_key /
 *     stale_pack_version / changed_recommendation)
 *   • an `applyRecommendation` mutation that binds the pack recommendation
 *     for a specific setting_key via `_upsert_default_account_setting`
 *     under `source='pack_upgrade'`.
 *
 * The RPC is read-only and does not mutate any mapping — the panel is
 * purely informational until the accountant chooses an action.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export type PayrollUpgradeDiffStatus =
  | "new_key"
  | "deprecated_key"
  | "stale_pack_version"
  | "changed_recommendation";

export interface PayrollUpgradeDiffRow {
  status: PayrollUpgradeDiffStatus;
  setting_key: string;
  label: string;
  rule_code: string | null;
  kind: string;
  required_account_type: string | null;
  current_account_id: string | null;
  current_account_code: string | null;
  current_account_name: string | null;
  current_source: string | null;
  current_pack_version: string | null;
  installed_pack_version: string | null;
  recommended_account_id: string | null;
  recommended_account_code: string | null;
  recommended_account_name: string | null;
}

export function usePayrollGlUpgradeDiff() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;

  const queryKey = ["payroll-gl-upgrade-diff", orgId, bizId];

  const query = useQuery({
    queryKey,
    enabled: !!orgId && !!bizId,
    staleTime: 60_000,
    queryFn: async (): Promise<PayrollUpgradeDiffRow[]> => {
      const { data, error } = await (supabase as any).rpc(
        "payroll_gl_upgrade_diff",
        { _org_id: orgId, _business_id: bizId },
      );
      if (error) throw error;
      return (data ?? []) as PayrollUpgradeDiffRow[];
    },
  });

  const rows = (query.data ?? []) as PayrollUpgradeDiffRow[];

  const buckets = useMemo(() => {
    return {
      new_key: rows.filter((r) => r.status === "new_key"),
      deprecated_key: rows.filter((r) => r.status === "deprecated_key"),
      stale_pack_version: rows.filter((r) => r.status === "stale_pack_version"),
      changed_recommendation: rows.filter(
        (r) => r.status === "changed_recommendation",
      ),
    };
  }, [rows]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: ["payroll-gl-readiness", orgId, bizId] });
    qc.invalidateQueries({ queryKey: ["payroll-mapping-details", orgId, bizId] });
  };

  const applyRecommendation = useMutation({
    mutationFn: async (row: PayrollUpgradeDiffRow) => {
      if (!orgId || !bizId) throw new Error("Select an organization and business first");
      if (!row.recommended_account_id) {
        throw new Error("No pack recommendation is available for this key");
      }
      const { error } = await (supabase as any).rpc(
        "_upsert_default_account_setting",
        {
          _org_id: orgId,
          _business_id: bizId,
          _branch_id: null,
          _setting_key: row.setting_key,
          _account_id: row.recommended_account_id,
          _source: "pack_upgrade",
          _origin_pack_id: null,
          _origin_pack_version: row.installed_pack_version,
          _overridden_by: null,
          _override_reason: null,
        },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Applied pack recommendation");
      invalidate();
    },
    onError: (e: any) => {
      toast.error(normalizeError(e).message || "Could not apply recommendation");
    },
  });

  const total = rows.length;

  return {
    rows,
    buckets,
    total,
    isLoading: query.isLoading,
    applyRecommendation,
    refetch: query.refetch,
  };
}

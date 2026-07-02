/**
 * useScannerScopePolicy — read + mutate the active Scanner Scope policy.
 *
 * Two layers:
 *   - tenant default    (`scanner_scope_policies` row with user_id IS NULL)
 *   - per-user override (`scanner_scope_policies` row with user_id = me)
 *
 * Resolution: user override wins; otherwise tenant default; otherwise the
 * baseline "ambient" (back-compat — every existing tenant keeps the old
 * focused-field-wins behavior with zero migration).
 *
 * Modes:
 *   - ambient → any focused <BarcodeInputField> across the app receives
 *     scans from any paired phone, regardless of which channel paired it.
 *   - scoped  → POS-paired phones (`pos:scan:<reg>`) only feed the POS
 *     cart; workspace-paired phones (`scan:session:<uuid>`) only feed
 *     <BarcodeInputField>s in non-POS workspaces. Keyboard wedge and
 *     manual entry are NEVER filtered — they keep working everywhere.
 */

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ScannerScopeMode = "ambient" | "scoped";

interface PolicyRow {
  id: string;
  business_id: string;
  user_id: string | null;
  mode: ScannerScopeMode;
}

export interface ScannerScopePolicyResult {
  /** Effective mode after applying user override. */
  mode: ScannerScopeMode;
  /** Tenant default (null if never set; treated as 'ambient'). */
  tenantMode: ScannerScopeMode | null;
  /** Per-user override (null when user is following tenant default). */
  userMode: ScannerScopeMode | null;
  isLoading: boolean;
  /** Update tenant default. Caller is responsible for admin gating in UI. */
  setTenantMode: (next: ScannerScopeMode) => Promise<void>;
  /** Set per-user override. */
  setUserMode: (next: ScannerScopeMode) => Promise<void>;
  /** Remove the user's override so they follow the tenant default again. */
  clearUserMode: () => Promise<void>;
}

function queryKey(businessId: string | null) {
  return ["scanner-scope-policies", businessId ?? "none"] as const;
}

export function useScannerScopePolicy(businessId: string | null | undefined): ScannerScopePolicyResult {
  const qc = useQueryClient();
  const bid = businessId || null;

  const { data, isLoading } = useQuery({
    queryKey: queryKey(bid),
    enabled: !!bid,
    staleTime: 60_000,
    queryFn: async (): Promise<{ tenant: PolicyRow | null; user: PolicyRow | null; me: string | null }> => {
      const { data: ures } = await supabase.auth.getUser();
      const me = ures.user?.id ?? null;
      const { data: rows, error } = await supabase
        .from("scanner_scope_policies" as any)
        .select("id,business_id,user_id,mode")
        .eq("business_id", bid as string);
      if (error) throw error;
      const list = (rows ?? []) as unknown as PolicyRow[];
      const tenant = list.find((r) => r.user_id === null) ?? null;
      const user = me ? list.find((r) => r.user_id === me) ?? null : null;
      return { tenant, user, me };
    },
  });

  const tenantMode = data?.tenant?.mode ?? null;
  const userMode = data?.user?.mode ?? null;
  const mode: ScannerScopeMode = userMode ?? tenantMode ?? "ambient";

  const upsertMutation = useMutation({
    mutationFn: async (payload: { mode: ScannerScopeMode; scope: "tenant" | "user" }) => {
      if (!bid) throw new Error("No business in scope");
      const me = data?.me ?? (await supabase.auth.getUser()).data.user?.id ?? null;
      const row = {
        business_id: bid,
        user_id: payload.scope === "tenant" ? null : me,
        mode: payload.mode,
      };
      const onConflict = payload.scope === "tenant"
        ? "business_id,user_id"
        : "business_id,user_id";
      // Partial unique indexes — fall back to manual upsert.
      const existingId = payload.scope === "tenant" ? data?.tenant?.id : data?.user?.id;
      if (existingId) {
        const { error } = await supabase
          .from("scanner_scope_policies" as any)
          .update({ mode: payload.mode })
          .eq("id", existingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("scanner_scope_policies" as any).insert(row as any);
        if (error) throw error;
      }
      void onConflict;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(bid) }),
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      if (!data?.user?.id) return;
      const { error } = await supabase
        .from("scanner_scope_policies" as any)
        .delete()
        .eq("id", data.user.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(bid) }),
  });

  const setTenantMode = useCallback(
    async (next: ScannerScopeMode) => {
      await upsertMutation.mutateAsync({ mode: next, scope: "tenant" });
    },
    [upsertMutation],
  );
  const setUserMode = useCallback(
    async (next: ScannerScopeMode) => {
      await upsertMutation.mutateAsync({ mode: next, scope: "user" });
    },
    [upsertMutation],
  );
  const clearUserMode = useCallback(async () => {
    await clearMutation.mutateAsync();
  }, [clearMutation]);

  return useMemo(
    () => ({ mode, tenantMode, userMode, isLoading, setTenantMode, setUserMode, clearUserMode }),
    [mode, tenantMode, userMode, isLoading, setTenantMode, setUserMode, clearUserMode],
  );
}

/**
 * Convenience read-only hook for consumers that only need the effective
 * mode (channel hooks, POSTerminal listener). Avoids re-rendering on
 * unrelated policy-row updates.
 */
export function useScannerScopeMode(businessId: string | null | undefined): ScannerScopeMode {
  const { mode } = useScannerScopePolicy(businessId);
  return mode;
}
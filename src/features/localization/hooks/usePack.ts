/**
 * Pack lifecycle hooks for the shared localization editor.
 *
 * These hooks back the `PackEditorShell` and its sub-components in BOTH
 * admin (platform) and tenant (workspace) modes. Reads honour RLS — admin
 * users see all packs, tenant users see installed packs scoped to their
 * organization. Mutations always go through edge functions or RLS-checked
 * tables; nothing client-side is privileged.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invokeLocalizationFn } from "@/features/localization/lib/invokeLocalizationFn";

export interface LocalizationPack {
  id: string;
  country_code: string;
  name: string;
  description: string | null;
  version: string;
  is_active: boolean;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

export interface PackVersion {
  id: string;
  pack_id: string;
  version: string;
  status: "draft" | "published" | "archived" | string;
  changelog: any | null;
  snapshot: any;
  parent_version_id: string | null;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  created_by: string | null;
}

export interface PackUpgradeProposal {
  id: string;
  organization_id: string;
  business_id: string | null;
  pack_id: string;
  from_version: string | null;
  to_version: string;
  diff: any;
  status: "pending" | "accepted" | "rejected" | string;
  decided_by: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  created_at: string;
}

export interface PackAuditEntry {
  id: string;
  pack_id: string | null;
  organization_id: string | null;
  actor_id: string | null;
  scope: string;
  entity_table: string;
  entity_id: string | null;
  action: string;
  before: any;
  after: any;
  metadata: any;
  created_at: string;
}

/**
 * Packs visible to the caller.
 *
 * - `scope: "tenant"` (default): only published+active packs the tenant is
 *   entitled to see. RLS already enforces country + publication scoping
 *   (see `current_user_country_codes()`); the explicit WHERE keeps payload
 *   small and intent obvious.
 * - `scope: "admin"`: full read; platform-admin RLS gates this.
 */
export function usePacks(opts?: { scope?: "tenant" | "admin" }) {
  const scope = opts?.scope ?? "tenant";
  return useQuery({
    queryKey: ["localization-packs", scope],
    queryFn: async (): Promise<LocalizationPack[]> => {
      let q = (supabase as any).from("localization_packs").select("*");
      if (scope === "tenant") {
        q = q.eq("is_published", true).eq("is_active", true);
      }
      const { data, error } = await q.order("country_code").order("name");
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60_000,
  });
}

/** Single pack by id. */
export function usePack(packId?: string | null) {
  return useQuery({
    queryKey: ["localization-pack", packId],
    enabled: !!packId,
    queryFn: async (): Promise<LocalizationPack | null> => {
      const { data, error } = await (supabase as any)
        .from("localization_packs")
        .select("*")
        .eq("id", packId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
}

/** Version timeline (newest first). */
export function usePackVersions(packId?: string | null) {
  return useQuery({
    queryKey: ["pack-versions", packId],
    enabled: !!packId,
    queryFn: async (): Promise<PackVersion[]> => {
      const { data, error } = await (supabase as any)
        .from("pack_versions")
        .select("*")
        .eq("pack_id", packId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Outstanding upgrade proposals for the current tenant (RLS-scoped). */
export function usePackUpgradeProposals(opts?: { packId?: string | null; status?: string }) {
  const { packId, status = "pending" } = opts ?? {};
  return useQuery({
    queryKey: ["pack-upgrade-proposals", packId ?? "all", status],
    queryFn: async (): Promise<PackUpgradeProposal[]> => {
      let q = (supabase as any)
        .from("pack_upgrade_proposals")
        .select("*")
        .order("created_at", { ascending: false });
      if (packId) q = q.eq("pack_id", packId);
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Audit log slice for a pack (admin) or for a tenant's installed pack. */
export function usePackAuditLog(opts?: { packId?: string | null; limit?: number }) {
  const { packId, limit = 100 } = opts ?? {};
  return useQuery({
    queryKey: ["pack-audit-log", packId ?? "all", limit],
    queryFn: async (): Promise<PackAuditEntry[]> => {
      let q = (supabase as any)
        .from("pack_audit_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (packId) q = q.eq("pack_id", packId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Admin-only: publish a new pack version (snapshot + diff + auto-fan-out). */
export function usePublishPackVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      pack_id: string;
      version: string;
      notes?: string;
      propose_upgrades?: boolean;
      skip_lint?: boolean;
    }) => {
      return await invokeLocalizationFn("publish-localization-pack-version", input);
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["pack-versions", vars.pack_id] });
      qc.invalidateQueries({ queryKey: ["localization-pack", vars.pack_id] });
      qc.invalidateQueries({ queryKey: ["pack-upgrade-proposals"] });
      qc.invalidateQueries({ queryKey: ["pack-audit-log"] });
    },
  });
}

/**
 * Tenant: decide on an upgrade proposal.
 *
 * Acceptance routes through the `apply-localization-pack-upgrade` edge
 * function which calls `apply_pack_upgrade_atomic` — a single transaction
 * that diffs the from/to snapshots, inserts added rules, updates
 * non-customised rules in place, end-dates removed rules (never deletes),
 * records `pack_rule_conflicts` rows for customised tenant overrides,
 * bumps `installed_localization_packs.pack_version`, marks the proposal
 * accepted, and writes a `pack_migration_log` audit entry.
 *
 * Rejection stays a row-level update — no side-effects on the tenant rules.
 */
export function useDecidePackUpgradeProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      proposal_id: string;
      decision: "accepted" | "rejected";
      notes?: string;
    }) => {
      if (input.decision === "accepted") {
        // The apply RPC now requires a diff-ack hash on the proposal —
        // the user must have reviewed the diff before we commit it.
        const { error: ackErr } = await (supabase as any).rpc(
          "acknowledge_pack_upgrade_diff",
          { _proposal_id: input.proposal_id },
        );
        if (ackErr) throw ackErr;

        const r = await invokeLocalizationFn<{ ok: boolean; result: Record<string, unknown> }>(
          "apply-localization-pack-upgrade",
          { proposal_id: input.proposal_id },
        );
        return r as unknown as PackUpgradeProposal;
      }
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await (supabase as any)
        .from("pack_upgrade_proposals")
        .update({
          status: "rejected",
          decision_notes: input.notes ?? null,
          decided_by: user?.id ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq("id", input.proposal_id)
        .select()
        .single();
      if (error) throw error;
      return data as PackUpgradeProposal;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-upgrade-proposals"] });
      qc.invalidateQueries({ queryKey: ["payroll-statutory-rules"] });
      qc.invalidateQueries({ queryKey: ["payroll-statutory-rules-admin"] });
      qc.invalidateQueries({ queryKey: ["installed-localization-packs"] });
      qc.invalidateQueries({ queryKey: ["pack-rule-conflicts"] });
    },
  });
}

/**
 * Promote any previously-published version to be the "current" one for
 * either the caller's tenant or every installed tenant. Backed by the
 * `promote-pack-version` edge function which enforces RBAC.
 */
export function usePromotePackVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      pack_id: string;
      version_id: string;
      scope: "self" | "all_tenants";
      notes?: string;
    }) => {
      return await invokeLocalizationFn<{ promoted: number; proposals_logged: number; version: string }>(
        "promote-pack-version",
        input,
      );
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["installed-localization-packs"] });
      qc.invalidateQueries({ queryKey: ["pack-versions", vars.pack_id] });
      qc.invalidateQueries({ queryKey: ["pack-upgrade-proposals"] });
    },
  });
}

/**
 * Pack health: rows that were grandfathered before the schema validator
 * was introduced. Surfaces them so an admin or tenant can re-validate.
 */
export function usePackHealth(packId?: string | null) {
  return useQuery({
    queryKey: ["pack-health", packId ?? "all"],
    enabled: !!packId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_statutory_rules")
        .select("id,rule_code,rule_type,computation_method,parameters,legacy_unvalidated,pack_id")
        .eq("pack_id", packId)
        .eq("legacy_unvalidated", true)
        .order("rule_code");
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        rule_code: string;
        rule_type: string;
        computation_method: string;
        parameters: any;
        legacy_unvalidated: boolean;
        pack_id: string;
      }>;
    },
  });
}
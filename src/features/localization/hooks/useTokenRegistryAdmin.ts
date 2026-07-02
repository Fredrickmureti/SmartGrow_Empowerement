/**
 * useTokenRegistryAdmin — CRUD over `pack_token_registry` rows scoped to a
 * single pack. The platform-reserved tokens (pack_id IS NULL) are read-only
 * here: only platform admins manage those, and they should do so via the
 * platform-admin token catalogue (out of scope for the pack editor).
 *
 * Why deletes are guarded: tokens are the contract between pack authors and
 * the resolver (`_shared/renderTokens.ts`). Removing a token that is still
 * referenced by a certificate/return/template body silently breaks every
 * downstream render at runtime. We resolve consumers by scanning the
 * `localization_pack_*` template bodies for the token path string and block
 * destructive operations when any consumer exists.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PackTokenRow {
  id: string;
  pack_id: string | null;
  token_path: string;
  source: string;
  data_type: string;
  sample_value: unknown | null;
  description: string | null;
  deprecated_in_version: string | null;
  replaces: string | null;
  created_at: string;
}

export interface PackTokenConsumer {
  table: string;
  id: string;
  code: string;
  display_name: string | null;
}

/** All token rows visible for this pack: platform-reserved + pack-scoped. */
export function usePackTokenRegistry(packId?: string | null) {
  return useQuery({
    queryKey: ["pack-token-registry-admin", packId],
    enabled: !!packId,
    queryFn: async (): Promise<PackTokenRow[]> => {
      const orClause = `pack_id.is.null,pack_id.eq.${packId}`;
      const { data, error } = await (supabase as any)
        .from("pack_token_registry")
        .select(
          "id, pack_id, token_path, source, data_type, sample_value, description, deprecated_in_version, replaces, created_at",
        )
        .or(orClause)
        .order("source", { ascending: true })
        .order("token_path", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PackTokenRow[];
    },
  });
}

/**
 * Consumers of a token within the same pack — best-effort discovery used
 * for the deprecation/delete impact dialog. Scans certificate and return
 * template bodies for the token path string. Misses tokens referenced from
 * statutory-rule `parameters` (those are numeric-typed); add as needed.
 */
export function usePackTokenConsumers(packId: string | null, tokenPath: string | null) {
  return useQuery({
    queryKey: ["pack-token-consumers", packId, tokenPath],
    enabled: !!packId && !!tokenPath,
    queryFn: async (): Promise<PackTokenConsumer[]> => {
      const needle = String(tokenPath);
      const results: PackTokenConsumer[] = [];
      const tables: Array<{ table: string; code: string; name: string }> = [
        { table: "localization_pack_certificate_templates", code: "code", name: "display_name" },
        { table: "localization_pack_return_templates", code: "code", name: "display_name" },
      ];
      for (const t of tables) {
        const { data } = await (supabase as any)
          .from(t.table)
          .select(`id, ${t.code}, ${t.name}, body`)
          .eq("pack_id", packId);
        for (const row of (data ?? []) as any[]) {
          const blob = JSON.stringify(row.body ?? {});
          if (blob.includes(needle)) {
            results.push({
              table: t.table,
              id: row.id,
              code: String(row[t.code] ?? ""),
              display_name: row[t.name] ?? null,
            });
          }
        }
      }
      return results;
    },
  });
}

export interface UpsertPackTokenInput {
  id?: string;
  pack_id: string;
  token_path: string;
  source: string;
  data_type: string;
  description?: string | null;
  sample_value?: unknown | null;
  deprecated_in_version?: string | null;
  replaces?: string | null;
}

export function useUpsertPackToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertPackTokenInput) => {
      const payload = {
        pack_id: input.pack_id,
        token_path: input.token_path.trim(),
        source: input.source.trim(),
        data_type: input.data_type.trim(),
        description: input.description ?? null,
        sample_value: input.sample_value ?? null,
        deprecated_in_version: input.deprecated_in_version ?? null,
        replaces: input.replaces ?? null,
      };
      if (input.id) {
        const { data, error } = await (supabase as any)
          .from("pack_token_registry")
          .update(payload)
          .eq("id", input.id)
          .select()
          .single();
        if (error) throw error;
        return data as PackTokenRow;
      }
      const { data, error } = await (supabase as any)
        .from("pack_token_registry")
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      return data as PackTokenRow;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["pack-token-registry-admin", vars.pack_id] });
      qc.invalidateQueries({ queryKey: ["pack_token_registry", vars.pack_id] });
    },
  });
}

export function useDeletePackToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; pack_id: string }) => {
      const { error } = await (supabase as any)
        .from("pack_token_registry")
        .delete()
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["pack-token-registry-admin", vars.pack_id] });
      qc.invalidateQueries({ queryKey: ["pack_token_registry", vars.pack_id] });
    },
  });
}

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { PackRuleSchema, PackToken } from "./types";

/** All registered rule-type schemas (platform-wide registry). */
export function useRuleSchemas() {
  return useQuery({
    queryKey: ["pack-rule-type-schemas"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("pack_rule_type_schemas")
        .select("*")
        .order("rule_type")
        .order("computation_kind");
      if (error) throw error;
      return (data ?? []) as PackRuleSchema[];
    },
    staleTime: 10 * 60_000,
  });
}

/** Resolve a single schema for (rule_type, computation_kind) — latest version. */
export function useRuleSchema(rule_type?: string | null, computation_kind?: string | null) {
  const { data: all, isLoading } = useRuleSchemas();
  const match = (all ?? [])
    .filter((s) => s.rule_type === rule_type && s.computation_kind === computation_kind)
    .sort((a, b) => b.schema_version - a.schema_version)[0];
  return { schema: match ?? null, isLoading };
}

/** Token registry for a given pack (plus platform-wide tokens). */
export function useTokenRegistry(pack_id?: string | null) {
  return useQuery({
    queryKey: ["pack-token-registry", pack_id ?? "platform"],
    queryFn: async () => {
      let q = (supabase as any).from("pack_token_registry").select("*").order("token_path");
      if (pack_id) q = q.or(`pack_id.is.null,pack_id.eq.${pack_id}`);
      else q = q.is("pack_id", null);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as PackToken[];
    },
    staleTime: 10 * 60_000,
  });
}

/** Server-authoritative payload validation. */
export async function validatePayload(input:
  | { kind: "rule"; rule_type: string; parameters: any }
  | { kind: "template"; pack_id?: string | null; body: any }
  | { kind: "return_template"; body: any }
) {
  const { data, error } = await (supabase as any).functions.invoke(
    "localization-pack",
    { body: { op: "validate-localization-payload", ...input } },
  );
  if (error) throw error;
  return data as { valid: boolean; errors: string[]; warnings: string[] };
}

/**
 * usePackTokens — load the available source paths for a return-template
 * column from the canonical `pack_token_registry` table.
 *
 * Returns the union of:
 *   - platform-reserved tokens (pack_id IS NULL — earnings/deductions
 *     aggregates and the standard employee/run/system attributes), and
 *   - the current pack's pack-scoped tokens (e.g. KRA PIN / NSSF / NHIF
 *     for the Kenya pack, SSNIT for a Ghana pack, etc.).
 *
 * Replaces the previous hardcoded `KNOWN_SOURCES` constant in
 * `ReturnTemplateEditor.tsx`. New countries do not require any frontend
 * change — they only need to ship their tokens via the pack registry.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PackTokenOption = {
  value: string;
  label: string;
  numeric: boolean;
  source: string;
  description?: string | null;
  deprecated?: boolean;
};

type Row = {
  token_path: string;
  source: string;
  data_type: string;
  description: string | null;
  deprecated_in_version: string | null;
  pack_id: string | null;
};

const NUMERIC_TYPES = new Set(["currency", "number", "numeric", "decimal", "integer", "money"]);

function rowToOption(r: Row): PackTokenOption {
  const numeric = NUMERIC_TYPES.has((r.data_type ?? "").toLowerCase());
  // Human label: "Source — Path" so Kenya identifiers, Ghana identifiers,
  // and platform aggregates all read coherently.
  const tail = r.token_path.includes(".") ? r.token_path.split(".").slice(1).join(".") : r.token_path;
  const head =
    r.source === "system" ? "Aggregate" : r.source.charAt(0).toUpperCase() + r.source.slice(1);
  const label = `${head} — ${tail}`;
  return {
    value: r.token_path,
    label,
    numeric,
    source: r.source,
    description: r.description,
    deprecated: !!r.deprecated_in_version,
  };
}

export function usePackTokens(packId?: string | null) {
  return useQuery({
    queryKey: ["pack_token_registry", packId ?? null],
    queryFn: async (): Promise<PackTokenOption[]> => {
      // pack_id IS NULL → platform-reserved tokens; current pack's
      // pack-scoped tokens layered on top.
      const orClause = packId ? `pack_id.is.null,pack_id.eq.${packId}` : "pack_id.is.null";
      const { data, error } = await supabase
        .from("pack_token_registry" as any)
        .select(
          "token_path, source, data_type, description, deprecated_in_version, pack_id",
        )
        .or(orClause)
        .order("source", { ascending: true })
        .order("token_path", { ascending: true });
      if (error) throw error;
      const rows = ((data ?? []) as unknown) as Row[];
      // Deduplicate: pack-scoped overrides platform-reserved if same path.
      const byPath = new Map<string, Row>();
      for (const r of rows) {
        const existing = byPath.get(r.token_path);
        if (!existing || (existing.pack_id == null && r.pack_id != null)) {
          byPath.set(r.token_path, r);
        }
      }
      return Array.from(byPath.values()).map(rowToOption);
    },
    staleTime: 60_000,
  });
}

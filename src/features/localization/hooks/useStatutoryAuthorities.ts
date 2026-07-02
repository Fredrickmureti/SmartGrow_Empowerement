/**
 * useStatutoryAuthorities — load the pack-owned statutory authority
 * registry (KRA, NSSF-KE, SARS, …) so the return-template editor can
 * bind `authority_id` to a real record instead of a free-text string.
 *
 * Authorities are pack-scoped (ADR-0036 §I7): platform-reserved rows
 * (pack_id IS NULL) are unioned with the current pack's rows so a
 * cross-pack authority (rare) and pack-specific ones both surface.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type StatutoryAuthorityOption = {
  id: string;
  pack_id: string | null;
  country_code: string;
  code: string;
  display_name: string;
  portal_url: string | null;
  efiling_endpoint: string | null;
};

export function useStatutoryAuthorities(packId?: string | null) {
  return useQuery({
    queryKey: ["statutory_authorities", packId ?? null],
    queryFn: async (): Promise<StatutoryAuthorityOption[]> => {
      const orClause = packId ? `pack_id.is.null,pack_id.eq.${packId}` : "pack_id.is.null";
      const { data, error } = await (supabase as any)
        .from("statutory_authorities")
        .select("id, pack_id, country_code, code, display_name, portal_url, efiling_endpoint")
        .or(orClause)
        .order("country_code")
        .order("code");
      if (error) throw error;
      return (data ?? []) as StatutoryAuthorityOption[];
    },
    staleTime: 60_000,
  });
}

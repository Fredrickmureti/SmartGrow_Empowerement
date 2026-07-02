/**
 * useOrganizationStatutoryIdentifiers — employer-side mirror of
 * `useEmployeeStatutoryIdentifiers`.
 *
 * The companion table `organization_statutory_identifiers` stores the
 * *employer*'s statutory IDs (Tax PIN, NSSF employer number, EIN, UTR,
 * etc.). The `payslip_header` RPC reads these and surfaces them on the
 * payslip PDF and portal view. Without a write path the consumer was
 * dead — every payslip shipped with an empty Employer block.
 *
 * Country-agnostic: the list of fields rendered by the consuming UI
 * comes from `pack_requirements` (scope = 'statutory_identifier').
 * This hook only persists rows keyed by
 * `(organization_id, business_id, country_code, identifier_type)`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface OrganizationStatutoryIdentifierRow {
  id: string;
  organization_id: string;
  business_id: string | null;
  country_code: string;
  identifier_type: string;
  identifier_value: string;
  is_active: boolean;
}

export interface UpsertOrgStatutoryIdentifierInput {
  identifier_type: string;
  country_code: string;
  identifier_value: string;
}

export function useOrganizationStatutoryIdentifiers(
  organizationId: string | null | undefined,
  businessId: string | null | undefined,
) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: [
      "organization-statutory-identifiers",
      organizationId,
      businessId ?? null,
    ],
    enabled: !!organizationId,
    queryFn: async (): Promise<OrganizationStatutoryIdentifierRow[]> => {
      let q = (supabase as any)
        .from("organization_statutory_identifiers")
        .select(
          "id, organization_id, business_id, country_code, identifier_type, identifier_value, is_active",
        )
        .eq("organization_id", organizationId)
        .eq("is_active", true);
      // Include both business-scoped and org-wide rows. The RPC accepts
      // either; filtering here would hide org-wide IDs from the editor.
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as OrganizationStatutoryIdentifierRow[];
    },
  });

  const upsert = useMutation({
    mutationFn: async (input: UpsertOrgStatutoryIdentifierInput) => {
      if (!organizationId) throw new Error("No organization selected");
      const value = (input.identifier_value ?? "").trim();
      const identifier_type = input.identifier_type.trim();
      const country_code = (input.country_code ?? "").trim().toUpperCase().slice(0, 2);
      if (!identifier_type) throw new Error("identifier_type is required");
      if (!country_code) throw new Error("country_code is required");

      // Find existing row (active or soft-deleted) for this composite key
      // so an empty value soft-deletes and a re-entered value reactivates.
      // NOTE: PostgREST `is.` only accepts null/true/false; for a concrete
      // UUID we MUST use `eq.`. Mixing them produced a 400.
      let lookup = (supabase as any)
        .from("organization_statutory_identifiers")
        .select("id, is_active")
        .eq("organization_id", organizationId)
        .eq("country_code", country_code)
        .eq("identifier_type", identifier_type);
      lookup = businessId
        ? lookup.eq("business_id", businessId)
        : lookup.is("business_id", null);
      const { data: existing, error: lookupError } = await lookup
        .limit(1)
        .maybeSingle();
      if (lookupError) throw lookupError;

      if (value === "") {
        if (existing) {
          const { error } = await (supabase as any)
            .from("organization_statutory_identifiers")
            .update({ is_active: false })
            .eq("id", existing.id);
          if (error) throw error;
        }
        return;
      }

      if (existing) {
        const { error } = await (supabase as any)
          .from("organization_statutory_identifiers")
          .update({ identifier_value: value, is_active: true })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("organization_statutory_identifiers")
          .insert({
            organization_id: organizationId,
            business_id: businessId ?? null,
            country_code,
            identifier_type,
            identifier_value: value,
            is_active: true,
          });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["organization-statutory-identifiers", organizationId],
      });
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  return {
    rows: query.data ?? [],
    isLoading: query.isLoading,
    refetch: query.refetch,
    upsert,
  };
}

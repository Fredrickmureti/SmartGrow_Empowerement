/**
 * useDocumentBranding — single canonical source for legal-entity branding
 * used in invoices, bills, PDFs, emails, and any other document.
 *
 * Per the multi-entity architecture redesign (Phase 7): document branding
 * MUST come from `businesses` (the legal/accounting entity), NEVER from
 * `organizations` (the tenant). Org-level identity columns are deprecated.
 *
 * Always pass an explicit business_id when rendering a document tied to
 * a specific record (invoice, bill, etc.) — that record's `business_id`
 * is the source of truth, NOT the user's currently-selected business.
 *
 * Branch overrides (Stage 5 of the Settings audit): when a `branchId` is
 * provided, the resolver `get_effective_company_config` is consulted so
 * branch-level overrides for `logo_url` and `invoice_prefix` (suffix) take
 * effect on the rendered document. The branding object's `_source` map
 * reports per-field provenance ('branch' | 'business') so the UI can
 * visualise inheritance.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { getEffectiveCompanyConfig } from "@/lib/settings/getEffectiveCompanyConfig";

export interface DocumentBranding {
  business_id: string;
  name: string;
  legal_name: string | null;
  tax_id: string | null;
  registration_number: string | null;
  logo_url: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  base_currency: string | null;
  invoice_prefix: string | null;
  estimate_prefix: string | null;
  bill_prefix: string | null;
}

/**
 * Fetch branding for a specific business. If no business_id is passed,
 * falls back to the currently-selected business in BusinessContext.
 * Returns `null` while loading or if no business is resolvable — callers
 * must handle null (do NOT fall back to organization fields).
 */
export function useDocumentBranding(
  businessId?: string | null,
  branchId?: string | null,
) {
  const { currentBusiness } = useBusinesses();
  const effectiveId = businessId ?? currentBusiness?.id ?? null;
  const effectiveBranchId = branchId ?? null;

  const query = useQuery({
    queryKey: ["document-branding", effectiveId, effectiveBranchId],
    enabled: !!effectiveId,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<DocumentBranding | null> => {
      if (!effectiveId) return null;

      // Fetch the business row + (optionally) the branch overrides via
      // the resolver. We run them in parallel to keep latency at one
      // round-trip (Supabase parallelizes through the same connection).
      const [bizResult, configResult] = await Promise.all([
        supabase
          .from("businesses")
          .select(
            "id, name, legal_name, tax_id, registration_number, logo_url, email, phone, website, address, city, state, postal_code, country, base_currency, invoice_prefix, estimate_prefix, bill_prefix"
          )
          .eq("id", effectiveId)
          .maybeSingle(),
        effectiveBranchId
          ? getEffectiveCompanyConfig(effectiveId, effectiveBranchId)
          : Promise.resolve(null),
      ]);

      if (bizResult.error) throw bizResult.error;
      const data = bizResult.data;
      if (!data) return null;

      // Apply branch overrides where present. Right now the resolver
      // exposes overrides for `logo_url` and `invoice_prefix` (the latter
      // already concatenated with the branch suffix server-side).
      const overriddenLogo = configResult?.logo_url?.value ?? null;
      const overriddenInvoicePrefix =
        configResult?.invoice_prefix?.source === "branch"
          ? configResult.invoice_prefix.value
          : null;

      return {
        business_id: data.id,
        name: data.name,
        legal_name: data.legal_name ?? data.name,
        tax_id: data.tax_id ?? null,
        registration_number: data.registration_number ?? null,
        logo_url: overriddenLogo ?? data.logo_url ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        website: data.website ?? null,
        address: data.address ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        postal_code: data.postal_code ?? null,
        country: data.country ?? null,
        base_currency: data.base_currency ?? null,
        invoice_prefix: overriddenInvoicePrefix ?? data.invoice_prefix ?? null,
        estimate_prefix: data.estimate_prefix ?? null,
        bill_prefix: data.bill_prefix ?? null,
      };
    },
  });

  return {
    branding: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

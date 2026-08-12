/**
 * ADR 0135 — resolves the currency a new purchasing document should be created in.
 *
 * Resolution order (server-authoritative party → role lookup, then base currency):
 *   suppliers.default_currency → contacts.default_currency → businesses.base_currency
 *
 * This is a *proposal* default only. The database stamps and freezes the document's
 * currency and exchange rate on insert; the browser never computes FX.
 */
import { useQuery } from "@tanstack/react-query";
import { useCurrency } from "@/hooks/useCurrency";
import { useBusinesses } from "@/contexts/BusinessContext";
import { resolveSupplierDefaults } from "./supplierRpcs";

export function useSupplierDocumentCurrency(vendorId: string | null | undefined) {
  const { baseCurrency } = useCurrency();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["supplier-document-currency", businessId, vendorId],
    enabled: !!businessId && !!vendorId,
    staleTime: 1000 * 60 * 5,
    queryFn: async () => {
      const defaults = await resolveSupplierDefaults(businessId!, vendorId!);
      return defaults?.currency ?? null;
    },
  });

  return {
    /** Currency the document should be created in. Never null once base currency loads. */
    currency: data ?? baseCurrency,
    /** True when the supplier proposes a currency other than the reporting base. */
    isForeign: !!data && !!baseCurrency && data !== baseCurrency,
    baseCurrency,
    isResolving: isLoading,
  };
}
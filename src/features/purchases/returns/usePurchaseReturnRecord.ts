import { useDocumentRecord } from "@/design-system";
import type { PurchaseReturn } from "@/hooks/usePurchaseReturns";

/**
 * usePurchaseReturnRecord — canonical single-record fetch for the
 * Purchase Return peek + record page. Uses the shared
 * `useDocumentRecord` scaffold so behaviour matches every other
 * business record in the ERP.
 */
export function usePurchaseReturnRecord(id: string | null | undefined) {
  return useDocumentRecord<PurchaseReturn>({
    table: "purchase_returns",
    select:
      "*, vendor:contacts(name, email), items:purchase_return_items(*)",
    id,
    entityLabel: "Purchase return",
  });
}

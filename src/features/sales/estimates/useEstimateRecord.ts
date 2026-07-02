import { useSalesDocumentRecord } from "@/features/sales/record";
import type { Estimate } from "@/hooks/useEstimates";

export function useEstimateRecord(id: string | null | undefined) {
  return useSalesDocumentRecord<Estimate>({
    table: "estimates",
    select: "*, contact:contacts(name, email), items:estimate_items(*)",
    id,
    entityLabel: "Estimate",
  });
}

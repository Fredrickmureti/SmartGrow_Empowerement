import { useDocumentRecord } from "@/features/sales/record";
import type { Estimate } from "@/hooks/useEstimates";

export function useEstimateRecord(id: string | null | undefined) {
  return useDocumentRecord<Estimate>({
    table: "estimates",
    select: "*, contact:contacts(name, email), items:estimate_items(*)",
    id,
    entityLabel: "Estimate",
  });
}

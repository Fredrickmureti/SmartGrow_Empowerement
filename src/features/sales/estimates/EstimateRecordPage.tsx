/**
 * EstimateRecordPage — the full-page projection of `useEstimateView`.
 */
import { useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useRecordPrint } from "@/features/sales/record/useRecordPrint";
import { useCurrency } from "@/hooks/useCurrency";
import { useEstimateView } from "./estimateView";

export default function EstimateRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatCurrency } = useCurrency();
  const { print, printing } = useRecordPrint("estimate");
  const isNew = id === "new";
  const { estimate, view } = useEstimateView(isNew ? null : id, formatCurrency);

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New estimate"
      onPrint={
        estimate && !printing
          ? () => void print(estimate.id, `Estimate ${estimate.estimate_number}`)
          : undefined
      }
    />
  );
}

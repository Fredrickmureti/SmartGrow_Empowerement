/**
 * EstimateRecordPage — the full-page projection of `useEstimateView`.
 *
 * Actions come from `useEstimateActions`, the same array the list row menu
 * renders, so the full page is never a read-only dead end.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useEstimateView } from "./estimateView";
import { useEstimateActions } from "./useEstimateActions";

export default function EstimateRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { estimate, refresh, view } = useEstimateView(
    isNew ? null : id,
    formatCurrency,
  );

  const { actions, dialogs } = useEstimateActions(estimate, {
    onChanged: refresh,
    onDeleted: () => navigate("/sales/estimates"),
  });

  return (
    <>
      <RecordScaffold {...view} id={id} newLabel="New estimate" actions={actions} />
      {dialogs}
    </>
  );
}

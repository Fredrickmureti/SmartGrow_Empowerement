/**
 * LandedCostRecordPage — the full-page projection of `useLandedCostView`.
 * Actions come from `useLandedCostActions`, the same vocabulary the list
 * row menu and the peek drawer render.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useLandedCostView } from "./landedCostView";
import { useLandedCostActions } from "./useLandedCostActions";

export default function LandedCostRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { record, view, refresh } = useLandedCostView(
    isNew ? null : id,
    formatCurrency,
  );

  const { actions, dialogs } = useLandedCostActions(record, {
    onChanged: refresh,
    onDeleted: () => navigate("/purchases/landed-costs"),
  });

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New landed cost voucher"
        actions={actions}
      />
      {dialogs}
    </>
  );
}

/**
 * RFQRecordPage — `/purchases/rfqs/:id`.
 * Read-only body powered by `useRFQView`; the header renders the shared
 * `useRFQActions` vocabulary (Edit / Mark sent / Mark received / Cancel /
 * Delete) so the full page is never a dead end.
 */
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQView } from "./rfqView";
import { useRFQActions } from "./useRFQActions";

export default function RFQRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const { rfq, view } = useRFQView(isNew ? null : id, formatCurrency);

  const actions = useRFQActions(rfq, {
    onDeleted: () => navigate("/purchases/rfqs"),
  });

  return (
    <RecordScaffold {...view} id={id} newLabel="New RFQ" actions={actions} />
  );
}

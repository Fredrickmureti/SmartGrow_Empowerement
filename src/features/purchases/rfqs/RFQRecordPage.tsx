/**
 * RFQRecordPage — `/purchases/rfqs/:id`.
 * Read-only body powered by `useRFQView`; the header renders the shared
 * `useRFQActions` lifecycle vocabulary (Submit / Approve / Release / Award /
 * Convert / Revise / Cancel / Delete), each backed by a server-side RPC.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { RecordScaffold } from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQView } from "./rfqView";
import { useRFQActions } from "./useRFQActions";
import { RFQAwardDrawer } from "./RFQAwardDrawer";

export default function RFQRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const isNew = id === "new";
  const [awardOpen, setAwardOpen] = useState(false);
  const { rfq, view } = useRFQView(isNew ? null : id, formatCurrency);

  const actions = useRFQActions(rfq, {
    onDeleted: () => navigate("/purchases/rfqs"),
    onAward: () => setAwardOpen(true),
  });

  return (
    <>
      <RecordScaffold {...view} id={id} newLabel="New RFQ" actions={actions} />
      <RFQAwardDrawer rfq={rfq} open={awardOpen} onOpenChange={setAwardOpen} />
    </>
  );
}

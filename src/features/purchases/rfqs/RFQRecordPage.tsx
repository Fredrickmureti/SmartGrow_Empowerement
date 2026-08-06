/**
 * RFQRecordPage — `/purchases/rfqs/:id`.
 * Read-only body powered by `useRFQView`; header carries the lifecycle
 * actions (Edit / Send / Mark received / Cancel / Delete).
 */
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Ban, FileText, Pencil, Send, Trash2 } from "lucide-react";

import { ActionBar } from "@/design-system";
import { RecordScaffold } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQs } from "@/hooks/useRFQs";
import { useRFQView } from "./rfqView";

export default function RFQRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { updateStatus, deleteRFQ } = useRFQs();
  const isNew = id === "new";
  const { rfq, view } = useRFQView(isNew ? null : id, formatCurrency);

  const isDraft = rfq?.status === "draft";

  const headerActions = rfq ? (
    <ActionBar>
      <Button variant="outline" size="sm" onClick={() => navigate("/purchases/rfqs")}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>
      {isDraft && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/purchases/rfqs/${rfq.id}/edit`)}
        >
          <Pencil className="mr-2 h-4 w-4" /> Edit
        </Button>
      )}
      {isDraft && (
        <Button size="sm" onClick={() => updateStatus({ id: rfq.id, status: "sent" })}>
          <Send className="mr-2 h-4 w-4" /> Mark sent
        </Button>
      )}
      {rfq.status === "sent" && (
        <Button size="sm" onClick={() => updateStatus({ id: rfq.id, status: "received" })}>
          <FileText className="mr-2 h-4 w-4" /> Mark received
        </Button>
      )}
      {["draft", "sent", "received"].includes(rfq.status) && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => updateStatus({ id: rfq.id, status: "cancelled" })}
        >
          <Ban className="mr-2 h-4 w-4" /> Cancel
        </Button>
      )}
      {isDraft && (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => {
            if (confirm(`Delete RFQ ${rfq.rfq_number}?`)) {
              deleteRFQ(rfq.id);
              navigate("/purchases/rfqs");
            }
          }}
        >
          <Trash2 className="mr-2 h-4 w-4" /> Delete
        </Button>
      )}
    </ActionBar>
  ) : undefined;

  return (
    <RecordScaffold
      {...view}
      id={id}
      newLabel="New RFQ"
      headerActions={headerActions}
    />
  );
}

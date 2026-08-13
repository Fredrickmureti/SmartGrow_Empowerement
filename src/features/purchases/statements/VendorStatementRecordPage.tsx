/**
 * VendorStatementRecordPage — object-page route for a saved Vendor
 * Statement at `/purchases/statements/:id`.
 *
 * The page owns routing and actions only; every piece of document content
 * comes from the shared `useVendorStatementView` descriptor, which the peek
 * sheet also renders.
 */
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { Download, Send } from "lucide-react";

import { RecordScaffold } from "@/design-system/records";
import type { DocumentAction } from "@/design-system/records";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { useCurrency } from "@/hooks/useCurrency";
import {
  useVendorStatementView,
  useVendorStatementActions,
} from "./vendorStatementView";

export default function VendorStatementRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatCurrency } = useCurrency();
  const { record, view } = useVendorStatementView(id, formatCurrency);
  const { dispatching, download, print, emailOpen, setEmailOpen, sendDocument } =
    useVendorStatementActions(record);

  // One action vocabulary — the same array the Statements row menu renders.
  const actions = useMemo<DocumentAction[]>(
    () =>
      record
        ? [
            {
              id: "download",
              label: "Download PDF",
              icon: Download,
              primary: true,
              disabled: dispatching,
              disabledReason: dispatching ? "Preparing the document…" : undefined,
              onSelect: () => void download(),
            },
            {
              id: "print",
              label: "Print",
              icon: Printer,
              disabled: dispatching,
              onSelect: () => void print(),
            },
            {
              id: "email",
              label: "Send",
              icon: Send,
              primary: true,
              onSelect: () => setEmailOpen(true),
            },
          ]
        : [],
    [record, dispatching, download, print, setEmailOpen],
  );

  return (
    <>
      <RecordScaffold
        {...view}
        id={id}
        newLabel="New statement"
        newDescription={
          <>
            Vendor statements are produced from the{" "}
            <strong>Generate statement</strong> action on the Statements list.
          </>
        }
        actions={actions}
      />
      {sendDocument && (
        <SendDocumentDialog
          open={emailOpen}
          onOpenChange={setEmailOpen}
          document={sendDocument}
        />
      )}
    </>
  );
}

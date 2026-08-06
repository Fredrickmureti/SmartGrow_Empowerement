/**
 * VendorStatementRecordPage — object-page route for a saved Vendor
 * Statement at `/purchases/statements/:id`.
 *
 * The page owns routing and actions only; every piece of document content
 * comes from the shared `useVendorStatementView` descriptor, which the peek
 * sheet also renders.
 */
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, Send, Loader2 } from "lucide-react";

import { ActionBar } from "@/design-system";
import { RecordScaffold } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { useCurrency } from "@/hooks/useCurrency";
import {
  useVendorStatementView,
  useVendorStatementActions,
} from "./vendorStatementView";

export default function VendorStatementRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { record, view } = useVendorStatementView(id, formatCurrency);
  const { dispatching, download, emailOpen, setEmailOpen, sendDocument } =
    useVendorStatementActions(record);

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
        headerActions={
          <ActionBar>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/purchases/statements")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
            {record && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={download}
                  disabled={dispatching}
                >
                  {dispatching ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  Download PDF
                </Button>
                <Button size="sm" onClick={() => setEmailOpen(true)}>
                  <Send className="mr-2 h-4 w-4" /> Send
                </Button>
              </>
            )}
          </ActionBar>
        }
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

/**
 * VendorStatementPeekSheet — drawer projection of the same
 * `useVendorStatementView` descriptor that the record page renders, so the
 * two surfaces cannot drift. This file owns the frame and the actions only.
 */
import { Download, Send, Loader2 } from "lucide-react";

import { PeekScaffold } from "@/design-system/records";
import { Button } from "@/components/ui/button";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { useCurrency } from "@/hooks/useCurrency";
import {
  useVendorStatementView,
  useVendorStatementActions,
} from "./vendorStatementView";

interface Props {
  statementId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function VendorStatementPeekSheet({ statementId, onOpenChange }: Props) {
  const { formatCurrency } = useCurrency();
  const { record, view } = useVendorStatementView(statementId, formatCurrency);
  const { dispatching, download, print, emailOpen, setEmailOpen, sendDocument } =
    useVendorStatementActions(record);

  return (
    <>
      <PeekScaffold
        {...view}
        open={!!statementId}
        onOpenChange={onOpenChange}
        fullPageHref={
          record ? `/purchases/statements/${record.header.id}` : undefined
        }
        extraHeaderActions={
          record ? (
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
                PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void print()}
                disabled={dispatching}
              >
                <Printer className="mr-2 h-4 w-4" />
                Print
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEmailOpen(true)}
              >
                <Send className="mr-2 h-4 w-4" />
                Send
              </Button>
            </>
          ) : null
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

export default VendorStatementPeekSheet;

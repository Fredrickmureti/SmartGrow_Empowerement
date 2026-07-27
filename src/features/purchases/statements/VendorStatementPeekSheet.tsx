/**
 * VendorStatementPeekSheet — standard peek surface for one saved
 * Vendor Statement on `/purchases/statements?peek=<id>`. Retires the
 * inline preview `Dialog` in `src/pages/VendorStatements.tsx` for the
 * VIEW path (row click / "View statement" action). The Generate flow
 * remains a picker + confirm-style workflow because it operates on an
 * unsaved computed statement.
 */
import { useState } from "react";
import { format } from "date-fns";
import { Download, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  DocumentPeekShell,
  Section,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { VendorStatementPreview } from "@/components/purchases/VendorStatementPreview";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useBranches } from "@/hooks/useBranches";
import { normalizeError } from "@/lib/errors/normalizeError";
import { useVendorStatementRecord } from "./useVendorStatementRecord";
import { dispatchVendorStatement } from "./dispatchVendorStatement";

interface Props {
  statementId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function VendorStatementPeekSheet({ statementId, onOpenChange }: Props) {
  const { record, loading, error } = useVendorStatementRecord(statementId);
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { currentBranch } = useBranches();
  const [dispatching, setDispatching] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const handleDownload = async () => {
    if (!record || dispatching) return;
    setDispatching(true);
    try {
      const result = await dispatchVendorStatement({
        statementId: record.header.id,
        organizationId: currentOrg?.id ?? null,
        businessId: currentBusiness?.id ?? null,
        branchId: currentBranch?.id ?? null,
      });
      toast.success(`Statement dispatched to ${result.targetCount} target(s).`);
    } catch (err) {
      toast.error(`Failed to dispatch statement: ${normalizeError(err).message}`);
    } finally {
      setDispatching(false);
    }
  };


  return (
    <>
      <DocumentPeekShell
        open={!!statementId}
        onOpenChange={onOpenChange}
        loading={loading}
        error={error}
        errorTitle="Unable to load vendor statement"
        fullPageHref={
          record ? `/purchases/statements/${record.header.id}` : undefined
        }
        title={
          loading
            ? "Loading statement…"
            : record
              ? `Vendor Statement — ${record.data.contact.name}`
              : "Vendor Statement"
        }
        description={
          record ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={record.header.sent_at ? "success" : "neutral"}>
                {record.header.sent_at ? "Sent" : "Draft"}
              </StatusBadge>
              <span className="text-muted-foreground">
                {format(new Date(record.header.period_start), "MMM d, yyyy")} –{" "}
                {format(new Date(record.header.period_end), "MMM d, yyyy")}
              </span>
            </span>
          ) : undefined
        }
        extraHeaderActions={
          record ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={isGeneratingPdf}
              >
                {isGeneratingPdf ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                PDF
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
      >
        {record && (
          <div className="space-y-5">
            <Section title="Statement">
              <VendorStatementPreview data={record.data} />
            </Section>
          </div>
        )}
      </DocumentPeekShell>
      {record && (
        <SendDocumentDialog
          open={emailOpen}
          onOpenChange={setEmailOpen}
          document={{
            documentType: "vendor_statement",
            documentId: record.header.id,
            documentNumber: `Vendor_Statement_${format(
              new Date(record.header.statement_date),
              "yyyy-MM-dd",
            )}`,
            recipientEmail: record.data.contact.email || "",
            recipientName: record.data.contact.name,
            total: record.data.closingBalance,
            currency: currentBusiness?.base_currency,
          }}
        />
      )}
    </>
  );
}

export default VendorStatementPeekSheet;
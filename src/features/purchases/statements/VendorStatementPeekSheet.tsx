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
import {
  DocumentPeekShell,
  Section,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { normalizeError } from "@/services/resilience";
import { VendorStatementPreview } from "@/components/purchases/VendorStatementPreview";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useVendorStatementRecord } from "./useVendorStatementRecord";

interface Props {
  statementId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function VendorStatementPeekSheet({ statementId, onOpenChange }: Props) {
  const { record, loading, error } = useVendorStatementRecord(statementId);
  const { currentBusiness } = useBusinesses();
  const [downloading, setDownloading] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const handleDownload = async () => {
    if (!record) return;
    setDownloading(true);
    try {
      const { downloadPdfBlob } = await import("@/services/printing/pdfUtils");
      const { data, error: fnErr } = await supabase.functions.invoke(
        "generate-document",
        {
          body: {
            documentType: "vendor_statement",
            documentId: record.header.id,
            format: "pdf",
          },
        },
      );
      if (fnErr) throw fnErr;
      const blob =
        data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
      const filename = `Vendor_Statement_${record.data.contact.name.replace(
        /[^a-zA-Z0-9]/g,
        "_",
      )}_${format(new Date(), "yyyy-MM-dd")}.pdf`;
      downloadPdfBlob(blob, filename);
      toast.success("Vendor statement PDF downloaded");
    } catch (err: any) {
      toast.error(
        "Failed to generate statement PDF: " +
          (normalizeError(err).message || "Unknown error"),
      );
    } finally {
      setDownloading(false);
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
                disabled={downloading}
              >
                {downloading ? (
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
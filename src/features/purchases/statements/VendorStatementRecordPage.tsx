/**
 * VendorStatementRecordPage — full read-only object page for a saved
 * Vendor Statement at `/purchases/statements/:id`. Uses the shared
 * `RecordShell` chain so this page renders exactly like every other
 * Purchases record (Bill, PO, Vendor Credit Note, Purchase Return).
 * Body reuses the same `VendorStatementPreview` component that the peek
 * sheet and PDF pipeline consume, guaranteeing peek/full/print parity.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import { ArrowLeft, Download, Send, Loader2 } from "lucide-react";

import {
  ActionBar,
  ErrorState,
  FooterActionBar,
  LoadingState,
  RecordHeader,
  RecordShell,
  Section,
  StatusBadge,
  SummaryPanel,
  DocumentTotalsPanel,
  DocumentActivityPanel,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { useBusinesses } from "@/hooks/useBusinesses";
import { VendorStatementPreview } from "@/components/purchases/VendorStatementPreview";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";
import { useDocumentPrint } from "@/hooks/useDocumentPrint";
import { useVendorStatementRecord } from "./useVendorStatementRecord";

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

export default function VendorStatementRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { currentBusiness } = useBusinesses();
  const { record, loading, error } = useVendorStatementRecord(id);
  const { downloadPdf, isGeneratingPdf } = useDocumentPrint();
  const [emailOpen, setEmailOpen] = useState(false);

  const back = () => navigate("/purchases/statements");

  const handleDownload = async () => {
    if (!record) return;
    const filename = `Vendor_Statement_${record.data.contact.name.replace(
      /[^a-zA-Z0-9]/g,
      "_",
    )}_${format(new Date(), "yyyy-MM-dd")}`;
    await downloadPdf("vendor_statement", record.header.id, filename);
  };

  if (loading) {
    return (
      <RecordShell
        header={<RecordHeader eyebrow="Vendor Statement" title="Loading…" />}
      >
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !record) {
    return (
      <RecordShell
        header={
          <RecordHeader
            eyebrow="Vendor Statement"
            title="Vendor Statement"
            actions={
              <ActionBar>
                <Button variant="outline" size="sm" onClick={back}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
              </ActionBar>
            }
          />
        }
      >
        <Section>
          <ErrorState
            title="Unable to load vendor statement"
            description={error ?? "Unknown error."}
            onRetry={back}
          />
        </Section>
      </RecordShell>
    );
  }

  const { header, data } = record;

  return (
    <>
      <RecordShell
        header={
          <RecordHeader
            eyebrow="Vendor Statement"
            title={data.contact.name}
            docNumber={
              header.statement_date
                ? format(new Date(header.statement_date), "PP")
                : undefined
            }
            status={
              <StatusBadge tone={header.sent_at ? "success" : "neutral"}>
                {header.sent_at ? "Sent" : "Draft"}
              </StatusBadge>
            }
            meta={
              <>
                <span>
                  Period {fmtDate(header.period_start)} –{" "}
                  {fmtDate(header.period_end)}
                </span>
                <span className="tabular-nums">
                  {formatCurrency(header.closing_balance ?? 0)}{" "}
                  {currentBusiness?.base_currency ?? ""}
                </span>
              </>
            }
            actions={
              <ActionBar>
                <Button variant="outline" size="sm" onClick={back}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
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
                  Download PDF
                </Button>
                <Button size="sm" onClick={() => setEmailOpen(true)}>
                  <Send className="mr-2 h-4 w-4" /> Send
                </Button>
              </ActionBar>
            }
          />
        }
        aside={
          <SummaryPanel>
            <DocumentTotalsPanel
              rows={[
                {
                  label: "Opening balance",
                  value: formatCurrency(header.opening_balance ?? 0),
                },
                {
                  label: "Billed in period",
                  value: formatCurrency(header.total_billed ?? 0),
                },
                {
                  label: "Payments",
                  value: `- ${formatCurrency(header.total_payments ?? 0)}`,
                  muted: true,
                },
                {
                  label: "Closing balance",
                  value: formatCurrency(header.closing_balance ?? 0),
                  emphasized: true,
                },
              ]}
              footer={`Currency ${currentBusiness?.base_currency ?? ""}`}
            />
            <DocumentActivityPanel
              entries={[
                {
                  id: "generated",
                  at: fmtDate(header.created_at),
                  actor: "System",
                  title: `Statement generated`,
                },
                ...(header.sent_at
                  ? [
                      {
                        id: "sent",
                        at: fmtDate(header.sent_at),
                        actor: "User",
                        title: `Sent to ${header.sent_to ?? "vendor"}`,
                      },
                    ]
                  : []),
              ]}
            />
          </SummaryPanel>
        }
        footer={
          <FooterActionBar
            trailing={
              <Button variant="outline" onClick={back}>
                Close
              </Button>
            }
          />
        }
      >
        <Section title="Statement">
          <VendorStatementPreview data={data} />
        </Section>
      </RecordShell>
      <SendDocumentDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        document={{
          documentType: "vendor_statement",
          documentId: header.id,
          documentNumber: `Vendor_Statement_${format(
            new Date(header.statement_date),
            "yyyy-MM-dd",
          )}`,
          recipientEmail: data.contact.email || "",
          recipientName: data.contact.name,
          total: data.closingBalance,
          currency: currentBusiness?.base_currency,
        }}
      />
    </>
  );
}

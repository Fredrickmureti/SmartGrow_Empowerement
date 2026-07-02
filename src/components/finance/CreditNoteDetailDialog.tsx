import { useState, useEffect } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { useNavigate } from "react-router-dom";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { SendSmsButton } from "@/components/sms/SendSmsButton";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { DocumentHistoryTab } from "@/components/common/DocumentHistoryTab";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCreditNotes, CreditNote, CreditNoteApplication } from "@/hooks/useCreditNotes";
import { useCurrency } from "@/hooks/useCurrency";
import { useDocumentPrint } from "@/hooks/useDocumentPrint";
import { ReprintButton } from "@/components/printing/ReprintButton";
import { format, parseISO } from "date-fns";
import {
  FileText,
  ArrowRight,
  DollarSign,
  Loader2,
  RotateCcw,
  Printer,
  Download,
  Clock,
  Calendar,
  Building2,
  Hash,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface CreditNoteDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creditNote: CreditNote | null;
  onApplyCredit?: () => void;
  onProcessRefund?: () => void;
  onViewInvoice?: (invoiceId: string) => void;
}

interface JournalEntryLine {
  account_name: string;
  account_code: string;
  debit: number;
  credit: number;
}

interface JournalEntryRow {
  id: string;
  entry_number: string;
  date: string;
  description: string | null;
  status: string;
  lines: JournalEntryLine[];
}

export function CreditNoteDetailDialog({
  open,
  onOpenChange,
  creditNote,
  onApplyCredit,
  onProcessRefund,
  onViewInvoice,
}: CreditNoteDetailDialogProps) {
  const { getCreditApplications } = useCreditNotes();
  const { formatCurrency } = useCurrency();
  const { printDocument, downloadPdf, isGeneratingPdf } = useDocumentPrint();
  const navigate = useNavigate();
  const [applications, setApplications] = useState<CreditNoteApplication[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [journalEntries, setJournalEntries] = useState<JournalEntryRow[]>([]);
  const [loadingJEs, setLoadingJEs] = useState(false);
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);

  useEffect(() => {
    if (open && creditNote?.id) {
      setLoadingApps(true);
      getCreditApplications(creditNote.id)
        .then(setApplications)
        .catch(() => setApplications([]))
        .finally(() => setLoadingApps(false));

      // Fetch JEs using proper source_id lookup (not fragile text matching)
      setLoadingJEs(true);
      const fetchJEs = async () => {
        try {
          const { data } = await supabase
            .from("journal_entries")
            .select("id, entry_number, entry_date, description, status")
            .eq("source_id", creditNote.id)
            .order("entry_date", { ascending: false });

          if (!data || data.length === 0) {
            setJournalEntries([]);
            return;
          }
          const jeIds = data.map((je) => je.id);
          const { data: allLines } = await supabase
            .from("journal_entry_lines")
            .select("journal_entry_id, debit, credit, accounts:account_id(name, code)")
            .in("journal_entry_id", jeIds)
            .order("debit", { ascending: false });

          const linesByJE: Record<string, JournalEntryLine[]> = {};
          (allLines || []).forEach((l: any) => {
            if (!linesByJE[l.journal_entry_id]) linesByJE[l.journal_entry_id] = [];
            linesByJE[l.journal_entry_id].push({
              account_name: l.accounts?.name || "Unknown",
              account_code: l.accounts?.code || "",
              debit: l.debit || 0,
              credit: l.credit || 0,
            });
          });

          setJournalEntries(data.map((je) => ({
            id: je.id,
            entry_number: je.entry_number,
            date: je.entry_date,
            description: je.description,
            status: je.status,
            lines: linesByJE[je.id] || [],
          })));
        } catch {
          setJournalEntries([]);
        } finally {
          setLoadingJEs(false);
        }
      };
      fetchJEs();
    }
  }, [open, creditNote?.id]);

  if (!creditNote) return null;

  const refundAmount = creditNote.refund_amount || 0;
  const available = creditNote.total - creditNote.amount_applied - refundAmount;
  const usedPercent = creditNote.total > 0 ? ((creditNote.amount_applied + refundAmount) / creditNote.total) * 100 : 0;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary">Draft</Badge>;
      case "issued":
        return available > 0
          ? <Badge variant="default">Open</Badge>
          : <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">Fully Used</Badge>;
      case "applied":
        return <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">Fully Applied</Badge>;
      case "void":
        return <Badge variant="destructive">Void</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const contactId = creditNote.contact_id;
  const contactPhone = (creditNote.contact as any)?.phone || "";

  return (
    <>
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          Credit Note {creditNote.credit_note_number}
          {getStatusBadge(creditNote.status)}
        </span>
      }
      description={
        <div className="flex items-center justify-between gap-4">
          <div>
            {contactId ? (
              <ClickableEntity onClick={() => { setContactDrawerId(contactId); setContactDrawerOpen(true); }} className="text-sm">
                {creditNote.contact?.name || "Unknown Customer"}
              </ClickableEntity>
            ) : (
              <span className="text-sm text-muted-foreground">
                {creditNote.contact?.name || "Unknown Customer"}
              </span>
            )}
          </div>
          <div className="text-right">
            <div className="text-lg font-bold">{formatCurrency(creditNote.total, creditNote.currency)}</div>
            {available > 0 && creditNote.status !== "draft" && (
              <div className="text-xs text-primary font-medium">
                {formatCurrency(available, creditNote.currency)} available
              </div>
            )}
          </div>
        </div>
      }
    >
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-5">

            <Separator />

            {/* Details Grid */}
            <div className="grid grid-cols-2 gap-4">
              <DetailRow icon={Calendar} label="Issue Date" value={format(parseISO(creditNote.issue_date), "MMMM d, yyyy")} />
              <DetailRow icon={Building2} label="Customer" value={
                contactId ? (
                  <ClickableEntity onClick={() => { setContactDrawerId(contactId); setContactDrawerOpen(true); }}>
                    {creditNote.contact?.name || "—"}
                  </ClickableEntity>
                ) : (creditNote.contact?.name || "—")
              } />
              <DetailRow icon={FileText} label="Original Invoice" value={
                creditNote.invoice?.invoice_number ? (
                  <ClickableEntity onClick={() => {
                    onOpenChange(false);
                    navigate(`/sales/invoices?id=${creditNote.invoice_id}`);
                  }}>
                    {creditNote.invoice.invoice_number}
                  </ClickableEntity>
                ) : "—"
              } />
              {creditNote.reason && (
                <DetailRow icon={Hash} label="Reason" value={creditNote.reason} />
              )}
              <DetailRow icon={DollarSign} label="Applied" value={<span className="text-emerald-600">{formatCurrency(creditNote.amount_applied, creditNote.currency)}</span>} />
              <DetailRow icon={DollarSign} label="Refunded" value={<span className="text-orange-600">{formatCurrency(refundAmount, creditNote.currency)}</span>} />
            </div>

            {/* Source Return */}
            {creditNote.source_return && (
              <>
                <Separator />
                <div className="flex items-start gap-2.5 rounded-lg border p-3">
                  <RotateCcw className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="text-sm flex items-center gap-1.5">
                    <span className="text-muted-foreground">Source: </span>
                    <ClickableEntity onClick={() => {
                      if (creditNote.source_return_id) {
                        onOpenChange(false);
                        navigate(`/sales/returns?id=${creditNote.source_return_id}`);
                      }
                    }}>
                      {creditNote.source_return.return_number}
                    </ClickableEntity>
                    <Badge variant="outline" className="text-[10px]">Sales Return</Badge>
                  </div>
                </div>
              </>
            )}

            {/* Credit Utilization */}
            {creditNote.status !== "draft" && (
              <>
                <Separator />
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Credit Utilization</span>
                    <span className="font-medium text-foreground">{Math.round(usedPercent)}%</span>
                  </div>
                  <Progress value={usedPercent} className="h-2" />
                </div>
              </>
            )}

            {/* Quick Actions */}
            {(creditNote.status !== "draft" || creditNote.invoice_id) && (
              <>
                <Separator />
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isGeneratingPdf || creditNote.status === "draft"}
                    onClick={() => printDocument("credit_note", creditNote.id, `Credit Note ${creditNote.credit_note_number}`)}
                  >
                    <Printer className="h-4 w-4 mr-2" />
                    Print
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isGeneratingPdf || creditNote.status === "draft"}
                    onClick={() => downloadPdf("credit_note", creditNote.id, `CreditNote-${creditNote.credit_note_number}`)}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download PDF
                  </Button>
                  {creditNote.status !== "draft" && (
                    <ReprintButton
                      kind="receipt"
                      documentKind="credit_note"
                      sourceDocType="credit_note"
                      sourceDocId={creditNote.id}
                      documentNumber={creditNote.credit_note_number}
                      receiptData={{ kind: "credit_note", creditNoteId: creditNote.id, number: creditNote.credit_note_number }}
                    />
                  )}
                  {available > 0 && creditNote.status === "issued" && onApplyCredit && (
                    <Button size="sm" onClick={onApplyCredit}>
                      <ArrowRight className="h-4 w-4 mr-2" />
                      Apply to Invoice
                    </Button>
                  )}
                  {available > 0 && creditNote.status === "issued" && onProcessRefund && (
                    <Button variant="outline" size="sm" onClick={onProcessRefund}>
                      <DollarSign className="h-4 w-4 mr-2" />
                      Process Refund
                    </Button>
                  )}
                  <SendSmsButton
                    recipientPhone={contactPhone}
                    recipientName={creditNote.contact?.name || ""}
                    variables={{
                      customer_name: creditNote.contact?.name || "",
                      credit_note_number: creditNote.credit_note_number,
                      amount: String(creditNote.total),
                    }}
                    context={{ entityType: "credit_note", entityId: creditNote.id }}
                  />
                </div>
              </>
            )}

            {/* Line Items */}
            {creditNote.items && creditNote.items.length > 0 && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Line Items
                  </h4>
                  <div className="rounded-lg border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/50">
                          <TableHead>Description</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Price</TableHead>
                          <TableHead className="text-right">Tax</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {creditNote.items.map((item, idx) => (
                          <TableRow key={item.id || idx}>
                            <TableCell>{item.description}</TableCell>
                            <TableCell className="text-right">{item.quantity}</TableCell>
                            <TableCell className="text-right">{formatCurrency(item.unit_price, creditNote.currency)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(item.tax_amount, creditNote.currency)}</TableCell>
                            <TableCell className="text-right font-medium">{formatCurrency(item.line_total, creditNote.currency)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="mt-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Subtotal</span>
                     <span>{formatCurrency(creditNote.subtotal, creditNote.currency)}</span>
                    </div>
                    {creditNote.tax_amount > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Tax</span>
                        <span>{formatCurrency(creditNote.tax_amount, creditNote.currency)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-medium text-base border-t pt-2">
                      <span>Total</span>
                      <span>{formatCurrency(creditNote.total, creditNote.currency)}</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Applications */}
            {!loadingApps && applications.length > 0 && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <ArrowRight className="h-4 w-4" />
                    Applications ({applications.length})
                  </h4>
                  <div className="rounded-lg border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/50">
                          <TableHead>Invoice</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Notes</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {applications.map((app) => (
                          <TableRow key={app.id}>
                            <TableCell className="font-mono text-sm">
                              {app.invoice_id ? (
                                <ClickableEntity onClick={() => {
                                  onOpenChange(false);
                                  navigate(`/sales/invoices?id=${app.invoice_id}`);
                                }}>
                                  {app.invoice?.invoice_number || app.invoice_id}
                                </ClickableEntity>
                              ) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-medium">{formatCurrency(app.amount, creditNote.currency)}</TableCell>
                            <TableCell>{format(parseISO(app.applied_at), "MMM d, yyyy")}</TableCell>
                            <TableCell className="text-muted-foreground max-w-[200px] truncate">{app.notes || "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </>
            )}

            {/* Refund Info */}
            {refundAmount > 0 && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Refund Processed
                  </h4>
                  <div className="rounded-lg border p-3 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Amount</span>
                      <span className="font-medium">{formatCurrency(refundAmount, creditNote.currency)}</span>
                    </div>
                    {creditNote.refund_date && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Date</span>
                        <span>{format(parseISO(creditNote.refund_date), "MMM d, yyyy")}</span>
                      </div>
                    )}
                    {creditNote.refund_method && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Method</span>
                        <span className="capitalize">{creditNote.refund_method.replace("_", " ")}</span>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Journal Entries — with debit/credit lines */}
            {!loadingJEs && journalEntries.length > 0 && (
              <>
                <Separator />
                <div className="space-y-4">
                  {journalEntries.map((je) => (
                    <div key={je.id}>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-medium flex items-center gap-2">
                          <FileText className="h-4 w-4" />
                          {je.entry_number}
                          <Badge variant={je.status === "posted" ? "default" : "secondary"} className="text-[10px]">
                            {je.status}
                          </Badge>
                        </h4>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {format(parseISO(je.date), "MMM d, yyyy")}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => {
                              onOpenChange(false);
                              navigate(`/finance/journal-entries?selected=${je.id}`);
                            }}
                          >
                            View Full Entry
                            <ArrowRight className="h-3 w-3 ml-1" />
                          </Button>
                        </div>
                      </div>
                      {je.lines.length > 0 ? (
                        <div className="rounded-lg border overflow-hidden">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-muted/50">
                                <th className="text-left px-3 py-2 font-medium">Account</th>
                                <th className="text-right px-3 py-2 font-medium">Debit</th>
                                <th className="text-right px-3 py-2 font-medium">Credit</th>
                              </tr>
                            </thead>
                            <tbody>
                              {je.lines.map((line, i) => (
                                <tr key={i} className="border-t">
                                  <td className="px-3 py-2">
                                    <span className="text-muted-foreground mr-1">{line.account_code}</span>
                                    {line.account_name}
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {line.debit > 0 ? formatCurrency(line.debit, creditNote.currency) : "—"}
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {line.credit > 0 ? formatCurrency(line.credit, creditNote.currency) : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">{je.description || "No line details available"}</p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Activity History */}
            <Separator />
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Activity History
              </h4>
              <DocumentHistoryTab entityType="credit_note" entityId={creditNote.id} />
            </div>
          </div>
        </ScrollArea>
    </DetailSheet>


    <ContactPreviewDrawer
      open={contactDrawerOpen}
      onOpenChange={setContactDrawerOpen}
      contactId={contactDrawerId}
    />
    </>
  );
}

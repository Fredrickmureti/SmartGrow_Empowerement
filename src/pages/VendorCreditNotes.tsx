/**
 * Vendor Credit Notes list.
 *
 * ADR 0132: the list is a *view* of the tri-status lifecycle (commercial /
 * accounting / settlement) owned by the server. It renders the shared
 * `useVendorCreditNoteActions` array through `VendorCreditNoteRowActions`, so
 * the row menu can never drift from the record page, and it holds no apply
 * dialog of its own — allocation of credit against bills is a server command
 * reached through the shared "Apply to bills" action.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useVendorCreditNotes } from "@/hooks/useVendorCreditNotes";
import { useCurrency } from "@/hooks/useCurrency";
import { PermissionGate } from "@/components/common/PermissionGate";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { usePeekParam } from "@/design-system";
import { DocumentStatusBadge } from "@/design-system/records";
import { VendorCreditNotePeekSheet } from "@/features/purchases/credit-notes/VendorCreditNotePeekSheet";
import { VendorCreditNoteRowActions } from "@/features/purchases/credit-notes/VendorCreditNoteRowActions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Plus,
  Search,
  Loader2,
  FileText,
} from "lucide-react";
import { format } from "date-fns";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";

/**
 * The commercial state is what an operator filters on: it is the state the
 * claim is in with the supplier. Accounting and settlement states are shown
 * on the record, not used as list filters, so the two vocabularies never get
 * mixed into one misleading dropdown.
 */
const COMMERCIAL_FILTERS = [
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "approved", label: "Approved" },
  { value: "disputed", label: "Disputed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
] as const;

type CreditNoteRow = ReturnType<typeof useVendorCreditNotes>["creditNotes"][number];

/** Fallback for rows written before the tri-status columns existed. */
function commercialStateOf(cn: CreditNoteRow): string {
  return (
    cn.commercial_status ??
    (cn.status === "draft" ? "draft" : cn.status === "void" ? "cancelled" : "approved")
  );
}

function accountingStateOf(cn: CreditNoteRow): string {
  return (
    cn.accounting_status ??
    (cn.status === "draft" ? "unposted" : cn.status === "void" ? "reversed" : "posted")
  );
}

export default function VendorCreditNotes() {
  const { creditNotes, isLoading, confirmVendorCreditNote, deleteVendorCreditNote, applyToBill, refreshCreditNotes } = useVendorCreditNotes();
  const navigate = useNavigate();
  // Vendors used to be prefetched here for a create dialog picker; the
  // create flow is now the RecordFormShell route at /purchases/credit-notes/new,
  // so this list no longer needs the contacts fetch.
  const { bills } = useBills();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);
  const [applyDialogCN, setApplyDialogCN] = useState<typeof creditNotes[number] | null>(null);
  const [applyBillId, setApplyBillId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");
  const [peekId, setPeekId] = usePeekParam();

  const outstandingBills = bills.filter((b) => ["received", "partial", "overdue"].includes(b.status));

  const handleOpenCreate = () => {
    navigate("/purchases/credit-notes/new");
  };

  const filteredNotes = creditNotes.filter((cn) => {
    const matchesSearch =
      cn.credit_note_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cn.vendor?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || cn.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">Vendor Credit Notes</h1>
              <p className="text-sm text-muted-foreground">Track supplier credits and debit notes that reduce AP liability</p>
            </div>
            <RefreshButton onRefresh={refreshCreditNotes} tooltip="Refresh credit notes" />
          </div>
          <div className="flex items-center gap-2">
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "credit_note_number", header: "Credit Note #", width: 16 },
                  { key: "vendor", header: "Vendor", width: 20 },
                  { key: "credit_date", header: "Date", width: 12 },
                  { key: "status", header: "Status", width: 10 },
                  { key: "total", header: "Total", width: 14 },
                  { key: "applied_amount", header: "Applied", width: 14 },
                  { key: "remaining", header: "Remaining", width: 14 },
                ];
                return {
                  title: "Vendor Credit Notes",
                  columns: cols,
                  rows: filteredNotes.map((cn: any) => ({
                    credit_note_number: cn.credit_note_number,
                    vendor: cn.vendor?.name || "—",
                    credit_date: format(new Date(cn.credit_date), "MMM d, yyyy"),
                    status: cn.status,
                    total: cn.total,
                    applied_amount: cn.applied_amount || 0,
                    remaining: cn.total - (cn.applied_amount || 0),
                  })),
                  generatedAt: new Date(),
                  currency: baseCurrency,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="managePurchases">
              <Button onClick={handleOpenCreate}>
                <Plus className="mr-2 h-4 w-4" /> New Credit Note
              </Button>
            </PermissionGate>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search credit notes..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9 w-full" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="applied">Applied</SelectItem>
              <SelectItem value="void">Void</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="text-center py-12">
            <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium">No vendor credit notes</h3>
            <p className="text-muted-foreground mb-4">Create credit notes when vendors issue refunds or credits</p>
            <PermissionGate permission="managePurchases">
              <Button variant="outline" size="sm" onClick={handleOpenCreate}>
                <Plus className="mr-2 h-4 w-4" /> Create Credit Note
              </Button>
            </PermissionGate>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Linked Bill</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Applied</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredNotes.map((cn) => {
                  const badge = statusBadge[cn.status] || statusBadge.draft;
                  return (
                    <TableRow key={cn.id} className="cursor-pointer" onClick={() => setPeekId(cn.id)}>
                      <TableCell className="font-medium font-mono">{cn.credit_note_number}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {cn.vendor ? (
                          <ClickableEntity onClick={() => setPreviewContactId(cn.vendor_id)}>
                            {cn.vendor.name}
                          </ClickableEntity>
                        ) : "—"}
                      </TableCell>
                      <TableCell>{format(new Date(cn.credit_date), "MMM d, yyyy")}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {cn.bill_id && cn.bill?.bill_number ? (
                          <ClickableEntity onClick={() => navigate(`/purchases/bills?id=${cn.bill_id}`)}>
                            {cn.bill.bill_number}
                          </ClickableEntity>
                        ) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(cn.total, cn.currency)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(cn.amount_applied, cn.currency)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setPeekId(cn.id)}>
                              <Eye className="mr-2 h-4 w-4" /> View Details
                            </DropdownMenuItem>
                            {cn.status === "draft" && (
                              <>
                                <DropdownMenuItem onClick={() => confirmVendorCreditNote(cn.id)}>
                                  <CheckCircle className="mr-2 h-4 w-4" /> Confirm & Post GL
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => deleteVendorCreditNote(cn.id)}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                                </DropdownMenuItem>
                              </>
                            )}
                            {cn.status === "confirmed" && (
                              <DropdownMenuItem onClick={() => {
                                setApplyDialogCN(cn);
                                setApplyAmount(String(cn.total - cn.amount_applied));
                                setApplyBillId(cn.bill_id || "");
                              }}>
                                <FileText className="mr-2 h-4 w-4" /> Apply to Bill
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>


      {/* Apply to Bill Dialog */}
      <Dialog open={!!applyDialogCN} onOpenChange={(open) => { if (!open) setApplyDialogCN(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply Credit to Bill</DialogTitle>
            <DialogDescription>
              {applyDialogCN && `Apply ${applyDialogCN.credit_note_number} (remaining: ${formatCurrency(applyDialogCN.total - applyDialogCN.amount_applied, applyDialogCN.currency)})`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Select Bill</Label>
              <Select value={applyBillId} onValueChange={setApplyBillId}>
                <SelectTrigger><SelectValue placeholder="Choose a bill" /></SelectTrigger>
                <SelectContent>
                  {outstandingBills
                    .filter((b) => !applyDialogCN?.vendor_id || b.vendor_id === applyDialogCN.vendor_id)
                    .map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.bill_number} — Balance: {formatCurrency(b.total - (b.amount_paid || 0), b.currency)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount to Apply</Label>
              <Input
                type="number"
                step="0.01"
                value={applyAmount}
                onChange={(e) => setApplyAmount(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyDialogCN(null)}>Cancel</Button>
            <Button
              disabled={isSubmitting || !applyBillId || !applyAmount}
              onClick={async () => {
                if (!applyDialogCN) return;
                setIsSubmitting(true);
                try {
                  await applyToBill(applyDialogCN.id, applyBillId, Number(applyAmount));
                  setApplyDialogCN(null);
                } catch (err: any) {
                  toast({ title: "Error applying credit", description: normalizeError(err).message, variant: "destructive" });
                } finally {
                  setIsSubmitting(false);
                }
              }}
            >
              {isSubmitting ? "Applying..." : "Apply Credit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ContactPreviewDrawer
        open={!!previewContactId}
        onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
        contactId={previewContactId}
      />

      <VendorCreditNotePeekSheet
        creditNoteId={peekId}
        onOpenChange={(open) => { if (!open) setPeekId(null); }}
      />
    </>
  );
}

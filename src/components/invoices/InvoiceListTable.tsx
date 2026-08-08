/**
 * InvoiceListTable - Extracted from Invoices.tsx for maintainability
 */
import { Invoice } from "@/hooks/useInvoicesPaginated";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal, Eye, FileSearch, Printer, Mail, Edit, CheckCircle2, Send, CreditCard, History, Receipt, RotateCcw, Ban, Trash2, ExternalLink,
} from "lucide-react";
import { format } from "date-fns";
import { useNavigate } from "react-router-dom";

interface InvoiceListTableProps {
  invoices: Invoice[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  allSelected: boolean;
  onViewDetails: (invoice: Invoice) => void;
  onPrint: (invoice: Invoice) => void;
  /** Read-only preview — renders the document without dispatching a job. */
  onPreview?: (invoice: Invoice) => void;
  onEmail: (invoice: Invoice) => void;
  onEdit: (invoice: Invoice) => void;
  onStatusChange: (invoice: Invoice, status: Invoice["status"]) => void;
  onRecordPayment: (invoice: Invoice) => void;
  onViewPaymentHistory: (invoice: Invoice) => void;
  onViewReceipt: (invoice: Invoice) => void;
  onCreateCreditNote: (invoice: Invoice) => void;
  onCreateReturn: (invoice: Invoice) => void;
  onVoid: (invoice: Invoice) => void;
  onDelete: (invoice: Invoice) => void;
  onPreviewContact: (contactId: string) => void;
  isAdmin: boolean;
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  confirmed: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  sent: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  viewed: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  partial: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  paid: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  overdue: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  cancelled: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  voided: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 line-through",
};

export function InvoiceListTable({
  invoices,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  allSelected,
  onViewDetails,
  onPrint,
  onPreview,
  onEmail,
  onEdit,
  onStatusChange,
  onRecordPayment,
  onViewPaymentHistory,
  onViewReceipt,
  onCreateCreditNote,
  onCreateReturn,
  onVoid,
  onDelete,
  onPreviewContact,
  isAdmin,
}: InvoiceListTableProps) {
  const { formatCurrency } = useCurrency();
  const { getUserName } = useOrgMembers();
  const navigate = useNavigate();

  const getStatusBadge = (status: Invoice["status"]) => {
    const statusKey = status as string;
    const displayStatus = statusKey === "voided" ? "VOID" : statusKey === "confirmed" ? "Confirmed" : status;
    return <Badge className={statusStyles[statusKey] || statusStyles.cancelled}>{displayStatus}</Badge>;
  };

  return (
    <div className="table-container">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Checkbox checked={allSelected} onCheckedChange={onToggleSelectAll} aria-label="Select all" />
            </TableHead>
            <TableHead>Invoice #</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Salesperson</TableHead>
            <TableHead>Issue Date</TableHead>
            <TableHead>Due Date</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Balance</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((invoice) => (
            <TableRow key={invoice.id} className={`cursor-pointer ${selectedIds.has(invoice.id) ? "bg-muted/50" : ""}`} onClick={() => onViewDetails(invoice)}>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selectedIds.has(invoice.id)} onCheckedChange={() => onToggleSelect(invoice.id)} aria-label={`Select ${invoice.invoice_number}`} />
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex items-center gap-1.5">
                  {invoice.invoice_number}
                  {invoice.notes?.startsWith("[POS]") && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-accent/50 border-primary/30 text-primary">POS</Badge>
                  )}
                </div>
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                {invoice.contact_id && invoice.contact?.name ? (
                  <ClickableEntity onClick={() => onPreviewContact(invoice.contact_id)}>{invoice.contact.name}</ClickableEntity>
                ) : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{getUserName(invoice.salesperson_id)}</TableCell>
              <TableCell>{format(new Date(invoice.issue_date), "MMM d, yyyy")}</TableCell>
              <TableCell>
                <div className="flex items-center gap-1.5">
                  {format(new Date(invoice.due_date), "MMM d, yyyy")}
                  {(() => {
                    const isOverdue = isInvoiceOverdue(invoice);

                    if (!isOverdue) return null;
                    const daysOverdue = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
                    const severity = daysOverdue > 90 ? "bg-destructive text-destructive-foreground"
                      : daysOverdue > 60 ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                      : daysOverdue > 30 ? "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300"
                      : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
                    return <Badge className={`${severity} text-[10px] px-1.5 py-0 h-5 font-medium`}>{daysOverdue}d</Badge>;
                  })()}
                </div>
              </TableCell>
              <TableCell>{getStatusBadge(invoice.status)}</TableCell>
              <TableCell className="text-right">{formatCurrency(invoice.total, invoice.currency)}</TableCell>
              <TableCell className="text-right">
                <span className={invoice.total - invoice.amount_paid > 0 ? "text-destructive" : "text-green-600"}>
                  {formatCurrency(invoice.total - invoice.amount_paid, invoice.currency)}
                </span>
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onViewDetails(invoice)}><Eye className="mr-2 h-4 w-4" />View Details</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => navigate(`/sales/invoices/${invoice.id}`)}><ExternalLink className="mr-2 h-4 w-4" />Open Full Page</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {onPreview && (
                      <DropdownMenuItem onClick={() => onPreview(invoice)}><FileSearch className="mr-2 h-4 w-4" />Preview</DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => onPrint(invoice)}><Printer className="mr-2 h-4 w-4" />Print</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onEmail(invoice)}><Mail className="mr-2 h-4 w-4" />Send via Email</DropdownMenuItem>
                    {invoice.status === "draft" && <DropdownMenuItem onClick={() => onEdit(invoice)}><Edit className="mr-2 h-4 w-4" />Edit Invoice</DropdownMenuItem>}
                    {invoice.status === "draft" && <DropdownMenuItem onClick={() => onStatusChange(invoice, "confirmed")}><CheckCircle2 className="mr-2 h-4 w-4" />Confirm &amp; Release Stock</DropdownMenuItem>}
                    {invoice.status === "draft" && <DropdownMenuItem onClick={() => onStatusChange(invoice, "sent")}><Send className="mr-2 h-4 w-4" />Confirm, Release Stock &amp; Send</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    {isInvoicePayable(invoice) && (
                      <DropdownMenuItem onClick={() => onRecordPayment(invoice)}><CreditCard className="mr-2 h-4 w-4" />Record Payment</DropdownMenuItem>
                    )}
                    {invoice.amount_paid > 0 && <DropdownMenuItem onClick={() => onViewPaymentHistory(invoice)}><History className="mr-2 h-4 w-4" />Payment History</DropdownMenuItem>}
                    {invoice.status === "paid" && <DropdownMenuItem onClick={() => onViewReceipt(invoice)}><Receipt className="mr-2 h-4 w-4" />View Receipt</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    {invoice.status !== "draft" && invoice.status !== "cancelled" && (invoice.status as string) !== "voided" && (
                      <>
                        <DropdownMenuItem onClick={() => onCreateCreditNote(invoice)}><CreditCard className="mr-2 h-4 w-4" />Create Credit Note</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onCreateReturn(invoice)}><RotateCcw className="mr-2 h-4 w-4" />Create Sales Return</DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    {invoice.status !== "draft" && invoice.status !== "cancelled" && (invoice.status as string) !== "voided" && (
                      <DropdownMenuItem onClick={() => onVoid(invoice)} className="text-destructive"><Ban className="mr-2 h-4 w-4" />Void Invoice</DropdownMenuItem>
                    )}
                    {invoice.status === "draft" && <DropdownMenuItem onClick={() => onDelete(invoice)} className="text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

import { useNavigate } from "react-router-dom";
import { Payment } from "@/hooks/usePayments";
import { useCurrency } from "@/hooks/useCurrency";
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
  MoreHorizontal, FileText, Download, Ban, Unlink, ArrowRightLeft, Eye, Mail, Printer, ExternalLink,
} from "lucide-react";
import { format } from "date-fns";

interface PaymentWithStatus extends Payment {
  status?: "applied" | "voided" | "unreconciled";
}

interface PaymentListTableProps {
  payments: PaymentWithStatus[];
  isLoading: boolean;
  bulkSelection: {
    isAllSelected: boolean;
    isPartiallySelected: boolean;
    isSelected: (id: string) => boolean;
    toggleAll: () => void;
    toggleItem: (id: string) => void;
  };
  onViewDetail: (payment: PaymentWithStatus) => void;
  onViewReceipt: (payment: Payment) => void;
  onDownloadReceipt: (payment: Payment) => void;
  onPrintReceipt: (payment: Payment) => void;
  onEmailReceipt: (payment: Payment) => void;
  onVoid: (payment: PaymentWithStatus) => void;
  onUnreconcile: (payment: PaymentWithStatus) => void;
  onReapply: (payment: PaymentWithStatus) => void;
  /** ADR 0012 R3 — apply unapplied (Customer Deposits) cash to an open invoice. */
  onApplyDeposit?: (payment: PaymentWithStatus) => void;
}

export function PaymentListTable({
  payments, isLoading, bulkSelection,
  onViewDetail, onViewReceipt, onDownloadReceipt, onPrintReceipt, onEmailReceipt,
  onVoid, onUnreconcile, onReapply, onApplyDeposit,
}: PaymentListTableProps) {
  const { formatCurrency, baseCurrency } = useCurrency();
  const navigate = useNavigate();

  const getMethodBadge = (method: string) => {
    const styles: Record<string, string> = {
      cash: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      bank_transfer: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      credit_card: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      mpesa: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      mobile_money: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
      cheque: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
      check: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
      other: "bg-muted text-muted-foreground",
    };
    return <Badge className={styles[method] || "bg-muted"}>{method.replace("_", " ")}</Badge>;
  };

  const getStatusBadge = (payment: PaymentWithStatus) => {
    const status = payment.status || "applied";
    if (status === "voided") return <Badge variant="destructive">Voided</Badge>;
    if (status === "unreconciled") return <Badge variant="secondary">Unreconciled</Badge>;
    return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Applied</Badge>;
  };

  return (
    <div className="table-container">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Checkbox
                checked={bulkSelection.isAllSelected}
                onCheckedChange={bulkSelection.toggleAll}
                aria-label="Select all"
                className={bulkSelection.isPartiallySelected ? "data-[state=checked]:bg-primary/50" : ""}
              />
            </TableHead>
            <TableHead>Receipt #</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Invoice</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="w-10"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((payment) => {
            const isVoided = payment.status === "voided";
            const isUnreconciled = payment.status === "unreconciled";
            const contact = payment.contact as { name: string } | null;

            return (
              <TableRow
                key={payment.id}
                data-state={bulkSelection.isSelected(payment.id) ? "selected" : undefined}
                className={`cursor-pointer ${isVoided ? "opacity-50" : ""}`}
                onClick={() => onViewDetail(payment)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={bulkSelection.isSelected(payment.id)}
                    onCheckedChange={() => bulkSelection.toggleItem(payment.id)}
                    aria-label={`Select payment ${payment.receipt_number}`}
                  />
                </TableCell>
                <TableCell className={`font-medium ${isVoided ? "line-through" : ""}`}>
                  {payment.receipt_number || "—"}
                </TableCell>
                <TableCell className="font-medium">{contact?.name || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{format(new Date(payment.payment_date), "MMM d, yyyy")}</TableCell>
                <TableCell>
                  {(() => {
                    const amt = Number(payment.amount) || 0;
                    const outstanding = Number((payment as any).outstanding_amount ?? 0) || 0;
                    const applied = Math.max(amt - outstanding, 0);
                    // ADR 0027 — source the linked invoice from the joined
                    // allocation row, never from any legacy single-FK column.
                    const singleInvoiceId =
                      (payment.invoice as { id?: string } | null)?.id || null;
                    const singleInvoiceNumber = payment.invoice?.invoice_number;

                    if (isUnreconciled) {
                      return <span className="text-muted-foreground italic">Not applied</span>;
                    }
                    // Pure customer deposit — nothing applied.
                    if (applied <= 0.005) {
                      return <span className="text-muted-foreground italic">Customer Deposit</span>;
                    }
                    // Single-invoice path: legacy FK is populated.
                    if (singleInvoiceId && singleInvoiceNumber) {
                      return (
                        <ClickableEntity
                          onClick={() => navigate(`/sales/invoices?id=${singleInvoiceId}`)}
                        >
                          {singleInvoiceNumber}
                        </ClickableEntity>
                      );
                    }
                    // Multi-invoice payment (allocations live in payment_allocations).
                    // Detail dialog renders the full breakdown.
                    return (
                      <span className="text-foreground/80">Multiple invoices</span>
                    );
                  })()}
                </TableCell>
                <TableCell>{getMethodBadge(payment.payment_method)}</TableCell>
                <TableCell>{getStatusBadge(payment)}</TableCell>
                <TableCell className={`text-right font-medium ${isVoided ? "line-through text-muted-foreground" : "text-green-600"}`}>
                  +{formatCurrency(payment.amount, baseCurrency)}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onViewDetail(payment)}>
                        <Eye className="mr-2 h-4 w-4" /> View Details
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => navigate(`/sales/payments/${payment.id}`)}>
                        <ExternalLink className="mr-2 h-4 w-4" /> Open Full Page
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onViewReceipt(payment)}>
                        <FileText className="mr-2 h-4 w-4" /> View Receipt
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onDownloadReceipt(payment)}>
                        <Download className="mr-2 h-4 w-4" /> Download Receipt
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onPrintReceipt(payment)}>
                        <Printer className="mr-2 h-4 w-4" /> Print Receipt
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onEmailReceipt(payment)}>
                        <Mail className="mr-2 h-4 w-4" /> Email Receipt
                      </DropdownMenuItem>
                      {!isVoided && (
                        <>
                          <DropdownMenuSeparator />
                          {!isUnreconciled && (
                            <DropdownMenuItem onClick={() => onUnreconcile(payment)}>
                              <Unlink className="mr-2 h-4 w-4" /> Un-reconcile
                            </DropdownMenuItem>
                          )}
                          {isUnreconciled && (
                            <DropdownMenuItem onClick={() => onReapply(payment)}>
                              <ArrowRightLeft className="mr-2 h-4 w-4" /> Apply to Invoice
                            </DropdownMenuItem>
                          )}
                          {onApplyDeposit && Number((payment as any).outstanding_amount ?? 0) > 0 && (
                            <DropdownMenuItem onClick={() => onApplyDeposit(payment)}>
                              <ArrowRightLeft className="mr-2 h-4 w-4" /> Apply Deposit to Invoice
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => onVoid(payment)} className="text-destructive">
                            <Ban className="mr-2 h-4 w-4" /> Void Payment
                          </DropdownMenuItem>
                        </>
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
  );
}

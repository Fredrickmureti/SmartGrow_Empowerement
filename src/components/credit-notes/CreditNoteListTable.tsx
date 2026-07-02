import { useNavigate } from "react-router-dom";
import { CreditNote } from "@/hooks/useCreditNotes";
import { useCurrency } from "@/hooks/useCurrency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal, Trash2, Send, CreditCard, Download, Mail, Printer, Eye, RotateCcw, Ban, Edit, ExternalLink,
} from "lucide-react";
import { format } from "date-fns";
import { ClickableEntity } from "@/components/common/ClickableEntity";

interface CreditNoteListTableProps {
  creditNotes: CreditNote[];
  isLoading: boolean;
  currencyReady: boolean;
  onViewDetail: (cn: CreditNote) => void;
  onEdit: (cn: CreditNote) => void;
  onIssue: (cn: CreditNote) => void;
  onApply: (cn: CreditNote) => void;
  onRefund: (cn: CreditNote) => void;
  onVoid: (cn: CreditNote) => void;
  onDelete: (id: string) => void;
  onSendEmail: (cn: CreditNote) => void;
  onPrint: (cn: CreditNote) => void;
  onPreviewContact: (contactId: string) => void;
}

export function CreditNoteListTable({
  creditNotes, isLoading, currencyReady,
  onViewDetail, onEdit, onIssue, onApply, onRefund, onVoid, onDelete,
  onSendEmail, onPrint, onPreviewContact,
}: CreditNoteListTableProps) {
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();

  const getStatusBadge = (cn: CreditNote) => {
    const refundAmt = cn.refund_amount || 0;
    const available = cn.total - cn.amount_applied - refundAmt;
    if (cn.status === "draft") return <Badge variant="secondary">Draft</Badge>;
    if (cn.status === "void") return <Badge variant="destructive">Void</Badge>;
    if (cn.status === "applied" || available <= 0.01) return <Badge className="bg-emerald-600 text-white">Fully Resolved</Badge>;
    if (cn.amount_applied > 0 || refundAmt > 0) return <Badge className="bg-amber-500 text-white">Partially Used</Badge>;
    return <Badge variant="default">Open</Badge>;
  };

  return (
    <div className="table-container rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Credit Note #</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Invoice</TableHead>
            <TableHead>Issue Date</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Applied</TableHead>
            <TableHead className="text-right">Refunded</TableHead>
            <TableHead className="text-right">Available</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(isLoading || !currencyReady) ? (
            <TableRow><TableCell colSpan={12} className="text-center py-8">Loading...</TableCell></TableRow>
          ) : creditNotes.length === 0 ? (
            <TableRow><TableCell colSpan={12} className="text-center py-8 text-muted-foreground">No credit notes found</TableCell></TableRow>
          ) : (
            creditNotes.map((cn) => {
              const refundAmt = cn.refund_amount || 0;
              const available = cn.total - cn.amount_applied - refundAmt;
              return (
                <TableRow key={cn.id} className="cursor-pointer" onClick={() => onViewDetail(cn)}>
                  <TableCell className="font-medium font-mono">{cn.credit_note_number}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {cn.contact_id && cn.contact?.name ? (
                      <ClickableEntity onClick={() => onPreviewContact(cn.contact_id)}>
                        {cn.contact.name}
                      </ClickableEntity>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {cn.source_return ? (
                      <ClickableEntity onClick={() => {
                        if (cn.source_return_id) navigate(`/sales/returns?id=${cn.source_return_id}`);
                      }}>
                        <span className="flex items-center gap-1">
                          <RotateCcw className="h-3 w-3 text-muted-foreground" />
                          {cn.source_return.return_number}
                        </span>
                      </ClickableEntity>
                    ) : (
                      <span className="text-muted-foreground">Manual</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs" onClick={(e) => e.stopPropagation()}>
                    {cn.invoice?.invoice_number && cn.invoice_id ? (
                      <ClickableEntity onClick={() => navigate(`/sales/invoices?id=${cn.invoice_id}`)}>
                        {cn.invoice.invoice_number}
                      </ClickableEntity>
                    ) : "—"}
                  </TableCell>
                  <TableCell>{format(new Date(cn.issue_date), "MMM d, yyyy")}</TableCell>
                  <TableCell className="max-w-[150px] truncate">{cn.reason}</TableCell>
                  <TableCell>{getStatusBadge(cn)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(cn.total, cn.currency)}</TableCell>
                  <TableCell className="text-right text-sm text-emerald-600">{cn.amount_applied > 0 ? formatCurrency(cn.amount_applied, cn.currency) : "—"}</TableCell>
                  <TableCell className="text-right text-sm text-orange-600">{refundAmt > 0 ? formatCurrency(refundAmt, cn.currency) : "—"}</TableCell>
                  <TableCell className="text-right font-medium">{available > 0.01 ? formatCurrency(available, cn.currency) : <span className="text-muted-foreground text-xs">—</span>}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onViewDetail(cn)}>
                          <Eye className="mr-2 h-4 w-4" /> View Details
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate(`/sales/credit-notes/${cn.id}`)}>
                          <ExternalLink className="mr-2 h-4 w-4" /> Open Full Page
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onPrint(cn)}>
                          <Printer className="mr-2 h-4 w-4" /> Print Credit Note
                        </DropdownMenuItem>
                        {cn.status === "draft" && (
                          <DropdownMenuItem onClick={() => onEdit(cn)}>
                            <Edit className="mr-2 h-4 w-4" /> Edit
                          </DropdownMenuItem>
                        )}
                        {cn.status === "draft" && (
                          <DropdownMenuItem onClick={() => onIssue(cn)}>
                            <Send className="mr-2 h-4 w-4" /> Issue Credit Note
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => onSendEmail(cn)}>
                          <Mail className="mr-2 h-4 w-4" /> Send via Email
                        </DropdownMenuItem>
                        {cn.status === "issued" && cn.total > cn.amount_applied && (
                          <>
                            <DropdownMenuItem onClick={() => onApply(cn)}>
                              <CreditCard className="mr-2 h-4 w-4" /> Apply to Invoice
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onRefund(cn)}>
                              <Download className="mr-2 h-4 w-4" /> Process Refund
                            </DropdownMenuItem>
                          </>
                        )}
                        <DropdownMenuSeparator />
                        {cn.status === "issued" && cn.amount_applied === 0 && (cn.refund_amount || 0) === 0 && (
                          <DropdownMenuItem onClick={() => onVoid(cn)} className="text-destructive">
                            <Ban className="mr-2 h-4 w-4" /> Void Credit Note
                          </DropdownMenuItem>
                        )}
                        {cn.status === "draft" && (
                          <DropdownMenuItem onClick={() => onDelete(cn.id)} className="text-destructive">
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

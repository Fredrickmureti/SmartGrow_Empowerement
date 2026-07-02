import { Estimate } from "@/hooks/useEstimates";
import { useCurrency } from "@/hooks/useCurrency";
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
  MoreHorizontal, FileText, Trash2, Edit, Send, ArrowRightLeft, X, Printer, Mail, ShoppingCart, ExternalLink,
} from "lucide-react";
import { format } from "date-fns";
import { useNavigate } from "react-router-dom";

interface EstimateListTableProps {
  estimates: Estimate[];
  isLoading: boolean;
  currencyReady: boolean;
  isAdmin: boolean;
  canManageSales: boolean;
  isSelected: (id: string) => boolean;
  isAllSelected: boolean;
  isPartiallySelected: boolean;
  toggleItem: (id: string) => void;
  toggleAll: () => void;
  onViewDetail: (estimate: Estimate) => void;
  onEdit: (estimate: Estimate) => void;
  onStatusChange: (id: string, status: string) => void;
  onConvertToInvoice: (id: string) => void;
  onConvertToSalesOrder: (id: string) => void;
  onDelete: (id: string) => void;
  onPrint: (estimate: Estimate) => void;
  onSendEmail: (estimate: Estimate) => void;
}

export function EstimateListTable({
  estimates, isLoading, currencyReady, isAdmin, canManageSales,
  isSelected, isAllSelected, isPartiallySelected, toggleItem, toggleAll,
  onViewDetail, onEdit, onStatusChange, onConvertToInvoice, onConvertToSalesOrder,
  onDelete, onPrint, onSendEmail,
}: EstimateListTableProps) {
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      draft: "secondary", sent: "default", viewed: "default", accepted: "default",
      rejected: "destructive", expired: "destructive", converted: "outline",
    };
    return <Badge variant={variants[status] || "secondary"}>{status}</Badge>;
  };

  return (
    <div className="table-container rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[50px]">
              <Checkbox
                checked={isAllSelected}
                ref={(el) => { if (el) (el as any).indeterminate = isPartiallySelected; }}
                onCheckedChange={toggleAll}
                aria-label="Select all estimates"
              />
            </TableHead>
            <TableHead>Estimate #</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Issue Date</TableHead>
            <TableHead>Expiry Date</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(isLoading || !currencyReady) ? (
            <TableRow><TableCell colSpan={8} className="text-center py-8">Loading...</TableCell></TableRow>
          ) : estimates.length === 0 ? (
            <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No estimates found</TableCell></TableRow>
          ) : (
            estimates.map((estimate) => (
              <TableRow
                key={estimate.id}
                className={`cursor-pointer ${isSelected(estimate.id) ? "bg-muted/50" : ""}`}
                onClick={() => onViewDetail(estimate)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected(estimate.id)}
                    onCheckedChange={() => toggleItem(estimate.id)}
                    aria-label={`Select ${estimate.estimate_number}`}
                  />
                </TableCell>
                <TableCell className="font-medium">{estimate.estimate_number}</TableCell>
                <TableCell>{estimate.contact?.name || "—"}</TableCell>
                <TableCell>{format(new Date(estimate.issue_date), "MMM d, yyyy")}</TableCell>
                <TableCell>{format(new Date(estimate.expiry_date), "MMM d, yyyy")}</TableCell>
                <TableCell>{getStatusBadge(estimate.status)}</TableCell>
                <TableCell className="text-right font-medium">{formatCurrency(estimate.total, estimate.currency)}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => navigate(`/sales/estimates/${estimate.id}`)}>
                        <ExternalLink className="mr-2 h-4 w-4" /> Open Full Page
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onPrint(estimate)}>
                        <Printer className="mr-2 h-4 w-4" /> Print / Download
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onSendEmail(estimate)}>
                        <Mail className="mr-2 h-4 w-4" /> Send via Email
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {estimate.status === "draft" && (
                        <>
                          <DropdownMenuItem onClick={() => onEdit(estimate)}>
                            <Edit className="mr-2 h-4 w-4" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onStatusChange(estimate.id, "sent")}>
                            <Send className="mr-2 h-4 w-4" /> Mark as Sent
                          </DropdownMenuItem>
                        </>
                      )}
                      {["sent", "viewed"].includes(estimate.status) && (
                        <>
                          <DropdownMenuItem onClick={() => onStatusChange(estimate.id, "accepted")}>
                            <FileText className="mr-2 h-4 w-4" /> Mark Accepted
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onStatusChange(estimate.id, "rejected")}>
                            <X className="mr-2 h-4 w-4" /> Mark Rejected
                          </DropdownMenuItem>
                        </>
                      )}
                      {estimate.status === "accepted" && !estimate.converted_invoice_id && (
                        <>
                          <DropdownMenuItem onClick={() => onConvertToSalesOrder(estimate.id)}>
                            <ShoppingCart className="mr-2 h-4 w-4" /> Convert to Sales Order
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onConvertToInvoice(estimate.id)}>
                            <ArrowRightLeft className="mr-2 h-4 w-4" /> Convert to Invoice
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      {(isAdmin || estimate.status === "draft") && (
                        <DropdownMenuItem onClick={() => onDelete(estimate.id)} className="text-destructive">
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

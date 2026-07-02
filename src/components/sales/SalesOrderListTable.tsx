import { useCurrency } from "@/hooks/useCurrency";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, FileText, Truck, Eye, CheckCircle, Ban, ArrowRight, Printer, Mail } from "lucide-react";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { format } from "date-fns";

interface SalesOrder {
  id: string;
  so_number: string;
  contact_id: string;
  contact?: { name: string; email?: string } | null;
  order_date: string;
  status: string;
  total: number;
  currency?: string;
  converted_invoice_id?: string | null;
}

interface LinkedDocs {
  invoiceNumber?: string;
  deliveryCount?: number;
  fulfillmentPercent?: number;
}

interface SalesOrderListTableProps {
  orders: SalesOrder[];
  isLoading: boolean;
  linkedDocs: Record<string, LinkedDocs>;
  bulkSelection: {
    isAllSelected: boolean;
    isPartiallySelected: boolean;
    isSelected: (id: string) => boolean;
    toggleAll: () => void;
    toggleItem: (id: string) => void;
  };
  isReadOnly: boolean;
  onViewDetail: (id: string) => void;
  onEdit: (order: SalesOrder) => void;
  onConfirm: (order: SalesOrder) => void;
  onCreateDeliveryNote: (order: SalesOrder) => void;
  onConvertToInvoice: (order: SalesOrder) => void;
  onCancel: (order: SalesOrder) => void;
  onDelete: (order: SalesOrder) => void;
  onPrint: (order: SalesOrder) => void;
  onSendEmail: (order: SalesOrder) => void;
  onPreviewContact: (contactId: string) => void;
}

export function SalesOrderListTable({
  orders, isLoading, linkedDocs, bulkSelection, isReadOnly,
  onViewDetail, onEdit, onConfirm, onCreateDeliveryNote, onConvertToInvoice,
  onCancel, onDelete, onPrint, onSendEmail, onPreviewContact,
}: SalesOrderListTableProps) {
  const { formatCurrency } = useCurrency();

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      draft: "bg-muted text-muted-foreground",
      confirmed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      processing: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      partial: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
      fulfilled: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      invoiced: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    };
    return <Badge className={styles[status] || "bg-muted"}>{status}</Badge>;
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
            <TableHead>Order #</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Fulfillment</TableHead>
            <TableHead>Documents</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="w-10"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => {
            const docs = linkedDocs[order.id];
            const fulfillment = docs?.fulfillmentPercent ?? 0;
            return (
              <TableRow
                key={order.id}
                data-state={bulkSelection.isSelected(order.id) ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => onViewDetail(order.id)}
              >
                <TableCell onClick={e => e.stopPropagation()}>
                  <Checkbox
                    checked={bulkSelection.isSelected(order.id)}
                    onCheckedChange={() => bulkSelection.toggleItem(order.id)}
                    aria-label={`Select order ${order.so_number}`}
                  />
                </TableCell>
                <TableCell className="font-medium text-primary">{order.so_number}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {order.contact_id && order.contact?.name ? (
                    <ClickableEntity onClick={() => onPreviewContact(order.contact_id)}>
                      {order.contact.name}
                    </ClickableEntity>
                  ) : <span>—</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{format(new Date(order.order_date), "MMM d, yyyy")}</TableCell>
                <TableCell>{getStatusBadge(order.status)}</TableCell>
                <TableCell>
                  {["confirmed", "processing", "partial", "fulfilled", "invoiced"].includes(order.status) ? (
                    <div className="flex items-center gap-2 min-w-[100px]">
                      <Progress value={fulfillment} className="h-2 flex-1" />
                      <span className="text-xs text-muted-foreground w-8 text-right">{fulfillment}%</span>
                    </div>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {docs?.invoiceNumber && (
                      <Badge variant="outline" className="text-xs font-normal gap-1">
                        <FileText className="h-3 w-3" />{docs.invoiceNumber}
                      </Badge>
                    )}
                    {(docs?.deliveryCount || 0) > 0 && (
                      <Badge variant="outline" className="text-xs font-normal gap-1">
                        <Truck className="h-3 w-3" />{docs.deliveryCount} DN
                      </Badge>
                    )}
                    {!docs?.invoiceNumber && !(docs?.deliveryCount) && (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right font-semibold">{formatCurrency(order.total, order.currency)}</TableCell>
                <TableCell onClick={e => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onViewDetail(order.id)}>
                        <Eye className="mr-2 h-4 w-4" /> View Details
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onPrint(order)}>
                        <Printer className="mr-2 h-4 w-4" /> Print
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onSendEmail(order)}>
                        <Mail className="mr-2 h-4 w-4" /> Send via Email
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {order.status === "draft" && (
                        <DropdownMenuItem onClick={() => onEdit(order)}>
                          <FileText className="mr-2 h-4 w-4" /> Edit Order
                        </DropdownMenuItem>
                      )}
                      {order.status === "draft" && (
                        <DropdownMenuItem onClick={() => onConfirm(order)}>
                          <CheckCircle className="mr-2 h-4 w-4" /> Confirm Order
                        </DropdownMenuItem>
                      )}
                      {["confirmed", "processing", "partial"].includes(order.status) && (
                        <DropdownMenuItem onClick={() => onCreateDeliveryNote(order)}>
                          <Truck className="mr-2 h-4 w-4" /> Create Delivery Note
                        </DropdownMenuItem>
                      )}
                      {!order.converted_invoice_id && ["confirmed", "processing", "partial", "fulfilled"].includes(order.status) && (
                        <DropdownMenuItem onClick={() => onConvertToInvoice(order)}>
                          <ArrowRight className="mr-2 h-4 w-4" /> Convert to Invoice
                        </DropdownMenuItem>
                      )}
                      {["draft", "confirmed"].includes(order.status) && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => onCancel(order)}>
                            <Ban className="mr-2 h-4 w-4" /> Cancel
                          </DropdownMenuItem>
                        </>
                      )}
                      {order.status === "draft" && (
                        <DropdownMenuItem className="text-destructive" onClick={() => onDelete(order)}>
                          Delete
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
  );
}

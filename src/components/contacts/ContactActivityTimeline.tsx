/**
 * Phase 3d: Activity Timeline
 * Shows a chronological timeline of all transactions for a contact.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { useCurrency } from "@/hooks/useCurrency";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Receipt, CreditCard, Wallet, ShoppingCart, ClipboardList } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  invoices: any[];
  bills: any[];
  payments: any[];
  billPayments: any[];
  creditNotes: any[];
  salesOrders: any[];
  purchaseOrders: any[];
}

interface TimelineItem {
  id: string;
  type: string;
  icon: React.ReactNode;
  reference: string;
  date: string;
  amount: number;
  status: string;
}

export function ContactActivityTimeline({
  invoices, bills, payments, billPayments, creditNotes, salesOrders, purchaseOrders,
}: Props) {
  const { formatCurrency } = useCurrency();

  const items = useMemo<TimelineItem[]>(() => {
    const all: TimelineItem[] = [];

    invoices.forEach(inv => all.push({
      id: inv.id, type: "Invoice", icon: <FileText className="h-3.5 w-3.5" />,
      reference: inv.invoice_number, date: inv.issue_date,
      amount: inv.total || 0, status: inv.status,
    }));

    bills.forEach(b => all.push({
      id: b.id, type: "Bill", icon: <Receipt className="h-3.5 w-3.5" />,
      reference: b.bill_number, date: b.bill_date,
      amount: b.total || 0, status: b.status,
    }));

    payments.forEach(p => all.push({
      id: p.id, type: "Payment", icon: <CreditCard className="h-3.5 w-3.5" />,
      reference: p.reference || p.id.slice(0, 8), date: p.payment_date,
      amount: p.amount || 0, status: "completed",
    }));

    billPayments.forEach(bp => all.push({
      id: bp.id, type: "Bill Payment", icon: <Wallet className="h-3.5 w-3.5" />,
      reference: bp.reference || bp.id.slice(0, 8), date: bp.payment_date,
      amount: bp.amount || 0, status: "completed",
    }));

    creditNotes.forEach(cn => all.push({
      id: cn.id, type: "Credit Note", icon: <Receipt className="h-3.5 w-3.5" />,
      reference: cn.credit_note_number, date: cn.issue_date,
      amount: cn.total || 0, status: cn.status,
    }));

    salesOrders.forEach(so => all.push({
      id: so.id, type: "Sales Order", icon: <ShoppingCart className="h-3.5 w-3.5" />,
      reference: so.so_number, date: so.order_date,
      amount: so.total || 0, status: so.status,
    }));

    purchaseOrders.forEach(po => all.push({
      id: po.id, type: "Purchase Order", icon: <ClipboardList className="h-3.5 w-3.5" />,
      reference: po.po_number, date: po.order_date,
      amount: po.total || 0, status: po.status,
    }));

    return all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [invoices, bills, payments, billPayments, creditNotes, salesOrders, purchaseOrders]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "paid": case "completed": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200";
      case "sent": case "approved": case "confirmed": return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
      case "overdue": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      case "draft": return "bg-muted text-muted-foreground";
      default: return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
    }
  };

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground text-sm">
          No activity recorded
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Activity Timeline ({items.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative space-y-0">
          {/* Timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />
          
          {items.slice(0, 50).map((item, idx) => (
            <div key={item.id} className="relative flex items-start gap-3 py-2 pl-8">
              {/* Dot */}
              <div className="absolute left-[11px] top-3 h-2.5 w-2.5 rounded-full border-2 border-background bg-muted-foreground" />
              
              <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-muted-foreground shrink-0">{item.icon}</span>
                  <span className="text-xs font-medium shrink-0">{item.type}</span>
                  <span className="text-xs font-mono text-muted-foreground truncate">{item.reference}</span>
                  <Badge className={cn("text-[10px] shrink-0", getStatusColor(item.status))}>{item.status}</Badge>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-medium">{formatCurrency(item.amount)}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.date ? format(new Date(item.date), "MMM d, yy") : "—"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

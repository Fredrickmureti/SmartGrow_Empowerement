import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useSmsLog } from "@/hooks/useSmsLog";
import { Loader2, MessageSquare, ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import type { Database } from "@/integrations/supabase/types";

type SmsStatus = Database["public"]["Enums"]["sms_status"];
type SmsEventType = Database["public"]["Enums"]["sms_event_type"];

const STATUS_COLORS: Record<string, string> = {
  queued: "bg-muted text-muted-foreground",
  sent: "bg-primary/10 text-primary",
  delivered: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  failed: "bg-destructive/10 text-destructive",
  undelivered: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
};

function maskPhone(phone: string): string {
  if (phone.length <= 6) return "****" + phone.slice(-2);
  return phone.slice(0, 4) + "****" + phone.slice(-2);
}

export default function SmsLogPage() {
  const [statusFilter, setStatusFilter] = useState<SmsStatus | "all">("all");
  const [eventFilter, setEventFilter] = useState<SmsEventType | "all">("all");
  const [page, setPage] = useState(0);

  const { data, isLoading } = useSmsLog({
    status: statusFilter === "all" ? undefined : statusFilter,
    eventType: eventFilter === "all" ? undefined : eventFilter,
    page,
  });

  const logs = data?.data || [];
  const totalCount = data?.count || 0;
  const totalPages = Math.ceil(totalCount / 25);

  return (
    <div className="space-y-6 px-4 sm:px-0">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight">SMS Log</h2>
        <p className="text-sm text-muted-foreground">View all sent SMS messages and their delivery status.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as SmsStatus | "all"); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="undelivered">Undelivered</SelectItem>
          </SelectContent>
        </Select>

        <Select value={eventFilter} onValueChange={(v) => { setEventFilter(v as SmsEventType | "all"); setPage(0); }}>
          <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="Event" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Events</SelectItem>
            <SelectItem value="invoice_posted">Invoice Posted</SelectItem>
            <SelectItem value="payment_received">Payment Received</SelectItem>
            <SelectItem value="invoice_overdue">Invoice Overdue</SelectItem>
            <SelectItem value="po_sent">PO Sent</SelectItem>
            <SelectItem value="estimate_sent">Estimate Sent</SelectItem>
            <SelectItem value="sales_order_confirmed">Sales Order Confirmed</SelectItem>
            <SelectItem value="delivery_shipped">Delivery Shipped</SelectItem>
            <SelectItem value="payment_reminder">Payment Reminder</SelectItem>
            <SelectItem value="credit_note_issued">Credit Note Issued</SelectItem>
            <SelectItem value="recurring_invoice_generated">Recurring Invoice</SelectItem>
            <SelectItem value="customer_statement_sent">Statement Sent</SelectItem>
            <SelectItem value="expense_approved">Expense Approved</SelectItem>
            <SelectItem value="expense_rejected">Expense Rejected</SelectItem>
            <SelectItem value="payroll_processed">Payroll Processed</SelectItem>
            <SelectItem value="low_stock_alert">Low Stock Alert</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <MessageSquare className="mx-auto h-12 w-12 mb-4 opacity-50" />
            <p>No SMS messages found.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="p-3 text-left font-medium whitespace-nowrap">Date</th>
                  <th className="p-3 text-left font-medium whitespace-nowrap">Recipient</th>
                  <th className="p-3 text-left font-medium whitespace-nowrap hidden sm:table-cell">Event</th>
                  <th className="p-3 text-left font-medium whitespace-nowrap">Mode</th>
                  <th className="p-3 text-left font-medium whitespace-nowrap">Status</th>
                  <th className="p-3 text-left font-medium whitespace-nowrap hidden md:table-cell">Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const mode = (log as { provider_mode?: string }).provider_mode || "live";
                  return (
                    <tr key={log.id} className="border-b">
                      <td className="p-3 whitespace-nowrap text-xs sm:text-sm">
                        {format(new Date(log.created_at), "MMM d, HH:mm")}
                      </td>
                      <td className="p-3 font-mono text-xs">{maskPhone(log.recipient_phone)}</td>
                      <td className="p-3 hidden sm:table-cell">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted">
                          {log.event_type?.replace(/_/g, " ") || "Manual"}
                        </span>
                      </td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${mode === "live" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                          {mode}
                        </span>
                      </td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[log.status] || ""}`}>
                          {log.status}
                        </span>
                      </td>
                      <td className="p-3 max-w-xs truncate text-muted-foreground hidden md:table-cell">{log.message_body}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{totalCount} messages total</p>
              <div className="flex gap-2 items-center">
                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm py-1 px-2 whitespace-nowrap">Page {page + 1} of {totalPages}</span>
                <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

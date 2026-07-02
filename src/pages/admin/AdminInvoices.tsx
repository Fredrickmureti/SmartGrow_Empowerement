import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  Search,
  Loader2,
  RefreshCw,
  DollarSign,
  Clock,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { format } from "date-fns";

interface InvoiceWithOrg {
  id: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string;
  total: number;
  amount_paid: number;
  currency: string | null;
  contact: { name: string } | null;
  organization: { name: string } | null;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }> = {
  draft: { label: "Draft", variant: "outline", icon: FileText },
  sent: { label: "Sent", variant: "secondary", icon: Clock },
  viewed: { label: "Viewed", variant: "secondary", icon: Clock },
  partial: { label: "Partial", variant: "default", icon: Clock },
  paid: { label: "Paid", variant: "default", icon: CheckCircle },
  overdue: { label: "Overdue", variant: "destructive", icon: AlertCircle },
  cancelled: { label: "Cancelled", variant: "outline", icon: FileText },
};

import { useAdminCurrency } from "@/hooks/useAdminCurrency";

export default function AdminInvoices() {
  const [invoices, setInvoices] = useState<InvoiceWithOrg[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { formatCurrency } = useAdminCurrency();

  const fetchInvoices = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          *,
          contact:contacts(name),
          organization:organizations(name)
        `)
        .order("created_at", { ascending: false })
        .limit(500);

      if (error) throw error;
      setInvoices(data || []);
    } catch (error) {
      console.error("Error fetching invoices:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchInvoices();
  }, []);

  const filteredInvoices = invoices.filter((inv) => {
    const matchesSearch =
      inv.invoice_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inv.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inv.organization?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || inv.status === statusFilter;
    return matchesSearch && matchesStatus;
  });


  // Calculate stats
  const totalValue = invoices.reduce((sum, inv) => sum + Number(inv.total), 0);
  const paidValue = invoices.filter((inv) => inv.status === "paid").reduce((sum, inv) => sum + Number(inv.total), 0);
  const overdueValue = invoices.filter((inv) => inv.status === "overdue").reduce((sum, inv) => sum + Number(inv.total), 0);

  return (
    <>
      <div className="p-4 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="page-header">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Invoices</h1>
            <p className="text-sm text-muted-foreground">
              View all invoices across the platform
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchInvoices} disabled={isLoading} className="touch-target self-start sm:self-auto">
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="stats-grid">
          <Card>
            <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
              <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                Total Invoices
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="stat-value">{invoices.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
              <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                <DollarSign className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                Total Value
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="stat-value">{formatCurrency(totalValue)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
              <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                <CheckCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-success" />
                Paid
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="stat-value text-success">
                {formatCurrency(paidValue)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
              <CardDescription className="flex items-center gap-2 text-xs sm:text-sm">
                <AlertCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 text-destructive" />
                Overdue
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="stat-value text-destructive">
                {formatCurrency(overdueValue)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search & Table */}
        <Card>
          <CardHeader className="p-4 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <CardTitle className="text-sm sm:text-base">All Invoices</CardTitle>
              <div className="flex flex-col xs:flex-row gap-2 w-full sm:w-auto">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full xs:w-36 touch-target text-sm">
                    <SelectValue placeholder="Filter status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="sent">Sent</SelectItem>
                    <SelectItem value="viewed">Viewed</SelectItem>
                    <SelectItem value="partial">Partial</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="overdue">Overdue</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative w-full xs:w-56 sm:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search invoices..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 touch-target text-sm"
                  />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Desktop table */}
                <div className="hidden md:block rounded-lg border overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="text-xs">Invoice</TableHead>
                        <TableHead className="text-xs">Organization</TableHead>
                        <TableHead className="text-xs">Customer</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs text-right">Amount</TableHead>
                        <TableHead className="text-xs">Due Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredInvoices.length > 0 ? (
                        filteredInvoices.map((invoice) => {
                          const config = statusConfig[invoice.status] || statusConfig.draft;
                          const StatusIcon = config.icon;
                          return (
                            <TableRow key={invoice.id}>
                              <TableCell className="text-sm">
                                <span className="font-mono font-medium">
                                  {invoice.invoice_number}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {invoice.organization?.name || "—"}
                              </TableCell>
                              <TableCell className="text-sm">{invoice.contact?.name || "—"}</TableCell>
                              <TableCell>
                                <Badge variant={config.variant} className="gap-1 text-xs">
                                  <StatusIcon className="h-3 w-3" />
                                  {config.label}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right text-sm font-medium">
                                {formatCurrency(Number(invoice.total))}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {format(new Date(invoice.due_date), "MMM d, yyyy")}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      ) : (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-12">
                            <FileText className="h-12 w-12 mx-auto mb-3 opacity-20" />
                            <p className="text-sm">No invoices found</p>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile card list */}
                <div className="md:hidden mobile-card-list">
                  {filteredInvoices.length > 0 ? (
                    filteredInvoices.map((invoice) => {
                      const config = statusConfig[invoice.status] || statusConfig.draft;
                      const StatusIcon = config.icon;
                      return (
                        <div key={invoice.id} className="mobile-card space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-sm font-medium">{invoice.invoice_number}</span>
                            <Badge variant={config.variant} className="gap-1 text-xs">
                              <StatusIcon className="h-3 w-3" />
                              {config.label}
                            </Badge>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground truncate mr-2">
                              {invoice.organization?.name || "—"}
                            </span>
                            <span className="font-medium whitespace-nowrap">
                              {formatCurrency(Number(invoice.total))}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>{invoice.contact?.name || "—"}</span>
                            <span>Due {format(new Date(invoice.due_date), "MMM d, yyyy")}</span>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center text-muted-foreground py-12">
                      <FileText className="h-12 w-12 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">No invoices found</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

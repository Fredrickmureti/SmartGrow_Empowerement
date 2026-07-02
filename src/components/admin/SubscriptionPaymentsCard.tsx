// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
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
import { supabase } from "@/integrations/supabase/client";
import { 
  DollarSign, 
  Search, 
  Loader2,
  RefreshCw,
  Building2,
  Receipt
} from "lucide-react";
import { format } from "date-fns";

interface SubscriptionPayment {
  id: string;
  organization_id: string;
  organization_name?: string;
  plan_name?: string;
  amount: number;
  currency: string;
  payment_method: string;
  period_start: string;
  period_end: string;
  status: string;
  notes: string | null;
  created_at: string;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  mpesa: "M-Pesa",
  bank_transfer: "Bank Transfer",
  stripe: "Stripe",
  other: "Other",
};

export function SubscriptionPaymentsCard() {
  const [payments, setPayments] = useState<SubscriptionPayment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchPayments = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("subscription_payments")
        .select(`
          *,
          organizations:organization_id (name),
          platform_subscription_plans:plan_id (name)
        `)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      const formattedPayments = data?.map(p => ({
        ...p,
        organization_name: (p.organizations as any)?.name || "Unknown",
        plan_name: (p.platform_subscription_plans as any)?.name || "—",
      })) || [];

      setPayments(formattedPayments);
    } catch (error) {
      console.error("Error fetching payments:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPayments();
  }, []);

  const filteredPayments = payments.filter(p =>
    p.organization_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.payment_method?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalAmount = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-5 w-5" />
              Recent Subscription Payments
            </CardTitle>
            <CardDescription>
              Manually recorded payments for subscriptions
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchPayments} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="p-3 rounded-lg bg-muted/50 border">
            <p className="text-sm text-muted-foreground">Total Payments</p>
            <p className="text-2xl font-bold">{payments.length}</p>
          </div>
          <div className="p-3 rounded-lg bg-green-500/10 border border-green-200">
            <p className="text-sm text-muted-foreground">Total Amount</p>
            <p className="text-2xl font-bold text-green-600">
              ${totalAmount.toLocaleString()}
            </p>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search payments..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredPayments.length > 0 ? (
          <div className="rounded-lg border max-h-96 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPayments.map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{payment.organization_name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{payment.plan_name}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium text-green-600">
                        ${Number(payment.amount).toLocaleString()}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {PAYMENT_METHOD_LABELS[payment.payment_method] || payment.payment_method}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(payment.period_start), "MMM d")} -{" "}
                      {format(new Date(payment.period_end), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(payment.created_at), "MMM d, yyyy")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <DollarSign className="h-12 w-12 mx-auto mb-2 opacity-20" />
            <p>No payments recorded yet</p>
            <p className="text-sm mt-1">
              Payments are recorded when managing subscriptions in the Organizations page
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

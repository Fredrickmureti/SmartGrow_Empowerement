import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { PlatformAppLayout } from "@/apps/platform";
import { useOrganization } from "@/hooks/useOrganization";
import { useSubscription } from "@/hooks/useSubscription";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  CreditCard,
  Calendar,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Receipt,
  AlertTriangle,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

interface PaymentRecord {
  id: string;
  amount: number;
  currency: string;
  payment_method: string;
  period_start: string;
  period_end: string;
  status: string;
  notes: string | null;
  created_at: string;
  plan: { name: string } | null;
}

export default function BillingHistory() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { plan: currentPlan, subscriptionStatus } = useSubscription();
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) return;
    
    const fetchPayments = async () => {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("subscription_payments")
        .select(`
          *,
          plan:platform_subscription_plans(name)
        `)
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (!error && data) {
        setPayments(data as unknown as PaymentRecord[]);
      }
      setIsLoading(false);
    };

    fetchPayments();
  }, [currentOrg]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20"><CheckCircle2 className="h-3 w-3 mr-1" />Completed</Badge>;
      case "failed":
        return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
      case "pending":
        return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getMethodLabel = (method: string) => {
    const labels: Record<string, string> = {
      stripe: "Stripe",
      mpesa: "M-Pesa",
      paypal: "PayPal",
      pesapal: "PesaPal",
      manual: "Manual",
    };
    return labels[method] || method;
  };

  const formatAmount = (amount: number, currency: string) => {
    if (currency === "KES") return `KSh ${amount.toLocaleString()}`;
    return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  };

  return (
    <PlatformAppLayout>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Billing & Subscription</h1>
            <p className="text-muted-foreground text-sm">
              Manage your subscription and view payment history
            </p>
          </div>
        </div>

        {/* Current Subscription Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Current Subscription
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-sm text-muted-foreground">Plan</p>
                <p className="font-semibold text-lg">{currentPlan?.name || "No Plan"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <div className="mt-1">
                  {subscriptionStatus.isActive && (
                    <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Active</Badge>
                  )}
                  {subscriptionStatus.isTrialing && (
                    <Badge variant="secondary">Trial</Badge>
                  )}
                  {subscriptionStatus.isExpired && (
                    <Badge variant="destructive">Expired</Badge>
                  )}
                  {subscriptionStatus.isSuspended && (
                    <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">Suspended</Badge>
                  )}
                  {!subscriptionStatus.isActive && !subscriptionStatus.isTrialing && !subscriptionStatus.isExpired && !subscriptionStatus.isSuspended && (
                    <Badge variant="outline">None</Badge>
                  )}
                </div>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {subscriptionStatus.isTrialing ? "Trial Ends" : "Renews / Expires"}
                </p>
                <p className="font-medium">
                  {subscriptionStatus.isTrialing && subscriptionStatus.trialEndsAt
                    ? format(new Date(subscriptionStatus.trialEndsAt), "MMM d, yyyy")
                    : subscriptionStatus.subscriptionEndsAt
                    ? format(new Date(subscriptionStatus.subscriptionEndsAt), "MMM d, yyyy")
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Time Remaining</p>
                <p className="font-medium">
                  {subscriptionStatus.daysRemaining !== null
                    ? `${subscriptionStatus.daysRemaining} days`
                    : "—"}
                </p>
              </div>
            </div>

            <Separator className="my-4" />

            <div className="flex gap-3">
              <Button onClick={() => navigate("/upgrade")}>
                {subscriptionStatus.isActive ? "Change Plan" : "Upgrade"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Payment History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5" />
              Payment History
            </CardTitle>
            <CardDescription>
              All subscription payments for your organization
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : payments.length === 0 ? (
              <div className="text-center py-12">
                <AlertTriangle className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">No payment records found</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Payments will appear here after your first subscription purchase
                </p>
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((payment) => (
                      <TableRow key={payment.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm">
                              {format(new Date(payment.created_at), "MMM d, yyyy")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDistanceToNow(new Date(payment.created_at), { addSuffix: true })}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>{payment.plan?.name || "—"}</TableCell>
                        <TableCell>{getMethodLabel(payment.payment_method)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1 text-sm">
                            <Calendar className="h-3 w-3 text-muted-foreground" />
                            {format(new Date(payment.period_start), "MMM d")} – {format(new Date(payment.period_end), "MMM d, yyyy")}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">
                          {formatAmount(payment.amount, payment.currency)}
                        </TableCell>
                        <TableCell>{getStatusBadge(payment.status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PlatformAppLayout>
  );
}

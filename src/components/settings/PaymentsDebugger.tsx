// @ts-nocheck
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Bug,
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  Play,
  ChevronRight,
  Eye,
  Smartphone,
  FlaskConical,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useCurrency } from "@/hooks/useCurrency";
import { useMpesaSimulation, SimulationScenario } from "@/hooks/useMpesaSimulation";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import { formatDistanceToNow, format } from "date-fns";

interface PaymentRequest {
  id: string;
  provider: string;
  provider_reference: string | null;
  merchant_request_id: string | null;
  amount: number;
  currency: string;
  phone_number: string | null;
  status: string;
  result_code: string | null;
  result_description: string | null;
  receipt_number: string | null;
  initiated_at: string;
  completed_at: string | null;
  callback_payload: any;
  created_at: string;
}

export function PaymentsDebugger() {
  const { currentOrg } = useOrganization();
  const { formatCurrency } = useCurrency();
  const { simulateCallback, isSimulating } = useMpesaSimulation();
  const { settings: platformSettings, getSetting } = usePlatformSettings();

  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedPayment, setSelectedPayment] = useState<PaymentRequest | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const isSandbox = getSetting("mpesa_environment") !== "production";

  const fetchPaymentRequests = async () => {
    if (!currentOrg) return;

    setIsLoading(true);
    try {
      let query = supabase
        // SCOPE-EXEMPT: admin debugger surfaces all payment requests across the workspace
        .from("payment_requests")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }

      const { data, error } = await query;

      if (error) throw error;
      setPaymentRequests(data || []);
    } catch (error) {
      console.error("Error fetching payment requests:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPaymentRequests();
  }, [currentOrg, statusFilter]);

  const handleSimulate = async (paymentId: string, scenario: SimulationScenario) => {
    const result = await simulateCallback(paymentId, scenario);
    if (result?.success) {
      fetchPaymentRequests();
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-600" />;
      case "failed":
        return <XCircle className="h-4 w-4 text-destructive" />;
      case "cancelled":
        return <XCircle className="h-4 w-4 text-amber-600" />;
      case "expired":
        return <AlertTriangle className="h-4 w-4 text-amber-600" />;
      case "processing":
      case "pending":
        return <Clock className="h-4 w-4 text-blue-600 animate-pulse" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadgeVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    switch (status) {
      case "completed":
        return "default";
      case "failed":
        return "destructive";
      case "cancelled":
      case "expired":
        return "secondary";
      default:
        return "outline";
    }
  };

  const filteredPayments = paymentRequests.filter((p) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      p.phone_number?.toLowerCase().includes(query) ||
      p.receipt_number?.toLowerCase().includes(query) ||
      p.provider_reference?.toLowerCase().includes(query) ||
      p.id.toLowerCase().includes(query)
    );
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bug className="h-5 w-5 text-primary flex-shrink-0" />
            <div>
              <CardTitle className="text-base sm:text-lg">Payments Debugger</CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                Monitor M-Pesa payment requests, view callback data, and simulate transactions
              </CardDescription>
            </div>
          </div>
          {isSandbox && (
            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/30 self-start sm:self-auto">
              <FlaskConical className="h-3 w-3 mr-1" />
              Sandbox Mode
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 sm:items-end">
          <div className="flex-1 min-w-0 sm:min-w-[200px]">
            <Label>Search</Label>
            <Input
              placeholder="Phone, receipt, or reference..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="w-full sm:w-[150px]">
            <Label>Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={fetchPaymentRequests} disabled={isLoading} className="self-end">
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Separator />

        {/* Payment Requests List */}
        <ScrollArea className="h-[400px]">
          {isLoading ? (
            <div className="flex items-center justify-center h-32">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredPayments.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
              <Smartphone className="h-8 w-8 mb-2" />
              <p>No payment requests found</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredPayments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {getStatusIcon(payment.status)}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">
                          {formatCurrency(payment.amount)}
                        </span>
                        <Badge variant={getStatusBadgeVariant(payment.status)} className="text-xs">
                          {payment.status}
                        </Badge>
                        {payment.callback_payload?._simulated && (
                          <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-600">
                            Simulated
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs sm:text-sm text-muted-foreground truncate">
                        {payment.phone_number && (
                          <span className="font-mono">{payment.phone_number}</span>
                        )}
                        {payment.receipt_number && (
                          <span className="ml-2">• {payment.receipt_number}</span>
                        )}
                        <span className="ml-2">
                          • {formatDistanceToNow(new Date(payment.created_at), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                    {/* Simulate Buttons - Only for pending/processing in sandbox */}
                    {isSandbox && ["pending", "processing"].includes(payment.status) && (
                      <div className="flex gap-1 flex-wrap">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-green-600 hover:bg-green-50"
                              disabled={isSimulating}
                            >
                              <Play className="h-3 w-3 mr-1" />
                              Success
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Simulate Success?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will simulate a successful M-Pesa callback for this payment request.
                                A fake receipt number will be generated and the payment will be marked as completed.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleSimulate(payment.id, "success")}
                                className="bg-green-600 hover:bg-green-700"
                              >
                                Simulate Success
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>

                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-amber-600 hover:bg-amber-50"
                              disabled={isSimulating}
                            >
                              <XCircle className="h-3 w-3 mr-1" />
                              Cancel
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Simulate Cancellation?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will simulate a user-cancelled M-Pesa transaction (ResultCode 1032).
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleSimulate(payment.id, "cancelled")}
                                className="bg-amber-600 hover:bg-amber-700"
                              >
                                Simulate Cancellation
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>

                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive hover:bg-destructive/10"
                              disabled={isSimulating}
                            >
                              <XCircle className="h-3 w-3 mr-1" />
                              Fail
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Simulate Failure?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will simulate a failed M-Pesa transaction (e.g., insufficient balance).
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleSimulate(payment.id, "failed")}
                                className="bg-destructive hover:bg-destructive/90"
                              >
                                Simulate Failure
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}

                    {/* View Details */}
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelectedPayment(payment)}
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          Details
                          <ChevronRight className="h-4 w-4 ml-1" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                        <DialogHeader>
                          <DialogTitle className="flex items-center gap-2">
                            {getStatusIcon(payment.status)}
                            Payment Details
                          </DialogTitle>
                        </DialogHeader>
                        <ScrollArea className="flex-1">
                          <div className="space-y-4 pr-4">
                            {/* Basic Info */}
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <Label className="text-muted-foreground">Amount</Label>
                                <p className="font-medium">{formatCurrency(payment.amount)}</p>
                              </div>
                              <div>
                                <Label className="text-muted-foreground">Status</Label>
                                <p className="flex items-center gap-2">
                                  <Badge variant={getStatusBadgeVariant(payment.status)}>
                                    {payment.status}
                                  </Badge>
                                </p>
                              </div>
                              <div>
                                <Label className="text-muted-foreground">Phone Number</Label>
                                <p className="font-mono">{payment.phone_number || "-"}</p>
                              </div>
                              <div>
                                <Label className="text-muted-foreground">Receipt Number</Label>
                                <p className="font-mono">{payment.receipt_number || "-"}</p>
                              </div>
                              <div>
                                <Label className="text-muted-foreground">Initiated At</Label>
                                <p>{format(new Date(payment.initiated_at), "PPpp")}</p>
                              </div>
                              <div>
                                <Label className="text-muted-foreground">Completed At</Label>
                                <p>
                                  {payment.completed_at
                                    ? format(new Date(payment.completed_at), "PPpp")
                                    : "-"}
                                </p>
                              </div>
                            </div>

                            <Separator />

                            {/* Technical Details */}
                            <div className="space-y-2">
                              <Label className="text-muted-foreground">Provider Reference</Label>
                              <code className="block text-xs bg-muted p-2 rounded">
                                {payment.provider_reference || "-"}
                              </code>
                            </div>

                            <div className="space-y-2">
                              <Label className="text-muted-foreground">Merchant Request ID</Label>
                              <code className="block text-xs bg-muted p-2 rounded">
                                {payment.merchant_request_id || "-"}
                              </code>
                            </div>

                            {payment.result_description && (
                              <div className="space-y-2">
                                <Label className="text-muted-foreground">Result Description</Label>
                                <p className="text-sm">{payment.result_description}</p>
                              </div>
                            )}

                            <Separator />

                            {/* Callback Payload */}
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <Label className="text-muted-foreground">Callback Payload</Label>
                                {payment.callback_payload?._simulated && (
                                  <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-600">
                                    Simulated
                                  </Badge>
                                )}
                              </div>
                              <ScrollArea className="h-[200px]">
                                <pre className="text-xs bg-muted p-3 rounded overflow-x-auto">
                                  {payment.callback_payload
                                    ? JSON.stringify(payment.callback_payload, null, 2)
                                    : "No callback received yet"}
                                </pre>
                              </ScrollArea>
                            </div>
                          </div>
                        </ScrollArea>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

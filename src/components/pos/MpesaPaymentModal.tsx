import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { 
  Smartphone, 
  Loader2, 
  CheckCircle, 
  XCircle, 
  Clock,
  RefreshCw,
  AlertTriangle,
  FlaskConical
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { usePaymentRequests, PaymentRequest } from "@/hooks/usePaymentRequests";
import { useMpesaSimulation, SimulationScenario } from "@/hooks/useMpesaSimulation";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { z } from "zod";

interface MpesaPaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amount: number;
  posTransactionId?: string;
  onSuccess: (receiptNumber: string) => void;
  onCancel: () => void;
}

type PaymentPhase = "phone-entry" | "waiting" | "success" | "failed" | "expired";

export function MpesaPaymentModal({
  open,
  onOpenChange,
  amount,
  posTransactionId,
  onSuccess,
  onCancel,
}: MpesaPaymentModalProps) {
  const { formatCurrency } = useCurrency();
  const { initiateMpesaPayment, checkPaymentStatus, queryMpesaStatus, cancelPaymentRequest, isProcessing } = usePaymentRequests();
  const { simulateCallback, isSimulating } = useMpesaSimulation();
  const { getSetting } = usePlatformSettings();
  const { toast } = useToast();

  const [phase, setPhase] = useState<PaymentPhase>("phone-entry");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [paymentRequest, setPaymentRequest] = useState<PaymentRequest | null>(null);
  const [countdown, setCountdown] = useState(120); // 2 minutes
  const [isQuerying, setIsQuerying] = useState(false);
  const [autoQueryTriggered, setAutoQueryTriggered] = useState(false);
  const autoQueryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSandbox = getSetting("mpesa_environment") !== "production";

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setPhase("phone-entry");
      setPhoneNumber("");
      setPaymentRequest(null);
      setCountdown(120);
      setAutoQueryTriggered(false);
      if (autoQueryTimeoutRef.current) {
        clearTimeout(autoQueryTimeoutRef.current);
      }
    }
    return () => {
      if (autoQueryTimeoutRef.current) {
        clearTimeout(autoQueryTimeoutRef.current);
      }
    };
  }, [open]);

  // Polling for payment status
  useEffect(() => {
    if (phase !== "waiting" || !paymentRequest) return;

    const pollInterval = setInterval(async () => {
      const status = await checkPaymentStatus(paymentRequest.id);
      if (status) {
        if (status.status === "completed") {
          setPhase("success");
          setPaymentRequest(status);
        } else if (status.status === "failed" || status.status === "cancelled") {
          setPhase("failed");
          setPaymentRequest(status);
        } else if (status.status === "expired") {
          setPhase("expired");
          setPaymentRequest(status);
        }
      }
    }, 3000); // Poll every 3 seconds

    return () => clearInterval(pollInterval);
  }, [phase, paymentRequest, checkPaymentStatus]);

  // Automatic fallback query after 30 seconds if no callback received
  useEffect(() => {
    if (phase !== "waiting" || !paymentRequest || autoQueryTriggered) return;

    autoQueryTimeoutRef.current = setTimeout(async () => {
      console.log("Auto-triggering M-Pesa query after 30 seconds...");
      setAutoQueryTriggered(true);
      const result = await queryMpesaStatus(paymentRequest.id);
      if (result) {
        setPaymentRequest(result);
        if (result.status === "completed") {
          setPhase("success");
        } else if (result.status === "failed" || result.status === "cancelled") {
          setPhase("failed");
        }
      }
    }, 30000); // 30 seconds

    return () => {
      if (autoQueryTimeoutRef.current) {
        clearTimeout(autoQueryTimeoutRef.current);
      }
    };
  }, [phase, paymentRequest, autoQueryTriggered, queryMpesaStatus]);

  // Countdown timer
  useEffect(() => {
    if (phase !== "waiting") return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setPhase("expired");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [phase]);

  const handleInitiatePayment = async () => {
    const normalized = normalizeKenyanPhoneNumber(phoneNumber);
    const parsed = mpesaPhoneSchema.safeParse(phoneNumber);
    if (!parsed.success || !normalized) {
      toast({
        title: "Invalid phone number",
        description: parsed.success ? "Enter a valid Kenyan phone number." : parsed.error.issues[0]?.message,
        variant: "destructive",
      });
      return;
    }

    const result = await initiateMpesaPayment(normalized, amount, posTransactionId);
    if (result) {
      setPaymentRequest(result);
      setPhase("waiting");
      setCountdown(120);
    }
  };

  const handleQueryStatus = async () => {
    if (!paymentRequest) return;
    
    setIsQuerying(true);
    const result = await queryMpesaStatus(paymentRequest.id);
    if (result) {
      setPaymentRequest(result);
      if (result.status === "completed") {
        setPhase("success");
      } else if (result.status === "failed" || result.status === "cancelled") {
        setPhase("failed");
      }
    }
    setIsQuerying(false);
  };

  const handleRetry = () => {
    setPhase("phone-entry");
    setPaymentRequest(null);
    setCountdown(120);
    setAutoQueryTriggered(false);
  };

  const handleCancel = async () => {
    if (paymentRequest && phase === "waiting") {
      await cancelPaymentRequest(paymentRequest.id);
    }
    if (autoQueryTimeoutRef.current) {
      clearTimeout(autoQueryTimeoutRef.current);
    }
    onCancel();
    onOpenChange(false);
  };

  const handleSimulateSuccess = async () => {
    if (!paymentRequest) return;
    const result = await simulateCallback(paymentRequest.id, "success");
    if (result?.success) {
      setPhase("success");
      setPaymentRequest({
        ...paymentRequest,
        status: "completed",
        receipt_number: result.receiptNumber || null,
      });
    }
  };

  const handleSuccessClose = () => {
    onSuccess(paymentRequest?.receipt_number || "");
    onOpenChange(false);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // Format phone number as user types
  const handlePhoneChange = (value: string) => {
    // Remove all non-numeric characters
    const cleaned = value.replace(/\D/g, "");
    setPhoneNumber(cleaned);
  };

  const normalizeKenyanPhoneNumber = (raw: string): string | null => {
    const cleaned = raw.replace(/\s+/g, "").replace(/[^0-9]/g, "");
    if (!cleaned) return null;

    // Accept:
    // - 712345678 (9 digits) -> 254712345678
    // - 0712345678 (10 digits) -> 254712345678
    // - 254712345678 (12 digits) -> 254712345678
    if (cleaned.startsWith("254") && cleaned.length === 12) return cleaned;
    if (cleaned.startsWith("0") && cleaned.length === 10) return `254${cleaned.slice(1)}`;
    if ((cleaned.startsWith("7") || cleaned.startsWith("1")) && cleaned.length === 9) return `254${cleaned}`;

    return null;
  };

  const mpesaPhoneSchema = z
    .string()
    .min(1, { message: "Phone number is required" })
    .refine((val) => normalizeKenyanPhoneNumber(val) !== null, {
      message: "Enter a valid Kenyan number (e.g., 0712345678 or 712345678)",
    });

  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="max-w-[95vw] sm:max-w-md max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-[#4caf50] flex items-center justify-center">
              <Smartphone className="h-4 w-4 text-white" />
            </div>
            M-Pesa Payment
            {isSandbox && (
              <Badge variant="outline" className="ml-2 bg-amber-500/10 text-amber-600 border-amber-500/30">
                <FlaskConical className="h-3 w-3 mr-1" />
                Sandbox
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Amount Display */}
          <div className="text-center py-4 bg-muted/50 rounded-lg">
            <p className="text-sm text-muted-foreground mb-1">Amount to Pay</p>
            <p className="text-3xl font-bold">{formatCurrency(amount)}</p>
          </div>

          {/* Phone Entry Phase */}
          {phase === "phone-entry" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mpesaPhone">M-Pesa Phone Number</Label>
                <div className="flex gap-2">
                  <div className="flex items-center px-3 bg-muted rounded-l-md border border-r-0">
                    <span className="text-sm font-medium">+254</span>
                  </div>
                  <Input
                    id="mpesaPhone"
                    type="tel"
                    value={phoneNumber.startsWith("254") ? phoneNumber.slice(3) : phoneNumber.startsWith("0") ? phoneNumber.slice(1) : phoneNumber}
                    onChange={(e) => handlePhoneChange(e.target.value)}
                    placeholder="7XXXXXXXX"
                    className="rounded-l-none text-lg"
                    maxLength={9}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter the customer's M-Pesa registered phone number
                </p>
              </div>

              <div className="flex gap-2">
                <Button
                  className="flex-1 h-12"
                  onClick={handleInitiatePayment}
                  disabled={!mpesaPhoneSchema.safeParse(phoneNumber).success || isProcessing}
                >
                  {isProcessing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Smartphone className="mr-2 h-4 w-4" />
                  )}
                  Send STK Push
                </Button>
                <Button variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Waiting Phase */}
          {phase === "waiting" && (
            <div className="space-y-6 text-center">
              <div className="space-y-2">
                <div className="flex justify-center">
                  <div className="relative">
                    <div className="h-20 w-20 rounded-full border-4 border-primary/20 flex items-center justify-center">
                      <Smartphone className="h-8 w-8 text-primary animate-pulse" />
                    </div>
                    <div className="absolute -inset-1 rounded-full border-4 border-t-primary border-r-transparent border-b-transparent border-l-transparent animate-spin" />
                  </div>
                </div>
                <h3 className="font-medium text-lg">Waiting for M-Pesa...</h3>
                <p className="text-sm text-muted-foreground">
                  A prompt has been sent to <span className="font-mono">+{paymentRequest?.phone_number}</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  Ask the customer to enter their M-Pesa PIN
                </p>
              </div>

              <div className="flex items-center justify-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className={cn(
                  "font-mono text-lg",
                  countdown <= 30 && "text-amber-600",
                  countdown <= 10 && "text-destructive"
                )}>
                  {formatTime(countdown)}
                </span>
              </div>

              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  className="flex-1"
                  onClick={handleQueryStatus}
                  disabled={isQuerying}
                >
                  {isQuerying ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Check Status
                </Button>
                <Button variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>

              {/* Sandbox Simulation Controls */}
              {isSandbox && (
                <div className="mt-4 p-3 rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5">
                  <p className="text-xs text-amber-600 mb-2 flex items-center gap-1">
                    <FlaskConical className="h-3 w-3" />
                    Sandbox Testing Controls
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full text-green-600 hover:bg-green-50 border-green-300"
                    onClick={handleSimulateSuccess}
                    disabled={isSimulating}
                  >
                    {isSimulating ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle className="mr-2 h-3 w-3" />
                    )}
                    Simulate Success Callback
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Success Phase */}
          {phase === "success" && (
            <div className="space-y-6 text-center">
              <div className="space-y-2">
                <div className="flex justify-center">
                  <div className="h-20 w-20 rounded-full bg-green-500/10 flex items-center justify-center">
                    <CheckCircle className="h-10 w-10 text-green-600" />
                  </div>
                </div>
                <h3 className="font-medium text-lg text-green-600">Payment Successful!</h3>
                {paymentRequest?.receipt_number && (
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">M-Pesa Receipt</p>
                    <Badge variant="outline" className="text-lg font-mono">
                      {paymentRequest.receipt_number}
                    </Badge>
                  </div>
                )}
              </div>

              <Button className="w-full h-12" onClick={handleSuccessClose}>
                <CheckCircle className="mr-2 h-4 w-4" />
                Complete Transaction
              </Button>
            </div>
          )}

          {/* Failed Phase */}
          {phase === "failed" && (
            <div className="space-y-6 text-center">
              <div className="space-y-2">
                <div className="flex justify-center">
                  <div className="h-20 w-20 rounded-full bg-destructive/10 flex items-center justify-center">
                    <XCircle className="h-10 w-10 text-destructive" />
                  </div>
                </div>
                <h3 className="font-medium text-lg text-destructive">Payment Failed</h3>
                <p className="text-sm text-muted-foreground">
                  {paymentRequest?.result_description || "The payment was not completed"}
                </p>
              </div>

              <div className="flex gap-2">
                <Button className="flex-1" onClick={handleRetry}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Try Again
                </Button>
                <Button variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Expired Phase */}
          {phase === "expired" && (
            <div className="space-y-6 text-center">
              <div className="space-y-2">
                <div className="flex justify-center">
                  <div className="h-20 w-20 rounded-full bg-amber-500/10 flex items-center justify-center">
                    <AlertTriangle className="h-10 w-10 text-amber-600" />
                  </div>
                </div>
                <h3 className="font-medium text-lg text-amber-600">Request Expired</h3>
                <p className="text-sm text-muted-foreground">
                  The M-Pesa prompt timed out. The customer may have dismissed it or didn't respond in time.
                </p>
              </div>

              <div className="flex gap-2">
                <Button className="flex-1" onClick={handleRetry}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Send New Request
                </Button>
                <Button variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

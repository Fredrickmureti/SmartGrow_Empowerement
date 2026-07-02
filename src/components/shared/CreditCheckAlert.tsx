import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useCustomerCredit } from "@/hooks/useCustomerCredit";

interface CreditCheckAlertProps {
  customerId?: string;
  orderAmount: number;
}

/**
 * Displays a warning/block alert when a customer is on credit hold
 * or when an order would exceed available credit.
 */
export function CreditCheckAlert({ customerId, orderAmount }: CreditCheckAlertProps) {
  const { creditInfo, isLoading, checkCreditAvailability } = useCustomerCredit(customerId);

  if (isLoading || !customerId || !creditInfo) return null;

  const result = checkCreditAvailability(orderAmount);

  if (result.allowed) return null;

  const isHold = creditInfo.creditHold;

  return (
    <Alert variant="destructive" className="border-destructive/50">
      {isHold ? (
        <ShieldAlert className="h-4 w-4" />
      ) : (
        <AlertTriangle className="h-4 w-4" />
      )}
      <AlertTitle>{isHold ? "Credit Hold" : "Credit Limit Exceeded"}</AlertTitle>
      <AlertDescription>{result.reason}</AlertDescription>
    </Alert>
  );
}

/**
 * Hook wrapper for imperative credit checks before submission.
 * Returns a function that checks credit and shows a toast if blocked.
 */
export function useCreditCheck() {
  const checkBeforeSubmit = (
    creditInfo: ReturnType<typeof useCustomerCredit>["creditInfo"],
    checkFn: ReturnType<typeof useCustomerCredit>["checkCreditAvailability"],
    orderAmount: number
  ): { allowed: boolean; reason?: string } => {
    if (!creditInfo) return { allowed: true };
    const result = checkFn(orderAmount);
    return result;
  };

  return { checkBeforeSubmit };
}

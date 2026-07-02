/**
 * Phase 3c: Credit Utilization Bar
 * Shows credit limit, outstanding, available credit and utilization progress.
 */
import { useCustomerCredit } from "@/hooks/useCustomerCredit";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, CreditCard, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  contactId: string;
  contactType: string;
}

export function ContactCreditStatus({ contactId, contactType }: Props) {
  const { creditInfo, isLoading } = useCustomerCredit(contactId);
  const { formatCurrency } = useCurrency();

  const isCustomer = contactType === "customer" || contactType === "both";
  if (!isCustomer) return null;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!creditInfo) return null;

  // Only show if credit limit is set or credit hold is active
  if (creditInfo.creditLimit === null && !creditInfo.creditHold) return null;

  const utilization = creditInfo.creditUtilization ?? 0;
  const getUtilColor = () => {
    if (utilization >= 90) return "text-destructive";
    if (utilization >= 70) return "text-orange-600";
    if (utilization >= 50) return "text-yellow-600";
    return "text-emerald-600";
  };

  const getProgressColor = () => {
    if (utilization >= 90) return "[&>div]:bg-destructive";
    if (utilization >= 70) return "[&>div]:bg-orange-500";
    if (utilization >= 50) return "[&>div]:bg-yellow-500";
    return "[&>div]:bg-emerald-500";
  };

  return (
    <Card className={creditInfo.creditHold ? "border-destructive" : ""}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CreditCard className="h-4 w-4" /> Credit Status
          </CardTitle>
          {creditInfo.creditHold && (
            <Badge variant="destructive" className="gap-1">
              <ShieldAlert className="h-3 w-3" />
              Credit Hold
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {creditInfo.creditLimit !== null && (
          <>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Utilization</span>
              <span className={cn("font-medium", getUtilColor())}>{utilization.toFixed(0)}%</span>
            </div>
            <Progress value={Math.min(utilization, 100)} className={cn("h-2", getProgressColor())} />
          </>
        )}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[10px] text-muted-foreground">Limit</p>
            <p className="text-sm font-medium">
              {creditInfo.creditLimit !== null ? formatCurrency(creditInfo.creditLimit) : "∞"}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">Outstanding</p>
            <p className="text-sm font-medium text-destructive">
              {formatCurrency(creditInfo.outstandingBalance)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">Available</p>
            <p className="text-sm font-medium text-emerald-600">
              {creditInfo.availableCredit !== null ? formatCurrency(creditInfo.availableCredit) : "∞"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

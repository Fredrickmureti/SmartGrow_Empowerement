import { useCustomersNearCreditLimit } from "@/hooks/useCustomerCredit";
import { useCurrency } from "@/hooks/useCurrency";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AlertTriangle, CreditCard, Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

export function CreditAlertWidget() {
  const { customersNearLimit, isLoading } = useCustomersNearCreditLimit(80);
  const { formatCurrency } = useCurrency();

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base font-medium flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Credit Alerts
            </CardTitle>
            <CardDescription>
              Customers near or exceeding credit limit
            </CardDescription>
          </div>
          {customersNearLimit.length > 0 && (
            <Badge variant="destructive">
              {customersNearLimit.length}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : customersNearLimit.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <div className="rounded-full bg-green-100 p-2 mb-2">
              <CreditCard className="h-5 w-5 text-green-600" />
            </div>
            <p className="text-sm text-muted-foreground">
              All customers within credit limits
            </p>
          </div>
        ) : (
          <ScrollArea className="h-[200px]">
            <div className="space-y-3">
              {customersNearLimit.map((customer) => (
                <div
                  key={customer.id}
                  className="flex flex-col gap-2 p-3 rounded-lg border bg-muted/30"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm truncate">
                      {customer.name}
                    </span>
                    {customer.isOnHold ? (
                      <Badge variant="destructive" className="text-xs">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        On Hold
                      </Badge>
                    ) : customer.utilization >= 100 ? (
                      <Badge variant="destructive" className="text-xs">
                        Over Limit
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        {customer.utilization.toFixed(0)}% Used
                      </Badge>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Progress 
                      value={Math.min(100, customer.utilization)} 
                      className="h-2"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>
                        Outstanding: {formatCurrency(customer.outstandingBalance)}
                      </span>
                      <span>
                        Limit: {formatCurrency(customer.creditLimit)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

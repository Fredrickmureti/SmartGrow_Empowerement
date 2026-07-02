import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, CreditCard, Receipt, MonitorSmartphone, Rocket, X } from "lucide-react";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { usePOSRegisters } from "@/hooks/pos/usePOSRegisters";
import { useState } from "react";

interface POSSetupChecklistProps {
  hasShiftHistory: boolean;
}

export function POSSetupChecklist({ hasShiftHistory }: POSSetupChecklistProps) {
  const navigate = useNavigate();
  const { enabledPaymentMethods, receiptSettings } = usePOSSettings();
  const { registers } = usePOSRegisters();
  const [dismissed, setDismissed] = useState(false);

  // Don't show if shifts exist or manually dismissed
  if (hasShiftHistory || dismissed) return null;

  const checks = [
    {
      label: "Payment methods configured",
      done: enabledPaymentMethods.length >= 1,
      action: () => navigate("/pos/settings", { state: { tab: "payments" } }),
      icon: CreditCard,
    },
    {
      label: "Receipt header/footer set",
      done: !!(receiptSettings.receipt_header || receiptSettings.receipt_footer),
      action: () => navigate("/pos/settings", { state: { tab: "receipts" } }),
      icon: Receipt,
    },
    {
      label: "At least one active register",
      done: registers.filter(r => r.is_active).length >= 1,
      action: () => navigate("/pos/settings", { state: { tab: "registers" } }),
      icon: MonitorSmartphone,
    },
  ];

  const completedCount = checks.filter(c => c.done).length;
  const allDone = completedCount === checks.length;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">
              {allDone ? "You're all set!" : "Configure your POS"}
            </CardTitle>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDismissed(true)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <CardDescription className="text-xs">
          {allDone
            ? "Open a terminal and start your first shift."
            : `Complete these steps to get started (${completedCount}/${checks.length})`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {checks.map((check, i) => {
          const Icon = check.done ? CheckCircle2 : Circle;
          return (
            <button
              key={i}
              onClick={check.action}
              className="flex items-center gap-3 w-full text-left p-2 rounded-md hover:bg-primary/10 transition-colors"
            >
              <Icon className={`h-4 w-4 flex-shrink-0 ${check.done ? "text-primary" : "text-muted-foreground"}`} />
              <span className={`text-sm flex-1 ${check.done ? "line-through text-muted-foreground" : ""}`}>
                {check.label}
              </span>
              {!check.done && (
                <Badge variant="outline" className="text-[10px]">Set up</Badge>
              )}
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FileText, BarChart3, ArrowRight, CheckCircle2, AlertTriangle, Info } from "lucide-react";
import type { MigrationStrategy } from "@/lib/migration/types";

interface Props {
  selected: MigrationStrategy;
  onSelect: (strategy: MigrationStrategy) => void;
}

export function MigrationStrategySelector({ selected, onSelect }: Props) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">How do you want to migrate your data?</h3>
        <p className="text-sm text-muted-foreground mt-1">
          This choice affects how your historical data appears in reports and the General Ledger.
        </p>
      </div>

      <div className="grid gap-3">
        {/* Summary Migration */}
        <Card
          className={`cursor-pointer transition-all ${selected === "summary" ? "border-primary ring-2 ring-primary/20" : "hover:border-primary/50"}`}
          onClick={() => onSelect("summary")}
        >
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 p-2 rounded-lg bg-primary/10">
                <BarChart3 className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-sm">Opening Balances Only</span>
                  <Badge variant="secondary" className="text-[10px]">Recommended</Badge>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Import account balances as of cutover date. Open invoices are tracked for aging reports
                  but the GL shows a single consolidated opening balance entry.
                </p>
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-success" />
                    Correct trial balance and financial statements
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-success" />
                    AR/AP aging by customer/vendor
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3 w-3 text-warning" />
                    No GL drill-down to individual migrated invoices
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3 w-3 text-warning" />
                    No payment history for migrated transactions
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Full Transaction Migration */}
        <Card
          className={`cursor-pointer transition-all ${selected === "full_transaction" ? "border-primary ring-2 ring-primary/20" : "hover:border-primary/50"}`}
          onClick={() => onSelect("full_transaction")}
        >
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 p-2 rounded-lg bg-primary/10">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-sm">Full Transaction Import</span>
                  <Badge variant="outline" className="text-[10px]">Advanced</Badge>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Import individual invoices and payments with full GL linkage. Each transaction
                  gets its own journal entry — identical to invoices created in-system.
                </p>
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-success" />
                    Full GL drill-down to every migrated invoice
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-success" />
                    Payment history and settlement tracking
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-success" />
                    Complete audit trail from day one
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3 w-3 text-warning" />
                    Requires more data preparation
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AlertTriangle className="h-3 w-3 text-warning" />
                    Trial balance must EXCLUDE AR/AP totals (they come from invoices)
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {selected === "full_transaction" && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>Important:</strong> In full transaction mode, your trial balance should NOT include 
            Accounts Receivable or Accounts Payable totals — those balances will be generated automatically 
            from the imported invoices and bills. Including them would cause double-counting in the GL.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

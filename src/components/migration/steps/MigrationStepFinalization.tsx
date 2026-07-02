import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useMigrationSession } from "@/hooks/useMigrationSession";
import { CheckCircle2, Loader2, Lock, ShieldAlert } from "lucide-react";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

export function MigrationStepFinalization({ onComplete }: Props) {
  const migration = useMigrationSession();
  const [isFinalizing, setIsFinalizing] = useState(false);

  const validationStep = migration.steps.find((s) => s.step_key === "validation");
  const validationPassed = validationStep?.status === "completed";

  const handleFinalize = async () => {
    setIsFinalizing(true);
    try {
      await migration.finalizeMigration();
      onComplete();
    } catch (err) {
      console.error(err);
    }
    setIsFinalizing(false);
  };

  const completedSteps = migration.steps.filter((s) => s.status === "completed" || s.status === "skipped");
  const totalImported = completedSteps.reduce((sum, s) => sum + (s.record_count || 0), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-5 w-5" />
          Finalize Migration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Finalizing will mark the migration as complete, lock all fiscal periods up to the cutover date,
          and prevent further migration imports. After finalization, you can begin entering live transactions.
        </p>

        <div className="p-4 rounded-md bg-muted space-y-2">
          <div className="text-sm">
            <strong>Steps completed:</strong> {completedSteps.length} / {migration.steps.length}
          </div>
          <div className="text-sm">
            <strong>Total records imported:</strong> {totalImported}
          </div>
          {migration.session?.cutover_date && (
            <div className="text-sm">
              <strong>Cutover date:</strong> {migration.session.cutover_date}
            </div>
          )}
        </div>

        {!migration.session?.cutover_date && (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription>
              No cutover date set. Fiscal period locking requires a cutover date. 
              Go back to the Configuration step to set one.
            </AlertDescription>
          </Alert>
        )}

        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            After finalization: all fiscal periods ending on or before the cutover date will be locked.
            You can start creating invoices, bills, payments, and journal entries dated after the cutover date.
          </AlertDescription>
        </Alert>

        <Button
          onClick={handleFinalize}
          disabled={isFinalizing || !migration.session?.cutover_date}
          className="w-full"
          size="lg"
        >
          {isFinalizing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Finalize & Lock Migration
        </Button>
      </CardContent>
    </Card>
  );
}

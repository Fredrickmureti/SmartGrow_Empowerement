import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
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
  CheckCircle2,
  Circle,
  Loader2,
  AlertTriangle,
  XCircle,
  SkipForward,
  Lock,
  ArrowRight,
  Database,
  Info,
  RotateCcw,
} from "lucide-react";
import { useMigrationSession } from "@/hooks/useMigrationSession";
import { MIGRATION_STEPS_CONFIG, StepKey, StepStatus, RollbackableStepKey, STEP_ROLLBACK_CONFIG, MigrationStrategy } from "@/lib/migration/types";
import { MigrationStrategySelector } from "./MigrationStrategySelector";
import { MigrationStepConfig } from "./steps/MigrationStepConfig";
import { MigrationStepAccounts } from "./steps/MigrationStepAccounts";
import { MigrationStepContacts } from "./steps/MigrationStepContacts";
import { MigrationStepProducts } from "./steps/MigrationStepProducts";
import { MigrationStepTrialBalance } from "./steps/MigrationStepTrialBalance";
import { MigrationStepOpenAR } from "./steps/MigrationStepOpenAR";
import { MigrationStepOpenAP } from "./steps/MigrationStepOpenAP";
import { MigrationStepBankBalances } from "./steps/MigrationStepBankBalances";
import { MigrationStepInventory } from "./steps/MigrationStepInventory";
import { MigrationStepValidation } from "./steps/MigrationStepValidation";
import { MigrationStepFinalization } from "./steps/MigrationStepFinalization";
import { MigrationStepPayments } from "./steps/MigrationStepPayments";

const stepStatusIcon = (status: StepStatus, canProceed: boolean) => {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-5 w-5 text-success" />;
    case "in_progress":
      return <Loader2 className="h-5 w-5 text-primary animate-spin" />;
    case "failed":
      return <XCircle className="h-5 w-5 text-destructive" />;
    case "skipped":
      return <SkipForward className="h-5 w-5 text-muted-foreground" />;
    default:
      return canProceed ? (
        <Circle className="h-5 w-5 text-primary" />
      ) : (
        <Lock className="h-5 w-5 text-muted-foreground" />
      );
  }
};

const STEP_COMPONENTS: Record<StepKey, React.ComponentType<{ onComplete: () => void; onSkip: () => void }>> = {
  config: MigrationStepConfig,
  accounts: MigrationStepAccounts,
  contacts: MigrationStepContacts,
  products: MigrationStepProducts,
  trial_balance: MigrationStepTrialBalance,
  open_ar: MigrationStepOpenAR,
  open_ap: MigrationStepOpenAP,
  payments: MigrationStepPayments,
  bank_balances: MigrationStepBankBalances,
  inventory: MigrationStepInventory,
  validation: MigrationStepValidation,
  finalization: MigrationStepFinalization,
};

const ROLLBACKABLE_STEPS = new Set<string>(Object.keys(STEP_ROLLBACK_CONFIG));

export function MigrationWorkbench() {
  const migration = useMigrationSession();
  const [activeStep, setActiveStep] = useState<StepKey | null>(null);
  const [cutoverDate, setCutoverDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sourceSystem, setSourceSystem] = useState("");
  const [migrationStrategy, setMigrationStrategy] = useState<MigrationStrategy>("summary");
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [showStrategyChange, setShowStrategyChange] = useState(false);

  if (migration.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // No active session — show create form
  if (!migration.session) {
    return (
      <Card className="max-w-xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Start Data Migration
          </CardTitle>
          <CardDescription>
            Migrate your financial data from another system. This guided workflow ensures your
            accounting data is imported correctly and consistently.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="cutover-date">Cutover Date</Label>
            <Input
              id="cutover-date"
              type="date"
              value={cutoverDate}
              onChange={(e) => setCutoverDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The date your opening balances are effective. All imported balances will be as of this date.
              Common choices: last fiscal year-end, last month-end, or today.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="source-system">Source System (optional)</Label>
            <Input
              id="source-system"
              placeholder="e.g., QuickBooks, Odoo, Tally, Excel"
              value={sourceSystem}
              onChange={(e) => setSourceSystem(e.target.value)}
            />
          </div>

          <Separator />

          <MigrationStrategySelector
            selected={migrationStrategy}
            onSelect={setMigrationStrategy}
          />

          <Button
            className="w-full"
            onClick={() =>
              migration.createSession.mutate({
                cutoverDate: cutoverDate || undefined,
                sourceSystem: sourceSystem || undefined,
                migrationStrategy,
              })
            }
            disabled={migration.createSession.isPending || !cutoverDate}
          >
            {migration.createSession.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Begin Migration
          </Button>
        </CardContent>
      </Card>
    );
  }

  const completedSteps = migration.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
  const totalSteps = migration.steps.length;
  const overallProgress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const isCompleted = migration.session?.status === "completed";

  const handleStepComplete = async (stepKey: StepKey) => {
    await migration.updateStepStatus(stepKey, "completed");
    setActiveStep(null);
    if (migration.session?.status === "draft") {
      await migration.updateSessionStatus("in_progress");
    }
  };

  const handleStepSkip = async (stepKey: StepKey) => {
    await migration.updateStepStatus(stepKey, "skipped");
    setActiveStep(null);
  };

  const handleRollback = async (stepKey: string) => {
    setRollingBack(stepKey);
    try {
      await migration.rollbackStep(stepKey as RollbackableStepKey);
    } catch (err) {
      console.error("Rollback failed:", err);
    }
    setRollingBack(null);
  };

  // Render active step detail
  if (activeStep) {
    const StepComponent = STEP_COMPONENTS[activeStep];
    const stepConfig = MIGRATION_STEPS_CONFIG.find((s) => s.key === activeStep)!;

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setActiveStep(null)}>
            ← Back to Overview
          </Button>
          <Separator orientation="vertical" className="h-6" />
          <h2 className="text-lg font-semibold">{stepConfig.label}</h2>
        </div>
        <StepComponent
          onComplete={() => handleStepComplete(activeStep)}
          onSkip={() => handleStepSkip(activeStep)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Migration Workbench
              </CardTitle>
              <CardDescription>
                {migration.session.source_system && `Migrating from ${migration.session.source_system} · `}
                {migration.session.cutover_date && `Cutover: ${migration.session.cutover_date} · `}
                Strategy: <Badge variant="outline" className="mx-1">
                  {migration.session.migration_strategy === "full_transaction" ? "Full Transaction" : "Opening Balances"}
                </Badge>
                {migration.canChangeStrategy && !showStrategyChange && (
                  <Button variant="link" size="sm" className="h-auto p-0 ml-1 text-xs" onClick={() => setShowStrategyChange(true)}>
                    Change
                  </Button>
                )}
                {" · "}
                Status: <Badge variant={isCompleted ? "default" : "secondary"}>{migration.session.status}</Badge>
              </CardDescription>
            </div>
            {!isCompleted && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10">
                    <XCircle className="h-4 w-4 mr-1" />
                    Abandon
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Abandon this migration?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete the migration session and all associated step data.
                      Any imported records (invoices, bills, journal entries) from completed steps will remain
                      — you should rollback individual steps first if needed.
                      You can then start a fresh migration.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => migration.abandonSession.mutate()}
                      disabled={migration.abandonSession.isPending}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {migration.abandonSession.isPending ? (
                        <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Abandoning...</>
                      ) : (
                        "Abandon & Start Over"
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {showStrategyChange && (
            <div className="space-y-3 p-4 rounded-lg border bg-muted/50">
              <MigrationStrategySelector
                selected={(migration.session.migration_strategy as MigrationStrategy) || "summary"}
                onSelect={async (strategy) => {
                  await migration.updateStrategy.mutateAsync(strategy);
                  setShowStrategyChange(false);
                }}
              />
              <Button variant="ghost" size="sm" onClick={() => setShowStrategyChange(false)}>
                Cancel
              </Button>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Progress value={overallProgress} className="flex-1" />
            <span className="text-sm font-medium text-muted-foreground">
              {completedSteps}/{totalSteps} steps
            </span>
          </div>
        </CardContent>
      </Card>

      {isCompleted && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            Migration is complete. Fiscal periods up to the cutover date are locked. 
            You can now begin entering live transactions.
          </AlertDescription>
        </Alert>
      )}

      {!isCompleted && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            Complete each step in sequence. Steps with unmet prerequisites are locked.
            You can skip optional steps and rollback completed data import steps.
          </AlertDescription>
        </Alert>
      )}

      {/* Steps list */}
      <div className="space-y-2">
        {MIGRATION_STEPS_CONFIG.map((config) => {
          const step = migration.steps.find((s) => s.step_key === config.key);
          const status = step?.status || "pending";
          const canProceed = migration.canProceedToStep(config.key);
          const currentStrategy = migration.session?.migration_strategy || "summary";
          const isSummaryOnly = currentStrategy === "summary";

          // Payments step is only relevant for full_transaction strategy
          const isStrategyHidden = config.key === "payments" && isSummaryOnly;
          if (isStrategyHidden) return null;

          // Strategy-specific descriptions for AR/AP
          let description = config.description;
          if (isSummaryOnly && config.key === "open_ar") {
            description = "Import open customer invoices for aging reports (subledger only — no GL posting)";
          } else if (isSummaryOnly && config.key === "open_ap") {
            description = "Import open supplier bills for aging reports (subledger only — no GL posting)";
          }

          const isClickable = canProceed && status !== "completed" && !isCompleted;
          const canRollback = !isCompleted && status === "completed" && ROLLBACKABLE_STEPS.has(config.key);

          return (
            <Card
              key={config.key}
              className={`transition-colors ${isClickable ? "cursor-pointer hover:border-primary/50" : ""} ${status === "completed" ? "opacity-80" : ""}`}
              onClick={() => isClickable && setActiveStep(config.key)}
            >
              <CardContent className="flex items-center gap-4 py-4">
                <div className="flex-shrink-0">
                  {stepStatusIcon(status, canProceed)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{config.label}</span>
                    {step?.record_count ? (
                      <Badge variant="outline" className="text-xs">
                        {step.record_count} records
                      </Badge>
                    ) : null}
                    {step?.error_count ? (
                      <Badge variant="destructive" className="text-xs">
                        {step.error_count} errors
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {canRollback && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {rollingBack === config.key ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="h-4 w-4" />
                          )}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Rollback "{config.label}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will delete all records imported in this step (invoices, bills, stock movements, 
                            or journal entries as applicable) and reset the step to pending. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleRollback(config.key)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Rollback
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {isClickable && (
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

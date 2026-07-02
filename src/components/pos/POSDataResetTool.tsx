// @ts-nocheck
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  Trash2, 
  AlertTriangle, 
  Loader2,
  ShieldAlert,
  RotateCcw,
  Database,
  AlertOctagon,
  ShoppingCart,
  Clock,
  TableIcon,
  Pause,
  Rocket
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface DataCategory {
  id: string;
  label: string;
  description: string;
  tables: string[];
  icon: React.ReactNode;
  color: string;
}

type ConfirmationStep = "warning" | "type_confirm" | "final_countdown";

export function POSDataResetTool() {
  const { currentOrg, userRole } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [confirmStep, setConfirmStep] = useState<ConfirmationStep>("warning");
  const [confirmText, setConfirmText] = useState("");
  const [countdown, setCountdown] = useState(5);
  const [dataCounts, setDataCounts] = useState<Record<string, number>>({});
  const [isLoadingCounts, setIsLoadingCounts] = useState(false);

  // Only allow owner, admin, or super_admin roles
  const allowedRoles = ["super_admin", "owner", "admin"];
  const canAccessTool = userRole && allowedRoles.includes(userRole.role);

  const categories: DataCategory[] = [
    {
      id: "transactions",
      label: "POS Transactions",
      description: "All sales, items, payments, modifiers, split bills, and kitchen orders",
      tables: [
        "pos_transaction_item_modifiers",
        "pos_transaction_items",
        "pos_transaction_payments",
        "pos_split_bills",
        "pos_kitchen_orders",
        "pos_transactions",
      ],
      icon: <ShoppingCart className="h-4 w-4" />,
      color: "text-blue-500",
    },
    {
      id: "shifts",
      label: "POS Shifts",
      description: "Shift records and cash drawer movements",
      tables: ["pos_cash_movements", "pos_shifts"],
      icon: <Clock className="h-4 w-4" />,
      color: "text-green-500",
    },
    {
      id: "table_sessions",
      label: "Table Sessions",
      description: "Restaurant table sessions and transfers",
      tables: ["pos_table_transfers", "pos_table_sessions"],
      icon: <TableIcon className="h-4 w-4" />,
      color: "text-purple-500",
    },
    {
      id: "held_transactions",
      label: "Held Transactions",
      description: "Parked/held orders waiting to be completed",
      tables: ["pos_held_transactions"],
      icon: <Pause className="h-4 w-4" />,
      color: "text-orange-500",
    },
  ];

  const fetchDataCounts = async () => {
    if (!currentOrg) return;
    
    setIsLoadingCounts(true);
    try {
      const counts: Record<string, number> = {};
      
      const [
        { count: transactionsCount },
        { count: shiftsCount },
        { count: tableSessionsCount },
        { count: heldTransactionsCount },
      ] = await Promise.all([
        // SCOPE-EXEMPT: admin go-live POS reset — clears workspace-wide test data
        supabase.from("pos_transactions").select("*", { count: "exact", head: true }).eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id),
        // SCOPE-EXEMPT: admin go-live POS reset
        supabase.from("pos_shifts").select("*", { count: "exact", head: true }).eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id),
        supabase.from("pos_table_sessions").select("*", { count: "exact", head: true }).eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id),
        supabase.from("pos_held_transactions").select("*", { count: "exact", head: true }).eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id),
      ]);

      counts["transactions"] = transactionsCount || 0;
      counts["shifts"] = shiftsCount || 0;
      counts["table_sessions"] = tableSessionsCount || 0;
      counts["held_transactions"] = heldTransactionsCount || 0;

      setDataCounts(counts);
    } catch (error) {
      console.error("Error fetching data counts:", error);
      toast.error("Failed to fetch data counts");
    } finally {
      setIsLoadingCounts(false);
    }
  };

  const toggleCategory = (categoryId: string) => {
    setSelectedCategories(prev =>
      prev.includes(categoryId)
        ? prev.filter(id => id !== categoryId)
        : [...prev, categoryId]
    );
  };

  const openConfirmDialog = () => {
    setConfirmStep("warning");
    setConfirmText("");
    setCountdown(5);
    setShowConfirmDialog(true);
  };

  const closeConfirmDialog = () => {
    setShowConfirmDialog(false);
    setConfirmStep("warning");
    setConfirmText("");
    setCountdown(5);
  };

  const proceedToNextStep = () => {
    if (confirmStep === "warning") {
      setConfirmStep("type_confirm");
    } else if (confirmStep === "type_confirm" && confirmText === "DELETE POS DATA") {
      setConfirmStep("final_countdown");
      startCountdown();
    }
  };

  const startCountdown = () => {
    let count = 5;
    setCountdown(count);
    
    const interval = setInterval(() => {
      count -= 1;
      setCountdown(count);
      
      if (count <= 0) {
        clearInterval(interval);
      }
    }, 1000);
  };

  const handleReset = async () => {
    if (!currentOrg) return;

    setIsLoading(true);
    closeConfirmDialog();

    try {
      // Call the edge function for atomic deletion
      const { data, error } = await supabase.functions.invoke("clear-pos-data", {
        body: {
          organization_id: currentOrg.id,
        business_id: currentBusiness.id,
          categories: selectedCategories,
        },
      });

      if (error) throw error;

      const deletedCount = data?.total_deleted || 0;

      toast.success(`Successfully cleared ${deletedCount} POS records from ${selectedCategories.length} categories`);
      setSelectedCategories([]);
      fetchDataCounts(); // Refresh counts
    } catch (error: any) {
      console.error("Error resetting POS data:", error);
      toast.error(normalizeError(error).message || "Failed to reset POS data. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const selectAll = () => {
    setSelectedCategories(categories.map(c => c.id));
  };

  const deselectAll = () => {
    setSelectedCategories([]);
  };

  const getTotalSelectedRecords = () => {
    return selectedCategories.reduce((total, catId) => {
      return total + (dataCounts[catId] || 0);
    }, 0);
  };

  // Don't render if user doesn't have permission
  if (!canAccessTool) {
    return null;
  }

  if (!currentOrg) return null;

  // Branch-isolation guard (Wave-A re-audit, Round 3):
  // This tool deletes pos_transactions org-wide. Running it while a branch
  // is selected is a "wipe other branches' data" landmine. Require the
  // user to drop into HQ-overseer context (no active branch) before the
  // tool will operate. Non-overseer admins can still see the card but it
  // is read-only with a banner explaining the next step.
  const branchScopeBlock = !!currentBranch?.id || !canOversee;

  return (
    <>
      <Card className="border-destructive/30">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <AlertOctagon className="h-5 w-5 text-destructive" />
            <CardTitle className="text-base text-destructive">POS Go-Live Reset</CardTitle>
          </div>
          <CardDescription className="flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            Clear test POS data before going live. Configuration (registers, discounts, settings) will be preserved.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {branchScopeBlock && (
            <Alert variant="destructive">
              <AlertOctagon className="h-4 w-4" />
              <AlertDescription>
                {currentBranch?.id
                  ? "POS reset is disabled inside a branch context. Switch to HQ (no branch) to operate this tool org-wide; per-branch resets are not supported because the underlying clear-pos-data edge function deletes by organization_id."
                  : "Your role cannot operate the POS reset tool. Owner or admin role is required."}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={fetchDataCounts}
              disabled={isLoadingCounts || branchScopeBlock}
            >
              {isLoadingCounts ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Database className="h-4 w-4 mr-2" />
              )}
              Load Record Counts
            </Button>
            <Button variant="ghost" size="sm" onClick={selectAll}>
              Select All
            </Button>
            <Button variant="ghost" size="sm" onClick={deselectAll}>
              Deselect All
            </Button>
          </div>

          <Separator />

          <div className="grid gap-3">
            {categories.map((category) => (
              <div
                key={category.id}
                className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                  selectedCategories.includes(category.id)
                    ? "border-destructive/50 bg-destructive/5"
                    : "border-border hover:border-border/80"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Checkbox
                    id={category.id}
                    checked={selectedCategories.includes(category.id)}
                    onCheckedChange={() => toggleCategory(category.id)}
                  />
                  <div className={category.color}>{category.icon}</div>
                  <div>
                    <Label
                      htmlFor={category.id}
                      className="font-medium cursor-pointer"
                    >
                      {category.label}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {category.description}
                    </p>
                  </div>
                </div>
                {dataCounts[category.id] !== undefined && (
                  <Badge variant="secondary" className="tabular-nums">
                    {dataCounts[category.id]} records
                  </Badge>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            <p className="font-medium mb-1">What will be preserved:</p>
            <ul className="list-disc list-inside space-y-0.5 text-xs">
              <li>POS Registers and their settings</li>
              <li>Discounts, payment methods, and pricing rules</li>
              <li>Floor plans, tables, and modifiers</li>
              <li>Cashier assignments and security settings</li>
              <li>Happy hour configurations</li>
            </ul>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span>This action cannot be undone</span>
            </div>
            <Button
              variant="destructive"
              onClick={openConfirmDialog}
              disabled={selectedCategories.length === 0 || isLoading || branchScopeBlock}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Clear POS Data ({selectedCategories.length})
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Multi-step confirmation dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              {confirmStep === "warning" && "Warning: POS Data Deletion"}
              {confirmStep === "type_confirm" && "Confirm POS Data Deletion"}
              {confirmStep === "final_countdown" && "Final Confirmation"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {confirmStep === "warning" && (
                  <>
                    <p>
                      You are about to permanently delete POS data from the following categories:
                    </p>
                    <ul className="list-disc list-inside space-y-1 text-foreground">
                      {categories
                        .filter(c => selectedCategories.includes(c.id))
                        .map(c => (
                          <li key={c.id}>
                            {c.label} {dataCounts[c.id] !== undefined && `(${dataCounts[c.id]} records)`}
                          </li>
                        ))}
                    </ul>
                    <p className="font-medium text-destructive">
                      Total: {getTotalSelectedRecords()} records will be deleted
                    </p>
                    <p className="text-sm">
                      This will clear all test transactions, shifts, and related data. Your POS configuration will be preserved.
                    </p>
                  </>
                )}

                {confirmStep === "type_confirm" && (
                  <>
                    <p className="font-medium text-destructive">
                      This action is irreversible!
                    </p>
                    <p>
                      To proceed, type <span className="font-mono font-bold bg-muted px-1.5 py-0.5 rounded">DELETE POS DATA</span> below:
                    </p>
                    <Input
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="DELETE POS DATA"
                      className="font-mono"
                      autoComplete="off"
                    />
                  </>
                )}

                {confirmStep === "final_countdown" && (
                  <>
                    <p className="text-center text-lg font-bold text-destructive">
                      Last chance to cancel!
                    </p>
                    <p className="text-center">
                      Deletion will begin in{" "}
                      <span className="text-2xl font-mono font-bold text-destructive">
                        {countdown}
                      </span>{" "}
                      seconds
                    </p>
                    <p className="text-center text-sm text-muted-foreground">
                      Click "Delete Now" to proceed immediately or "Cancel" to abort.
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={closeConfirmDialog}>
              Cancel
            </Button>
            
            {confirmStep === "warning" && (
              <Button variant="destructive" onClick={proceedToNextStep}>
                I Understand, Continue
              </Button>
            )}
            
            {confirmStep === "type_confirm" && (
              <Button 
                variant="destructive" 
                onClick={proceedToNextStep}
                disabled={confirmText !== "DELETE POS DATA"}
              >
                Confirm Deletion
              </Button>
            )}
            
            {confirmStep === "final_countdown" && (
              <Button 
                variant="destructive" 
                onClick={handleReset}
                disabled={countdown > 0}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Delete Now
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

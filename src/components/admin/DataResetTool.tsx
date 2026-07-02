// @ts-nocheck - Admin tables not in auto-generated types
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
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { 
  Trash2, 
  AlertTriangle, 
  FileText, 
  CreditCard, 
  Receipt, 
  DollarSign,
  Loader2,
  ShieldAlert,
  RotateCcw,
  Database
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface DataCategory {
  id: string;
  label: string;
  description: string;
  tables: string[];
  icon: React.ReactNode;
  count?: number;
  color: string;
}

export function DataResetTool() {
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [dataCounts, setDataCounts] = useState<Record<string, number>>({});
  const [isLoadingCounts, setIsLoadingCounts] = useState(false);

  const categories: DataCategory[] = [
    {
      id: "payments",
      label: "Payments (Cash Inflows)",
      description: "Customer payments recorded against invoices",
      tables: ["payments"],
      icon: <DollarSign className="h-4 w-4" />,
      color: "text-green-500",
    },
    {
      id: "expenses",
      label: "Expenses",
      description: "Recorded expenses and their approvals",
      tables: ["expenses"],
      icon: <Receipt className="h-4 w-4" />,
      color: "text-red-500",
    },
    {
      id: "bill_payments",
      label: "Bill Payments (Cash Outflows)",
      description: "Payments made against vendor bills",
      tables: ["bill_payments"],
      icon: <CreditCard className="h-4 w-4" />,
      color: "text-orange-500",
    },
    {
      id: "invoices",
      label: "Invoices & Invoice Items",
      description: "All customer invoices and line items",
      tables: ["invoice_items", "invoices"],
      icon: <FileText className="h-4 w-4" />,
      color: "text-blue-500",
    },
    {
      id: "bills",
      label: "Bills & Bill Items",
      description: "All vendor bills and line items",
      tables: ["bill_items", "bills"],
      icon: <FileText className="h-4 w-4" />,
      color: "text-purple-500",
    },
    {
      id: "journal_entries",
      label: "Journal Entries",
      description: "All journal entries and their lines (GL data)",
      tables: ["journal_entry_lines", "journal_entries"],
      icon: <Database className="h-4 w-4" />,
      color: "text-indigo-500",
    },
    {
      id: "bank_transactions",
      label: "Bank Transactions",
      description: "Imported and recorded bank transactions",
      tables: ["bank_transactions"],
      icon: <CreditCard className="h-4 w-4" />,
      color: "text-cyan-500",
    },
  ];

  const fetchDataCounts = async () => {
    setIsLoadingCounts(true);
    try {
      const counts: Record<string, number> = {};
      
      const [
        { count: paymentsCount },
        { count: expensesCount },
        { count: billPaymentsCount },
        { count: invoicesCount },
        { count: billsCount },
        { count: journalEntriesCount },
        { count: bankTransactionsCount },
      ] = await Promise.all([
        (supabase.from as any)("payments").select("*", { count: "exact", head: true }),
        (supabase.from as any)("expenses").select("*", { count: "exact", head: true }),
        (supabase.from as any)("bill_payments").select("*", { count: "exact", head: true }),
        (supabase.from as any)("invoices").select("*", { count: "exact", head: true }),
        (supabase.from as any)("bills").select("*", { count: "exact", head: true }),
        (supabase.from as any)("journal_entries").select("*", { count: "exact", head: true }),
        (supabase.from as any)("bank_transactions").select("*", { count: "exact", head: true }),
      ]);

      counts["payments"] = paymentsCount || 0;
      counts["expenses"] = expensesCount || 0;
      counts["bill_payments"] = billPaymentsCount || 0;
      counts["invoices"] = invoicesCount || 0;
      counts["bills"] = billsCount || 0;
      counts["journal_entries"] = journalEntriesCount || 0;
      counts["bank_transactions"] = bankTransactionsCount || 0;

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

  const handleReset = async () => {
    if (confirmText !== "RESET DATA") {
      toast.error("Please type 'RESET DATA' to confirm");
      return;
    }

    setIsLoading(true);
    setShowConfirmDialog(false);

    try {
      const selectedTables = categories
        .filter(cat => selectedCategories.includes(cat.id))
        .flatMap(cat => cat.tables);

      // Delete in correct order to handle foreign key constraints
      for (const table of selectedTables) {
        const { error } = await supabase
          .from(table as any)
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000"); // Delete all rows

        if (error) {
          console.error(`Error deleting from ${table}:`, error);
          toast.error(`Failed to delete ${table}: ${normalizeError(error).message}`);
        }
      }

      toast.success(`Successfully reset ${selectedCategories.length} data categories`);
      setSelectedCategories([]);
      setConfirmText("");
      fetchDataCounts(); // Refresh counts
    } catch (error: any) {
      console.error("Error resetting data:", error);
      toast.error(normalizeError(error).message || "Failed to reset data");
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

  return (
    <>
      <Card className="border-destructive/30">
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <RotateCcw className="h-4 w-4 sm:h-5 sm:w-5 text-destructive" />
            Data Reset Tool
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Clear transactional data to start fresh. Master data (accounts, contacts, products) will be preserved.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 sm:space-y-4 p-4 sm:p-6 pt-0 sm:pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={fetchDataCounts}
              disabled={isLoadingCounts}
              className="text-xs sm:text-sm"
            >
              {isLoadingCounts ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Database className="h-3.5 w-3.5 mr-1.5" />
              )}
              Load Counts
            </Button>
            <Button variant="ghost" size="sm" onClick={selectAll} className="text-xs sm:text-sm">
              Select All
            </Button>
            <Button variant="ghost" size="sm" onClick={deselectAll} className="text-xs sm:text-sm">
              Deselect All
            </Button>
          </div>

          <Separator />

          <div className="grid gap-2 sm:gap-3">
            {categories.map((category) => (
              <div
                key={category.id}
                className={`flex items-center justify-between gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-lg border transition-colors ${
                  selectedCategories.includes(category.id)
                    ? "border-destructive/50 bg-destructive/5"
                    : "border-border hover:border-border/80"
                }`}
              >
                <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                  <Checkbox
                    id={category.id}
                    checked={selectedCategories.includes(category.id)}
                    onCheckedChange={() => toggleCategory(category.id)}
                    className="shrink-0"
                  />
                  <div className={`${category.color} shrink-0`}>{category.icon}</div>
                  <div className="min-w-0">
                    <Label
                      htmlFor={category.id}
                      className="text-xs sm:text-sm font-medium cursor-pointer truncate block"
                    >
                      {category.label}
                    </Label>
                    <p className="text-[10px] sm:text-xs text-muted-foreground truncate">
                      {category.description}
                    </p>
                  </div>
                </div>
                {dataCounts[category.id] !== undefined && (
                  <Badge variant="secondary" className="tabular-nums text-[10px] sm:text-xs shrink-0">
                    {dataCounts[category.id]}
                  </Badge>
                )}
              </div>
            ))}
          </div>

          <Separator />

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-3">
            <div className="flex items-center gap-1.5 sm:gap-2 text-[11px] sm:text-sm text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-amber-500 shrink-0" />
              <span>This action cannot be undone</span>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowConfirmDialog(true)}
              disabled={selectedCategories.length === 0 || isLoading}
              className="w-full sm:w-auto text-xs sm:text-sm"
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              )}
              Reset Selected ({selectedCategories.length})
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              Confirm Data Reset
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                You are about to permanently delete data from the following categories:
              </p>
              <ul className="list-disc list-inside space-y-1">
                {categories
                  .filter(c => selectedCategories.includes(c.id))
                  .map(c => (
                    <li key={c.id} className="text-foreground">
                      {c.label}
                    </li>
                  ))}
              </ul>
              <p className="font-medium text-destructive">
                This action cannot be undone!
              </p>
              <div className="pt-2">
                <Label htmlFor="confirm-reset">
                  Type <span className="font-mono font-bold">RESET DATA</span> to confirm:
                </Label>
                <Input
                  id="confirm-reset"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="RESET DATA"
                  className="mt-2"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmText("")}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReset}
              disabled={confirmText !== "RESET DATA"}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Reset Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

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
import {
  Trash2,
  
  FileText,
  CreditCard,
  Receipt,
  DollarSign,
  Loader2,
  ShieldAlert,
  RotateCcw,
  Database,
  AlertOctagon,
  Eye,
  Boxes,
  Building2,
  Landmark,
  Banknote,
  ShoppingCart,
  Package,
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

/**
 * Each "category" maps to a module-level reset_module__<x> RPC. Selecting the
 * right combination is the user's responsibility — but the per-category mode
 * is now transactional (reset_categories RPC), so any FK violation rolls back
 * the WHOLE selection cleanly instead of leaving the org half-wiped.
 *
 * For full reset, use "Wipe All Transactional Data" — it runs every module in
 * the correct order with a coverage guard.
 */
interface DataCategory {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  /** Tables shown in the preview/counts panel for this module */
  previewTables: string[];
}

type ConfirmationStep = "warning" | "type_confirm" | "final_countdown";
type ResetMode = "categories" | "wipe_all";

const CATEGORIES: DataCategory[] = [
  {
    id: "sales",
    label: "Sales (AR)",
    description:
      "Invoices, credit notes, sales returns, delivery notes, sales orders, proforma, estimates, recurring invoices, and customer payments.",
    icon: <ShoppingCart className="h-4 w-4" />,
    color: "text-blue-500",
    previewTables: [
      "invoices",
      "credit_notes",
      "sales_returns",
      "delivery_notes",
      "sales_orders",
      "proforma_invoices",
      "estimates",
      "recurring_invoices",
      "payments",
    ],
  },
  {
    id: "purchases",
    label: "Purchases (AP)",
    description:
      "Vendor bills, bill payments, purchase orders, and recorded expenses.",
    icon: <Building2 className="h-4 w-4" />,
    color: "text-purple-500",
    previewTables: ["bills", "bill_payments", "purchase_orders", "expenses"],
  },
  {
    id: "vendor_returns",
    label: "Vendor Credit Notes & Purchase Returns",
    description: "Vendor credit notes, applications, and purchase returns.",
    icon: <FileText className="h-4 w-4" />,
    color: "text-fuchsia-500",
    previewTables: ["vendor_credit_notes", "purchase_returns"],
  },
  {
    id: "finance",
    label: "Finance (Journal Entries)",
    description:
      "Journal entries and lines. Run AFTER Sales/Purchases/Banking — JEs are referenced by them.",
    icon: <Landmark className="h-4 w-4" />,
    color: "text-indigo-500",
    previewTables: ["journal_entries"],
  },
  {
    id: "banking",
    label: "Banking",
    description:
      "Bank transactions, statements, reconciliation sessions and items.",
    icon: <Banknote className="h-4 w-4" />,
    color: "text-cyan-500",
    previewTables: [
      "bank_transactions",
      "bank_statements",
      "bank_reconciliation_sessions",
    ],
  },
  {
    id: "transactions_ledger",
    label: "Universal Transactions Ledger",
    description:
      "The unified `transactions` projection. MUST be wiped before Sales/Purchases — it references invoices/payments/expenses.",
    icon: <Database className="h-4 w-4" />,
    color: "text-slate-500",
    previewTables: ["transactions"],
  },
  {
    id: "pos",
    label: "POS",
    description:
      "POS transactions, items, payments, modifiers, kitchen orders, split bills, held, gift cards, shifts, sessions, daily summaries.",
    icon: <Receipt className="h-4 w-4" />,
    color: "text-orange-500",
    previewTables: [
      "pos_transactions",
      "pos_shifts",
      "pos_held_transactions",
      "pos_table_sessions",
      "pos_split_bills",
      "pos_gift_card_transactions",
    ],
  },
  {
    id: "inventory",
    label: "Inventory Movements",
    description:
      "Stock movements, adjustments, goods receipts, backorders, replenishment logs. Products themselves are preserved.",
    icon: <Package className="h-4 w-4" />,
    color: "text-teal-500",
    previewTables: [
      "stock_movements",
      "stock_adjustments",
      "goods_receipts",
      "backorders",
    ],
  },
  {
    id: "fixed_assets",
    label: "Fixed-Asset Depreciation Postings",
    description:
      "Depreciation entries (postings). Fixed assets master and depreciation schedules are preserved.",
    icon: <Boxes className="h-4 w-4" />,
    color: "text-amber-500",
    previewTables: ["depreciation_entries"],
  },
  {
    id: "ancillaries",
    label: "Ancillaries",
    description:
      "Customer statements, eTIMS logs, payment requests, approval requests for wiped doc types.",
    icon: <FileText className="h-4 w-4" />,
    color: "text-rose-500",
    previewTables: [
      "customer_statements",
      "etims_transmission_logs",
      "payment_requests",
    ],
  },
  {
    id: "payroll",
    label: "Payroll",
    description:
      "Payroll runs, payslips, periods, remittances, statutory liabilities, payment batches, tax certificates, work entries. Salary structures and rules are preserved as master data.",
    icon: <DollarSign className="h-4 w-4" />,
    color: "text-emerald-500",
    previewTables: [
      "payroll_runs",
      "payslips",
      "payroll_periods",
      "payroll_remittances",
      "payroll_payment_batches",
      "payroll_tax_certificates",
      "payroll_work_entries",
    ],
  },
  {
    id: "hr",
    label: "HR (Attendance, Leave, Timesheets)",
    description:
      "Attendance, leave requests, timesheets, employee onboarding, loans, documents, benefits, compensation-component history. Employees, current contracts, and configs are preserved.",
    icon: <FileText className="h-4 w-4" />,
    color: "text-pink-500",
    previewTables: [
      "timesheets",
      "attendance",
      "leave_requests",
      "leave_allocations",
      "employee_onboarding",
      "employee_loans",
      "employee_documents",
    ],
  },
  {
    id: "sequences",
    label: "Numbering Sequences",
    description:
      "Reset invoice and journal-entry numbering so post-reset documents start fresh.",
    icon: <RotateCcw className="h-4 w-4" />,
    color: "text-green-500",
    previewTables: [],
  },
];




export function OrgDataResetTool() {
  const { currentOrg } = useOrganization();
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [confirmStep, setConfirmStep] = useState<ConfirmationStep>("warning");
  const [confirmText, setConfirmText] = useState("");
  const [countdown, setCountdown] = useState(5);
  /** preview counts keyed by RAW table name (returned by preview_organization_reset) */
  const [previewCounts, setPreviewCounts] = useState<Record<string, number>>({});
  const [previewTotal, setPreviewTotal] = useState<number | null>(null);
  const [resetMode, setResetMode] = useState<ResetMode>("categories");
  /**
   * Wave 2 — registry-driven labels/descriptions from `governance_modules`.
   * Falls back to the hardcoded CATEGORIES list when the RPC is unavailable
   * (offline, older DB, RLS issue) so the reset tool always renders. Icons
   * and colors stay in the hardcoded list — the registry intentionally
   * stores no UI tokens.
   */
  const [registryOverrides, setRegistryOverrides] = useState<
    Record<string, { label?: string; description?: string }>
  >({});

  // Load registry once on mount. Typed as any because the RPC was added in a
  // Wave 2 migration and may not be in the generated supabase types yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = supabase as any;
  useState(() => {
    sbAny
      .rpc("governance_list_modules")
      .then(({ data, error }: { data: any[] | null; error: any }) => {
        if (error || !data) return;
        const overrides: Record<string, { label?: string; description?: string }> = {};
        for (const m of data) {
          if (m?.module_key) {
            overrides[m.module_key] = {
              label: m.display_name ?? undefined,
              description: m.description ?? undefined,
            };
          }
        }
        setRegistryOverrides(overrides);
      })
      .catch(() => {
        /* swallow — fall back to hardcoded CATEGORIES */
      });
  });

  const displayCategories: DataCategory[] = CATEGORIES.map((c) => {
    const o = registryOverrides[c.id];
    return o
      ? { ...c, label: o.label ?? c.label, description: o.description ?? c.description }
      : c;
  });

  const fetchPreview = async () => {
    if (!currentOrg) return;
    setIsPreviewLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("clear-org-data", {
        body: { organization_id: currentOrg.id, mode: "preview" },
      });
      if (error) throw error;
      if (data?.success === false) throw new Error(data?.error || "Preview failed");
      setPreviewCounts((data?.preview ?? {}) as Record<string, number>);
      setPreviewTotal(data?.total ?? 0);
      toast.success(`Preview loaded — ${data?.total ?? 0} rows would be wiped`);
    } catch (e: any) {
      console.error(e);
      toast.error(normalizeError(e).message || "Failed to load preview");
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const toggleCategory = (id: string) =>
    setSelectedCategories((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const openConfirmDialog = (mode: ResetMode = "categories") => {
    setResetMode(mode);
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

  const expectedConfirmText =
    resetMode === "wipe_all" ? `RESET ${currentOrg?.name ?? ""}`.trim() : "DELETE ALL DATA";

  const proceedToNextStep = () => {
    if (confirmStep === "warning") {
      setConfirmStep("type_confirm");
    } else if (confirmStep === "type_confirm" && confirmText === expectedConfirmText) {
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
      if (count <= 0) clearInterval(interval);
    }, 1000);
  };

  const handleReset = async () => {
    if (!currentOrg) return;
    setIsLoading(true);
    closeConfirmDialog();
    try {
      const body =
        resetMode === "wipe_all"
          ? {
              organization_id: currentOrg.id,
              mode: "wipe_all",
              confirmation_token: `RESET-${currentOrg.id}`,
            }
          : {
              organization_id: currentOrg.id,
              mode: "categories",
              categories: selectedCategories,
            };

      const { data, error } = await supabase.functions.invoke("clear-org-data", { body });

      // The edge function now always returns HTTP 200 with {ok, success, error, code, hint, stage, details}.
      // `error` from invoke() should only fire on transport-level failure now.
      if (error) {
        console.error("[OrgDataResetTool] transport error:", error);
        throw error;
      }
      if (data?.ok === false || data?.success === false) {
        const detail = [
          data?.stage ? `[${data.stage}]` : null,
          data?.error,
          data?.code ? `(code: ${data.code})` : null,
          data?.hint ? `\nHint: ${data.hint}` : null,
          data?.details ? `\nDetails: ${data.details}` : null,
        ]
          .filter(Boolean)
          .join(" ");
        console.error("[OrgDataResetTool] server-reported failure:", data);
        throw new Error(detail || "Reset failed");
      }

      if (resetMode === "wipe_all") {
        const total = data?.result?.totalDeleted ?? 0;
        const storage = data?.storage ?? {};
        const fileCount =
          (storage?.receipts?.removed ?? 0) +
          (storage?.["document-pdfs"]?.removed ?? 0);
        toast.success(
          `Wiped ${total} records and ${fileCount} files. Master data preserved.`,
        );
      } else {
        toast.success(
          `Cleared ${selectedCategories.length} module categories successfully.`,
        );
      }
      setSelectedCategories([]);
      fetchPreview();
    } catch (error: any) {
      console.error("Error resetting data:", error);
      toast.error(normalizeError(error).message || "Failed to reset data. Please try again.", {
        duration: 12000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const selectAll = () => setSelectedCategories(displayCategories.map((c) => c.id));
  const deselectAll = () => setSelectedCategories([]);

  const countForCategory = (cat: DataCategory) =>
    cat.previewTables.reduce((acc, t) => acc + (previewCounts[t] ?? 0), 0);

  if (!currentOrg) return null;

  return (
    <>
      <Card className="border-destructive/30 mt-6">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <AlertOctagon className="h-5 w-5 text-destructive" />
            <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
          </div>
          <CardDescription>
            Wipe transactional data while preserving master data (chart of accounts,
            contacts, products, settings, users, subscription, branding).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={fetchPreview}
              disabled={isPreviewLoading}
            >
              {isPreviewLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Eye className="h-4 w-4 mr-2" />
              )}
              Preview What Will Be Wiped
            </Button>
            <Button variant="ghost" size="sm" onClick={selectAll}>
              Select All
            </Button>
            <Button variant="ghost" size="sm" onClick={deselectAll}>
              Deselect All
            </Button>
            {previewTotal !== null && (
              <Badge variant="secondary" className="ml-auto tabular-nums">
                Total: {previewTotal} rows
              </Badge>
            )}
          </div>

          <Separator />

          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Impact preview by module.</strong>{" "}
            Tick modules to see how many rows the wipe will remove from each
            domain. Selection is preview-only — the actual wipe always runs
            across every transactional domain in dependency order
            (HR → Payroll → Sales/Purchases → Banking → Finance → Sequences).
          </div>

          <div className="grid gap-3">
            {displayCategories.map((category) => {
              const count = countForCategory(category);
              const isSelected = selectedCategories.includes(category.id);
              return (
                <div
                  key={category.id}
                  className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                    isSelected
                      ? "border-border bg-muted/40"
                      : "border-border hover:border-border/80"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={category.id}
                      checked={isSelected}
                      onCheckedChange={() => toggleCategory(category.id)}
                    />
                    <div className={category.color}>{category.icon}</div>
                    <div>
                      <Label htmlFor={category.id} className="font-medium cursor-pointer">
                        {category.label}
                      </Label>
                      <p className="text-xs text-muted-foreground max-w-xl">
                        {category.description}
                      </p>
                    </div>
                  </div>
                  {previewTotal !== null && category.previewTables.length > 0 && (
                    <Badge variant="secondary" className="tabular-nums">
                      {count} rows
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>

          <Separator />


          <div className="rounded-lg border-2 border-destructive/40 bg-destructive/5 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertOctagon className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-semibold text-destructive">
                  Go Live — Wipe All Transactional Data
                </h4>
                <p className="text-sm text-muted-foreground mt-1">
                  Atomically wipes <strong>every transactional record</strong>:
                  Sales, Purchases, Finance, Banking, POS, Inventory movements,
                  fixed-asset depreciation postings, vendor credit notes, purchase
                  returns, the universal transactions ledger, ancillaries — plus
                  numbering sequences and linked Storage files (expense receipts,
                  generated PDFs).
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  <strong>Preserved:</strong> chart of accounts, contacts, products,
                  tax codes, payment terms, organization settings, branches, users
                  and roles, subscription, branding, fixed-asset master and
                  depreciation schedules.
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                variant="destructive"
                onClick={() => openConfirmDialog("wipe_all")}
                disabled={isLoading}
              >
                {isLoading && resetMode === "wipe_all" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4 mr-2" />
                )}
                Wipe All Transactional Data
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              {confirmStep === "warning" && "Warning: Data Deletion"}
              {confirmStep === "type_confirm" && "Confirm Data Deletion"}
              {confirmStep === "final_countdown" && "Final Confirmation"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {confirmStep === "warning" && (
                  <>
                    {resetMode === "wipe_all" ? (
                      <>
                        <p className="font-medium text-destructive">
                          You are about to wipe ALL transactional data for{" "}
                          <strong>{currentOrg?.name}</strong>.
                        </p>
                        <p>
                          Every invoice, credit note, sales return, delivery note,
                          sales order, proforma, estimate, recurring invoice, payment,
                          bill, expense, journal entry, bank transaction, POS record,
                          inventory movement, depreciation posting, vendor credit
                          note and purchase return will be permanently deleted.
                          Linked files in Storage (expense receipts, generated PDFs)
                          will also be removed.
                        </p>
                        <p className="text-sm">
                          Master data (accounts, contacts, products, settings,
                          subscription) is preserved.
                        </p>
                      </>
                    ) : (
                      <>
                        <p>
                          You are about to permanently delete data from these modules:
                        </p>
                        <ul className="list-disc list-inside space-y-1 text-foreground">
                          {displayCategories.filter((c) =>
                            selectedCategories.includes(c.id),
                          ).map((c) => (
                            <li key={c.id}>
                              {c.label}
                              {previewTotal !== null && c.previewTables.length > 0 &&
                                ` (${countForCategory(c)} rows)`}
                            </li>
                          ))}
                        </ul>
                        <p className="text-sm">
                          The whole batch is transactional — if any FK violation
                          occurs, NOTHING is deleted.
                        </p>
                      </>
                    )}
                  </>
                )}

                {confirmStep === "type_confirm" && (
                  <>
                    <p className="font-medium text-destructive">
                      This action is irreversible!
                    </p>
                    <p>
                      To proceed, type{" "}
                      <span className="font-mono font-bold bg-muted px-1.5 py-0.5 rounded">
                        {expectedConfirmText}
                      </span>{" "}
                      below:
                    </p>
                    <Input
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder={expectedConfirmText}
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
                disabled={confirmText !== expectedConfirmText}
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

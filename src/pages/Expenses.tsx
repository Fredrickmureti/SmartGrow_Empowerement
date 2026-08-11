import { useState, useMemo, useRef, useEffect } from "react";
import { downloadCsv } from "@/lib/exports/csv";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { EXPENSE_IMPORT_FIELDS } from "@/lib/importConfigs/expenseImportConfig";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useExpensesPaginated, Expense, ExpenseCategory } from "@/hooks/useExpensesPaginated";
import { useContacts } from "@/hooks/useContacts";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { useViewMode } from "@/hooks/useViewMode";
import { useListViewColumns, DefaultColumn } from "@/hooks/useListViewColumns";
import { useCoreFieldDisplay } from "@/hooks/useCoreFieldDisplay";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Search,
  Receipt,
  MoreHorizontal,
  Loader2,
  Pencil,
  Trash2,
  TrendingDown,
  Calendar,
  Coins,
  Download,
  Upload,
  X,
  FileText,
  AlertTriangle,
  Info,
  Eye,
  Ban,
  Wallet,
  Send,
  Check,
} from "lucide-react";
import { ImportWizard } from "@/components/common/ImportWizard";
import { FieldDefinition } from "@/lib/importUtils";
import { ContactResolver } from "@/lib/entityResolver";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { ReceiptUpload } from "@/components/expenses/ReceiptUpload";
import { CurrencySelect } from "@/components/common/CurrencySelect";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAccounts } from "@/hooks/useAccounts";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ExpensePeekSheet } from "@/features/purchases/expenses/ExpensePeekSheet";
import { usePeekParam } from "@/design-system";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { normalizeError } from "@/services/resilience";
import {
  isEmployeeReimbursable,
  isExpenseDeletable,
  isExpenseEditable,
} from "@/lib/finance/expenseCommands";
import { ExpenseReimburseDialog } from "@/features/purchases/expenses/ExpenseReimburseDialog";
interface PaymentAccount {
  id: string;
  name: string;
  code: string;
  account_type: string;
}

export default function Expenses() {
  // View mode state
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "expense" });
  
  // Core field display overrides from Studio
  const coreFieldDisplay = useCoreFieldDisplay("expense");

  // Default list columns - can be overridden by saved list views in Studio
  const defaultExpenseColumns: DefaultColumn[] = coreFieldDisplay.applyToColumns([
    { field: "date", label: "Date", visible: true },
    { field: "description", label: "Description", visible: true },
    { field: "category", label: "Category", visible: true },
    { field: "supplier", label: "Supplier", visible: true },
    { field: "status", label: "Status", visible: true },
    { field: "amount", label: "Amount", visible: true },
  ]);
  const { visibleColumns } = useListViewColumns("expense", defaultExpenseColumns);

  // Custom field filtering
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters, filterEntityIds, isFiltering: isCustomFiltering } = useCustomFieldFiltering("expense");

  // Search and filter state
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Debounced search
  const debouncedSearch = useDebouncedCallback((value: string) => {
    setSearch(value);
  }, 300);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
    debouncedSearch(e.target.value);
  };

  const {
    expenses,
    categories,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    createExpense,
    updateExpense,
    submitExpense,
    approveExpense,
    rejectExpense,
    deleteExpense,
    voidExpense,
    createCategory,
    updateCategory,
    deleteCategory,
    createLinkedBill,
    isAPAccount,
    queuePayrollReimbursement,
    unqueuePayrollReimbursement,
    reimburseDirect,
  } = useExpensesPaginated({
    statusFilter: statusFilter !== "all" ? statusFilter : undefined,
    search: search || undefined,
  });

  const { contacts } = useContacts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { canManagePurchases } = usePermissions();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const { userRole, currentOrg } = useOrganization();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [peekId, setPeekId] = usePeekParam();
  const [reimburseExpense, setReimburseExpense] = useState<Expense | null>(null);

  // Handle deep-link URL params
  useEffect(() => {
    let cancelled = false;

    const consumeParams = (keys: string[]) => {
      const next = new URLSearchParams(searchParams);
      let changed = false;

      keys.forEach((key) => {
        if (next.has(key)) {
          next.delete(key);
          changed = true;
        }
      });

      if (changed) {
        setSearchParams(next, { replace: true });
      }
    };

    const openExpenseRecord = (expenseId: string) => {
      setPeekId(expenseId);
      return true;
    };

    const handleDeepLinks = async () => {
      if (searchParams.get("action") === "create") {
        // `?action=create` now redirects to the dedicated
        // `/purchases/expenses/new` route. Forward the vendor / project
        // prefill query params so the create page can hydrate its form.
        const prefillContactId = searchParams.get("contact_id");
        const prefillProjectId = searchParams.get("project_id");
        const params = new URLSearchParams();
        if (prefillContactId) params.set("contact_id", prefillContactId);
        if (prefillProjectId) params.set("project_id", prefillProjectId);
        const qs = params.toString();
        navigate(qs ? `/purchases/expenses/new?${qs}` : "/purchases/expenses/new", {
          replace: true,
        });
        return;
      }

      const expenseId = searchParams.get("id");
      if (!expenseId) return;

      setPeekId(expenseId);
      consumeParams(["id"]);
    };

    void handleDeepLinks();

    return () => {
      cancelled = true;
    };
  }, [searchParams, setSearchParams, setPeekId, navigate]);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ExpenseCategory | null>(null);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Bulk selection state
  const [selectedExpenses, setSelectedExpenses] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [linkedBills, setLinkedBills] = useState<Record<string, { id: string; status: string; bill_number: string }>>({});
  const vendorResolverRef = useRef<ContactResolver | null>(null);
  const [previewContactId, setPreviewContactId] = useState<string | null>(null);

  const expenseFieldDefinitions = EXPENSE_IMPORT_FIELDS;

  const handleImportExpense = async (row: Record<string, any>) => {
    // Resolve category by name
    let categoryId = "";
    if (row.category_name) {
      const found = categories.find((c) => c.name.toLowerCase() === row.category_name.toLowerCase());
      if (found) {
        categoryId = found.id;
      } else {
        // Auto-create category
        const newCat = await createCategory({ name: row.category_name, description: "", color: "#6366f1", is_active: true, account_id: null, business_id: null });
        categoryId = newCat.id;
      }
    }

    // Resolve vendor by name (auto-create if not found)
    let vendorId = "";
    if (row.vendor_name) {
      if (!vendorResolverRef.current && currentOrg && currentBusiness) {
        vendorResolverRef.current = new ContactResolver(
          currentOrg.id, currentBusiness.id, "supplier",
          contacts.filter((c) => c.type === "supplier" || c.type === "both")
        );
      }
      if (vendorResolverRef.current) {
        const resolved = await vendorResolverRef.current.resolve(row.vendor_name);
        vendorId = resolved.id;
      }
    }

    await createExpense({
      expense_date: row.expense_date,
      description: row.description,
      amount: Number(row.amount),
      tax_amount: row.tax_amount ? Number(row.tax_amount) : 0,
      category_id: categoryId || null,
      vendor_id: vendorId || null,
      reference: row.reference || "",
      is_billable: false,
      receipt_url: null,
      currency: baseCurrency,
      account_id: null,
      payment_account_id: null,
      payment_method: row.payment_method || "cash",
    });
  };

  // Check if user is admin
  const isAdmin = userRole?.role === "admin" || userRole?.role === "owner" || userRole?.role === "super_admin";

  const [formData, setFormData] = useState({
    expense_date: format(new Date(), "yyyy-MM-dd"),
    amount: 0,
    tax_amount: 0,
    description: "",
    reference: "",
    category_id: "",
    vendor_id: "",
    is_billable: false,
    receipt_url: "" as string | null,
    currency: "",
    payment_method: "cash",
    payment_account_id: "",
    project_id: null as string | null,
  });

  // Fetch payment-eligible accounts from COA
  const { currentBusiness } = useBusinesses();
  const [paymentAccounts, setPaymentAccounts] = useState<PaymentAccount[]>([]);

  useEffect(() => {
    const fetchPaymentAccounts = async () => {
      if (!currentOrg) return;

      let query = supabase
        .from("accounts")
        .select("id, name, code, account_type")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .in("account_type", ["asset", "liability"])
        .order("code");

      if (currentBusiness?.id) {
        query = query.or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
      }

      const { data } = await query;
      if (data) {
        // Filter to payment-capable accounts by name heuristic
        const paymentCapable = (data as PaymentAccount[]).filter((a) => {
          const n = a.name.toLowerCase();
          return (
            n.includes("cash") ||
            n.includes("bank") ||
            n.includes("petty") ||
            n.includes("mobile") ||
            n.includes("m-pesa") ||
            n.includes("mpesa") ||
            n.includes("credit card") ||
            n.includes("card") ||
            n.includes("payable") ||
            n.includes("wallet") ||
            n.includes("reimbursement")
          );
        });
        setPaymentAccounts(paymentCapable.length > 0 ? paymentCapable : (data as PaymentAccount[]));
      }
    };

    fetchPaymentAccounts();
  }, [currentOrg?.id, currentBusiness?.id]);

  const [categoryForm, setCategoryForm] = useState({
    name: "",
    description: "",
    color: "#6366f1",
    account_id: "",
  });

  const vendors = contacts.filter((c) => c.type === "supplier" || c.type === "both");
  const { accounts: allAccounts } = useAccounts();

  // Fetch linked bills for AP expenses to show bill status indicators
  useEffect(() => {
    const fetchLinkedBills = async () => {
      if (!currentOrg || !expenses.length) return;
      const apExpenseIds = expenses
        .filter(e => e.payment_account_id && defaultAccounts.accounts_payable_id && e.payment_account_id === defaultAccounts.accounts_payable_id)
        .map(e => e.id);
      if (apExpenseIds.length === 0) { setLinkedBills({}); return; }
      const { data } = await supabase
        .from("bills")
        .select("id, status, bill_number, source_expense_id")
        .in("source_expense_id", apExpenseIds);
      if (data) {
        const map: Record<string, { id: string; status: string; bill_number: string }> = {};
        data.forEach(b => { if (b.source_expense_id) map[b.source_expense_id] = { id: b.id, status: b.status, bill_number: b.bill_number }; });
        setLinkedBills(map);
      }
    };
    fetchLinkedBills();
  }, [expenses, currentOrg?.id, defaultAccounts.accounts_payable_id]);
  const expenseAccounts = useMemo(() => allAccounts.filter(a => a.account_type === "expense" && a.is_active), [allAccounts]);

  const resetForm = () => {
    setFormData({
      expense_date: format(new Date(), "yyyy-MM-dd"),
      amount: 0,
      tax_amount: 0,
      description: "",
      reference: "",
      category_id: "",
      vendor_id: "",
      is_billable: false,
      receipt_url: null,
      currency: baseCurrency,
      payment_method: "cash",
      payment_account_id: "",
      project_id: null,
    });
    setEditingExpense(null);
  };

  // Routes to the new dedicated create/edit pages. The inline
  // `<Dialog>` create/edit surface was retired as part of the ERP-wide
  // interaction standard — every record form is now a full page mounted
  // on `RecordFormShell`.
  const handleOpenDialog = (expense?: Expense) => {
    if (expense) {
      // Accounting lock: approved/paid expenses stay read-only in peek.
      if (!isExpenseEditable(expense.status)) {
        setPeekId(expense.id);
        return;
      }
      navigate(`/purchases/expenses/${expense.id}/edit`);
      return;
    }
    navigate("/purchases/expenses/new");
  };


  // Detect if selected payment account is AP
  const isAPSelected = !!(formData.payment_account_id && defaultAccounts.accounts_payable_id && formData.payment_account_id === defaultAccounts.accounts_payable_id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate: AP expenses require a vendor
    if (isAPSelected && !formData.vendor_id) {
      toast({
        title: "Vendor required",
        description: "When paying from Accounts Payable, you must select a supplier so a vendor bill can be created.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      // Auto-resolve account_id from category mapping
      const selectedCategory = formData.category_id ? categories.find(c => c.id === formData.category_id) : null;
      const expenseData = {
        expense_date: formData.expense_date,
        amount: formData.amount,
        tax_amount: formData.tax_amount,
        description: formData.description,
        reference: formData.reference || null,
        category_id: formData.category_id || null,
        vendor_id: formData.vendor_id || null,
        is_billable: formData.is_billable,
        currency: formData.currency || baseCurrency,
        receipt_url: formData.receipt_url || null,
        account_id: selectedCategory?.account_id || null,
        payment_method: formData.payment_method || "cash",
        payment_account_id: formData.payment_account_id || null,
        project_id: formData.project_id,
      };

      if (editingExpense) {
        await updateExpense(editingExpense.id, expenseData);
        toast({ title: "Expense updated successfully" });
      } else {
        const result = await createExpense(expenseData as any);
        if (result.gated) {
          toast({
            title: "Expense submitted for approval",
            description: "Your approval policy requires a reviewer before this expense is posted.",
          });
        } else {
          toast({ title: "Expense recorded and posted" });
        }
      }
      // Dialog surface retired — create/edit now live on
      // /purchases/expenses/{new,:id/edit}. Kept as no-op to satisfy
      // legacy submit handler until it's fully removed in a later sweep.
      resetForm();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenCategoryDialog = (category?: ExpenseCategory) => {
    if (category) {
      setEditingCategory(category);
      setCategoryForm({
        name: category.name,
        description: category.description || "",
        color: category.color,
        account_id: category.account_id || "",
      });
    } else {
      setEditingCategory(null);
      setCategoryForm({ name: "", description: "", color: "#6366f1", account_id: "" });
    }
    setShowCategoryDialog(true);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      if (editingCategory) {
        await updateCategory(editingCategory.id, {
          name: categoryForm.name,
          description: categoryForm.description || null,
          color: categoryForm.color,
          account_id: categoryForm.account_id || null,
        });
        toast({ title: "Category updated successfully" });
      } else {
        await createCategory({
          name: categoryForm.name,
          description: categoryForm.description || null,
          color: categoryForm.color,
          is_active: true,
          account_id: categoryForm.account_id || null,
          business_id: null,
        });
        toast({ title: "Category created successfully" });
      }
      setShowCategoryDialog(false);
      setEditingCategory(null);
      setCategoryForm({ name: "", description: "", color: "#6366f1", account_id: "" });
    } catch (error: any) {
      toast({
        title: editingCategory ? "Error updating category" : "Error creating category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteCategory = async (category: ExpenseCategory) => {
    try {
      await deleteCategory(category.id);
      toast({ title: "Category deactivated" });
    } catch (error: any) {
      toast({
        title: "Error deactivating category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const executeDeleteExpense = async (expense: Expense) => {
    try {
      await deleteExpense(expense.id);
      toast({ title: "Expense deleted" });
    } catch (error: any) {
      toast({
        title: "Error deleting expense",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const deleteConfirm = useConfirmDelete<Expense>({ onConfirm: executeDeleteExpense });

  const handleDelete = (expense: Expense) => {
    // Only pending expenses can be deleted
    if (!isExpenseDeletable(expense.status)) {
      toast({
        title: "Cannot delete",
        description: "Only unposted expenses can be deleted. Use 'Void' for approved or paid expenses.",
        variant: "destructive",
      });
      return;
    }
    deleteConfirm.requestDelete(expense);
  };

  const handleSubmitExpense = async (expense: Expense) => {
    try {
      const res = await submitExpense(expense.id);
      toast({
        title: res?.gated ? "Submitted for approval" : "Expense approved and posted",
        description: res?.gated
          ? "An authorized approver must review this expense before it reaches the ledger."
          : "No approval rule applied, so the expense posted immediately.",
      });
    } catch (error: any) {
      toast({ title: "Could not submit expense", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleApproveExpense = async (expense: Expense) => {
    try {
      await approveExpense(expense.id);
      toast({ title: "Expense approved", description: "The journal entry has been posted." });
    } catch (error: any) {
      toast({ title: "Could not approve expense", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleRejectExpense = async (expense: Expense) => {
    try {
      await rejectExpense(expense.id);
      toast({ title: "Expense rejected" });
    } catch (error: any) {
      toast({ title: "Could not reject expense", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleUnqueueReimbursement = async (expense: Expense) => {
    try {
      await unqueuePayrollReimbursement(expense.id);
      toast({
        title: "Removed from payroll queue",
        description: "This reimbursement will no longer be paid through payroll.",
      });
    } catch (error: any) {
      toast({
        title: "Could not update reimbursement",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const handleVoidExpense = async (expense: Expense) => {
    try {
      await voidExpense(expense.id);
      toast({ title: "Expense voided", description: "A reversing journal entry has been created." });
    } catch (error: any) {
      toast({
        title: "Error voiding expense",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  // Bulk selection handlers
  const toggleSelectAll = () => {
    if (selectedExpenses.size === expenses.length) {
      setSelectedExpenses(new Set());
    } else {
      setSelectedExpenses(new Set(expenses.map((e) => e.id)));
    }
  };

  const toggleSelectExpense = (id: string) => {
    const newSelected = new Set(selectedExpenses);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedExpenses(newSelected);
  };

  const handleBulkDelete = async () => {
    if (!isAdmin) return;
    setIsBulkDeleting(true);
    
    try {
      const allSelected = Array.from(selectedExpenses);
      
      // Separate pending (deletable) from posted (must void)
      const pendingIds = allSelected.filter(id => {
        const exp = expenses.find(e => e.id === id);
        return isExpenseDeletable(exp?.status);
      });
      const postedIds = allSelected.filter(id => {
        const exp = expenses.find(e => e.id === id);
        return exp && (exp.status === "approved" || exp.status === "paid");
      });

      // Void posted expenses
      let voidedCount = 0;
      for (const id of postedIds) {
        try {
          await voidExpense(id);
          voidedCount++;
        } catch (err) {
          console.error(`Failed to void expense ${id}:`, err);
        }
      }

      // Delete pending expenses
      let deletedCount = 0;
      if (pendingIds.length > 0) {
        const { error } = await supabase
          .from("expenses")
          .delete()
          .in("id", pendingIds);
        if (error) throw error;
        deletedCount = pendingIds.length;
      }

      const parts = [];
      if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
      if (voidedCount > 0) parts.push(`${voidedCount} voided`);
      
      toast({ title: `Expenses processed: ${parts.join(", ")}` });
      setSelectedExpenses(new Set());
      setShowBulkDeleteDialog(false);
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
    } catch (error: any) {
      toast({
        title: "Error processing expenses",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const handleExport = () => {
    const expensesToExport = selectedExpenses.size > 0
      ? expenses.filter((e) => selectedExpenses.has(e.id))
      : expenses;

    const csvContent = [
      ["Date", "Description", "Category", "Supplier", "Paid From Account", "Status", "Amount", "Tax", "Currency", "Reference", "Billable"].join(","),
      ...expensesToExport.map((e) =>
        [
          e.expense_date,
          `"${e.description.replace(/"/g, '""')}"`,
          e.category?.name || "",
          e.vendor?.name || "",
          e.payment_account ? `${e.payment_account.code} - ${e.payment_account.name}` : (e.payment_method || ""),
          e.status,
          e.amount,
          e.tax_amount,
          e.currency,
          e.reference || "",
          e.is_billable ? "Yes" : "No",
        ].join(",")
      ),
    ].join("\r\n");

    downloadCsv(`expenses_${format(new Date(), "yyyy-MM-dd")}.csv`, csvContent);

    toast({ title: `Exported ${expensesToExport.length} expenses` });
  };

  // Format currency helper that respects expense currency
  const formatExpenseCurrency = (amount: number, currency?: string) => {
    return formatCurrency(amount, currency || baseCurrency);
  };

  const getStatusBadge = (status: Expense["status"]) => {
    const styles: Record<string, string> = {
      draft: "bg-muted text-muted-foreground",
      submitted: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
      pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
      approved: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      rejected: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
      paid: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      voided: "bg-muted text-muted-foreground line-through",
    };
    const labels: Record<string, string> = {
      draft: "Draft",
      submitted: "Awaiting approval",
      approved: "Approved",
      paid: "Paid",
      pending: "Pending",
      rejected: "Rejected",
      voided: "Voided",
    };
    return <Badge className={styles[status]}>{labels[status] || status}</Badge>;
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Expenses</h1>
            <p className="text-sm sm:text-base text-muted-foreground">Track and manage expenses</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="expense" />
            <StudioQuickPanelTrigger entityType="expense" />
            <RefreshButton
              queryKeyPrefixes={[['expenses'] as const]}
              tooltip="Refresh expenses"
            />
            <ViewSwitcher
              entityType="expense"
              currentView={currentView}
              onViewChange={setView}
            />
            {canManagePurchases && (
              <>
                <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                  <Upload className="mr-2 h-4 w-4" />
                  Import
                </Button>
                <Button variant="outline" onClick={() => handleOpenCategoryDialog()} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Category
                </Button>
                <Button onClick={() => handleOpenDialog()} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" />
                  Record Expense
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search expenses..."
              value={searchInput}
              onChange={handleSearchChange}
              className="pl-10 w-full"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="voided">Voided</SelectItem>
            </SelectContent>
          </Select>
          {isAdmin && (
            <>
              <Button variant="outline" onClick={handleExport}>
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
              <ReportExportButtons
                compact
                formats={["excel", "csv", "print", "pdf"]}
                getExportConfig={() => {
                  const expData = selectedExpenses.size > 0
                    ? expenses.filter((e) => selectedExpenses.has(e.id))
                    : expenses;
                  const cols: ExportColumn[] = [
                    { key: "date", header: "Date", width: 12 },
                    { key: "description", header: "Description", width: 30 },
                    { key: "category", header: "Category", width: 15 },
                    { key: "vendor", header: "Supplier", width: 20 },
                    { key: "status", header: "Status", width: 10 },
                    { key: "amount", header: "Amount", format: "currency", width: 14, align: "right" },
                    { key: "tax", header: "Tax", format: "currency", width: 12, align: "right" },
                    { key: "reference", header: "Reference", width: 15 },
                  ];
                  const rows = expData.map((e) => ({
                    date: e.expense_date,
                    description: e.description,
                    category: categories.find(c => c.id === e.category_id)?.name || "",
                    vendor: contacts.find(c => c.id === e.vendor_id)?.name || "",
                    status: e.status,
                    amount: e.amount,
                    tax: e.tax_amount || 0,
                    reference: e.reference || "",
                  }));
                  return {
                    title: "Expense Report",
                    companyName: currentOrg?.name,
                    columns: cols,
                    rows,
                    currency: baseCurrency,
                    organizationId: currentOrg?.id,
                  } as ExportConfig;
                }}
              />
            </>
          )}
        </div>

        {/* Bulk Actions Bar */}
        {isAdmin && selectedExpenses.size > 0 && (
          <div className="flex items-center justify-between rounded-lg border bg-muted/50 p-3">
            <span className="text-sm font-medium">
              {selectedExpenses.size} expense{selectedExpenses.size > 1 ? "s" : ""} selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedExpenses(new Set())}
              >
                <X className="mr-2 h-4 w-4" />
                Clear Selection
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowBulkDeleteDialog(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Selected
              </Button>
            </div>
          </div>
        )}

        <CustomFieldFilters entityType="expense" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />

        {/* Dynamic Views */}
        <DynamicViewsRenderer
          currentView={currentView}
          selectedSavedView={selectedSavedView}
          data={expenses as unknown as Record<string, unknown>[]}
          isLoading={isLoading}
        />

        {/* Table */}
        {currentView === "list" && <Card>
          <CardContent className="p-0">
            {(isLoading || !currencyReady) ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : expenses.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Receipt className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No expenses to show</h3>
                <p className="text-muted-foreground max-w-md">
                  {!search && statusFilter === "all"
                    ? "You see your own expenses and those of the people who report to you; Finance sees all of them. Record an expense to get started."
                    : "Try adjusting your search or filter."}
                </p>
              </div>

            ) : (
              <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    {isAdmin && (
                      <TableHead className="w-12">
                        <Checkbox
                          checked={selectedExpenses.size === expenses.length && expenses.length > 0}
                          onCheckedChange={toggleSelectAll}
                        />
                      </TableHead>
                    )}
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expenses.map((expense) => (
                    <TableRow key={expense.id} className={`cursor-pointer ${selectedExpenses.has(expense.id) ? "bg-muted/50" : ""}`} onClick={() => setPeekId(expense.id)}>
                      {isAdmin && (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedExpenses.has(expense.id)}
                            onCheckedChange={() => toggleSelectExpense(expense.id)}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          {format(new Date(expense.expense_date), "MMM d, yyyy")}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>
                          <div className="font-medium">{expense.description}</div>
                          {expense.reference && (
                            <div className="text-sm text-muted-foreground">
                              Ref: {expense.reference}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {expense.category ? (
                          <Badge
                            variant="outline"
                            style={{ borderColor: expense.category.color }}
                          >
                            {expense.category.name}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {expense.vendor ? (
                          <ClickableEntity onClick={() => setPreviewContactId(expense.vendor_id)}>
                            {expense.vendor.name}
                          </ClickableEntity>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {getStatusBadge(expense.status)}
                          {linkedBills[expense.id] && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 cursor-help">
                                    <FileText className="h-3 w-3 mr-0.5" />
                                    {linkedBills[expense.id].status === "paid" ? "Paid" :
                                     linkedBills[expense.id].status === "partial" ? "Partial" : "Unpaid"}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Linked bill: {linkedBills[expense.id].bill_number}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatExpenseCurrency(expense.amount, expense.currency)}
                      </TableCell>
                      {canManagePurchases ? (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {/* View — always available */}
                              <DropdownMenuItem onClick={() => setPeekId(expense.id)}>
                                <Eye className="mr-2 h-4 w-4" />
                                View Details
                              </DropdownMenuItem>
                              {/* Edit — only for pending/draft (Odoo behavior) */}
                              {isExpenseEditable(expense.status) && (
                                <DropdownMenuItem onClick={() => handleOpenDialog(expense)}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                              )}
                              {/* Lifecycle — the server decides what actually happens */}
                              {(expense.status === "draft" ||
                                expense.status === "pending" ||
                                expense.status === "rejected") && (
                                <DropdownMenuItem onClick={() => handleSubmitExpense(expense)}>
                                  <Send className="mr-2 h-4 w-4" />
                                  Submit for approval
                                </DropdownMenuItem>
                              )}
                              {(expense.status === "submitted" || expense.status === "pending") && (
                                <>
                                  <DropdownMenuItem onClick={() => handleApproveExpense(expense)}>
                                    <Check className="mr-2 h-4 w-4" />
                                    Approve
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => handleRejectExpense(expense)}
                                    className="text-destructive"
                                  >
                                    <X className="mr-2 h-4 w-4" />
                                    Reject
                                  </DropdownMenuItem>
                                </>
                              )}
                              {/* Show "Create Bill" for AP expenses without a linked bill */}
                              {isAPAccount(expense.payment_account_id) && !linkedBills[expense.id] && (
                                <DropdownMenuItem
                                  onClick={async () => {
                                    const result = await createLinkedBill(expense.id);
                                    if (result.success) {
                                      toast({ title: "Vendor bill created", description: `Bill ${result.bill?.bill_number} is now available in Purchases → Bills.` });
                                      queryClient.invalidateQueries({ queryKey: ["bills"] });
                                      queryClient.invalidateQueries({ queryKey: ["aging-report"] });
                                      queryClient.invalidateQueries({ queryKey: ["expenses"] });
                                    }
                                  }}
                                  className="text-blue-600"
                                >
                                  <FileText className="mr-2 h-4 w-4" />
                                  Create Vendor Bill
                                </DropdownMenuItem>
                              )}
                              {/* Reimbursement — only for employee-paid expenses */}
                              {isEmployeeReimbursable(expense) && (
                                expense.reimburse_via_payroll ? (
                                  <DropdownMenuItem
                                    onClick={() => handleUnqueueReimbursement(expense)}
                                  >
                                    <X className="mr-2 h-4 w-4" />
                                    Remove from payroll queue
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    onClick={() => setReimburseExpense(expense)}
                                  >
                                    <Wallet className="mr-2 h-4 w-4" />
                                    Reimburse employee
                                  </DropdownMenuItem>
                                )
                              )}
                              {/* Void — for approved/paid expenses */}
                              {(expense.status === "approved" || expense.status === "paid") && (
                                <DropdownMenuItem
                                  onClick={() => handleVoidExpense(expense)}
                                  className="text-destructive"
                                >
                                  <Ban className="mr-2 h-4 w-4" />
                                  Void Expense
                                </DropdownMenuItem>
                              )}
                              {/* Delete — only for pending expenses */}
                              {isExpenseDeletable(expense.status) && (
                                <DropdownMenuItem
                                  onClick={() => handleDelete(expense)}
                                  className="text-destructive"
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      ) : (
                        <TableCell />
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
          </CardContent>
        </Card>}

        {/* Pagination */}
        {expenses.length > 0 && (
          <DataTablePagination
            pagination={pagination}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            isLoading={isFetching}
          />
        )}

        {/*
          The legacy `<Dialog>` create/edit surface for Expenses lived
          here. It was retired on the platform-wide interaction
          standardization initiative (P.1 in the Purchases ledger).
          Create / edit are now dedicated full pages at
          `/purchases/expenses/new` and `/purchases/expenses/:id/edit`,
          composed on `RecordFormShell` — see
          `src/features/purchases/expenses/ExpenseCreatePage.tsx` and
          `ExpenseEditPage.tsx`.
        */}


        <ExpenseReimburseDialog
          expense={reimburseExpense}
          open={!!reimburseExpense}
          onOpenChange={(open) => {
            if (!open) setReimburseExpense(null);
          }}
          onQueuePayroll={queuePayrollReimbursement}
          onReimburseDirect={reimburseDirect}
        />

        {/* Add/Edit Category Dialog */}
        <Dialog open={showCategoryDialog} onOpenChange={(open) => {
          setShowCategoryDialog(open);
          if (!open) setEditingCategory(null);
        }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingCategory ? "Edit" : "Add"} Expense Category</DialogTitle>
              <DialogDescription>
                {editingCategory ? "Update category details and GL mapping." : "Create a new category to organize your expenses."}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSaveCategory} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cat_name">Category Name *</Label>
                <Input
                  id="cat_name"
                  value={categoryForm.name}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, name: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cat_description">Description</Label>
                <Textarea
                  id="cat_description"
                  value={categoryForm.description}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, description: e.target.value })
                  }
                  rows={2}
                />
              </div>
               <div className="space-y-2">
                <Label htmlFor="cat_color">Color</Label>
                <Input
                  id="cat_color"
                  type="color"
                  value={categoryForm.color}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, color: e.target.value })
                  }
                  className="h-10 w-20"
                />
              </div>
              <div className="space-y-2">
                <Label>Expense Account (GL Mapping)</Label>
                <AccountCombobox
                  accounts={expenseAccounts}
                  value={categoryForm.account_id}
                  onValueChange={(value) => setCategoryForm({ ...categoryForm, account_id: value })}
                  placeholder="Select expense account..."
                />
                {!categoryForm.account_id && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    ⚠ Without a linked account, expenses in this category will default to the generic Operating Expenses account. For accurate financial reports, select the matching expense account.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Links this category to a specific expense account in your Chart of Accounts for accurate journal entries.
                </p>
              </div>

              {/* Category list for editing/deleting */}
              {!editingCategory && categories.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Existing Categories</Label>
                  <div className="max-h-40 overflow-y-auto rounded-md border">
                    {categories.map((cat) => (
                      <div key={cat.id} className="flex items-center justify-between px-3 py-2 border-b last:border-b-0">
                        <div className="flex items-center gap-2">
                          <div className="h-3 w-3 rounded-full" style={{ backgroundColor: cat.color }} />
                          <span className="text-sm">{cat.name}</span>
                          {!cat.account_id && <span className="text-xs text-amber-500">⚠ No GL</span>}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleOpenCategoryDialog(cat)}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteCategory(cat)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setShowCategoryDialog(false); setEditingCategory(null); }}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {editingCategory ? "Update Category" : "Create Category"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          title="Delete Expense"
          description="Are you sure you want to delete this expense? This action cannot be undone."
          onConfirm={deleteConfirm.confirmDelete}
          isLoading={deleteConfirm.isDeleting}
        />

        {/* Bulk Delete Confirmation Dialog */}
        <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {selectedExpenses.size} Expenses?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete {selectedExpenses.size} expense{selectedExpenses.size > 1 ? "s" : ""} regardless of their status. 
                This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isBulkDeleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleBulkDelete}
                disabled={isBulkDeleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isBulkDeleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete All
                  </>
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Import Wizard */}
        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Expense"
          fieldDefinitions={expenseFieldDefinitions}
          onImport={handleImportExpense}
          onComplete={() => {}}
        />

        {/* Expense peek surface — standard enterprise interaction */}
        <ExpensePeekSheet
          expenseId={peekId}
          onOpenChange={(open) => { if (!open) setPeekId(null); }}
          onVoid={(id) => {
            const exp = expenses.find(e => e.id === id);
            if (exp) handleVoidExpense(exp);
          }}
          onReimburse={(id) => {
            const exp = expenses.find(e => e.id === id);
            if (exp) setReimburseExpense(exp);
          }}
          onUnqueuePayroll={(id) => {
            const exp = expenses.find(e => e.id === id);
            if (exp) handleUnqueueReimbursement(exp);
          }}
        />

      </div>

      <ContactPreviewDrawer
        open={!!previewContactId}
        onOpenChange={(open) => { if (!open) setPreviewContactId(null); }}
        contactId={previewContactId}
      />
    </>
  );
}

import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import { useRecurringInvoices, RecurringInvoiceItem } from "@/hooks/useRecurringInvoices";
import { useOrganization } from "@/hooks/useOrganization";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { useContacts } from "@/hooks/useContacts";
import { useProducts } from "@/hooks/useProducts";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { BulkActionsToolbar } from "@/components/common/BulkActionsToolbar";
import { BulkDeleteDialog } from "@/components/common/BulkDeleteDialog";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { useViewMode } from "@/hooks/useViewMode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProductCombobox } from "@/components/common/ProductCombobox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  Play,
  Pause,
  Zap,
  RefreshCw,
  Download,
  FileText,
  ExternalLink,
} from "lucide-react";
import { useExport } from "@/hooks/useExport";
import { format } from "date-fns";
import { PermissionGate } from "@/components/common/PermissionGate";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { RecurringInvoicePeekSheet } from "@/features/sales/recurring/RecurringInvoicePeekSheet";
import { usePeekParam } from "@/design-system/records";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { normalizeError } from "@/services/resilience";
export default function RecurringInvoices() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { recurringInvoices, isLoading, createRecurringInvoice, updateRecurringInvoice, deleteRecurringInvoice, toggleActive, generateInvoiceNow } = useRecurringInvoices();
  const { currentOrg } = useOrganization();
  const { contacts } = useContacts();
  const { products } = useProducts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { exportRecurringInvoices } = useExport();
  const { toast } = useToast();
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "recurring_invoice" });
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters } = useCustomFieldFiltering("recurring_invoice");

  const [showDialog, setShowDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [peekId, setPeekId] = usePeekParam();

  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);

  // Deep-link: ?id={uuid} opens peek sheet directly
  useEffect(() => {
    const id = searchParams.get("id");
    if (!id) return;
    setPeekId(id);
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, setPeekId]);


  const [formData, setFormData] = useState({
    template_name: "",
    contact_id: "",
    frequency: "monthly" as const,
    start_date: new Date().toISOString().split("T")[0],
    end_date: "",
    auto_send: false,
    auto_confirm: false,
    days_before_due: 30,
    notes: "",
    terms: "",
  });

  const [lineItems, setLineItems] = useState<Omit<RecurringInvoiceItem, "id" | "recurring_invoice_id">[]>([
    { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0, discount_percent: 0, sort_order: 0 },
  ]);

  const customers = contacts.filter((c) => (c.type === "customer" || c.type === "both") && c.is_active);

  const filteredRecurring = recurringInvoices.filter((ri) =>
    ri.template_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    ri.contact?.name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const bulkSelection = useBulkSelection({
    items: filteredRecurring,
    getItemId: (ri) => ri.id,
  });

  const handleBulkDelete = async () => {
    setIsBulkDeleting(true);
    try {
      const selectedItems = bulkSelection.selectedItems;
      let successCount = 0;
      let errorCount = 0;

      for (const item of selectedItems) {
        try {
          await deleteRecurringInvoice(item.id);
          successCount++;
        } catch {
          errorCount++;
        }
      }

      if (successCount > 0) {
        toast({
          title: `${successCount} template${successCount > 1 ? "s" : ""} deleted`,
          description: errorCount > 0 ? `${errorCount} failed to delete` : undefined,
        });
      }
      
      bulkSelection.clearSelection();
    } catch (error: any) {
      toast({
        title: "Error deleting templates",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsBulkDeleting(false);
      setShowBulkDeleteDialog(false);
    }
  };

  const handleBulkExport = () => {
    const selectedItems = bulkSelection.selectedItems;
    exportRecurringInvoices(selectedItems);
    toast({
      title: `Exported ${selectedItems.length} template${selectedItems.length > 1 ? "s" : ""}`,
    });
    bulkSelection.clearSelection();
  };

  const resetForm = () => {
    setFormData({
      template_name: "",
      contact_id: "",
      frequency: "monthly",
      start_date: new Date().toISOString().split("T")[0],
      end_date: "",
      auto_send: false,
      auto_confirm: false,
      days_before_due: 30,
      notes: "",
      terms: "",
    });
    setLineItems([{ product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0, discount_percent: 0, sort_order: 0 }]);
  };

  const updateLineItem = (index: number, field: string, value: any) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], [field]: value };

    if (field === "product_id" && value) {
      const product = products.find((p) => p.id === value);
      if (product) {
        updated[index].description = product.name;
        updated[index].unit_price = product.unit_price;
        updated[index].tax_rate = product.tax_rate || 0;
      }
    }

    setLineItems(updated);
  };

  const addLineItem = () => {
    setLineItems([...lineItems, { product_id: null, description: "", quantity: 1, unit_price: 0, tax_rate: 0, discount_percent: 0, sort_order: lineItems.length }]);
  };

  const removeLineItem = (index: number) => {
    if (lineItems.length > 1) {
      setLineItems(lineItems.filter((_, i) => i !== index));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.template_name || !formData.contact_id || lineItems.every((item) => !item.description)) {
      toast({ title: "Please fill required fields", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      await createRecurringInvoice(
        {
          template_name: formData.template_name,
          contact_id: formData.contact_id,
          frequency: formData.frequency,
          start_date: formData.start_date,
          end_date: formData.end_date || null,
          next_run_date: formData.start_date,
          is_active: true,
          auto_send: formData.auto_send,
          auto_confirm: formData.auto_confirm,
          days_before_due: formData.days_before_due,
          currency: baseCurrency,
          notes: formData.notes || null,
          terms: formData.terms || null,
        },
        lineItems.filter((item) => item.description)
      );
      toast({ title: "Recurring invoice created" });
      setShowDialog(false);
      resetForm();
    } catch (error: any) {
      toast({ title: "Error creating", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleActive = async (id: string, currentState: boolean) => {
    try {
      await toggleActive(id, !currentState);
      toast({ title: currentState ? "Paused" : "Activated" });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const handleGenerateNow = async (id: string) => {
    try {
      const result = await generateInvoiceNow(id);
      if (!result?.duplicate) {
        toast({
          title: "Invoice generated",
          description: result?.invoice_number
            ? `${result.invoice_number} covers ${result.period_start} — ${result.period_end}.`
            : undefined,
        });
      }
    } catch (error: any) {
      toast({ title: "Error generating invoice", description: normalizeError(error).message, variant: "destructive" });
    }
  };


  const handleDelete = async (id: string) => {
    try {
      await deleteRecurringInvoice(id);
      toast({ title: "Recurring invoice deleted" });
    } catch (error: any) {
      toast({ title: "Error deleting", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const getFrequencyLabel = (frequency: string) => {
    const labels: Record<string, string> = {
      weekly: "Weekly",
      biweekly: "Bi-weekly",
      monthly: "Monthly",
      quarterly: "Quarterly",
      yearly: "Yearly",
    };
    return labels[frequency] || frequency;
  };

  const calculateTotal = (items: RecurringInvoiceItem[]) => {
    return items.reduce((sum, item) => {
      const subtotal = item.quantity * item.unit_price;
      const tax = subtotal * (item.tax_rate / 100);
      return sum + subtotal + tax;
    }, 0);
  };

  const stats = {
    active: filteredRecurring.filter((ri) => ri.is_active).length,
    total: filteredRecurring.length,
    generated: filteredRecurring.reduce((sum, ri) => sum + ri.invoices_generated, 0),
  };

  const previewTotal = lineItems.reduce((sum, item) => {
    const subtotal = item.quantity * item.unit_price;
    const tax = subtotal * (item.tax_rate / 100);
    return sum + subtotal + tax;
  }, 0);

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="page-title">Recurring Invoices</h1>
              {currentOrg && (
                <RefreshButton queryKeyPrefixes={[queryKeys.recurringInvoices.all(currentOrg.id)]} tooltip="Refresh recurring invoices" />
              )}
            </div>
            <p className="text-sm sm:text-base text-muted-foreground">Automate billing for subscription customers</p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomFieldFilters
              entityType="recurring_invoice"
              filters={customFieldFilters}
              onFiltersChange={setCustomFieldFilters}
            />
            <ViewSwitcher
              entityType="recurring_invoice"
              currentView={currentView}
              onViewChange={setView}
            />
            <StudioQuickPanelTrigger entityType="recurring_invoice" />
            <CustomizeFieldsButton entityType="recurring_invoice" />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "name", header: "Template Name", width: 20 },
                  { key: "customer", header: "Customer", width: 22 },
                  { key: "frequency", header: "Frequency", width: 12 },
                  { key: "amount", header: "Amount", format: "currency", width: 14, align: "right" },
                  { key: "status", header: "Status", width: 10 },
                  { key: "next_date", header: "Next Date", width: 12 },
                  { key: "generated", header: "Generated", width: 10, align: "right" },
                ];
                const rows = filteredRecurring.map((ri) => ({
                  name: ri.template_name,
                  customer: ri.contact?.name || "",
                  frequency: ri.frequency,
                  amount: (ri.items || []).reduce((s, item) => s + (item.quantity * item.unit_price), 0),
                  status: ri.is_active ? "Active" : "Paused",
                  next_date: ri.next_run_date,
                  generated: ri.invoices_generated,
                }));
                return {
                  title: "Recurring Invoices Schedule",
                  columns: cols,
                  rows,
                  currency: baseCurrency,
                } as ExportConfig;
              }}
            />
            <PermissionGate permission="manageSales">
              <Button onClick={() => setShowDialog(true)} className="flex-1 sm:flex-none">
                <Plus className="mr-2 h-4 w-4" /> Create Template
              </Button>
            </PermissionGate>
          </div>
        </div>

        <div className="stats-grid grid-cols-1 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Active Templates</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{stats.active}</div>
              <p className="text-xs text-muted-foreground">of {stats.total} total</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Invoices Generated</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.generated}</div>
              <p className="text-xs text-muted-foreground">all time</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <RefreshCw className="h-4 w-4" /> Next Due
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {filteredRecurring.filter((ri) => ri.is_active).length > 0
                  ? format(
                      new Date(
                        Math.min(
                          ...filteredRecurring
                            .filter((ri) => ri.is_active)
                            .map((ri) => new Date(ri.next_run_date).getTime())
                        )
                      ),
                      "MMM d"
                    )
                  : "—"}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search recurring invoices..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
        </div>

        <DynamicViewsRenderer
          currentView={currentView}
          selectedSavedView={selectedSavedView}
          data={filteredRecurring as unknown as Record<string, unknown>[]}
          isLoading={isLoading}
          onItemClick={(item) => {
            const ri = filteredRecurring.find(r => r.id === (item as any).id);
            if (ri) setPeekId(ri.id);
          }}
          entityType="recurring_invoice"
        />

        {currentView === "list" && <div className="table-container rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <Checkbox
                    checked={bulkSelection.isAllSelected}
                    onCheckedChange={bulkSelection.toggleAll}
                    aria-label="Select all"
                    className={bulkSelection.isPartiallySelected ? "data-[state=checked]:bg-primary/50" : ""}
                  />
                </TableHead>
                <TableHead>Template Name</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>Next Run</TableHead>
                <TableHead>Generated</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(isLoading || !currencyReady) ? (
                <TableRow><TableCell colSpan={9} className="text-center py-8">Loading...</TableCell></TableRow>
              ) : filteredRecurring.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">No recurring invoices found</TableCell></TableRow>
              ) : (
                filteredRecurring.map((ri) => (
                  <TableRow key={ri.id} data-state={bulkSelection.isSelected(ri.id) ? "selected" : undefined} className="cursor-pointer" onClick={() => setPeekId(ri.id)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={bulkSelection.isSelected(ri.id)}
                        onCheckedChange={() => bulkSelection.toggleItem(ri.id)}
                        aria-label={`Select template ${ri.template_name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{ri.template_name}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {ri.contact?.name ? (
                        <ClickableEntity onClick={() => {
                          setContactDrawerId((ri as any).contact_id);
                          setContactDrawerOpen(true);
                        }}>
                          {ri.contact.name}
                        </ClickableEntity>
                      ) : "—"}
                    </TableCell>
                    <TableCell>{getFrequencyLabel(ri.frequency)}</TableCell>
                    <TableCell>{format(new Date(ri.next_run_date), "MMM d, yyyy")}</TableCell>
                    <TableCell>{ri.invoices_generated}</TableCell>
                    <TableCell>
                      <Badge variant={ri.is_active ? "default" : "secondary"} className={ri.is_active ? "bg-green-500" : ""}>
                        {ri.is_active ? "Active" : "Paused"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(calculateTotal(ri.items || []), ri.currency)}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setPeekId(ri.id)}>
                            <FileText className="mr-2 h-4 w-4" /> View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => navigate(`/sales/recurring/${ri.id}`)}>
                            <ExternalLink className="mr-2 h-4 w-4" /> Open Full Page
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleGenerateNow(ri.id)}>
                            <Zap className="mr-2 h-4 w-4" /> Generate Now
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleToggleActive(ri.id, ri.is_active)}>
                            {ri.is_active ? (
                              <><Pause className="mr-2 h-4 w-4" /> Pause</>
                            ) : (
                              <><Play className="mr-2 h-4 w-4" /> Activate</>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleDelete(ri.id)} className="text-destructive">
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>}
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="w-[95vw] max-w-4xl max-h-[90vh] overflow-y-auto p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Create Recurring Invoice</DialogTitle>
            <DialogDescription>Set up automatic invoicing for a customer</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Template Name *</Label>
                <Input value={formData.template_name} onChange={(e) => setFormData({ ...formData, template_name: e.target.value })} placeholder="e.g., Monthly Subscription" />
              </div>
              <div className="space-y-2">
                <Label>Customer *</Label>
                <Select value={formData.contact_id} onValueChange={(v) => setFormData({ ...formData, contact_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Frequency *</Label>
                <Select value={formData.frequency} onValueChange={(v: any) => setFormData({ ...formData, frequency: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Bi-weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Due after (days from period start)</Label>
                <Input type="number" value={formData.days_before_due} onChange={(e) => setFormData({ ...formData, days_before_due: parseInt(e.target.value) || 30 })} />
                <p className="text-xs text-muted-foreground">
                  Each generated invoice is due this many days after the billing period begins.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Start Date *</Label>
                <Input type="date" value={formData.start_date} onChange={(e) => setFormData({ ...formData, start_date: e.target.value })} />
                <p className="text-xs text-muted-foreground">
                  Anchors the billing calendar — a schedule starting on the 31st keeps billing on the 31st.
                </p>
              </div>
              <div className="space-y-2">
                <Label>End Date (optional)</Label>
                <Input type="date" value={formData.end_date} onChange={(e) => setFormData({ ...formData, end_date: e.target.value })} />
                <p className="text-xs text-muted-foreground">
                  The final period that begins on or before this date is still billed, then the schedule completes.
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-2">
              <Switch checked={formData.auto_send} onCheckedChange={(v) => setFormData({ ...formData, auto_send: v })} />
              <div>
                <Label>Email the invoice to the customer</Label>
                <p className="text-xs text-muted-foreground">
                  Sent only after the invoice is posted. A failed email is retried and never changes the invoice.
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-2">
              <Switch checked={formData.auto_confirm} onCheckedChange={(v) => setFormData({ ...formData, auto_confirm: v })} />
              <div>
                <Label>Confirm &amp; post to the ledger automatically</Label>
                <p className="text-xs text-muted-foreground">
                  Off: invoices arrive as drafts for review. On: posting failures cancel the whole occurrence and it is retried.
                </p>
              </div>
            </div>


            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>Line Items</Label>
                <Button type="button" variant="outline" size="sm" onClick={addLineItem}><Plus className="mr-1 h-3 w-3" /> Add Item</Button>
              </div>

              {/* Desktop line items table */}
              <div className="hidden sm:block space-y-2">
                {lineItems.map((item, index) => (
                  <div key={index} className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-4">
                      <ProductCombobox
                        products={products}
                        value={item.product_id}
                        onChange={(v) => updateLineItem(index, "product_id", v)}
                        placeholder="Product"
                      />
                    </div>
                    <div className="col-span-3">
                      <Input placeholder="Description" value={item.description} onChange={(e) => updateLineItem(index, "description", e.target.value)} />
                    </div>
                    <div className="col-span-1">
                      <NumericInput placeholder="Qty" value={item.quantity} onValueChange={(v) => updateLineItem(index, "quantity", v ?? 0)} />
                    </div>
                    <div className="col-span-2">
                      <NumericInput placeholder="Price" value={item.unit_price} onValueChange={(v) => updateLineItem(index, "unit_price", v ?? 0)} />
                    </div>
                    <div className="col-span-1">
                      <NumericInput placeholder="Tax %" value={item.tax_rate} onValueChange={(v) => updateLineItem(index, "tax_rate", v ?? 0)} />
                    </div>
                    <div className="col-span-1">
                      <Button type="button" variant="ghost" size="icon" onClick={() => removeLineItem(index)} disabled={lineItems.length === 1}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Mobile line items cards */}
              <div className="sm:hidden space-y-3">
                {lineItems.map((item, index) => (
                  <div key={index} className="rounded-lg border p-3 space-y-3 bg-card">
                    <div className="flex items-start justify-between">
                      <span className="text-xs font-medium text-muted-foreground">Item {index + 1}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 -mt-1 -mr-1"
                        onClick={() => removeLineItem(index)}
                        disabled={lineItems.length === 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <ProductCombobox
                      products={products}
                      value={item.product_id}
                      onChange={(v) => updateLineItem(index, "product_id", v)}
                    />
                    <Input
                      placeholder="Description"
                      value={item.description}
                      onChange={(e) => updateLineItem(index, "description", e.target.value)}
                      className="h-9"
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Qty</Label>
                        <NumericInput className="h-9" value={item.quantity} onValueChange={(v) => updateLineItem(index, "quantity", v ?? 0)} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Price</Label>
                        <NumericInput className="h-9" value={item.unit_price} onValueChange={(v) => updateLineItem(index, "unit_price", v ?? 0)} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Tax %</Label>
                        <NumericInput className="h-9" value={item.tax_rate} onValueChange={(v) => updateLineItem(index, "tax_rate", v ?? 0)} />
                      </div>
                    </div>
                    <div className="flex justify-between items-center pt-1 border-t">
                      <span className="text-xs text-muted-foreground">Line Total</span>
                      <span className="text-sm font-semibold">{formatCurrency((item.quantity || 0) * (item.unit_price || 0) * (1 + (item.tax_rate || 0) / 100))}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <div className="w-full sm:w-64 space-y-2 text-sm">
                <div className="flex justify-between font-bold text-lg">
                  <span>Invoice Total:</span><span>{formatCurrency(previewTotal)}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} placeholder="Invoice notes..." />
              </div>
              <div className="space-y-2">
                <Label>Terms</Label>
                <Textarea value={formData.terms} onChange={(e) => setFormData({ ...formData, terms: e.target.value })} placeholder="Payment terms..." />
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating..." : "Create Template"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Detail Peek Sheet */}
      <RecurringInvoicePeekSheet
        recurringId={peekId}
        onOpenChange={(o) => { if (!o) setPeekId(null); }}
      />


      {/* Bulk Delete Dialog */}
      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={bulkSelection.selectedCount}
        entityName={bulkSelection.selectedCount === 1 ? "template" : "templates"}
        onConfirm={handleBulkDelete}
        isDeleting={isBulkDeleting}
      />

      {/* Bulk Actions Toolbar */}
      <BulkActionsToolbar
        selectedCount={bulkSelection.selectedCount}
        onDelete={() => setShowBulkDeleteDialog(true)}
        onExport={handleBulkExport}
        onClearSelection={bulkSelection.clearSelection}
        isDeleting={isBulkDeleting}
        entityName={bulkSelection.selectedCount === 1 ? "template" : "templates"}
      />

      <ContactPreviewDrawer
        open={contactDrawerOpen}
        onOpenChange={setContactDrawerOpen}
        contactId={contactDrawerId}
      />
    </>
  );
}

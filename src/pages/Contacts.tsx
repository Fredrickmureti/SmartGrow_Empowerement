import { useState, useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCountries } from "@/hooks/useCountries";
import { ProductAccountSelector } from "@/components/products/ProductAccountSelector";
import { ContactDeleteDialog } from "@/components/contacts/ContactDeleteDialog";
import { CountryCombobox } from "@/components/contacts/CountryCombobox";
import { ParentCompanyCombobox } from "@/components/contacts/ParentCompanyCombobox";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { useContactsPaginated, Contact } from "@/hooks/useContactsPaginated";
import { usePermissions } from "@/hooks/usePermissions";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { useViewMode } from "@/hooks/useViewMode";
import { useBulkSelection } from "@/hooks/useBulkSelection";
import { useListViewColumns, DefaultColumn } from "@/hooks/useListViewColumns";
import { useCoreFieldDisplay } from "@/hooks/useCoreFieldDisplay";
import { ViewSwitcher } from "@/components/common/ViewSwitcher";
import { BulkActionsToolbar } from "@/components/common/BulkActionsToolbar";
import { BulkDeleteDialog } from "@/components/common/BulkDeleteDialog";
import { DynamicViewsRenderer } from "@/components/common/DynamicViewsRenderer";
import { CustomFieldFilters } from "@/components/common/CustomFieldFilters";
import { useCustomFieldFiltering } from "@/hooks/useCustomFieldFiltering";
import { StudioQuickPanelTrigger } from "@/components/studio/StudioQuickPanelTrigger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
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
  Users,
  Mail,
  Phone,
  Building2,
  MoreHorizontal,
  Loader2,
  Pencil,
  Trash2,
  Download,
  AlertTriangle,
  ExternalLink,
  Upload,
  Archive,
  RotateCcw,
} from "lucide-react";
import { useExport } from "@/hooks/useExport";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { ImportWizard } from "@/components/common/ImportWizard";
import { CONTACT_IMPORT_FIELDS, createContactImportHandler } from "@/lib/contactImportConfig";
import { useVendorPortalInvite } from "@/hooks/useVendorPortal";
import { useOrganization } from "@/hooks/useOrganization";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { CreditManagementSection } from "@/components/contacts/CreditManagementSection";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { CustomFieldsSection, useCustomFieldFormState } from "@/components/studio/CustomFieldsSection";
import { useEntityFieldValues } from "@/hooks/useEntityFields";
import { CustomizeFieldsButton } from "@/components/studio/CustomizeFieldsButton";
import { ContactMergeDialog } from "@/components/contacts/ContactMergeDialog";
import { ContactBulkActions } from "@/components/contacts/ContactBulkActions";
import { normalizeError } from "@/services/resilience";

interface ContactsProps {
  /** Pre-set the type filter (customer/vendor) */
  defaultTypeFilter?: "customer" | "supplier" | "both";
  /** Show only contacts with company field set */
  showCompaniesOnly?: boolean;
}

export default function Contacts({ defaultTypeFilter, showCompaniesOnly }: ContactsProps = {}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { currentBusiness } = useBusinesses();
  const { countries } = useCountries();
  const defaultCountry = currentBusiness?.country || "US";
  // View mode state
  const { currentView, selectedSavedView, setView } = useViewMode({ entityType: "contact" });

  // Core field display overrides from Studio
  const coreFieldDisplay = useCoreFieldDisplay("contact");

  // Default list columns - can be overridden by saved list views in Studio
  const defaultContactColumns: DefaultColumn[] = coreFieldDisplay.applyToColumns([
    { field: "name", label: "Name", visible: true },
    { field: "type", label: "Type", visible: true },
    { field: "email", label: "Email", visible: true },
    { field: "phone", label: "Phone", visible: true },
    { field: "company", label: "Company", visible: true },
  ]);
  const { visibleColumns } = useListViewColumns("contact", defaultContactColumns);
  
  // Custom field filtering
  const { filters: customFieldFilters, setFilters: setCustomFieldFilters, filterEntityIds, isFiltering: isCustomFiltering } = useCustomFieldFiltering("contact");

  // Search and filter state
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>(defaultTypeFilter || "all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);

  // Sync typeFilter when route changes (component is reused across routes)
  useEffect(() => {
    setTypeFilter(defaultTypeFilter || "all");
  }, [defaultTypeFilter]);

  // Handle ?action=create query param
  const [pendingCreateAction, setPendingCreateAction] = useState(false);
  useEffect(() => {
    const action = searchParams.get("action");
    const typeParam = searchParams.get("type") as "customer" | "supplier" | null;
    if (action === "create") {
      setPendingCreateAction(true);
      const presetType = typeParam || (defaultTypeFilter && defaultTypeFilter !== "both" ? defaultTypeFilter : "customer");
      setFormData(prev => ({
        ...prev,
        name: "",
        email: "",
        phone: "",
        type: presetType as "customer" | "supplier" | "both",
        address_line1: "",
        city: "",
        state: "",
        postal_code: "",
        country: defaultCountry,
        notes: "",
        credit_limit: "",
        credit_hold: false,
        payment_term_id: "none",
        customer_group_id: "none",
      }));
      setEditingContact(null);
      setShowDialog(true);
    }
  }, [searchParams]);

  // Debounced search
  const debouncedSearch = useDebouncedCallback((value: string) => {
    setSearch(value);
  }, 300);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
    debouncedSearch(e.target.value);
  };

  const {
    contacts,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    createContact,
    updateContact,
    deleteContact,
    archiveContact,
    restoreContact,
  } = useContactsPaginated({
    typeFilter: typeFilter !== "all" ? typeFilter : undefined,
    showCompaniesOnly,
    search: search || undefined,
    includeArchived,
  });


  const { exportContacts } = useExport();
  const { canManageContacts } = usePermissions();
  const { toast } = useToast();
  const { inviteVendor, isInviting } = useVendorPortalInvite();
  const { currentOrg } = useOrganization();
  const [showDialog, setShowDialog] = useState(false);
  const [isGroupsDialogOpen, setIsGroupsDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [showBulkUpdateDialog, setShowBulkUpdateDialog] = useState(false);

  const handleImportContact = createContactImportHandler(
    currentOrg?.id || "",
    currentBusiness?.id || "",
    async (data) => { await createContact(data as any); }
  );

  // Bulk selection
  const bulkSelection = useBulkSelection({
    items: contacts,
    getItemId: (contact) => contact.id,
  });

  // Derive contextual labels from props
  const pageContext = showCompaniesOnly
    ? { title: "Companies", description: "Manage your company contacts", addButton: "Add Contact", searchPlaceholder: "Search companies...", emptyTitle: "No companies found", emptyHint: "Get started by adding your first company contact." }
    : defaultTypeFilter === "customer"
    ? { title: "Customers", description: "Manage your customers and receivables", addButton: "Add Customer", searchPlaceholder: "Search customers...", emptyTitle: "No customers found", emptyHint: "Get started by adding your first customer." }
    : defaultTypeFilter === "supplier"
    ? { title: "Suppliers", description: "Manage your suppliers and payables", addButton: "Add Vendor", searchPlaceholder: "Search suppliers...", emptyTitle: "No suppliers found", emptyHint: "Get started by adding your first supplier." }
    : { title: "All Contacts", description: "Manage your customers, suppliers, and companies", addButton: "Add Contact", searchPlaceholder: "Search contacts...", emptyTitle: "No contacts found", emptyHint: "Get started by adding your first contact." };

  const defaultFormType = (defaultTypeFilter === "customer" || defaultTypeFilter === "supplier") ? defaultTypeFilter : "customer";

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    type: defaultFormType as "customer" | "supplier" | "both",
    address_line1: "",
    city: "",
    state: "",
    postal_code: "",
    country: defaultCountry,
    notes: "",
    credit_limit: "",
    credit_hold: false,
    payment_term_id: "none",
    customer_group_id: "none",
    default_expense_account_id: null as string | null,
    default_payable_account_id: null as string | null,
    default_receivable_account_id: null as string | null,
    default_tax_rate_id: null as string | null,
    withholding_tax_rate: "",
    tax_exemption_number: "",
    // Phase E — Odoo-grade hierarchy
    parent_contact_id: "none" as string,
    is_company: false,
    child_address_type: "none" as string,
  });

  const resetForm = () => {
    setFormData({
      name: "",
      email: "",
      phone: "",
      
      type: defaultFormType,
      address_line1: "",
      city: "",
      state: "",
      postal_code: "",
      country: defaultCountry,
      notes: "",
      credit_limit: "",
      credit_hold: false,
      payment_term_id: "none",
      customer_group_id: "none",
      default_expense_account_id: null,
      default_payable_account_id: null,
      default_receivable_account_id: null,
      default_tax_rate_id: null,
      withholding_tax_rate: "",
      tax_exemption_number: "",
      parent_contact_id: "none",
      is_company: false,
      child_address_type: "none",
    });
    setEditingContact(null);
  };

  const handleOpenDialog = (contact?: Contact) => {
    if (contact) {
      setEditingContact(contact);
      setFormData({
        name: contact.name,
        email: contact.email || "",
        phone: contact.phone || "",
        
        type: contact.type,
        address_line1: contact.address_line1 || "",
        city: contact.city || "",
        state: contact.state || "",
        postal_code: contact.postal_code || "",
        country: contact.country || defaultCountry,
        notes: contact.notes || "",
        credit_limit: contact.credit_limit?.toString() || "",
        credit_hold: contact.credit_hold || false,
        payment_term_id: contact.payment_term_id || "none",
        customer_group_id: contact.customer_group_id || "none",
        default_expense_account_id: contact.default_expense_account_id || null,
        default_payable_account_id: contact.default_payable_account_id || null,
        default_receivable_account_id: (contact as any).default_receivable_account_id || null,
        default_tax_rate_id: contact.default_tax_rate_id || null,
        withholding_tax_rate: contact.withholding_tax_rate?.toString() || "",
        tax_exemption_number: contact.tax_exemption_number || "",
        parent_contact_id: (contact as any).parent_contact_id || "none",
        is_company: (contact as any).is_company ?? false,
        child_address_type: (contact as any).child_address_type || "none",
      });
    } else {
      resetForm();
    }
    setShowDialog(true);
  };

  // Handle ?action=edit&id=... — auto-open edit dialog
  const editHandledRef = useRef<string | null>(null);
  useEffect(() => {
    const action = searchParams.get("action");
    const editId = searchParams.get("id");
    if (action !== "edit" || !editId || editHandledRef.current === editId) return;

    const found = contacts.find((c) => c.id === editId);
    if (found) {
      editHandledRef.current = editId;
      handleOpenDialog(found);
    } else if (!isLoading) {
      // Not in current page — fetch directly
      editHandledRef.current = editId;
      (async () => {
        const { data, error } = await supabase
          .from("contacts")
          .select("*")
          .eq("id", editId)
          .single();
        if (!error && data) {
          handleOpenDialog(data as unknown as Contact);
        }
      })();
    }
  }, [searchParams, contacts, isLoading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const isCustomer = formData.type === "customer" || formData.type === "both";
      const isSupplier = formData.type === "supplier" || formData.type === "both";
      const curC = Number((editingContact as any)?.customer_rank ?? 0);
      const curS = Number((editingContact as any)?.supplier_rank ?? 0);
      const submitData = {
        ...formData,
        credit_limit: formData.credit_limit ? parseFloat(formData.credit_limit) : null,
        payment_term_id: formData.payment_term_id === "none" ? null : formData.payment_term_id,
        customer_group_id: formData.customer_group_id === "none" ? null : formData.customer_group_id,
        default_expense_account_id: formData.default_expense_account_id || null,
        default_payable_account_id: formData.default_payable_account_id || null,
        default_tax_rate_id: formData.default_tax_rate_id === "none" ? null : formData.default_tax_rate_id || null,
        withholding_tax_rate: formData.withholding_tax_rate ? parseFloat(formData.withholding_tax_rate) : null,
        tax_exemption_number: formData.tax_exemption_number || null,
        parent_contact_id: formData.parent_contact_id === "none" ? null : formData.parent_contact_id,
        child_address_type: formData.child_address_type === "none" ? null : (formData.child_address_type as "contact" | "invoice" | "delivery" | "other"),
        is_company: formData.is_company,
        // Rank bookkeeping — never overwrite a non-zero rank (only real
        // transactions bump those); user toggles flip between 0 and 1.
        customer_rank: isCustomer ? Math.max(1, curC) : 0,
        supplier_rank: isSupplier ? Math.max(1, curS) : 0,
      };
      
      if (editingContact) {
        await updateContact(editingContact.id, submitData);
        toast({ title: "Contact updated successfully" });
      } else {
        const newContact = await createContact({
          ...submitData,
          is_active: true,
        });
        const contactId = (newContact as any)?.id;
        toast({
          title: "Contact created successfully",
          description: submitData.type === "customer" || submitData.type === "both"
            ? "Create an invoice for this customer?"
            : "Create a bill from this supplier?",
          action: (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (submitData.type === "supplier") {
                  navigate(`/purchases/bills?action=create${contactId ? `&contact_id=${contactId}` : ""}`);
                } else {
                  navigate(`/sales/invoices?action=create${contactId ? `&contact_id=${contactId}` : ""}`);
                }
              }}
            >
              {submitData.type === "supplier" ? "Create Bill" : "Create Invoice"}
            </Button>
          ),
        });
      }
      setShowDialog(false);
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

  const handleDelete = (contact: Contact) => {
    setDeleteTarget(contact);
  };

  const executeDeleteContact = async () => {
    if (!deleteTarget) return;
    try {
      await deleteContact(deleteTarget.id);
      toast({ title: "Contact deleted successfully" });
    } catch (error: any) {
      toast({ title: "Error deleting contact", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const executeArchiveContact = async () => {
    if (!deleteTarget) return;
    try {
      await archiveContact(deleteTarget.id);
      toast({ title: "Contact archived", description: `${deleteTarget.name} has been archived and hidden from default views.` });
    } catch (error: any) {
      toast({ title: "Error archiving contact", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  // Bulk delete handler
  const handleBulkDelete = async () => {
    setIsBulkDeleting(true);
    try {
      const selectedContacts = bulkSelection.selectedItems;
      let successCount = 0;
      let errorCount = 0;

      for (const contact of selectedContacts) {
        try {
          await deleteContact(contact.id);
          successCount++;
        } catch {
          errorCount++;
        }
      }

      if (successCount > 0) {
        toast({
          title: `${successCount} contact${successCount > 1 ? "s" : ""} deleted`,
          description: errorCount > 0 ? `${errorCount} failed to delete` : undefined,
        });
      }
      
      bulkSelection.clearSelection();
    } catch (error: any) {
      toast({
        title: "Error deleting contacts",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsBulkDeleting(false);
      setShowBulkDeleteDialog(false);
    }
  };

  // Bulk export handler
  const handleBulkExport = () => {
    const selectedContacts = bulkSelection.selectedItems;
    exportContacts(selectedContacts);
    toast({
      title: `Exported ${selectedContacts.length} contact${selectedContacts.length > 1 ? "s" : ""}`,
    });
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div className="flex items-center gap-2">
            <div>
              <h1 className="page-title">{pageContext.title}</h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                {pageContext.description}
              </p>
            </div>
            <RefreshButton queryKeyPrefixes={[["contacts"]]} tooltip="Refresh contacts" />
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <CustomizeFieldsButton entityType="contact" />
            <StudioQuickPanelTrigger entityType="contact" />
            <ViewSwitcher
              entityType="contact"
              currentView={currentView}
              onViewChange={setView}
            />
            <ReportExportButtons
              compact
              formats={["excel", "csv", "print", "pdf"]}
              getExportConfig={() => {
                const cols: ExportColumn[] = [
                  { key: "name", header: "Name", width: 22 },
                  { key: "company", header: "Company", width: 20 },
                  { key: "type", header: "Type", width: 12 },
                  { key: "email", header: "Email", width: 22 },
                  { key: "phone", header: "Phone", width: 16 },
                  { key: "city", header: "City", width: 14 },
                  { key: "status", header: "Status", width: 10 },
                ];
                const rows = contacts.map((c) => ({
                  name: c.name,
                  company: c.company || "",
                  type: c.type || "",
                  email: c.email || "",
                  phone: c.phone || "",
                  city: c.city || "",
                  status: c.is_active ? "Active" : "Archived",
                }));
                const typeLabel = typeFilter === "customer" ? "Customers" : typeFilter === "supplier" ? "Suppliers" : "All Contacts";
                return {
                  title: `${typeLabel} Directory`,
                  companyName: currentOrg?.name,
                  columns: cols,
                  rows,
                  organizationId: currentOrg?.id,
                } as ExportConfig;
              }}
            />
            {canManageContacts && (
              <Button variant="outline" onClick={() => setShowMergeDialog(true)} className="flex-1 sm:flex-none">
                Merge
              </Button>
            )}
            {canManageContacts && (
              <Button variant="outline" onClick={() => setShowImportWizard(true)} className="flex-1 sm:flex-none">
                <Upload className="mr-2 h-4 w-4" />
                Import
              </Button>
            )}
            {canManageContacts && (
              <Button onClick={() => handleOpenDialog()} className="flex-1 sm:flex-none">
                <Plus className="mr-2 h-4 w-4" />
                {pageContext.addButton}
              </Button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={pageContext.searchPlaceholder}
              value={searchInput}
              onChange={handleSearchChange}
              className="pl-10 w-full"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="customer">Customers</SelectItem>
              <SelectItem value="supplier">Suppliers</SelectItem>
              <SelectItem value="both">Both</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Checkbox
              id="includeArchived"
              checked={includeArchived}
              onCheckedChange={(checked) => setIncludeArchived(checked === true)}
            />
            <Label htmlFor="includeArchived" className="text-sm whitespace-nowrap cursor-pointer">
              Include Archived
            </Label>
          </div>
        </div>

        <CustomFieldFilters entityType="contact" filters={customFieldFilters} onFiltersChange={setCustomFieldFilters} />
        <DynamicViewsRenderer
          currentView={currentView}
          selectedSavedView={selectedSavedView}
          data={contacts as unknown as Record<string, unknown>[]}
          isLoading={isLoading}
        />

        {/* List View (Table) */}
        {currentView === "list" && (
          <Card>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : contacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Users className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium">{pageContext.emptyTitle}</h3>
                  <p className="text-muted-foreground">
                    {!search && typeFilter === "all"
                      ? pageContext.emptyHint
                      : "Try adjusting your search or filter."}
                  </p>
                </div>
              ) : (
                <div className="table-container">
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
                      {visibleColumns.map(col => (
                        <TableHead key={col.field}>{col.label}</TableHead>
                      ))}
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contacts.map((contact) => (
                      <TableRow 
                        key={contact.id}
                        data-state={bulkSelection.isSelected(contact.id) ? "selected" : undefined}
                      >
                        <TableCell>
                          <Checkbox
                            checked={bulkSelection.isSelected(contact.id)}
                            onCheckedChange={() => bulkSelection.toggleItem(contact.id)}
                            aria-label={`Select ${contact.name}`}
                          />
                        </TableCell>
                        {visibleColumns.map(col => {
                          switch (col.field) {
                            case "name":
                              return (
                                <TableCell key="name" className="font-medium">
                                  <div className="flex items-center gap-2">
                                    {contact.name}
                                    {!contact.is_active && (
                                      <Badge variant="outline" className="text-xs text-muted-foreground">
                                        <Archive className="h-3 w-3 mr-1" />
                                        Archived
                                      </Badge>
                                    )}
                                    {contact.credit_hold && (
                                      <Badge variant="destructive" className="text-xs">
                                        <AlertTriangle className="h-3 w-3 mr-1" />
                                        Hold
                                      </Badge>
                                    )}
                                  </div>
                                </TableCell>
                              );
                            case "type":
                              return (
                                <TableCell key="type">
                                  <Badge variant="outline" className="capitalize">{contact.type}</Badge>
                                </TableCell>
                              );
                            case "email":
                              return (
                                <TableCell key="email">
                                  {contact.email && (
                                    <div className="flex items-center gap-1">
                                      <Mail className="h-3 w-3 text-muted-foreground" />
                                      {contact.email}
                                    </div>
                                  )}
                                </TableCell>
                              );
                            case "phone":
                              return (
                                <TableCell key="phone">
                                  {contact.phone && (
                                    <div className="flex items-center gap-1">
                                      <Phone className="h-3 w-3 text-muted-foreground" />
                                      {contact.phone}
                                    </div>
                                  )}
                                </TableCell>
                              );
                            case "company":
                              return <TableCell key="company">{contact.company}</TableCell>;
                            default:
                              return <TableCell key={col.field}>{(contact as any)[col.field] ?? ""}</TableCell>;
                          }
                        })}
                        {canManageContacts ? (
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => navigate(`/contacts-app/profile?id=${contact.id}`)}>
                                  <ExternalLink className="mr-2 h-4 w-4" />
                                  View Details
                                </DropdownMenuItem>
                                {(contact.type === "customer" || contact.type === "both") && (
                                  <DropdownMenuItem onClick={() => navigate(`/sales/customers/${contact.id}`)}>
                                    <ExternalLink className="mr-2 h-4 w-4" />
                                    Open Sales Record
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onClick={() => handleOpenDialog(contact)}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                                {(contact.type === "supplier" || contact.type === "both") && contact.email && currentOrg && (
                                  <DropdownMenuItem
                                    onClick={async () => {
                                      const result = await inviteVendor(contact.id, contact.email!, currentOrg.id);
                                      toast({
                                        title: result.success ? "Invitation sent" : "Failed to invite",
                                        description: result.success
                                          ? `Portal invitation sent to ${contact.email}`
                                          : result.error,
                                        variant: result.success ? "default" : "destructive",
                                      });
                                    }}
                                    disabled={isInviting}
                                  >
                                    <ExternalLink className="mr-2 h-4 w-4" />
                                    Invite to Portal
                                  </DropdownMenuItem>
                                )}
                                {!contact.is_active ? (
                                  <DropdownMenuItem
                                    onClick={async () => {
                                      try {
                                        await restoreContact(contact.id);
                                        toast({ title: "Contact restored", description: `${contact.name} is now active again.` });
                                      } catch (error: any) {
                                        toast({ title: "Error restoring contact", description: normalizeError(error).message, variant: "destructive" });
                                      }
                                    }}
                                  >
                                    <RotateCcw className="mr-2 h-4 w-4" />
                                    Restore
                                  </DropdownMenuItem>
                                ) : null}
                                {(contact.type === "supplier" || contact.type === "both") && contact.is_active && (
                                  <DropdownMenuItem onClick={() => navigate(`/purchases/bills?action=create&contact_id=${contact.id}`)}>
                                    <Plus className="mr-2 h-4 w-4" />
                                    Create Bill
                                  </DropdownMenuItem>
                                )}
                                {(contact.type === "customer" || contact.type === "both") && contact.is_active && (
                                  <DropdownMenuItem onClick={() => navigate(`/sales/invoices?action=create&contact_id=${contact.id}`)}>
                                    <Plus className="mr-2 h-4 w-4" />
                                    Create Invoice
                                  </DropdownMenuItem>
                                )}
                                {contact.is_active && (
                                  <DropdownMenuItem
                                    onClick={() => handleDelete(contact)}
                                    className="text-destructive"
                                  >
                                    <Archive className="mr-2 h-4 w-4" />
                                    Archive
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={() => handleDelete(contact)}
                                  className="text-destructive"
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
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
          </Card>
        )}

        {/* Pagination */}
        {contacts.length > 0 && (
          <DataTablePagination
            pagination={pagination}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            isLoading={isFetching}
          />
        )}

        {/* Add/Edit Dialog */}
        <Dialog open={showDialog} onOpenChange={(open) => {
          if (!open && isGroupsDialogOpen) return; // Don't close if groups dialog is open
          setShowDialog(open);
        }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingContact ? "Edit Contact" : "Add New Contact"}
              </DialogTitle>
              <DialogDescription>
                {editingContact
                  ? "Update the contact details below."
                  : "Fill in the details to add a new contact."}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Roles *</Label>
                  <div className="flex flex-col gap-2 rounded-md border p-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={formData.type === "customer" || formData.type === "both"}
                        onCheckedChange={(checked) => {
                          const isCustomer = checked === true;
                          const isSupplier = formData.type === "supplier" || formData.type === "both";
                          const next = isCustomer && isSupplier ? "both" : isCustomer ? "customer" : isSupplier ? "supplier" : "customer";
                          setFormData({ ...formData, type: next });
                        }}
                      />
                      <span>Is a customer</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={formData.type === "supplier" || formData.type === "both"}
                        onCheckedChange={(checked) => {
                          const isSupplier = checked === true;
                          const isCustomer = formData.type === "customer" || formData.type === "both";
                          const next = isCustomer && isSupplier ? "both" : isSupplier ? "supplier" : isCustomer ? "customer" : "customer";
                          setFormData({ ...formData, type: next });
                        }}
                      />
                      <span>Is a supplier</span>
                    </label>
                    <p className="text-xs text-muted-foreground">
                      At least one role is required. Roles are independent — a single contact can be both.
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="address">Address</Label>
                  <Input
                    id="address"
                    value={formData.address_line1}
                    onChange={(e) =>
                      setFormData({ ...formData, address_line1: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State</Label>
                  <Input
                    id="state"
                    value={formData.state}
                    onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="postal_code">Postal Code</Label>
                  <Input
                    id="postal_code"
                    value={formData.postal_code}
                    onChange={(e) =>
                      setFormData({ ...formData, postal_code: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">Country</Label>
                  <CountryCombobox
                    countries={countries}
                    value={formData.country}
                    onValueChange={(value) => setFormData({ ...formData, country: value })}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={3}
                  />
                </div>
              </div>

              {/* Phase E — Odoo-grade hierarchy: Individual ⇄ Company first, parent second */}
              <div className="pt-4 border-t space-y-4">
                <div>
                  <h4 className="text-sm font-medium mb-1">Contact type</h4>
                  <p className="text-xs text-muted-foreground mb-3">
                    Is this contact a company itself, or an individual that belongs to a company?
                    Statements and credit limits roll up to the company at the top of the hierarchy.
                  </p>
                </div>

                {/* Segmented Individual / Company choice — the FIRST hierarchy decision. */}
                <div
                  role="radiogroup"
                  aria-label="Contact type"
                  className="grid grid-cols-2 gap-2 rounded-lg border p-1"
                >
                  {[
                    { key: "individual", label: "Individual", desc: "A person" },
                    { key: "company", label: "Company", desc: "An organisation" },
                  ].map((opt) => {
                    const active =
                      opt.key === "company" ? formData.is_company : !formData.is_company;
                    return (
                      <button
                        type="button"
                        key={opt.key}
                        role="radio"
                        aria-checked={active}
                        onClick={() => {
                          const willBeCompany = opt.key === "company";
                          setFormData({
                            ...formData,
                            is_company: willBeCompany,
                            // Companies cannot have a parent or an address role.
                            parent_contact_id: willBeCompany ? "none" : formData.parent_contact_id,
                            child_address_type: willBeCompany ? "none" : formData.child_address_type,
                          });
                        }}
                        className={cn(
                          "rounded-md px-3 py-2 text-left text-sm transition-colors",
                          active
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "hover:bg-muted text-foreground"
                        )}
                      >
                        <div className="font-medium">{opt.label}</div>
                        <div className={cn(
                          "text-xs",
                          active ? "text-primary-foreground/80" : "text-muted-foreground"
                        )}>
                          {opt.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Parent picker + address role — ONLY for individuals. */}
                {!formData.is_company && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="parent_contact_id">Works at</Label>
                      <ParentCompanyCombobox
                        value={
                          formData.parent_contact_id === "none"
                            ? null
                            : formData.parent_contact_id
                        }
                        excludeId={editingContact?.id}
                        onValueChange={(id) =>
                          setFormData({
                            ...formData,
                            parent_contact_id: id ?? "none",
                            // Clearing the parent clears the address role.
                            child_address_type: id ? formData.child_address_type : "none",
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Search any existing company, or create a new one inline.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="child_address_type">Role at company</Label>
                      <Select
                        value={formData.child_address_type}
                        onValueChange={(value) =>
                          setFormData({ ...formData, child_address_type: value })
                        }
                        disabled={formData.parent_contact_id === "none"}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="—" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">—</SelectItem>
                          <SelectItem value="contact">Contact person</SelectItem>
                          <SelectItem value="invoice">Invoice address</SelectItem>
                          <SelectItem value="delivery">Delivery address</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </div>


              {(formData.type === "customer" || formData.type === "both") && (
                <CreditManagementSection
                  creditLimit={formData.credit_limit}
                  creditHold={formData.credit_hold}
                  paymentTermId={formData.payment_term_id}
                  customerGroupId={formData.customer_group_id}
                  onCreditLimitChange={(value) => setFormData({ ...formData, credit_limit: value })}
                  onCreditHoldChange={(value) => setFormData({ ...formData, credit_hold: value })}
                  onPaymentTermIdChange={(value) => setFormData({ ...formData, payment_term_id: value })}
                  onCustomerGroupIdChange={(value) => setFormData({ ...formData, customer_group_id: value })}
                  showForType={formData.type as "customer" | "supplier" | "both"}
                  onGroupsDialogChange={setIsGroupsDialogOpen}
                />
              )}

              {(formData.type === "customer" || formData.type === "both") && (
                <div className="pt-4 border-t">
                  <h4 className="text-sm font-medium mb-3">Customer Accounting Defaults</h4>
                  <p className="text-xs text-muted-foreground mb-4">
                    These defaults auto-populate when creating invoices for this customer.
                  </p>
                  <div className="space-y-4">
                    <ProductAccountSelector
                      label="Default Receivable Account"
                      value={formData.default_receivable_account_id}
                      onChange={(v) => setFormData({ ...formData, default_receivable_account_id: v })}
                      accountType="asset"
                      helpText="Override the system AR account for this customer (optional)"
                    />
                  </div>
                </div>
              )}

              {(formData.type === "supplier" || formData.type === "both") && (
                <div className="pt-4 border-t">
                  <h4 className="text-sm font-medium mb-3">Vendor Accounting Defaults</h4>
                  <p className="text-xs text-muted-foreground mb-4">
                    These defaults auto-populate when creating bills for this vendor.
                  </p>
                  <div className="space-y-4">
                    <ProductAccountSelector
                      label="Default Expense Account"
                      value={formData.default_expense_account_id}
                      onChange={(v) => setFormData({ ...formData, default_expense_account_id: v })}
                      accountType="expense"
                      helpText="Debited by default on bills from this vendor"
                    />
                    <ProductAccountSelector
                      label="Default Payable Account"
                      value={formData.default_payable_account_id}
                      onChange={(v) => setFormData({ ...formData, default_payable_account_id: v })}
                      accountType="liability"
                      helpText="Override the system AP account for this vendor (optional)"
                    />
                    <div className="space-y-2">
                      <Label>Withholding Tax Rate (%)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        value={formData.withholding_tax_rate}
                        onChange={(e) => setFormData({ ...formData, withholding_tax_rate: e.target.value })}
                        placeholder="e.g. 5.00"
                      />
                      <p className="text-xs text-muted-foreground">Withholding tax rate applied to payments to this vendor</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Tax Exemption Number</Label>
                      <Input
                        value={formData.tax_exemption_number}
                        onChange={(e) => setFormData({ ...formData, tax_exemption_number: e.target.value })}
                        placeholder="Tax exemption certificate number"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Custom Fields Section */}
              <CustomFieldsSection
                entityType="contact"
                entityId={editingContact?.id || null}
                formValues={formData}
                disabled={isSubmitting}
              />

              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowDialog(false);
                    resetForm();
                  }}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {editingContact ? "Update Contact" : "Add Contact"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Smart Delete/Archive Dialog */}
        {deleteTarget && (
          <ContactDeleteDialog
            open={!!deleteTarget}
            onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
            contactName={deleteTarget.name}
            contactId={deleteTarget.id}
            onDelete={executeDeleteContact}
            onArchive={executeArchiveContact}
          />
        )}

        {/* Bulk Delete Dialog */}
        <BulkDeleteDialog
          open={showBulkDeleteDialog}
          onOpenChange={setShowBulkDeleteDialog}
          count={bulkSelection.selectedCount}
          entityName={bulkSelection.selectedCount === 1 ? "contact" : "contacts"}
          onConfirm={handleBulkDelete}
          isDeleting={isBulkDeleting}
        />

        {/* Bulk Actions Toolbar */}
        <BulkActionsToolbar
          selectedCount={bulkSelection.selectedCount}
          onDelete={canManageContacts ? () => setShowBulkDeleteDialog(true) : undefined}
          onExport={handleBulkExport}
          onClearSelection={bulkSelection.clearSelection}
          isDeleting={isBulkDeleting}
          entityName={bulkSelection.selectedCount === 1 ? "contact" : "contacts"}
        />

        {/* Import Wizard */}
        <ImportWizard
          open={showImportWizard}
          onOpenChange={setShowImportWizard}
          entityName="Contact"
          fieldDefinitions={CONTACT_IMPORT_FIELDS}
          onImport={handleImportContact}
        />

        {/* Merge Dialog */}
        <ContactMergeDialog
          open={showMergeDialog}
          onOpenChange={setShowMergeDialog}
          contacts={contacts}
          onMerged={() => {
            bulkSelection.clearSelection();
          }}
        />

        {/* Bulk Update Dialog */}
        <ContactBulkActions
          open={showBulkUpdateDialog}
          onOpenChange={setShowBulkUpdateDialog}
          selectedIds={bulkSelection.selectedItems.map(c => c.id)}
          onUpdated={() => {
            bulkSelection.clearSelection();
          }}
        />
      </div>
    </>
  );
}

import { useState, useEffect } from "react";
import { usePaymentMethods } from "@/hooks/usePaymentMethods";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Plus, 
  MoreHorizontal, 
  Pencil, 
  Trash2, 
  Star, 
  Building2, 
  Smartphone, 
  CreditCard, 
  Banknote,
  QrCode,
  ArrowUpDown,
  Bitcoin
} from "lucide-react";
import { AddPaymentMethodDialog } from "./AddPaymentMethodDialog";
import { 
  OrganizationPaymentMethod, 
  PAYMENT_METHOD_TYPES,
  type PaymentMethodType
} from "@/types/paymentMethod";
import { normalizeError } from "@/services/resilience";

const typeIcons: Record<PaymentMethodType, React.ReactNode> = {
  bank: <Building2 className="h-4 w-4" />,
  mobile_money: <Smartphone className="h-4 w-4" />,
  online: <CreditCard className="h-4 w-4" />,
  cash: <Banknote className="h-4 w-4" />,
  crypto: <Bitcoin className="h-4 w-4" />,
};

export function PaymentMethodsSettings() {
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const {
    paymentMethods,
    isLoading,
    deletePaymentMethod,
    setDefaultPaymentMethod,
    toggleActivePaymentMethod,
    isDeleting,
  } = usePaymentMethods();
  
  const { accounts: bankAccounts } = useBankAccounts();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingMethod, setEditingMethod] = useState<OrganizationPaymentMethod | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showOnAllDocs, setShowOnAllDocs] = useState(false);
  const [isTogglingGlobal, setIsTogglingGlobal] = useState(false);
  const [hasAutoEnabled, setHasAutoEnabled] = useState(false);

  // Read flag scoped to the SELECTED Company (single source of truth on `businesses`).
  useEffect(() => {
    if (!currentBusiness?.id) {
      setShowOnAllDocs(false);
      return;
    }
    const checkGlobalState = async () => {
      const { data } = await supabase
        .from("businesses")
        .select("show_payment_methods_on_documents")
        .eq("id", currentBusiness.id)
        .maybeSingle();
      if (data) {
        setShowOnAllDocs((data as any).show_payment_methods_on_documents === true);
      }
    };
    checkGlobalState();
  }, [currentBusiness?.id]);

  const handleToggleGlobalPaymentMethods = async (checked: boolean) => {
    if (!currentOrg?.id) return;
    if (!currentBusiness?.id) {
      toast({
        title: "Select a Company",
        description: "Payment-method display is configured per Company.",
        variant: "destructive",
      });
      return;
    }
    setIsTogglingGlobal(true);

    const EXPECTED_TYPES = ['invoice', 'estimate', 'proforma', 'credit_note', 'receipt', 'purchase_order', 'sales_order', 'delivery_note'] as const;

    try {
      // 1. Update Company-scoped flag (single source of truth on `businesses`).
      const { error: orgErr } = await supabase
        .from("businesses")
        .update({ show_payment_methods_on_documents: checked } as any)
        .eq("id", currentBusiness.id);

      if (orgErr) throw orgErr;

      // 2. Also update default templates for THIS Company.
      const { data: existingTemplates, error: fetchErr } = await supabase
        .from("document_templates")
        .select("id, template_type")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_default", true);

      if (fetchErr) throw fetchErr;

      const existingTypes = new Set((existingTemplates || []).map(t => t.template_type));

      const missingTypes = EXPECTED_TYPES.filter(t => !existingTypes.has(t));

      if (missingTypes.length > 0) {
        const now = new Date().toISOString();
        const newTemplates = missingTypes.map(type => ({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          template_type: type,
          template_name: `Default ${type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
          is_default: true,
          is_active: true,
          show_payment_methods: checked,
          logo_position: 'top-left',
          logo_size: 'medium',
          primary_color: '#1a1a2e',
          secondary_color: '#6b7280',
          accent_color: '#3b82f6',
          font_family: 'Inter',
          font_size_base: 14,
          show_company_name: true,
          show_company_address: true,
          show_company_phone: true,
          show_company_email: true,
          show_tax_id: false,
          document_title_format: type.replace(/_/g, ' ').toUpperCase(),
          show_line_numbers: true,
          show_item_description: true,
          show_unit_price: true,
          show_quantity: true,
          show_tax_column: true,
          show_discount_column: false,
          show_subtotals_per_item: false,
          show_subtotal: true,
          show_discount_total: true,
          show_tax_breakdown: true,
          show_total_in_words: false,
          totals_position: 'right',
          show_payment_instructions: true,
          show_bank_details: true,
          show_signature_line: false,
          signature_label: 'Authorized Signature',
          show_terms: true,
          show_status_badge: false,
          watermark_opacity: 0.1,
          background_color: '#ffffff',
          created_at: now,
          updated_at: now,
        }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: insertErr } = await supabase
          .from("document_templates")
          .insert(newTemplates as any);

        if (insertErr) throw insertErr;
      }

      if (existingTemplates && existingTemplates.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: updateErr } = await supabase
          .from("document_templates")
          .update({
            show_payment_methods: checked,
            updated_at: new Date().toISOString(),
          } as any)
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("is_default", true);

        if (updateErr) throw updateErr;
      }

      setShowOnAllDocs(checked);
      toast({
        title: checked ? "Payment methods enabled" : "Payment methods hidden",
        description: checked
          ? "All active payment methods will appear on all documents."
          : "Payment methods will no longer appear on documents by default.",
      });
    } catch (err: unknown) {
      const e = err as Error;
      toast({ title: "Error", description: normalizeError(e).message, variant: "destructive" });
    } finally {
      setIsTogglingGlobal(false);
    }
  };

  const handleDelete = () => {
    if (deletingId) {
      deletePaymentMethod(deletingId);
      setDeletingId(null);
    }
  };

  const getMethodSubtitle = (method: OrganizationPaymentMethod): string => {
    const details = method.details;
    
    switch (method.type) {
      case 'bank':
        return (details as any).bank_name || 'Bank Account';
      case 'mobile_money':
        return (details as any).paybill_number 
          ? `Paybill: ${(details as any).paybill_number}` 
          : (details as any).till_number 
            ? `Till: ${(details as any).till_number}`
            : 'Mobile Money';
      case 'online':
        return (details as any).email || (details as any).username || 'Online Payment';
      case 'cash':
        return 'Cash Payment';
      case 'crypto':
        return (details as any).currency?.toUpperCase() || 'Cryptocurrency';
      default:
        return '';
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Payment Methods
              </CardTitle>
              <CardDescription>
                Configure payment options that appear on your invoices and documents.
                Select which methods to display per document type in Templates.
              </CardDescription>
            </div>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Method
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Global toggle */}
          {paymentMethods.length > 0 && (
            <div className="flex items-center justify-between rounded-lg border p-4 mb-6">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Display payment methods on all documents</p>
                <p className="text-xs text-muted-foreground">
                  When enabled, all active payment methods appear on invoices, sale orders, and proforma invoices by default.
                </p>
              </div>
              <Switch
                checked={showOnAllDocs}
                onCheckedChange={handleToggleGlobalPaymentMethods}
                disabled={isTogglingGlobal}
              />
            </div>
          )}
          {paymentMethods.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <CreditCard className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="font-medium">No payment methods configured</p>
              <p className="text-sm mb-4">
                Add bank accounts, mobile money, or online payment options.
              </p>
              <Button onClick={() => setShowAddDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Payment Method
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <ArrowUpDown className="h-4 w-4" />
                  </TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead className="text-center">Default</TableHead>
                  <TableHead className="text-center">QR</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentMethods.map((method, index) => (
                  <TableRow key={method.id}>
                    <TableCell className="text-muted-foreground">
                      {index + 1}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                          {typeIcons[method.type]}
                        </div>
                        <span className="font-medium">
                          {PAYMENT_METHOD_TYPES[method.type].label}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{method.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {getMethodSubtitle(method)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {method.type === 'bank' && (details => 
                        details?.account_number 
                          ? `****${details.account_number.slice(-4)}`
                          : '-'
                      )(method.details as any)}
                      {method.type === 'mobile_money' && (details =>
                        details?.phone_number || details?.account_number || '-'
                      )(method.details as any)}
                      {method.type === 'online' && (details =>
                        details?.email || details?.payment_link || '-'
                      )(method.details as any)}
                      {method.type === 'crypto' && (details =>
                        details?.wallet_address 
                          ? `${details.wallet_address.slice(0, 8)}...${details.wallet_address.slice(-6)}`
                          : '-'
                      )(method.details as any)}
                    </TableCell>
                    <TableCell className="text-center">
                      {method.is_default ? (
                        <Badge variant="default" className="gap-1">
                          <Star className="h-3 w-3" />
                          Default
                        </Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDefaultPaymentMethod(method.id)}
                        >
                          Set Default
                        </Button>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {method.qr_code_enabled && (
                        <QrCode className="h-4 w-4 mx-auto text-primary" />
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={method.is_active}
                        onCheckedChange={(checked) =>
                          toggleActivePaymentMethod({ id: method.id, is_active: checked })
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditingMethod(method)}>
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit
                          </DropdownMenuItem>
                          {!method.is_default && (
                            <DropdownMenuItem onClick={() => setDefaultPaymentMethod(method.id)}>
                              <Star className="h-4 w-4 mr-2" />
                              Set as Default
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => setDeletingId(method.id)}
                            className="text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AddPaymentMethodDialog
        open={showAddDialog || !!editingMethod}
        onOpenChange={(open) => {
          if (!open) {
            setShowAddDialog(false);
            setEditingMethod(null);
            // Auto-enable payment methods on documents when a method is created/edited
            if (!showOnAllDocs) {
              setTimeout(() => {
                handleToggleGlobalPaymentMethods(true);
              }, 500);
            }
          }
        }}
        editingMethod={editingMethod}
        bankAccounts={bankAccounts}
      />

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Payment Method</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this payment method? 
              It will be removed from all document templates.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * ContactRecordForm — shared record form body used by
 * `ContactCreatePage` (/contacts-app/new) and `ContactEditPage`
 * (/contacts-app/:id/edit).
 *
 * Phase-12 replacement for the ~340-line inline `<Dialog>` that used
 * to live in `src/pages/Contacts.tsx`. Hosts the identical field set
 * on top of `RecordFormShell`, matching the platform-standard
 * create/edit workspace used by Finance (Journal Entry, Bank Account,
 * Budget), Sales (Invoice) and Purchases (Bill).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CountryCombobox } from "@/components/contacts/CountryCombobox";
import { ParentCompanyCombobox } from "@/components/contacts/ParentCompanyCombobox";
import { CreditManagementSection } from "@/components/contacts/CreditManagementSection";
import { ContactAddressBook } from "./ContactAddressBook";
import { AccountSelectField } from "@/components/finance/AccountSelectField";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { useContactsPaginated, type Contact } from "@/hooks/useContactsPaginated";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCountries } from "@/hooks/useCountries";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ContactRecordFormProps {
  mode: "create" | "edit";
  /** Pre-existing contact when editing. */
  initialContact?: Contact | null;
  /** Optional preset role when opening the create page from a filter view. */
  defaultTypeFilter?: "customer" | "supplier" | "both";
}

export function ContactRecordForm({
  mode,
  initialContact = null,
  defaultTypeFilter,
}: ContactRecordFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentBusiness } = useBusinesses();
  const { countries } = useCountries();
  const defaultCountry = currentBusiness?.country || "US";
  const { createContact, updateContact } = useContactsPaginated({});

  const defaultFormType: "customer" | "supplier" | "both" =
    defaultTypeFilter === "customer" || defaultTypeFilter === "supplier"
      ? defaultTypeFilter
      : "customer";

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGroupsDialogOpen, setIsGroupsDialogOpen] = useState(false);
  const [formData, setFormData] = useState(() => ({
    name: initialContact?.name ?? "",
    email: initialContact?.email ?? "",
    phone: initialContact?.phone ?? "",
    type: (initialContact?.type ?? defaultFormType) as
      | "customer"
      | "supplier"
      | "both",
    address_line1: initialContact?.address_line1 ?? "",
    city: initialContact?.city ?? "",
    state: initialContact?.state ?? "",
    postal_code: initialContact?.postal_code ?? "",
    country: initialContact?.country || defaultCountry,
    notes: initialContact?.notes ?? "",
    credit_limit: initialContact?.credit_limit?.toString() ?? "",
    credit_hold: initialContact?.credit_hold ?? false,
    payment_term_id: initialContact?.payment_term_id ?? "none",
    customer_group_id: initialContact?.customer_group_id ?? "none",
    default_expense_account_id:
      initialContact?.default_expense_account_id ?? (null as string | null),
    default_payable_account_id:
      initialContact?.default_payable_account_id ?? (null as string | null),
    default_receivable_account_id:
      (initialContact as any)?.default_receivable_account_id ??
      (null as string | null),
    default_tax_rate_id:
      initialContact?.default_tax_rate_id ?? (null as string | null),
    withholding_tax_rate: initialContact?.withholding_tax_rate?.toString() ?? "",
    tax_exemption_number: initialContact?.tax_exemption_number ?? "",
    parent_contact_id: ((initialContact as any)?.parent_contact_id ??
      "none") as string,
    is_company: ((initialContact as any)?.is_company ?? false) as boolean,
    child_address_type: ((initialContact as any)?.child_address_type ??
      "none") as string,
  }));

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const isCustomer =
        formData.type === "customer" || formData.type === "both";
      const isSupplier =
        formData.type === "supplier" || formData.type === "both";
      const curC = Number((initialContact as any)?.customer_rank ?? 0);
      const curS = Number((initialContact as any)?.supplier_rank ?? 0);
      const submitData = {
        ...formData,
        credit_limit: formData.credit_limit
          ? parseFloat(formData.credit_limit)
          : null,
        payment_term_id:
          formData.payment_term_id === "none" ? null : formData.payment_term_id,
        customer_group_id:
          formData.customer_group_id === "none"
            ? null
            : formData.customer_group_id,
        default_expense_account_id: formData.default_expense_account_id || null,
        default_payable_account_id: formData.default_payable_account_id || null,
        default_tax_rate_id:
          formData.default_tax_rate_id === "none"
            ? null
            : formData.default_tax_rate_id || null,
        withholding_tax_rate: formData.withholding_tax_rate
          ? parseFloat(formData.withholding_tax_rate)
          : null,
        tax_exemption_number: formData.tax_exemption_number || null,
        parent_contact_id:
          formData.parent_contact_id === "none"
            ? null
            : formData.parent_contact_id,
        child_address_type:
          formData.child_address_type === "none"
            ? null
            : (formData.child_address_type as
                | "contact"
                | "invoice"
                | "delivery"
                | "other"),
        is_company: formData.is_company,
        customer_rank: isCustomer ? Math.max(1, curC) : 0,
        supplier_rank: isSupplier ? Math.max(1, curS) : 0,
      };

      if (mode === "edit" && initialContact) {
        await updateContact(initialContact.id, submitData as any);
        toast({ title: "Contact updated successfully" });
        navigate("/contacts-app");
      } else {
        const newContact = await createContact({
          ...submitData,
          is_active: true,
        } as any);
        const contactId = (newContact as any)?.id;
        toast({
          title: "Contact created successfully",
          description:
            submitData.type === "customer" || submitData.type === "both"
              ? "Create an invoice for this customer?"
              : "Create a bill from this supplier?",
          action: (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (submitData.type === "supplier") {
                  navigate(
                    `/purchases/bills?action=create${contactId ? `&contact_id=${contactId}` : ""}`,
                  );
                } else {
                  navigate(
                    `/sales/invoices?action=create${contactId ? `&contact_id=${contactId}` : ""}`,
                  );
                }
              }}
            >
              {submitData.type === "supplier" ? "Create Bill" : "Create Invoice"}
            </Button>
          ),
        });
        navigate("/contacts-app");
      }
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

  return (
    <RecordFormShell
      mode={mode}
      entityLabel="Contact"
      recordRef={initialContact?.name}
      cancelHref="/contacts-app"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Roles *</Label>
            <div className="flex flex-col gap-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={
                    formData.type === "customer" || formData.type === "both"
                  }
                  onCheckedChange={(checked) => {
                    const isCustomer = checked === true;
                    const isSupplier =
                      formData.type === "supplier" ||
                      formData.type === "both";
                    const next =
                      isCustomer && isSupplier
                        ? "both"
                        : isCustomer
                          ? "customer"
                          : isSupplier
                            ? "supplier"
                            : "customer";
                    setFormData({ ...formData, type: next });
                  }}
                />
                <span>Is a customer</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={
                    formData.type === "supplier" || formData.type === "both"
                  }
                  onCheckedChange={(checked) => {
                    const isSupplier = checked === true;
                    const isCustomer =
                      formData.type === "customer" ||
                      formData.type === "both";
                    const next =
                      isCustomer && isSupplier
                        ? "both"
                        : isSupplier
                          ? "supplier"
                          : isCustomer
                            ? "customer"
                            : "customer";
                    setFormData({ ...formData, type: next });
                  }}
                />
                <span>Is a supplier</span>
              </label>
              <p className="text-xs text-muted-foreground">
                At least one role is required. Roles are independent — a
                single contact can be both.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) =>
                setFormData({ ...formData, email: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              value={formData.phone}
              onChange={(e) =>
                setFormData({ ...formData, phone: e.target.value })
              }
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
              onChange={(e) =>
                setFormData({ ...formData, city: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="state">State</Label>
            <Input
              id="state"
              value={formData.state}
              onChange={(e) =>
                setFormData({ ...formData, state: e.target.value })
              }
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
              onValueChange={(value) =>
                setFormData({ ...formData, country: value })
              }
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) =>
                setFormData({ ...formData, notes: e.target.value })
              }
              rows={3}
            />
          </div>
        </div>

        {/* Odoo-grade hierarchy: Individual ⇄ Company */}
        <div className="pt-4 border-t space-y-4">
          <div>
            <h4 className="text-sm font-medium mb-1">Contact type</h4>
            <p className="text-xs text-muted-foreground mb-3">
              Is this contact a company itself, or an individual that belongs
              to a company? Statements and credit limits roll up to the
              company at the top of the hierarchy.
            </p>
          </div>
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
                opt.key === "company"
                  ? formData.is_company
                  : !formData.is_company;
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
                      parent_contact_id: willBeCompany
                        ? "none"
                        : formData.parent_contact_id,
                      child_address_type: willBeCompany
                        ? "none"
                        : formData.child_address_type,
                    });
                  }}
                  className={cn(
                    "rounded-md px-3 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "hover:bg-muted text-foreground",
                  )}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div
                    className={cn(
                      "text-xs",
                      active
                        ? "text-primary-foreground/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {opt.desc}
                  </div>
                </button>
              );
            })}
          </div>

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
                  excludeId={initialContact?.id}
                  onValueChange={(id) =>
                    setFormData({
                      ...formData,
                      parent_contact_id: id ?? "none",
                      child_address_type: id
                        ? formData.child_address_type
                        : "none",
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

        {/* Saved addresses — only for an existing ROOT party. A child
            address row cannot own an address book of its own. */}
        {mode === "edit" &&
          initialContact?.id &&
          formData.parent_contact_id === "none" && (
            <ContactAddressBook
              contactId={initialContact.id}
              partyName={formData.name}
            />
          )}

        {(formData.type === "customer" || formData.type === "both") && (
          <CreditManagementSection
            creditLimit={formData.credit_limit}
            creditHold={formData.credit_hold}
            paymentTermId={formData.payment_term_id}
            customerGroupId={formData.customer_group_id}
            onCreditLimitChange={(value) =>
              setFormData({ ...formData, credit_limit: value })
            }
            onCreditHoldChange={(value) =>
              setFormData({ ...formData, credit_hold: value })
            }
            onPaymentTermIdChange={(value) =>
              setFormData({ ...formData, payment_term_id: value })
            }
            onCustomerGroupIdChange={(value) =>
              setFormData({ ...formData, customer_group_id: value })
            }
            showForType={formData.type as "customer" | "supplier" | "both"}
            onGroupsDialogChange={setIsGroupsDialogOpen}
          />
        )}

        {(formData.type === "customer" || formData.type === "both") && (
          <div className="pt-4 border-t">
            <h4 className="text-sm font-medium mb-3">
              Customer Accounting Defaults
            </h4>
            <p className="text-xs text-muted-foreground mb-4">
              These defaults auto-populate when creating invoices for this
              customer.
            </p>
            <div className="space-y-4">
              <AccountSelectField
                label="Default Receivable Account"
                value={formData.default_receivable_account_id}
                onChange={(v) =>
                  setFormData({
                    ...formData,
                    default_receivable_account_id: v,
                  })
                }
                accountType="asset"
                defaultKey="accounts_receivable_id"
                helpText="Override the system AR account for this customer (optional)"
              />
            </div>
          </div>
        )}

        {(formData.type === "supplier" || formData.type === "both") && (
          <div className="pt-4 border-t">
            <h4 className="text-sm font-medium mb-3">
              Vendor Accounting Defaults
            </h4>
            <p className="text-xs text-muted-foreground mb-4">
              These defaults auto-populate when creating bills for this
              vendor.
            </p>
            <div className="space-y-4">
              <AccountSelectField
                label="Default Expense Account"
                value={formData.default_expense_account_id}
                onChange={(v) =>
                  setFormData({ ...formData, default_expense_account_id: v })
                }
                accountType="expense"
                defaultKey="operating_expenses_id"
                helpText="Debited by default on bills from this vendor"
              />
              <AccountSelectField
                label="Default Payable Account"
                value={formData.default_payable_account_id}
                onChange={(v) =>
                  setFormData({ ...formData, default_payable_account_id: v })
                }
                accountType="liability"
                defaultKey="accounts_payable_id"
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
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      withholding_tax_rate: e.target.value,
                    })
                  }
                  placeholder="e.g. 5.00"
                />
                <p className="text-xs text-muted-foreground">
                  Withholding tax rate applied to payments to this vendor
                </p>
              </div>
              <div className="space-y-2">
                <Label>Tax Exemption Number</Label>
                <Input
                  value={formData.tax_exemption_number}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      tax_exemption_number: e.target.value,
                    })
                  }
                  placeholder="Tax exemption certificate number"
                />
              </div>
            </div>
          </div>
        )}

        <CustomFieldsSection
          entityType="contact"
          entityId={initialContact?.id || null}
          formValues={formData}
          disabled={isSubmitting}
        />

        {isSubmitting && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving contact…
          </div>
        )}
        {isGroupsDialogOpen && null}
      </div>
    </RecordFormShell>
  );
}

export default ContactRecordForm;
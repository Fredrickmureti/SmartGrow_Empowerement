import { useState, useEffect } from "react";
import { makeCustomerPaymentRequestId } from "@/components/payments/RecordCustomerPaymentDialog";
import { usePayments, Payment } from "@/hooks/usePayments";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { isMpesaSupported } from "@/lib/regionConfig";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { applyPartyScope } from "@/lib/contactAddresses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { FieldGrid, FieldGroup } from "@/design-system/primitives/FieldGrid";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Loader2, ArrowRight, ChevronsUpDown, Check, Banknote, Landmark } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { normalizeError } from "@/services/resilience";

interface AdvancePaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface Contact {
  id: string;
  name: string;
  company: string | null;
}

export function AdvancePaymentDialog({
  open,
  onOpenChange,
  onSuccess,
}: AdvancePaymentDialogProps) {
  const { recordAdvancePayment } = usePayments();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const { accounts: allAccounts } = useAccounts();
  const showMpesa = isMpesaSupported(currentBusiness?.country ?? null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [depositAccountId, setDepositAccountId] = useState("");

  // Filter to asset accounts only for deposit
  const assetAccounts = allAccounts.filter(a => a.account_type === "asset" && a.is_active);

  const getDepositAccountForMethod = (method: string): string => {
    switch (method) {
      case "cash":
        return defaultAccounts.cash_account_id || defaultAccounts.bank_account_id || "";
      case "bank_transfer":
      case "check":
        return defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "credit_card":
        return defaultAccounts.credit_card_clearing_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "mpesa":
        return defaultAccounts.mpesa_account_id || defaultAccounts.mobile_money_account_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "mobile_money":
        return defaultAccounts.mobile_money_account_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      default:
        return defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
    }
  };

  const [formData, setFormData] = useState({
    contact_id: "",
    amount: 0,
    payment_date: format(new Date(), "yyyy-MM-dd"),
    payment_method: "bank_transfer" as Payment["payment_method"],
    reference: "",
    notes: "",
  });

  const selectedContact = contacts.find((c) => c.id === formData.contact_id);

  // Fetch customers when dialog opens
  useEffect(() => {
    if (open && currentOrg?.id) {
      const fetchContacts = async () => {
        // Phase 7: rank-aware filter. The legacy `.eq("type","customer")`
        // silently hid contacts whose row carried only `customer_rank>0`
        // with a null `type`. Same OR shape used by `useContactsPaginated`
        // so the lookup stays consistent with every other customer picker.
        const { data } = await (applyPartyScope(
          supabase
            .from("contacts")
            .select("id, name, company"),
        )
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id) as any)
          .or("customer_rank.gt.0,type.eq.customer,type.eq.both")
          .eq("is_active", true)
          .order("name");
        setContacts(data || []);
      };
      fetchContacts();
      const defaultMethod = "bank_transfer";
      setFormData({
        contact_id: "",
        amount: 0,
        payment_date: format(new Date(), "yyyy-MM-dd"),
        payment_method: defaultMethod,
        reference: "",
        notes: "",
      });
      setDepositAccountId(getDepositAccountForMethod(defaultMethod));
    }
  }, [open, currentOrg?.id, currentBusiness?.id]);

  // Update deposit account when payment method changes
  useEffect(() => {
    setDepositAccountId(getDepositAccountForMethod(formData.payment_method));
  }, [formData.payment_method, defaultAccounts]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.contact_id || formData.amount <= 0) return;

    if (!depositAccountId) {
      toast({
        title: "Deposit account required",
        description: "Please select the GL account that will receive these funds.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await recordAdvancePayment({
        contact_id: formData.contact_id,
        amount: formData.amount,
        payment_date: formData.payment_date,
        payment_method: formData.payment_method,
        reference: formData.reference || undefined,
        notes: formData.notes || undefined,
        deposit_account_id: depositAccountId,
        // Deterministic on the deposit intent — a double-click or a retry
        // after a timeout replays the same deposit instead of minting a
        // second one. Never `crypto.randomUUID()`.
        requestId: makeCustomerPaymentRequestId({
          contactId: formData.contact_id,
          allocations: [],
          totalCents: Math.round(formData.amount * 100),
          paymentDate: formData.payment_date,
          depositAccountId,
        }),
      });


      toast({
        title: "Advance payment recorded",
        description: `${formatCurrency(formData.amount)} received from ${selectedContact?.name}. Credit note ${result.credit_note_number} created.`,
      });

      onOpenChange(false);
      onSuccess();
    } catch (error: any) {
      toast({
        title: "Error recording advance payment",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Find selected deposit account for preview
  const selectedDepositAccount = assetAccounts.find(a => a.id === depositAccountId);
  const depositAccountLabel = selectedDepositAccount
    ? `${selectedDepositAccount.code} - ${selectedDepositAccount.name}`
    : "Cash/Bank";

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Banknote className="h-5 w-5" />
          Receive Advance Payment
        </span>
      }
      description="Record a payment received before an invoice is created. This creates a customer credit that can be applied to future invoices."
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          }
          trailing={
            <Button
              type="submit"
              form="advance-payment-form"
              disabled={isSubmitting || formData.amount <= 0 || !formData.contact_id || !depositAccountId}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Advance Payment
            </Button>
          }
        />
      }
    >
      <form id="advance-payment-form" onSubmit={handleSubmit} className="space-y-6">
        <FieldGroup label="Customer & Amount">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label>Customer *</Label>
              <Popover open={contactsOpen} onOpenChange={setContactsOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className="w-full justify-between font-normal"
                  >
                    {selectedContact
                      ? selectedContact.name
                      : "Select customer..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-full p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search customers..." />
                    <CommandList>
                      <CommandEmpty>No customers found.</CommandEmpty>
                      <CommandGroup>
                        {contacts.map((contact) => (
                          <CommandItem
                            key={contact.id}
                            value={contact.name}
                            onSelect={() => {
                              setFormData({ ...formData, contact_id: contact.id });
                              setContactsOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                formData.contact_id === contact.id ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div>
                              <div>{contact.name}</div>
                              {contact.company && (
                                <div className="text-xs text-muted-foreground">{contact.company}</div>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label htmlFor="adv-amount">Amount *</Label>
              <Input
                id="adv-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={formData.amount || ""}
                onChange={(e) =>
                  setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })
                }
                placeholder="0.00"
                required
              />
            </div>
          </FieldGrid>
        </FieldGroup>

        <FieldGroup label="Payment Details">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label htmlFor="adv-date">Payment Date *</Label>
              <Input
                id="adv-date"
                type="date"
                value={formData.payment_date}
                onChange={(e) =>
                  setFormData({ ...formData, payment_date: e.target.value })
                }
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="adv-method">Method *</Label>
              <Select
                value={formData.payment_method}
                onValueChange={(value: Payment["payment_method"]) =>
                  setFormData({ ...formData, payment_method: value })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  {showMpesa && <SelectItem value="mpesa">M-Pesa</SelectItem>}
                  <SelectItem value="mobile_money">Mobile Money</SelectItem>
                  <SelectItem value="credit_card">Credit Card</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label className="flex items-center gap-1.5">
                <Landmark className="h-3.5 w-3.5" />
                Deposit To *
              </Label>
              <AccountCombobox
                accounts={assetAccounts}
                value={depositAccountId}
                onValueChange={setDepositAccountId}
                placeholder="Select deposit account..."
              />
              <p className="text-xs text-muted-foreground">
                The GL account that will be debited for this advance
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="adv-reference">Reference / Transaction ID</Label>
              <Input
                id="adv-reference"
                value={formData.reference}
                onChange={(e) =>
                  setFormData({ ...formData, reference: e.target.value })
                }
                placeholder="e.g., TXN-12345"
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="adv-notes">Notes</Label>
              <Textarea
                id="adv-notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={2}
                placeholder="Optional notes…"
              />
            </div>
          </FieldGrid>
        </FieldGroup>

        {formData.amount > 0 && formData.contact_id && (
          <Card className="border-dashed border-primary/40 bg-primary/5">
            <CardContent className="p-3 text-sm space-y-1">
              <div className="flex items-center gap-2 font-medium">
                <ArrowRight className="h-4 w-4 text-primary" />
                Journal Entry Preview
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-1 text-xs text-muted-foreground pl-6">
                <span>Dr {depositAccountLabel}</span>
                <span className="text-right font-mono">{formatCurrency(formData.amount)}</span>
                <span>Cr Customer Advance</span>
                <span className="text-right font-mono">{formatCurrency(formData.amount)}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 pl-6">
                A credit note will be auto-created. Apply it to future invoices.
              </p>
            </CardContent>
          </Card>
        )}
      </form>
    </DetailSheet>
  );
}

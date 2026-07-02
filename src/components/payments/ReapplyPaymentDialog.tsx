// @ts-nocheck
import { useState, useEffect } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTransactionReversal } from "@/hooks/useTransactionReversal";
import { useCurrency } from "@/hooks/useCurrency";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { ArrowRightLeft, Loader2 } from "lucide-react";

interface ReapplyPaymentDialogProps {
  payment: {
    id: string;
    receipt_number: string;
    amount: number;
    contact_id: string | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface UnpaidInvoice {
  id: string;
  invoice_number: string;
  total: number;
  amount_paid: number;
  contact?: { name: string } | null;
}

export function ReapplyPaymentDialog({
  payment,
  open,
  onOpenChange,
  onSuccess,
}: ReapplyPaymentDialogProps) {
  const [reason, setReason] = useState("Payment re-applied to correct invoice");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [unpaidInvoices, setUnpaidInvoices] = useState<UnpaidInvoice[]>([]);
  const [isLoadingInvoices, setIsLoadingInvoices] = useState(false);
  
  const { reapplyPayment } = useTransactionReversal();
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Fetch unpaid invoices when dialog opens
  useEffect(() => {
    if (open && currentOrg) {
      fetchUnpaidInvoices();
    }
  }, [open, currentOrg]);

  const fetchUnpaidInvoices = async () => {
    if (!currentOrg) return;
    
    setIsLoadingInvoices(true);
    try {
      let q = supabase
        .from("invoices")
        .select(`
          id,
          invoice_number,
          total,
          amount_paid,
          contact:contacts(name)
        `)
        .eq("organization_id", currentOrg.id)
        .in("status", ["sent", "viewed", "partial", "overdue"])
        .order("created_at", { ascending: false });
      q = q.eq("business_id", currentBusiness!.id);
      const { data, error } = await q;

      if (error) throw error;
      setUnpaidInvoices(data as UnpaidInvoice[]);
    } catch (error) {
      console.error("Error fetching unpaid invoices:", error);
    } finally {
      setIsLoadingInvoices(false);
    }
  };

  const handleReapply = async () => {
    if (!payment || !selectedInvoiceId || !reason.trim()) return;

    setIsSubmitting(true);
    try {
      const success = await reapplyPayment({
        paymentId: payment.id,
        newInvoiceId: selectedInvoiceId,
        reason: reason.trim(),
      });

      if (success) {
        setReason("Payment re-applied to correct invoice");
        setSelectedInvoiceId("");
        onOpenChange(false);
        onSuccess?.();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!payment) return null;

  const selectedInvoice = unpaidInvoices.find(inv => inv.id === selectedInvoiceId);

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5 text-primary" />
          Re-apply Payment
        </span>
      }
      description={<>Apply payment <strong>{payment.receipt_number}</strong> to a different invoice</>}
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
          }
          trailing={
            <Button onClick={handleReapply} disabled={isSubmitting || !selectedInvoiceId}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Re-apply Payment
            </Button>
          }
        />
      }
    >


        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Payment Amount:</span>
              <span className="font-medium text-green-600">
                {formatCurrency(payment.amount)}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="invoice">
              Select Invoice to Apply Payment <span className="text-destructive">*</span>
            </Label>
            {isLoadingInvoices ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Select value={selectedInvoiceId} onValueChange={setSelectedInvoiceId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an invoice..." />
                </SelectTrigger>
                <SelectContent>
                  {unpaidInvoices.map((invoice) => (
                    <SelectItem key={invoice.id} value={invoice.id}>
                      <div className="flex items-center justify-between gap-4">
                        <span>{invoice.invoice_number}</span>
                        <span className="text-muted-foreground text-xs">
                          {invoice.contact?.name || "No customer"} — 
                          Due: {formatCurrency(invoice.total - invoice.amount_paid)}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {selectedInvoice && (
            <div className="rounded-lg border p-4 space-y-2 text-sm bg-muted/50">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Invoice Total:</span>
                <span className="font-medium">{formatCurrency(selectedInvoice.total)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Already Paid:</span>
                <span className="font-medium">{formatCurrency(selectedInvoice.amount_paid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Balance Due:</span>
                <span className="font-medium text-amber-600">
                  {formatCurrency(selectedInvoice.total - selectedInvoice.amount_paid)}
                </span>
              </div>
              <div className="flex justify-between border-t pt-2 mt-2">
                <span className="text-muted-foreground">After Payment:</span>
                <span className={`font-medium ${
                  selectedInvoice.total - selectedInvoice.amount_paid - payment.amount <= 0 
                    ? "text-green-600" 
                    : "text-amber-600"
                }`}>
                  {formatCurrency(
                    Math.max(0, selectedInvoice.total - selectedInvoice.amount_paid - payment.amount)
                  )}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="reason">
              Reason for Re-applying
            </Label>
            <Textarea
              id="reason"
              placeholder="e.g., Payment was applied to wrong invoice"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
      </div>
    </DetailSheet>
  );
}


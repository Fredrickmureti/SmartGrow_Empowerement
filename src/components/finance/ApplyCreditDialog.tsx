/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useMemo } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useInvoices } from "@/hooks/useInvoices";
import { useCreditNotes } from "@/hooks/useCreditNotes";
import { useCurrency } from "@/hooks/useCurrency";
import { useToast } from "@/hooks/use-toast";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { Loader2, FileText, ArrowRight } from "lucide-react";
import { format, parseISO } from "date-fns";
import { normalizeError } from "@/services/resilience";

interface ApplyCreditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creditNoteId: string;
  creditNoteNumber: string;
  contactId: string;
  contactName: string;
  availableAmount: number;
  onSuccess?: () => void;
}

export function ApplyCreditDialog({
  open,
  onOpenChange,
  creditNoteId,
  creditNoteNumber,
  contactId,
  contactName,
  availableAmount,
  onSuccess,
}: ApplyCreditDialogProps) {
  const { invoices } = useInvoices();
  const { applyCreditToInvoice } = useCreditNotes();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const { branchId } = useFinanceScope();

  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [isApplying, setIsApplying] = useState(false);

  // Open invoices for this contact, branch-scoped: when a branch is active
  // we only show invoices that belong to that branch (or legacy NULL-branch
  // rows). This mirrors the RPC's cross-branch guard so the UX never
  // surfaces an invoice the server would refuse.
  const openInvoices = useMemo(
    () =>
      invoices.filter((inv: any) => {
        if (inv.contact_id !== contactId) return false;
        if (inv.status === "paid" || inv.status === "cancelled" || inv.status === "draft") return false;
        if ((inv.total || 0) - (inv.amount_paid || 0) <= 0) return false;
        if (branchId && inv.branch_id && inv.branch_id !== branchId) return false;
        return true;
      }),
    [invoices, contactId, branchId]
  );

  const selectedInvoice = openInvoices.find((i) => i.id === selectedInvoiceId);
  const invoiceBalance = selectedInvoice
    ? (selectedInvoice.total || 0) - (selectedInvoice.amount_paid || 0)
    : 0;
  const maxApplicable = Math.min(availableAmount, invoiceBalance);
  const parsedAmount = parseFloat(amount) || 0;

  const handleApply = async () => {
    if (!selectedInvoiceId || parsedAmount <= 0) return;
    if (parsedAmount > maxApplicable) {
      toast({ title: "Amount exceeds maximum applicable", variant: "destructive" });
      return;
    }

    setIsApplying(true);
    try {
      await applyCreditToInvoice(creditNoteId, selectedInvoiceId, parsedAmount, notes || undefined, branchId);
      toast({ title: "Credit applied successfully" });
      onOpenChange(false);
      setSelectedInvoiceId("");
      setAmount("");
      setNotes("");
      onSuccess?.();
    } catch (err: any) {
      toast({ title: "Failed to apply credit", description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <ArrowRight className="h-5 w-5" />
          Apply Credit to Invoice
        </span>
      }
      description={
        <>Apply credit from <span className="font-mono font-semibold">{creditNoteNumber}</span> to an open invoice for {contactName}</>
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          }
          trailing={
            <Button
              onClick={handleApply}
              disabled={!selectedInvoiceId || parsedAmount <= 0 || parsedAmount > maxApplicable || isApplying}
            >
              {isApplying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Apply {parsedAmount > 0 ? formatCurrency(parsedAmount) : "Credit"}
            </Button>
          }
        />
      }
    >



        <div className="space-y-4">
          <div className="rounded-md bg-muted/50 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Available Credit</span>
              <span className="font-semibold text-primary">{formatCurrency(availableAmount)}</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Invoice</Label>
            {openInvoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open invoices for this customer.</p>
            ) : (
              <Select value={selectedInvoiceId} onValueChange={(v) => { setSelectedInvoiceId(v); setAmount(""); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an invoice..." />
                </SelectTrigger>
                <SelectContent>
                  {openInvoices.map((inv) => (
                    <SelectItem key={inv.id} value={inv.id}>
                      <span className="font-mono text-xs mr-2">{inv.invoice_number}</span>
                      <span className="text-muted-foreground">
                        Balance: {formatCurrency((inv.total || 0) - (inv.amount_paid || 0))}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {selectedInvoiceId && (
            <>
              <div className="rounded-md bg-muted/50 p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Invoice Balance</span>
                  <span className="font-medium">{formatCurrency(invoiceBalance)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Max Applicable</span>
                  <span className="font-semibold">{formatCurrency(maxApplicable)}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Amount to Apply</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={maxApplicable}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={`Max: ${maxApplicable.toFixed(2)}`}
                />
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setAmount(maxApplicable.toFixed(2))}
                >
                  Apply maximum ({formatCurrency(maxApplicable)})
                </Button>
              </div>

              <div className="space-y-2">
                <Label>Notes (optional)</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Application notes..."
                  rows={2}
                />
              </div>
            </>
          )}
        </div>
    </DetailSheet>
  );
}


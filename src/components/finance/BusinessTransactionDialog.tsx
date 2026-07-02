import { useState } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useBusinessTransactions, BusinessTransactionType } from "@/hooks/useBusinessTransactions";
import { useAccounts } from "@/hooks/useAccounts";
import { format } from "date-fns";
import { Loader2, ArrowRightLeft, PiggyBank, TrendingDown, Landmark, CreditCard } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType?: BusinessTransactionType;
}

const TRANSACTION_TYPES: { value: BusinessTransactionType; label: string; icon: React.ElementType; description: string }[] = [
  { value: "owner_investment", label: "Owner Investment", icon: PiggyBank, description: "Record capital injected into the business" },
  { value: "owner_drawing", label: "Owner Drawing", icon: TrendingDown, description: "Record cash withdrawn by the owner" },
  { value: "bank_transfer", label: "Bank Transfer", icon: ArrowRightLeft, description: "Transfer funds between your bank accounts" },
  { value: "loan_received", label: "Loan Received", icon: Landmark, description: "Record a loan deposited into your bank" },
  { value: "loan_payment", label: "Loan Payment", icon: CreditCard, description: "Record a loan repayment with principal + interest" },
];

export function BusinessTransactionDialog({ open, onOpenChange, defaultType }: Props) {
  const { recordTransaction } = useBusinessTransactions();
  const { accounts } = useAccounts();
  const [type, setType] = useState<BusinessTransactionType>(defaultType || "owner_investment");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [memo, setMemo] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [equityAccountId, setEquityAccountId] = useState("");
  const [fromBankAccountId, setFromBankAccountId] = useState("");
  const [toBankAccountId, setToBankAccountId] = useState("");
  const [loanAccountId, setLoanAccountId] = useState("");
  const [interestAmount, setInterestAmount] = useState("");
  const [interestAccountId, setInterestAccountId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = () => {
    setAmount(""); setMemo(""); setBankAccountId(""); setEquityAccountId("");
    setFromBankAccountId(""); setToBankAccountId(""); setLoanAccountId("");
    setInterestAmount(""); setInterestAccountId("");
  };

  const handleSubmit = async () => {
    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount <= 0) return;

    setIsSubmitting(true);
    try {
      const result = await recordTransaction({
        type,
        amount: numAmount,
        date,
        memo,
        bankAccountId,
        equityAccountId,
        fromBankAccountId,
        toBankAccountId,
        loanAccountId,
        interestAmount: interestAmount ? parseFloat(interestAmount) : undefined,
        interestAccountId,
      });

      if (result) {
        resetForm();
        onOpenChange(false);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedType = TRANSACTION_TYPES.find(t => t.value === type);

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Record Business Transaction"
      description="Guided form — no debit/credit knowledge needed"
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <Button onClick={handleSubmit} disabled={isSubmitting || !amount || parseFloat(amount) <= 0}>
              {isSubmitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Recording...</> : "Record Transaction"}
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">

          {/* Transaction Type */}
          <div className="space-y-2">
            <Label>Transaction Type</Label>
            <Select value={type} onValueChange={(v) => { setType(v as BusinessTransactionType); resetForm(); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TRANSACTION_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value}>
                    <span className="flex items-center gap-2">
                      <t.icon className="h-4 w-4" />
                      {t.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedType && <p className="text-xs text-muted-foreground">{selectedType.description}</p>}
          </div>

          {/* Common fields */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Amount</Label>
              <Input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
          </div>

          {/* Type-specific fields */}
          {(type === "owner_investment" || type === "owner_drawing") && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Bank / Cash Account</Label>
                <AccountCombobox accounts={accounts} value={bankAccountId} onValueChange={setBankAccountId} placeholder="Select bank account..." allowedTypes={["asset"]} />
              </div>
              <div className="space-y-1.5">
                <Label>{type === "owner_investment" ? "Equity Account" : "Owner's Drawing / Equity Account"}</Label>
                <AccountCombobox accounts={accounts} value={equityAccountId} onValueChange={setEquityAccountId} placeholder="Select equity account..." allowedTypes={["equity"]} />
                <p className="text-xs text-muted-foreground">
                  Only Equity accounts are allowed here — owner contributions and drawings affect equity, not assets.
                </p>
              </div>
            </div>
          )}

          {type === "bank_transfer" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Transfer From (Source)</Label>
                <AccountCombobox accounts={accounts} value={fromBankAccountId} onValueChange={setFromBankAccountId} placeholder="Select source bank..." allowedTypes={["asset"]} />
              </div>
              <div className="space-y-1.5">
                <Label>Transfer To (Destination)</Label>
                <AccountCombobox accounts={accounts} value={toBankAccountId} onValueChange={setToBankAccountId} placeholder="Select destination bank..." allowedTypes={["asset"]} />
              </div>
            </div>
          )}

          {(type === "loan_received" || type === "loan_payment") && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Bank / Cash Account</Label>
                <AccountCombobox accounts={accounts} value={bankAccountId} onValueChange={setBankAccountId} placeholder="Select bank account..." allowedTypes={["asset"]} />
              </div>
              <div className="space-y-1.5">
                <Label>Loan Account (Liability)</Label>
                <AccountCombobox accounts={accounts} value={loanAccountId} onValueChange={setLoanAccountId} placeholder="Select loan account..." allowedTypes={["liability"]} />
              </div>
              {type === "loan_payment" && (
                <>
                  <div className="space-y-1.5">
                    <Label>Interest Portion (optional)</Label>
                    <Input type="number" min="0" step="0.01" value={interestAmount} onChange={e => setInterestAmount(e.target.value)} placeholder="0.00" />
                  </div>
                  {interestAmount && parseFloat(interestAmount) > 0 && (
                    <div className="space-y-1.5">
                      <Label>Interest Expense Account</Label>
                      <AccountCombobox accounts={accounts} value={interestAccountId} onValueChange={setInterestAccountId} placeholder="Select interest expense account..." allowedTypes={["expense"]} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Memo (optional)</Label>
            <Textarea value={memo} onChange={e => setMemo(e.target.value)} placeholder="Description of this transaction..." rows={2} />
          </div>
      </div>
    </DetailSheet>

  );
}

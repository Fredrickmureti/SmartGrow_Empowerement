/**
 * BusinessTransactionCreatePage — routed guided-post surface at
 * `/finance/business-transactions/new`. Composes `RecordFormShell`
 * with the guided 5-type form previously in the legacy
 * `BusinessTransactionDialog`. All `useBusinessTransactions`
 * business logic (account validation, GL posting via `postToGL`,
 * toast wording, reference generation) is preserved verbatim.
 *
 * Deep-linkable via `?type=<owner_investment|owner_drawing|
 * bank_transfer|loan_received|loan_payment>`.
 */
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { ArrowRightLeft, PiggyBank, TrendingDown, Landmark, CreditCard } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import {
  useBusinessTransactions,
  type BusinessTransactionType,
} from "@/hooks/useBusinessTransactions";

const TRANSACTION_TYPES: {
  value: BusinessTransactionType;
  label: string;
  icon: React.ElementType;
  description: string;
}[] = [
  { value: "owner_investment", label: "Owner Investment", icon: PiggyBank, description: "Record capital injected into the business" },
  { value: "owner_drawing", label: "Owner Drawing", icon: TrendingDown, description: "Record cash withdrawn by the owner" },
  { value: "bank_transfer", label: "Bank Transfer", icon: ArrowRightLeft, description: "Transfer funds between your bank accounts" },
  { value: "loan_received", label: "Loan Received", icon: Landmark, description: "Record a loan deposited into your bank" },
  { value: "loan_payment", label: "Loan Payment", icon: CreditCard, description: "Record a loan repayment with principal + interest" },
];

const VALID_TYPES = new Set<BusinessTransactionType>(
  TRANSACTION_TYPES.map((t) => t.value),
);

export default function BusinessTransactionCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { recordTransaction } = useBusinessTransactions();
  const { accounts } = useAccounts();

  const initialType = (() => {
    const raw = searchParams.get("type") as BusinessTransactionType | null;
    return raw && VALID_TYPES.has(raw) ? raw : "owner_investment";
  })();

  const [type, setType] = useState<BusinessTransactionType>(initialType);
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

  const resetTypeFields = () => {
    setBankAccountId("");
    setEquityAccountId("");
    setFromBankAccountId("");
    setToBankAccountId("");
    setLoanAccountId("");
    setInterestAmount("");
    setInterestAccountId("");
  };

  const selectedType = TRANSACTION_TYPES.find((t) => t.value === type);
  const parsedAmount = parseFloat(amount);
  const submitDisabled = !amount || Number.isNaN(parsedAmount) || parsedAmount <= 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) return;
    setIsSubmitting(true);
    try {
      const result = await recordTransaction({
        type,
        amount: parsedAmount,
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
        navigate(`/finance/journal-entries/${result}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Business Transaction"
      meta={selectedType?.description}
      cancelHref="/finance/dashboard"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={submitDisabled}
      submitLabel={isSubmitting ? "Recording…" : "Record Transaction"}
    >
      <Section
        title="Transaction"
        description="Guided form — no debit/credit knowledge needed"
      >
        <FieldGrid columns={3}>
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="bt_type">Transaction Type *</Label>
              <Select
                value={type}
                onValueChange={(v) => {
                  setType(v as BusinessTransactionType);
                  resetTypeFields();
                }}
              >
                <SelectTrigger id="bt_type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRANSACTION_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      <span className="flex items-center gap-2">
                        <t.icon className="h-4 w-4" />
                        {t.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FieldCell>
          <div className="space-y-2">
            <Label htmlFor="bt_amount">Amount *</Label>
            <Input
              id="bt_amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bt_date">Date *</Label>
            <Input
              id="bt_date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </FieldGrid>
      </Section>

      {(type === "owner_investment" || type === "owner_drawing") && (
        <Section title="Accounts">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label>Bank / Cash Account *</Label>
              <AccountCombobox
                accounts={accounts}
                value={bankAccountId}
                onValueChange={setBankAccountId}
                placeholder="Select bank account..."
                allowedTypes={["asset"]}
              />
            </div>
            <div className="space-y-2">
              <Label>
                {type === "owner_investment"
                  ? "Equity Account *"
                  : "Owner's Drawing / Equity Account *"}
              </Label>
              <AccountCombobox
                accounts={accounts}
                value={equityAccountId}
                onValueChange={setEquityAccountId}
                placeholder="Select equity account..."
                allowedTypes={["equity"]}
              />
              <p className="text-xs text-muted-foreground">
                Only Equity accounts are allowed here — owner contributions and drawings affect equity, not assets.
              </p>
            </div>
          </FieldGrid>
        </Section>
      )}

      {type === "bank_transfer" && (
        <Section title="Accounts">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label>Transfer From (Source) *</Label>
              <AccountCombobox
                accounts={accounts}
                value={fromBankAccountId}
                onValueChange={setFromBankAccountId}
                placeholder="Select source bank..."
                allowedTypes={["asset"]}
              />
            </div>
            <div className="space-y-2">
              <Label>Transfer To (Destination) *</Label>
              <AccountCombobox
                accounts={accounts}
                value={toBankAccountId}
                onValueChange={setToBankAccountId}
                placeholder="Select destination bank..."
                allowedTypes={["asset"]}
              />
            </div>
          </FieldGrid>
        </Section>
      )}

      {(type === "loan_received" || type === "loan_payment") && (
        <Section title="Accounts">
          <FieldGrid columns={2}>
            <div className="space-y-2">
              <Label>Bank / Cash Account *</Label>
              <AccountCombobox
                accounts={accounts}
                value={bankAccountId}
                onValueChange={setBankAccountId}
                placeholder="Select bank account..."
                allowedTypes={["asset"]}
              />
            </div>
            <div className="space-y-2">
              <Label>Loan Account (Liability) *</Label>
              <AccountCombobox
                accounts={accounts}
                value={loanAccountId}
                onValueChange={setLoanAccountId}
                placeholder="Select loan account..."
                allowedTypes={["liability"]}
              />
            </div>
            {type === "loan_payment" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="bt_interest">Interest Portion (optional)</Label>
                  <Input
                    id="bt_interest"
                    type="number"
                    min="0"
                    step="0.01"
                    value={interestAmount}
                    onChange={(e) => setInterestAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                {interestAmount && parseFloat(interestAmount) > 0 && (
                  <div className="space-y-2">
                    <Label>Interest Expense Account *</Label>
                    <AccountCombobox
                      accounts={accounts}
                      value={interestAccountId}
                      onValueChange={setInterestAccountId}
                      placeholder="Select interest expense account..."
                      allowedTypes={["expense"]}
                    />
                  </div>
                )}
              </>
            )}
          </FieldGrid>
        </Section>
      )}

      <Section title="Memo">
        <FieldGrid columns={3}>
          <FieldCell span={3}>
            <div className="space-y-2">
              <Label htmlFor="bt_memo">Memo (optional)</Label>
              <Textarea
                id="bt_memo"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Description of this transaction..."
                rows={2}
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </Section>
    </RecordFormShell>
  );
}
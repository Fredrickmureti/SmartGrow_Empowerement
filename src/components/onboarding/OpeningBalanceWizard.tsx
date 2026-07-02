import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import { useGLPosting } from "@/hooks/useGLPosting";
import { useOrganization } from "@/hooks/useOrganization";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Loader2, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface BalanceEntry {
  accountId: string;
  accountName: string;
  amount: number;
  isDebitNormal: boolean;
}

export function OpeningBalanceWizard({ open, onOpenChange }: Props) {
  const [step, setStep] = useState(1);
  const [fiscalStartDate, setFiscalStartDate] = useState(format(new Date(new Date().getFullYear(), 0, 1), "yyyy-MM-dd"));
  const [balances, setBalances] = useState<BalanceEntry[]>([]);
  const [newAccountId, setNewAccountId] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isComplete, setIsComplete] = useState(false);

  const { accounts, createAccount } = useAccounts();
  const { postToGL } = useGLPosting();
  const { currentOrg } = useOrganization();
  const { toast } = useToast();

  const DEBIT_NORMAL_TYPES = ["asset", "expense"];

  const addBalance = () => {
    const account = accounts.find(a => a.id === newAccountId);
    if (!account || !newAmount) return;
    const exists = balances.find(b => b.accountId === newAccountId);
    if (exists) {
      toast({ title: "Account already added", variant: "destructive" });
      return;
    }
    setBalances([...balances, {
      accountId: newAccountId,
      accountName: `${account.code} — ${account.name}`,
      amount: parseFloat(newAmount),
      isDebitNormal: DEBIT_NORMAL_TYPES.includes(account.account_type),
    }]);
    setNewAccountId("");
    setNewAmount("");
  };

  const removeBalance = (idx: number) => setBalances(balances.filter((_, i) => i !== idx));

  // Calculate totals
  const totalDebits = balances.filter(b => b.isDebitNormal).reduce((s, b) => s + b.amount, 0);
  const totalCredits = balances.filter(b => !b.isDebitNormal).reduce((s, b) => s + b.amount, 0);
  const difference = totalDebits - totalCredits;

  const handlePost = async () => {
    if (!currentOrg?.id || balances.length === 0) return;
    setIsSubmitting(true);

    try {
      // Find or create Opening Balance Equity account
      let obeAccount = accounts.find(a =>
        a.detail_type === "opening_balance_equity" ||
        a.name.toLowerCase().includes("opening balance equity")
      );

      if (!obeAccount && Math.abs(difference) > 0.01) {
        // Create OBE account
        obeAccount = await createAccount({
          code: "3900",
          name: "Opening Balance Equity",
          account_type: "equity" as any,
          detail_type: "opening_balance_equity",
          description: "System-generated account for opening balance differences",
        });
      }

      // Build GL entries
      const entries = balances.map(b => ({
        account_id: b.accountId,
        debit_amount: b.isDebitNormal ? b.amount : 0,
        credit_amount: b.isDebitNormal ? 0 : b.amount,
        description: `Opening balance — ${b.accountName}`,
      }));

      // Add OBE line if there's a difference
      if (Math.abs(difference) > 0.01 && obeAccount) {
        if (difference > 0) {
          entries.push({
            account_id: obeAccount.id,
            debit_amount: 0,
            credit_amount: difference,
            description: "Opening Balance Equity — balancing entry",
          });
        } else {
          entries.push({
            account_id: obeAccount.id,
            debit_amount: Math.abs(difference),
            credit_amount: 0,
            description: "Opening Balance Equity — balancing entry",
          });
        }
      }

      await postToGL({
        source_type: "opening_balance",
        source_id: crypto.randomUUID(),
        reference: "OB-WIZARD",
        memo: "Opening balances set via wizard",
        entry_date: fiscalStartDate,
        entries,
      });

      setIsComplete(true);
      toast({ title: "Opening balances posted successfully" });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isComplete) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <div className="flex flex-col items-center py-8 gap-4">
            <CheckCircle2 className="h-16 w-16 text-primary" />
            <h2 className="text-xl font-semibold">Opening Balances Posted!</h2>
            <p className="text-sm text-muted-foreground text-center">
              Your opening balances have been recorded as a journal entry dated {format(new Date(fiscalStartDate), "MMM d, yyyy")}.
            </p>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Opening Balance Wizard</DialogTitle>
          <DialogDescription>Step {step} of 3 — Set up your starting balances</DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="space-y-1.5">
                  <Label>Fiscal Year Start Date</Label>
                  <Input type="date" value={fiscalStartDate} onChange={e => setFiscalStartDate(e.target.value)} />
                  <p className="text-xs text-muted-foreground">
                    Opening balances will be posted as of this date. Typically the first day of your fiscal year.
                  </p>
                </div>
              </CardContent>
            </Card>
            <div className="flex justify-end">
              <Button onClick={() => setStep(2)}>Next <ChevronRight className="h-4 w-4 ml-1" /></Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <Card>
              <CardContent className="pt-6 space-y-4">
                <p className="text-sm text-muted-foreground">
                  Add each account that has an opening balance. Assets and expenses are debits; liabilities, equity, and revenue are credits. Any difference will auto-balance to "Opening Balance Equity."
                </p>

                <div className="grid grid-cols-[1fr_120px_auto] gap-2 items-end">
                  <div>
                    <Label>Account</Label>
                    <AccountCombobox accounts={accounts} value={newAccountId} onValueChange={setNewAccountId} placeholder="Select account..." />
                  </div>
                  <div>
                    <Label>Amount</Label>
                    <Input type="number" min="0.01" step="0.01" value={newAmount} onChange={e => setNewAmount(e.target.value)} placeholder="0.00" />
                  </div>
                  <Button onClick={addBalance} disabled={!newAccountId || !newAmount}>Add</Button>
                </div>

                {balances.length > 0 && (
                  <div className="border rounded-lg divide-y">
                    {balances.map((b, idx) => (
                      <div key={idx} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="flex-1">{b.accountName}</span>
                        <Badge variant="outline" className="mr-2">{b.isDebitNormal ? "DR" : "CR"}</Badge>
                        <span className="font-mono w-24 text-right">{b.amount.toFixed(2)}</span>
                        <Button variant="ghost" size="sm" className="ml-2 h-6 w-6 p-0" onClick={() => removeBalance(idx)}>×</Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex justify-between text-sm font-medium pt-2 border-t">
                  <span>Total Debits: {totalDebits.toFixed(2)}</span>
                  <span>Total Credits: {totalCredits.toFixed(2)}</span>
                </div>
                {Math.abs(difference) > 0.01 && (
                  <p className="text-xs text-muted-foreground">
                    Difference of {Math.abs(difference).toFixed(2)} will be posted to "Opening Balance Equity"
                  </p>
                )}
              </CardContent>
            </Card>
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}><ChevronLeft className="h-4 w-4 mr-1" /> Back</Button>
              <Button onClick={() => setStep(3)} disabled={balances.length === 0}>Review <ChevronRight className="h-4 w-4 ml-1" /></Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <Card>
              <CardContent className="pt-6 space-y-3">
                <h3 className="font-medium">Review Opening Balances</h3>
                <p className="text-sm text-muted-foreground">
                  Date: {format(new Date(fiscalStartDate), "MMMM d, yyyy")}
                </p>
                <div className="border rounded-lg divide-y text-sm">
                  {balances.map((b, idx) => (
                    <div key={idx} className="flex justify-between px-3 py-2">
                      <span>{b.accountName}</span>
                      <span className="font-mono">
                        {b.isDebitNormal ? `DR ${b.amount.toFixed(2)}` : `CR ${b.amount.toFixed(2)}`}
                      </span>
                    </div>
                  ))}
                  {Math.abs(difference) > 0.01 && (
                    <div className="flex justify-between px-3 py-2 bg-muted/50">
                      <span>Opening Balance Equity (auto)</span>
                      <span className="font-mono">
                        {difference > 0 ? `CR ${difference.toFixed(2)}` : `DR ${Math.abs(difference).toFixed(2)}`}
                      </span>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {balances.length} accounts • Total: {(totalDebits + (difference > 0 ? 0 : Math.abs(difference))).toFixed(2)}
                </p>
              </CardContent>
            </Card>
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(2)}><ChevronLeft className="h-4 w-4 mr-1" /> Back</Button>
              <Button onClick={handlePost} disabled={isSubmitting}>
                {isSubmitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Posting...</> : "Post Opening Balances"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

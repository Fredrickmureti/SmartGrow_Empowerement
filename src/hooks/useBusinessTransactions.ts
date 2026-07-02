import { useGLPosting, GLEntry } from "./useGLPosting";
import { useAccounts } from "./useAccounts";
import { useOrganization } from "./useOrganization";
import { useToast } from "./use-toast";

export type BusinessTransactionType = 
  | "owner_investment" 
  | "owner_drawing" 
  | "bank_transfer" 
  | "loan_received" 
  | "loan_payment";

export interface BusinessTransactionInput {
  type: BusinessTransactionType;
  amount: number;
  date: string;
  memo?: string;
  // For owner investment / drawing
  bankAccountId?: string;
  equityAccountId?: string;
  // For bank transfer
  fromBankAccountId?: string;
  toBankAccountId?: string;
  // For loan received / payment
  loanAccountId?: string;
  interestAmount?: number;
  interestAccountId?: string;
}

export function useBusinessTransactions() {
  const { postToGL } = useGLPosting();
  const { currentOrg } = useOrganization();
  const { toast } = useToast();

  const recordTransaction = async (input: BusinessTransactionInput): Promise<string | null> => {
    if (!currentOrg) {
      toast({ title: "Error", description: "No organization selected", variant: "destructive" });
      return null;
    }

    const sourceId = crypto.randomUUID();
    let entries: GLEntry[] = [];
    let reference = "";
    let memo = input.memo || "";

    switch (input.type) {
      case "owner_investment":
        if (!input.bankAccountId || !input.equityAccountId) {
          toast({ title: "Missing accounts", description: "Select both bank and equity accounts", variant: "destructive" });
          return null;
        }
        entries = [
          { account_id: input.bankAccountId, debit_amount: input.amount, credit_amount: 0, description: "Owner capital investment — cash received" },
          { account_id: input.equityAccountId, debit_amount: 0, credit_amount: input.amount, description: "Owner capital investment — equity increase" },
        ];
        reference = `OWN-INV-${sourceId.slice(-8)}`;
        memo = memo || "Owner capital investment";
        break;

      case "owner_drawing":
        if (!input.bankAccountId || !input.equityAccountId) {
          toast({ title: "Missing accounts", description: "Select both bank and equity/drawing accounts", variant: "destructive" });
          return null;
        }
        entries = [
          { account_id: input.equityAccountId, debit_amount: input.amount, credit_amount: 0, description: "Owner drawing — equity decrease" },
          { account_id: input.bankAccountId, debit_amount: 0, credit_amount: input.amount, description: "Owner drawing — cash withdrawn" },
        ];
        reference = `OWN-DRW-${sourceId.slice(-8)}`;
        memo = memo || "Owner drawing / distribution";
        break;

      case "bank_transfer":
        if (!input.fromBankAccountId || !input.toBankAccountId) {
          toast({ title: "Missing accounts", description: "Select both source and destination bank accounts", variant: "destructive" });
          return null;
        }
        entries = [
          { account_id: input.toBankAccountId, debit_amount: input.amount, credit_amount: 0, description: "Bank transfer — funds received" },
          { account_id: input.fromBankAccountId, debit_amount: 0, credit_amount: input.amount, description: "Bank transfer — funds sent" },
        ];
        reference = `XFER-${sourceId.slice(-8)}`;
        memo = memo || "Inter-account bank transfer";
        break;

      case "loan_received":
        if (!input.bankAccountId || !input.loanAccountId) {
          toast({ title: "Missing accounts", description: "Select both bank and loan liability accounts", variant: "destructive" });
          return null;
        }
        entries = [
          { account_id: input.bankAccountId, debit_amount: input.amount, credit_amount: 0, description: "Loan proceeds — cash received" },
          { account_id: input.loanAccountId, debit_amount: 0, credit_amount: input.amount, description: "Loan proceeds — liability created" },
        ];
        reference = `LOAN-RCV-${sourceId.slice(-8)}`;
        memo = memo || "Loan received";
        break;

      case "loan_payment": {
        if (!input.bankAccountId || !input.loanAccountId) {
          toast({ title: "Missing accounts", description: "Select both bank and loan accounts", variant: "destructive" });
          return null;
        }
        const principal = input.amount - (input.interestAmount || 0);
        entries = [
          { account_id: input.loanAccountId, debit_amount: principal, credit_amount: 0, description: "Loan payment — principal" },
        ];
        if (input.interestAmount && input.interestAmount > 0 && input.interestAccountId) {
          entries.push({ account_id: input.interestAccountId, debit_amount: input.interestAmount, credit_amount: 0, description: "Loan payment — interest expense" });
        }
        entries.push({ account_id: input.bankAccountId, debit_amount: 0, credit_amount: input.amount, description: "Loan payment — cash paid" });
        reference = `LOAN-PAY-${sourceId.slice(-8)}`;
        memo = memo || "Loan payment";
        break;
      }
    }

    try {
      const jeId = await postToGL({
        source_type: input.type,
        source_id: sourceId,
        reference,
        memo,
        entry_date: input.date,
        entries,
      });

      if (jeId) {
        toast({ title: "Transaction recorded", description: `${memo} — ${reference}` });
      }
      return jeId;
    } catch (error: any) {
      console.error("Business transaction error:", error);
      return null;
    }
  };

  return { recordTransaction };
}

/**
 * Dialog to create a payroll payment batch with an explicit bank account.
 *
 * Migrated to the WorkflowSheet design standard (right-side sheet, numbered
 * sections, sticky footer) — matches the "Create Payroll Run" experience.
 *
 * Bank account selection is mandatory because the cash-side journal entry
 * (DR Net Salary Payable / CR Bank) needs the account_id behind the row.
 * Bank rows missing a GL link are disabled.
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Banknote } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePayrollPayments } from "@/hooks/payroll/usePayrollPayments";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  payrollRunId: string;
  payrollNumber: string;
  /**
   * Optional payroll batch (run group) that this disbursement is the cash leg of.
   * When provided, the resulting payment batch is linked via
   * `payroll_payment_batches.source_batch_id`, which `payroll_batch_mark_paid`
   * requires before it will transition the batch to "paid". Surfaced as a locked,
   * informational row in the dialog so the operator can see the binding.
   */
  sourceBatchId?: string | null;
  sourceBatchNumber?: string | null;
}

export function CreatePaymentBatchDialog({
  open,
  onOpenChange,
  payrollRunId,
  payrollNumber,
  sourceBatchId,
  sourceBatchNumber,
}: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { createBatch } = usePayrollPayments();
  const [bankAccountId, setBankAccountId] = useState<string>("");

  const banksQ = useQuery({
    queryKey: ["payroll-bank-accounts", currentOrg?.id, currentBusiness?.id],
    enabled: open && !!currentOrg?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("bank_accounts")
        .select("id, name, bank_name, currency, account_id, is_primary, business_id")
        .eq("organization_id", currentOrg!.id)
        .eq("is_active", true)
        .order("is_primary", { ascending: false });
      return (data || []).filter(
        (b: any) => !b.business_id || b.business_id === currentBusiness?.id,
      );
    },
  });

  const sortedBanks = useMemo(
    () =>
      (banksQ.data || []).sort(
        (a: any, b: any) => Number(!!b.account_id) - Number(!!a.account_id),
      ),
    [banksQ.data],
  );

  const selectedBank = sortedBanks.find((b: any) => b.id === bankAccountId);

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Create payment batch · ${payrollNumber}`}
      description="Configure the cash-side disbursement and review what will post to the general ledger."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!bankAccountId || createBatch.isPending}
            onClick={async () => {
              await createBatch.mutateAsync({
                payroll_run_id: payrollRunId,
                bank_account_id: bankAccountId,
                source_batch_id: sourceBatchId ?? null,
              });
              onOpenChange(false);
            }}
          >
            {createBatch.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            <Banknote className="mr-2 h-4 w-4" />
            Create batch
          </Button>
        </>
      }
    >
      {sourceBatchId && (
        <WorkflowSheetSection
          number={1}
          title="Linked payroll batch"
          subtitle="This disbursement counts toward the batch's Mark-paid gate and cannot be unlinked here."
        >
          <div className="text-xs font-mono px-2 py-1.5 rounded bg-muted text-foreground/80 border w-fit">
            {sourceBatchNumber ?? sourceBatchId}
          </div>
        </WorkflowSheetSection>
      )}

      <WorkflowSheetSection
        number={sourceBatchId ? 2 : 1}
        title="Disbursement target"
        subtitle="Bank account that funds the net-pay disbursement."
      >
        <WorkflowField
          label="Disburse from bank account"
          required
          hint="The cash leg posts to this account. Accounts without a GL link cannot be selected."
        >
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select bank account…" />
            </SelectTrigger>
            <SelectContent>
              {sortedBanks.map((b: any) => (
                <SelectItem key={b.id} value={b.id} disabled={!b.account_id}>
                  {b.name} {b.bank_name ? `· ${b.bank_name}` : ""}{" "}
                  {b.currency ? `(${b.currency})` : ""}
                  {!b.account_id ? " — no GL link" : ""}
                </SelectItem>
              ))}
              {sortedBanks.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  No active bank accounts. Add one in Finance → Banking.
                </div>
              )}
            </SelectContent>
          </Select>
        </WorkflowField>
      </WorkflowSheetSection>

      <WorkflowSheetSection
        number={sourceBatchId ? 3 : 2}
        title="Posting preview"
        subtitle="What will hit the general ledger when this batch is created."
      >
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1.5">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">DR</span>
            <span className="flex-1">Net Salary Payable</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">CR</span>
            <span className="flex-1 truncate">
              {selectedBank
                ? `${selectedBank.name}${selectedBank.bank_name ? ` · ${selectedBank.bank_name}` : ""}`
                : "— select a bank account above —"}
            </span>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Net Salary Payable is cleared once the batch is marked paid. Reversal
          and re-issue both go through the audit log.
        </p>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

export default CreatePaymentBatchDialog;

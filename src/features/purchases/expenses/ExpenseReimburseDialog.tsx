/**
 * ExpenseReimburseDialog — settlement surface for an employee-paid expense.
 *
 * An employee-paid expense credits an employee payable at approval. That
 * obligation is discharged exactly once, through exactly one route:
 *
 *   • Payroll  — queue the expense; the payroll engine adds a non-taxable
 *                reimbursement earning to the next run and stamps the payslip
 *                link back onto the expense.
 *   • Direct   — pay it now from a bank / cash account; the server posts
 *                employee payable → bank through the single journal engine.
 *
 * Both routes are server commands (`expense_queue_payroll_reimbursement`,
 * `expense_reimburse_direct`); this dialog only collects their inputs.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { usePaymentAccounts } from "./usePaymentAccounts";

export interface ReimbursableExpense {
  id: string;
  description: string;
  amount: number;
  currency?: string | null;
  employee_id?: string | null;
  expense_number?: string | null;
}

interface Props {
  expense: ReimbursableExpense | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onQueuePayroll: (id: string, employeeId?: string | null) => Promise<unknown>;
  onReimburseDirect: (
    id: string,
    bankAccountId: string,
    paymentDate?: string | null,
    reference?: string | null,
  ) => Promise<unknown>;
}

export function ExpenseReimburseDialog({
  expense,
  open,
  onOpenChange,
  onQueuePayroll,
  onReimburseDirect,
}: Props) {
  const { toast } = useToast();
  const paymentAccounts = usePaymentAccounts();

  const [route, setRoute] = useState<"payroll" | "direct">("payroll");
  const [bankAccountId, setBankAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!expense) return;
    setBusy(true);
    try {
      if (route === "payroll") {
        await onQueuePayroll(expense.id, expense.employee_id ?? null);
        toast({
          title: "Queued for payroll",
          description:
            "This reimbursement will be paid out with the employee's next payroll run.",
        });
      } else {
        if (!bankAccountId) {
          toast({
            title: "Payment account required",
            description: "Choose the bank or cash account the employee is paid from.",
            variant: "destructive",
          });
          return;
        }
        await onReimburseDirect(
          expense.id,
          bankAccountId,
          paymentDate || null,
          reference || null,
        );
        toast({
          title: "Reimbursement paid",
          description: "The employee payable has been settled and the payment posted.",
        });
      }
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Could not reimburse expense",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reimburse employee</DialogTitle>
          <DialogDescription>
            {expense
              ? `${expense.expense_number ? `${expense.expense_number} — ` : ""}${expense.description} (${expense.currency ?? ""} ${Number(expense.amount).toFixed(2)})`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <RadioGroup
            value={route}
            onValueChange={(v) => setRoute(v as "payroll" | "direct")}
            className="space-y-2"
          >
            <div className="flex items-start gap-3 rounded-md border p-3">
              <RadioGroupItem value="payroll" id="reimburse-payroll" className="mt-1" />
              <Label htmlFor="reimburse-payroll" className="font-normal">
                <span className="block font-medium">With next payroll run</span>
                <span className="text-muted-foreground text-sm">
                  Added as a non-taxable reimbursement on the employee's payslip.
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-3 rounded-md border p-3">
              <RadioGroupItem value="direct" id="reimburse-direct" className="mt-1" />
              <Label htmlFor="reimburse-direct" className="font-normal">
                <span className="block font-medium">Pay now from bank or cash</span>
                <span className="text-muted-foreground text-sm">
                  Settles the employee payable immediately.
                </span>
              </Label>
            </div>
          </RadioGroup>

          {route === "direct" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="reimburse-account">Paid from</Label>
                <Select value={bankAccountId} onValueChange={setBankAccountId}>
                  <SelectTrigger id="reimburse-account">
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reimburse-date">Payment date</Label>
                <Input
                  id="reimburse-date"
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reimburse-reference">Reference (optional)</Label>
                <Input
                  id="reimburse-reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Transfer or cheque reference"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {route === "payroll" ? "Queue for payroll" : "Pay reimbursement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

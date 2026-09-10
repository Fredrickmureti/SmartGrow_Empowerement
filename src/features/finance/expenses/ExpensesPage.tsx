/**
 * Expenses — list + capture surface at `/finance/expenses`.
 *
 * The screen only authors commercial fields and calls the server lifecycle
 * commands (`expense_submit` / `expense_approve` / `expense_reject` /
 * `expense_void`). It never writes status, numbering or the ledger entry.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import {
  Plus,
  Search,
  Receipt,
  Loader2,
  MoreHorizontal,
  Send,
  CheckCircle,
  XCircle,
  Trash2,
  RotateCcw,
  Pencil,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useExpenses, type Expense } from "@/hooks/useExpenses";
import {
  approveExpense,
  rejectExpense,
  submitExpense,
  isExpenseDeletable,
  isExpenseEditable,
  type ExpenseStatus,
} from "@/lib/finance/expenseCommands";
import { normalizeError } from "@/services/resilience";
import { ExpenseFormDialog, type ExpenseFormValues } from "./ExpenseFormDialog";
import { VoidExpenseDialog } from "./VoidExpenseDialog";
import { ExpenseCategoriesDialog } from "./ExpenseCategoriesDialog";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  pending: "secondary",
  submitted: "secondary",
  approved: "default",
  paid: "default",
  rejected: "destructive",
  voided: "destructive",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending: "Pending",
  submitted: "Awaiting approval",
  approved: "Approved",
  paid: "Paid",
  rejected: "Rejected",
  voided: "Voided",
};

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "KES",
    minimumFractionDigits: 2,
  }).format(Number(amount || 0));

export default function ExpensesPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const {
    expenses,
    categories,
    isLoading,
    createExpense,
    updateExpense,
    deleteExpense,
    voidExpense,
    refreshExpenses,
  } = useExpenses();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [voiding, setVoiding] = useState<Expense | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expenses.filter((e) => {
      if (status !== "all" && e.status !== status) return false;
      if (!q) return true;
      return (
        e.description?.toLowerCase().includes(q) ||
        e.reference?.toLowerCase().includes(q) ||
        e.category?.name?.toLowerCase().includes(q)
      );
    });
  }, [expenses, search, status]);

  const total = rows.reduce((sum, e) => sum + Number(e.amount || 0), 0);

  const run = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await fn();
      await refreshExpenses();
      toast({ title: label });
    } catch (error) {
      toast({
        title: `Could not ${label.toLowerCase()}`,
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const onSave = async (values: ExpenseFormValues, submit: boolean) => {
    try {
      if (editing) {
        await updateExpense(editing.id, values as Partial<Expense>);
        await refreshExpenses();
        toast({ title: "Expense updated" });
      } else {
        await createExpense({
          ...values,
          status: "draft" as ExpenseStatus,
          is_billable: false,
          vendor_id: null,
          approved_by: null,
          submit,
        } as never);
        toast({ title: submit ? "Expense recorded and submitted" : "Draft saved" });
      }
    } catch (error) {
      toast({
        title: "Could not save the expense",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      throw error;
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
          <p className="text-sm text-muted-foreground">
            Record what the institution spends. Approval and the ledger entry
            are handled by the system.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          New expense
        </Button>
      </div>

      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Receipt className="h-4 w-4" />
                Recorded expenses
              </CardTitle>
              <CardDescription>
                {rows.length} shown · {money(total, rows[0]?.currency ?? "KES")} total
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="w-56 pl-8"
                  placeholder="Search description or reference"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {Object.keys(STATUS_LABEL).map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading expenses…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              No expenses yet. Use “New expense” to record one.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">
                      {e.expense_date ? format(new Date(e.expense_date), "dd MMM yyyy") : "—"}
                    </TableCell>
                    <TableCell className="max-w-[22rem] truncate">{e.description}</TableCell>
                    <TableCell>{e.category?.name ?? "Uncategorised"}</TableCell>
                    <TableCell className="text-muted-foreground">{e.reference ?? "—"}</TableCell>
                    <TableCell className="text-right font-medium">
                      {money(e.amount, e.currency)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[e.status] ?? "outline"}>
                        {STATUS_LABEL[e.status] ?? e.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" disabled={busyId === e.id}>
                            {busyId === e.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <MoreHorizontal className="h-4 w-4" />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {isExpenseEditable(e.status) && (
                            <DropdownMenuItem
                              onClick={() => {
                                setEditing(e);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                          )}
                          {["draft", "pending", "rejected"].includes(e.status) && (
                            <DropdownMenuItem
                              onClick={() => run(e.id, "Expense submitted", () => submitExpense(e.id))}
                            >
                              <Send className="mr-2 h-4 w-4" />
                              Submit for approval
                            </DropdownMenuItem>
                          )}
                          {["submitted", "pending"].includes(e.status) && (
                            <>
                              <DropdownMenuItem
                                onClick={() => run(e.id, "Expense approved", () => approveExpense(e.id))}
                              >
                                <CheckCircle className="mr-2 h-4 w-4" />
                                Approve
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => run(e.id, "Expense rejected", () => rejectExpense(e.id))}
                              >
                                <XCircle className="mr-2 h-4 w-4" />
                                Reject
                              </DropdownMenuItem>
                            </>
                          )}
                          {["approved", "paid"].includes(e.status) && (
                            <DropdownMenuItem onClick={() => setVoiding(e)}>
                              <RotateCcw className="mr-2 h-4 w-4" />
                              Void
                            </DropdownMenuItem>
                          )}
                          {(e as unknown as { journal_entry_id?: string }).journal_entry_id && (
                            <DropdownMenuItem
                              onClick={() =>
                                navigate(
                                  `/finance/journal-entries/${
                                    (e as unknown as { journal_entry_id?: string }).journal_entry_id
                                  }`,
                                )
                              }
                            >
                              <Receipt className="mr-2 h-4 w-4" />
                              View ledger entry
                            </DropdownMenuItem>
                          )}
                          {isExpenseDeletable(e.status) && (
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => run(e.id, "Expense deleted", () => deleteExpense(e.id))}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ExpenseFormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        categories={categories}
        expense={editing}
        onSave={onSave}
      />

      <VoidExpenseDialog
        open={!!voiding}
        onOpenChange={(o) => !o && setVoiding(null)}
        expenseDescription={voiding?.description}
        onConfirm={async (reason, reasonCode) => {
          if (!voiding) return;
          await run(voiding.id, "Expense voided", () =>
            voidExpense(voiding.id, reason, reasonCode),
          );
          setVoiding(null);
        }}
      />
    </div>
  );
}

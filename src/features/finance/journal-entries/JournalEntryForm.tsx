/**
 * JournalEntryForm — shared create/edit form composed on RecordFormShell.
 *
 * Rendered inside the `/finance/journal-entries/new` and
 * `/finance/journal-entries/:id/edit` routes. Preserves the full
 * business logic previously in `src/pages/JournalEntries.tsx` inline
 * dialog verbatim: balance validation, AR/AP control-account contact
 * requirement, fiscal-period lock guard, and RPC calls via
 * `useJournalEntries`.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Loader2, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { EditableLineItemsGrid } from "@/design-system/records";
import {
  JournalLineRow,
  JOURNAL_LINE_COLUMNS,
} from "@/components/documents/lines/JournalLineRow";
import { useAccounts } from "@/hooks/useAccounts";
import { useAnalyticAccounts } from "@/hooks/useAnalyticAccounts";
import { useContacts } from "@/hooks/useContacts";
import { useCurrency } from "@/hooks/useCurrency";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import {
  useJournalEntries,
  type JournalEntry,
} from "@/hooks/useJournalEntries";


interface JournalLine {
  account_id: string;
  description: string;
  debit: number;
  credit: number;
  contact_id?: string;
  /** Optional analytic attribution; materialised into the analytic ledger by
   *  the database once the entry posts. */
  analytic_account_id?: string | null;
}

interface JournalEntryFormProps {
  mode: "create" | "edit";
  entry?: JournalEntry | null;
}

export function JournalEntryForm({ mode, entry }: JournalEntryFormProps) {
  const navigate = useNavigate();
  const { accounts } = useAccounts();
  const { activeAccounts: postableAnalyticAccounts } = useAnalyticAccounts();
  const { contacts } = useContacts();
  const { formatCurrency } = useCurrency();
  const { isDateLocked } = useFiscalPeriods();
  const { createJournalEntry, updateJournalEntry } = useJournalEntries();

  const [formData, setFormData] = useState({
    entry_date: new Date().toISOString().split("T")[0],
    description: "",
    reference: "",
    is_adjusting: false,
    is_closing: false,
    lines: [
      { account_id: "", description: "", debit: 0, credit: 0, analytic_account_id: null } as JournalLine,
      { account_id: "", description: "", debit: 0, credit: 0, analytic_account_id: null } as JournalLine,
    ],
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (mode === "edit" && entry) {
      setFormData({
        entry_date: entry.entry_date,
        description: entry.description,
        reference: entry.reference || "",
        is_adjusting: entry.is_adjusting,
        is_closing: entry.is_closing,
        lines:
          entry.lines?.map((l) => ({
            account_id: l.account_id,
            description: l.description || "",
            debit: l.debit,
            credit: l.credit,
            contact_id: l.contact_id || undefined,
            analytic_account_id:
              (l as { analytic_account_id?: string | null })
                .analytic_account_id ?? null,
          })) || [],
      });
    }
  }, [mode, entry]);

  const handleAddLine = useCallback(() => {
    setFormData((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        { account_id: "", description: "", debit: 0, credit: 0, analytic_account_id: null },
      ],
    }));
  }, []);

  const handleRemoveLine = useCallback((index: number) => {
    setFormData((prev) => ({
      ...prev,
      lines: prev.lines.filter((_, i) => i !== index),
    }));
  }, []);

  /** Stable patch handler so `JournalLineRow`'s memo actually engages. */
  const handlePatchLine = useCallback(
    (index: number, patch: Partial<JournalLine>) => {
      setFormData((prev) => ({
        ...prev,
        lines: prev.lines.map((line, i) =>
          i === index ? { ...line, ...patch } : line,
        ),
      }));
    },
    [],
  );


  // Only postable (active) analytic accounts may be attributed on a new
  // posting; archived/restricted accounts are refused by the database anyway.
  const analyticOptions = useMemo(
    () =>
      postableAnalyticAccounts.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        planName: a.plan?.name ?? null,
      })),
    [postableAnalyticAccounts],
  );

  const totalDebit = formData.lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = formData.lines.reduce((s, l) => s + (l.credit || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

  const controlRoleFor = (accountId: string): "ar" | "ap" | null => {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return null;
    if ((acc as any).system_role === "accounts_receivable") return "ar";
    if ((acc as any).system_role === "accounts_payable") return "ap";
    return null;
  };
  const missingContactLines = formData.lines
    .map((l, i) => ({ l, i, role: controlRoleFor(l.account_id) }))
    .filter((x) => x.role && !x.l.contact_id);
  const hasMissingContact = missingContactLines.length > 0;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isBalanced || hasMissingContact) return;
    setIsSubmitting(true);
    try {
      const validLines = formData.lines
        .filter((l) => l.account_id && (l.debit > 0 || l.credit > 0))
        .map((l) => ({ ...l, analytic_account_id: l.analytic_account_id || null }));
      if (mode === "edit" && entry) {
        await updateJournalEntry.mutateAsync({
          id: entry.id,
          entry_date: formData.entry_date,
          description: formData.description,
          reference: formData.reference,
          is_adjusting: formData.is_adjusting,
          is_closing: formData.is_closing,
          lines: validLines,
        });
      } else {
        await createJournalEntry.mutateAsync({
          entry_date: formData.entry_date,
          description: formData.description,
          reference: formData.reference,
          is_adjusting: formData.is_adjusting,
          is_closing: formData.is_closing,
          lines: validLines,
        });
      }
      navigate("/finance/journal-entries");
    } finally {
      setIsSubmitting(false);
    }
  };

  const dateLocked = formData.entry_date && isDateLocked(formData.entry_date);
  const submitDisabled =
    !isBalanced ||
    hasMissingContact ||
    formData.lines.length < 2 ||
    !formData.description ||
    !!dateLocked;

  return (
    <RecordFormShell
      mode={mode}
      entityLabel="Journal Entry"
      recordRef={mode === "edit" ? entry?.entry_number : undefined}
      cancelHref="/finance/journal-entries"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitDisabled={submitDisabled}
    >
      <Section
        title="Header"
        description="Debits must equal credits for the entry to be valid."
      >
        <FieldGrid columns={3}>
          <div className="space-y-2">
            <Label htmlFor="je_date">Date *</Label>
            <Input
              id="je_date"
              type="date"
              value={formData.entry_date}
              onChange={(e) =>
                setFormData({ ...formData, entry_date: e.target.value })
              }
              required
            />
            {dateLocked && (
              <Alert variant="destructive" className="py-2">
                <Lock className="h-3.5 w-3.5" />
                <AlertDescription className="text-xs">
                  Fiscal period for{" "}
                  {format(new Date(formData.entry_date), "MMM d, yyyy")} is
                  closed — saving will fail.
                </AlertDescription>
              </Alert>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="je_ref">Reference</Label>
            <Input
              id="je_ref"
              value={formData.reference}
              onChange={(e) =>
                setFormData({ ...formData, reference: e.target.value })
              }
              placeholder="Optional reference"
            />
          </div>
          <div className="flex items-end">
            <div className="flex items-center gap-2">
              <Checkbox
                id="is_adjusting"
                checked={formData.is_adjusting}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, is_adjusting: !!checked })
                }
              />
              <Label htmlFor="is_adjusting">Adjusting Entry</Label>
            </div>
          </div>
          <FieldCell span={3}>
            <div className="space-y-2">
              <Label htmlFor="je_desc">Description *</Label>
              <Textarea
                id="je_desc"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Describe the purpose of this entry"
                required
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section
        title="Lines"
        description="Each line posts to one GL account. AR/AP control accounts require a customer or vendor. The analytic account attributes the amount to a cost centre, project or department without changing the GL."
      >
        <EditableLineItemsGrid
          columns={JOURNAL_LINE_COLUMNS}
          rows={formData.lines}
          onAddRow={handleAddLine}
          onRemoveRow={handleRemoveLine}
          canRemoveRow={() => formData.lines.length > 2}
          addLabel="Add line"
          empty="No lines yet — a journal entry needs at least two."
          renderRow={(line, index, layout) => (
            <JournalLineRow
              index={index}
              item={line}
              accounts={accounts}
              contacts={contacts}
              controlRole={controlRoleFor(line.account_id)}
              analyticAccounts={analyticOptions}
              layout={layout}
              onPatch={handlePatchLine}
            />
          )}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {formData.lines.length}{" "}
                {formData.lines.length === 1 ? "line" : "lines"}
              </span>
              <div className="flex items-center gap-6">
                <span className="text-right">
                  <span className="block text-[11px] uppercase tracking-wider text-muted-foreground">
                    Total debit
                  </span>
                  <span className="font-semibold tabular-nums">
                    {formatCurrency(totalDebit)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block text-[11px] uppercase tracking-wider text-muted-foreground">
                    Total credit
                  </span>
                  <span className="font-semibold tabular-nums">
                    {formatCurrency(totalCredit)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block text-[11px] uppercase tracking-wider text-muted-foreground">
                    Difference
                  </span>
                  <span
                    className={
                      isBalanced
                        ? "font-semibold tabular-nums text-muted-foreground"
                        : "font-semibold tabular-nums text-destructive"
                    }
                  >
                    {formatCurrency(Math.abs(totalDebit - totalCredit))}
                  </span>
                </span>
              </div>
            </div>
          }
        />


        {!isBalanced && (
          <p className="text-sm text-destructive mt-2">
            Entry is unbalanced. Difference:{" "}
            {formatCurrency(Math.abs(totalDebit - totalCredit))}
          </p>
        )}
        {hasMissingContact && (
          <p className="text-sm text-destructive mt-2">
            {missingContactLines.length === 1 ? "Line" : "Lines"}{" "}
            {missingContactLines.map((x) => x.i + 1).join(", ")} post to an
            AR/AP control account — pick a customer or vendor to keep the
            subledger reconciled with the GL.
          </p>
        )}

        {isSubmitting && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving…
          </div>
        )}
      </Section>
    </RecordFormShell>
  );
}

export default JournalEntryForm;
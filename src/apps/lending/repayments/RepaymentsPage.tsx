/**
 * Lending → Repayments (C7).
 *
 * Batch-per-meeting capture with per-loan receipts and append-only reversal.
 * Every figure shown here is read from the server-derived balance views; this
 * page performs no allocation or balance maths.
 */
import { useMemo, useState } from "react";
import { usePermissions } from "@/hooks/usePermissions";
import { Plus, Undo2, Layers } from "lucide-react";
import {
  PageHeader,
  PageBody,
  Section,
  FilterBar,
  EmptyState,
  LoadingState,
  ErrorState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
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
import { useMfClients } from "@/hooks/useMfClients";
import {
  useMfLoanBalances,
  useMfRepaymentBatches,
  useMfRepayments,
} from "@/hooks/useMfRepayments";
import {
  useMfBankAccounts,
  useMfCollectionBankings,
} from "@/hooks/useMfCollectionBankings";
import { LendingDocumentsMenu } from "../documents/LendingDocumentsMenu";
import { RecordPaymentDialog } from "./RecordPaymentDialog";
import { BankBatchDialog } from "./BankBatchDialog";


const money = (value: number, currency = "") =>
  `${currency} ${Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();

export function RepaymentsPage() {
  const { can } = usePermissions();
  const canRecord = can("recordRepayments");
  const [search, setSearch] = useState("");
  const [batchId, setBatchId] = useState<string>("none");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);

  const { batches, openBatch, closeBatch } = useMfRepaymentBatches();
  const { repayments, isLoading, error, record, reverse } = useMfRepayments();
  const { balances } = useMfLoanBalances();
  const { clients } = useMfClients();
  const { bankAccounts } = useMfBankAccounts();
  const { bankings, bankBatch } = useMfCollectionBankings();

  const activeBatchId = batchId === "none" ? null : batchId;
  const activeBatch = useMemo(
    () => batches.find((b) => b.id === activeBatchId) ?? null,
    [batches, activeBatchId],
  );
  const bankedBatchIds = useMemo(
    () => new Set(bankings.map((b) => b.batch_id)),
    [bankings],
  );
  const canBankActiveBatch =
    !!activeBatch &&
    activeBatch.status === "closed" &&
    !bankedBatchIds.has(activeBatch.id);
  const batchLabel = useMemo(() => {
    const map = new Map(batches.map((b) => [b.id, `${b.batch_number} · ${b.collected_on}`]));
    return (id: string) => map.get(id) ?? "—";
  }, [batches]);
  const bankAccountName = useMemo(() => {
    const map = new Map(bankAccounts.map((a) => [a.id, a.name]));
    return (id: string) => map.get(id) ?? "—";
  }, [bankAccounts]);

  const clientName = useMemo(() => {
    const map = new Map(clients.map((c) => [c.id, `${c.client_number} — ${c.full_name}`]));
    return (id: string) => map.get(id) ?? "—";
  }, [clients]);

  const loanNumber = useMemo(() => {
    const map = new Map(balances.map((b) => [b.loan_id, b.loan_number]));
    return (id: string) => map.get(id) ?? "—";
  }, [balances]);

  const openLoans = useMemo(
    () => balances.filter((b) => b.status === "active"),
    [balances],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repayments;
    return repayments.filter((r) =>
      [r.receipt_number, r.reference, clientName(r.client_id), loanNumber(r.loan_id)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [repayments, search, clientName, loanNumber]);

  const doReverse = (id: string) => {
    const reason = window.prompt("Reason for reversing this receipt?");
    if (!reason?.trim()) return;
    reverse.mutate({ repaymentId: id, reason: reason.trim() });
  };

  return (
    <>
      <PageHeader
        eyebrow="Lending"
        title="Repayments"
        description="Collection batches, per-client receipts and server-side allocation."
        actions={
          canRecord ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                openBatch.mutate(
                  { collectedOn: new Date().toISOString().slice(0, 10) },
                  { onSuccess: (id) => setBatchId(id) },
                )
              }
            >
              <Layers className="mr-1.5 h-4 w-4" />
              Open batch
            </Button>
            <Button size="sm" onClick={() => setCaptureOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Record payment
            </Button>
          </div>
          ) : undefined
        }
      />
      <PageBody>
        <Section
          title="Receipts"
          description={`${filtered.length} receipt(s)`}
        >
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            placeholder="Search receipt, reference, client or loan…"
          >
            <Select value={batchId} onValueChange={setBatchId}>
              <SelectTrigger className="h-8 w-[240px] text-sm">
                <SelectValue placeholder="No batch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No batch (ad-hoc capture)</SelectItem>
                {batches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.batch_number} · {b.collected_on} · {b.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canRecord && activeBatchId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => closeBatch.mutate(activeBatchId)}
              >
                Close batch
              </Button>
            )}
          </FilterBar>

          {error ? (
            <ErrorState description={error.message} />
          ) : isLoading ? (
            <LoadingState />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No receipts yet"
              description="Open a collection batch for the meeting, then capture each member's payment."
              action={canRecord ? <Button onClick={() => setCaptureOpen(true)}>Record payment</Button> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Paid on</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Loan</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.receipt_number}</TableCell>
                    <TableCell className="text-sm">{r.paid_on}</TableCell>
                    <TableCell className="font-medium">{clientName(r.client_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{loanNumber(r.loan_id)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.amount)}</TableCell>
                    <TableCell className="text-sm capitalize">
                      {r.method.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={r.status === "posted" ? "success" : "danger"}>
                        {r.status === "posted" ? "Posted" : "Reversed"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="space-x-1.5 text-right">
                      <LendingDocumentsMenu
                        label="Receipt"
                        documents={[
                          {
                            documentType: "loan_payment_receipt",
                            documentId: r.id,
                            title: `Payment receipt ${r.receipt_number}`,
                            filename: `payment-receipt-${r.receipt_number}`,
                          },
                        ]}
                      />
                      {canRecord && r.status === "posted" && (
                        <Button size="sm" variant="outline" onClick={() => doReverse(r.id)}>
                          <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                          Reverse
                        </Button>
                      )}
                    </TableCell>

                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      <RecordPaymentDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
        loans={openLoans}
        batchId={activeBatchId}
        onRecord={(input) => record.mutateAsync(input)}
      />
    </>
  );
}

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useMigrationSession } from "@/hooks/useMigrationSession";
import { useMigrationFileUpload } from "@/hooks/useMigrationFileUpload";
import { useMigrationImportLoop } from "@/hooks/useMigrationImportLoop";
import { useGLPosting } from "@/hooks/useGLPosting";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { findBestMatch } from "@/lib/migration/fuzzyMatch";
import { useToast } from "@/hooks/use-toast";
import { Upload, FileSpreadsheet, Loader2, Info, AlertTriangle, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

interface PaymentRow {
  customerName: string;
  invoiceNumber: string;
  paymentDate: string;
  amount: number;
  paymentMethod: string;
  reference: string;
  matchedContactId?: string;
  matchedInvoiceId?: string;
  matchStatus: "matched" | "invoice_not_found" | "customer_not_found";
}

export function MigrationStepPayments({ onComplete, onSkip }: Props) {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const migration = useMigrationSession();
  const { postPaymentToGL } = useGLPosting();
  const { getPaymentAccountMappings, hasRequiredAccounts } = useDefaultAccounts();
  const [parsedRows, setParsedRows] = useState<PaymentRow[]>([]);

  const fileUpload = useMigrationFileUpload({
    isBatchDuplicate: migration.isBatchDuplicate,
    onParsed: useCallback(async ({ headers, rows }) => {
      const custCol = headers.find(h => /customer|client|name/i.test(h)) || headers[0];
      const invCol = headers.find(h => /invoice.?num|inv.?no|invoice/i.test(h)) || headers[1];
      const dateCol = headers.find(h => /payment.?date|date|received/i.test(h)) || headers[2];
      const amtCol = headers.find(h => /amount|total|payment/i.test(h)) || headers[3];
      const methodCol = headers.find(h => /method|type|mode/i.test(h));
      const refCol = headers.find(h => /reference|ref|check|cheque/i.test(h));

      const { fetchAllRows } = await import("@/lib/supabasePagination");
      const contactList = await fetchAllRows<{ id: string; name: string; type: string }>(
        "contacts",
        "id, name, type",
        [
          { method: "eq", column: "organization_id", value: currentOrg!.id },
          { method: "in", column: "type", value: ["customer", "both"] },
        ]
      );
      const contactMap = new Map(contactList.map(c => [c.name.toLowerCase().trim(), c.id]));

      const invoices = await fetchAllRows<{ id: string; invoice_number: string; contact_id: string | null; total: number; amount_paid: number | null }>(
        "invoices",
        "id, invoice_number, contact_id, total, amount_paid",
        [
          { method: "eq", column: "organization_id", value: currentOrg!.id },
          { method: "eq", column: "source", value: "migration" },
        ]
      );
      const invoiceMap = new Map(invoices.map(inv => [inv.invoice_number.toLowerCase().trim(), inv]));

      const parsed: PaymentRow[] = rows
        .filter(row => row[custCol]?.trim())
        .map(row => {
          const name = (row[custCol] || "").trim();
          const invNum = (row[invCol] || "").trim();
          const amount = Math.abs(parseFloat(row[amtCol]) || 0);

          let matchedContactId = contactMap.get(name.toLowerCase());
          if (!matchedContactId) {
            const fuzzy = findBestMatch(name, contactList, c => c.name, 0.7);
            if (fuzzy) matchedContactId = fuzzy.item.id;
          }

          const matchedInvoice = invoiceMap.get(invNum.toLowerCase());
          let matchStatus: PaymentRow["matchStatus"] = "matched";
          if (!matchedContactId) matchStatus = "customer_not_found";
          else if (!matchedInvoice) matchStatus = "invoice_not_found";

          return {
            customerName: name,
            invoiceNumber: invNum,
            paymentDate: (row[dateCol] || new Date().toISOString().slice(0, 10)).trim(),
            amount,
            paymentMethod: methodCol ? (row[methodCol] || "cash").trim() : "cash",
            reference: refCol ? (row[refCol] || "").trim() : "",
            matchedContactId,
            matchedInvoiceId: matchedInvoice?.id,
            matchStatus,
          };
        });

      setParsedRows(parsed);
    }, [currentOrg]),
  });

  const importLoop = useMigrationImportLoop({
    recordBatch: migration.recordBatch,
    updateStepStatus: migration.updateStepStatus,
  });

  const matchedRows = parsedRows.filter(r => r.matchStatus === "matched");
  const unmatchedRows = parsedRows.filter(r => r.matchStatus !== "matched");

  const handleImport = async () => {
    if (!currentOrg?.id || !fileUpload.file || !user) return;

    if (!hasRequiredAccounts()) {
      toast({
        title: "Account mappings required",
        description: "Payment import requires default account mappings (Cash, AR). Use the link above to configure them.",
        variant: "destructive",
      });
      return;
    }

    const importable = matchedRows.filter(r => r.matchedContactId && r.matchedInvoiceId && r.amount > 0);

    await importLoop.executeLoop({
      stepKey: "payments",
      fileHash: fileUpload.fileHash,
      fileName: fileUpload.file.name,
      totalRows: parsedRows.length,
      matchedRows: importable,
      unmatchedCount: unmatchedRows.length,
      importRow: async (row, i) => {
        const receiptNumber = row.reference || `MIG-PMT-${Date.now()}-${i}`;

        const { data: payment, error: pmtError } = await supabase
          .from("payments")
          .insert({
            organization_id: currentOrg.id,
            business_id: currentBusiness?.id || null,
            contact_id: row.matchedContactId!,
            // ADR 0027: the canonical payment→invoice link is written into
            // payment_allocations below; no single-FK column is populated.
            amount: row.amount,
            payment_date: row.paymentDate,
            payment_method: row.paymentMethod as any,
            receipt_number: receiptNumber,
            reference: row.reference || null,
            notes: "Migration: Imported payment",
            status: "completed",
            created_by: user.id,
            migration_session_id: migration.session?.id || null,
          })
          .select("id, receipt_number, payment_date, amount")
          .single();

        if (pmtError) throw pmtError;

        if (payment) {
          // Canonical link: write the allocation row tagged source='backfill'
          // so it is distinguishable from runtime allocations in audits.
          const { error: allocError } = await supabase
            .from("payment_allocations")
            .insert({
              organization_id: currentOrg.id,
              payment_id: payment.id,
              invoice_id: row.matchedInvoiceId!,
              amount: row.amount,
              source: "backfill",
            } as any);
          if (allocError) throw allocError;

          const accountMappings = getPaymentAccountMappings(row.paymentMethod);
          if (accountMappings.cash_account_id && accountMappings.receivable_account_id) {
            const jeId = await postPaymentToGL(
              {
                id: payment.id,
                receipt_number: payment.receipt_number || receiptNumber,
                payment_date: payment.payment_date,
                amount: payment.amount,
                invoice_id: row.matchedInvoiceId!,
              },
              accountMappings as { cash_account_id: string; receivable_account_id: string }
            );
            if (jeId) {
              await supabase.from("payments").update({ journal_entry_id: jeId }).eq("id", payment.id);
            }
          }


          const { data: invoice } = await supabase
            .from("invoices")
            .select("total, amount_paid")
            .eq("id", row.matchedInvoiceId!)
            .single();

          if (invoice) {
            const newPaid = (invoice.amount_paid || 0) + row.amount;
            const newStatus = newPaid >= invoice.total - 0.01 ? "paid" : "partial";
            await supabase
              .from("invoices")
              .update({ amount_paid: newPaid, status: newStatus })
              .eq("id", row.matchedInvoiceId!);
          }
        }
      },
      getRowLabel: (row) => `${row.customerName} / ${row.invoiceNumber}`,
      onSuccess: onComplete,
      successMessage: "Payments imported",
    });
  };

  const handleReset = () => {
    fileUpload.reset();
    setParsedRows([]);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment Import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Import customer payments and link them to migrated invoices. Each payment will generate a GL entry
          (DR Cash/Bank, CR Accounts Receivable) and update the invoice balance.
        </p>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            Payments are matched to invoices by Invoice Number. Make sure the Open AR step was completed first
            so the invoices exist for matching.
          </AlertDescription>
        </Alert>

        {!hasRequiredAccounts() && (
          <Alert className="border-destructive/30 bg-destructive/5">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm">Default account mappings (Cash, AR) are required for payment import.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/finance/settings?returnTo=/settings/migration")}
                className="shrink-0"
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1" />
                Configure Accounts
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {parsedRows.length === 0 ? (
          <>
            <div
              {...fileUpload.dropzone.getRootProps()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${fileUpload.dropzone.isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
            >
              <input {...fileUpload.dropzone.getInputProps()} />
              {fileUpload.isProcessing ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm">Processing file...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">Drop CSV or XLSX file here</p>
                  <p className="text-xs text-muted-foreground">
                    Columns: Customer Name, Invoice Number, Payment Date, Amount, Payment Method (optional), Reference (optional)
                  </p>
                </div>
              )}
            </div>
            <Button variant="ghost" onClick={onSkip} className="w-full">Skip this step</Button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4" />
              <span className="font-medium">{fileUpload.file?.name}</span>
              <Button variant="ghost" size="sm" onClick={handleReset}>Change file</Button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold">{parsedRows.length}</div>
                <div className="text-xs text-muted-foreground">Total Rows</div>
              </div>
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold text-success">{matchedRows.length}</div>
                <div className="text-xs text-muted-foreground">Matched</div>
              </div>
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold">{matchedRows.reduce((s, r) => s + r.amount, 0).toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Total Payments</div>
              </div>
            </div>

            {unmatchedRows.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {unmatchedRows.filter(r => r.matchStatus === "customer_not_found").length > 0 && (
                    <span>Some customers not found in contacts. </span>
                  )}
                  {unmatchedRows.filter(r => r.matchStatus === "invoice_not_found").length > 0 && (
                    <span>Some invoices not found — make sure Open AR was imported first. </span>
                  )}
                  These rows will be skipped.
                </AlertDescription>
              </Alert>
            )}

            {importLoop.progress && (
              <div className="text-sm text-muted-foreground text-center">
                Importing... {importLoop.progress.current} / {importLoop.progress.total}
              </div>
            )}

            <div className="max-h-64 overflow-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Invoice #</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.slice(0, 50).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{row.customerName}</TableCell>
                      <TableCell className="font-mono text-xs">{row.invoiceNumber}</TableCell>
                      <TableCell className="text-xs">{row.paymentDate}</TableCell>
                      <TableCell className="text-right text-sm">{row.amount.toLocaleString()}</TableCell>
                      <TableCell className="text-xs">{row.paymentMethod}</TableCell>
                      <TableCell>
                        <Badge
                          variant={row.matchStatus === "matched" ? "default" : "destructive"}
                          className="text-xs"
                        >
                          {row.matchStatus === "matched" ? "matched" : row.matchStatus === "invoice_not_found" ? "no invoice" : "no customer"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleImport} disabled={matchedRows.length === 0 || importLoop.isImporting} className="flex-1">
                {importLoop.isImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import {matchedRows.length} Payments (with GL posting)
              </Button>
              <Button variant="ghost" onClick={onSkip}>Skip</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

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
import { createEntityMatcher } from "@/lib/migration/entityMatcher";
import {
  autoMapMigrationColumns,
  getMappedValue,
  validateMappedRow,
  OPEN_AR_FIELDS,
  OPEN_AP_FIELDS,
  type MigrationFieldSpec,
  type ColumnMapping,
} from "@/lib/migration/columnMapper";
import { validateBatchCurrencies } from "@/lib/migration/currencyValidation";
import { downloadTemplate } from "@/lib/migration/csvTemplates";
import { useToast } from "@/hooks/use-toast";
import { Upload, FileSpreadsheet, Loader2, Info, AlertTriangle, Download, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";

type BalanceType = "ar" | "ap";

interface OpenBalanceRow {
  entityName: string;
  documentNumber: string;
  documentDate: string;
  dueDate: string;
  amount: number;
  amountPaid: number;
  currency: string;
  matchedContactId?: string;
  status: "matched" | "unmatched";
  validationErrors?: string[];
}

interface Props {
  type: BalanceType;
  onComplete: () => void;
  onSkip: () => void;
}

const CONFIG = {
  ar: {
    title: "Open Receivables (AR)",
    entityLabel: "Customer",
    documentLabel: "Invoice",
    documentNumberLabel: "Invoice #",
    stepKey: "open_ar" as const,
    templateKey: "open_ar" as const,
    contactTypes: ["customer", "both"] as const,
    sourceSystemStep: "open_ar" as const,
    fields: OPEN_AR_FIELDS,
    descriptions: {
      normal: " These create subledger records for aging and tracking. The GL balance was already posted via the Trial Balance step.",
      fullTransaction: " Each invoice will have its own GL journal entry for full traceability.",
    },
    accountWarning: "Full transaction mode requires default account mappings (AR, Revenue). Use the link above to configure them.",
    fullTransactionNote: "Each imported invoice will generate an individual journal entry (DR Accounts Receivable, CR Revenue). Ensure your Trial Balance does NOT include AR totals to prevent double-counting.",
    subledgerNote: "These invoices are for subledger tracking (aging reports, customer statements). The AR GL balance was already included in your Trial Balance import.",
    unmatchedLabel: "customer(s) not found in contacts",
    totalLabel: "Total AR",
    importLabel: "Open Invoices",
    toastTitle: "Open AR imported",
  },
  ap: {
    title: "Open Payables (AP)",
    entityLabel: "Supplier",
    documentLabel: "Bill",
    documentNumberLabel: "Bill #",
    stepKey: "open_ap" as const,
    templateKey: "open_ap" as const,
    contactTypes: ["supplier", "both"] as const,
    sourceSystemStep: "open_ap" as const,
    fields: OPEN_AP_FIELDS,
    descriptions: {
      normal: " These create subledger records for aging and tracking. The GL balance was already posted via the Trial Balance step.",
      fullTransaction: " Each bill will have its own GL journal entry for full traceability.",
    },
    accountWarning: "Full transaction mode requires default account mappings (AP, Expense). Use the link above to configure them.",
    fullTransactionNote: "Each imported bill will generate an individual journal entry (DR Expense, CR Accounts Payable). Ensure your Trial Balance does NOT include AP totals to prevent double-counting.",
    subledgerNote: "These bills are for subledger tracking (aging reports, vendor statements). The AP GL balance was already included in your Trial Balance import.",
    unmatchedLabel: "supplier(s) not found",
    totalLabel: "Total AP",
    importLabel: "Open Bills",
    toastTitle: "Open AP imported",
  },
};

export function MigrationStepOpenBalance({ type, onComplete, onSkip }: Props) {
  const cfg = CONFIG[type];
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const migration = useMigrationSession();
  const { postToGL, postBillToGL } = useGLPosting();
  const { getInvoiceAccountMappings, getBillAccountMappings, hasRequiredAccounts } = useDefaultAccounts();
  const [parsedRows, setParsedRows] = useState<OpenBalanceRow[]>([]);
  const [currencyWarning, setCurrencyWarning] = useState<string | null>(null);
  const [validationWarnings, setValidationWarnings] = useState<number>(0);

  const isFullTransaction = migration.session?.migration_strategy === "full_transaction";

  const fileUpload = useMigrationFileUpload({
    isBatchDuplicate: migration.isBatchDuplicate,
    allowRetry: true,
    onParsed: useCallback(async ({ headers, rows }) => {
      // Use shared column mapper
      const mapping = autoMapMigrationColumns(headers, cfg.fields, cfg.sourceSystemStep);

      const { fetchAllRows } = await import("@/lib/supabasePagination");
      const contacts = await fetchAllRows<{ id: string; name: string; type: string }>(
        "contacts",
        "id, name, type",
        [
          { method: "eq", column: "organization_id", value: currentOrg!.id },
          { method: "in", column: "type", value: cfg.contactTypes },
        ]
      );

      // Use shared entity matcher with fuzzy support
      const matcher = createEntityMatcher(contacts, {
        secondaryKey: (c) => c.name,
        fuzzyMatch: true,
        fuzzyThreshold: 0.7,
      });

      let warningCount = 0;

      const parsed: OpenBalanceRow[] = rows
        .filter(row => {
          const name = getMappedValue(row, "entity_name", mapping, cfg.fields);
          return name && (name as string).trim();
        })
        .map(row => {
          // Pre-import validation
          const errors = validateMappedRow(row, mapping, cfg.fields);
          if (errors.length > 0) warningCount++;

          const name = (getMappedValue(row, "entity_name", mapping, cfg.fields) as string) || "";
          const matchResult = matcher.match(undefined, name);
          const totalAmt = Math.abs((getMappedValue(row, "amount", mapping, cfg.fields) as number) || 0);
          const paidAmt = Math.abs((getMappedValue(row, "amount_paid", mapping, cfg.fields) as number) || 0);
          const docDate = (getMappedValue(row, "doc_date", mapping, cfg.fields) as string) || new Date().toISOString().slice(0, 10);

          return {
            entityName: name,
            documentNumber: (getMappedValue(row, "doc_number", mapping, cfg.fields) as string) || "",
            documentDate: docDate,
            dueDate: (getMappedValue(row, "due_date", mapping, cfg.fields) as string) || "",
            amount: totalAmt,
            amountPaid: Math.min(paidAmt, totalAmt),
            currency: (getMappedValue(row, "currency", mapping, cfg.fields) as string) || "",
            matchedContactId: matchResult?.item.id,
            status: matchResult ? "matched" as const : "unmatched" as const,
            validationErrors: errors.length > 0 ? errors : undefined,
          };
        });

      setValidationWarnings(warningCount);

      const baseCurrency = currentBusiness?.base_currency ?? "";
      const currencyCheck = validateBatchCurrencies(
        parsed.map(r => ({ amount: r.amount, currency: r.currency || undefined })),
        baseCurrency
      );
      if (currencyCheck.hasMultipleCurrencies) {
        setCurrencyWarning(currencyCheck.summary);
      } else {
        setCurrencyWarning(null);
      }

      setParsedRows(parsed);
    }, [currentOrg, cfg]),
  });

  const importLoop = useMigrationImportLoop({
    recordBatch: migration.recordBatch,
    updateStepStatus: migration.updateStepStatus,
  });

  const matchedRows = parsedRows.filter(r => r.status === "matched");
  const unmatchedRows = parsedRows.filter(r => r.status === "unmatched");
  const totalAmount = matchedRows.reduce((s, r) => s + r.amount, 0);

  const handleImport = async () => {
    if (!currentOrg?.id || !fileUpload.file || !user) return;

    if (isFullTransaction && !hasRequiredAccounts()) {
      toast({
        title: "Account mappings required",
        description: cfg.accountWarning,
        variant: "destructive",
      });
      return;
    }

    const cutoverDate = migration.session?.cutover_date || new Date().toISOString().slice(0, 10);
    const importable = matchedRows.filter(r => r.matchedContactId && r.amount > 0);

    await importLoop.executeLoop({
      stepKey: cfg.stepKey,
      fileHash: fileUpload.fileHash,
      fileName: fileUpload.file.name,
      totalRows: parsedRows.length,
      matchedRows: importable,
      unmatchedCount: unmatchedRows.length,
      chunkSize: 50,
      // Batch insert for non-GL rows, row-by-row for GL posting
      ...(isFullTransaction
        ? {
            // Row-by-row when GL posting is needed (each row needs its own JE)
            importRow: async (row: OpenBalanceRow, i: number) => {
              await importSingleRow(row, i, cutoverDate);
            },
          }
        : {
            // Batch insert when no GL posting needed
            batchInsert: async (chunk: OpenBalanceRow[]) => {
              return await importBatch(chunk, cutoverDate);
            },
            // Fallback for individual retry
            importRow: async (row: OpenBalanceRow, i: number) => {
              await importSingleRow(row, i, cutoverDate);
            },
          }),
      getRowLabel: (row) => `${row.entityName} / ${row.documentNumber}`,
      onSuccess: onComplete,
      successMessage: cfg.toastTitle,
      successDescription: `${importable.length} ${cfg.importLabel.toLowerCase()} created${isFullTransaction ? " with individual GL entries" : " for subledger tracking"}. ${unmatchedRows.length} unmatched rows skipped.`,
    });
  };

  /** Import a batch of rows without GL posting */
  const importBatch = async (chunk: OpenBalanceRow[], cutoverDate: string) => {
    let imported = 0;
    const errors: Array<{ item: string; error: string }> = [];

    if (type === "ar") {
      const inserts = chunk.map((row, i) => {
        const balanceDue = row.amount - row.amountPaid;
        const invoiceStatus = (balanceDue <= 0.01 ? "paid" : row.amountPaid > 0 ? "partial" : "confirmed") as "paid" | "partial" | "confirmed";
        return {
          organization_id: currentOrg!.id,
          business_id: currentBusiness?.id || null,
          // Migrated opening balances are historical & not attributable to a
          // current branch — stamped NULL intentionally so the architecture
          // guard knows we considered the dimension.
          branch_id: null,
          contact_id: row.matchedContactId!,
          invoice_number: row.documentNumber || `MIG-AR-${Date.now()}-${i}`,
          issue_date: row.documentDate || cutoverDate,
          due_date: row.dueDate || cutoverDate,
          subtotal: row.amount,
          tax_amount: 0,
          total: row.amount,
          amount_paid: row.amountPaid,
          status: invoiceStatus,
          notes: "Migration: Opening AR balance",
          source: "migration",
          created_by: user!.id,
          migration_session_id: migration.session?.id || null,
        };
      });

      const { data, error } = await supabase.from("invoices").insert(inserts).select("id");
      if (error) {
        // Batch failed — report all as errors for fallback
        throw error;
      }
      imported = data?.length || 0;
    } else {
      const inserts = chunk.map((row, i) => {
        const balanceDue = row.amount - row.amountPaid;
        const billStatus = (balanceDue <= 0.01 ? "paid" : row.amountPaid > 0 ? "partial" : "received") as "paid" | "partial" | "received";
        return {
          organization_id: currentOrg!.id,
          business_id: currentBusiness?.id || null,
          branch_id: null,
          vendor_id: row.matchedContactId!,
          bill_number: row.documentNumber || `MIG-AP-${Date.now()}-${i}`,
          bill_date: row.documentDate || cutoverDate,
          due_date: row.dueDate || cutoverDate,
          subtotal: row.amount,
          tax_amount: 0,
          total: row.amount,
          amount_paid: row.amountPaid,
          status: billStatus,
          notes: "Migration: Opening AP balance",
          created_by: user!.id,
          migration_session_id: migration.session?.id || null,
        };
      });

      const { data, error } = await supabase.from("bills").insert(inserts).select("id");
      if (error) throw error;
      imported = data?.length || 0;
    }

    return { imported, errors };
  };

  /** Import a single row (used for GL posting mode or as batch fallback) */
  const importSingleRow = async (row: OpenBalanceRow, i: number, cutoverDate: string) => {
    const balanceDue = row.amount - row.amountPaid;

    if (type === "ar") {
      const invoiceStatus = balanceDue <= 0.01 ? "paid" : row.amountPaid > 0 ? "partial" : "confirmed";
      const { data: invoice, error: invError } = await supabase
        .from("invoices")
        .insert({
          organization_id: currentOrg!.id,
          business_id: currentBusiness?.id || null,
          branch_id: null, // historical migration — not attributable to a branch
          contact_id: row.matchedContactId!,
          invoice_number: row.documentNumber || `MIG-AR-${Date.now()}-${i}`,
          issue_date: row.documentDate || cutoverDate,
          due_date: row.dueDate || cutoverDate,
          subtotal: row.amount,
          tax_amount: 0,
          total: row.amount,
          amount_paid: row.amountPaid,
          status: invoiceStatus,
          notes: `Migration: ${isFullTransaction ? "Full transaction import" : "Opening AR balance"}`,
          source: "migration",
          created_by: user!.id,
          migration_session_id: migration.session?.id || null,
        })
        .select("id, invoice_number, issue_date, subtotal, tax_amount, total, contact_id")
        .single();

      if (invError) throw invError;

      if (isFullTransaction && invoice) {
        const accountMappings = getInvoiceAccountMappings();
        if (accountMappings.receivable_account_id && accountMappings.revenue_account_id) {
          // C-5b: use canonical postToGL with per-line entries (no legacy fallback).
          const entries = [
            {
              account_id: accountMappings.receivable_account_id,
              debit_amount: invoice.total,
              credit_amount: 0,
              description: `Invoice ${invoice.invoice_number} - Accounts Receivable`,
              contact_id: invoice.contact_id || undefined,
            },
            {
              account_id: accountMappings.revenue_account_id,
              debit_amount: 0,
              credit_amount: invoice.subtotal,
              description: `Invoice ${invoice.invoice_number} - Sales Revenue`,
            },
          ];
          if (invoice.tax_amount > 0 && accountMappings.tax_liability_account_id) {
            entries.push({
              account_id: accountMappings.tax_liability_account_id,
              debit_amount: 0,
              credit_amount: invoice.tax_amount,
              description: `Invoice ${invoice.invoice_number} - Tax Liability`,
            });
          }
          const jeId = await postToGL({
            source_type: "invoice",
            source_id: invoice.id,
            reference: invoice.invoice_number,
            memo: `Migration: Invoice ${invoice.invoice_number}`,
            entry_date: invoice.issue_date,
            entries,
          });
          if (jeId) {
            // Phase 6.3: `journal_entry_id` is governed; the importer uses the
            // link-once engine instead of a direct table write.
            const { error: linkError } = await supabase.rpc(
              "link_invoice_journal_entry_atomic" as never,
              { p_invoice_id: invoice.id, p_journal_entry_id: jeId } as never,
            );
            if (linkError) throw linkError;
          }
        }
      }
    } else {
      const billStatus = balanceDue <= 0.01 ? "paid" : row.amountPaid > 0 ? "partial" : "received";
      const { data: bill, error: billError } = await supabase
        .from("bills")
        .insert({
          organization_id: currentOrg!.id,
          business_id: currentBusiness?.id || null,
          branch_id: null, // historical migration — not attributable to a branch
          vendor_id: row.matchedContactId!,
          bill_number: row.documentNumber || `MIG-AP-${Date.now()}-${i}`,
          bill_date: row.documentDate || cutoverDate,
          due_date: row.dueDate || cutoverDate,
          subtotal: row.amount,
          tax_amount: 0,
          total: row.amount,
          amount_paid: row.amountPaid,
          status: billStatus,
          notes: `Migration: ${isFullTransaction ? "Full transaction import" : "Opening AP balance"}`,
          created_by: user!.id,
          migration_session_id: migration.session?.id || null,
        })
        .select("id, bill_number, bill_date, subtotal, tax_amount, total, vendor_id")
        .single();

      if (billError) throw billError;

      if (isFullTransaction && bill) {
        const accountMappings = getBillAccountMappings();
        if (accountMappings.payable_account_id && accountMappings.expense_account_id) {
          // C-5b: use canonical postToGL with per-line entries.
          const entries = [
            {
              account_id: accountMappings.expense_account_id,
              debit_amount: bill.subtotal,
              credit_amount: 0,
              description: `Bill ${bill.bill_number} - Expense`,
            },
            {
              account_id: accountMappings.payable_account_id,
              debit_amount: 0,
              credit_amount: bill.total,
              description: `Bill ${bill.bill_number} - Accounts Payable`,
              contact_id: bill.vendor_id || undefined,
            },
          ];
          if (bill.tax_amount > 0 && accountMappings.tax_asset_account_id) {
            entries.push({
              account_id: accountMappings.tax_asset_account_id,
              debit_amount: bill.tax_amount,
              credit_amount: 0,
              description: `Bill ${bill.bill_number} - Input Tax`,
            });
          }
          const jeId = await postToGL({
            source_type: "bill",
            source_id: bill.id,
            reference: bill.bill_number,
            memo: `Migration: Bill ${bill.bill_number}`,
            entry_date: bill.bill_date,
            entries,
          });
          if (jeId) {
            await supabase.from("bills").update({ journal_entry_id: jeId }).eq("id", bill.id);
          }
        }
      }
    }
  };

  const handleReset = () => {
    fileUpload.reset();
    setParsedRows([]);
    setCurrencyWarning(null);
    setValidationWarnings(0);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{cfg.title}</CardTitle>
          <Button variant="outline" size="sm" onClick={() => downloadTemplate(cfg.templateKey)}>
            <Download className="mr-2 h-4 w-4" /> Template
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Import outstanding {type === "ar" ? "customer invoices" : "supplier bills"} as of the cutover date.
          {isFullTransaction ? cfg.descriptions.fullTransaction : cfg.descriptions.normal}
        </p>

        {isFullTransaction && !hasRequiredAccounts() && (
          <Alert className="border-destructive/30 bg-destructive/5">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm">{cfg.accountWarning}</span>
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

        {isFullTransaction && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>Full Transaction Mode:</strong> {cfg.fullTransactionNote}
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
                    Columns: {cfg.entityLabel} Name, {cfg.documentNumberLabel}, {cfg.documentLabel} Date, Due Date, Amount, Amount Paid (optional)
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
                <div className="text-sm font-bold">{totalAmount.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">{cfg.totalLabel}</div>
              </div>
            </div>

            {validationWarnings > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {validationWarnings} row(s) have validation warnings (missing required fields or invalid dates/amounts).
                </AlertDescription>
              </Alert>
            )}

            {currencyWarning && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{currencyWarning}</AlertDescription>
              </Alert>
            )}

            {unmatchedRows.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {unmatchedRows.length} {cfg.unmatchedLabel}: {unmatchedRows.slice(0, 3).map(r => r.entityName).join(", ")}
                  {unmatchedRows.length > 3 && ` and ${unmatchedRows.length - 3} more`}
                  {type === "ar" && ". Import contacts first or these will be skipped."}
                </AlertDescription>
              </Alert>
            )}

            {!isFullTransaction && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>{cfg.subledgerNote}</AlertDescription>
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
                    <TableHead>{cfg.entityLabel}</TableHead>
                    <TableHead>{cfg.documentNumberLabel}</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Due Date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>{type === "ar" ? "Match" : "Status"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.slice(0, 50).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{row.entityName}</TableCell>
                      <TableCell className="font-mono text-xs">{row.documentNumber}</TableCell>
                      <TableCell className="text-xs">{row.documentDate}</TableCell>
                      <TableCell className="text-xs">{row.dueDate}</TableCell>
                      <TableCell className="text-right text-sm">{row.amount.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">{row.amountPaid > 0 ? row.amountPaid.toLocaleString() : "—"}</TableCell>
                      <TableCell className="text-right text-sm font-medium">{(row.amount - row.amountPaid).toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge variant={row.status === "matched" ? "default" : "destructive"} className="text-xs">{row.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {importLoop.lastErrors.length > 0 && (
              <Button variant="outline" size="sm" onClick={importLoop.downloadErrors}>
                <Download className="mr-2 h-4 w-4" /> Download Error Report
              </Button>
            )}

            <div className="flex gap-2">
              <Button onClick={handleImport} disabled={matchedRows.length === 0 || importLoop.isImporting} className="flex-1">
                {importLoop.isImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import {matchedRows.length} {cfg.importLabel}
                {isFullTransaction && " (with GL posting)"}
              </Button>
              <Button variant="ghost" onClick={onSkip}>Skip</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

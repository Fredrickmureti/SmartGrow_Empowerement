/**
 * ImportStatementWizardPage — routed `WizardShell` replacement for the
 * legacy `ImportTransactionsDialog`. Route: `/finance/banking/import`
 * (optionally `?accountId=<id>` to preselect an account).
 *
 * Behaviour is ported verbatim from the dialog: file-hash dedupe, column
 * mapping (CSV/Excel), row-hash duplicate detection, batched upsert with
 * transaction-rule auto-categorization on success.
 */
// @ts-nocheck — bank_statements/bank_transactions tables not in auto types
import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Upload,
  FileSpreadsheet,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  FooterActionBar,
  PageHeader,
  WizardShell,
  WizardStepper,
  type WizardStep,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { supabase } from "@/integrations/supabase/client";
import {
  parseStatementFile,
  applyColumnMapping,
  computeFileHash,
  generateTransactionHash,
  type ParsedBankTransaction,
  type ParsedStatement,
  type ParsedStatementColumn,
  type ColumnMapping,
} from "@/lib/bankStatementParsers";

import { normalizeError } from "@/services/resilience";

const STEPS: WizardStep[] = [
  { id: "upload", label: "Upload" },
  { id: "map", label: "Map columns" },
  { id: "preview", label: "Preview" },
  { id: "done", label: "Complete" },
];

type StepId = (typeof STEPS)[number]["id"];

export default function ImportStatementWizardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedAccountId = searchParams.get("accountId") || "";

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { accounts: bankAccounts } = useBankAccounts();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<StepId>("upload");
  const [selectedAccountId, setSelectedAccountId] = useState(preselectedAccountId);
  const [file, setFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState("");
  const [parsedStatement, setParsedStatement] = useState<ParsedStatement | null>(null);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({
    date: "",
    description: "",
    amount: "",
    reference: "",
  });
  const [finalTransactions, setFinalTransactions] = useState<ParsedBankTransaction[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    success: number;
    failed: number;
    duplicates: number;
    rejectedRows: Array<{ row: number; reason: string }>;
  } | null>(null);
  const [duplicateCount, setDuplicateCount] = useState(0);

  const completedSteps: StepId[] = (() => {
    const order: StepId[] = ["upload", "map", "preview", "done"];
    const idx = order.indexOf(step);
    return order.slice(0, idx);
  })();

  const goBackToBanking = () => navigate("/finance/banking");

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    setFile(selectedFile);

    try {
      const hash = await computeFileHash(selectedFile);
      setFileHash(hash);

      const { data: existingStatement } = await supabase
        .from("bank_statements")
        .select("id, file_name, created_at")
        .eq("bank_account_id", selectedAccountId)
        .eq("file_hash", hash)
        .maybeSingle();

      if (existingStatement) {
        toast.warning(
          `This file was already imported as "${existingStatement.file_name}". Duplicate rows will be skipped.`,
        );
      }

      const statement = await parseStatementFile(selectedFile);
      setParsedStatement(statement);

      if (statement.needsColumnMapping) {
        setStep("map");
      } else {
        await preparePreview(statement.transactions);
      }
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to parse file");
    }
  };

  const handleMappingComplete = async () => {
    if (
      !columnMapping.date ||
      !columnMapping.description ||
      (!columnMapping.amount && !columnMapping.credit)
    ) {
      toast.error("Please map at least Date, Description, and Amount columns");
      return;
    }
    if (!parsedStatement?.columns || !parsedStatement?.rawRows) return;

    const mapped = applyColumnMapping(
      parsedStatement.columns,
      parsedStatement.rawRows,
      columnMapping,
      selectedAccountId,
    );

    await preparePreview(mapped);
  };

  const preparePreview = async (transactions: ParsedBankTransaction[]) => {
    if (selectedAccountId && transactions.length > 0) {
      const hashes = transactions.map((t) =>
        generateTransactionHash(
          t.date,
          t.description,
          t.type === "credit" ? t.amount : -t.amount,
          t.reference,
          selectedAccountId,
        ),
      );

      const { data: existing } = await supabase
        .from("bank_transactions")
        .select("external_transaction_id")
        .eq("bank_account_id", selectedAccountId)
        .in("external_transaction_id", hashes);

      const existingSet = new Set(
        (existing || []).map((e) => e.external_transaction_id),
      );
      const dupes = hashes.filter((h) => existingSet.has(h)).length;
      setDuplicateCount(dupes);
    }

    setFinalTransactions(transactions);
    setStep("preview");
  };

  /**
   * Ingestion is server-owned (ADR: one statement ingestion engine).
   * The browser only hands over the parsed rows; the database assigns the
   * dedup fingerprint, applies categorization rules, enforces the account
   * lifecycle and fiscal-period locks, writes the statement header and its
   * rows in ONE transaction, and emits the business event.
   */
  const handleImport = async () => {
    if (!selectedAccountId || finalTransactions.length === 0) return;

    setIsImporting(true);
    try {
      const rows = finalTransactions.map((row) => ({
        transaction_date: row.date,
        description: row.description,
        reference: row.reference || null,
        amount: row.type === "credit" ? row.amount : -row.amount,
        balance_after: row.balance ?? null,
        raw_data: row.rawData || null,
      }));

      const { data, error } = await supabase.rpc("bank_statement_import_batch", {
        _bank_account_id: selectedAccountId,
        _rows: rows,
        _statement: {
          file_name: file?.name || "manual_import",
          file_hash: fileHash || `batch_${Date.now()}`,
          file_format: parsedStatement?.format || null,
          opening_balance: parsedStatement?.metadata?.openingBalance ?? null,
          closing_balance: parsedStatement?.metadata?.closingBalance ?? null,
        },
        _source: "manual_import",
      } as any);

      if (error) throw error;

      const result = (data ?? {}) as {
        inserted?: number;
        duplicates?: number;
        rejected?: number;
        rejected_rows?: Array<{ row: number; reason: string }>;
      };

      const firstRejection = result.rejected_rows?.[0];
      if (result.rejected && firstRejection) {
        toast.warning(
          `${result.rejected} row(s) skipped — ${firstRejection.reason}`,
        );
      }

      setImportResult({
        success: result.inserted ?? 0,
        failed: result.rejected ?? 0,
        duplicates: result.duplicates ?? 0,
        rejectedRows: result.rejected_rows ?? [],
      });
      setStep("done");
    } catch (error) {
      console.error("Import error:", error);
      toast.error(normalizeError(error).message || "Failed to import transactions");
    } finally {
      setIsImporting(false);
    }
  };

  const columns = parsedStatement?.columns || [];
  const rawRows = parsedStatement?.rawRows || [];


  const stepDescription =
    step === "upload"
      ? "Upload a bank statement file (CSV, Excel, OFX, QBO, or QIF)."
      : step === "map"
        ? "Match the columns in your file to transaction fields."
        : step === "preview"
          ? `Review ${finalTransactions.length} transactions before importing${
              duplicateCount > 0 ? ` (${duplicateCount} duplicates will be skipped)` : ""
            }.`
          : "Your transactions have been imported.";

  const footer = (() => {
    if (step === "upload") {
      return (
        <FooterActionBar
          anchor="inline"
          trailing={
            <Button variant="outline" onClick={goBackToBanking}>
              Cancel
            </Button>
          }
        />
      );
    }
    if (step === "map") {
      return (
        <FooterActionBar
          anchor="inline"
          leading={
            <Button variant="outline" onClick={() => setStep("upload")}>
              Back
            </Button>
          }
          trailing={
            <Button onClick={handleMappingComplete}>Continue to preview</Button>
          }
        />
      );
    }
    if (step === "preview") {
      return (
        <FooterActionBar
          anchor="inline"
          leading={
            <Button
              variant="outline"
              onClick={() =>
                setStep(parsedStatement?.needsColumnMapping ? "map" : "upload")
              }
            >
              Back
            </Button>
          }
          trailing={
            <Button onClick={handleImport} disabled={isImporting}>
              {isImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Import {finalTransactions.length - duplicateCount} transactions
            </Button>
          }
        />
      );
    }
    return (
      <FooterActionBar
        anchor="inline"
        trailing={<Button onClick={goBackToBanking}>Done</Button>}
      />
    );
  })();

  return (
    <WizardShell
      header={
        <PageHeader
          eyebrow="Banking"
          title="Import bank statement"
          description={stepDescription}
        />
      }
      stepper={
        <WizardStepper
          steps={STEPS}
          activeStepId={step}
          completedStepIds={completedSteps}
          onStepClick={(id) => setStep(id as StepId)}
        />
      }
      footer={footer}
    >
      {step === "upload" && (
        <div className="space-y-6">
          <div className="space-y-2">
            <Label>Select bank account</Label>
            <Select
              value={selectedAccountId}
              onValueChange={setSelectedAccountId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {(bankAccounts || []).map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.name} — {acc.bank_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Upload statement file</Label>
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                selectedAccountId
                  ? "hover:border-primary hover:bg-muted/50"
                  : "opacity-50 cursor-not-allowed"
              }`}
              onClick={() => selectedAccountId && fileInputRef.current?.click()}
              onDragOver={(e) => {
                if (selectedAccountId) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDragEnter={(e) => {
                if (selectedAccountId) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!selectedAccountId) return;
                const droppedFile = e.dataTransfer.files?.[0];
                if (droppedFile) {
                  const dataTransfer = new DataTransfer();
                  dataTransfer.items.add(droppedFile);
                  if (fileInputRef.current) {
                    fileInputRef.current.files = dataTransfer.files;
                    fileInputRef.current.dispatchEvent(
                      new Event("change", { bubbles: true }),
                    );
                  }
                }
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,.txt,.ofx,.qbo,.qif"
                onChange={handleFileChange}
                className="hidden"
                disabled={!selectedAccountId}
              />
              <FileSpreadsheet className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
              <p className="font-medium">Click to upload or drag and drop</p>
              <p className="mt-1 text-sm text-muted-foreground">
                CSV, Excel (.xlsx), OFX, QBO, QIF
              </p>
            </div>
          </div>
        </div>
      )}

      {step === "map" && (
        <div className="space-y-6">
          <Card>
            <CardContent className="pt-4">
              <p className="mb-4 text-sm text-muted-foreground">
                Found {columns.length} columns and {rawRows.length} rows. Map
                your columns below:
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <MapField
                  label="Date column *"
                  value={columnMapping.date}
                  columns={columns}
                  onChange={(v) => setColumnMapping({ ...columnMapping, date: v })}
                />
                <MapField
                  label="Description column *"
                  value={columnMapping.description}
                  columns={columns}
                  onChange={(v) =>
                    setColumnMapping({ ...columnMapping, description: v })
                  }
                />
                <MapField
                  label="Amount column (if single column)"
                  value={columnMapping.amount}
                  columns={columns}
                  optional
                  onChange={(v) => setColumnMapping({ ...columnMapping, amount: v })}
                />
                <MapField
                  label="Reference column (optional)"
                  value={columnMapping.reference}
                  columns={columns}
                  optional
                  onChange={(v) =>
                    setColumnMapping({ ...columnMapping, reference: v })
                  }
                />
                <MapField
                  label="Credit column (if separate)"
                  value={columnMapping.credit}
                  columns={columns}
                  optional
                  onChange={(v) => setColumnMapping({ ...columnMapping, credit: v })}
                />
                <MapField
                  label="Debit column (if separate)"
                  value={columnMapping.debit}
                  columns={columns}
                  optional
                  onChange={(v) => setColumnMapping({ ...columnMapping, debit: v })}
                />
                <MapField
                  label="Balance column (optional)"
                  value={columnMapping.balance}
                  columns={columns}
                  optional
                  onChange={(v) =>
                    setColumnMapping({ ...columnMapping, balance: v })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((col) => (
                    <TableHead key={col.key} className="whitespace-nowrap">
                      {col.key}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rawRows.slice(0, 3).map((row, i) => (
                  <TableRow key={i}>
                    {columns.map((col) => (
                      <TableCell key={col.key} className="whitespace-nowrap">
                        {row[col.index] ?? ""}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {/* "parsed", not "ready": statement-level validation (account
                lifecycle, currency, period locks) happens server-side inside
                the import engine, after this step. */}
            <Badge variant="outline">
              {finalTransactions.length} transactions parsed
            </Badge>
            {duplicateCount > 0 && (
              <Badge
                variant="secondary"
                className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
              >
                {duplicateCount} duplicates will be skipped
              </Badge>
            )}
            {parsedStatement?.format && (
              <Badge variant="secondary">
                Format: {parsedStatement.format.toUpperCase()}
              </Badge>
            )}
            {parsedStatement?.metadata?.currency && (
              <Badge variant="secondary">
                {parsedStatement.metadata.currency}
              </Badge>
            )}
          </div>

          <div className="max-h-[400px] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  {finalTransactions.some((t) => t.balance !== undefined) && (
                    <TableHead className="text-right">Balance</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {finalTransactions.slice(0, 50).map((row, i) => (
                  <TableRow key={i}>
                    <TableCell>{row.date}</TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {row.description}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={row.type === "credit" ? "default" : "secondary"}
                      >
                        {row.type}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium ${
                        row.type === "credit" ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {row.type === "credit" ? "+" : "-"}
                      {row.amount.toLocaleString()}
                    </TableCell>
                    {finalTransactions.some((t) => t.balance !== undefined) && (
                      <TableCell className="text-right text-muted-foreground">
                        {row.balance?.toLocaleString() ?? "—"}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {finalTransactions.length > 50 && (
            <p className="text-center text-sm text-muted-foreground">
              Showing first 50 of {finalTransactions.length} transactions
            </p>
          )}
        </div>
      )}

      {step === "done" && importResult && (
        <div className="py-8 text-center">
          {importResult.success > 0 ? (
            <CheckCircle2 className="mx-auto mb-4 h-16 w-16 text-green-500" />
          ) : (
            <AlertCircle className="mx-auto mb-4 h-16 w-16 text-amber-500" />
          )}
          <h3 className="mb-2 text-xl font-semibold">
            {importResult.success > 0 ? "Import successful!" : "Import failed"}
          </h3>
          <div className="flex items-center justify-center gap-4 text-sm">
            <span className="text-green-600">
              <CheckCircle2 className="mr-1 inline h-4 w-4" />
              {importResult.success} imported
            </span>
            {importResult.duplicates > 0 && (
              <span className="text-amber-600">
                <AlertCircle className="mr-1 inline h-4 w-4" />
                {importResult.duplicates} duplicates skipped
              </span>
            )}
            {importResult.failed > 0 && (
              <span className="text-red-600">
                <X className="mr-1 inline h-4 w-4" />
                {importResult.failed} failed
              </span>
            )}
          </div>
        </div>
      )}
    </WizardShell>
  );
}

interface MapFieldProps {
  label: string;
  value: string | undefined;
  columns: ParsedStatementColumn[];
  optional?: boolean;
  onChange: (v: string) => void;
}

/**
 * Column picker. Option values are `column.key` — guaranteed non-empty and
 * unique by the parser — so a blank or duplicated header in the source file
 * can never become an empty selectable value. "Not mapped" is represented by
 * the placeholder (required fields) or the `__none__` sentinel (optional).
 */
function MapField({ label, value, columns, optional, onChange }: MapFieldProps) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select
        value={value || (optional ? "__none__" : undefined)}
        onValueChange={(v) => onChange(optional && v === "__none__" ? "" : v)}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select column" />
        </SelectTrigger>
        <SelectContent>
          {optional && <SelectItem value="__none__">None</SelectItem>}
          {columns.map((col) => (
            <SelectItem key={col.key} value={col.key}>
              <span>{col.key}</span>
              {col.sample && (
                <span className="ml-2 text-muted-foreground">
                  e.g. {col.sample}
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

}

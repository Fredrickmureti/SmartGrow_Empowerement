import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOpeningBalanceCheck } from "@/hooks/useOpeningBalanceCheck";
import { useMigrationSession } from "@/hooks/useMigrationSession";
import { useMigrationFileUpload } from "@/hooks/useMigrationFileUpload";
import { useGLPosting, type GLEntry } from "@/hooks/useGLPosting";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { hashFileContent } from "@/lib/migration/hashUtils";
import { downloadTemplate } from "@/lib/migration/csvTemplates";
import {
  autoMapMigrationColumns,
  getMappedValue,
  validateMappedRow,
  TRIAL_BALANCE_FIELDS,
} from "@/lib/migration/columnMapper";
import { createEntityMatcher } from "@/lib/migration/entityMatcher";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Info,
  Download,
  PlusCircle,
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  matchedAccountId?: string;
  matchedAccountType?: string;
  status: "matched" | "unmatched" | "fuzzy_match" | "error";
  fuzzyMatchCandidates?: Array<{ id: string; code: string; name: string; score: number }>;
  validationErrors?: string[];
  error?: string;
}

export function MigrationStepTrialBalance({ onComplete }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const migration = useMigrationSession();
  const balanceCheck = useOpeningBalanceCheck();
  const { postToGL } = useGLPosting();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const [parsedRows, setParsedRows] = useState<TrialBalanceRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
  const [validationWarnings, setValidationWarnings] = useState<number>(0);

  const fileUpload = useMigrationFileUpload({
    isBatchDuplicate: migration.isBatchDuplicate,
    allowRetry: true,
    onParsed: useCallback(async ({ headers, rows }) => {
      // Use shared column mapper instead of inline regex
      const mapping = autoMapMigrationColumns(headers, TRIAL_BALANCE_FIELDS, "trial_balance");

      // Fetch ALL existing accounts (paginated past 1000-row limit)
      const { fetchAllRows } = await import("@/lib/supabasePagination");
      const accounts = await fetchAllRows<{ id: string; code: string; name: string; account_type: string }>(
        "accounts",
        "id, code, name, account_type",
        [
          { method: "eq", column: "organization_id", value: currentOrg!.id },
          { method: "eq", column: "is_active", value: true },
        ]
      );

      // Use shared entity matcher
      const matcher = createEntityMatcher(accounts, {
        primaryKey: (a) => a.code,
        secondaryKey: (a) => a.name,
        fuzzyMatch: true,
        fuzzyThreshold: 0.5,
      });

      // Debit-normal account types: assets, expenses
      const isDebitNormal = (accountType: string) =>
        ["asset", "expense"].includes(accountType);

      let warningCount = 0;

      const parsed: TrialBalanceRow[] = rows.map((row) => {
        const code = (getMappedValue(row, "account_code", mapping, TRIAL_BALANCE_FIELDS) as string) || "";
        const name = (getMappedValue(row, "account_name", mapping, TRIAL_BALANCE_FIELDS) as string) || "";

        // Pre-import validation
        const errors = validateMappedRow(row, mapping, TRIAL_BALANCE_FIELDS);
        if (errors.length > 0) warningCount++;

        let debit = 0;
        let credit = 0;

        // Use entity matcher
        const matchResult = matcher.match(code, name);
        const match = matchResult?.item;

        const debitVal = getMappedValue(row, "debit", mapping, TRIAL_BALANCE_FIELDS) as number | null;
        const creditVal = getMappedValue(row, "credit", mapping, TRIAL_BALANCE_FIELDS) as number | null;
        const balanceVal = getMappedValue(row, "balance", mapping, TRIAL_BALANCE_FIELDS) as number | null;

        if (debitVal !== null || creditVal !== null) {
          debit = Math.abs(debitVal || 0);
          credit = Math.abs(creditVal || 0);
        } else if (balanceVal !== null) {
          const val = Math.abs(balanceVal);
          if (val === 0) {
            debit = 0;
            credit = 0;
          } else if (match) {
            if (isDebitNormal(match.account_type)) {
              if (balanceVal >= 0) debit = val;
              else credit = val;
            } else {
              if (balanceVal >= 0) credit = val;
              else debit = val;
            }
          } else {
            if (balanceVal >= 0) debit = val;
            else credit = val;
          }
        }

        // Fuzzy match candidates for unmatched rows
        let fuzzyMatchCandidates: TrialBalanceRow["fuzzyMatchCandidates"];
        if (!match && name) {
          const candidates = matcher.findCandidates(name, 3);
          if (candidates.length > 0) {
            fuzzyMatchCandidates = candidates.map((c) => ({
              id: c.item.id,
              code: c.item.code,
              name: c.item.name,
              score: c.score,
            }));
          }
        }

        return {
          accountCode: code,
          accountName: name || match?.name || "",
          debit,
          credit,
          matchedAccountId: match?.id,
          matchedAccountType: match?.account_type,
          status: match ? "matched" as const : (fuzzyMatchCandidates ? "fuzzy_match" as const : "unmatched" as const),
          fuzzyMatchCandidates,
          validationErrors: errors.length > 0 ? errors : undefined,
        };
      });

      setValidationWarnings(warningCount);
      setParsedRows(parsed);
    }, [currentOrg]),
  });

  const matchedRows = parsedRows.filter((r) => r.status === "matched");
  const fuzzyRows = parsedRows.filter((r) => r.status === "fuzzy_match");
  const unmatchedRows = parsedRows.filter((r) => r.status === "unmatched");
  const totalDebits = parsedRows.filter(r => r.status === "matched").reduce((s, r) => s + r.debit, 0);
  const totalCredits = parsedRows.filter(r => r.status === "matched").reduce((s, r) => s + r.credit, 0);
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.01;

  // Accept a fuzzy match suggestion
  const handleAcceptFuzzy = (rowIndex: number, candidate: { id: string; code: string; name: string }) => {
    setParsedRows(prev => prev.map((row, i) => {
      if (i !== rowIndex) return row;
      return {
        ...row,
        matchedAccountId: candidate.id,
        status: "matched" as const,
        fuzzyMatchCandidates: undefined,
      };
    }));
  };

  // Inline account creation for unmatched rows
  const [creatingForRow, setCreatingForRow] = useState<number | null>(null);
  const handleCreateAccountForRow = async (rowIndex: number) => {
    const row = parsedRows[rowIndex];
    if (!currentOrg?.id || !row) return;
    if (!currentBusiness?.id) {
      toast({ title: "Select a company first", description: "Accounts are company-scoped.", variant: "destructive" });
      return;
    }
    setCreatingForRow(rowIndex);
    try {
      const code = row.accountCode || `MIG-${Date.now().toString(36).toUpperCase()}`;
      const { data, error } = await supabase
        .from("accounts")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          code,
          name: row.accountName || `Imported: ${code}`,
          account_type: "expense" as const,
          is_active: true,
        })
        .select("id, account_type")
        .single();

      if (error) throw error;

      setParsedRows(prev => prev.map((r, i) => {
        if (i !== rowIndex) return r;
        return {
          ...r,
          matchedAccountId: data.id,
          matchedAccountType: data.account_type,
          status: "matched" as const,
        };
      }));
      toast({ title: `Account "${row.accountName || code}" created` });
    } catch (err: any) {
      toast({ title: "Failed to create account", description: normalizeError(err).message, variant: "destructive" });
    }
    setCreatingForRow(null);
  };

  // Trial Balance import is unique: GL posting first, then batch account updates.
  const handleImport = async () => {
    if (!currentOrg?.id || !fileUpload.file) return;

    if (!isBalanced) {
      toast({
        title: "Cannot import imbalanced trial balance",
        description: `Total debits (${totalDebits.toLocaleString()}) must equal total credits (${totalCredits.toLocaleString()}). Difference: ${Math.abs(totalDebits - totalCredits).toLocaleString()}. Please correct your file and re-upload.`,
        variant: "destructive",
      });
      return;
    }

    setIsImporting(true);

    try {
      let imported = 0;
      const errors: any[] = [];
      const glEntries: GLEntry[] = [];

      for (const row of matchedRows) {
        if (!row.matchedAccountId) continue;
        if (row.debit > 0) {
          glEntries.push({ account_id: row.matchedAccountId, debit_amount: row.debit, credit_amount: 0, description: `Opening: ${row.accountCode} ${row.accountName}` });
        } else if (row.credit > 0) {
          glEntries.push({ account_id: row.matchedAccountId, debit_amount: 0, credit_amount: row.credit, description: `Opening: ${row.accountCode} ${row.accountName}` });
        }
      }

      // Post the single consolidated Opening Balance Journal Entry FIRST
      const cutoverDate = migration.session?.cutover_date || new Date().toISOString().slice(0, 10);
      if (glEntries.length > 0) {
        // Use the migration session UUID as source_id so re-running with the same session
        // is idempotent at the DB level via the unique index.
        await postToGL({
          source_type: "migration",
          source_id: migration.session?.id || crypto.randomUUID(),
          reference: "MIG-OB-TRIAL-BALANCE",
          memo: "Migration: Consolidated Opening Balance Journal Entry",
          entry_date: cutoverDate,
          entries: glEntries,
        });
        toast({ title: "Opening Balance JE posted", description: `${glEntries.length} lines posted to the General Ledger.` });
      }

      // GL posted successfully — now batch update account opening_balance
      const affectedAccountIds: string[] = [];
      const accountsToUpdate = matchedRows.filter(r => r.matchedAccountId);
      setImportProgress({ current: 0, total: accountsToUpdate.length });

      // Chunk account updates in batches of 50
      const CHUNK_SIZE = 50;
      for (let i = 0; i < accountsToUpdate.length; i += CHUNK_SIZE) {
        const chunk = accountsToUpdate.slice(i, i + CHUNK_SIZE);
        const updatePromises = chunk.map(async (row) => {
          const balance = row.debit > 0 ? row.debit : -row.credit;
          const { error } = await supabase
            .from("accounts")
            .update({ opening_balance: balance })
            .eq("id", row.matchedAccountId!);
          if (error) {
            errors.push({ account: row.accountCode, error: error.message });
          } else {
            imported++;
            affectedAccountIds.push(row.matchedAccountId!);
          }
        });
        await Promise.all(updatePromises);
        setImportProgress({ current: Math.min(i + CHUNK_SIZE, accountsToUpdate.length), total: accountsToUpdate.length });
      }

      const hash = await hashFileContent(fileUpload.file);
      await migration.recordBatch({
        stepKey: "trial_balance",
        batchHash: hash,
        sourceFileName: fileUpload.file.name,
        recordsTotal: parsedRows.length,
        recordsImported: imported,
        recordsFailed: errors.length + unmatchedRows.length,
        errorDetails: [{ affected_account_ids: affectedAccountIds }, ...errors],
      });

      await migration.updateStepStatus("trial_balance", "completed", {
        record_count: imported,
        error_count: errors.length + unmatchedRows.length,
      });

      toast({
        title: "Trial balance imported",
        description: `${imported} account balances updated. ${unmatchedRows.length} unmatched rows skipped.`,
      });

      balanceCheck.refetch();
      onComplete();
    } catch (err: any) {
      toast({ title: "Import failed", description: normalizeError(err).message, variant: "destructive" });
    }
    setIsImporting(false);
    setImportProgress(null);
  };

  const handleReset = () => {
    fileUpload.reset();
    setParsedRows([]);
    setValidationWarnings(0);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Trial Balance Import</CardTitle>
          <Button variant="outline" size="sm" onClick={() => downloadTemplate("trial_balance")}>
            <Download className="mr-2 h-4 w-4" /> Template
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {migration.session?.migration_strategy === "full_transaction" ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Full Transaction Mode:</strong> Your trial balance should <strong>exclude</strong> Accounts Receivable
              and Accounts Payable totals — those will be generated from individual invoices and bills imported in later steps.
              Including them here would cause double-counting.
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            Upload your trial balance as of the cutover date. This posts the <strong>single consolidated Opening Balance journal entry</strong> to the GL.
            AR/AP and Inventory steps will create subledger records only (no duplicate GL posting).
          </p>
        )}

        {parsedRows.length === 0 ? (
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
                  Columns: Account Code, Account Name, Debit, Credit
                </p>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <FileSpreadsheet className="h-4 w-4" />
              <span className="font-medium">{fileUpload.file?.name}</span>
              <Button variant="ghost" size="sm" onClick={handleReset}>
                Change file
              </Button>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold">{parsedRows.length}</div>
                <div className="text-xs text-muted-foreground">Total Rows</div>
              </div>
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold text-success">{matchedRows.length}</div>
                <div className="text-xs text-muted-foreground">Matched</div>
              </div>
              <div className="text-center p-2 rounded-md bg-muted">
                <div className="text-sm font-bold text-warning">{unmatchedRows.length}</div>
                <div className="text-xs text-muted-foreground">Unmatched</div>
              </div>
              <div className="text-center p-2 rounded-md bg-muted">
                <div className={`text-sm font-bold ${isBalanced ? "text-success" : "text-destructive"}`}>
                  {isBalanced ? "Balanced" : "Imbalanced"}
                </div>
                <div className="text-xs text-muted-foreground">
                  D: {totalDebits.toLocaleString()} / C: {totalCredits.toLocaleString()}
                </div>
              </div>
            </div>

            {validationWarnings > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {validationWarnings} row(s) have validation warnings (missing required fields or invalid values).
                </AlertDescription>
              </Alert>
            )}

            {!isBalanced && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Total debits ({totalDebits.toLocaleString()}) do not equal total credits ({totalCredits.toLocaleString()}).
                  Difference: {Math.abs(totalDebits - totalCredits).toLocaleString()}. <strong>Import is blocked until the trial balance is balanced.</strong> Please correct your file and re-upload.
                </AlertDescription>
              </Alert>
            )}

            {/* Fuzzy match suggestions */}
            {fuzzyRows.length > 0 && (
              <Alert className="border-warning/30 bg-warning/5">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <AlertDescription>
                  <strong>{fuzzyRows.length} row(s)</strong> have possible matches by name. Review and accept or skip:
                </AlertDescription>
              </Alert>
            )}

            {fuzzyRows.length > 0 && (
              <div className="space-y-2 max-h-48 overflow-auto">
                {fuzzyRows.map((row) => {
                  const rowIndex = parsedRows.indexOf(row);
                  return (
                    <div key={rowIndex} className="p-2 rounded border bg-warning/5 space-y-1">
                      <div className="text-sm font-medium">
                        <span className="font-mono text-xs">{row.accountCode}</span> — {row.accountName}
                        <span className="text-muted-foreground ml-2">
                          (D: {row.debit.toLocaleString()} / C: {row.credit.toLocaleString()})
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {row.fuzzyMatchCandidates?.map((c) => (
                          <Button
                            key={c.id}
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={() => handleAcceptFuzzy(rowIndex, c)}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            {c.code} — {c.name} ({Math.round(c.score * 100)}%)
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {unmatchedRows.length > 0 && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  <strong>{unmatchedRows.length} row(s)</strong> could not be matched. You can create accounts inline or skip them.
                </AlertDescription>
              </Alert>
            )}

            {unmatchedRows.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-auto">
                {unmatchedRows.slice(0, 20).map((row) => {
                  const rowIndex = parsedRows.indexOf(row);
                  return (
                    <div key={rowIndex} className="flex items-center gap-2 p-1.5 rounded border text-sm">
                      <span className="font-mono text-xs">{row.accountCode}</span>
                      <span className="truncate flex-1">{row.accountName}</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-6 text-xs gap-1 shrink-0"
                        disabled={creatingForRow === rowIndex}
                        onClick={() => handleCreateAccountForRow(rowIndex)}
                      >
                        {creatingForRow === rowIndex ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <PlusCircle className="h-3 w-3" />
                        )}
                        Create
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {importProgress && (
              <div className="text-sm text-muted-foreground text-center">
                Updating accounts... {importProgress.current} / {importProgress.total}
              </div>
            )}

            {/* Preview table */}
            <div className="max-h-64 overflow-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.slice(0, 50).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{row.accountCode}</TableCell>
                      <TableCell className="text-sm">{row.accountName}</TableCell>
                      <TableCell className="text-right text-sm">{row.debit > 0 ? row.debit.toLocaleString() : "-"}</TableCell>
                      <TableCell className="text-right text-sm">{row.credit > 0 ? row.credit.toLocaleString() : "-"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={row.status === "matched" ? "default" : row.status === "fuzzy_match" ? "secondary" : "destructive"}
                          className="text-xs"
                        >
                          {row.status === "fuzzy_match" ? "review" : row.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <Button
              onClick={handleImport}
              disabled={matchedRows.length === 0 || isImporting || !isBalanced}
              className="w-full"
            >
              {isImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {!isBalanced ? "Fix Imbalance to Import" : `Import ${matchedRows.length} Opening Balances`}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

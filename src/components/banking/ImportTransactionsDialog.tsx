// @ts-nocheck - Tables not in auto-generated types
import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { BankAccount } from "@/hooks/useBankAccounts";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useTransactionRules } from "@/hooks/useTransactionRules";
import { toast } from "sonner";
import {
  Upload,
  FileSpreadsheet,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
} from "lucide-react";
import {
  parseStatementFile,
  applyColumnMapping,
  computeFileHash,
  generateTransactionHash,
  type ParsedBankTransaction,
  type ParsedStatement,
  type ColumnMapping,
} from "@/lib/bankStatementParsers";
import { normalizeError } from "@/services/resilience";

interface ImportTransactionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: BankAccount[];
  onSuccess: () => void;
}

export function ImportTransactionsDialog({
  open,
  onOpenChange,
  accounts,
  onSuccess,
}: ImportTransactionsDialogProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { applyRulesToTransaction } = useTransactionRules();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [step, setStep] = useState(1);
  const [selectedAccountId, setSelectedAccountId] = useState("");
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
  const [importResult, setImportResult] = useState<{ success: number; failed: number; duplicates: number } | null>(null);
  const [duplicateCount, setDuplicateCount] = useState(0);

  const resetState = () => {
    setStep(1);
    setSelectedAccountId("");
    setFile(null);
    setFileHash("");
    setParsedStatement(null);
    setColumnMapping({ date: "", description: "", amount: "", reference: "" });
    setFinalTransactions([]);
    setImportResult(null);
    setDuplicateCount(0);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    setFile(selectedFile);

    try {
      // Compute real content hash for deduplication
      const hash = await computeFileHash(selectedFile);
      setFileHash(hash);

      // Check for duplicate file import
      const { data: existingStatement } = await supabase
        .from("bank_statements")
        .select("id, file_name, created_at")
        .eq("bank_account_id", selectedAccountId)
        .eq("file_hash", hash)
        .maybeSingle();

      if (existingStatement) {
        toast.warning(`This file was already imported as "${existingStatement.file_name}". Duplicate rows will be skipped.`);
      }

      // Parse the file
      const statement = await parseStatementFile(selectedFile);
      setParsedStatement(statement);

      if (statement.needsColumnMapping) {
        // CSV/Excel — go to column mapping step
        setStep(2);
      } else {
        // OFX/QIF — transactions are already parsed, skip to preview
        await preparePreview(statement.transactions);
      }
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to parse file");
    }
  };

  const handleMappingComplete = async () => {
    if (!columnMapping.date || !columnMapping.description || (!columnMapping.amount && !columnMapping.credit)) {
      toast.error("Please map at least Date, Description, and Amount columns");
      return;
    }

    if (!parsedStatement?.headers || !parsedStatement?.rawRows) return;

    const mapped = applyColumnMapping(
      parsedStatement.headers,
      parsedStatement.rawRows,
      columnMapping,
      selectedAccountId
    );

    await preparePreview(mapped);
  };

  const preparePreview = async (transactions: ParsedBankTransaction[]) => {
    // Check for row-level duplicates against existing transactions
    if (selectedAccountId && transactions.length > 0) {
      const hashes = transactions.map(t =>
        generateTransactionHash(
          t.date,
          t.description,
          t.type === "credit" ? t.amount : -t.amount,
          t.reference,
          selectedAccountId
        )
      );

      const { data: existing } = await supabase
        .from("bank_transactions")
        .select("external_transaction_id")
        .eq("bank_account_id", selectedAccountId)
        .in("external_transaction_id", hashes);

      const existingSet = new Set((existing || []).map(e => e.external_transaction_id));
      const dupes = hashes.filter(h => existingSet.has(h)).length;
      setDuplicateCount(dupes);
    }

    setFinalTransactions(transactions);
    setStep(3);
  };

  const handleImport = async () => {
    if (!currentOrg?.id || !currentBusiness?.id || !selectedAccountId || finalTransactions.length === 0) return;

    setIsImporting(true);
    let success = 0;
    let failed = 0;
    let duplicates = 0;

    try {
      const { data: userData } = await supabase.auth.getUser();
      
      // Find date range
      const dates = finalTransactions.map(r => r.date).filter(Boolean).sort();

      // Create statement batch record with real file hash
      const { data: stmtData } = await supabase
        .from("bank_statements")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          bank_account_id: selectedAccountId,
          file_name: file?.name || "manual_import",
          file_hash: fileHash || `batch_${Date.now()}`,
          imported_by: userData.user?.id || null,
          status: "processing",
          period_start: dates[0] || null,
          period_end: dates[dates.length - 1] || null,
          transaction_count: finalTransactions.length,
          ...(parsedStatement?.metadata?.openingBalance !== undefined
            ? { opening_balance: parsedStatement.metadata.openingBalance }
            : {}),
          ...(parsedStatement?.metadata?.closingBalance !== undefined
            ? { closing_balance: parsedStatement.metadata.closingBalance }
            : {}),
        })
        .select("id")
        .single();

      const statementId = stmtData?.id || null;

      // Import transactions in batches of 50 for performance
      const BATCH_SIZE = 50;
      for (let batchStart = 0; batchStart < finalTransactions.length; batchStart += BATCH_SIZE) {
        const batch = finalTransactions.slice(batchStart, batchStart + BATCH_SIZE);
        const validRows: any[] = [];

        for (let i = 0; i < batch.length; i++) {
          const row = batch[i];
          if (!row.date) { failed++; continue; }

          const signedAmount = row.type === "credit" ? row.amount : -row.amount;
          const txHash = generateTransactionHash(
            row.date,
            row.description,
            signedAmount,
            row.reference,
            selectedAccountId
          );

          validRows.push({
            organization_id: currentOrg.id,
            business_id: currentBusiness.id,
            bank_account_id: selectedAccountId,
            external_transaction_id: txHash,
            transaction_date: row.date,
            description: row.description,
            amount: signedAmount,
            reference: row.reference || null,
            transaction_type: row.type,
            is_reconciled: false,
            statement_id: statementId,
            import_row_number: batchStart + i + 1,
            balance_after: row.balance ?? null,
            raw_data: row.rawData || null,
          });
        }

        if (validRows.length > 0) {
          const { data: insertedData, error: batchError } = await supabase
            .from("bank_transactions")
            .upsert(validRows, { 
              onConflict: "bank_account_id,external_transaction_id",
              ignoreDuplicates: true 
            })
            .select("id");

          if (batchError) {
            console.error("Batch import error:", batchError);
            failed += validRows.length;
          } else {
            const insertedCount = insertedData?.length || 0;
            success += insertedCount;
            duplicates += validRows.length - insertedCount;
          }
        }
      }

      // Apply transaction rules to newly imported transactions
      if (success > 0) {
        try {
          const { data: newTxns } = await supabase
            .from("bank_transactions")
            .select("id, description, reference, amount, transaction_type")
            .eq("bank_account_id", selectedAccountId)
            .eq("statement_id", statementId)
            .is("category", null);

          let categorized = 0;
          for (const tx of (newTxns || [])) {
            const match = applyRulesToTransaction(
              tx.description,
              tx.reference,
              Math.abs(tx.amount),
              tx.transaction_type as "credit" | "debit"
            );
            if (match) {
              await supabase
                .from("bank_transactions")
                .update({ 
                  category: match.category, 
                  category_confidence: match.confidence,
                  lifecycle_status: "for_review",
                } as any)
                .eq("id", tx.id);
              categorized++;
            }
          }
          if (categorized > 0) {
            toast.success(`${categorized} transaction(s) auto-categorized by rules`);
          }
        } catch (ruleError) {
          console.error("Rule application error (non-fatal):", ruleError);
        }
      }

      // Update statement with final counts
      if (statementId) {
        await supabase
          .from("bank_statements")
          .update({
            status: "completed",
            transaction_count: success,
            failed_count: failed,
            duplicate_count: duplicates,
            file_format: parsedStatement?.format || null,
          })
          .eq("id", statementId);
      }

      setImportResult({ success, failed, duplicates });
      setStep(4);

      if (success > 0) {
        onSuccess();
      }
    } catch (error) {
      console.error("Import error:", error);
      toast.error("Failed to import transactions");
    } finally {
      setIsImporting(false);
    }
  };

  const handleClose = () => {
    resetState();
    onOpenChange(false);
  };

  const headers = parsedStatement?.headers || [];
  const rawRows = parsedStatement?.rawRows || [];

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 1 && "Import Bank Statement"}
            {step === 2 && "Map Columns"}
            {step === 3 && "Preview & Import"}
            {step === 4 && "Import Complete"}
          </DialogTitle>
          <DialogDescription>
            {step === 1 && "Upload a bank statement file (CSV, Excel, OFX, QBO, or QIF)"}
            {step === 2 && "Match the columns in your file to transaction fields"}
            {step === 3 && `Review ${finalTransactions.length} transactions before importing${duplicateCount > 0 ? ` (${duplicateCount} duplicates will be skipped)` : ""}`}
            {step === 4 && "Your transactions have been imported"}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Select Account & Upload File */}
        {step === 1 && (
          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label>Select Bank Account</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name} - {acc.bank_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Upload Statement File</Label>
              <div
                className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                  selectedAccountId ? "hover:border-primary hover:bg-muted/50" : "opacity-50 cursor-not-allowed"
                }`}
                onClick={() => selectedAccountId && fileInputRef.current?.click()}
                onDragOver={(e) => { if (selectedAccountId) { e.preventDefault(); e.stopPropagation(); } }}
                onDragEnter={(e) => { if (selectedAccountId) { e.preventDefault(); e.stopPropagation(); } }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!selectedAccountId) return;
                  const droppedFile = e.dataTransfer.files?.[0];
                  if (droppedFile) {
                    // Trigger the same handler by creating a synthetic event
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(droppedFile);
                    if (fileInputRef.current) {
                      fileInputRef.current.files = dataTransfer.files;
                      fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
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
                <FileSpreadsheet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="font-medium">Click to upload or drag and drop</p>
                <p className="text-sm text-muted-foreground mt-1">
                  CSV, Excel (.xlsx), OFX, QBO, QIF
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Column Mapping (CSV/Excel only) */}
        {step === 2 && (
          <div className="space-y-6 py-4">
            <Card>
              <CardContent className="pt-4">
                <p className="text-sm text-muted-foreground mb-4">
                  Found {headers.length} columns and {rawRows.length} rows. Map your columns below:
                </p>
                
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Date Column *</Label>
                    <Select value={columnMapping.date} onValueChange={(v) => setColumnMapping({ ...columnMapping, date: v })}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        {headers.map((h, i) => (<SelectItem key={i} value={h}>{h}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Description Column *</Label>
                    <Select value={columnMapping.description} onValueChange={(v) => setColumnMapping({ ...columnMapping, description: v })}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        {headers.map((h, i) => (<SelectItem key={i} value={h}>{h}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Amount Column (if single column)</Label>
                    <Select value={columnMapping.amount || "__none__"} onValueChange={(v) => setColumnMapping({ ...columnMapping, amount: v === "__none__" ? "" : v })}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {headers.map((h, i) => (<SelectItem key={i} value={h}>{h}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Reference Column (optional)</Label>
                    <Select value={columnMapping.reference || "__none__"} onValueChange={(v) => setColumnMapping({ ...columnMapping, reference: v === "__none__" ? "" : v })}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {headers.map((h, i) => (<SelectItem key={i} value={h}>{h}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Credit Column (if separate)</Label>
                    <Select value={columnMapping.credit || "__none__"} onValueChange={(v) => setColumnMapping({ ...columnMapping, credit: v === "__none__" ? "" : v })}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {headers.map((h, i) => (<SelectItem key={i} value={h}>{h}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Debit Column (if separate)</Label>
                    <Select value={columnMapping.debit || "__none__"} onValueChange={(v) => setColumnMapping({ ...columnMapping, debit: v === "__none__" ? "" : v })}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {headers.map((h, i) => (<SelectItem key={i} value={h}>{h}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Balance Column (optional)</Label>
                    <Select value={columnMapping.balance || "__none__"} onValueChange={(v) => setColumnMapping({ ...columnMapping, balance: v === "__none__" ? "" : v })}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {headers.map((h, i) => (<SelectItem key={i} value={h}>{h}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Preview first few rows */}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {headers.map((h, i) => (
                      <TableHead key={i} className="whitespace-nowrap">{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rawRows.slice(0, 3).map((row, i) => (
                    <TableRow key={i}>
                      {row.map((cell, j) => (
                        <TableCell key={j} className="whitespace-nowrap">{cell}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === 3 && (
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline">{finalTransactions.length} transactions ready</Badge>
              {duplicateCount > 0 && (
                <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
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

            <div className="max-h-[300px] overflow-y-auto border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    {finalTransactions.some(t => t.balance !== undefined) && (
                      <TableHead className="text-right">Balance</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {finalTransactions.slice(0, 50).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell>{row.date}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{row.description}</TableCell>
                      <TableCell>
                        <Badge variant={row.type === "credit" ? "default" : "secondary"}>
                          {row.type}
                        </Badge>
                      </TableCell>
                      <TableCell className={`text-right font-medium ${row.type === "credit" ? "text-green-600" : "text-red-600"}`}>
                        {row.type === "credit" ? "+" : "-"}{row.amount.toLocaleString()}
                      </TableCell>
                      {finalTransactions.some(t => t.balance !== undefined) && (
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
              <p className="text-sm text-muted-foreground text-center">
                Showing first 50 of {finalTransactions.length} transactions
              </p>
            )}
          </div>
        )}

        {/* Step 4: Complete */}
        {step === 4 && importResult && (
          <div className="py-8 text-center">
            {importResult.success > 0 ? (
              <CheckCircle2 className="h-16 w-16 mx-auto text-green-500 mb-4" />
            ) : (
              <AlertCircle className="h-16 w-16 mx-auto text-amber-500 mb-4" />
            )}
            
            <h3 className="text-xl font-semibold mb-2">
              {importResult.success > 0 ? "Import Successful!" : "Import Failed"}
            </h3>
            
            <div className="flex items-center justify-center gap-4 text-sm">
              <span className="text-green-600">
                <CheckCircle2 className="h-4 w-4 inline mr-1" />
                {importResult.success} imported
              </span>
              {importResult.duplicates > 0 && (
                <span className="text-amber-600">
                  <AlertCircle className="h-4 w-4 inline mr-1" />
                  {importResult.duplicates} duplicates skipped
                </span>
              )}
              {importResult.failed > 0 && (
                <span className="text-red-600">
                  <X className="h-4 w-4 inline mr-1" />
                  {importResult.failed} failed
                </span>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 1 && (
            <Button variant="outline" onClick={handleClose}>Cancel</Button>
          )}
          {step === 2 && (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={handleMappingComplete}>Continue to Preview</Button>
            </>
          )}
          {step === 3 && (
            <>
              <Button variant="outline" onClick={() => parsedStatement?.needsColumnMapping ? setStep(2) : setStep(1)}>Back</Button>
              <Button onClick={handleImport} disabled={isImporting}>
                {isImporting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Import {finalTransactions.length - duplicateCount} Transactions
              </Button>
            </>
          )}
          {step === 4 && (
            <Button onClick={handleClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

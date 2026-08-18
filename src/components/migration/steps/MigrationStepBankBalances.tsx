import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useMigrationSession } from "@/hooks/useMigrationSession";
import { useMigrationFileUpload } from "@/hooks/useMigrationFileUpload";
import { useMigrationImportLoop } from "@/hooks/useMigrationImportLoop";
import { downloadTemplate } from "@/lib/migration/csvTemplates";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Upload, Loader2, Download, Info, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { normalizeError } from "@/services/resilience";

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

interface BankRow {
  accountName: string;
  accountNumber: string;
  openingBalance: number;
  matchedBankAccountId?: string;
  status: "matched" | "unmatched";
}

export function MigrationStepBankBalances({ onComplete, onSkip }: Props) {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { toast } = useToast();
  const migration = useMigrationSession();
  const [parsedRows, setParsedRows] = useState<BankRow[]>([]);
  const [manualEdits, setManualEdits] = useState<Record<string, number>>({});
  const [isManualSaving, setIsManualSaving] = useState(false);

  const { data: bankAccounts = [], refetch } = useQuery({
    queryKey: ["bank-accounts-migration", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data } = await supabase
        // SCOPE-EXEMPT: migration tool lists all bank accounts in workspace for matching
        .from("bank_accounts")
        .select("id, name, account_number, opening_balance, current_balance")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);
      return data || [];
    },
    enabled: !!currentOrg?.id,
  });

  const fileUpload = useMigrationFileUpload({
    isBatchDuplicate: migration.isBatchDuplicate,
    onParsed: useCallback(async ({ headers, rows }) => {
      const nameCol = headers.find(h => /account.?name|bank.?name|name/i.test(h)) || headers[0];
      const numCol = headers.find(h => /account.?num|number/i.test(h)) || headers[1];
      const balCol = headers.find(h => /opening.?balance|balance|amount/i.test(h)) || headers[2];

      const nameMap = new Map(bankAccounts.map(b => [b.name.toLowerCase().trim(), b.id]));
      const numMap = new Map(bankAccounts.filter(b => b.account_number).map(b => [b.account_number!.trim(), b.id]));

      const parsed: BankRow[] = rows
        .filter(row => row[nameCol]?.trim())
        .map(row => {
          const name = (row[nameCol] || "").trim();
          const num = (row[numCol] || "").trim();
          const bal = parseFloat(row[balCol]) || 0;
          const matchedBankAccountId = (numMap.get(num) || nameMap.get(name.toLowerCase())) as string | undefined;
          return {
            accountName: name,
            accountNumber: num,
            openingBalance: bal,
            matchedBankAccountId,
            status: matchedBankAccountId ? "matched" as const : "unmatched" as const,
          };
        });

      setParsedRows(parsed);
    }, [bankAccounts]),
  });

  const importLoop = useMigrationImportLoop({
    recordBatch: migration.recordBatch,
    updateStepStatus: migration.updateStepStatus,
  });

  const handleImport = async () => {
    if (!currentOrg?.id || !fileUpload.file) return;
    const matched = parsedRows.filter(r => r.status === "matched" && r.matchedBankAccountId);

    await importLoop.executeLoop({
      stepKey: "bank_balances",
      fileHash: fileUpload.fileHash,
      fileName: fileUpload.file.name,
      totalRows: parsedRows.length,
      matchedRows: matched,
      unmatchedCount: parsedRows.filter(r => r.status === "unmatched").length,
      importRow: async (row) => {
        // C-8: stop writing accounts.current_balance directly.
        // Wave 1: opening_balance is set through the bank-account write seam,
        // which posts the opening-balance journal entry itself when the
        // account carries a Chart-of-Accounts link.
        const { error } = await supabase.rpc("bank_account_update", {
          _id: row.matchedBankAccountId!,
          _row_version: null,
          _payload: { opening_balance: row.openingBalance } as never,
        });
        if (error) throw error;

      },
      getRowLabel: (row) => row.accountName,
      onSuccess: () => {
        refetch();
        onComplete();
      },
      successMessage: "Bank balances updated (post via Trial Balance to record GL entries)",
    });
  };

  // Save manual edits (non-CSV path)
  const handleSaveManual = async () => {
    setIsManualSaving(true);
    try {
      let updated = 0;
      for (const [accountId, balance] of Object.entries(manualEdits)) {
        // C-8: opening_balance only — never directly mutate current_balance.
        const { error } = await supabase.rpc("bank_account_update", {
          _id: accountId,
          _row_version: null,
          _payload: { opening_balance: balance } as never,
        });
        if (error) throw error;

        updated++;
      }

      await migration.updateStepStatus("bank_balances", "completed", { record_count: updated });
      toast({ title: "Bank balances saved", description: `${updated} balance(s) updated. Post the GL entries via Trial Balance.` });
      refetch();
      setManualEdits({});
      onComplete();
    } catch (err: any) {
      toast({ title: "Save failed", description: normalizeError(err).message, variant: "destructive" });
    }
    setIsManualSaving(false);
  };

  const handleReset = () => {
    fileUpload.reset();
    setParsedRows([]);
  };

  const hasManualEdits = Object.keys(manualEdits).length > 0;
  const withBalance = bankAccounts.filter((b) => (b.opening_balance || 0) !== 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Bank Balances</CardTitle>
          <Button variant="outline" size="sm" onClick={() => downloadTemplate("bank_balances")}>
            <Download className="mr-2 h-4 w-4" /> Template
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Set opening balances for your bank accounts. You can import via CSV or edit directly below.
          Bank balances should match what's in your Trial Balance.
        </p>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            Bank account GL balances are posted via the Trial Balance step. This step sets the
            opening balance on the bank account records for reconciliation purposes.
          </AlertDescription>
        </Alert>

        {/* CSV Import Section */}
        {parsedRows.length === 0 ? (
          <div
            {...fileUpload.dropzone.getRootProps()}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${fileUpload.dropzone.isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
          >
            <input {...fileUpload.dropzone.getInputProps()} />
            {fileUpload.isProcessing ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-sm">Processing...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">Import bank balances from CSV</p>
                <p className="text-xs text-muted-foreground">Columns: Account Name, Account Number, Opening Balance</p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{fileUpload.file?.name}</span>
              <Button variant="ghost" size="sm" onClick={handleReset}>Change</Button>
            </div>

            {importLoop.progress && (
              <div className="text-sm text-muted-foreground text-center">
                Importing... {importLoop.progress.current} / {importLoop.progress.total}
              </div>
            )}

            <div className="max-h-48 overflow-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{row.accountName}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{row.openingBalance.toLocaleString()}</TableCell>
                      <TableCell>
                        <span className={`text-xs font-medium ${row.status === "matched" ? "text-success" : "text-destructive"}`}>
                          {row.status}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Button onClick={handleImport} disabled={importLoop.isImporting || parsedRows.filter(r => r.status === "matched").length === 0} className="w-full">
              {importLoop.isImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Import {parsedRows.filter(r => r.status === "matched").length} Bank Balances
            </Button>
          </div>
        )}

        {/* Manual Edit Section */}
        {parsedRows.length === 0 && bankAccounts.length > 0 && (
          <>
            <div className="border-t pt-4">
              <h4 className="text-sm font-medium mb-3">Or edit balances directly:</h4>
              <div className="space-y-2">
                {bankAccounts.map((ba) => (
                  <div key={ba.id} className="flex items-center justify-between gap-3 p-2 rounded bg-muted">
                    <span className="text-sm flex-1">{ba.name}</span>
                    <Input
                      type="number"
                      step="0.01"
                      className="w-40 text-right"
                      defaultValue={ba.opening_balance || 0}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value) || 0;
                        setManualEdits((prev) => ({ ...prev, [ba.id]: val }));
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {withBalance.length > 0 && !hasManualEdits && (
              <div className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" />
                {withBalance.length} bank account(s) already have opening balances
              </div>
            )}
          </>
        )}

        {bankAccounts.length === 0 && parsedRows.length === 0 && (
          <Alert className="border-warning/30 bg-warning/5">
            <Info className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm">No bank accounts found. Add them in Banking first.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/finance/banking?returnTo=/settings/migration")}
                className="shrink-0"
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1" />
                Go to Banking
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex gap-2">
          {hasManualEdits && (
            <Button onClick={handleSaveManual} disabled={isManualSaving} className="flex-1">
              {isManualSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Balances
            </Button>
          )}
          {!hasManualEdits && parsedRows.length === 0 && (
            <Button onClick={onComplete} className="flex-1">
              Confirm Bank Balances
            </Button>
          )}
          <Button variant="ghost" onClick={onSkip} className="flex-1">
            Skip
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

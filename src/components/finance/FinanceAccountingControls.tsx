import { useMemo, useState } from "react";
import { BookOpen, Landmark, Loader2, Plus, RefreshCw, Save, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { supabase } from "@/integrations/supabase/client";
import { useJournalBooks, type JournalType } from "@/hooks/finance/useJournalBooks";
import {
  describeRuleSkip,
  useReconciliationRules,
  type ApplyRulesResult,
} from "@/hooks/finance/useReconciliationRules";
import { useFxRevaluation, useFxRevaluationReadiness } from "@/hooks/finance/useFxRevaluation";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ShieldAlert } from "lucide-react";
import { useFinancePermissions } from "@/hooks/finance/useFinancePermission";
import { FinanceReadOnlyNotice } from "@/components/finance/FinanceReadOnlyNotice";
import { normalizeError } from "@/services/resilience";

interface AccountOption {
  id: string;
  code: string;
  name: string;
  account_type: string;
}

interface BankAccountOption {
  id: string;
  name: string;
  bank_name: string | null;
}

interface FinanceAccountingControlsProps {
  accounts: AccountOption[];
}

const JOURNAL_TYPES: JournalType[] = ["sale", "purchase", "bank", "cash", "general", "situation"];

export function FinanceAccountingControls({ accounts }: FinanceAccountingControlsProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const journalBooks = useJournalBooks();
  const reconRules = useReconciliationRules();
  const fx = useFxRevaluation();
  const [lastRuleRun, setLastRuleRun] = useState<ApplyRulesResult | null>(null);
  // One batched, cached round-trip for all three gates. While unresolved we
  // disable inputs but never render a denial banner (tri-state contract).
  const { permissions, isLoading: permLoading } = useFinancePermissions([
    "finance.manage_settings",
    "finance.manage_je",
    "finance.reconcile_bank",
  ]);
  const canManageSettings = permissions["finance.manage_settings"];
  const canManageJe = permissions["finance.manage_je"];
  const canReconcile = permissions["finance.reconcile_bank"];
  const journalsReadOnly = !canManageSettings;
  const rulesReadOnly = !(canManageSettings || canReconcile);
  const fxReadOnly = !canManageJe;
  const [bankAccounts, setBankAccounts] = useState<BankAccountOption[]>([]);
  const [isLoadingBanks, setIsLoadingBanks] = useState(false);
  const [journalDraft, setJournalDraft] = useState({ code: "", name: "", journal_type: "general" as JournalType, default_account_id: "", description: "" });
  const [ruleDraft, setRuleDraft] = useState({ name: "", bank_account_id: "", description_pattern: "", amount_sign: "any", counterpart_account_id: "", auto_post: false, description_template: "" });
  const [applyBankAccountId, setApplyBankAccountId] = useState("");
  const [fxDraft, setFxDraft] = useState({ run_date: new Date().toISOString().slice(0, 10), base_currency: currentBusiness?.base_currency ?? "", unrealized_gain_account_id: "", unrealized_loss_account_id: "" });

  const { data: readiness } = useFxRevaluationReadiness(fxDraft.run_date);
  const periodBlocked = !!readiness?.fiscal_period_id && readiness.fiscal_period_status !== "open";

  const incomeAccounts = useMemo(() => accounts.filter((account) => account.account_type === "income"), [accounts]);
  const expenseAccounts = useMemo(() => accounts.filter((account) => account.account_type === "expense"), [accounts]);

  const refreshBanks = async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    setIsLoadingBanks(true);
    const { data, error } = await (supabase as any)
      .from("bank_accounts")
      .select("id, name, bank_name")
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("name");
    setIsLoadingBanks(false);
    if (error) {
      toast({ title: "Could not load bank accounts", description: normalizeError(error).message, variant: "destructive" });
      return;
    }
    setBankAccounts((data ?? []) as BankAccountOption[]);
  };

  const createJournalBook = async () => {
    if (!journalDraft.code.trim() || !journalDraft.name.trim()) return;
    await journalBooks.createBook({
      code: journalDraft.code.trim().toUpperCase(),
      name: journalDraft.name.trim(),
      journal_type: journalDraft.journal_type,
      default_account_id: journalDraft.default_account_id || null,
      description: journalDraft.description || null,
    });
    setJournalDraft({ code: "", name: "", journal_type: "general", default_account_id: "", description: "" });
    toast({ title: "Journal book created" });
  };

  const createRule = async () => {
    if (!ruleDraft.name.trim() || !ruleDraft.counterpart_account_id) return;
    await reconRules.createRule({
      bank_account_id: ruleDraft.bank_account_id || null,
      // This inline authoring surface is company-wide; per-branch scoping is
      // set on the full rule form.
      branch_id: null,
      name: ruleDraft.name.trim(),
      priority: 100,
      is_active: true,
      description_pattern: ruleDraft.description_pattern || null,
      description_regex: null,
      reference_pattern: null,
      amount_min: null,
      amount_max: null,
      amount_sign: ruleDraft.amount_sign as "debit" | "credit" | "any",
      counterpart_contact_id: null,
      counterpart_account_id: ruleDraft.counterpart_account_id,
      journal_book_id: journalBooks.books.find((book) => book.journal_type === "bank")?.id ?? null,
      auto_post: ruleDraft.auto_post,
      description_template: ruleDraft.description_template || null,
    });
    setRuleDraft({ name: "", bank_account_id: "", description_pattern: "", amount_sign: "any", counterpart_account_id: "", auto_post: false, description_template: "" });
    toast({ title: "Reconciliation rule saved" });
  };

  const runFx = async () => {
    if (!fxDraft.unrealized_gain_account_id || !fxDraft.unrealized_loss_account_id) return;
    await fx.runRevaluation(fxDraft);
  };

  const applyRules = async () => {
    if (!applyBankAccountId) return;
    // A refusal is evidence, not an error: show the accountant which lines the
    // rules deliberately left alone and why.
    const result = await reconRules.applyRules(applyBankAccountId);
    setLastRuleRun(result);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4" />
          Accounting Controls
        </CardTitle>
        <CardDescription className="text-xs">
          Manage journal books, reconciliation rule suggestions, and FX revaluation runs from one accountant workspace.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="journals" className="space-y-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="journals">Journals</TabsTrigger>
            <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
            <TabsTrigger value="fx">FX</TabsTrigger>
          </TabsList>

          <TabsContent value="journals" className="space-y-4">
            <FinanceReadOnlyNotice
              what="review the journal books"
              permission="finance.manage_settings"
              isLoading={permLoading}
              readOnly={journalsReadOnly}
            />
            <div className="grid gap-3 md:grid-cols-5">
              <Input placeholder="Code" disabled={journalsReadOnly} value={journalDraft.code} onChange={(event) => setJournalDraft((draft) => ({ ...draft, code: event.target.value }))} />
              <Input placeholder="Name" className="md:col-span-2" disabled={journalsReadOnly} value={journalDraft.name} onChange={(event) => setJournalDraft((draft) => ({ ...draft, name: event.target.value }))} />
              <Select value={journalDraft.journal_type} disabled={journalsReadOnly} onValueChange={(value) => setJournalDraft((draft) => ({ ...draft, journal_type: value as JournalType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{JOURNAL_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
              </Select>
              <Button onClick={createJournalBook} disabled={!journalDraft.code || !journalDraft.name || journalsReadOnly}>
                <Plus className="h-4 w-4" /> Create
              </Button>
            </div>
            <div className="flex justify-between gap-3">
              <Button variant="outline" onClick={journalBooks.seedDefaults} disabled={journalBooks.isLoading || journalsReadOnly}>
                {journalBooks.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Seed Defaults
              </Button>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {journalBooks.books.map((book) => (
                <div key={book.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{book.code} — {book.name}</p>
                      <p className="text-xs text-muted-foreground">{book.journal_type}</p>
                    </div>
                    <Badge variant={book.is_active ? "outline" : "secondary"}>{book.is_active ? "Active" : "Inactive"}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="reconciliation" className="space-y-4">
            <FinanceReadOnlyNotice
              what="review the reconciliation rules"
              permission="finance.manage_settings / finance.reconcile_bank"
              isLoading={permLoading}
              readOnly={rulesReadOnly}
            />
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={refreshBanks} disabled={isLoadingBanks}>
                {isLoadingBanks ? <Loader2 className="h-4 w-4 animate-spin" /> : <Landmark className="h-4 w-4" />}
                Load Bank Accounts
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Input placeholder="Rule name" value={ruleDraft.name} onChange={(event) => setRuleDraft((draft) => ({ ...draft, name: event.target.value }))} />
              <Input placeholder="Description pattern, e.g. %Stripe%" value={ruleDraft.description_pattern} onChange={(event) => setRuleDraft((draft) => ({ ...draft, description_pattern: event.target.value }))} />
              <Select value={ruleDraft.bank_account_id || "all"} onValueChange={(value) => setRuleDraft((draft) => ({ ...draft, bank_account_id: value === "all" ? "" : value }))}>
                <SelectTrigger><SelectValue placeholder="Bank account" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All bank accounts</SelectItem>
                  {bankAccounts.map((bank) => <SelectItem key={bank.id} value={bank.id}>{bank.name}{bank.bank_name ? ` — ${bank.bank_name}` : ""}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={ruleDraft.amount_sign} onValueChange={(value) => setRuleDraft((draft) => ({ ...draft, amount_sign: value }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any amount</SelectItem>
                  <SelectItem value="debit">Money in</SelectItem>
                  <SelectItem value="credit">Money out</SelectItem>
                </SelectContent>
              </Select>
              <Select value={ruleDraft.counterpart_account_id} onValueChange={(value) => setRuleDraft((draft) => ({ ...draft, counterpart_account_id: value }))}>
                <SelectTrigger><SelectValue placeholder="Counterpart account" /></SelectTrigger>
                <SelectContent>{accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.code} — {account.name}</SelectItem>)}</SelectContent>
              </Select>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <Label className="text-sm">Mark auto matches as to-check</Label>
                <Switch checked={ruleDraft.auto_post} onCheckedChange={(checked) => setRuleDraft((draft) => ({ ...draft, auto_post: checked }))} />
              </div>
            </div>
            <Textarea placeholder="Suggestion note" value={ruleDraft.description_template} onChange={(event) => setRuleDraft((draft) => ({ ...draft, description_template: event.target.value }))} />
            <Button onClick={createRule} disabled={!ruleDraft.name || !ruleDraft.counterpart_account_id || reconRules.isLoading || rulesReadOnly}>
              <Save className="h-4 w-4" /> Save Rule
            </Button>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Select value={applyBankAccountId} onValueChange={setApplyBankAccountId}>
                <SelectTrigger><SelectValue placeholder="Bank account to test/apply rules" /></SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((bank) => <SelectItem key={bank.id} value={bank.id}>{bank.name}{bank.bank_name ? ` — ${bank.bank_name}` : ""}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={applyRules} disabled={!applyBankAccountId || reconRules.isApplying || rulesReadOnly}>
                {reconRules.isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Apply Rules
              </Button>
            </div>
            {lastRuleRun && lastRuleRun.skipped.length > 0 && (
              <div className="rounded-md border border-dashed p-3 space-y-1">
                <p className="text-xs font-medium">
                  {lastRuleRun.skipped.length} line
                  {lastRuleRun.skipped.length === 1 ? "" : "s"} left for review
                </p>
                {Object.entries(
                  lastRuleRun.skipped.reduce<Record<string, number>>((acc, skip) => {
                    acc[skip.reason] = (acc[skip.reason] ?? 0) + 1;
                    return acc;
                  }, {}),
                ).map(([reason, count]) => (
                  <p key={reason} className="text-xs text-muted-foreground">
                    {count} × {describeRuleSkip(reason)}
                  </p>
                ))}
              </div>
            )}
            <div className="space-y-2">
              {reconRules.rules.map((rule) => (
                <div key={rule.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{rule.name}</p>
                      <p className="text-xs text-muted-foreground">{rule.description_pattern || "No pattern"} · matched {rule.match_count}</p>
                    </div>
                    <Badge variant={rule.auto_post ? "secondary" : "outline"}>{rule.auto_post ? "To-check" : "Suggestion"}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="fx" className="space-y-4">
            <FinanceReadOnlyNotice
              what="review FX revaluation settings"
              permission="finance.manage_je"
              isLoading={permLoading}
              readOnly={fxReadOnly}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Revaluation date</p>
                <Input type="date" value={fxDraft.run_date} onChange={(event) => setFxDraft((draft) => ({ ...draft, run_date: event.target.value }))} />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Reporting currency</p>
                <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">
                  {currentBusiness?.base_currency ?? "—"}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Unrealized gain and loss are posted to the accounts mapped under
              Settings → Default Accounts (FX Unrealized Gain / Loss). They are resolved
              server-side so every run hits the same accounts.
            </p>

            {readiness && (
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    Period {readiness.fiscal_period_name ?? "—"}
                  </p>
                  <Badge variant={readiness.fiscal_period_status === "open" ? "outline" : "secondary"}>
                    {readiness.fiscal_period_status ?? "no period"}
                  </Badge>
                </div>
                {readiness.foreign_balances.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No foreign-currency monetary balances as of this date.</p>
                ) : (
                  <div className="space-y-1">
                    {readiness.foreign_balances.map((balance) => (
                      <div key={balance.currency} className="flex items-center justify-between text-xs">
                        <span>{balance.currency} · {balance.account_count} account(s)</span>
                        <span className={balance.rate == null ? "text-destructive" : "text-muted-foreground"}>
                          {balance.foreign_balance} @ {balance.rate ?? "no rate on file"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {readiness.missing_rates.length > 0 && (
                  <Alert variant="destructive">
                    <ShieldAlert className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      No rate on file for {readiness.missing_rates.join(", ")} as of {fxDraft.run_date}. Add an override in Currency settings before revaluing.
                    </AlertDescription>
                  </Alert>
                )}
                {periodBlocked && (
                  <Alert variant="destructive">
                    <ShieldAlert className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      This fiscal period is {readiness.fiscal_period_status}. Revaluation can only post into an open period.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
            <Button
              onClick={runFx}
              disabled={
                fx.isRunning ||
                fxReadOnly ||
                periodBlocked ||
                (readiness?.missing_rates.length ?? 0) > 0
              }
            >

              {fx.isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingUp className="h-4 w-4" />}
              Run Revaluation
            </Button>
            <div className="space-y-2">
              {fx.runs.map((run) => (
                <div key={run.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{run.run_date} · {run.base_currency}</p>
                      <p className="text-xs text-muted-foreground">Gain {run.total_unrealized_gain} · Loss {run.total_unrealized_loss}</p>
                      {run.reversed_at && (
                        <p className="text-xs text-muted-foreground">
                          Reversed {run.reversed_at.slice(0, 10)}
                          {run.reversal_journal_entry_id ? " · reversal posted" : ""}
                        </p>
                      )}
                      {run.status === "failed" && run.notes && (
                        <p className="text-xs text-destructive">{run.notes}</p>
                      )}
                    </div>
                    <Badge variant={run.status === "posted" ? "outline" : run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

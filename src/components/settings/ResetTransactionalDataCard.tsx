/**
 * Administrator-only "Reset transactional data" control.
 *
 * The database is the authority: `preview_transactional_reset` and
 * `reset_transactional_data` both call `_assert_reset_permission`, which allows
 * only the organisation owner/admin or a platform admin. Hiding this card is a
 * convenience, not the security boundary.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Loader2 } from "lucide-react";
import { normalizeError } from "@/services/resilience";

const CONFIRM_PHRASE = "RESET TRANSACTIONAL DATA";

// Untyped RPC access: these functions are newer than the generated types.
const callRpc = (fn: string, args: Record<string, unknown>) =>
  (supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>)(fn, args);

const LABELS: Record<string, string> = {
  mf_loan_applications: "Loan applications",
  mf_application_assessments: "Application assessments",
  mf_loans: "Loans",
  mf_loan_schedule: "Repayment schedules",
  mf_loan_disbursements: "Disbursements",
  mf_loan_charges: "Loan charges",
  mf_client_charges: "Client charges",
  mf_loan_events: "Loan events",
  mf_repayments: "Repayments",
  mf_repayment_allocations: "Repayment allocations",
  mf_repayment_batches: "Repayment batches",
  mf_collection_activities: "Collection activities",
  mf_collection_bankings: "Collection bankings",
  mf_event_postings: "Accounting postings from lending",
  journal_entries: "Journal entries",
  journal_entry_lines: "Journal entry lines",
  payments: "Payments",
  bank_transactions: "Bank transactions",
};

const PRESERVED = [
  "Users and sign-in accounts",
  "Roles, access groups and permissions",
  "Branches and branch assignments",
  "Loan products and product versions (unless you tick the option below)",
  "Chart of accounts and account mappings",
  "Company, workspace and system settings",
];

export function ResetTransactionalDataCard() {
  const { currentOrg } = useOrganization();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [running, setRunning] = useState(false);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [includeClients, setIncludeClients] = useState(false);
  const [includeProducts, setIncludeProducts] = useState(false);
  const [phrase, setPhrase] = useState("");

  const openDialog = async () => {
    if (!currentOrg) return;
    setOpen(true);
    setPhrase("");
    setIncludeClients(false);
    setIncludeProducts(false);
    setCounts(null);
    setLoadingPreview(true);
    try {
      const { data, error } = await callRpc("preview_transactional_reset", {
        org_id: currentOrg.id,
      });
      if (error) throw new Error(error.message);
      setCounts((data ?? {}) as Record<string, number>);
    } catch (e) {
      toast({
        title: "Could not read the current data",
        description: normalizeError(e).message,
        variant: "destructive",
      });
    } finally {
      setLoadingPreview(false);
    }
  };

  const runReset = async () => {
    if (!currentOrg) return;
    setRunning(true);
    try {
      const { data, error } = await callRpc("reset_transactional_data", {
        org_id: currentOrg.id,
        confirmation: CONFIRM_PHRASE,
        include_clients: includeClients,
        include_products: includeProducts,
      });
      if (error) throw new Error(error.message);
      const details = (data as { details?: Record<string, unknown> })?.details ?? {};
      const mf = (details["microfinance"] ?? {}) as Record<string, number>;
      const removed = Object.values(mf).reduce((a, b) => a + (Number(b) || 0), 0);
      toast({
        title: "Transactional data reset",
        description: `${removed} lending records removed. Users, access groups and configuration are untouched.`,
      });
      setOpen(false);
    } catch (e) {
      toast({
        title: "Reset failed — nothing was deleted",
        description: normalizeError(e).message,
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  const optionalClients = Number(counts?.["mf_clients_optional"] ?? 0);
  const optionalGroups = Number(counts?.["mf_groups_optional"] ?? 0);
  const optionalProducts = Number(counts?.["mf_loan_products_optional"] ?? 0);
  const optionalProductVersions = Number(
    counts?.["mf_loan_product_versions_optional"] ?? 0,
  );

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          Reset Transactional Data
        </CardTitle>
        <CardDescription>
          Permanently removes transactional and test activity — loan applications, loans,
          schedules, disbursements, repayments, collections and the accounting entries
          those produced — while preserving users, organisation configuration,
          permissions, loan products, the chart of accounts and all other setup data.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={openDialog} disabled={!currentOrg}>
          Reset Transactional Data
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={(v) => !running && setOpen(v)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-destructive">Reset Transactional Data</DialogTitle>
            <DialogDescription>
              This cannot be undone. Review exactly what will be removed.
            </DialogDescription>
          </DialogHeader>

          {loadingPreview ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Counting current records…
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-sm font-medium">Will be removed</p>
                <div className="rounded-md border divide-y">
                  {Object.entries(LABELS).map(([key, label]) => (
                    <div key={key} className="flex justify-between px-3 py-1.5 text-sm">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-medium tabular-nums">
                        {Number(counts?.[key] ?? 0)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-md border p-3">
                <Checkbox
                  id="include-clients"
                  checked={includeClients}
                  onCheckedChange={(v) => setIncludeClients(v === true)}
                />
                <Label htmlFor="include-clients" className="text-sm font-normal leading-snug">
                  Also remove clients and groups ({optionalClients} clients, {optionalGroups}{" "}
                  groups). Leave unchecked to keep the client register and only clear lending
                  activity.
                </Label>
              </div>

              <div className="flex items-start gap-2 rounded-md border p-3">
                <Checkbox
                  id="include-products"
                  checked={includeProducts}
                  onCheckedChange={(v) => setIncludeProducts(v === true)}
                />
                <Label htmlFor="include-products" className="text-sm font-normal leading-snug">
                  Also remove loan products ({optionalProducts} products,{" "}
                  {optionalProductVersions} published versions). Leave unchecked to keep the
                  product catalogue for the next test cycle.
                </Label>
              </div>

              <Alert>
                <AlertDescription>
                  <p className="mb-1 text-sm font-medium">Preserved</p>
                  <ul className="list-disc pl-4 text-sm text-muted-foreground">
                    {PRESERVED.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <Label htmlFor="confirm-phrase">
                  Type <span className="font-mono font-semibold">{CONFIRM_PHRASE}</span> to
                  continue
                </Label>
                <Input
                  id="confirm-phrase"
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={runReset}
              disabled={running || loadingPreview || phrase !== CONFIRM_PHRASE}
            >
              {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reset Transactional Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import type { BankProvider } from "./useBankProviders";

export type BankAccountLifecycleStatus =
  | "draft"
  | "active"
  | "suspended"
  | "closed";

/**
 * One row of `public.bank_account_positions()` — the only sanctioned answer to
 * "how much money does this account hold". Every field is reproducible from
 * source rows, so a figure on screen can always be traced back to a statement
 * line or a posted journal line.
 */
export interface BankAccountPosition {
  /** Opening balance recorded on the account. */
  opening_balance: number;
  /** Opening balance + every imported statement line up to `as_of`. */
  statement_balance: number;
  /** Date of the most recent statement line, or null when none imported. */
  last_statement_line_date: string | null;
  /**
   * Posted-journal balance of the linked control account. `null` when the
   * account has no GL link, or when several bank accounts share one control
   * account and the balance therefore cannot be attributed to just this one.
   */
  gl_balance: number | null;
  /** True when the control account is shared, which is why `gl_balance` is null. */
  gl_shared: boolean;
  unreconciled_count: number;
  unreconciled_amount: number;
  as_of: string;
}

/**
 * The figure to display for an account, and where it came from. Returns `null`
 * rather than a fabricated zero when nothing is resolvable — a missing balance
 * is an absence, not zero (ADR-0136's rule applied to cash).
 */
export function resolveBankAccountBalance(
  account: Pick<BankAccount, "position">,
): { amount: number; source: "gl" | "statement" } | null {
  const p = account.position;
  if (!p) return null;
  if (p.gl_balance != null) return { amount: Number(p.gl_balance), source: "gl" };
  return { amount: Number(p.statement_balance ?? 0), source: "statement" };
}

/**
 * One row of `public.bank_feed_status()` — the only sanctioned answer to
 * "is this account's feed healthy and when did it last run". Connection-level
 * health plus the counts of the most recent run, so a number on screen traces
 * back to an auditable run row.
 */
export interface BankFeedStatus {
  connection_id: string;
  provider_code: string | null;
  status: string | null;
  auto_sync_enabled: boolean | null;
  sync_frequency: string | null;
  last_success_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_run_id: string | null;
  last_run_status: string | null;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_run_window_from: string | null;
  last_run_window_to: string | null;
  last_run_fetched: number | null;
  last_run_inserted: number | null;
  last_run_duplicates: number | null;
  last_run_rejected: number | null;
  last_run_error_code: string | null;
}

export interface BankAccount {

  id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  routing_number: string | null;
  currency: string | null;
  /**
   * Phase 7 — canonical cash position, derived server-side by
   * `bank_account_positions()`. The old `bank_accounts.current_balance`
   * column was removed: nothing maintained it, so it could not be
   * reconciled back to any source row. `null` means "not resolved yet".
   */
  position?: BankAccountPosition | null;
  is_active: boolean | null;
  is_primary: boolean | null;
  account_id: string | null;
  provider_id: string | null;
  external_account_id: string | null;
  /**
   * Phase 14 — feed health, derived from `bank_feed_connections` + the latest
   * `bank_feed_runs` row via `bank_feed_status()`. The old
   * `bank_accounts.sync_status` / `sync_error` / `last_sync_at` columns were
   * removed: feed state has exactly one representation, the connection and its
   * run history, so every imported line traces to a run.
   */
  feed?: BankFeedStatus | null;

  sync_from_date: string | null;
  created_at: string;
  updated_at: string;
  /** Wave 1 lifecycle state machine — `is_active` is a derived read of this. */
  lifecycle_status: BankAccountLifecycleStatus;
  /** Optimistic-concurrency token; required by every mutator RPC. */
  row_version: number;
  opening_balance: number | null;
  opening_balance_date: string | null;
  /** Provenance: the opening-balance journal entry the server posted. */
  opening_balance_je_id: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  provider?: BankProvider;
}

export interface CreateBankAccountData {
  name: string;
  bank_name?: string;
  account_number?: string;
  routing_number?: string;
  currency?: string;
  opening_balance?: number;
  opening_balance_date?: string;
  account_type?: string;
  account_id?: string | null;
  is_primary?: boolean;
  provider_id?: string;
  external_account_id?: string;
  sync_from_date?: string;
  auto_sync_enabled?: boolean;
  sync_frequency?: string;
  /** Create only: false parks the account in `draft` instead of activating it. */
  activate?: boolean;
  /**
   * Optional explicit branch override. If omitted the active finance scope's
   * branch is stamped (NULL when consolidated / "All branches"). The server
   * validates the pairing and derives `is_shared` from it.
   */
  branch_id?: string | null;
}


/**
 * Phase 11 — Banking. Branch-aware reads + business-level mutator gating.
 *
 * Reads: filtered to `branch_id = currentBranch OR branch_id IS NULL` for
 * branch users; HQ / consolidated returns the full set (RLS still enforces
 * `finance.view_consolidated` for cross-branch access).
 *
 * Writes: stamped with the active scope's `business_id` and `branch_id`.
 * RLS additionally requires `finance.manage_bank_accounts` for the parent
 * business, so a branch-only user without the permission gets a friendly
 * `INSUFFICIENT_PRIVILEGE_BANK_MANAGE` toast instead of a raw RLS error.
 */
export function useBankAccounts() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const { allowed: canManage } = useFinancePermission("finance.manage_bank_accounts");

  const lastOrgIdRef = useRef<string | null>(null);
  const lastBusinessIdRef = useRef<string | null>(null);
  const lastBranchIdRef = useRef<string | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchAccounts = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) {
      setAccounts([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      let q = supabase
        .from("bank_accounts")
        .select(`*, provider:platform_bank_providers(*)`)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);

      // Branch scope filter: when a specific branch is active, return rows
      // for that branch + company-wide (NULL) rows. Consolidated mode returns
      // everything the user is allowed to see (RLS enforces the cap).
      if (scope.branchId) {
        q = q.or(`branch_id.eq.${scope.branchId},branch_id.is.null`);
      }

      const { data, error } = await q
        .order("is_primary", { ascending: false })
        .order("name");

      if (error) throw error;
      const rows = (data as unknown as BankAccount[]) || [];

      // Phase 7: balances are never read from the account row. They come from
      // the server projection so statement and GL figures stay traceable.
      const { data: positions, error: posError } = await supabase.rpc(
        "bank_account_positions",
        { _business_id: currentBusiness.id },
      );
      if (posError) {
        console.error("Error resolving bank positions:", posError);
      }
      const byId = new Map<string, BankAccountPosition>(
        ((positions ?? []) as Array<Record<string, unknown>>).map((p) => [
          String(p.bank_account_id),
          {
            opening_balance: Number(p.opening_balance ?? 0),
            statement_balance: Number(p.statement_balance ?? 0),
            last_statement_line_date: (p.last_statement_line_date as string | null) ?? null,
            gl_balance: p.gl_balance == null ? null : Number(p.gl_balance),
            gl_shared: Boolean(p.gl_shared),
            unreconciled_count: Number(p.unreconciled_count ?? 0),
            unreconciled_amount: Number(p.unreconciled_amount ?? 0),
            as_of: String(p.as_of ?? ""),
          },
        ]),
      );

      setAccounts(rows.map((a) => ({ ...a, position: byId.get(a.id) ?? null })));
    } catch (error: unknown) {
      console.error("Error fetching bank accounts:", error);
      toast.error("Failed to load bank accounts");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, scope.branchId]);

  useEffect(() => {
    const orgId = currentOrg?.id ?? null;
    const businessId = currentBusiness?.id ?? null;
    const branchId = scope.branchId ?? null;

    if (!currentOrg?.id) {
      setAccounts([]);
      setIsLoading(false);
      lastOrgIdRef.current = null;
      lastBusinessIdRef.current = null;
      lastBranchIdRef.current = null;
      hasFetchedRef.current = false;
      return;
    }

    if (
      lastOrgIdRef.current !== orgId ||
      lastBusinessIdRef.current !== businessId ||
      lastBranchIdRef.current !== branchId ||
      !hasFetchedRef.current
    ) {
      lastOrgIdRef.current = orgId;
      lastBusinessIdRef.current = businessId;
      lastBranchIdRef.current = branchId;
      hasFetchedRef.current = true;
      fetchAccounts();
    }
  }, [currentOrg?.id, currentBusiness?.id, scope.branchId, fetchAccounts]);

  const mapPermErr = (error: unknown): string | null => {
    const msg = (error as { message?: string })?.message ?? "";
    const code = (error as { code?: string })?.code ?? "";
    if (
      msg.includes("INSUFFICIENT_PRIVILEGE_BANK_MANAGE") ||
      (code === "42501" && msg.includes("finance.manage_bank_accounts"))
    ) {
      return "You don't have permission to manage bank accounts for this business. Ask a finance admin (owner/admin/accountant).";
    }
    if (code === "42501") {
      return "You don't have permission to perform this action on bank accounts.";
    }
    // Wave 1 — the write-seam RPCs raise typed HINTs; prefer them over
    // constraint-name sniffing, which only worked for direct table writes.
    const hint = (error as { hint?: string })?.hint ?? "";
    if (hint === "BANK_ACCOUNT_ALREADY_CONNECTED") {
      return "This bank account is already connected for this company. Open the existing account to manage it instead of adding a duplicate.";
    }
    if (hint === "BANK_ACCOUNT_VERSION_CONFLICT") {
      return "This bank account was changed by someone else while you were editing. Reload and try again.";
    }
    if (hint === "BANK_ACCOUNT_ACCOUNTING_LOCKED") {
      return "Currency, ledger account and opening balance are fixed once this account has posted activity. Post a correcting journal entry instead.";
    }
    if (hint === "BANK_ACCOUNT_UNRECONCILED" || hint === "BANK_ACCOUNT_OPEN_RECONCILIATION") {
      return msg || "Finish reconciling this account before closing it.";
    }
    if (hint === "BANK_ACCOUNT_NOT_DELETABLE") {
      return "This bank account has financial history and cannot be deleted. Close it instead.";
    }
    if (hint === "BANK_ACCOUNT_NEEDS_GL" || hint === "BANK_OPENING_BALANCE_NEEDS_GL") {
      return msg || "Link a Chart-of-Accounts entry before activating this bank account.";
    }
    if (hint === "BANK_ACCOUNT_INVALID_TRANSITION" || hint === "BANK_ACCOUNT_CLOSED") {
      return msg || "That status change isn't allowed for this bank account.";
    }
    // Legacy constraint messages (older rows / service-role paths).
    if (code === "23505") {
      return "This bank account is already connected for this company.";
    }
    if (code === "23514" && msg.includes("bank_accounts_shared_branch_consistency")) {
      return "Shared-across-branches accounts cannot also be tagged to a single branch. Pick one.";
    }
    return null;
  };


  /**
   * Wave 1 write seam. The browser never writes `bank_accounts` directly:
   * every mutation goes through a SECURITY DEFINER RPC that owns lifecycle
   * invariants, currency validation, opening-balance posting through
   * `post_journal_entry_atomic`, and optimistic concurrency.
   */
  const toPayload = (data: Partial<CreateBankAccountData>) => {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      payload[k] = v;
    }
    return payload;
  };

  const createAccount = async (data: CreateBankAccountData) => {
    if (!currentBusiness?.id) return;

    try {
      setIsSaving(true);
      // Default branch_id to the active scope branch (NULL = company-wide).
      const branch_id = data.branch_id !== undefined ? data.branch_id : scope.branchId;

      const { data: created, error } = await supabase.rpc("bank_account_create", {
        _business_id: currentBusiness.id,
        _payload: toPayload({ ...data, branch_id }) as never,
      });

      if (error) throw error;
      toast.success("Bank account added successfully");
      await fetchAccounts();
      return created as unknown as BankAccount;
    } catch (error: unknown) {
      console.error("Error creating bank account:", error);
      const friendly = mapPermErr(error);
      const hint = (error as { hint?: string })?.hint ?? "";
      // G3 — duplicate-connection toasts deep-link to /banking so the user
      // can open the existing account instead of creating another.
      if (hint === "BANK_ACCOUNT_ALREADY_CONNECTED") {
        toast.error(friendly ?? "This bank account is already connected.", {
          action: {
            label: "Open bank accounts",
            onClick: () => {
              window.location.href = "/banking";
            },
          },
        });
      } else {
        toast.error(friendly ?? "Failed to add bank account");
      }
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const updateAccount = async (
    id: string,
    data: Partial<CreateBankAccountData>,
    rowVersion?: number,
  ) => {
    try {
      setIsSaving(true);
      const version =
        rowVersion ?? accounts.find((a) => a.id === id)?.row_version ?? null;
      const { error } = await supabase.rpc("bank_account_update", {
        _id: id,
        _row_version: version,
        _payload: toPayload(data) as never,
      });

      if (error) throw error;
      toast.success("Bank account updated successfully");
      await fetchAccounts();
    } catch (error: unknown) {
      console.error("Error updating bank account:", error);
      const friendly = mapPermErr(error);
      toast.error(friendly ?? "Failed to update bank account");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  /** Lifecycle change: activate / suspend / close. Closure is guarded server-side. */
  const transitionAccount = async (
    id: string,
    target: BankAccountLifecycleStatus,
    reason?: string,
  ) => {
    try {
      setIsSaving(true);
      const version = accounts.find((a) => a.id === id)?.row_version ?? null;
      const { error } = await supabase.rpc("bank_account_transition", {
        _id: id,
        _target: target,
        _reason: reason ?? null,
        _row_version: version,
      });
      if (error) throw error;
      toast.success(
        target === "closed"
          ? "Bank account closed"
          : target === "suspended"
            ? "Bank account suspended"
            : "Bank account activated",
      );
      await fetchAccounts();
    } catch (error: unknown) {
      console.error("Error changing bank account status:", error);
      const friendly = mapPermErr(error);
      toast.error(friendly ?? "Failed to change bank account status");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Deletion only ever removes an untouched draft. An account with financial
   * history is closed instead — the server refuses anything else.
   */
  const deleteAccount = async (id: string) => {
    try {
      setIsSaving(true);
      const account = accounts.find((a) => a.id === id);
      if (account && account.lifecycle_status !== "draft") {
        await transitionAccount(id, "closed", "Removed from bank account list");
        return;
      }
      const { error } = await supabase.rpc("bank_account_delete_draft", {
        _id: id,
        _row_version: account?.row_version ?? null,
      });
      if (error) throw error;
      toast.success("Bank account deleted successfully");
      await fetchAccounts();
    } catch (error: unknown) {
      console.error("Error deleting bank account:", error);
      const friendly = mapPermErr(error);
      toast.error(friendly ?? "Failed to delete bank account");
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Sync is owned end-to-end by the `sync-bank-transactions` function: it
   * stamps `sync_status` / `sync_error` with the service role. The browser
   * only asks for the sync and re-reads the result.
   */
  const syncTransactions = async (accountId: string) => {
    if (!currentOrg?.id) return;

    try {
      setIsSaving(true);

      const { data, error } = await supabase.functions.invoke("sync-bank-transactions", {
        body: { bank_account_id: accountId, organization_id: currentOrg.id },
      });

      if (error) throw error;

      if (data?.success) {
        toast.success(`Synced ${data.new_transactions ?? 0} transactions`);
      } else {
        toast.error(data?.message || "Sync failed");
      }
    } catch (error: unknown) {
      console.error("Error syncing transactions:", error);
      toast.error("Failed to sync transactions");
    } finally {
      await fetchAccounts();
      setIsSaving(false);
    }
  };


  // Stable identity to play nicely with downstream hooks/memos.
  const value = useMemo(
    () => ({
      accounts,
      isLoading,
      isSaving,
      canManage,
      fetchAccounts,
      createAccount,
      updateAccount,
      transitionAccount,

      deleteAccount,
      syncTransactions,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, isLoading, isSaving, canManage, fetchAccounts],
  );

  return value;
}

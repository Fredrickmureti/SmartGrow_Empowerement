/* eslint-disable @typescript-eslint/no-explicit-any */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { usePermissions } from "./usePermissions";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface JournalEntry {
  id: string;
  organization_id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  reference: string | null;
  is_adjusting: boolean;
  is_closing: boolean;
  is_reversing: boolean;
  is_reversal: boolean;
  reversed_entry_id: string | null;
  reversal_of_id: string | null;
  reversed_by_id: string | null;
  status: 'draft' | 'posted' | 'voided' | 'reversed';
  posted_at: string | null;
  posted_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  source_type: string | null;
  source_id: string | null;
  lines?: JournalEntryLine[];
  total_debit?: number;
  total_credit?: number;
}

export interface JournalEntryLine {
  id: string;
  journal_entry_id: string;
  account_id: string;
  description: string | null;
  debit: number;
  credit: number;
  contact_id: string | null;
  sort_order: number;
  created_at: string;
  accounts?: {
    id: string;
    name: string;
    code: string;
    account_type: string;
  };
  contacts?: {
    id: string;
    name: string;
  } | null;
}

export interface CreateJournalEntryInput {
  entry_date: string;
  description: string;
  reference?: string;
  is_adjusting?: boolean;
  is_closing?: boolean;
  lines: {
    account_id: string;
    description?: string;
    debit: number;
    credit: number;
    contact_id?: string;
  }[];
}

export interface UpdateJournalEntryInput extends CreateJournalEntryInput {
  id: string;
}

export function useJournalEntries() {
  const { currentOrg, isLoading: isOrgLoading } = useOrganization();
  const { currentBusiness, isLoading: isBusinessLoading } = useBusinesses();
  const { currentBranch, isLoading: isBranchLoading } = useBranch();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;

  // Wait for the FULL finance scope chain (org → business → branch) to
  // hydrate before firing the query. Without this gate the first render
  // runs with currentBranch=null and returns every JE in the business —
  // briefly leaking HQ + sibling-branch entries to a Branch A user (the
  // visible "flicker" before the list collapses to the branch's rows).
  const scopeReady =
    !isOrgLoading && !isBusinessLoading && !isBranchLoading && !!organizationId;

  // Fetch journal entries with server-side limit (pagination-ready)
  const { data: journalEntries = [], isLoading } = useQuery({
    queryKey: ["journal-entries", organizationId, currentBusiness?.id, currentBranch?.id ?? "all"],
    queryFn: async () => {
      if (!organizationId) return [];
      let query = supabase
        .from("journal_entries")
        .select(`
          *,
          journal_entry_lines(
            *,
            accounts(id, name, code, account_type),
            contacts(id, name)
          )
        `)
        .eq("organization_id", organizationId);

      if (currentBusiness) {
        query = query.eq("business_id", currentBusiness.id);
      }

      // Branch scoping (mirrors useFinanceScope contract):
      //   - currentBranch != null  → show entries for THAT branch + entries
      //     with branch_id IS NULL (business-wide / unattributable, e.g.
      //     depreciation, year-end closing, opening balances).
      //   - currentBranch == null  → "All branches / consolidated" — show
      //     every entry in the business.
      // Without this filter a Branch A user sees HQ + every other branch's
      // journal entries, which leaks data and makes per-branch tracking
      // impossible.
      if (currentBranch?.id) {
        query = query.or(`branch_id.eq.${currentBranch.id},branch_id.is.null`);
      }

      const { data, error } = await query
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(0, 499); // Server-side limit: first 500 entries

      if (error) throw error;
      
      return data.map(entry => {
        const lines = entry.journal_entry_lines || [];
        return {
          ...entry,
          lines,
          total_debit: lines.reduce((sum: number, line: JournalEntryLine) => sum + (line.debit || 0), 0),
          total_credit: lines.reduce((sum: number, line: JournalEntryLine) => sum + (line.credit || 0), 0),
        };
      }) as JournalEntry[];
    },
    enabled: scopeReady,
    staleTime: 15_000,
  });

  // Numbering is owned by the posting engine (post_journal_entry_atomic →
  // generate_next_je_number). The client never mints an entry number.
  const generateEntryNumber = async (): Promise<null> => null;

  // Create journal entry — atomic via DB function (P0-3 fix)
  const createJournalEntry = useMutation({
    mutationFn: async (input: CreateJournalEntryInput) => {
      if (!can("manageFinancials")) throw new Error("Permission denied: cannot create journal entries");
      if (!organizationId) throw new Error("No organization selected");

      // Validate that debits equal credits
      const totalDebit = input.lines.reduce((sum, line) => sum + line.debit, 0);
      const totalCredit = input.lines.reduce((sum, line) => sum + line.credit, 0);
      
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        throw new Error("Debits must equal credits");
      }

      const { data: userData } = await supabase.auth.getUser();
      const entryNumber = await generateEntryNumber();

      // Build lines JSON for the atomic RPC
      const linesJson = input.lines.map((line, index) => ({
        account_id: line.account_id,
        description: line.description || "",
        debit: line.debit,
        credit: line.credit,
        contact_id: line.contact_id || null,
      }));

      // Single atomic DB call — header + lines in one transaction
      const { data: entryId, error: rpcError } = await supabase.rpc(
        "create_journal_entry_atomic" as any,
        {
          _org_id: organizationId,
          _business_id: currentBusiness?.id || null,
          _entry_number: entryNumber,
          _entry_date: input.entry_date,
          _description: input.description,
          _reference: input.reference || null,
          _is_adjusting: input.is_adjusting || false,
          _is_closing: input.is_closing || false,
          _created_by: userData?.user?.id || null,
          _lines: linesJson,
          // Stage 3: stamp the active branch so per-branch GL is consistent
          // for manual JEs. Caller can pass `branch_id: null` to record an
          // unattributable entry (e.g. HQ-level depreciation).
          _branch_id: (input as any).branch_id !== undefined
            ? (input as any).branch_id
            : (currentBranch?.id ?? null),
        }
      );

      if (rpcError) throw rpcError;

      // Fetch the created entry to return it
      const { data: entry, error: fetchError } = await supabase
        .from("journal_entries")
        .select("*")
        .eq("id", entryId)
        .single();

      if (fetchError) throw fetchError;
      return entry;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      toast.success("Journal entry created");
    },
    onError: (error) => {
      toast.error("Failed to create journal entry: " + normalizeError(error).message);
    },
  });

  // Update journal entry (draft only — posted/voided entries are immutable)
  const updateJournalEntry = useMutation({
    mutationFn: async (input: UpdateJournalEntryInput) => {
      if (!can("manageFinancials")) throw new Error("Permission denied: cannot update journal entries");
      // P0 Immutability Guard: Only draft entries can be edited
      const { data: existing, error: fetchErr } = await supabase
        .from("journal_entries")
        .select("status")
        .eq("id", input.id)
        .single();

      if (fetchErr) throw fetchErr;
      if (!existing) throw new Error("Journal entry not found");
      if (existing.status !== "draft") {
        throw new Error(`Cannot edit a ${existing.status} journal entry. Create a reversing entry or void it instead.`);
      }

      // Validate that debits equal credits
      const totalDebit = input.lines.reduce((sum, line) => sum + line.debit, 0);
      const totalCredit = input.lines.reduce((sum, line) => sum + line.credit, 0);
      
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        throw new Error("Debits must equal credits");
      }

      // C5 FIX: Use atomic server-side RPC instead of delete-then-insert
      const linesJson = input.lines.map((line, index) => ({
        account_id: line.account_id,
        description: line.description || "",
        debit: line.debit || 0,
        credit: line.credit || 0,
        contact_id: line.contact_id || null,
        sort_order: index,
      }));

      const { error: rpcError } = await supabase.rpc("update_journal_entry_atomic", {
        _entry_id: input.id,
        _entry_date: input.entry_date,
        _description: input.description,
        _reference: input.reference || null,
        _is_adjusting: input.is_adjusting || false,
        _is_closing: input.is_closing || false,
        _lines: linesJson,
      });

      if (rpcError) throw rpcError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      toast.success("Journal entry updated");
    },
    onError: (error) => {
      toast.error("Failed to update journal entry: " + normalizeError(error).message);
    },
  });

  // Post journal entry — server-side validated (balance check + draft guard)
  const postJournalEntry = useMutation({
    mutationFn: async (entryId: string) => {
      const { data: userData } = await supabase.auth.getUser();

      const { error } = await supabase.rpc("post_journal_entry_status", {
        _entry_id: entryId,
        _user_id: userData?.user?.id || null,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Journal entry posted");
    },
    onError: (error) => {
      toast.error("Failed to post journal entry: " + normalizeError(error).message);
    },
  });

  // Void journal entry — atomic server-side: creates reversal + marks original in one transaction
  const voidJournalEntry = useMutation({
    mutationFn: async ({ entryId, reason }: { entryId: string; reason: string }) => {
      if (!organizationId) throw new Error("No organization selected");

      const { data: userData } = await supabase.auth.getUser();
      const entryNumber = await generateEntryNumber();

      const { data: reversalId, error } = await supabase.rpc(
        "void_journal_entry_atomic" as any,
        {
          _entry_id: entryId,
          _reason: reason,
          _user_id: userData?.user?.id || null,
          _entry_number: entryNumber,
        }
      );

      if (error) throw error;
      return reversalId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Journal entry voided — reversal entry created");
    },
    onError: (error: Error) => {
      toast.error("Failed to void journal entry: " + normalizeError(error).message);
    },
  });

  // Delete journal entry — atomic server-side (lines + header in one transaction)
  const deleteJournalEntry = useMutation({
    mutationFn: async (entryId: string) => {
      if (!can("manageFinancials")) throw new Error("Permission denied: cannot delete journal entries");

      const { error } = await supabase.rpc("delete_draft_journal_entry", {
        _entry_id: entryId,
      });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      toast.success("Journal entry deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete journal entry: " + normalizeError(error).message);
    },
  });

  // Create reversing entry — delegates to canonical void_journal_entry_atomic RPC.
  // The RPC handles all guards, idempotency, balance-flip, source linkage,
  // and original-entry status update in ONE transaction. NEVER mutates lines.
  const createReversingEntry = useMutation({
    mutationFn: async (entryId: string) => {
      if (!organizationId) throw new Error("No organization selected");

      const { data: userData } = await supabase.auth.getUser();
      const { data: result, error } = await supabase.rpc("void_journal_entry_atomic", {
        _entry_id: entryId,
        _reason: "Manual reversal",
        _user_id: userData?.user?.id || null,
        _entry_number: null,
        _reversal_date: null,
      } as any);

      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
      toast.success("Reversing entry created");
    },
    onError: (error) => {
      toast.error("Failed to create reversing entry: " + normalizeError(error).message);
    },
  });

  return {
    journalEntries,
    isLoading,
    createJournalEntry,
    updateJournalEntry,
    postJournalEntry,
    voidJournalEntry,
    deleteJournalEntry,
    createReversingEntry,
  };
}

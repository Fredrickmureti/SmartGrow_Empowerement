import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export interface Branch {
  id: string;
  business_id: string;
  organization_id: string;
  name: string;
  code: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  is_headquarters: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  logo_url?: string | null;
  receipt_header?: string | null;
  receipt_footer?: string | null;
  invoice_prefix_suffix?: string | null;
  default_warehouse_id?: string | null;
  // Additional fields from RPC
  is_primary_assignment?: boolean;
  can_manage?: boolean;
}

export interface CreateBranchInput {
  name: string;
  code?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  is_headquarters?: boolean;
}

interface BranchContextType {
  branches: Branch[];
  currentBranch: Branch | null;
  isLoading: boolean;
  switchBranch: (branchId: string | null) => void;
  createBranch: (input: CreateBranchInput) => Promise<Branch>;
  updateBranch: (id: string, updates: Partial<CreateBranchInput>) => Promise<Branch>;
  deleteBranch: (id: string) => Promise<void>;
  setHeadquarters: (branchId: string) => Promise<void>;
  refreshBranches: () => Promise<void>;
  canManageCurrentBranch: boolean;
  hasMultipleBranches: boolean;
  /**
   * Dashboard-only opt-in for the All-Branches consolidated view.
   * Stored separately from `currentBranch` so transactional pages
   * (POS, invoicing, inventory) keep their single-branch guarantee
   * even when the dashboard is showing consolidated metrics.
   * Only meaningful for users with `dashboard.view_consolidated`.
   */
  consolidatedView: boolean;
  setConsolidatedView: (next: boolean) => void;
}

const BranchContext = createContext<BranchContextType | undefined>(undefined);

export function BranchProvider({ children }: { children: ReactNode }) {
  const { currentOrg, isLoading: orgLoading } = useOrganization();
  const { currentBusiness, isLoading: businessLoading } = useBusinesses();
  const { user } = useAuth();
  // Depend on the stable identity, never the session-bound `user` object —
  // a re-emitted auth event must not re-trigger the branch fetch (and its
  // isLoading=true flash) for the same signed-in user.
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [currentBranch, setCurrentBranch] = useState<Branch | null>(null);
  // `isLoading` is HONEST about upstream readiness. It starts true and only
  // flips false when the branch fetch genuinely settles for the current
  // (org, business) pair, OR when upstream contexts have themselves finished
  // loading and definitively report "no org / no business" (terminal state).
  // This closes the t2..t3 flicker window where branch-scoped surfaces saw
  // `isLoading=false && currentBranch=null` while business was still
  // hydrating. See docs/audit/2026-05-20-pos-security-settings-and-branch-hydration.md.
  const [isLoading, setIsLoading] = useState(true);
  const [consolidatedView, setConsolidatedViewState] = useState<boolean>(false);

  // Restore consolidated-view preference per business on mount / business switch.
  useEffect(() => {
    if (!currentBusiness) {
      setConsolidatedViewState(false);
      return;
    }
    const stored = localStorage.getItem(`dashboardConsolidated_${currentBusiness.id}`);
    setConsolidatedViewState(stored === "1");
  }, [currentBusiness?.id]);

  const invalidateDashboard = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-analytics"] });
    queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
    queryClient.invalidateQueries({ queryKey: ["executive-stats"] });
  }, [queryClient]);

  const setConsolidatedView = useCallback(
    (next: boolean) => {
      setConsolidatedViewState(next);
      if (currentBusiness) {
        localStorage.setItem(
          `dashboardConsolidated_${currentBusiness.id}`,
          next ? "1" : "0",
        );
      }
      invalidateDashboard();
    },
    [currentBusiness, invalidateDashboard],
  );

  const fetchBranches = useCallback(async () => {
    // Upstream contexts still hydrating — keep isLoading=true. Flipping it
    // false here would let branch-scoped UIs render a "no branch" terminal
    // state during the transient hydration gap.
    if (orgLoading || businessLoading) {
      return;
    }

    if (!currentOrg || !userId) {
      // Terminal: no auth/org. Safe to mark loaded.
      setBranches([]);
      setCurrentBranch(null);
      setIsLoading(false);
      return;
    }

    if (!currentBusiness) {
      // Terminal: authenticated, has org, but no company selected.
      // Branch-critical surfaces gate on currentBusiness explicitly.
      setBranches([]);
      setCurrentBranch(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      // Use the RPC function to get only branches the user can access (returns
      // ids + access flags). Identity fields (email/phone/address) are then
      // hydrated via a single follow-up SELECT — never returned as nulls.
      const { data: rpcData, error } = await supabase.rpc("get_user_allowed_branches", {
        _user_id: userId,
        _business_id: currentBusiness.id,
      });

      let baseBranches: Branch[] = [];

      if (error) {
        console.error("Error fetching branches via RPC:", error);
        // Fallback: direct query (admins / RLS-permitted users). Same shape
        // as the hydrated path so downstream code is identical.
        const { data: fallbackData, error: fallbackError } = await supabase
          .from("branches")
          .select("*")
          .eq("business_id", currentBusiness.id)
          .eq("is_active", true)
          .order("is_headquarters", { ascending: false })
          .order("name");

        if (fallbackError) throw fallbackError;

        baseBranches = (fallbackData || []).map((b: any) => ({
          ...b,
          is_primary_assignment: false,
          can_manage: true,
        }));
      } else {
        const rpcRows = (rpcData || []) as Array<{
          id: string;
          name: string;
          code: string | null;
          business_id: string;
          organization_id: string;
          is_headquarters: boolean | null;
          is_active: boolean | null;
          is_primary_assignment: boolean;
          can_manage: boolean;
        }>;

        if (rpcRows.length === 0) {
          baseBranches = [];
        } else {
          // Hydrate identity fields with a single round-trip — RPC only
          // returns access metadata, never the address/contact columns.
          const branchIds = rpcRows.map((r) => r.id);
          const { data: identityData, error: identityError } = await supabase
            .from("branches")
            .select("id, email, phone, address, city, state, postal_code, country, logo_url, receipt_header, receipt_footer, invoice_prefix_suffix, default_warehouse_id, created_at, updated_at")
            .in("id", branchIds);

          if (identityError) throw identityError;

          const identityMap = new Map<string, any>(
            (identityData || []).map((row: any) => [row.id as string, row]),
          );

          baseBranches = rpcRows.map((b) => {
            const identity: any = identityMap.get(b.id) || {};
            return {
              id: b.id,
              business_id: b.business_id,
              organization_id: b.organization_id,
              name: b.name,
              code: b.code,
              email: identity.email ?? null,
              phone: identity.phone ?? null,
              address: identity.address ?? null,
              city: identity.city ?? null,
              state: identity.state ?? null,
              postal_code: identity.postal_code ?? null,
              country: identity.country ?? null,
              logo_url: identity.logo_url ?? null,
              receipt_header: identity.receipt_header ?? null,
              receipt_footer: identity.receipt_footer ?? null,
              invoice_prefix_suffix: identity.invoice_prefix_suffix ?? null,
              default_warehouse_id: identity.default_warehouse_id ?? null,
              is_headquarters: b.is_headquarters ?? false,
              is_active: b.is_active ?? true,
              created_at: identity.created_at ?? new Date().toISOString(),
              updated_at: identity.updated_at ?? new Date().toISOString(),
              is_primary_assignment: b.is_primary_assignment,
              can_manage: b.can_manage,
            };
          });
        }
      }

      setBranches(baseBranches);

      // Restore previously selected branch or pick primary/HQ/first.
      // Legacy "all" sentinel is migrated to the headquarters / first branch.
      const storedBranchId = localStorage.getItem(`currentBranchId_${currentBusiness.id}`);
      const fallback =
        baseBranches.find((b) => b.is_primary_assignment) ||
        baseBranches.find((b) => b.is_headquarters) ||
        baseBranches[0] ||
        null;

      if (storedBranchId === "all" || !storedBranchId) {
        setCurrentBranch(fallback);
        if (fallback) {
          localStorage.setItem(`currentBranchId_${currentBusiness.id}`, fallback.id);
        }
      } else {
        setCurrentBranch(baseBranches.find((b) => b.id === storedBranchId) || fallback);
      }
    } catch (error) {
      console.error("Error fetching branches:", error);
      toast.error("Failed to load branches");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg, currentBusiness, userId, orgLoading, businessLoading]);

  useEffect(() => {
    fetchBranches();
  }, [fetchBranches]);

  const switchBranch = useCallback((branchId: string | null) => {
    if (branchId === null || branchId === undefined || branchId === "") {
      throw new Error("switchBranch requires a valid branch id. The legacy 'All Branches' pseudo-mode no longer exists.");
    }

    // Stage R10 — branch-scoped caches must be flushed on context switch so
    // foreign-branch data cannot be re-rendered from React Query cache while
    // the new branch's data is in flight. Predicate matches every key whose
    // first segment is a known branch-sensitive prefix; non-scoped caches
    // (auth, profile, billing, etc.) are left intact.
    // INVARIANT: every POS query key that touches a branch-scoped table MUST
    // (a) include `currentBranch?.id` in its queryKey AND (b) appear (or have
    // its prefix appear) in this list. If you add a new POS hook, update both.
    const BRANCH_SCOPED_PREFIXES = [
      "pos",                       // legacy umbrella
      "pos-registers",
      "pos-shifts",
      "pos-current-shift",
      "pos-user-current-shift",
      "pos-orphaned-shifts",       // R4: rescue alert
      "pos-shift-integrity",
      "pos-cashiers",
      "pos-active-session",
      "pos-table-sessions",
      "pos-table-session",
      "pos-held-transactions",
      "pos-kitchen-orders",
      "pos-waitlist",
      "pos-dashboard-stats",
      "pos-transactions",
      "pos-split-bill",
      "pos-split-bill-portions",
      // Reporting fan-outs (gated by overseer, but cache must still flush)
      "pos-daily-sales",
      "pos-hourly-sales",
      "pos-top-products",
      "pos-z-report",
      "pos-tax-summary",
      "pos-payment-breakdown",
      "pos-cashier-performance",
      "pos-fraud-indicators",
      "pos-abc-analysis",
      "pos-customer-analytics",
      "floor-plan",
      "terminal-session",
      "register-cashiers",
      "register-security-settings",
      "pos-register-branch-guard",
      "inventory",
      "warehouse",
      "stock",
    ];
    queryClient.invalidateQueries({
      predicate: (q) => {
        const first = q.queryKey?.[0];
        return typeof first === "string" && BRANCH_SCOPED_PREFIXES.some((p) => first === p || first.startsWith(`${p}-`));
      },
    });
    // Dashboard caches are scope-keyed; switching branch must refetch.
    invalidateDashboard();

    const branch = branches.find((b) => b.id === branchId);
    if (branch && currentBusiness) {
      setCurrentBranch(branch);
      localStorage.setItem(`currentBranchId_${currentBusiness.id}`, branchId);
    }
  }, [branches, currentBusiness, queryClient, invalidateDashboard]);

  const createBranch = async (input: CreateBranchInput): Promise<Branch> => {
    if (!currentOrg || !currentBusiness) throw new Error("No business selected");

    const { data, error } = await supabase
      .from("branches")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        ...input,
      })
      .select()
      .single();

    if (error) throw error;

    toast.success("Branch created successfully");
    await fetchBranches();
    return data;
  };

  const updateBranch = async (id: string, updates: Partial<CreateBranchInput>): Promise<Branch> => {
    if (!currentOrg || !currentBusiness) throw new Error("No business selected");
    const { data, error } = await supabase
      .from("branches")
      .update(updates)
      .eq("id", id)
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .select()
      .single();

    if (error) throw error;

    toast.success("Branch updated successfully");
    await fetchBranches();
    return data;
  };

  const deleteBranch = async (id: string): Promise<void> => {
    if (!currentOrg || !currentBusiness) throw new Error("No business selected");
    const { error } = await supabase
      .from("branches")
      .update({ is_active: false })
      .eq("id", id)
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id);

    if (error) throw error;

    toast.success("Branch deleted successfully");
    await fetchBranches();
  };

  const setHeadquarters = async (branchId: string): Promise<void> => {
    if (!currentOrg || !currentBusiness) return;

    // First, unset all headquarters for this business
    await supabase
      .from("branches")
      .update({ is_headquarters: false })
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id);

    // Then set the new headquarters
    const { error } = await supabase
      .from("branches")
      .update({ is_headquarters: true })
      .eq("id", branchId)
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id);

    if (error) throw error;

    toast.success("Headquarters updated");
    await fetchBranches();
  };

  // Determine if user can manage current branch
  const canManageCurrentBranch = currentBranch?.can_manage ?? true;
  const hasMultipleBranches = branches.length > 1;

  return (
    <BranchContext.Provider
      value={{
        branches,
        currentBranch,
        isLoading,
        switchBranch,
        createBranch,
        updateBranch,
        deleteBranch,
        setHeadquarters,
        refreshBranches: fetchBranches,
        canManageCurrentBranch,
        hasMultipleBranches,
        consolidatedView,
        setConsolidatedView,
      }}
    >
      {children}
    </BranchContext.Provider>
  );
}

export function useBranch() {
  const context = useContext(BranchContext);
  if (!context) {
    throw new Error("useBranch must be used within BranchProvider");
  }
  return context;
}

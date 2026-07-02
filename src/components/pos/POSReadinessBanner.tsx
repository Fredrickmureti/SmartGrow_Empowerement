import { normalizeError } from "@/services/resilience";
/**
 * POSReadinessBanner — context-aware setup remediation panel.
 *
 * The DB RPCs `ensure_pos_ready_for_business` (company-wide) and
 * `ensure_pos_ready_for_branch` (current branch) return a list of
 * machine-readable `missing` keys. Instead of dumping those keys as flat
 * red text, this component:
 *
 *   - explains each missing item in human language,
 *   - shows a count where one is meaningful (e.g. "3 of 5 payment methods
 *     have no GL account mapped"),
 *   - groups items by severity ("blocking" vs "recommended"),
 *   - exposes a one-click "Fix this" deep link to the right settings tab,
 *   - offers "Apply default GL mappings" which calls the
 *     `pos_apply_default_method_gl` RPC and re-checks readiness,
 *   - re-runs both RPCs on demand so resolved items disappear immediately.
 *
 * It deliberately distinguishes "GL account is configured on the method
 * *template*" (DefaultAccountsConfig) from "GL account is persisted on the
 * enabled `pos_payment_methods` row" — that confusion is a frequent
 * source of "I configured it but POS still says it's missing" tickets.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ArrowRight,
  Wrench,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { toast } from "sonner";

interface ReadinessResult {
  ok: boolean;
  missing: string[];
}

type Severity = "blocking" | "recommended";

interface ItemDescriptor {
  key: string;
  title: string;
  detail: string;
  severity: Severity;
  cta?: { label: string; href: string };
  /** Optional secondary action (e.g. "Apply defaults"). */
  secondary?: { label: string; onClick: () => void; loading?: boolean };
}

export function usePOSReadiness() {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["pos-readiness", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async (): Promise<ReadinessResult> => {
      const { data, error } = await supabase.rpc(
        "ensure_pos_ready_for_business" as any,
        { _business_id: currentBusiness!.id } as any,
      );
      if (error) throw error;
      const result = (data ?? { ok: false, missing: [] }) as ReadinessResult;
      return {
        ok: !!result.ok,
        missing: Array.isArray(result.missing) ? result.missing : [],
      };
    },
    staleTime: 30_000,
  });
}

export function usePOSBranchReadiness() {
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  return useQuery({
    queryKey: ["pos-branch-readiness", currentBusiness?.id, currentBranch?.id],
    enabled: !!currentBusiness?.id && !!currentBranch?.id,
    queryFn: async (): Promise<ReadinessResult> => {
      const { data, error } = await supabase.rpc(
        "ensure_pos_ready_for_branch" as any,
        {
          _business_id: currentBusiness!.id,
          _branch_id: currentBranch!.id,
        } as any,
      );
      if (error) throw error;
      const result = (data ?? { ok: false, missing: [] }) as ReadinessResult;
      return {
        ok: !!result.ok,
        missing: Array.isArray(result.missing) ? result.missing : [],
      };
    },
    staleTime: 30_000,
  });
}

/** Side-query: how many enabled payment methods have NO GL account mapped. */
function usePaymentMethodMappingStats() {
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: ["pos-payment-method-mapping-stats", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pos_payment_methods")
        .select("id, display_name, debit_account_id, clearing_account_id, is_enabled")
        .eq("business_id", currentBusiness!.id)
        .eq("is_enabled", true);
      if (error) throw error;
      const rows = data ?? [];
      const unmapped = rows.filter(
        (r: any) => !r.debit_account_id && !r.clearing_account_id,
      );
      return {
        total: rows.length,
        unmapped: unmapped.length,
        unmappedNames: unmapped.map((r: any) => r.display_name).filter(Boolean),
      };
    },
    staleTime: 30_000,
  });
}

export function POSReadinessBanner() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { data, isLoading, refetch: refetchCompany } = usePOSReadiness();
  const {
    data: branchData,
    isLoading: branchLoading,
    refetch: refetchBranch,
  } = usePOSBranchReadiness();
  const { data: methodStats } = usePaymentMethodMappingStats();
  const [applyingDefaults, setApplyingDefaults] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  const recheck = async () => {
    setRechecking(true);
    try {
      await Promise.all([refetchCompany(), refetchBranch()]);
      await queryClient.invalidateQueries({
        queryKey: ["pos-payment-method-mapping-stats", currentBusiness?.id],
      });
    } finally {
      setRechecking(false);
    }
  };

  const applyDefaultMethodGL = async () => {
    if (!currentBusiness?.id) return;
    setApplyingDefaults(true);
    try {
      const { data, error } = await supabase.rpc(
        "pos_apply_default_method_gl" as any,
        { _business_id: currentBusiness.id } as any,
      );
      if (error) throw error;
      const result: any = data ?? {};
      if (result.ok === false) {
        toast.error(
          result.error === "forbidden"
            ? "You don't have permission to change GL mappings."
            : `Couldn't apply defaults: ${result.error ?? "unknown error"}`,
        );
        return;
      }
      const updated = result.updated ?? 0;
      const skipped = result.skipped ?? 0;
      if (updated === 0 && skipped === 0) {
        toast.info("All enabled payment methods already have a GL account.");
      } else if (updated > 0) {
        toast.success(
          `Mapped ${updated} payment method${updated === 1 ? "" : "s"} to default accounts.${
            skipped > 0
              ? ` ${skipped} skipped — no matching default account in your Chart of Accounts.`
              : ""
          }`,
        );
      } else {
        toast.warning(
          `Couldn't auto-map ${skipped} method${skipped === 1 ? "" : "s"} — please configure GL accounts manually.`,
        );
      }
      await recheck();
    } catch (err: any) {
      toast.error(`Couldn't apply defaults: ${normalizeError(err).message ?? "unknown error"}`);
    } finally {
      setApplyingDefaults(false);
    }
  };

  const items = useMemo<ItemDescriptor[]>(() => {
    const all = [
      ...((data?.missing ?? []) as string[]),
      ...((branchData?.missing ?? []) as string[]),
    ];
    const unique = Array.from(new Set(all));

    const branchLabel = currentBranch?.name ? ` for ${currentBranch.name}` : "";
    const posSettings = (tab: string) => `/pos/settings?tab=${tab}`;

    return unique
      .map<ItemDescriptor | null>((key) => {
        switch (key) {
          case "business_id":
            return {
              key,
              title: "No active company selected",
              detail: "Pick a company from the company switcher before opening POS.",
              severity: "blocking",
            };
          case "branch_id":
            return {
              key,
              title: "No active branch selected",
              detail: "Pick a branch from the branch switcher to use POS at a location.",
              severity: "blocking",
            };
          case "business_not_found":
            return {
              key,
              title: "Active company is invalid",
              detail: "The selected company can't be found. Switch to another company.",
              severity: "blocking",
            };
          case "register":
            return {
              key,
              title: `No active POS register${branchLabel}`,
              detail:
                "A register is the cash drawer / terminal a cashier opens a shift on. Add at least one register tied to this branch.",
              severity: "blocking",
              cta: { label: "Add register", href: posSettings("registers") },
            };
          case "warehouse":
            return {
              key,
              title: `No active warehouse${branchLabel}`,
              detail:
                "POS sales draw stock from a warehouse linked to the selling branch. Create or activate one to avoid checkout failures.",
              severity: "blocking",
              cta: { label: "Manage warehouses", href: "/inventory/warehouses" },
            };
          case "branch_warehouse":
            return {
              key,
              title: "Some branches have a register but no warehouse",
              detail:
                "Every branch that has a POS register must have at least one active warehouse. POS sales would fail at checkout for the affected branches.",
              severity: "blocking",
              cta: { label: "Open warehouses", href: "/inventory/warehouses" },
            };
          case "payment_methods":
            return {
              key,
              title: "No POS payment methods are enabled",
              detail:
                "Enable at least one payment method (Cash, Card, Mobile Money, Bank Transfer) for this company.",
              severity: "blocking",
              cta: { label: "Enable payment methods", href: posSettings("payments") },
            };
          case "payment_method_gl_mapping": {
            const total = methodStats?.total ?? 0;
            const unmapped = methodStats?.unmapped ?? 0;
            const namesPreview = (methodStats?.unmappedNames ?? [])
              .slice(0, 3)
              .join(", ");
            const detail =
              total > 0
                ? `${unmapped} of ${total} enabled method${
                    total === 1 ? "" : "s"
                  } have no GL account on the row${
                    namesPreview ? `: ${namesPreview}${unmapped > 3 ? "…" : ""}` : ""
                  }. The accounts shown in Default Accounts are templates — each enabled POS method also needs an account on the row itself.`
                : "Enabled payment methods need a GL account on the row (debit or clearing) so the journal entry posts correctly.";
            return {
              key,
              title: "Payment methods have no GL account",
              detail,
              severity: "blocking",
              cta: { label: "Open payment methods", href: posSettings("payments") },
              secondary: {
                label: applyingDefaults ? "Applying…" : "Apply default GL mappings",
                onClick: applyDefaultMethodGL,
                loading: applyingDefaults,
              },
            };
          }
          case "cashier":
            return {
              key,
              title: `No active cashier assigned${branchLabel}`,
              detail:
                "Assign at least one user as a cashier on this branch. Cashiers open shifts and process sales.",
              severity: "blocking",
              cta: { label: "Manage cashiers", href: posSettings("cashiers") },
            };
          case "revenue_account":
            return {
              key,
              title: "POS revenue account not mapped",
              detail:
                "Set the 'POS Revenue Account' in Finance Settings (or fall back to 'Sales Revenue') so POS sales credit the right revenue line.",
              severity: "blocking",
              cta: {
                label: "Open Finance Settings",
                href: "/finance/settings#pos-accounts",
              },
            };
          case "cash_account":
            return {
              key,
              title: "POS cash account not mapped",
              detail:
                "Set the 'POS Cash Account' in Finance Settings (or fall back to 'Cash') so cash drops post to the right account.",
              severity: "blocking",
              cta: {
                label: "Open Finance Settings",
                href: "/finance/settings#pos-accounts",
              },
            };
          case "tax_account":
            return {
              key,
              title: "Tax-payable account not mapped",
              detail:
                "Set the 'POS Tax Payable' account in Finance Settings (or fall back to the org-wide 'Tax Payable'). Without it the tax portion of POS sales has nowhere to post.",
              severity: "blocking",
              cta: {
                label: "Open Finance Settings",
                href: "/finance/settings#pos-accounts",
              },
            };
          default:
            return {
              key,
              title: key,
              detail: "Setup incomplete.",
              severity: "recommended",
            };
        }
      })
      .filter((x): x is ItemDescriptor => x !== null);
  }, [data, branchData, currentBranch, methodStats, applyingDefaults]);

  if (isLoading || branchLoading) return null;
  const companyOk = !data || data.ok;
  const branchOk = !branchData || branchData.ok;
  if (companyOk && branchOk) return null;
  if (items.length === 0) return null;

  const blocking = items.filter((i) => i.severity === "blocking");
  const recommended = items.filter((i) => i.severity === "recommended");

  return (
    <Alert variant="destructive" className="border-destructive/40">
      <AlertTriangle className="h-4 w-4" />
      <div className="flex flex-wrap items-center gap-2">
        <AlertTitle className="m-0">
          POS setup needed — {items.length} item{items.length === 1 ? "" : "s"}
        </AlertTitle>
        <Badge variant="outline" className="border-destructive/50 text-destructive">
          {blocking.length} blocking
        </Badge>
        {recommended.length > 0 && (
          <Badge variant="outline">{recommended.length} recommended</Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2"
          onClick={recheck}
          disabled={rechecking}
        >
          {rechecking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span className="ml-1.5 text-xs">Re-check</span>
        </Button>
      </div>
      <AlertDescription className="mt-3">
        <ul className="space-y-3">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex flex-col gap-2 rounded-md border border-destructive/20 bg-background/60 p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{item.title}</span>
                  {item.severity === "recommended" && (
                    <Badge variant="secondary" className="text-[10px]">
                      Recommended
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {item.secondary && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={item.secondary.onClick}
                    disabled={item.secondary.loading}
                  >
                    {item.secondary.loading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wrench className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {item.secondary.label}
                  </Button>
                )}
                {item.cta && (
                  <Button
                    size="sm"
                    onClick={() => navigate(item.cta!.href)}
                  >
                    {item.cta.label}
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Fix items, then click <span className="font-medium">Re-check</span> — resolved items disappear immediately.
        </p>
      </AlertDescription>
    </Alert>
  );
}

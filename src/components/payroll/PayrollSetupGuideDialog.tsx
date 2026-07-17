import { normalizeError } from "@/services/resilience";
import { formatInstallerError, isAlreadyInstalledError } from "@/features/localization/lib/installerError";
/**
 * PayrollSetupGuideDialog
 *
 * Context-aware payroll setup guide. Replaces the silent error-toast pattern
 * when `assert_payroll_ready` returns SETUP_REQUIRED.
 *
 * Behaviour
 *   1. Resolve the workspace country from business → org.
 *   2. Look up published localization packs for that country (never blind-list).
 *   3. Show the missing-items checklist with deep links to fix each item.
 *   4. If a country-matched pack exists, offer one-click install via the
 *      existing `install-localization-pack` edge function. Otherwise offer the
 *      manual path (no auto-install, no fake bank/tax integration).
 *
 * The dialog is purely presentational — the backend `compute-payroll` and
 * `assert_payroll_ready` remain the source of truth.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, Check, Globe, Loader2, Package, Settings,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { adminFrom } from "@/lib/adminClient";
import { NotAuthenticatedError } from "@/integrations/supabase/invokeWithAuth";
import { invokeLocalizationPack } from "@/integrations/supabase/invokeLocalizationPack";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { TenantReadinessGate } from "@/components/onboarding/TenantReadinessGate";

import type { PayrollReadinessBlocker } from "@/hooks/payroll/usePayrollReadiness";

interface PayrollSetupGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string | null;
  businessId: string | null;
  /** Country resolved from business → org. Pass null if unknown. */
  countryCode: string | null;
  countryLabel?: string | null;
  /**
   * Wave 3: structured blockers from `usePayrollReadiness`. Preferred over
   * `reasons`. When provided, each item renders with its DB-owned
   * `remediation_label` + `remediation_link` — no English-string regex.
   */
  blockers?: PayrollReadinessBlocker[];
  /**
   * Legacy free-text reasons (e.g. parsed from edge-function error messages
   * that don't carry rule codes). Used only as a fallback when `blockers` is
   * empty. New callers should pass `blockers`.
   */
  reasons?: string[];
  /** Optional: callback after a successful pack install so caller can retry. */
  onInstalled?: () => void;
}

interface AvailablePack {
  id: string;
  name: string;
  description: string | null;
  version: string;
  country_code: string;
}

/**
 * Wave 3 fallback only — used for free-text reasons that have no
 * `reason_code`/`remediation_link` (e.g. raw edge-function error messages).
 * For structured readiness blockers, the dialog renders `remediation_label`
 * and `remediation_link` from the DB directly.
 */
const FALLBACK_REASON_ACTIONS: { match: RegExp; label: string; to: string }[] = [
  { match: /localization|locale|country|pack/i, label: "Choose localization pack", to: "/settings/company?tab=localization" },
  { match: /salary.*structure|structure/i,      label: "Define salary structure", to: "/hr/payroll/configuration/structures" },
  { match: /statutory|tax|paye|nhif|nssf|sdl/i, label: "Configure statutory rules", to: "/hr/payroll/statutory-rules" },
  { match: /account.*mapping|gl.*account/i,     label: "Map payroll GL accounts", to: "/hr/payroll/configuration/accounts" },
  { match: /contract|active.*contract/i,        label: "Create employee contracts", to: "/hr/employees?needsContract=1" },
  { match: /pay.*schedule|frequency|period/i,   label: "Set pay schedule", to: "/hr/payroll/configuration/schedules" },
];

function resolveFallbackAction(reason: string): { label: string; to: string } {
  for (const rule of FALLBACK_REASON_ACTIONS) if (rule.match.test(reason)) return { label: rule.label, to: rule.to };
  return { label: "Open setup", to: "/hr/payroll/setup" };
}

/** Normalized item — either from a structured blocker or a free-text reason. */
interface GuideItem {
  text: string;
  label: string;
  to: string;
  source: "blocker" | "reason";
}


export function PayrollSetupGuideDialog({
  open, onOpenChange, organizationId, businessId, countryCode, countryLabel,
  blockers, reasons, onInstalled,
}: PayrollSetupGuideDialogProps) {
  const [pack, setPack] = useState<AvailablePack | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const qc = useQueryClient();

  // Only fetch packs when we actually have a country — never blind-list.
  useEffect(() => {
    let cancelled = false;
    if (!open || !countryCode) { setPack(null); return; }
    setPackLoading(true);
    (async () => {
      const { data } = await adminFrom("localization_packs")
        .select("id, name, description, version, country_code")
        .eq("country_code", countryCode)
        .eq("is_active", true)
        .eq("is_published", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) { setPack((data as AvailablePack | null) ?? null); setPackLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [open, countryCode]);

  // Wave 3: prefer structured readiness blockers over free-text reasons.
  // Each blocker carries `remediation_label` + `remediation_link` straight from
  // the rules table, so the dialog never needs to regex English strings.
  const items = useMemo<GuideItem[]>(() => {
    if (blockers && blockers.length) {
      return blockers.map<GuideItem>((b) => ({
        text: b.reason || b.rule_name,
        label: b.remediation_label || "Open setup",
        to: b.remediation_link || "/hr/payroll/setup",
        source: "blocker",
      }));
    }
    const list = reasons && reasons.length ? reasons : ["Payroll configuration is incomplete."];
    return list.map<GuideItem>((r) => {
      const a = resolveFallbackAction(r);
      return { text: r, label: a.label, to: a.to, source: "reason" };
    });
  }, [blockers, reasons]);


  const handleInstall = async (force = false) => {
    if (!pack || !organizationId) return;
    setInstalling(true);
    try {
      const { data, error } = await invokeLocalizationPack("install-localization-pack", {
        organization_id: organizationId,
        pack_id: pack.id,
        business_id: businessId ?? undefined,
        force_reseed: force,
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      // Wave 1C: trigger a fresh evaluation in the new readiness layer
      // (replaces the legacy refresh_payroll_setup_status / app_setup_status
      // pathway, which fails open on a brand-new org).
      if (organizationId) {
        try {
          await supabase.rpc("evaluate_payroll_readiness", {
            p_org_id: organizationId,
            p_business_id: businessId ?? null,
            p_scope: "org",
            p_subject_ids: null,
          });
        } catch { /* non-fatal — gate will refresh on next render */ }
      }
      // Invalidate every cache that may show stale "missing" state.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["payroll-statutory-rules-admin"] }),
        qc.invalidateQueries({ queryKey: ["payroll-statutory-rules"] }),
        qc.invalidateQueries({ queryKey: ["payroll-setup-pack"] }),
        qc.invalidateQueries({ queryKey: ["payroll-setup-coverage"] }),
        qc.invalidateQueries({ queryKey: ["payroll-readiness"] }),
        qc.invalidateQueries({ queryKey: ["payroll-readiness-blockers"] }),
        qc.invalidateQueries({ queryKey: ["payroll-readiness-findings"] }),
        qc.invalidateQueries({ queryKey: ["installed-localization-packs"] }),
      ]);
      const alreadyInstalled = (data as any)?.already_installed;
      if (alreadyInstalled && !force) {
        toast.info((data as any)?.message || "Already installed — click Reseed to re-apply templates.");
      } else {
        toast.success((data as any)?.message || `${pack.name} ${force ? "reseeded" : "installed"}`);
      }
      onInstalled?.();
      onOpenChange(false);
    } catch (err: any) {
      const { title, description } = formatInstallerError(err, normalizeError(err).message);
      if (isAlreadyInstalledError(err)) {
        // Pack already installed — treat as info, refresh the surrounding
        // queries and close the dialog so the UI reflects reality.
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["payroll-setup-pack"] }),
          qc.invalidateQueries({ queryKey: ["installed-localization-packs"] }),
          qc.invalidateQueries({ queryKey: ["payroll-readiness"] }),
          qc.invalidateQueries({ queryKey: ["payroll-readiness-blockers"] }),
          qc.invalidateQueries({ queryKey: ["payroll-readiness-findings"] }),
        ]);
        toast.info(title, { description });
        onInstalled?.();
        onOpenChange(false);
      } else {
        toast.error(title, { description });
      }
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Payroll setup required
          </DialogTitle>
          <DialogDescription>
            {countryLabel || countryCode
              ? <>Finish setup for this workspace ({countryLabel || countryCode}) before running payroll.</>
              : <>Finish setup before running payroll. We couldn’t detect your workspace country — set it on the company to unlock localization packs.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Missing items
          </div>
          {items.map((item, idx) => (
            <div key={`${item.text}-${idx}`} className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span>{item.text}</span>
              </div>
              <Button size="sm" variant="outline" asChild onClick={() => onOpenChange(false)}>
                <Link to={item.to}>{item.label}<ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
              </Button>
            </div>
          ))}

        </div>

        <Separator />

        <div className="space-y-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Localization
          </div>

          {!countryCode ? (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <Globe className="mr-2 inline h-4 w-4" />
              Set your company country first to see matching localization packs.
              <Button size="sm" variant="link" asChild className="px-1">
                <Link to="/settings/company" onClick={() => onOpenChange(false)}>Open Company settings</Link>
              </Button>
            </div>
          ) : packLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Looking up packs for {countryLabel || countryCode}…
            </div>
          ) : pack ? (
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-primary" />
                    <span className="font-medium">{pack.name}</span>
                    <Badge variant="outline">v{pack.version}</Badge>
                  </div>
                  {pack.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{pack.description}</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Installs the country’s salary structures, statutory rules, and suggested account mappings. You can edit everything afterwards.
                  </p>
                </div>
              </div>
              <TenantReadinessGate compact>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button onClick={() => handleInstall(false)} disabled={installing} className="flex-1">
                    {installing ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Working…</>
                                : <><Check className="mr-2 h-4 w-4" />Install {pack.name}</>}
                  </Button>
                  <Button onClick={() => handleInstall(true)} disabled={installing} variant="outline">
                    Reseed
                  </Button>
                </div>
              </TenantReadinessGate>
              <p className="text-xs text-muted-foreground">
                Already installed but rules are missing? Use Reseed to re-apply the pack's templates (safe — duplicates are skipped).
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <Globe className="mr-2 inline h-4 w-4" />
              No localization pack is available for {countryLabel || countryCode} yet. Configure salary structures and statutory rules manually, or use the generic engine (gross → net based on your salary structure with no statutory deductions).
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" asChild onClick={() => onOpenChange(false)}>
            <Link to="/hr/payroll/setup"><Settings className="mr-2 h-4 w-4" />Open Payroll Setup</Link>
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

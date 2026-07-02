import { normalizeError } from "@/services/resilience";
/**
 * PayrollSetupPage — guided onboarding for a payroll-ready company.
 *
 * Three operational steps a payroll officer must complete before the first
 * payroll run, surfaced as a single page so nothing is hidden:
 *
 *   1. Install localization pack (statutory rules, payslip labels) for the
 *      Company's country — uses the `install-localization-pack` edge fn.
 *   2. Seed payroll periods for the current year (RPC
 *      `generate_payroll_periods`).
 *   3. GL account coverage — reads `preflight_payroll_account_coverage`
 *      and lists every mapping key the engine + GL poster will require,
 *      with quick links to the mapping screen for any that are missing.
 *
 * No business logic lives here — every action delegates to an existing
 * server-side primitive. This is pure orchestration UI.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { CheckCircle2, AlertCircle, Loader2, ExternalLink, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { invokeWithAuth, NotAuthenticatedError } from "@/integrations/supabase/invokeWithAuth";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { TenantReadinessGate } from "@/components/onboarding/TenantReadinessGate";
import { toast } from "sonner";
import { formatInstallerError, isAlreadyInstalledError } from "@/features/localization/lib/installerError";
import { EmployerStatutoryIdentifiersCard } from "@/components/payroll/EmployerStatutoryIdentifiersCard";
import { PayslipDisplayPreferencesCard } from "@/components/payroll/PayslipDisplayPreferencesCard";

interface CoveragePreflight {
  ok: boolean;
  required_keys: string[];
  existing_keys: string[];
  missing_keys: string[];
}

function StatusPill({ ok, pending }: { ok: boolean; pending?: boolean }) {
  if (pending) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking…
      </Badge>
    );
  }
  return ok ? (
    <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600">
      <CheckCircle2 className="h-3 w-3" /> Ready
    </Badge>
  ) : (
    <Badge variant="destructive" className="gap-1">
      <AlertCircle className="h-3 w-3" /> Action needed
    </Badge>
  );
}

export function PayrollSetupPage() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const canManage = can("managePayroll");

  // Auto-mapping summary surfaced from the last install/reseed call so the
  // user can see exactly what failed and retry without reseeding rules.
  const [autoMap, setAutoMap] = useState<{ applied: number; created: number; errors: string[] } | null>(null);

  // ── Step 1: localization pack
  const packQuery = useQuery({
    queryKey: ["payroll-setup-pack", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const [installed, available] = await Promise.all([
        supabase
          .from("installed_localization_packs")
          .select("id, status, installed_at, pack_id")
          .eq("business_id", currentBusiness!.id)
          .maybeSingle(),
        supabase
          .from("localization_packs")
          .select("id, country_code, name")
          .eq("country_code", (currentBusiness as any)?.country || "")
          .eq("is_active", true)
          .eq("is_published", true)
          .maybeSingle(),
      ]);
      return {
        installed: installed.data,
        available: available.data,
        countryCode: (currentBusiness as any)?.country || null,
      };
    },
  });

  const installPack = useMutation({
    mutationFn: async (opts?: { force?: boolean }) => {
      const { data, error } = await invokeWithAuth("install-localization-pack", {
        body: {
          business_id: currentBusiness!.id,
          country_code: packQuery.data?.countryCode,
          auto_install: true,
          force_reseed: !!opts?.force,
        },
      });
      if (error) throw error;
      // Surface auto-mapping summary even on partial-failure (success:false)
      // so the UI shows the per-key errors instead of just a toast.
      const auto = (data as any)?.summary?.gl_mappings_auto;
      if (auto) {
        setAutoMap({
          applied: Number(auto.applied_existing ?? 0),
          created: Number(auto.created_new ?? 0),
          errors: Array.isArray(auto.errors) ? auto.errors : [],
        });
      } else {
        setAutoMap(null);
      }
      if ((data as any)?.error || (data as any)?.success === false) {
        throw new Error((data as any).error || "Install partially failed");
      }
      return data;
    },
    onSuccess: (data: any) => {
      if (data?.skipped) {
        toast.info("No localization pack available for this country — generic engine will be used.");
      } else {
        toast.success(data?.message || "Localization pack installed");
      }
      qc.invalidateQueries({ queryKey: ["payroll-setup-pack"] });
      qc.invalidateQueries({ queryKey: ["payroll-setup-coverage"] });
      qc.invalidateQueries({ queryKey: ["payroll-setup-periods"] });
      qc.invalidateQueries({ queryKey: ["payroll-statutory-rules-admin"] });
      qc.invalidateQueries({ queryKey: ["payroll-statutory-rules"] });
      // Phase 4: payroll readiness, account mappings, app setup status all
      // change after auto-mapping; invalidate so every consumer re-reads.
      qc.invalidateQueries({ queryKey: ["payroll-gl-readiness"] });
      qc.invalidateQueries({ queryKey: ["payroll-account-mappings"] });
      qc.invalidateQueries({ queryKey: ["app-setup-status"] });
    },
    onError: (e: unknown) => {
      // Even when install partial-fails, invalidate so the UI reflects the
      // half-installed state (status, periods, coverage, readiness).
      qc.invalidateQueries({ queryKey: ["payroll-setup-pack"] });
      qc.invalidateQueries({ queryKey: ["payroll-setup-coverage"] });
      qc.invalidateQueries({ queryKey: ["payroll-gl-readiness"] });
      qc.invalidateQueries({ queryKey: ["payroll-account-mappings"] });
      qc.invalidateQueries({ queryKey: ["app-setup-status"] });
      if (e instanceof NotAuthenticatedError) {
        toast.error("Your session expired. Please sign in again.");
      } else if (isAlreadyInstalledError(e)) {
        // Duplicate install — pack is already in place. Surface as info and
        // let the refreshed queries flip the UI into the installed state.
        const { title, description } = formatInstallerError(e);
        toast.info(title, { description });
      } else {
        const { title, description } = formatInstallerError(e, normalizeError(e).message);
        toast.error(title, { description });
      }
    },
  });

  // ── Step 2: payroll periods
  const periodsQuery = useQuery({
    queryKey: ["payroll-setup-periods", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const year = new Date().getFullYear();
      const { count } = await supabase
        .from("payroll_periods")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", currentOrg!.id)
        .gte("start_date", `${year}-01-01`)
        .lte("start_date", `${year}-12-31`);
      return { year, count: count ?? 0 };
    },
  });

  const seedPeriods = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("generate_payroll_periods", {
        p_org_id: currentOrg!.id,
        p_business_id: currentBusiness?.id || null,
        p_year: new Date().getFullYear(),
        p_period_type: "monthly",
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Payroll periods generated");
      qc.invalidateQueries({ queryKey: ["payroll-setup-periods"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message || "Could not generate periods"),
  });

  // ── Step 3: GL account coverage
  const coverageQuery = useQuery({
    queryKey: ["payroll-setup-coverage", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id,
    queryFn: async (): Promise<CoveragePreflight> => {
      const { data, error } = await supabase.rpc("preflight_payroll_account_coverage", {
        p_org_id: currentOrg!.id,
        p_business_id: currentBusiness?.id || null,
      });
      if (error) throw error;
      return data as unknown as CoveragePreflight;
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Payroll Setup</h1>
        <p className="text-sm text-muted-foreground">
          Three checks every Company must complete before its first payroll run. Re-run any time configuration changes.
        </p>
      </div>

      {/* Country-code prerequisite — without it, step 1 is silently dead. */}
      {!packQuery.isLoading && !packQuery.data?.countryCode && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
          <div className="flex-1">
            <div className="font-medium">Set the company's country first</div>
            <p className="text-muted-foreground">
              Localization packs are matched by country code. Without one, generic payroll runs but no statutory rules will be auto-installed.
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to="/settings/company?tab=company">Open Company Settings</Link>
          </Button>
        </div>
      )}

      {/* Step 1 */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">1. Localization Pack</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Country-specific statutory rules, payslip labels, and account templates. Generic mode is fine if no pack exists for your country.
            </p>
          </div>
          <StatusPill
            pending={packQuery.isLoading}
            ok={!!packQuery.data?.installed || !packQuery.data?.available}
          />
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>Country: <Badge variant="outline">{packQuery.data?.countryCode || "—"}</Badge></div>
          <div>Available pack: {packQuery.data?.available?.name || <span className="text-muted-foreground">none for this country (generic engine will be used)</span>}</div>
          <div>Installed: {packQuery.data?.installed ? (
            <Badge>{packQuery.data.installed.status}</Badge>
          ) : (
            <span className="text-muted-foreground">not installed</span>
          )}</div>
          {canManage && packQuery.data?.available && (
            <TenantReadinessGate compact>
              {!packQuery.data.installed ? (
                <Button
                  size="sm"
                  onClick={() => installPack.mutate({ force: false })}
                  disabled={installPack.isPending}
                >
                  {installPack.isPending ? "Installing…" : `Install ${packQuery.data.available.name}`}
                </Button>
              ) : (
                <div className="space-y-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => installPack.mutate({ force: true })}
                    disabled={installPack.isPending}
                  >
                    {installPack.isPending ? "Reseeding…" : "Reseed templates"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Re-applies the pack's accounts, taxes and statutory rules from the latest published version. Existing rows are kept; only missing ones are added. Use after the pack publisher ships a fix.
                  </p>
                </div>
              )}
            </TenantReadinessGate>
          )}

          {/* Phase 4: surface auto-mapping summary + errors so the user can
              see exactly which keys did not auto-create and retry. */}
          {autoMap && (autoMap.applied + autoMap.created > 0 || autoMap.errors.length > 0) && (
            <div className={
              "rounded-md border p-3 text-sm " +
              (autoMap.errors.length > 0
                ? "border-amber-500/40 bg-amber-500/10"
                : "border-emerald-500/40 bg-emerald-500/10")
            }>
              <div className="font-medium">
                Auto-mapping summary: {autoMap.applied} existing applied · {autoMap.created} new account(s) created
                {autoMap.errors.length > 0 && ` · ${autoMap.errors.length} error(s)`}
              </div>
              {autoMap.errors.length > 0 && (
                <>
                  <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground space-y-1">
                    {autoMap.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}
                    {autoMap.errors.length > 8 && <li>…and {autoMap.errors.length - 8} more</li>}
                  </ul>
                  {canManage && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => installPack.mutate({ force: true })}
                      disabled={installPack.isPending}
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      {installPack.isPending ? "Retrying…" : "Retry auto-map"}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Step 2 */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">2. Payroll Periods</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Pre-generate the year's pay periods so payroll runs can be tied to a fixed schedule.
            </p>
          </div>
          <StatusPill
            pending={periodsQuery.isLoading}
            ok={(periodsQuery.data?.count ?? 0) >= 12}
          />
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>{periodsQuery.data?.count ?? 0} period(s) configured for {periodsQuery.data?.year}.</div>
          {canManage && (periodsQuery.data?.count ?? 0) < 12 && (
            <Button
              size="sm"
              onClick={() => seedPeriods.mutate()}
              disabled={seedPeriods.isPending}
            >
              {seedPeriods.isPending ? "Generating…" : `Generate monthly periods for ${periodsQuery.data?.year ?? new Date().getFullYear()}`}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Step 3 */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">3. GL Account Coverage</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Every active statutory rule and salary-component deduction needs a payable (and an expense for employer contributions). Posting to the ledger is blocked if any are missing.
            </p>
          </div>
          <StatusPill
            pending={coverageQuery.isLoading}
            ok={!!coverageQuery.data?.ok}
          />
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Stat label="Required" value={coverageQuery.data?.required_keys.length ?? 0} />
            <Stat label="Mapped" value={coverageQuery.data?.existing_keys.length ?? 0} />
            <Stat label="Missing" value={coverageQuery.data?.missing_keys.length ?? 0} tone={coverageQuery.data?.missing_keys.length ? "destructive" : "ok"} />
          </div>
          {coverageQuery.data && coverageQuery.data.missing_keys.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <div className="text-sm font-medium mb-2">Missing mapping keys</div>
              <div className="flex flex-wrap gap-1">
                {coverageQuery.data.missing_keys.map((k) => (
                  <Badge key={k} variant="destructive" className="font-mono text-xs">{k}</Badge>
                ))}
              </div>
            </div>
          )}
          <Button asChild size="sm" variant="outline">
            <Link to="/hr/payroll/configuration/accounts" className="gap-1">
              Open GL Account Mapping <ExternalLink className="h-3 w-3" />
            </Link>
          </Button>
          {coverageQuery.data && coverageQuery.data.missing_keys.length > 0 && packQuery.data?.installed && (
            <p className="text-xs text-muted-foreground">
              The installed localization pack ships account templates — the mapping screen will pre-suggest matches when you open a missing key.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Step 4 — Employer Statutory Identifiers (pack-driven) */}
      <EmployerStatutoryIdentifiersCard />

      {/* Step 5 — Payslip display preferences (visibility of the IDs above) */}
      <PayslipDisplayPreferencesCard />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "destructive" }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${tone === "destructive" ? "text-destructive" : tone === "ok" ? "text-emerald-600" : ""}`}>{value}</div>
    </div>
  );
}

export default PayrollSetupPage;

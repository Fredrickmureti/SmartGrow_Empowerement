/**
 * ReportContext — auto-injects organization, business, currency, and company
 * name into every report ExportConfig produced by a report page.
 *
 * Why: previously each report page had to remember to pass
 *   organizationId: currentOrg?.id
 *   companyName: currentOrg?.name
 *   currency: baseCurrency
 * If a developer forgot, the PDF silently rendered without branding.
 *
 * With this provider mounted (by ReportsLayout), `useReportExportContext()`
 * returns the canonical render-context, and `enrichExportConfig(config)`
 * merges it into any ExportConfig the page produces — without the page
 * having to know about it.
 *
 * This is Stage 5 / Phase E of the unified reporting engine plan.
 */

import { createContext, useContext, useCallback, useMemo, ReactNode } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import type { ExportConfig } from "@/services/reports/ReportExportService";

export interface ReportRenderContext {
  organizationId?: string;
  businessId?: string;
  companyName?: string;
  currency?: string;
  /**
   * Business (legal entity) logo. Reports print the entity's logo, so the
   * on-screen masthead resolves it from the SAME record the server-side
   * branding resolver reads (`businesses.logo_url`).
   */
  logoUrl?: string | null;
  /** Active branch, or null when consolidated. */
  branchId?: string | null;
  /**
   * Masthead scope line ("All branches" / "Nairobi Branch (HQ)") —
   * identical to the server derivation.
   */
  scopeLabel?: string;
}

interface ReportContextValue extends ReportRenderContext {
  /**
   * Merge canonical render-context (organizationId, businessId, branchId,
   * companyName, currency) into a page-supplied ExportConfig. Accepts
   * either a full config or a partial — the typical usage is to spread it
   * inside an object literal:
   *
   *   getExportConfig={() => ({
   *     title: "Headcount Report",
   *     reportType: "headcount",
   *     columns: [...],
   *     rows: [...],
   *     ...enrichExportConfig({}),   // injects identity + scope
   *   })}
   *
   * Pages MUST NOT pass `companyName` / `organizationId` / `businessId`
   * themselves — identity is owned by this context. They MAY pass `branchId`
   * when the report's own filter is authoritative; an explicit null means
   * "All branches" and must survive the merge.
   */
  enrichExportConfig: <T extends Partial<ExportConfig>>(config: T) => T & {
    organizationId?: string;
    businessId?: string;
    branchId?: string | null;
    companyName?: string;
    currency?: string;
  };
}


const ReportContext = createContext<ReportContextValue | null>(null);

export function ReportContextProvider({ children }: { children: ReactNode }) {
  const { currentOrg } = useOrganization();
  const { baseCurrency } = useCurrencyContext();
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();

  const ctx: ReportRenderContext = useMemo(
    () => ({
      organizationId: currentOrg?.id,
      businessId: currentBusiness?.id,
      companyName: currentBusiness?.legal_name ?? currentBusiness?.name,
      currency: currentBusiness?.base_currency ?? baseCurrency,
      logoUrl: currentBusiness?.logo_url ?? null,
      branchId: scope.branchId,
      scopeLabel: scope.reportScopeLabel,
    }),
    [
      currentOrg?.id,
      currentBusiness?.id,
      currentBusiness?.name,
      currentBusiness?.legal_name,
      currentBusiness?.logo_url,
      currentBusiness?.base_currency,
      baseCurrency,
      scope.branchId,
      scope.reportScopeLabel,
    ],
  );

  const enrichExportConfig = useCallback(
    <T extends Partial<ExportConfig>>(config: T) => ({
      ...config,
      organizationId: ctx.organizationId ?? config.organizationId,
      businessId: ctx.businessId ?? config.businessId,
      // Branch is scope, not branding: a report-local branch wins over the
      // ambient navigation branch. Preserve explicit null ("All branches") —
      // nullish fallback used to turn that deliberate consolidated scope back
      // into whichever branch the global switcher happened to hold.
      branchId: config.branchId !== undefined ? config.branchId : ctx.branchId ?? null,
      companyName: ctx.companyName ?? config.companyName,
      currency: ctx.currency ?? config.currency,
    }),
    [ctx],
  );


  return (
    <ReportContext.Provider value={{ ...ctx, enrichExportConfig }}>
      {children}
    </ReportContext.Provider>
  );
}

export function useReportExportContext(): ReportContextValue {
  const ctx = useContext(ReportContext);
  if (ctx) return ctx;
  // Fallback: identity merge so report pages used outside the provider
  // (legacy entry points) keep working.
  return {
    enrichExportConfig: <T extends Partial<ExportConfig>>(config: T) => ({
      ...config,
      organizationId: config.organizationId,
      companyName: config.companyName,
      currency: config.currency,
    }),
  };
}

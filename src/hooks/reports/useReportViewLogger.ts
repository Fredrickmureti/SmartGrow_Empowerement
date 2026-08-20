/**
 * useReportViewLogger — Phase A foundation hook.
 *
 * Logs a single `report_views` row when a report page mounts. Wired into
 * `ReportPageLayout` so EVERY report opened by a user is captured for
 * audit / SOX-style "who saw payroll" questions.
 *
 * Contract:
 *   - Fires once per (reportId, path) the first time the layout mounts.
 *   - Re-fires when the user navigates to a different report (path changes).
 *   - Never blocks rendering — the RPC is fire-and-forget; failures are
 *     logged to console only.
 *   - Anon callers are a no-op on the server (the RPC returns null).
 */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { REPORT_REGISTRY, reportMountPaths } from "@/services/reports/ReportRegistry";

function resolveReportFromPath(pathname: string): { id: string; reportType: string } | null {
  // Strip query/hash for matching; the registry path may include `?view=...`.
  const cleanPath = pathname.split("?")[0].split("#")[0];
  // Prefer exact match, otherwise the most specific registry path that is a
  // prefix of the current pathname (so /finance/reports/financial matches
  // both ?view=pnl and ?view=balance_sheet via shared id).
  // Dual-hosted reports (ADR 0143) match on any of their mount paths.
  const exact = REPORT_REGISTRY.find(r => reportMountPaths(r).includes(cleanPath));
  if (exact) return { id: exact.id, reportType: exact.reportType };

  const prefixMatches = REPORT_REGISTRY
    .map(r => ({
      r,
      len: Math.max(
        ...reportMountPaths(r).map(b => (cleanPath.startsWith(b) ? b.length : 0)),
      ),
    }))
    .filter(m => m.len > 0)
    .sort((a, b) => b.len - a.len)
    .map(m => m.r);
  if (prefixMatches[0]) {
    return { id: prefixMatches[0].id, reportType: prefixMatches[0].reportType };
  }
  return null;
}

export function useReportViewLogger(explicitReportId?: string) {
  const { pathname, search } = useLocation();
  const loggedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const resolved = explicitReportId
      ? { id: explicitReportId, reportType: explicitReportId }
      : resolveReportFromPath(pathname);
    if (!resolved) return;

    const key = `${resolved.id}::${pathname}${search}`;
    if (loggedKeyRef.current === key) return;
    loggedKeyRef.current = key;

    // Parse search params into a plain object for the params jsonb column.
    const params: Record<string, string> = {};
    new URLSearchParams(search).forEach((v, k) => { params[k] = v; });

    // Fire-and-forget; never await, never throw.
    void supabase.rpc("log_report_view", {
      p_report_id: resolved.id,
      p_report_type: resolved.reportType,
      p_path: `${pathname}${search}`,
      p_params: params,
    }).then(({ error }) => {
      if (error && process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[useReportViewLogger] failed", error.message);
      }
    });
  }, [pathname, search, explicitReportId]);
}

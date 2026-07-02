/**
 * useScopedQuery — defensive rail to prevent unscoped Supabase reads on
 * company-scoped tables.
 *
 * Most data in this ERP is scoped by BOTH `organization_id` (the tenant /
 * workspace) AND `business_id` (the legal company within that workspace).
 * Forgetting either filter has caused real production incidents (cross-
 * company contamination, PGRST116 from `.maybeSingle()` matching multiple
 * rows, suspended orgs writing data, etc.).
 *
 * This helper centralizes the scope-resolution + filter-application step so
 * call sites can't silently drift. It is ADVISORY — the architecture guard
 * test (`src/test/architecture/business-scoped-queries.test.ts`) is what
 * actually fails the build on regressions. Use this helper for new code so
 * you never have to remember the dual-filter dance.
 *
 * Usage:
 *   const scoped = useScopedFrom();
 *   const { data } = await scoped("invoices").select("*");
 *   // → automatically becomes:
 *   //   .from("invoices").select("*")
 *   //     .eq("organization_id", currentOrg.id)
 *   //     .eq("business_id",     currentBusiness.id)
 *
 * For tables that are workspace-wide (no business_id), use:
 *   scoped("approval_workflows", { businessScoped: false })
 *
 * For shared-COA reads where rows may be company-scoped OR null
 * (e.g. default chart of accounts), use the standard `.or(...)` pattern
 * directly — that is intentionally not modeled here.
 */
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { requireBusinessId } from "@/lib/businessScopedQuery";

interface ScopedFromOptions {
  /** Default true. Set false for workspace-wide tables (e.g. approval_workflows). */
  businessScoped?: boolean;
}

export function useScopedFrom() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useMemo(
    () =>
      <T extends string>(table: T, opts: ScopedFromOptions = {}) => {
        const { businessScoped = true } = opts;
        if (!currentOrg?.id) {
          throw new Error(
            `useScopedFrom("${table}"): no active organization. ` +
              "Ensure the page is mounted inside an authenticated workspace.",
          );
        }
        if (businessScoped) {
          requireBusinessId(currentBusiness?.id, `useScopedFrom("${table}")`);
        }

        // Wrap the supabase builder so .select/.insert/.update/.delete all
        // get the right filters applied.
        const base = (supabase as any).from(table);
        const apply = <Q,>(q: Q): Q => {
          let chain: any = (q as any).eq("organization_id", currentOrg.id);
          if (businessScoped) {
            chain = chain.eq("business_id", currentBusiness!.id);
          }
          return chain as Q;
        };

        return {
          select: (...args: any[]) => apply(base.select(...args)),
          update: (values: any) => apply(base.update(values)),
          delete: () => apply(base.delete()),
          // Inserts: stamp the scope onto the payload(s). Caller may override.
          insert: (values: any) => {
            const stamp = (row: any) => ({
              organization_id: currentOrg.id,
              ...(businessScoped ? { business_id: currentBusiness!.id } : {}),
              ...row,
            });
            const payload = Array.isArray(values) ? values.map(stamp) : stamp(values);
            return base.insert(payload);
          },
          upsert: (values: any, options?: any) => {
            const stamp = (row: any) => ({
              organization_id: currentOrg.id,
              ...(businessScoped ? { business_id: currentBusiness!.id } : {}),
              ...row,
            });
            const payload = Array.isArray(values) ? values.map(stamp) : stamp(values);
            return base.upsert(payload, options);
          },
        };
      },
    [currentOrg?.id, currentBusiness?.id],
  );
}

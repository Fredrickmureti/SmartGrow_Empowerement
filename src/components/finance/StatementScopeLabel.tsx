/**
 * StatementScopeLabel — renders the issuing scope of a customer statement
 * ("Acme Ltd · Nairobi Branch" or "Acme Ltd · All Branches").
 *
 * Phase 5 of the Finance audit: every statement PDF / preview MUST display
 * the scope it was generated from so a printed/emailed statement can never
 * be mistaken for an HQ-wide document when it was in fact a branch-only
 * statement (or vice versa).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface StatementScopeLabelProps {
  businessId: string | null;
  branchId: string | null;
  className?: string;
}

export function StatementScopeLabel({
  businessId,
  branchId,
  className,
}: StatementScopeLabelProps) {
  const { data } = useQuery({
    queryKey: ["statement-scope-label", businessId, branchId],
    enabled: !!businessId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!businessId) return null;
      const [biz, branch] = await Promise.all([
        supabase.from("businesses").select("name").eq("id", businessId).maybeSingle(),
        branchId
          ? supabase
              .from("branches")
              .select("name, is_headquarters")
              .eq("id", branchId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null } as const),
      ]);
      return {
        businessName: biz.data?.name ?? "Business",
        branchName: branch.data?.name ?? null,
        isHq: !!branch.data?.is_headquarters,
      };
    },
  });

  if (!businessId || !data) return null;
  const branchSegment = data.branchName
    ? `${data.branchName}${data.isHq ? " (HQ)" : ""}`
    : "All Branches";
  return (
    <p className={className ?? "text-[11px] uppercase tracking-wider text-muted-foreground mt-1"}>
      Scope: {data.businessName} · {branchSegment}
    </p>
  );
}

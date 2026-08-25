import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { GitBranch } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

/**
 * Renders an "Originated from lead" badge that deep-links back to the CRM.
 *
 * Accepts any of three inputs (first non-null wins):
 *   - `leadId`            — caller already knows the lead id.
 *   - `viaSalesOrderId`   — look up `sales_orders.source_lead_id`.
 *   - `viaEstimateId`     — look up `estimates.source_lead_id`.
 *
 * Renders nothing when no source lead can be resolved or while loading.
 * Read-only: one tiny SELECT per dialog open.
 */
interface OriginatedFromLeadBadgeProps {
  leadId?: string | null;
  viaSalesOrderId?: string | null;
  viaEstimateId?: string | null;
  className?: string;
}

export function OriginatedFromLeadBadge({
  leadId,
  viaSalesOrderId,
  viaEstimateId,
  className,
}: OriginatedFromLeadBadgeProps) {
  const navigate = useNavigate();
  const [resolved, setResolved] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      let targetLeadId: string | null = leadId ?? null;

      if (!targetLeadId && viaSalesOrderId) {
        const { data } = await supabase
          .from("sales_orders")
          .select("source_lead_id")
          .eq("id", viaSalesOrderId)
          .maybeSingle();
        targetLeadId = (data as any)?.source_lead_id ?? null;
      }

      if (!targetLeadId && viaEstimateId) {
        const { data } = await supabase
          .from("estimates")
          .select("source_lead_id")
          .eq("id", viaEstimateId)
          .maybeSingle();
        targetLeadId = (data as any)?.source_lead_id ?? null;
      }

      if (!targetLeadId) {
        if (!cancelled) setResolved(null);
        return;
      }

      const { data: lead } = await supabase
        .from("crm_leads")
        .select("id, name")
        .eq("id", targetLeadId)
        .maybeSingle();

      if (!cancelled) {
        setResolved(lead ? { id: (lead as any).id, name: (lead as any).name } : null);
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [leadId, viaSalesOrderId, viaEstimateId]);

  if (!resolved) return null;

  return (
    <Badge
      variant="outline"
      className={cn(
        "cursor-pointer gap-1 text-xs font-normal hover:bg-accent",
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        navigate(`/crm-app/leads?lead=${resolved.id}`);
      }}
      title="Originated from CRM lead"
    >
      <GitBranch className="h-3 w-3" />
      Lead: {resolved.name}
    </Badge>
  );
}
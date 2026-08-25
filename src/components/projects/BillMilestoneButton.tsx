import { normalizeError } from "@/services/resilience";
/**
 * BillMilestoneButton — small inline action that drafts an invoice for a
 * milestone via the transactional `invoice_project_milestone` RPC, which
 * drafts the invoice and marks the milestone billed in one transaction and
 * refuses to bill an already-invoiced milestone.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Receipt, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PermissionGate } from "@/components/common/PermissionGate";

interface Props {
  milestoneId: string;
  isInvoiced?: boolean;
  hasBillingAmount?: boolean;
  onInvoiced?: () => void;
}

export function BillMilestoneButton({ milestoneId, isInvoiced, hasBillingAmount, onInvoiced }: Props) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  if (!hasBillingAmount) return null;

  const run = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("invoice_project_milestone", {
        _milestone_id: milestoneId,
      } as never);
      if (error) throw error;
      const res = (data ?? {}) as { ok?: boolean; invoice_id?: string; amount?: number; error?: string; reason?: string };
      if (!res.ok) {
        toast.error(res.error || res.reason || "Could not draft invoice");
        return;
      }
      toast.success(`Drafted invoice for milestone`);
      onInvoiced?.();
      if (res.invoice_id) navigate(`/invoices/${res.invoice_id}`);
    } catch (e) {
      toast.error(e instanceof Error ? normalizeError(e).message : "Failed to bill milestone");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PermissionGate permission="manageProjectFinancials" fallback={null}>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={busy || isInvoiced}
        onClick={(e) => { e.stopPropagation(); run(); }}
        title={isInvoiced ? "Already invoiced" : "Draft invoice for this milestone"}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Receipt className="h-3 w-3 mr-1" />}
        {isInvoiced ? "Billed" : "Bill"}
      </Button>
    </PermissionGate>
  );
}
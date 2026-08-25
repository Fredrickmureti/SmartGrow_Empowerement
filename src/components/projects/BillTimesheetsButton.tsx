import { normalizeError } from "@/services/resilience";
/**
 * BillTimesheetsButton — opens a small period picker, invokes the
 * `invoice-project-timesheets` edge function, and navigates to the new
 * draft invoice on success. Permission-gated by `manageProjectFinancials`.
 *
 * Pass 6 — Projects: migrated from `Dialog` to `WorkflowSheet` so the
 * presentation matches the New Payroll Run standard.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { Receipt, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowSheetGrid,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PermissionGate } from "@/components/common/PermissionGate";

interface Props { projectId: string; onInvoiced?: () => void; }

export function BillTimesheetsButton({ projectId, onInvoiced }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastMonth = subMonths(new Date(), 1);
  const [from, setFrom] = useState(format(startOfMonth(lastMonth), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(endOfMonth(lastMonth), "yyyy-MM-dd"));
  const navigate = useNavigate();

  const run = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("invoice_project_timesheets", {
        _project_id: projectId,
        _period_from: from,
        _period_to: to,
      } as never);
      if (error) throw error;
      const res = (data ?? {}) as { ok?: boolean; invoice_id?: string; lines?: number; hours?: number; error?: string; reason?: string };
      if (!res.ok) {
        toast.error(res.error || res.reason || "Nothing to bill in this period");
        return;
      }
      toast.success(`Drafted invoice with ${res.lines} line(s) · ${res.hours} h`);
      setOpen(false);
      onInvoiced?.();
      if (res.invoice_id) navigate(`/invoices/${res.invoice_id}`);
    } catch (e) {
      toast.error(e instanceof Error ? normalizeError(e).message : "Failed to bill timesheets");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PermissionGate permission="manageProjectFinancials" fallback={null}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Receipt className="h-3.5 w-3.5 mr-1" /> Bill timesheets
      </Button>
      <WorkflowSheet
        open={open}
        onOpenChange={(o) => { if (!busy) setOpen(o); }}
        size="md"
        title="Bill approved timesheets"
        description="Drafts a single invoice from approved, billable, un-invoiced timesheets in the selected period. You can review and confirm it before posting."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={run} disabled={busy || !from || !to}>
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Draft invoice
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Billing period">
          <WorkflowSheetGrid>
            <WorkflowField label="From" htmlFor="bt-from" required>
              <Input id="bt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </WorkflowField>
            <WorkflowField label="To" htmlFor="bt-to" required>
              <Input id="bt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </WorkflowSheet>
    </PermissionGate>
  );
}

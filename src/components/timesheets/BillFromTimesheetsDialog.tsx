import { normalizeError } from "@/services/resilience";
/**
 * BillFromTimesheetsDialog — invoice approved, unbilled, billable time.
 *
 * Ownership boundary: this dialog NEVER constructs invoices or prices hours.
 * It previews what the server would bill and then delegates the whole
 * operation to the `invoice_project_timesheets` RPC, which owns rate
 * resolution, invoice numbering, line building and marking the source
 * timesheets as invoiced inside a single transaction (with an advisory lock
 * that makes double-billing impossible).
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useContacts } from "@/hooks/useContacts";
import { isCustomerContact } from "@/services/finance/customerIdentity";
import { toast } from "sonner";

/** Server-side preview of what one project would bill. Display only. */
interface ProjectGroup {
  project_id: string;
  project_name: string;
  entries: number;
  hours: number;
  amount: number;
  from: string;
  to: string;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId?: string | null;
  contactId?: string | null;
  onInvoiced?: (invoiceId: string) => void;
}

export function BillFromTimesheetsDialog({ open, onOpenChange, projectId, contactId, onInvoiced }: Props) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { contacts } = useContacts();

  const customers = useMemo(
    // The enum name is not a property on contacts — see customerIdentity.ts.
    () => (contacts || []).filter((c: any) => isCustomerContact(c)),
    [contacts],
  );

  const [selectedContact, setSelectedContact] = useState<string | null>(contactId ?? null);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [periodFrom, setPeriodFrom] = useState<string>("");
  const [periodTo, setPeriodTo] = useState<string>("");

  useEffect(() => { setSelectedContact(contactId ?? null); }, [contactId]);

  // Preview only: the same filter the RPC applies (approved, billable, not invoiced).
  // Superseded/corrected entries are excluded because they are no longer 'approved'.
  useEffect(() => {
    if (!open) return;
    if (!selectedContact || !currentOrg || !currentBusiness) { setGroups([]); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      let q: any = (supabase as any)
        .from("timesheets")
        .select(`
          id, date, hours, billing_amount, project_id,
          project:projects!inner(id, name, customer_id)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("status", "approved")
        .eq("is_billable", true)
        .eq("is_invoiced", false)
        .eq("project.customer_id", selectedContact);
      if (projectId) q = q.eq("project_id", projectId);
      if (periodFrom) q = q.gte("date", periodFrom);
      if (periodTo) q = q.lte("date", periodTo);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) {
        toast.error(normalizeError(error).message);
        setGroups([]);
      } else {
        const m = new Map<string, ProjectGroup>();
        for (const r of (data || []) as any[]) {
          const g = m.get(r.project_id) || {
            project_id: r.project_id,
            project_name: r.project?.name ?? "Project",
            entries: 0, hours: 0, amount: 0,
            from: r.date, to: r.date,
          };
          g.entries += 1;
          g.hours += Number(r.hours || 0);
          g.amount += Number(r.billing_amount || 0);
          if (r.date < g.from) g.from = r.date;
          if (r.date > g.to) g.to = r.date;
          m.set(r.project_id, g);
        }
        const list = Array.from(m.values());
        setGroups(list);
        setPicked(new Set(list.map((g) => g.project_id)));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, selectedContact, projectId, periodFrom, periodTo, currentOrg?.id, currentBusiness?.id]);

  const selected = useMemo(() => groups.filter((g) => picked.has(g.project_id)), [groups, picked]);
  const total = selected.reduce((s, g) => s + g.amount, 0);
  const pickedEntries = selected.reduce((s, g) => s + g.entries, 0);
  const allPicked = groups.length > 0 && picked.size === groups.length;

  const togglePick = (id: string) => {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const toggleAll = () => {
    setPicked(allPicked ? new Set() : new Set(groups.map((g) => g.project_id)));
  };

  const handleConfirm = async () => {
    if (selected.length === 0) return;
    setSubmitting(true);
    try {
      const created: string[] = [];
      const failures: string[] = [];
      for (const g of selected) {
        const { data, error } = await (supabase as any).rpc("invoice_project_timesheets", {
          _project_id: g.project_id,
          _period_from: periodFrom || g.from,
          _period_to: periodTo || g.to,
        });
        if (error) {
          failures.push(`${g.project_name}: ${normalizeError(error).message}`);
          continue;
        }
        const res: any = data || {};
        if (res.invoice_id) created.push(res.invoice_id);
        else failures.push(`${g.project_name}: ${res.message || "nothing billable"}`);
      }

      if (created.length > 0) {
        toast.success(
          created.length === 1
            ? "Invoice created from approved timesheets."
            : `${created.length} invoices created from approved timesheets.`,
        );
        onInvoiced?.(created[0]);
      }
      if (failures.length > 0) toast.error(failures.join(" · "));
      if (failures.length === 0) onOpenChange(false);
    } catch (e: any) {
      toast.error(normalizeError(e).message || "Failed to invoice timesheets");
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      <div className="mr-auto text-sm">
        {selected.length > 0 ? (
          <span>
            <span className="text-muted-foreground">Estimated total</span>{" "}
            <span className="font-semibold">{total.toFixed(2)}</span>
            <span className="text-muted-foreground"> · {pickedEntries} entries</span>
          </span>
        ) : null}
      </div>
      <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button disabled={submitting || selected.length === 0} onClick={handleConfirm}>
        {submitting ? "Creating…" : `Create invoice${selected.length > 1 ? "s" : ""} (${selected.length})`}
      </Button>
    </>
  );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title="Bill from timesheets"
      description="One invoice per project, built and priced on the server from approved, unbilled hours."
      footer={footer}
    >
      <WorkflowSheetSection number={1} title="Invoice target" subtitle="Who you're invoicing and which period to bill.">
        <WorkflowSheetGrid>
          <WorkflowField label="Customer" required>
            <Select value={selectedContact ?? ""} onValueChange={setSelectedContact}>
              <SelectTrigger><SelectValue placeholder="Pick a customer" /></SelectTrigger>
              <SelectContent>
                {customers.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Period from">
            <Input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
          </WorkflowField>
          <WorkflowField label="Period to">
            <Input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection
        number={2}
        title="Projects to bill"
        subtitle="Approved unbilled hours, grouped by project. Rates and invoice lines are resolved by the server."
        fullWidth
        right={
          groups.length > 0 ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={toggleAll}>
              {allPicked ? "Deselect all" : "Select all"}
            </Button>
          ) : undefined
        }
      >
        <div className="max-h-72 overflow-auto rounded-md border">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !selectedContact ? (
            <p className="text-sm text-muted-foreground p-4">Pick a customer to load billable hours.</p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">No approved unbilled hours for this customer.</p>
          ) : (
            <ul className="divide-y">
              {groups.map((g) => (
                <li key={g.project_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Checkbox checked={picked.has(g.project_id)} onCheckedChange={() => togglePick(g.project_id)} />
                  <span className="flex-1 truncate">{g.project_name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{g.from} → {g.to}</span>
                  <Badge variant="outline">{g.hours}h</Badge>
                  <span className="w-20 text-right tabular-nums">{g.amount.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {groups.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Amounts shown are an estimate from stored billing snapshots. The invoice total is
            computed by the server at the moment of billing.
          </p>
        )}
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}

import { normalizeError } from "@/services/resilience";
/**
 * BillFromTimesheetsDialog — turn approved, unbilled, billable timesheets
 * for a customer into invoice lines.
 *
 * Migrated to the WorkflowSheet pattern (HR design-system Pass 3).
 */
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
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
import { useInvoices } from "@/hooks/useInvoices";
import { toast } from "sonner";

interface Row {
  id: string;
  date: string;
  hours: number;
  billing_rate: number;
  billing_amount: number;
  description: string | null;
  project_id: string;
  project_name: string;
  employee_name: string;
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
  const { createInvoice } = useInvoices();

  const customers = useMemo(
    // The enum name is not a property on contacts — see customerIdentity.ts.
    () => (contacts || []).filter((c: any) => isCustomerContact(c)),
    [contacts],
  );

  const [selectedContact, setSelectedContact] = useState<string | null>(contactId ?? null);
  const [rows, setRows] = useState<Row[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dueDate, setDueDate] = useState(format(new Date(Date.now() + 14 * 86400000), "yyyy-MM-dd"));

  useEffect(() => { setSelectedContact(contactId ?? null); }, [contactId]);

  useEffect(() => {
    if (!open) return;
    if (!selectedContact || !currentOrg || !currentBusiness) { setRows([]); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      let q: any = (supabase as any)
        .from("timesheets")
        .select(`
          id, date, hours, billing_rate, billing_amount, description, project_id,
          project:projects!inner(id, name, customer_id),
          employee:employees(first_name, last_name)
        `)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("status", "approved")
        .eq("is_billable", true)
        .eq("is_invoiced", false)
        .eq("project.customer_id", selectedContact);
      if (projectId) q = q.eq("project_id", projectId);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) {
        toast.error(normalizeError(error).message);
        setRows([]);
      } else {
        const mapped: Row[] = (data || []).map((r: any) => ({
          id: r.id,
          date: r.date,
          hours: Number(r.hours || 0),
          billing_rate: Number(r.billing_rate || 0),
          billing_amount: Number(r.billing_amount || 0),
          description: r.description,
          project_id: r.project_id,
          project_name: r.project?.name ?? "Project",
          employee_name: r.employee ? `${r.employee.first_name} ${r.employee.last_name}` : "Unknown",
        }));
        setRows(mapped);
        setPicked(new Set(mapped.map((m) => m.id)));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, selectedContact, projectId, currentOrg?.id, currentBusiness?.id]);

  const grouped = useMemo(() => {
    const m = new Map<string, { project_id: string; project_name: string; rate: number; hours: number; amount: number; ids: string[] }>();
    for (const r of rows) {
      if (!picked.has(r.id)) continue;
      const g = m.get(r.project_id) || {
        project_id: r.project_id, project_name: r.project_name,
        rate: r.billing_rate, hours: 0, amount: 0, ids: [],
      };
      g.hours += r.hours;
      g.amount += r.billing_amount;
      g.ids.push(r.id);
      m.set(r.project_id, g);
    }
    return Array.from(m.values());
  }, [rows, picked]);

  const total = grouped.reduce((s, g) => s + g.amount, 0);
  const allPicked = rows.length > 0 && picked.size === rows.length;
  const togglePick = (id: string) => {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const toggleAll = () => {
    setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)));
  };

  const handleConfirm = async () => {
    if (!selectedContact || grouped.length === 0) return;
    setSubmitting(true);
    try {
      const items = grouped.map((g) => ({
        description: `${g.project_name} — ${g.hours}h @ ${g.rate}`,
        quantity: g.hours,
        unit_price: g.rate,
        tax_rate: 0,
        tax_amount: 0,
        discount_percent: 0,
        line_total: g.amount,
        product_id: null as any,
      }));
      const inv: any = await createInvoice(
        { contact_id: selectedContact, due_date: dueDate, notes: "Generated from approved timesheets" },
        items as any,
      );
      const allIds = grouped.flatMap((g) => g.ids);
      const { error: markErr } = await (supabase as any).rpc("mark_timesheets_invoiced", {
        _invoice_id: inv.id, _timesheet_ids: allIds,
      });
      if (markErr) throw markErr;
      toast.success(`Invoice created from ${allIds.length} timesheet rows.`);
      onInvoiced?.(inv.id);
      onOpenChange(false);
    } catch (e: any) {
      toast.error(normalizeError(e).message || "Failed to invoice timesheets");
    } finally {
      setSubmitting(false);
    }
  };

  const pickedCount = grouped.reduce((s, g) => s + g.ids.length, 0);

  const footer = (
    <>
      <div className="mr-auto text-sm">
        {grouped.length > 0 ? (
          <span>
            <span className="text-muted-foreground">Total</span>{" "}
            <span className="font-semibold">{total.toFixed(2)}</span>
            <span className="text-muted-foreground"> · {pickedCount} entries</span>
          </span>
        ) : null}
      </div>
      <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button disabled={submitting || grouped.length === 0 || !selectedContact} onClick={handleConfirm}>
        {submitting ? "Creating…" : `Create invoice (${pickedCount})`}
      </Button>
    </>
  );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title="Bill from timesheets"
      description="Create an invoice for approved, unbilled hours. One line per project."
      footer={footer}
    >
      <WorkflowSheetSection number={1} title="Invoice target" subtitle="Who you're invoicing and when it's due.">
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
          <WorkflowField label="Due date">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection
        number={2}
        title="Billable entries"
        subtitle="Pick the approved unbilled hours to include."
        fullWidth
        right={
          rows.length > 0 ? (
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
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">No approved unbilled hours for this customer.</p>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Checkbox checked={picked.has(r.id)} onCheckedChange={() => togglePick(r.id)} />
                  <span className="font-mono text-xs w-24 shrink-0">{r.date}</span>
                  <span className="flex-1 truncate">{r.project_name} — {r.employee_name}</span>
                  <Badge variant="outline">{r.hours}h</Badge>
                  <span className="w-20 text-right tabular-nums">{r.billing_amount.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </WorkflowSheetSection>

      {grouped.length > 0 && (
        <WorkflowSheetSection number={3} title="Summary" subtitle="One invoice line per project." fullWidth>
          <div className="rounded-md border divide-y text-sm">
            {grouped.map((g) => (
              <div key={g.project_id} className="flex justify-between px-3 py-2">
                <span>{g.project_name} · {g.hours}h @ {g.rate}</span>
                <span className="font-medium tabular-nums">{g.amount.toFixed(2)}</span>
              </div>
            ))}
            <div className="flex justify-between px-3 py-2 font-semibold bg-muted/30">
              <span>Total</span>
              <span className="tabular-nums">{total.toFixed(2)}</span>
            </div>
          </div>
        </WorkflowSheetSection>
      )}
    </WorkflowSheet>
  );
}

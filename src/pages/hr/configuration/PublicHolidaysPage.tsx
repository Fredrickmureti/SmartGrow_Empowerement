import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HrConfigFormShell } from "@/components/hr/configuration/_shared/HrConfigFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Loader2, Plus, Trash2, Calendar } from "lucide-react";
import { toast } from "sonner";
import { ConfigPageHeader } from "./_ConfigShell";

export default function PublicHolidaysPage() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());

  const { data: holidays = [], isLoading } = useQuery({
    queryKey: ["public-holidays", currentOrg?.id, year],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const start = `${year}-01-01`, end = `${year}-12-31`;
      const { data, error } = await supabase
        .from("public_holidays").select("*")
        .eq("organization_id", currentOrg.id)
        .gte("holiday_date", start).lte("holiday_date", end)
        .order("holiday_date");
      if (error) throw error;
      return data || [];
    },
    enabled: !!currentOrg?.id,
  });

  const create = useMutation({
    mutationFn: async (input: { name: string; holiday_date: string; country_code: string | null }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { error } = await supabase.from("public_holidays").insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? null,
        ...input,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["public-holidays"] }); toast.success("Holiday added"); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("public_holidays").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["public-holidays"] }),
  });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", holiday_date: "", country_code: "" });

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ConfigPageHeader
        title="Public holidays"
        subtitle="Holidays consumed by Attendance and Leave entitlement calculations. Scope per organization (and optionally per business / country)."
        action={<div className="flex gap-2">
          <Input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="w-24 h-9" aria-label="Year" />
          <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4 mr-1" /> Add</Button>
        </div>}
      />

      {holidays.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No holidays for {year}.</CardContent></Card>
      ) : (
        <div className="space-y-1">
          {holidays.map((h: any) => (
            <Card key={h.id}><CardContent className="p-3 grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">{h.name}</div>
                <div className="text-xs text-muted-foreground">{h.holiday_date}{h.country_code ? ` · ${h.country_code}` : ""}</div>
              </div>
              <span className="text-xs text-muted-foreground">{new Date(h.holiday_date).toLocaleDateString(undefined, { weekday: "short" })}</span>
              <Button variant="ghost" size="icon" onClick={() => { if (confirm("Delete?")) remove.mutate(h.id); }}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </CardContent></Card>
          ))}
        </div>
      )}

      <HrConfigFormShell
        open={adding}
        onOpenChange={setAdding}
        entity="public-holiday"
        busy={create.isPending}
        submitLabel="Add"
        submitDisabled={!form.name || !form.holiday_date}
        onSubmit={async () => {
          await create.mutateAsync({ name: form.name, holiday_date: form.holiday_date, country_code: form.country_code || null });
          setForm({ name: "", holiday_date: "", country_code: "" });
          setAdding(false);
        }}
      >
        <WorkflowSheetSection number={1} title="Holiday details" subtitle="The name and date appear on calendars and attendance reports.">
          <WorkflowSheetGrid>
            <WorkflowField label="Name" required>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Labour Day" />
            </WorkflowField>
            <WorkflowField label="Date" required>
              <Input type="date" value={form.holiday_date} onChange={(e) => setForm((f) => ({ ...f, holiday_date: e.target.value }))} />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Scope" subtitle="Restrict the holiday to a specific country. Leave blank to apply everywhere.">
          <WorkflowField label="Country code">
            <Input maxLength={2} value={form.country_code} onChange={(e) => setForm((f) => ({ ...f, country_code: e.target.value.toUpperCase() }))} placeholder="KE" />
          </WorkflowField>
        </WorkflowSheetSection>
      </HrConfigFormShell>
    </div>
  );
}

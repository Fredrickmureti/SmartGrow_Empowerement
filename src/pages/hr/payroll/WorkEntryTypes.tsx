/**
 * Stage D — Work Entry Types page.
 *
 * Pack-default rows are read-only with an Override action that clones into
 * the tenant scope. Tenant rows are fully editable.
 */
import { useMemo, useState } from "react";
import { Plus, Edit2, Archive, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useWorkEntryTypes, type WorkEntryType, type WorkEntryTypeInput } from "@/hooks/payroll/useWorkEntryTypes";

const EMPTY: WorkEntryTypeInput = {
  code: "",
  name: "",
  color: null,
  is_paid: true,
  is_unpaid_leave: false,
  counts_as_worked: true,
  multiplier_normal: 1,
  multiplier_overtime: 1.5,
  accounting_tag: null,
  sequence: 100,
  is_active: true,
};

export default function WorkEntryTypes() {
  const { types, impact, isLoading, upsert, overrideFromPack, archive } = useWorkEntryTypes();
  const [editing, setEditing] = useState<WorkEntryType | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<WorkEntryTypeInput>(EMPTY);

  // Group by code so we can show "pack default" vs "tenant override".
  const grouped = useMemo(() => {
    const m = new Map<string, { tenant?: WorkEntryType; pack?: WorkEntryType }>();
    for (const t of types) {
      const slot = m.get(t.code) ?? {};
      if (t.business_id === null) slot.pack = t; else slot.tenant = t;
      m.set(t.code, slot);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [types]);

  const kpis = useMemo(() => {
    let total = 0, overridden = 0, unusedInPeriod = 0, referenced = 0;
    for (const [, { pack, tenant }] of grouped) {
      total++;
      if (tenant) overridden++;
      const effective = tenant ?? pack!;
      const meta = impact[effective.id];
      if (meta) {
        if (meta.rowsLast90d === 0) unusedInPeriod++;
        if (meta.rulesReferencing > 0) referenced++;
      } else {
        unusedInPeriod++;
      }
    }
    return { total, overridden, unusedInPeriod, referenced };
  }, [grouped, impact]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }

  function openEdit(t: WorkEntryType) {
    setEditing(t);
    setForm({
      code: t.code,
      name: t.name,
      color: t.color,
      is_paid: t.is_paid,
      is_unpaid_leave: t.is_unpaid_leave,
      counts_as_worked: t.counts_as_worked,
      multiplier_normal: t.multiplier_normal,
      multiplier_overtime: t.multiplier_overtime,
      accounting_tag: t.accounting_tag,
      sequence: t.sequence,
      is_active: t.is_active,
      version: t.version,
    });
    setOpen(true);
  }

  function handleSave() {
    upsert.mutate(
      editing ? { ...form, id: editing.id, version: editing.version } : form,
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Work Entry Types</h1>
          <p className="text-sm text-muted-foreground">
            Classify every unit of time before payroll runs — regular work, overtime, leave, holidays.
            Pack defaults are shared across companies; use <span className="font-medium">Override</span> to
            customise for this company.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> New type
        </Button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total types", value: kpis.total },
          { label: "Overridden", value: kpis.overridden },
          { label: "Unused (90d)", value: kpis.unusedInPeriod },
          { label: "In salary rules", value: kpis.referenced },
        ].map((k) => (
          <Card key={k.label}>
            <CardContent className="py-4">
              <div className="text-xs text-muted-foreground">{k.label}</div>
              <div className="text-2xl font-semibold tabular-nums">{k.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Catalogue</CardTitle>
          <CardDescription>
            Multipliers feed the structure engine: <code>worked_hours['CODE']</code> sums hours × normal multiplier, overtime hours × overtime multiplier.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Worked</TableHead>
                  <TableHead className="text-right">Multiplier (normal / OT)</TableHead>
                  <TableHead>Acct tag</TableHead>
                  <TableHead className="text-right">Impact (90d)</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grouped.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      No work entry types yet. Install a localization pack or create your own.
                    </TableCell>
                  </TableRow>
                )}
                {grouped.map(([code, { pack, tenant }]) => {
                  const effective = tenant ?? pack!;
                  const isPack = !tenant && !!pack;
                  const meta = impact[effective.id];
                  return (
                    <TableRow key={code} className={!effective.is_active ? "opacity-50" : ""}>
                      <TableCell className="font-mono text-xs">{code}</TableCell>
                      <TableCell>{effective.name}</TableCell>
                      <TableCell>
                        {tenant ? (
                          <Badge variant="default">Overridden</Badge>
                        ) : (
                          <Badge variant="secondary">Pack default</Badge>
                        )}
                      </TableCell>
                      <TableCell>{effective.is_paid ? "Yes" : "No"}</TableCell>
                      <TableCell>{effective.counts_as_worked ? "Yes" : "No"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {effective.multiplier_normal} / {effective.multiplier_overtime}
                      </TableCell>
                      <TableCell className="text-xs">{effective.accounting_tag ?? "—"}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {meta ? (
                          <div className="flex flex-col items-end leading-tight">
                            <span>
                              <span className="font-medium">{meta.rowsLast90d}</span> rows ·{" "}
                              <span className="font-medium">{meta.employeesLast90d}</span> emp
                            </span>
                            <span className="text-muted-foreground">
                              {meta.rulesReferencing} rule{meta.rulesReferencing === 1 ? "" : "s"}
                              {meta.leaveTypesRouted > 0 && <> · {meta.leaveTypesRouted} leave</>}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        {isPack ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => overrideFromPack.mutate(pack!)}
                            disabled={overrideFromPack.isPending}
                          >
                            <Copy className="h-3 w-3 mr-1" /> Override
                          </Button>
                        ) : (
                          <>
                            <Button size="icon" variant="ghost" onClick={() => openEdit(tenant!)}>
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            {tenant!.is_active && (
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => archive.mutate(tenant!.id)}
                                disabled={archive.isPending}
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            )}
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <WorkflowSheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit work entry type" : "New work entry type"}
        description={<>Code is the stable key referenced in salary rule expressions (e.g. <code>worked_hours['WORK']</code>).</>}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={upsert.isPending || !form.code || !form.name}>
              {upsert.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editing ? "Save changes" : "Create type"}
            </Button>
          </>
        }
      >
        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="Identity" subtitle="Stable code + display name. Code is locked once created.">
            <WorkflowField label="Code" required>
              <Input
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder="WORK"
                disabled={!!editing}
              />
            </WorkflowField>
            <WorkflowField label="Name" required>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Regular work"
              />
            </WorkflowField>
            <WorkflowField label="Accounting tag" hint="Routes hours to a posting bucket.">
              <Input
                value={form.accounting_tag ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, accounting_tag: e.target.value || null }))}
                placeholder="e.g. WAGES_OT"
              />
            </WorkflowField>
            <WorkflowField label="Sequence" hint="Display order in pickers and reports.">
              <NumericInput
                allowDecimals={false}
                value={form.sequence ?? 100}
                onValueChange={(n) => setForm((f) => ({ ...f, sequence: n ?? 100 }))}
              />
            </WorkflowField>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={2} title="Multipliers" subtitle="Applied to hours in the structure engine.">
            <WorkflowField label="Multiplier — normal">
              <NumericInput
                step="0.01"
                value={form.multiplier_normal}
                onValueChange={(n) => setForm((f) => ({ ...f, multiplier_normal: n ?? 0 }))}
              />
            </WorkflowField>
            <WorkflowField label="Multiplier — overtime">
              <NumericInput
                step="0.01"
                value={form.multiplier_overtime}
                onValueChange={(n) => setForm((f) => ({ ...f, multiplier_overtime: n ?? 0 }))}
              />
            </WorkflowField>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>

        <WorkflowSheetSection number={3} title="Flags" subtitle="How this type is treated by payroll & reporting.">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="flex items-center gap-2 text-sm rounded-md border bg-muted/40 px-3 py-2">
              <Switch checked={form.is_paid} onCheckedChange={(v) => setForm((f) => ({ ...f, is_paid: v }))} />
              Paid
            </label>
            <label className="flex items-center gap-2 text-sm rounded-md border bg-muted/40 px-3 py-2">
              <Switch checked={form.counts_as_worked} onCheckedChange={(v) => setForm((f) => ({ ...f, counts_as_worked: v }))} />
              Counts as worked
            </label>
            <label className="flex items-center gap-2 text-sm rounded-md border bg-muted/40 px-3 py-2">
              <Switch checked={form.is_active ?? true} onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
              Active
            </label>
          </div>
        </WorkflowSheetSection>
      </WorkflowSheet>
    </div>
  );
}

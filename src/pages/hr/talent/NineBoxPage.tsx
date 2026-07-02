/**
 * Nine-Box — HR places every employee on a Potential × Performance matrix
 * per performance cycle. Performance is derived from the latest signed-off
 * review final_rating; Potential is decided in calibration discussions.
 *
 * All writes go through the `talent_place_on_nine_box` RPC so the matrix
 * cannot drift from the audit log or the review pipeline.
 */
import { useMemo, useState } from "react";
import { useTalentCycles } from "@/hooks/useTalent";
import { useEmployees } from "@/hooks/useEmployees";
import { useNineBox } from "@/hooks/useSuccession";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import {
  WorkflowSheetSection,
  WorkflowSheetGrid,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Grid3x3, Users } from "lucide-react";

const POTENTIAL_LABEL: Record<number, string> = { 1: "Low", 2: "Moderate", 3: "High" };
const PERF_LABEL: Record<number, string> = { 1: "Below", 2: "Solid", 3: "Exceptional" };
const CELL_LABEL: Record<string, { name: string; tone: string }> = {
  "3-3": { name: "Star",                tone: "bg-emerald-500/10 border-emerald-500/40" },
  "3-2": { name: "High Potential",      tone: "bg-emerald-500/10 border-emerald-500/30" },
  "3-1": { name: "Enigma",              tone: "bg-amber-500/10  border-amber-500/30" },
  "2-3": { name: "High Performer",      tone: "bg-emerald-500/5  border-emerald-500/20" },
  "2-2": { name: "Core Player",         tone: "bg-muted/40       border-muted-foreground/20" },
  "2-1": { name: "Inconsistent",        tone: "bg-amber-500/5    border-amber-500/20" },
  "1-3": { name: "Trusted Professional",tone: "bg-blue-500/5     border-blue-500/20" },
  "1-2": { name: "Effective",           tone: "bg-muted/30       border-muted-foreground/15" },
  "1-1": { name: "Risk",                tone: "bg-destructive/10 border-destructive/30" },
};

export default function NineBoxPage() {
  const { cycles } = useTalentCycles();
  const [cycleId, setCycleId] = useState<string | null>(null);
  const activeCycleId = cycleId ?? cycles.find((c) => c.phase !== "closed")?.id ?? cycles[0]?.id ?? null;
  const { employees } = useEmployees();
  const { placements, place, remove } = useNineBox(activeCycleId);

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const grid: Record<string, typeof placements> = {};
  for (let p = 3; p >= 1; p--) for (let f = 1; f <= 3; f++) grid[`${p}-${f}`] = [];
  for (const r of placements) {
    const key = `${r.potential}-${r.performance}`;
    if (grid[key]) grid[key].push(r);
  }
  const placed = new Set(placements.map((p) => p.employee_id));
  const unplaced = employees.filter((e) => e.is_active !== false && !placed.has(e.id));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Grid3x3 className="h-6 w-6 text-primary" /> 9-Box Talent Grid
          </h1>
          <p className="text-sm text-muted-foreground">
            Calibrated placement of every employee on Potential × Performance for this cycle.
            Performance auto-derives from signed-off review ratings; potential is set in calibration.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Cycle</Label>
          <Select value={activeCycleId ?? ""} onValueChange={(v) => setCycleId(v || null)}>
            <SelectTrigger className="w-[260px]"><SelectValue placeholder="Select cycle" /></SelectTrigger>
            <SelectContent>
              {cycles.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!activeCycleId ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">Create a performance cycle to start placing employees.</CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-[auto_repeat(3,1fr)] gap-2">
            <div />
            {[1, 2, 3].map((f) => (
              <div key={f} className="text-center text-xs font-medium text-muted-foreground pb-1">
                Performance: {PERF_LABEL[f]}
              </div>
            ))}
            {[3, 2, 1].map((p) => (
              <PotentialRow key={p} potential={p} grid={grid} empById={empById} />
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" /> Unplaced ({unplaced.length})
              </CardTitle>
              <CardDescription>Active employees with no placement in this cycle.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {unplaced.length === 0 ? (
                <p className="text-sm text-muted-foreground">Everyone is placed.</p>
              ) : unplaced.map((e) => (
                <PlaceTrigger
                  key={e.id}
                  defaultEmployeeId={e.id}
                  cycleId={activeCycleId}
                  employees={employees}
                  onPlace={(args) => place.mutateAsync(args)}
                  label={`${e.first_name} ${e.last_name}`}
                />
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );

  function PotentialRow({
    potential, grid, empById,
  }: { potential: number; grid: Record<string, any[]>; empById: Map<string, any> }) {
    return (
      <>
        <div className="flex items-center text-xs font-medium text-muted-foreground pr-2 -rotate-180" style={{ writingMode: "vertical-rl" }}>
          Potential: {POTENTIAL_LABEL[potential]}
        </div>
        {[1, 2, 3].map((f) => {
          const key = `${potential}-${f}`;
          const cell = CELL_LABEL[key];
          const items = grid[key] ?? [];
          return (
            <Card key={key} className={`min-h-[140px] border-2 ${cell.tone}`}>
              <CardHeader className="p-3 pb-1">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wide">{cell.name}</CardTitle>
                  <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>
                </div>
              </CardHeader>
              <CardContent className="p-3 pt-1 space-y-1">
                {items.map((p) => {
                  const e = empById.get(p.employee_id);
                  return (
                    <div key={p.id} className="flex items-center justify-between text-xs">
                      <PlaceTrigger
                        defaultEmployeeId={p.employee_id}
                        cycleId={activeCycleId!}
                        employees={employees}
                        existing={p}
                        onPlace={(args) => place.mutateAsync(args)}
                        onRemove={() => remove.mutateAsync(p.id)}
                        asLink
                        label={e ? `${e.first_name} ${e.last_name}` : "Unknown"}
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </>
    );
  }
}

function PlaceTrigger({
  defaultEmployeeId, cycleId, employees, existing, onPlace, onRemove, label, asLink,
}: {
  defaultEmployeeId: string;
  cycleId: string;
  employees: any[];
  existing?: { id: string; potential: number; performance: number; placement_reason: string | null };
  onPlace: (args: { employee_id: string; cycle_id: string; potential: 1|2|3; placement_reason?: string; performance_override?: 1|2|3 }) => Promise<any>;
  onRemove?: () => Promise<any>;
  label: string;
  asLink?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [employeeId] = useState(defaultEmployeeId);
  const [potential, setPotential] = useState<1|2|3>((existing?.potential as 1|2|3) ?? 2);
  const [performance, setPerformance] = useState<1|2|3 | "auto">(existing ? (existing.performance as 1|2|3) : "auto");
  const [reason, setReason] = useState(existing?.placement_reason ?? "");
  const [busy, setBusy] = useState(false);

  const emp = employees.find((e) => e.id === employeeId);

  async function submit() {
    setBusy(true);
    try {
      await onPlace({
        employee_id: employeeId,
        cycle_id: cycleId,
        potential,
        placement_reason: reason || undefined,
        performance_override: performance === "auto" ? undefined : performance,
      });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {asLink ? (
        <button className="hover:underline truncate" onClick={() => setOpen(true)}>{label}</button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{label}</Button>
      )}
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="nine-box-rating"
        mode={existing ? "edit" : "create"}
        busy={busy}
        onSubmit={submit}
        submitLabel="Save placement"
        footer={
          existing && onRemove ? (
            <>
              <Button
                type="button"
                variant="ghost"
                className="text-destructive mr-auto"
                onClick={async () => { await onRemove(); setOpen(false); }}
              >Remove</Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="button" onClick={submit} disabled={busy}>Save placement</Button>
            </>
          ) : undefined
        }
      >
        <WorkflowSheetSection number={1} title="Employee">
          <WorkflowField label="Employee">
            <div className="text-sm font-medium">{emp ? `${emp.first_name} ${emp.last_name}` : "—"}</div>
          </WorkflowField>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Placement" subtitle="Potential is set in calibration; performance defaults to the latest signed-off review.">
          <WorkflowSheetGrid>
            <WorkflowField label="Potential" required>
              <Select value={String(potential)} onValueChange={(v) => setPotential(Number(v) as 1|2|3)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 — Low</SelectItem>
                  <SelectItem value="2">2 — Moderate</SelectItem>
                  <SelectItem value="3">3 — High</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Performance">
              <Select value={String(performance)} onValueChange={(v) => setPerformance(v === "auto" ? "auto" : Number(v) as 1|2|3)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (from signed-off review)</SelectItem>
                  <SelectItem value="1">1 — Below</SelectItem>
                  <SelectItem value="2">2 — Solid</SelectItem>
                  <SelectItem value="3">3 — Exceptional</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={3} title="Calibration notes">
          <WorkflowField label="Rationale" hint="Skills, scope, behaviour signals.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </WorkflowField>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}

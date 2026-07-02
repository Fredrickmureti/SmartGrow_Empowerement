/**
 * LeaveHolidays — standalone admin page for public holidays.
 *
 * Promoted from a dialog into a real route so the calendar of jurisdiction
 * holidays (which feeds attendance auto-stamping and leave-day calculations)
 * is deep-linkable (/hr/leave/holidays).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Plus, Trash2, Loader2, Lock, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { usePublicHolidays } from "@/hooks/leave/usePublicHolidays";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export default function LeaveHolidays() {
  const { holidays, isLoading, createHoliday, deleteHoliday } = usePublicHolidays();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    date: "",
    is_recurring: false,
    applies_to_all: true,
    description: "",
  });

  const grouped = useMemo(() => {
    const m = new Map<number, typeof holidays>();
    for (const h of holidays) {
      const arr = m.get(h.year) ?? [];
      arr.push(h);
      m.set(h.year, arr);
    }
    return Array.from(m.entries()).sort((a, b) => b[0] - a[0]);
  }, [holidays]);

  if (!can("manageLeaveTypes")) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Lock className="h-8 w-8 text-muted-foreground mb-3" />
          <h3 className="font-semibold">Manage-leave-types permission required</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Public holidays are an HR-administration surface.
          </p>
        </CardContent>
      </Card>
    );
  }

  const reset = () => {
    setForm({ name: "", date: "", is_recurring: false, applies_to_all: true, description: "" });
  };

  const submit = async () => {
    if (!form.name.trim() || !form.date) {
      toast.error("Name and date are required");
      return;
    }
    setSubmitting(true);
    try {
      await createHoliday({
        name: form.name.trim(),
        date: form.date,
        year: new Date(form.date).getFullYear(),
        is_recurring: form.is_recurring,
        applies_to_all: form.applies_to_all,
        branch_ids: null,
        description: form.description.trim() || null,
        is_active: true,
      });
      setAddOpen(false);
      reset();
    } catch (e) {
      toast.error(normalizeError(e).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarDays className="h-6 w-6" /> Public Holidays
          </h1>
          <p className="text-sm text-muted-foreground">
            Holidays automatically stamp attendance and shorten leave-day calculations.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> Add holiday
        </Button>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : grouped.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No public holidays configured yet.
          </CardContent>
        </Card>
      ) : (
        grouped.map(([year, list]) => (
          <Card key={year}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{year}</CardTitle>
              <CardDescription>
                {list.length} holiday{list.length === 1 ? "" : "s"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list
                    .slice()
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="font-mono text-xs">
                          {format(new Date(h.date), "EEE, MMM d")}
                        </TableCell>
                        <TableCell className="font-medium">
                          {h.name}
                          {h.is_recurring && (
                            <Badge variant="secondary" className="ml-2 text-[10px]">
                              recurring
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {h.applies_to_all ? "All branches" : `${(h.branch_ids ?? []).length} branches`}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (confirm(`Delete holiday "${h.name}"?`)) deleteHoliday(h.id);
                            }}
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))
      )}

      <div className="text-xs text-muted-foreground">
        <button
          className="underline hover:text-foreground"
          onClick={() => navigate("/hr/leave")}
        >
          ← Back to Time off
        </button>
      </div>

      <WorkflowSheet
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) reset();
        }}
        title="Add public holiday"
        description='Holidays apply jurisdiction-wide. Use "Recurring" for fixed annual dates.'
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add holiday
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Holiday" fullWidth>
          <WorkflowSheetGrid>
            <WorkflowField label="Name" htmlFor="h-name" required>
              <Input
                id="h-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. New Year's Day"
                autoFocus
              />
            </WorkflowField>
            <WorkflowField label="Date" htmlFor="h-date" required>
              <Input
                id="h-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </WorkflowField>
          </WorkflowSheetGrid>
          <WorkflowField label="Description" htmlFor="h-desc">
            <Input
              id="h-desc"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="Optional context (e.g. observed in lieu of…)"
            />
          </WorkflowField>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={2} title="Scope" fullWidth>
          <div className="flex items-center justify-between rounded border p-3">
            <div>
              <Label htmlFor="h-rec" className="text-sm font-medium">
                Recurring every year
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Auto-create the same holiday on this date in future years.
              </p>
            </div>
            <Switch
              id="h-rec"
              checked={form.is_recurring}
              onCheckedChange={(c) => setForm({ ...form, is_recurring: c })}
            />
          </div>
          <div className="flex items-center justify-between rounded border p-3">
            <div>
              <Label htmlFor="h-all" className="text-sm font-medium">
                Applies to all branches
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Disable to scope this holiday to a subset of branches later.
              </p>
            </div>
            <Switch
              id="h-all"
              checked={form.applies_to_all}
              onCheckedChange={(c) => setForm({ ...form, applies_to_all: c })}
            />
          </div>
        </WorkflowSheetSection>
      </WorkflowSheet>
    </div>
  );
}

/**
 * Development Plans (HR) — per-employee growth plans linked to competency
 * gaps, training, goals. HR / managers pick an employee, see their plans,
 * edit items, and use the suggestion engines to auto-populate from
 * competency gaps and the latest signed-off review.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useEmployees } from "@/hooks/useEmployees";
import {
  useDevelopmentPlans,
  useDevelopmentPlan,
  DevelopmentPlan,
  DevPlanItemType,
  DevPlanItemStatus,
} from "@/hooks/useDevelopmentPlans";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import {
  PenTool,
  Plus,
  Trash2,
  Sparkles,
  Search,
  CheckCircle2,
  Circle,
  AlertCircle,
  Play,
} from "lucide-react";
import { format } from "date-fns";

const ITEM_TYPES: { value: DevPlanItemType; label: string }[] = [
  { value: "competency", label: "Competency" },
  { value: "training", label: "Training" },
  { value: "goal", label: "Goal" },
  { value: "stretch_assignment", label: "Stretch assignment" },
  { value: "mentoring", label: "Mentoring" },
  { value: "reading", label: "Reading" },
  { value: "other", label: "Other" },
];

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-primary/10 text-primary",
  on_hold: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  completed: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  cancelled: "bg-destructive/10 text-destructive",
};

export default function DevelopmentPlansPage() {
  const [params, setParams] = useSearchParams();
  const employeeId = params.get("employee") ?? "";
  const [planId, setPlanId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { employees } = useEmployees();
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = employees.filter((e) => e.is_active);
    if (!s) return list.slice(0, 50);
    return list
      .filter(
        (e) =>
          `${e.first_name} ${e.last_name}`.toLowerCase().includes(s) ||
          (e.employee_number ?? "").toLowerCase().includes(s),
      )
      .slice(0, 50);
  }, [employees, search]);

  const selectedEmployee = employees.find((e) => e.id === employeeId) ?? null;
  const { plans, createPlan, deletePlan, activatePlan, updatePlan } = useDevelopmentPlans({
    employeeId: employeeId || undefined,
  });

  // Auto-select first plan when employee changes
  const activePlanId = planId && plans.find((p) => p.id === planId) ? planId : plans[0]?.id ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <PenTool className="h-5 w-5" /> Development Plans
        </h1>
        <p className="text-sm text-muted-foreground">
          Per-employee growth plans linked to competency gaps, training, goals, and stretch work.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        {/* Left: employee picker + plans list */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Employee</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-7 h-8 text-sm"
                />
              </div>
              <div className="max-h-72 overflow-y-auto -mx-2">
                {filtered.length === 0 ? (
                  <p className="px-2 py-4 text-xs text-muted-foreground">No employees match.</p>
                ) : (
                  filtered.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => {
                        setParams({ employee: e.id });
                        setPlanId(null);
                      }}
                      className={
                        "w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent " +
                        (e.id === employeeId ? "bg-accent font-medium" : "")
                      }
                    >
                      <div className="truncate">
                        {e.first_name} {e.last_name}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {e.employee_number} · {e.position ?? "—"}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {selectedEmployee && (
            <Card>
              <CardHeader className="pb-3 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Plans</CardTitle>
                <CreatePlanDialog
                  employeeId={selectedEmployee.id}
                  onCreated={(id) => setPlanId(id)}
                  create={createPlan.mutate}
                  busy={createPlan.isPending}
                />
              </CardHeader>
              <CardContent className="space-y-1">
                {plans.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No plans yet — create one.</p>
                ) : (
                  plans.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setPlanId(p.id)}
                      className={
                        "w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent " +
                        (p.id === activePlanId ? "bg-accent" : "")
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{p.title}</span>
                        <Badge variant="outline" className={"text-[10px] " + (STATUS_BADGE[p.status] ?? "")}>
                          {p.status.replace(/_/g, " ")}
                        </Badge>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {p.target_completion_date
                          ? `Due ${format(new Date(p.target_completion_date), "MMM d, yyyy")}`
                          : "No target date"}
                      </div>
                    </button>
                  ))
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: plan editor */}
        <div>
          {!selectedEmployee ? (
            <EmptyState
              title="Pick an employee"
              hint="Choose an employee on the left to see and edit their development plans."
            />
          ) : !activePlanId ? (
            <EmptyState
              title="No plan selected"
              hint='Create a plan using the "+" button beside "Plans".'
            />
          ) : (
            <PlanEditor
              planId={activePlanId}
              onActivate={(p) => activatePlan.mutate(p)}
              onDelete={(id) => {
                if (confirm("Delete this plan? Items will be removed.")) {
                  deletePlan.mutate(id);
                  setPlanId(null);
                }
              }}
              onUpdate={(id, patch) => updatePlan.mutate({ id, patch })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <PenTool className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground mt-1">{hint}</p>
      </CardContent>
    </Card>
  );
}

function CreatePlanDialog({
  employeeId,
  onCreated,
  create,
  busy,
}: {
  employeeId: string;
  onCreated: (id: string) => void;
  create: (input: any, opts?: any) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [target, setTarget] = useState("");

  return (
    <>
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
      </Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="development-plan"
        busy={busy}
        submitDisabled={!title.trim()}
        onSubmit={() =>
          create(
            {
              employee_id: employeeId,
              title: title.trim(),
              summary: summary.trim() || null,
              target_completion_date: target || null,
            },
            {
              onSuccess: (row: any) => {
                setOpen(false);
                setTitle("");
                setSummary("");
                setTarget("");
                if (row?.id) onCreated(row.id);
              },
            },
          )
        }
      >
        <WorkflowSheetSection number={1} title="Identity" subtitle="Plans start in draft. Activate when ready — the employee gets notified.">
          <WorkflowSheetGrid>
            <WorkflowField label="Title" required>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="H2 2026 Growth Plan" />
            </WorkflowField>
            <WorkflowField label="Target completion">
              <Input type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Summary" subtitle="Focus areas and the expected outcome. Visible to the employee.">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Focus areas, expected outcome…" rows={4} />
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}

function PlanEditor({
  planId,
  onActivate,
  onDelete,
  onUpdate,
}: {
  planId: string;
  onActivate: (p: DevelopmentPlan) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<DevelopmentPlan>) => void;
}) {
  const {
    plan,
    items,
    isLoading,
    addItem,
    updateItem,
    deleteItem,
    addItemsBulk,
    suggestFromGaps,
    suggestFromLatestReview,
  } = useDevelopmentPlan(planId);

  const [addOpen, setAddOpen] = useState(false);

  const completion = useMemo(() => {
    if (items.length === 0) return 0;
    const total = items.reduce((acc, i) => acc + (Number(i.progress_pct) || 0), 0);
    return Math.round(total / items.length);
  }, [items]);

  if (!plan) return <EmptyState title="Loading…" hint="" />;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              {plan.title}
              <Badge variant="outline" className={"text-[10px] " + (STATUS_BADGE[plan.status] ?? "")}>
                {plan.status.replace(/_/g, " ")}
              </Badge>
            </CardTitle>
            {plan.summary && <CardDescription className="mt-1">{plan.summary}</CardDescription>}
          </div>
          <div className="flex items-center gap-1">
            {plan.status === "draft" && (
              <Button size="sm" onClick={() => onActivate(plan)}>
                <Play className="h-3.5 w-3.5 mr-1" /> Activate
              </Button>
            )}
            {plan.status === "active" && items.every((i) => i.status === "completed" || i.status === "cancelled") && items.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onUpdate(plan.id, { status: "completed" })}
              >
                Mark complete
              </Button>
            )}
            <Button size="icon" variant="ghost" onClick={() => onDelete(plan.id)} title="Delete plan">
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>
        <div className="mt-3 space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Overall progress</span>
            <span className="tabular-nums">{completion}%</span>
          </div>
          <Progress value={completion} className="h-1.5" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add action
          </Button>
          <SuggestButton
            label="Suggest from gaps"
            run={suggestFromGaps}
            commit={(rows) => addItemsBulk.mutate(rows)}
            empty="No competency gaps detected for this employee."
          />
          <SuggestButton
            label="Suggest from latest review"
            run={suggestFromLatestReview}
            commit={(rows) => addItemsBulk.mutate(rows)}
            empty="No signed-off review with development areas yet."
          />
        </div>

        <AddItemDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onSubmit={(input) =>
            addItem.mutate(input, {
              onSuccess: () => setAddOpen(false),
            })
          }
          busy={addItem.isPending}
        />

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading items…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No actions yet. Add manually or use a suggestion engine above.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((it) => (
              <li key={it.id} className="px-3 py-2 flex items-start gap-3">
                <button
                  className="mt-0.5 shrink-0"
                  onClick={() =>
                    updateItem.mutate({
                      id: it.id,
                      patch: {
                        status: it.status === "completed" ? "in_progress" : "completed",
                        progress_pct: it.status === "completed" ? 50 : 100,
                      },
                    })
                  }
                  title="Toggle complete"
                >
                  {it.status === "completed" ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  ) : it.status === "blocked" ? (
                    <AlertCircle className="h-5 w-5 text-amber-600" />
                  ) : (
                    <Circle className="h-5 w-5 text-muted-foreground" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={"text-sm font-medium " + (it.status === "completed" ? "line-through text-muted-foreground" : "")}>
                      {it.title}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {it.item_type.replace(/_/g, " ")}
                    </Badge>
                    {it.due_date && (
                      <span className="text-[10px] text-muted-foreground">
                        due {format(new Date(it.due_date), "MMM d")}
                      </span>
                    )}
                  </div>
                  {it.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap">{it.description}</p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <Progress value={Number(it.progress_pct) || 0} className="h-1 flex-1 max-w-[160px]" />
                    <Select
                      value={it.status}
                      onValueChange={(v) =>
                        updateItem.mutate({
                          id: it.id,
                          patch: { status: v as DevPlanItemStatus },
                        })
                      }
                    >
                      <SelectTrigger className="h-6 w-[120px] text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="not_started">Not started</SelectItem>
                        <SelectItem value="in_progress">In progress</SelectItem>
                        <SelectItem value="blocked">Blocked</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="cancelled">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => deleteItem.mutate(it.id)}
                  title="Delete item"
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AddItemDialog({
  open,
  onOpenChange,
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (input: {
    item_type: DevPlanItemType;
    title: string;
    description?: string | null;
    due_date?: string | null;
  }) => void;
  busy: boolean;
}) {
  const [item_type, setType] = useState<DevPlanItemType>("competency");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [due_date, setDue] = useState("");

  return (
    <TalentFormShell
      open={open}
      onOpenChange={onOpenChange}
      entity="development-plan-item"
      busy={busy}
      submitLabel="Add"
      submitDisabled={!title.trim()}
      onSubmit={() => {
        onSubmit({
          item_type,
          title: title.trim(),
          description: description.trim() || null,
          due_date: due_date || null,
        });
        setTitle("");
        setDescription("");
        setDue("");
        setType("competency");
      }}
    >
      <WorkflowSheetSection number={1} title="Action" subtitle="What is the employee committing to, and when?">
        <WorkflowSheetGrid>
          <WorkflowField label="Type" required>
            <Select value={item_type} onValueChange={(v) => setType(v as DevPlanItemType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ITEM_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Due date">
            <Input type="date" value={due_date} onChange={(e) => setDue(e.target.value)} />
          </WorkflowField>
          <WorkflowField label="Title" required className="lg:col-span-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Complete advanced negotiation course" />
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>
      <WorkflowSheetSection number={2} title="Details" subtitle="Optional notes for the employee or manager.">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Resources, expectations, links…" />
      </WorkflowSheetSection>
    </TalentFormShell>
  );
}

function SuggestButton<T extends { title: string }>({
  label,
  run,
  commit,
  empty,
}: {
  label: string;
  run: () => Promise<T[]>;
  commit: (rows: T[]) => void;
  empty: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<T[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const openDialog = async () => {
    setOpen(true);
    setLoading(true);
    try {
      const r = await run();
      setRows(r);
      setPicked(new Set(r.map((_, i) => i)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Sparkles className="h-3.5 w-3.5 mr-1" /> {label}
      </Button>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="development-plan-suggest"
        title={label}
        submitLabel={`Add ${picked.size} item${picked.size === 1 ? "" : "s"}`}
        submitDisabled={picked.size === 0}
        onSubmit={() => {
          commit(rows.filter((_, i) => picked.has(i)));
          setOpen(false);
        }}
      >
        <WorkflowSheetSection number={1} title="Suggestions" subtitle="Untick anything you don't want in the plan.">
          {loading ? (
            <p className="text-sm text-muted-foreground">Analysing…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{empty}</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto divide-y border rounded-md">
              {rows.map((r, i) => (
                <li key={i} className="flex items-start gap-2 p-2">
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    onChange={(e) => {
                      const n = new Set(picked);
                      if (e.target.checked) n.add(i);
                      else n.delete(i);
                      setPicked(n);
                    }}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{r.title}</p>
                    {(r as any).description && (
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">{(r as any).description}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}
